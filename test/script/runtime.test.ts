import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BudgetExceededError, ScriptValidationError } from '../../src/errors.ts'
import { BUDGET_SLOTS } from '../../src/types.ts'
import { META, budgetBuffer, deferred, makeHooks, run, runWithMeta, waitFor } from './helpers.ts'

describe('běh skriptu: základ', () => {
  it('vrátí návratovou hodnotu a meta; top-level await a return fungují', async () => {
    const res = await run('const a = await Promise.resolve(20)\nconst b = await new Promise((r) => r(22))\nreturn { sum: a + b }\n')
    assert.deepEqual(res.value, { sum: 42 })
    assert.deepEqual(res.meta, { name: 't', description: 'test' })
  })

  it('serializace návratu: undefined → null, Date → ISO, undefined klíče zmizí, funkce se zahodí', async () => {
    assert.equal((await run('return undefined\n')).value, null)
    assert.equal((await run('const x = 1\n')).value, null)
    assert.deepEqual((await run('return { a: undefined, b: () => 1, d: new Date(0), n: null, arr: [1, undefined] }\n')).value, {
      d: '1970-01-01T00:00:00.000Z',
      n: null,
      arr: [1, null],
    })
    assert.deepEqual((await run('return new Map([[1, 2]])\n')).value, {})
  })

  it('nevyhodnotitelná návratová hodnota (BigInt, cyklus) → chyba', async () => {
    await assert.rejects(run('return 10n\n'), /nejde serializovat do JSON/)
    await assert.rejects(run('const o = {}; o.self = o; return o\n'), /nejde serializovat do JSON/)
  })

  it('návratová hodnota je obyčejný JSON objekt hlavního realmu (deepStrictEqual)', async () => {
    const res = await run('return { a: [1, { b: "c" }], s: "řetězec" }\n')
    assert.deepStrictEqual(res.value, { a: [1, { b: 'c' }], s: 'řetězec' })
  })

  it('args: objekt, pole, primitiva, undefined', async () => {
    assert.deepEqual((await run('return args\n', { args: { files: ['a', 'b'], n: 2 } })).value, { files: ['a', 'b'], n: 2 })
    assert.deepEqual((await run('return [Array.isArray(args), args.length, args instanceof Array]\n', { args: [1, 2, 3] })).value, [true, 3, true])
    assert.equal((await run('return args\n', { args: 'text' })).value, 'text')
    assert.equal((await run('return args\n', { args: 7 })).value, 7)
    assert.equal((await run('return args\n', { args: null })).value, null)
    assert.deepEqual((await run('return [typeof args, args === undefined]\n')).value, ['undefined', true])
  })

  it('args, které nejdou serializovat, hodí chybu před startem', async () => {
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    await assert.rejects(run('return 1\n', { args: cyc }), /args nejde serializovat/)
  })

  it('neplatný skript → ScriptValidationError s diagnostikou, hooky se nezavolají', async () => {
    const m = makeHooks()
    await assert.rejects(
      runWithMeta("const x = require('fs')\n", { hooks: m.hooks }),
      (e: unknown) => {
        assert.ok(e instanceof ScriptValidationError)
        assert.equal(e.code, 'SCRIPT_INVALID')
        assert.ok(e.diagnostics.some((d) => /chybí `export const meta/.test(d)))
        assert.ok(e.diagnostics.some((d) => /require/.test(d)))
        return true
      },
    )
    assert.equal(m.events.length, 0)
  })

  it('chyba skriptu: původní zpráva a stack s číslem řádku skriptu a jeho jménem', async () => {
    const body = 'const a = 1\n\nfunction boom() {\n  throw new RangeError("špatná hodnota 42")\n}\nboom()\n'
    await assert.rejects(run(body, { filename: 'muj-skript.ts' }), (e: unknown) => {
      assert.ok(e instanceof RangeError)
      assert.equal(e.message, 'špatná hodnota 42')
      assert.match(e.stack ?? '', /muj-skript\.ts:5:/, e.stack) // META je řádek 1, throw je na řádku 5
      assert.match(e.stack ?? '', /muj-skript\.ts:7:/) // volání boom()
      assert.ok(!/ultracode-runtime/.test(e.stack ?? ''))
      return true
    })
  })

  it('chyba po await má také správný řádek', async () => {
    const body = 'await agent("x")\n\nconst o = null\nreturn o.pole\n'
    await assert.rejects(run(body, { filename: 'wf.ts' }), (e: unknown) => {
      assert.ok(e instanceof TypeError)
      assert.match(e.stack ?? '', /wf\.ts:5:/, e.stack)
      return true
    })
  })

  it('vyhozená hodnota, která není Error, se zachová jako zpráva', async () => {
    await assert.rejects(run('throw "jen text"\n'), (e: unknown) => {
      assert.ok(e instanceof Error)
      assert.equal(e.message, 'jen text')
      return true
    })
  })

  it('skript uvázlý na Promise, která se nikdy nevyřeší, skončí chybou místo visení', async () => {
    const t0 = Date.now()
    await assert.rejects(run('await new Promise(() => {})\n'), /uvázl/)
    assert.ok(Date.now() - t0 < 3000)
  })

  it('ale čekání na pomalého agenta uváznutí není', async () => {
    const d = deferred<string>()
    const m = makeHooks({ agent: () => d.promise })
    const p = run('return await agent("pomalý")\n', { hooks: m.hooks })
    await waitFor(() => m.prompts().length === 1)
    await new Promise((r) => setTimeout(r, 120))
    d.resolve('hotovo')
    assert.equal((await p).value, 'hotovo')
  })
})

describe('izolace a determinismus', () => {
  it('v kontextu nejsou process, require, setTimeout, fetch, Buffer, module…', async () => {
    const res = await run(
      `return {
  process: typeof process, require: typeof require, module: typeof module, setTimeout: typeof setTimeout,
  fetch: typeof fetch, Buffer: typeof Buffer, gp: typeof globalThis.process, global: typeof global,
  exports: typeof exports, queueMicrotask: typeof queueMicrotask, performance: typeof performance,
}\n`,
    )
    for (const [k, v] of Object.entries(res.value as Record<string, string>)) assert.equal(v, 'undefined', k)
  })

  it('standardní builtins jsou k dispozici', async () => {
    const res = await run(
      `return [
  JSON.stringify({ a: 1 }), Math.max(1, 5), [3, 1, 2].sort().join(''), new Map([[1, 2]]).size, new Set([1, 1]).size,
  /a(b)/.exec('ab')[1], new Error('x') instanceof Error, typeof Intl.NumberFormat, Number('3') + 1, structuredClone === undefined,
]\n`.replace('structuredClone === undefined', "typeof structuredClone === 'undefined'"),
    )
    assert.deepEqual(res.value, ['{"a":1}', 5, '123', 1, 1, 'b', true, 'function', 4, true])
  })

  it('eval a new Function jsou zakázané', async () => {
    const res = await run(
      `const out = []
for (const f of [() => eval('1+1'), () => new Function('return 1')()]) {
  try { out.push(String(f())) } catch (e) { out.push(e.name) }
}
return out\n`,
    )
    assert.deepEqual(res.value, ['EvalError', 'EvalError'])
  })

  it('Date.now(), Math.random(), new Date(), Date() hodí DeterminismError (česká zpráva, kód)', async () => {
    const res = (await run(
      `const out = {}
for (const [k, f] of Object.entries({
  now: () => Date.now(), random: () => Math.random(), ctor: () => new Date(), call: () => Date(),
  sub: () => { class D extends Date {}; return new D() },
})) {
  try { f(); out[k] = 'nehodilo' } catch (e) { out[k] = { name: e.name, code: e.code, msg: e.message, isError: e instanceof Error } }
}
return out\n`,
    )).value as Record<string, { name: string; code: string; msg: string; isError: boolean }>
    for (const k of ['now', 'random', 'ctor', 'call', 'sub']) {
      assert.equal(res[k]!.name, 'DeterminismError', k)
      assert.equal(res[k]!.code, 'NON_DETERMINISTIC', k)
      assert.equal(res[k]!.isError, true, k)
      assert.match(res[k]!.msg, /není ve skriptu workflow povoleno/, k)
    }
    assert.match(res.now!.msg, /^Date\.now\(\)/)
    assert.match(res.random!.msg, /^Math\.random\(\)/)
    assert.match(res.ctor!.msg, /^new Date\(\)/)
  })

  it('Date s argumentem, Date.UTC, Date.parse, instanceof a podtřída fungují normálně', async () => {
    const res = await run(
      `const d = new Date('2024-03-05T10:00:00Z')
class D2 extends Date {}
return {
  iso: d.toISOString(), utc: Date.UTC(2020, 0, 1), parse: Date.parse('2020-01-01T00:00:00Z'),
  inst: d instanceof Date, ctor: d.constructor === Date, sub: new D2(0) instanceof Date, name: Date.name,
  y: new Date(2021, 5, 15).getFullYear(), n: new Date(NaN).getTime() !== new Date(NaN).getTime(),
  fromDate: new Date(d).getTime() === d.getTime(), json: JSON.stringify(new Date(0)),
}\n`,
    )
    assert.deepEqual(res.value, {
      iso: '2024-03-05T10:00:00.000Z',
      utc: 1577836800000,
      parse: 1577836800000,
      inst: true,
      ctor: true,
      sub: true,
      name: 'Date',
      y: 2021,
      n: true,
      fromDate: true,
      json: '"1970-01-01T00:00:00.000Z"',
    })
  })

  it('guardy v jednom běhu nezasáhnou následující běh (každý skript má vlastní kontext)', async () => {
    await run('try { Date.now() } catch {}\nreturn 1\n')
    const res = await run('return typeof Date.now\n')
    assert.equal(res.value, 'function')
  })

  it('console.* jde do hook log; log() převádí hodnoty na text', async () => {
    const m = makeHooks()
    await run(
      `console.log('a', 1, { x: [1] }, null)
console.info('info')
console.warn('pozor')
console.error('chyba')
log('prostý')
log({ k: 1 })
log(new Error('E!'))
log(undefined)\n`,
      { hooks: m.hooks },
    )
    assert.deepEqual(m.logs(), ['a 1 {"x":[1]} null', 'info', '[warn] pozor', '[error] chyba', 'prostý', '{"k":1}', 'Error: E!', 'undefined'])
  })
})

describe('phase / log / agent: pořadí a kontext', () => {
  it('phase, log a agent přicházejí na hooky ve stejném pořadí, v jakém je skript volal', async () => {
    const m = makeHooks()
    await run(
      `phase('A')
log('l1')
const r = await agent('p1', { label: 'L1', phase: 'A' })
phase('B')
log('l2:' + r)
await agent('p2')
log('konec')\n`,
      { hooks: m.hooks },
    )
    assert.deepEqual(
      m.events.map((e) => e.t + ':' + ('title' in e ? e.title : 'message' in e ? e.message : 'prompt' in e ? e.prompt : '')),
      ['phase:A', 'log:l1', 'agent:p1', 'phase:B', 'log:l2:echo:p1', 'agent:p2', 'log:konec'],
    )
    const first = m.events.find((e) => e.t === 'agent')
    assert.ok(first && first.t === 'agent')
    assert.deepEqual(first.opts, { label: 'L1', phase: 'A' })
    assert.deepEqual(first.call, { workflowPath: ['t'] })
  })

  it('log() bez čekání před throw se stejně doručí (fire-and-forget zachová pořadí s chybou)', async () => {
    const m = makeHooks()
    await assert.rejects(run("log('před'); throw new Error('konec')\n", { hooks: m.hooks }), /konec/)
    assert.deepEqual(m.logs(), ['před'])
  })

  it('výsledek agenta: string, objekt (schema), null; null se předá skriptu', async () => {
    const m = makeHooks({
      agent: (prompt) => {
        if (prompt === 'obj') return { ok: true, items: [1, 2] }
        if (prompt === 'nic') return null
        if (prompt === 'undef') return undefined
        return 'text'
      },
    })
    const res = await run(
      `return [
  await agent('s'), await agent('obj', { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } }),
  await agent('nic'), await agent('undef'),
]\n`,
      { hooks: m.hooks },
    )
    assert.deepEqual(res.value, ['text', { ok: true, items: [1, 2] }, null, null])
  })

  it('výsledek agenta je z realmu skriptu (instanceof Array/Object, Array.isArray)', async () => {
    const m = makeHooks({ agent: () => ({ list: [1, 2], nested: { a: 1 } }) })
    const res = await run(
      `const r = await agent('x')
return [r instanceof Object, r.list instanceof Array, Array.isArray(r.list), r.list.map((n) => n * 2), Object.keys(r.nested)]\n`,
      { hooks: m.hooks },
    )
    assert.deepEqual(res.value, [true, true, true, [2, 4], ['a']])
  })

  it('chyba z hooku (BudgetExceededError) se ve skriptu objeví jako Error se stejnou zprávou a code', async () => {
    const m = makeHooks({
      agent: () => {
        throw new BudgetExceededError('Rozpočet vyčerpán: 100/100 tokenů')
      },
    })
    const res = await run(
      `try { await agent('x'); return 'nehodilo' } catch (e) { return { msg: e.message, code: e.code, name: e.name, isError: e instanceof Error } }\n`,
      { hooks: m.hooks },
    )
    assert.deepEqual(res.value, {
      msg: 'Rozpočet vyčerpán: 100/100 tokenů',
      code: 'BUDGET_EXCEEDED',
      name: 'BudgetExceededError',
      isError: true,
    })
  })

  it('nezachycená chyba z hooku shodí skript jako BudgetExceededError (instanceof a code)', async () => {
    const m = makeHooks({
      agent: async () => {
        throw new BudgetExceededError('limit')
      },
    })
    await assert.rejects(run("await agent('x')\n", { hooks: m.hooks }), (e: unknown) => {
      assert.ok(e instanceof BudgetExceededError)
      assert.equal(e.code, 'BUDGET_EXCEEDED')
      assert.equal(e.message, 'limit')
      return true
    })
  })

  it('výsledek hooku, který nejde přenést (funkce), dá skriptu srozumitelnou chybu', async () => {
    const m = makeHooks({ agent: () => ({ fn: () => 1 }) })
    const res = await run("try { await agent('x') } catch (e) { return e.message }\n", { hooks: m.hooks })
    assert.match(String(res.value), /nelze předat skriptu/)
  })
})

describe('parallel', () => {
  it('zachová pořadí výsledků i při opačném dokončení; thunk co hodí → null, nehází', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()]
    const m = makeHooks({ agent: (prompt) => gates[Number(prompt)]!.promise })
    const p = run(
      `return await parallel([
  () => agent('0'),
  () => agent('1'),
  () => { throw new Error('sync boom') },
  async () => { await agent('2'); throw new Error('async boom') },
  () => 'hodnota',
])\n`,
      { hooks: m.hooks },
    )
    await waitFor(() => m.prompts().length === 3)
    gates[2]!.resolve('c')
    gates[1]!.resolve('b')
    gates[0]!.resolve('a')
    assert.deepEqual((await p).value, ['a', 'b', null, null, 'hodnota'])
    // selhání se nehlásí tiše: dostaneme log s příčinou
    assert.ok(m.logs().some((l) => /parallel\(\): položka 2 selhala.*sync boom/.test(l)), m.logs().join('\n'))
    assert.ok(m.logs().some((l) => /parallel\(\): položka 3 selhala.*async boom/.test(l)))
  })

  it('je bariéra: následující krok se spustí až po dokončení VŠECH thunků', async () => {
    const gates = [deferred<string>(), deferred<string>()]
    const m = makeHooks({ agent: (prompt) => (prompt.startsWith('t') ? gates[Number(prompt[1])]!.promise : 'po-bariére') })
    const p = run(
      `const r = await parallel([() => agent('t0'), () => agent('t1')])
const after = await agent('after:' + r.join(','))
return after\n`,
      { hooks: m.hooks },
    )
    await waitFor(() => m.prompts().length === 2)
    gates[0]!.resolve('x')
    await new Promise((r) => setTimeout(r, 100))
    assert.deepEqual(m.prompts(), ['t0', 't1'], 'after se nesmí spustit, dokud t1 neskončil')
    gates[1]!.resolve('y')
    assert.equal((await p).value, 'po-bariére')
    assert.deepEqual(m.prompts(), ['t0', 't1', 'after:x,y'])
  })

  it('všechny thunky se spustí ihned (souběžně), ne po jednom', async () => {
    const m = makeHooks({ agent: () => new Promise(() => {}) })
    const ac = new AbortController()
    const p = run("await parallel([1, 2, 3, 4, 5].map((i) => () => agent('a' + i)))\n", { hooks: m.hooks, signal: ac.signal })
    await waitFor(() => m.prompts().length === 5)
    assert.deepEqual(m.prompts(), ['a1', 'a2', 'a3', 'a4', 'a5'])
    ac.abort()
    await assert.rejects(p, { code: 'ABORTED' })
  })

  it('tolerantně přijme i hotové Promise místo funkce; prázdné pole → []', async () => {
    const res = await run("return [await parallel([]), await parallel([Promise.resolve(1), () => 2, Promise.reject(new Error('x'))])]\n")
    assert.deepEqual(res.value, [[], [1, 2, null]])
  })

  it('maxItems: nad limit je chyba a žádný thunk se nespustí; default 4096', async () => {
    const m = makeHooks()
    await assert.rejects(
      run("await parallel([1, 2, 3, 4].map((i) => () => agent('a' + i)))\n", { hooks: m.hooks, maxItems: 3 }),
      /parallel\(\): příliš mnoho položek \(4\), maximum je 3/,
    )
    assert.equal(m.prompts().length, 0)

    const ok = await run("return (await parallel(Array.from({ length: 4096 }, (_, i) => () => i))).length\n")
    assert.equal(ok.value, 4096)
    const m2 = makeHooks()
    const over = await run(
      "try { await parallel(Array.from({ length: 4097 }, () => () => agent('x'))) } catch (e) { return [e.name, e.message] }\n",
      { hooks: m2.hooks },
    )
    assert.deepEqual((over.value as string[])[0], 'RangeError')
    assert.match((over.value as string[])[1]!, /4097.*4096/)
    assert.equal(m2.prompts().length, 0)
  })

  it('špatný argument (ne pole) je chyba skriptu', async () => {
    await assert.rejects(run("await parallel(() => 1)\n"), /parallel\(\): očekává pole/)
  })

  it('víc než 10 selhání: log je omezen a zbytek shrnut', async () => {
    const m = makeHooks()
    await run("await parallel(Array.from({ length: 25 }, () => () => { throw new Error('e') }))\n", { hooks: m.hooks })
    const logs = m.logs()
    assert.equal(logs.filter((l) => /položka \d+ selhala/.test(l)).length, 10)
    assert.ok(logs.some((l) => /dalších 15 chyb nezobrazeno \(celkem 25\)/.test(l)))
  })
})

describe('pipeline', () => {
  it('BEZ bariéry: rychlá položka postoupí do stage 2, zatímco pomalá je ještě ve stage 1', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<string>>>()
    const gate = (k: string) => {
      if (!gates.has(k)) gates.set(k, deferred<string>())
      return gates.get(k)!
    }
    const m = makeHooks({ agent: (prompt) => gate(prompt).promise })
    const p = run(
      `return await pipeline(['A', 'B', 'C'],
  (x) => agent('s1:' + x),
  (r, x) => agent('s2:' + x + ':' + r),
)\n`,
      { hooks: m.hooks },
    )
    await waitFor(() => m.prompts().length === 3)
    assert.deepEqual(m.prompts(), ['s1:A', 's1:B', 's1:C'])
    // B a C dokončí stage 1, A (pomalá) stále visí
    gate('s1:B').resolve('rb')
    gate('s1:C').resolve('rc')
    await waitFor(() => m.prompts().includes('s2:B:rb') && m.prompts().includes('s2:C:rc'), 3000, 'stage 2 pro B a C')
    assert.ok(!m.prompts().includes('s2:A:ra'))
    assert.equal(
      m.prompts().filter((x) => x.startsWith('s2:')).length,
      2,
      'stage 2 pro A se nesmí spustit před dokončením jeho stage 1',
    )
    gate('s2:B:rb').resolve('fb')
    // dokonce B je hotové dřív, než A vůbec dokončí stage 1
    gate('s1:A').resolve('ra')
    await waitFor(() => m.prompts().includes('s2:A:ra'))
    gate('s2:A:ra').resolve('fa')
    gate('s2:C:rc').resolve('fc')
    assert.deepEqual((await p).value, ['fa', 'fb', 'fc'])
  })

  it('stage dostane (prev, original, index); výsledky v pořadí položek', async () => {
    const res = await run(
      `return await pipeline(
  [{ n: 'a' }, { n: 'b' }, { n: 'c' }],
  (item, original, i) => [item.n, original === item, i],
  (prev, original, i) => ({ prev, name: original.n, i }),
)\n`,
    )
    assert.deepEqual(res.value, [
      { prev: ['a', true, 0], name: 'a', i: 0 },
      { prev: ['b', true, 1], name: 'b', i: 1 },
      { prev: ['c', true, 2], name: 'c', i: 2 },
    ])
  })

  it('throw ve stage → null a zbylé stage se pro položku přeskočí; ostatní položky nejsou dotčeny', async () => {
    const m = makeHooks()
    const res = await run(
      `return await pipeline([1, 2, 3],
  async (x) => { if (x === 2) throw new Error('stage1 selhala'); return x * 10 },
  async (x) => { await agent('s2:' + x); return x + 1 },
  (x) => 'final:' + x,
)\n`,
      { hooks: m.hooks },
    )
    assert.deepEqual(res.value, ['final:11', null, 'final:31'])
    assert.deepEqual(m.prompts().sort(), ['s2:10', 's2:30'])
    assert.ok(m.logs().some((l) => /pipeline\(\): položka 1, stage 1 selhala.*stage1 selhala/.test(l)))
  })

  it('null VRÁCENÝ stagí se předává dál (nepřeskakuje se)', async () => {
    const res = await run(
      `return await pipeline(['a', 'b'],
  (x) => (x === 'a' ? null : 'ok'),
  (prev, original) => (prev === null ? 'FAILED:' + original : prev + ':' + original),
)\n`,
    )
    assert.deepEqual(res.value, ['FAILED:a', 'ok:b'])
  })

  it('bez stage vrátí položky; jedna stage; prázdné pole', async () => {
    assert.deepEqual((await run('return [await pipeline([1, 2]), await pipeline([], (x) => x), await pipeline([3], (x) => x * 2)]\n')).value, [
      [1, 2],
      [],
      [6],
    ])
  })

  it('maxItems a špatné argumenty', async () => {
    await assert.rejects(run('await pipeline([1, 2, 3], (x) => x)\n', { maxItems: 2 }), /pipeline\(\): příliš mnoho položek \(3\), maximum je 2/)
    await assert.rejects(run("await pipeline('abc', (x) => x)\n"), /první argument musí být pole/)
    await assert.rejects(run("await pipeline([1], 'ne-funkce')\n"), /stage 1 musí být funkce/)
  })

  it('agent() uvnitř pipeline: chyba rozpočtu → null položky, běh doběhne', async () => {
    const m = makeHooks({
      agent: (prompt) => {
        if (prompt.endsWith('2')) throw new BudgetExceededError('strop')
        return 'ok:' + prompt
      },
    })
    const res = await run("return await pipeline([1, 2, 3], (i) => agent('p' + i))\n", { hooks: m.hooks })
    assert.deepEqual(res.value, ['ok:p1', null, 'ok:p3'])
  })
})

describe('budget', () => {
  it('bez limitu: total null, remaining Infinity', async () => {
    const res = await run(
      'return { total: budget.total, totalUsd: budget.totalUsd, spent: budget.spent(), rem: String(budget.remaining()), remUsd: String(budget.remainingUsd()), spentUsd: budget.spentUsd() }\n',
      { budget: budgetBuffer({ spent: 1234, spentUsd: 0.5 }) },
    )
    assert.deepEqual(res.value, { total: null, totalUsd: null, spent: 1234, rem: 'Infinity', remUsd: 'Infinity', spentUsd: 0.5 })
  })

  it('s limitem: total, remaining, remainingUsd (a nikdy záporné)', async () => {
    const res = await run(
      'return { total: budget.total, totalUsd: budget.totalUsd, rem: budget.remaining(), remUsd: budget.remainingUsd() }\n',
      { budget: budgetBuffer({ spent: 300, total: 1000, spentUsd: 1.5, totalUsd: 1 }) },
    )
    assert.deepEqual(res.value, { total: 1000, totalUsd: 1, rem: 700, remUsd: 0 })
  })

  it('čte ŽIVĚ ze SharedArrayBuffer: hodnoty se mění, jak engine zapisuje', async () => {
    const buf = budgetBuffer({ total: 1000 })
    const view = new Float64Array(buf, 0, BUDGET_SLOTS)
    const m = makeHooks({
      agent: () => {
        view[0]! += 400
        return 'x'
      },
    })
    const res = await run(
      `const a = budget.spent(); const ra = budget.remaining()
await agent('x')
const b = budget.spent(); const rb = budget.remaining()
await agent('y')
return [a, ra, b, rb, budget.spent(), budget.remaining()]\n`,
      { hooks: m.hooks, budget: buf },
    )
    assert.deepEqual(res.value, [0, 1000, 400, 600, 800, 200])
  })

  it('loop-until-budget vzor funguje', async () => {
    const buf = budgetBuffer({ total: 1000 })
    const view = new Float64Array(buf, 0, BUDGET_SLOTS)
    const m = makeHooks({
      agent: () => {
        view[0]! += 300
        return 'ok'
      },
    })
    const res = await run(
      "let n = 0\nwhile (budget.total && budget.remaining() > 100) { await agent('r' + n); n++ }\nreturn n\n",
      { hooks: m.hooks, budget: buf },
    )
    assert.equal(res.value, 3) // zbývá 1000 → 700 → 400 → 100; při 100 už podmínka `> 100` neplatí
  })

  it('příliš malý budgetBuffer je chyba použití', async () => {
    await assert.rejects(run('return 1\n', { budget: new SharedArrayBuffer(8) }), /budgetBuffer/)
  })
})

describe('meta + běh dohromady', () => {
  it('skript s META konstantou a více fázemi', async () => {
    const m = makeHooks()
    const res = await runWithMeta(
      `export const meta = { name: 'multi', description: 'd', phases: [{ title: 'One' }, { title: 'Two' }] }
phase('One')
const a = await agent('a')
phase('Two')
const b = await agent('b')
return [a, b]
`,
      { hooks: m.hooks },
    )
    assert.deepEqual(res.value, ['echo:a', 'echo:b'])
    assert.equal(res.meta.name, 'multi')
    assert.deepEqual(m.events.map((e) => e.t), ['phase', 'agent', 'phase', 'agent'])
    assert.deepEqual((m.events[0] as { call: { workflowPath: string[] } }).call.workflowPath, ['multi'])
  })

  it('META helper je platný (sanity)', () => {
    assert.match(META, /export const meta/)
  })
})
