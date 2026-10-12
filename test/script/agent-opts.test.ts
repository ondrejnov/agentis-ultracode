import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateAgentCall, validateSchema } from '../../src/script/validate.ts'
import { makeHooks, run } from './helpers.ts'

/** Runs `agent(...)` in a script; returns either { called, opts } (hook invoked) or { error } (script got an error before the hook). */
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

describe('agent(): opts validation (via script; hook is not called on error)', () => {
  it('valid options reach the hook unchanged', async () => {
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

  it('isolation → clear error (worktree isolation is not in v1), hook is not called', async () => {
    const r = await viaScript("agent('p', { isolation: 'worktree' })")
    assert.equal(r.called, false)
    assert.match(r.error ?? '', /Isolation via git worktree/)
    assert.match(r.error ?? '', /not supported in version 1/)
  })

  it('prompt must be a non-empty string', async () => {
    assert.match((await viaScript('agent()')).error ?? '', /prompt must be a string/)
    assert.match((await viaScript('agent(42)')).error ?? '', /prompt must be a string/)
    assert.match((await viaScript("agent('   ')")).error ?? '', /prompt must not be empty/)
    assert.equal((await viaScript('agent({ a: 1 })')).called, false)
  })

  it('wrong option types', async () => {
    assert.match((await viaScript("agent('p', { effort: 'extreme' })")).error ?? '', /effort.*low, medium, high, xhigh, max/)
    assert.match((await viaScript("agent('p', { label: 5 })")).error ?? '', /label.*string/)
    assert.match((await viaScript("agent('p', { tools: 'Read' })")).error ?? '', /tools.*array/)
    assert.match((await viaScript("agent('p', { stallMs: -1 })")).error ?? '', /stallMs.*positive number/)
    assert.match((await viaScript("agent('p', { maxUsd: 'moc' })")).error ?? '', /maxUsd.*positive number/)
    assert.match((await viaScript("agent('p', { noCache: 1 })")).error ?? '', /noCache.*boolean/)
    assert.match((await viaScript("agent('p', 'text')")).error ?? '', /opts\) must be an object/)
  })

  it('unknown option is not an error, but a warning in the log and is not passed to the hook', async () => {
    const r = await viaScript("agent('p', { label: 'x', scheme: { type: 'object' } })")
    assert.equal(r.called, true)
    assert.deepEqual(r.opts, { label: 'x' })
    assert.ok(r.logs.some((l) => /unknown option “scheme”/.test(l)))
  })

  it('non-serializable opts (cycle) → clear error', async () => {
    const r = await viaScript("(() => { const o = {}; o.self = o; return agent('p', o) })()")
    assert.equal(r.called, false)
    assert.match(r.error ?? '', /cannot be serialized to JSON/)
  })
})

describe('agent(): schema validation', () => {
  const bad = (schema: unknown): string => {
    try {
      validateSchema(schema)
    } catch (e) {
      return (e as Error).message
    }
    assert.fail('expected an error for schema ' + JSON.stringify(schema))
  }

  it('valid schemas pass (nested objects, arrays, enum, anyOf, boolean subschema)', () => {
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

  it('root must be type object', () => {
    assert.match(bad({ type: 'array', items: { type: 'string' } }), /the schema root must have type: 'object'/)
    assert.match(bad({ properties: { a: { type: 'string' } } }), /the schema root must have type: 'object'/)
    assert.match(bad({ type: ['object', 'null'] }), /the schema root must have type: 'object'/)
    assert.match(bad('string'), /schema must be a JSON Schema object/)
    assert.match(bad([]), /schema must be a JSON Schema object/)
  })

  it('required must be a subset of properties', () => {
    assert.match(
      bad({ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'b'] }),
      /schema\.required: key “b” is not in properties/,
    )
    assert.match(bad({ type: 'object', required: ['a'] }), /key “a” is not in properties/)
  })

  it('additionalProperties:false + required key outside properties = contradiction', () => {
    assert.match(
      bad({ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'zz'], additionalProperties: false }),
      /contradictory schema.*“zz”.*additionalProperties: false/,
    )
  })

  it('the same checks apply in nested objects and items', () => {
    assert.match(
      bad({ type: 'object', properties: { s: { type: 'object', properties: { a: { type: 'string' } }, required: ['q'] } } }),
      /schema\.properties\.s\.required: key “q”/,
    )
    assert.match(
      bad({
        type: 'object',
        properties: { list: { type: 'array', items: { type: 'object', properties: {}, required: ['id'], additionalProperties: false } } },
      }),
      /contradictory.*schema\.properties\.list\.items/,
    )
  })

  it('unknown type, bad required/enum/properties', () => {
    assert.match(bad({ type: 'object', properties: { a: { type: 'str' } } }), /“str” is not a JSON Schema type/)
    assert.match(bad({ type: 'object', required: 'a' }), /required: must be an array of strings/)
    assert.match(bad({ type: 'object', properties: { a: {} }, required: ['a', 'a'] }), /listed more than once/)
    assert.match(bad({ type: 'object', properties: { a: { enum: [] } } }), /enum: must be a non-empty array/)
    assert.match(bad({ type: 'object', properties: [] }), /properties: must be an object/)
    assert.match(bad({ type: 'object', properties: { a: 5 } }), /subschema must be an object/)
  })

  it('via script: invalid schema fails the script before the agent starts', async () => {
    const r = await viaScript("agent('p', { schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] } })")
    assert.equal(r.called, false)
    assert.match(r.error ?? '', /key “b” is not in properties/)
  })
})

describe('validateAgentCall (direct)', () => {
  it('null/undefined opts → empty; does not change the input object', () => {
    assert.deepEqual(validateAgentCall('x', undefined), { prompt: 'x', opts: {}, warnings: [] })
    assert.deepEqual(validateAgentCall('x', null), { prompt: 'x', opts: {}, warnings: [] })
    const input = { label: 'a', unknown: 1 }
    const out = validateAgentCall('x', input)
    assert.deepEqual(input, { label: 'a', unknown: 1 })
    assert.deepEqual(out.opts, { label: 'a' })
    assert.equal(out.warnings.length, 1)
  })

  it('agentType is rejected in v1 just like isolation', () => {
    assert.throws(() => validateAgentCall('x', { agentType: 'Explore' }), /agentType/)
  })
})
