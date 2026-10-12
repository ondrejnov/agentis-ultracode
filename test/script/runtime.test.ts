import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BudgetExceededError, ScriptValidationError } from '../../src/errors.ts'
import { BUDGET_SLOTS } from '../../src/types.ts'
import { META, budgetBuffer, deferred, makeHooks, run, runWithMeta, waitFor } from './helpers.ts'

describe('script run: basics', () => {
  it('returns the return value and meta; top-level await and return work', async () => {
    const res = await run('const a = await Promise.resolve(20)\nconst b = await new Promise((r) => r(22))\nreturn { sum: a + b }\n')
    assert.deepEqual(res.value, { sum: 42 })
    assert.deepEqual(res.meta, { name: 't', description: 'test' })
  })

  it('return serialization: undefined → null, Date → ISO, undefined keys vanish, functions are dropped', async () => {
    assert.equal((await run('return undefined\n')).value, null)
    assert.equal((await run('const x = 1\n')).value, null)
    assert.deepEqual((await run('return { a: undefined, b: () => 1, d: new Date(0), n: null, arr: [1, undefined] }\n')).value, {
      d: '1970-01-01T00:00:00.000Z',
      n: null,
      arr: [1, null],
    })
    assert.deepEqual((await run('return new Map([[1, 2]])\n')).value, {})
  })

  it('unserializable return value (BigInt, cycle) → error', async () => {
    await assert.rejects(run('return 10n\n'), /cannot be serialized to JSON/)
    await assert.rejects(run('const o = {}; o.self = o; return o\n'), /cannot be serialized to JSON/)
  })

  it('return value is a plain JSON object of the main realm (deepStrictEqual)', async () => {
    const res = await run('return { a: [1, { b: "c" }], s: "string" }\n')
    assert.deepStrictEqual(res.value, { a: [1, { b: 'c' }], s: 'string' })
  })

  it('args: object, array, primitives, undefined', async () => {
    assert.deepEqual((await run('return args\n', { args: { files: ['a', 'b'], n: 2 } })).value, { files: ['a', 'b'], n: 2 })
    assert.deepEqual((await run('return [Array.isArray(args), args.length, args instanceof Array]\n', { args: [1, 2, 3] })).value, [true, 3, true])
    assert.equal((await run('return args\n', { args: 'text' })).value, 'text')
    assert.equal((await run('return args\n', { args: 7 })).value, 7)
    assert.equal((await run('return args\n', { args: null })).value, null)
    assert.deepEqual((await run('return [typeof args, args === undefined]\n')).value, ['undefined', true])
  })

  it('args that cannot be serialized throw an error before start', async () => {
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    await assert.rejects(run('return 1\n', { args: cyc }), /The args value cannot be serialized to JSON/)
  })

  it('invalid script → ScriptValidationError with diagnostics, hooks are not called', async () => {
    const m = makeHooks()
    await assert.rejects(
      runWithMeta("const x = require('fs')\n", { hooks: m.hooks }),
      (e: unknown) => {
        assert.ok(e instanceof ScriptValidationError)
        assert.equal(e.code, 'SCRIPT_INVALID')
        assert.ok(e.diagnostics.some((d) => /missing `export const meta/.test(d)))
        assert.ok(e.diagnostics.some((d) => /require/.test(d)))
        return true
      },
    )
    assert.equal(m.events.length, 0)
  })

  it('script error: original message and stack with script line number and its name', async () => {
    const body = 'const a = 1\n\nfunction boom() {\n  throw new RangeError("bad value 42")\n}\nboom()\n'
    await assert.rejects(run(body, { filename: 'my-script.ts' }), (e: unknown) => {
      assert.ok(e instanceof RangeError)
      assert.equal(e.message, 'bad value 42')
      assert.match(e.stack ?? '', /my-script\.ts:5:/, e.stack) // META is line 1, throw is on line 5
      assert.match(e.stack ?? '', /my-script\.ts:7:/) // call boom()
      assert.ok(!/ultracode-runtime/.test(e.stack ?? ''))
      return true
    })
  })

  it('error after await also has the correct line', async () => {
    const body = 'await agent("x")\n\nconst o = null\nreturn o.pole\n'
    await assert.rejects(run(body, { filename: 'wf.ts' }), (e: unknown) => {
      assert.ok(e instanceof TypeError)
      assert.match(e.stack ?? '', /wf\.ts:5:/, e.stack)
      return true
    })
  })

  it('a thrown non-Error value is kept as a message', async () => {
    await assert.rejects(run('throw "just text"\n'), (e: unknown) => {
      assert.ok(e instanceof Error)
      assert.equal(e.message, 'just text')
      return true
    })
  })

  it('script stuck on a Promise that never resolves ends with an error instead of hanging', async () => {
    const t0 = Date.now()
    await assert.rejects(run('await new Promise(() => {})\n'), /is stuck/)
    assert.ok(Date.now() - t0 < 3000)
  })

  it('but waiting for a slow agent is not a hang', async () => {
    const d = deferred<string>()
    const m = makeHooks({ agent: () => d.promise })
    const p = run('return await agent("slow")\n', { hooks: m.hooks })
    await waitFor(() => m.prompts().length === 1)
    await new Promise((r) => setTimeout(r, 120))
    d.resolve('done')
    assert.equal((await p).value, 'done')
  })
})

describe('isolation and determinism', () => {
  it('the context has no process, require, module…', async () => {
    const res = await run(
      `return {
  process: typeof process, require: typeof require, module: typeof module, setTimeout: typeof setTimeout,
  fetch: typeof fetch, Buffer: typeof Buffer, gp: typeof globalThis.process, global: typeof global,
  exports: typeof exports, queueMicrotask: typeof queueMicrotask, performance: typeof performance,
}\n`,
    )
    for (const [k, v] of Object.entries(res.value as Record<string, string>)) assert.equal(v, 'undefined', k)
  })

  it('standard builtins are available', async () => {
    const res = await run(
      `return [
  JSON.stringify({ a: 1 }), Math.max(1, 5), [3, 1, 2].sort().join(''), new Map([[1, 2]]).size, new Set([1, 1]).size,
  /a(b)/.exec('ab')[1], new Error('x') instanceof Error, typeof Intl.NumberFormat, Number('3') + 1, structuredClone === undefined,
]\n`.replace('structuredClone === undefined', "typeof structuredClone === 'undefined'"),
    )
    assert.deepEqual(res.value, ['{"a":1}', 5, '123', 1, 1, 'b', true, 'function', 4, true])
  })

  it('eval and new Function are forbidden', async () => {
    const res = await run(
      `const out = []
for (const f of [() => eval('1+1'), () => new Function('return 1')()]) {
  try { out.push(String(f())) } catch (e) { out.push(e.name) }
}
return out\n`,
    )
    assert.deepEqual(res.value, ['EvalError', 'EvalError'])
  })

  it('Date.now(), Math.random(), new Date(), Date() throw DeterminismError (English message, code)', async () => {
    const res = (await run(
      `const out = {}
for (const [k, f] of Object.entries({
  now: () => Date.now(), random: () => Math.random(), ctor: () => new Date(), call: () => Date(),
  sub: () => { class D extends Date {}; return new D() },
})) {
  try { f(); out[k] = 'did not throw' } catch (e) { out[k] = { name: e.name, code: e.code, msg: e.message, isError: e instanceof Error } }
}
return out\n`,
    )).value as Record<string, { name: string; code: string; msg: string; isError: boolean }>
    for (const k of ['now', 'random', 'ctor', 'call', 'sub']) {
      assert.equal(res[k]!.name, 'DeterminismError', k)
      assert.equal(res[k]!.code, 'NON_DETERMINISTIC', k)
      assert.equal(res[k]!.isError, true, k)
      assert.match(res[k]!.msg, /is not allowed in a workflow script/, k)
    }
    assert.match(res.now!.msg, /^Date\.now\(\)/)
    assert.match(res.random!.msg, /^Math\.random\(\)/)
    assert.match(res.ctor!.msg, /^new Date\(\)/)
  })

  it('Date with arguments, Date.UTC, Date.parse, instanceof and subclass work normally', async () => {
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

  it('guards in one run do not affect the next run (each script has its own context)', async () => {
    await run('try { Date.now() } catch {}\nreturn 1\n')
    const res = await run('return typeof Date.now\n')
    assert.equal(res.value, 'function')
  })

  it('console.* goes to hook log; log() converts values to text', async () => {
    const m = makeHooks()
    await run(
      `console.log('a', 1, { x: [1] }, null)
console.info('info')
console.warn('careful')
console.error('oops')
log('plain')
log({ k: 1 })
log(new Error('E!'))
log(undefined)\n`,
      { hooks: m.hooks },
    )
    assert.deepEqual(m.logs(), ['a 1 {"x":[1]} null', 'info', '[warn] careful', '[error] oops', 'plain', '{"k":1}', 'Error: E!', 'undefined'])
  })
})

describe('phase / log / agent: order and context', () => {
  it('phase, log and agent reach the hooks in the same order the script called them', async () => {
    const m = makeHooks()
    await run(
      `phase('A')
log('l1')
const r = await agent('p1', { label: 'L1', phase: 'A' })
phase('B')
log('l2:' + r)
await agent('p2')
log('end')\n`,
      { hooks: m.hooks },
    )
    assert.deepEqual(
      m.events.map((e) => e.t + ':' + ('title' in e ? e.title : 'message' in e ? e.message : 'prompt' in e ? e.prompt : '')),
      ['phase:A', 'log:l1', 'agent:p1', 'phase:B', 'log:l2:echo:p1', 'agent:p2', 'log:end'],
    )
    const first = m.events.find((e) => e.t === 'agent')
    assert.ok(first && first.t === 'agent')
    assert.deepEqual(first.opts, { label: 'L1', phase: 'A' })
    assert.deepEqual(first.call, { workflowPath: ['t'] })
  })

  it('log() without await before throw is still delivered (fire-and-forget keeps order with the error)', async () => {
    const m = makeHooks()
    await assert.rejects(run("log('before'); throw new Error('end')\n", { hooks: m.hooks }), /end/)
    assert.deepEqual(m.logs(), ['before'])
  })

  it('agent result: string, object (schema), null; null is passed to the script', async () => {
    const m = makeHooks({
      agent: (prompt) => {
        if (prompt === 'obj') return { ok: true, items: [1, 2] }
        if (prompt === 'none') return null
        if (prompt === 'undef') return undefined
        return 'text'
      },
    })
    const res = await run(
      `return [
  await agent('s'), await agent('obj', { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } }),
  await agent('none'), await agent('undef'),
]\n`,
      { hooks: m.hooks },
    )
    assert.deepEqual(res.value, ['text', { ok: true, items: [1, 2] }, null, null])
  })

  it('agent result is from the script realm (instanceof Array/Object, Array.isArray)', async () => {
    const m = makeHooks({ agent: () => ({ list: [1, 2], nested: { a: 1 } }) })
    const res = await run(
      `const r = await agent('x')
return [r instanceof Object, r.list instanceof Array, Array.isArray(r.list), r.list.map((n) => n * 2), Object.keys(r.nested)]\n`,
      { hooks: m.hooks },
    )
    assert.deepEqual(res.value, [true, true, true, [2, 4], ['a']])
  })

  it('hook error (BudgetExceededError) appears in the script as an Error with the same message and code', async () => {
    const m = makeHooks({
      agent: () => {
        throw new BudgetExceededError('Budget exhausted: 100/100 tokens')
      },
    })
    const res = await run(
      `try { await agent('x'); return 'did not throw' } catch (e) { return { msg: e.message, code: e.code, name: e.name, isError: e instanceof Error } }\n`,
      { hooks: m.hooks },
    )
    assert.deepEqual(res.value, {
      msg: 'Budget exhausted: 100/100 tokens',
      code: 'BUDGET_EXCEEDED',
      name: 'BudgetExceededError',
      isError: true,
    })
  })

  it('uncaught hook error fails the script as BudgetExceededError (instanceof and code)', async () => {
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

  it('hook result that cannot be transferred (a function) gives the script a clear error', async () => {
    const m = makeHooks({ agent: () => ({ fn: () => 1 }) })
    const res = await run("try { await agent('x') } catch (e) { return e.message }\n", { hooks: m.hooks })
    assert.match(String(res.value), /cannot be passed to the script/)
  })
})

describe('parallel', () => {
  it('keeps result order even when completed in reverse; a thunk that throws → null, does not throw', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()]
    const m = makeHooks({ agent: (prompt) => gates[Number(prompt)]!.promise })
    const p = run(
      `return await parallel([
  () => agent('0'),
  () => agent('1'),
  () => { throw new Error('sync boom') },
  async () => { await agent('2'); throw new Error('async boom') },
  () => 'value',
])\n`,
      { hooks: m.hooks },
    )
    await waitFor(() => m.prompts().length === 3)
    gates[2]!.resolve('c')
    gates[1]!.resolve('b')
    gates[0]!.resolve('a')
    assert.deepEqual((await p).value, ['a', 'b', null, null, 'value'])
    // failures are not silent: we get a log with the cause
    assert.ok(m.logs().some((l) => /parallel\(\): item 2 failed.*sync boom/.test(l)), m.logs().join('\n'))
    assert.ok(m.logs().some((l) => /parallel\(\): item 3 failed.*async boom/.test(l)))
  })

  it('is a barrier: the next step runs only after ALL thunks finish', async () => {
    const gates = [deferred<string>(), deferred<string>()]
    const m = makeHooks({ agent: (prompt) => (prompt.startsWith('t') ? gates[Number(prompt[1])]!.promise : 'after-barrier') })
    const p = run(
      `const r = await parallel([() => agent('t0'), () => agent('t1')])
const after = await agent('after:' + r.join(','))
return after\n`,
      { hooks: m.hooks },
    )
    await waitFor(() => m.prompts().length === 2)
    gates[0]!.resolve('x')
    await new Promise((r) => setTimeout(r, 100))
    assert.deepEqual(m.prompts(), ['t0', 't1'], 'after must not run until t1 finishes')
    gates[1]!.resolve('y')
    assert.equal((await p).value, 'after-barrier')
    assert.deepEqual(m.prompts(), ['t0', 't1', 'after:x,y'])
  })

  it('all thunks start immediately (concurrently), not one by one', async () => {
    const m = makeHooks({ agent: () => new Promise(() => {}) })
    const ac = new AbortController()
    const p = run("await parallel([1, 2, 3, 4, 5].map((i) => () => agent('a' + i)))\n", { hooks: m.hooks, signal: ac.signal })
    await waitFor(() => m.prompts().length === 5)
    assert.deepEqual(m.prompts(), ['a1', 'a2', 'a3', 'a4', 'a5'])
    ac.abort()
    await assert.rejects(p, { code: 'ABORTED' })
  })

  it('tolerantly accepts resolved Promises instead of functions; empty array → []', async () => {
    const res = await run("return [await parallel([]), await parallel([Promise.resolve(1), () => 2, Promise.reject(new Error('x'))])]\n")
    assert.deepEqual(res.value, [[], [1, 2, null]])
  })

  it('maxItems: above the limit is an error and no thunk runs; default 4096', async () => {
    const m = makeHooks()
    await assert.rejects(
      run("await parallel([1, 2, 3, 4].map((i) => () => agent('a' + i)))\n", { hooks: m.hooks, maxItems: 3 }),
      /parallel\(\): too many items \(4\), maximum is 3/,
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

  it('wrong argument (not an array) is a script error', async () => {
    await assert.rejects(run("await parallel(() => 1)\n"), /parallel\(\): expects an array/)
  })

  it('more than 10 failures: log is limited and the rest summarized', async () => {
    const m = makeHooks()
    await run("await parallel(Array.from({ length: 25 }, () => () => { throw new Error('e') }))\n", { hooks: m.hooks })
    const logs = m.logs()
    assert.equal(logs.filter((l) => /item \d+ failed/.test(l)).length, 10)
    assert.ok(logs.some((l) => /15 more errors not shown \(total 25\)/.test(l)))
  })
})

describe('pipeline', () => {
  it('NO barrier: a fast item moves to stage 2 while a slow one is still in stage 1', async () => {
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
    // B and C finish stage 1, A (slow) still hangs
    gate('s1:B').resolve('rb')
    gate('s1:C').resolve('rc')
    await waitFor(() => m.prompts().includes('s2:B:rb') && m.prompts().includes('s2:C:rc'), 3000, 'stage 2 for B and C')
    assert.ok(!m.prompts().includes('s2:A:ra'))
    assert.equal(
      m.prompts().filter((x) => x.startsWith('s2:')).length,
      2,
      'stage 2 for A must not run before its stage 1 finishes',
    )
    gate('s2:B:rb').resolve('fb')
    // B is even done before A finishes stage 1 at all
    gate('s1:A').resolve('ra')
    await waitFor(() => m.prompts().includes('s2:A:ra'))
    gate('s2:A:ra').resolve('fa')
    gate('s2:C:rc').resolve('fc')
    assert.deepEqual((await p).value, ['fa', 'fb', 'fc'])
  })

  it('stage receives (prev, original, index); results in item order', async () => {
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

  it('throw in a stage → null and the remaining stages are skipped for that item; other items unaffected', async () => {
    const m = makeHooks()
    const res = await run(
      `return await pipeline([1, 2, 3],
  async (x) => { if (x === 2) throw new Error('stage1 failed'); return x * 10 },
  async (x) => { await agent('s2:' + x); return x + 1 },
  (x) => 'final:' + x,
)\n`,
      { hooks: m.hooks },
    )
    assert.deepEqual(res.value, ['final:11', null, 'final:31'])
    assert.deepEqual(m.prompts().sort(), ['s2:10', 's2:30'])
    assert.ok(m.logs().some((l) => /pipeline\(\): item 1, stage 1 failed.*stage1 failed/.test(l)))
  })

  it('null RETURNED by a stage is passed on (not skipped)', async () => {
    const res = await run(
      `return await pipeline(['a', 'b'],
  (x) => (x === 'a' ? null : 'ok'),
  (prev, original) => (prev === null ? 'FAILED:' + original : prev + ':' + original),
)\n`,
    )
    assert.deepEqual(res.value, ['FAILED:a', 'ok:b'])
  })

  it('without stages returns items; one stage; empty array', async () => {
    assert.deepEqual((await run('return [await pipeline([1, 2]), await pipeline([], (x) => x), await pipeline([3], (x) => x * 2)]\n')).value, [
      [1, 2],
      [],
      [6],
    ])
  })

  it('maxItems and wrong arguments', async () => {
    await assert.rejects(run('await pipeline([1, 2, 3], (x) => x)\n', { maxItems: 2 }), /pipeline\(\): too many items \(3\), maximum is 2/)
    await assert.rejects(run("await pipeline('abc', (x) => x)\n"), /first argument must be an array/)
    await assert.rejects(run("await pipeline([1], 'not-a-function')\n"), /stage 1 must be a function/)
  })

  it('agent() inside pipeline: budget error → null for the item, the run completes', async () => {
    const m = makeHooks({
      agent: (prompt) => {
        if (prompt.endsWith('2')) throw new BudgetExceededError('cap')
        return 'ok:' + prompt
      },
    })
    const res = await run("return await pipeline([1, 2, 3], (i) => agent('p' + i))\n", { hooks: m.hooks })
    assert.deepEqual(res.value, ['ok:p1', null, 'ok:p3'])
  })
})

describe('budget', () => {
  it('no limit: total null, remaining Infinity', async () => {
    const res = await run(
      'return { total: budget.total, totalUsd: budget.totalUsd, spent: budget.spent(), rem: String(budget.remaining()), remUsd: String(budget.remainingUsd()), spentUsd: budget.spentUsd() }\n',
      { budget: budgetBuffer({ spent: 1234, spentUsd: 0.5 }) },
    )
    assert.deepEqual(res.value, { total: null, totalUsd: null, spent: 1234, rem: 'Infinity', remUsd: 'Infinity', spentUsd: 0.5 })
  })

  it('with limit: total, remaining, remainingUsd (and never negative)', async () => {
    const res = await run(
      'return { total: budget.total, totalUsd: budget.totalUsd, rem: budget.remaining(), remUsd: budget.remainingUsd() }\n',
      { budget: budgetBuffer({ spent: 300, total: 1000, spentUsd: 1.5, totalUsd: 1 }) },
    )
    assert.deepEqual(res.value, { total: 1000, totalUsd: 1, rem: 700, remUsd: 0 })
  })

  it('reads LIVE from SharedArrayBuffer: values change as the engine writes them', async () => {
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

  it('loop-until-budget pattern works', async () => {
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
    assert.equal(res.value, 3) // 1000 left → 700 → 400 → 100; at 100 the condition `> 100` no longer holds
  })

  it('too-small budgetBuffer is a usage error', async () => {
    await assert.rejects(run('return 1\n', { budget: new SharedArrayBuffer(8) }), /budgetBuffer/)
  })
})

describe('meta + run together', () => {
  it('script with META constant and multiple phases', async () => {
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

  it('META helper is valid (sanity)', () => {
    assert.match(META, /export const meta/)
  })
})
