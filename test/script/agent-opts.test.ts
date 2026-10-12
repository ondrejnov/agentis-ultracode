import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateAgentCall, validateSchema } from '../../src/script/validate.ts'
import { makeHooks, run } from './helpers.ts'

/** Spustí `agent(...)` ve skriptu; vrátí buď { ok, opts } (hook zavolán) nebo { error } (skript dostal chybu před hookem). */
async function viaScript(call: string): Promise<{ called: boolean; opts?: unknown; error?: string; logs: string[] }> {
  const m = makeHooks()
  const res = await run(`try { await ${call}; return null } catch (e) { return e.message }\n`, { hooks: m.hooks })
  const agentEvent = m.events.find((e) => e.t === 'agent') as { opts: unknown } | undefined
  return {
    called: agentEvent !== undefined,
    opts: agentEvent?.opts,
    error: typeof res.value === 'string' ? res.value : undefined,
    logs: m.logs(),
  }
}

describe('agent(): validace opts (přes skript, hook se při chybě nevolá)', () => {
  it('platné volby projdou do hooku beze změny', async () => {
    const r = await viaScript(
      `agent('p', { label: 'L', phase: 'Fix', model: 'sonnet', effort: 'low', cwd: '/tmp/x', tools: ['Read', 'Bash(git diff:*)'], disallowedTools: ['Write'], systemPrompt: 'S', stallMs: 1000, timeoutMs: 5000, maxUsd: 0.5, noCache: true, schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } })`,
    )
    assert.equal(r.called, true)
    assert.equal(r.error, undefined)
    assert.deepEqual(r.opts, {
      label: 'L',
      phase: 'Fix',
      model: 'sonnet',
      effort: 'low',
      cwd: '/tmp/x',
      tools: ['Read', 'Bash(git diff:*)'],
      disallowedTools: ['Write'],
      systemPrompt: 'S',
      stallMs: 1000,
      timeoutMs: 5000,
      maxUsd: 0.5,
      noCache: true,
      schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
    })
  })

  it('isolation → jasná česká chyba (worktree izolace není ve v1), hook se nezavolá', async () => {
    const r = await viaScript("agent('p', { isolation: 'worktree' })")
    assert.equal(r.called, false)
    assert.match(r.error ?? '', /Izolace přes git worktree/)
    assert.match(r.error ?? '', /není ve verzi 1 podporována/)
  })

  it('prompt musí být neprázdný řetězec', async () => {
    assert.match((await viaScript('agent()')).error ?? '', /prompt musí být řetězec/)
    assert.match((await viaScript('agent(42)')).error ?? '', /prompt musí být řetězec/)
    assert.match((await viaScript("agent('   ')")).error ?? '', /prompt nesmí být prázdný/)
    assert.equal((await viaScript('agent({ a: 1 })')).called, false)
  })

  it('špatné typy voleb', async () => {
    assert.match((await viaScript("agent('p', { effort: 'extreme' })")).error ?? '', /effort.*low, medium, high, xhigh, max/)
    assert.match((await viaScript("agent('p', { label: 5 })")).error ?? '', /label.*řetězec/)
    assert.match((await viaScript("agent('p', { tools: 'Read' })")).error ?? '', /tools.*pole/)
    assert.match((await viaScript("agent('p', { stallMs: -1 })")).error ?? '', /stallMs.*kladné číslo/)
    assert.match((await viaScript("agent('p', { maxUsd: 'moc' })")).error ?? '', /maxUsd.*kladné číslo/)
    assert.match((await viaScript("agent('p', { noCache: 1 })")).error ?? '', /noCache.*boolean/)
    assert.match((await viaScript("agent('p', 'text')")).error ?? '', /opts\) musí být objekt/)
  })

  it('neznámá volba není chyba, ale upozornění v logu a nepředá se hooku', async () => {
    const r = await viaScript("agent('p', { label: 'x', scheme: { type: 'object' } })")
    assert.equal(r.called, true)
    assert.deepEqual(r.opts, { label: 'x' })
    assert.ok(r.logs.some((l) => /neznámá volba „scheme“/.test(l)))
  })

  it('neserializovatelné opts (cyklus) → srozumitelná chyba', async () => {
    const r = await viaScript("(() => { const o = {}; o.self = o; return agent('p', o) })()")
    assert.equal(r.called, false)
    assert.match(r.error ?? '', /nelze serializovat do JSON/)
  })
})

