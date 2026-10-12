import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ScriptValidationError, WorkflowNotFoundError } from '../../src/errors.ts'
import type { LoadedScript } from '../../src/types.ts'
import { BUDGET_SLOTS } from '../../src/types.ts'
import { budgetBuffer, makeHooks, run } from './helpers.ts'
import type { MockHooks, MockOptions } from './helpers.ts'

const child = (body: string, name = 'child'): LoadedScript => ({
  source: `export const meta = { name: '${name}', description: 'child' }\n${body}`,
  filename: `${name}.workflow.ts`,
})

function hooksWith(files: Record<string, LoadedScript>, agent?: MockOptions['agent']): MockHooks {
  return makeHooks({
    agent,
    loadWorkflow: (ref) => {
      const key = typeof ref === 'string' ? ref : ref.scriptPath
      const f = files[key]
      if (!f) throw new WorkflowNotFoundError(key, ['/nowhere'])
      return f
    },
  })
}

describe('workflow(): nested workflow', () => {
  it('runs the child, passes args, returns its value; hooks have workflowPath with the child name', async () => {
    const m = hooksWith({
      sub: child("phase('P')\nlog('in child')\nconst r = await agent('child-agent:' + args.x)\nreturn { got: args, r }\n"),
    })
    const res = await run(
      `log('before')
const out = await workflow('sub', { x: 7, list: [1, 2] })
log('after')
return out\n`,
      { hooks: m.hooks },
    )
    assert.deepEqual(res.value, { got: { x: 7, list: [1, 2] }, r: 'echo:child-agent:7' })

    assert.deepEqual(
      m.events.map((e) => e.t),
      ['log', 'load', 'enter', 'phase', 'log', 'agent', 'exit', 'log'],
    )
    const byType = <T extends string>(t: T) => m.events.filter((e) => e.t === t) as Array<Extract<(typeof m.events)[number], { t: T }>>
    assert.deepEqual(byType('log')[0]!.call.workflowPath, ['t'])
    assert.deepEqual(byType('phase')[0]!.call.workflowPath, ['t', 'child'])
    assert.deepEqual(byType('log')[1]!.call.workflowPath, ['t', 'child'])
    assert.deepEqual(byType('agent')[0]!.call.workflowPath, ['t', 'child'])
    assert.deepEqual(byType('log')[2]!.call.workflowPath, ['t'])
    // enter/exit carry the child name and its path (same as hooks inside the child)
    assert.equal(byType('enter')[0]!.name, 'child')
    assert.deepEqual(byType('enter')[0]!.call.workflowPath, ['t', 'child'])
    assert.equal(byType('exit')[0]!.name, 'child')
    assert.deepEqual(byType('exit')[0]!.call.workflowPath, ['t', 'child'])
    // loadWorkflow got the reference and context
    assert.deepEqual(byType('load')[0], { t: 'load', ref: 'sub', call: { workflowPath: ['t'] } })
  })

  it('child runs in a new context: own args, cannot see parent variables, parent `args` stays', async () => {
    const m = hooksWith({ sub: child("return { argsInChild: args, leak: typeof PARENT_VAR, mine: typeof myLocal }\n") })
    const res = await run(
      `globalThis.PARENT_VAR = 1
const myLocal = 1
const c = await workflow('sub', 'text-only')
return { c, parentArgs: args }\n`,
      { hooks: m.hooks, args: { p: 1 } },
    )
    assert.deepEqual(res.value, { c: { argsInChild: 'text-only', leak: 'undefined', mine: 'undefined' }, parentArgs: { p: 1 } })
  })

  it('without args the child has args === undefined', async () => {
    const m = hooksWith({ sub: child('return typeof args\n') })
    assert.equal((await run("return await workflow('sub')\n", { hooks: m.hooks })).value, 'undefined')
  })

  it('also supports { scriptPath }', async () => {
    const m = hooksWith({ '/abs/path/x.ts': child('return 5\n', 'xx') })
    const res = await run("return await workflow({ scriptPath: '/abs/path/x.ts' })\n", { hooks: m.hooks })
    assert.equal(res.value, 5)
    assert.deepEqual((m.events.find((e) => e.t === 'load') as { ref: unknown }).ref, { scriptPath: '/abs/path/x.ts' })
  })

  it('child returning undefined gives null', async () => {
    const m = hooksWith({ sub: child('const a = 1\n') })
    assert.equal((await run("return await workflow('sub')\n", { hooks: m.hooks })).value, null)
  })

  it('shares the budget with the parent (same SharedArrayBuffer)', async () => {
    const buf = budgetBuffer({ total: 500, spent: 120 })
    const view = new Float64Array(buf, 0, BUDGET_SLOTS)
    const m = hooksWith(
      { sub: child("const before = budget.spent()\nawait agent('x')\nreturn [before, budget.spent(), budget.remaining()]\n") },
      () => {
        view[0]! += 80
        return 'ok'
      },
    )
    const res = await run(
      "const c = await workflow('sub')\nreturn [c, budget.spent(), budget.total]\n",
      { hooks: m.hooks, budget: buf },
    )
    assert.deepEqual(res.value, [[120, 200, 300], 200, 500])
  })

  it('several children concurrently in parallel(); each has the correct workflowPath', async () => {
    const m = hooksWith({
      a: child("await agent('a1')\nreturn 'A'\n", 'alpha'),
      b: child("await agent('b1')\nreturn 'B'\n", 'beta'),
    })
    const res = await run("return await parallel([() => workflow('a'), () => workflow('b'), () => workflow('a')])\n", { hooks: m.hooks })
    assert.deepEqual(res.value, ['A', 'B', 'A'])
    const agents = m.events.filter((e) => e.t === 'agent') as Array<{ prompt: string; call: { workflowPath: string[] } }>
    const path = (p: string) => agents.find((a) => a.prompt === p)!.call.workflowPath
    assert.deepEqual(path('a1'), ['t', 'alpha'])
    assert.deepEqual(path('b1'), ['t', 'beta'])
    assert.equal(m.events.filter((e) => e.t === 'enter').length, 3)
    assert.equal(m.events.filter((e) => e.t === 'exit').length, 3)
  })

  it('nesting only one level: workflow() in a child throws (and nothing else is loaded)', async () => {
    const m = hooksWith({
      outer: child("return await workflow('inner')\n", 'outer'),
      inner: child('return 1\n', 'inner'),
    })
    await assert.rejects(run("return await workflow('outer')\n", { hooks: m.hooks }), /only one level deep/)
    assert.equal(m.events.filter((e) => e.t === 'load').length, 1)
    // exit is called even on error
    assert.equal(m.events.filter((e) => e.t === 'exit').length, 1)

    // the child can catch the error and return normally
    const m2 = hooksWith({ outer: child("try { await workflow('inner') } catch (e) { return 'caught: ' + e.message.slice(0, 20) }\n", 'outer') })
    const res = await run("return await workflow('outer')\n", { hooks: m2.hooks })
    assert.match(String(res.value), /^caught: workflow\(\) cannot be/)
  })

  it('child error propagates to the caller with the same message, type and child line; exit runs', async () => {
    const m = hooksWith({ bad: child("const a = 1\nthrow new TypeError('error in child')\n", 'bad') })
    await assert.rejects(run("return await workflow('bad')\n", { hooks: m.hooks }), (e: unknown) => {
      assert.ok(e instanceof TypeError)
      assert.equal(e.message, 'error in child')
      assert.match(e.stack ?? '', /bad\.workflow\.ts:3:/, e.stack)
      return true
    })
    assert.deepEqual(
      m.events.map((e) => e.t),
      ['load', 'enter', 'exit'],
    )

    // the parent can catch it
    const m2 = hooksWith({ bad: child("throw new Error('x1')\n", 'bad') })
    const res = await run("try { await workflow('bad') } catch (e) { return 'caught:' + e.message }\n", { hooks: m2.hooks })
    assert.equal(res.value, 'caught:x1')
  })

  it('child in parallel() that fails → null, the others finish', async () => {
    const m = hooksWith({ ok: child('return 1\n', 'ok'), bad: child("throw new Error('x')\n", 'bad') })
    const res = await run("return await parallel([() => workflow('ok'), () => workflow('bad')])\n", { hooks: m.hooks })
    assert.deepEqual(res.value, [1, null])
  })

  it('nonexistent workflow: loadWorkflow error arrives with its code', async () => {
    const m = hooksWith({})
    const res = await run(
      "try { await workflow('neni') } catch (e) { return { code: e.code, msg: e.message } }\n",
      { hooks: m.hooks },
    )
    const v = res.value as { code: string; msg: string }
    assert.equal(v.code, 'WORKFLOW_NOT_FOUND')
    assert.match(v.msg, /Workflow “neni” not found/)
    assert.equal(m.events.filter((e) => e.t === 'enter').length, 0)
  })

  it('invalid child script → ScriptValidationError with diagnostics, enter is not called', async () => {
    const m = hooksWith({ broken: { source: "import x from 'y'\nreturn 1\n", filename: 'broken.ts' } })
    await assert.rejects(run("await workflow('broken')\n", { hooks: m.hooks }), (e: unknown) => {
      assert.ok(e instanceof ScriptValidationError)
      assert.match(e.message, /Nested workflow “broken” is invalid/)
      assert.ok(e.diagnostics.some((d) => /broken\.ts/.test(d)))
      return true
    })
    assert.equal(m.events.filter((e) => e.t === 'enter').length, 0)
  })

  it('wrong first argument of workflow()', async () => {
    for (const bad of ['', '123', '{}', 'null', '{ scriptPath: 5 }']) {
      const res = await run(`try { await workflow(${bad === '' ? "''" : bad}); return 'did not throw' } catch (e) { return e.message }\n`)
      assert.match(String(res.value), /workflow\(\): the first argument/, bad)
    }
  })

  it('child has its own determinism guards and globals', async () => {
    const m = hooksWith({ sub: child("try { Date.now() } catch (e) { return e.code }\n") })
    assert.equal((await run("return await workflow('sub')\n", { hooks: m.hooks })).value, 'NON_DETERMINISTIC')
  })
})