describe('agent(): validace schema', () => {
  const bad = (schema: unknown): string => {
    try {
      validateSchema(schema)
    } catch (e) {
      return (e as Error).message
    }
    assert.fail('očekávána chyba pro schema ' + JSON.stringify(schema))
  }

  it('platná schemata projdou (vnořené objekty, pole, enum, anyOf, boolean podschéma)', () => {
    validateSchema({ type: 'object' })
    validateSchema({
      type: 'object',
      properties: {
        name: { type: 'string' },
        n: { type: ['number', 'null'] },
        kind: { type: 'string', enum: ['a', 'b'] },
        tags: { type: 'array', items: { type: 'string' } },
        sub: { type: 'object', properties: { x: { type: 'integer' } }, required: ['x'], additionalProperties: false },
        any: true,
        choice: { anyOf: [{ type: 'string' }, { type: 'object', properties: { y: { type: 'number' } }, required: ['y'] }] },
      },
      required: ['name', 'kind'],
      additionalProperties: false,
    })
  })

  it('kořen musí být type object', () => {
    assert.match(bad({ type: 'array', items: { type: 'string' } }), /kořen schématu musí mít type: 'object'/)
    assert.match(bad({ properties: { a: { type: 'string' } } }), /kořen schématu musí mít type: 'object'/)
    assert.match(bad({ type: ['object', 'null'] }), /kořen schématu musí mít type: 'object'/)
    assert.match(bad('string'), /schema musí být objekt/)
    assert.match(bad([]), /schema musí být objekt/)
  })

  it('required musí být podmnožina properties', () => {
    assert.match(
      bad({ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'b'] }),
      /schema\.required: klíč „b“ není v properties/,
    )
    assert.match(bad({ type: 'object', required: ['a'] }), /klíč „a“ není v properties/)
  })

  it('additionalProperties:false + required klíč mimo properties = protimluv', () => {
    assert.match(
      bad({ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'zz'], additionalProperties: false }),
      /protimluvné schema.*„zz“.*additionalProperties: false/,
    )
  })

  it('stejné kontroly platí ve vnořených objektech a v items', () => {
    assert.match(
      bad({ type: 'object', properties: { s: { type: 'object', properties: { a: { type: 'string' } }, required: ['q'] } } }),
      /schema\.properties\.s\.required: klíč „q“/,
    )
    assert.match(
      bad({
        type: 'object',
        properties: { list: { type: 'array', items: { type: 'object', properties: {}, required: ['id'], additionalProperties: false } } },
      }),
      /protimluvné.*schema\.properties\.list\.items/,
    )
  })

  it('neznámý typ, špatné required/enum/properties', () => {
    assert.match(bad({ type: 'object', properties: { a: { type: 'str' } } }), /„str“ není typ JSON Schema/)
    assert.match(bad({ type: 'object', required: 'a' }), /required: musí být pole řetězců/)
    assert.match(bad({ type: 'object', properties: { a: {} }, required: ['a', 'a'] }), /víckrát/)
    assert.match(bad({ type: 'object', properties: { a: { enum: [] } } }), /enum: musí být neprázdné pole/)
    assert.match(bad({ type: 'object', properties: [] }), /properties: musí být objekt/)
    assert.match(bad({ type: 'object', properties: { a: 5 } }), /podschéma musí být objekt/)
  })

  it('přes skript: neplatné schema shodí skript před startem agenta', async () => {
    const r = await viaScript("agent('p', { schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] } })")
    assert.equal(r.called, false)
    assert.match(r.error ?? '', /klíč „b“ není v properties/)
  })
})

describe('validateAgentCall (přímo)', () => {
  it('null/undefined opts → prázdné; nezmění vstupní objekt', () => {
    assert.deepEqual(validateAgentCall('x', undefined), { prompt: 'x', opts: {}, warnings: [] })
    assert.deepEqual(validateAgentCall('x', null), { prompt: 'x', opts: {}, warnings: [] })
    const input = { label: 'a', unknown: 1 }
    const out = validateAgentCall('x', input)
    assert.deepEqual(input, { label: 'a', unknown: 1 })
    assert.deepEqual(out.opts, { label: 'a' })
    assert.equal(out.warnings.length, 1)
  })

  it('agentType je ve v1 odmítnut stejně jako isolation', () => {
    assert.throws(() => validateAgentCall('x', { agentType: 'Explore' }), /agentType/)
  })
})
