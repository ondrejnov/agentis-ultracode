import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ScriptValidationError, WorkflowNotFoundError } from '../../src/errors.ts'
import type { LoadedScript } from '../../src/types.ts'
import { BUDGET_SLOTS } from '../../src/types.ts'
import { budgetBuffer, makeHooks, run } from './helpers.ts'
import type { MockHooks, MockOptions } from './helpers.ts'

const child = (body: string, name = 'child'): LoadedScript => ({
  source: `export const meta = { name: '${name}', description: 'potomek' }\n${body}`,
  filename: `${name}.workflow.ts`,
})

function hooksWith(files: Record<string, LoadedScript>, agent?: MockOptions['agent']): MockHooks {
  return makeHooks({
    agent,
    loadWorkflow: (ref) => {
      const key = typeof ref === 'string' ? ref : ref.scriptPath
      const f = files[key]
      if (!f) throw new WorkflowNotFoundError(key, ['/nikde'])
      return f
    },
  })
}

describe('workflow(): vnořené workflow', () => {
  it('spustí potomka, předá args, vrátí jeho hodnotu; hooky mají workflowPath s jménem potomka', async () => {
    const m = hooksWith({
      sub: child("phase('P')\nlog('v potomkovi')\nconst r = await agent('child-agent:' + args.x)\nreturn { got: args, r }\n"),
    })
    const res = await run(
      `log('před')
const out = await workflow('sub', { x: 7, list: [1, 2] })
log('po')
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
    // enter/exit nesou jméno potomka a jeho cestu (stejnou jako hooky uvnitř potomka)
    assert.equal(byType('enter')[0]!.name, 'child')
    assert.deepEqual(byType('enter')[0]!.call.workflowPath, ['t', 'child'])
    assert.equal(byType('exit')[0]!.name, 'child')
    assert.deepEqual(byType('exit')[0]!.call.workflowPath, ['t', 'child'])
    // loadWorkflow dostal referenci a kontext
    assert.deepEqual(byType('load')[0], { t: 'load', ref: 'sub', call: { workflowPath: ['t'] } })
  })

  it('potomek běží v novém kontextu: vlastní args, nevidí proměnné rodiče, `args` rodiče zůstane', async () => {
    const m = hooksWith({ sub: child("return { argsInChild: args, leak: typeof PARENT_VAR, mine: typeof myLocal }\n") })
    const res = await run(
      `globalThis.PARENT_VAR = 1
const myLocal = 1
const c = await workflow('sub', 'jen-text')
return { c, parentArgs: args }\n`,
      { hooks: m.hooks, args: { p: 1 } },
    )
    assert.deepEqual(res.value, { c: { argsInChild: 'jen-text', leak: 'undefined', mine: 'undefined' }, parentArgs: { p: 1 } })
  })

  it('bez args je ve potomkovi args === undefined', async () => {
    const m = hooksWith({ sub: child('return typeof args\n') })
    assert.equal((await run("return await workflow('sub')\n", { hooks: m.hooks })).value, 'undefined')
  })

  it('podporuje i { scriptPath }', async () => {
    const m = hooksWith({ '/abs/path/x.ts': child('return 5\n', 'xx') })
    const res = await run("return await workflow({ scriptPath: '/abs/path/x.ts' })\n", { hooks: m.hooks })
    assert.equal(res.value, 5)
    assert.deepEqual((m.events.find((e) => e.t === 'load') as { ref: unknown }).ref, { scriptPath: '/abs/path/x.ts' })
  })

  it('potomek vracející undefined dá null', async () => {
    const m = hooksWith({ sub: child('const a = 1\n') })
    assert.equal((await run("return await workflow('sub')\n", { hooks: m.hooks })).value, null)
  })

  it('sdílí rozpočet s rodičem (stejný SharedArrayBuffer)', async () => {
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

  it('víc potomků souběžně v parallel(); každý má správný workflowPath', async () => {
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

  it('vnoření jen o jednu úroveň: workflow() v potomkovi hodí chybu (a nenačítá se nic dalšího)', async () => {
    const m = hooksWith({
      outer: child("return await workflow('inner')\n", 'outer'),
      inner: child('return 1\n', 'inner'),
    })
    await assert.rejects(run("return await workflow('outer')\n", { hooks: m.hooks }), /jen o jednu úroveň/)
    assert.equal(m.events.filter((e) => e.t === 'load').length, 1)
    // exit se zavolá i při chybě
    assert.equal(m.events.filter((e) => e.t === 'exit').length, 1)

    // potomek může chybu zachytit a vrátit se normálně
    const m2 = hooksWith({ outer: child("try { await workflow('inner') } catch (e) { return 'zachyceno: ' + e.message.slice(0, 20) }\n", 'outer') })
    const res = await run("return await workflow('outer')\n", { hooks: m2.hooks })
    assert.match(String(res.value), /^zachyceno: workflow\(\) nelze/)
  })

  it('chyba potomka se propaguje volajícímu se stejnou zprávou, typem a řádkem potomka; exit proběhne', async () => {
    const m = hooksWith({ bad: child("const a = 1\nthrow new TypeError('chyba v potomkovi')\n", 'bad') })
    await assert.rejects(run("return await workflow('bad')\n", { hooks: m.hooks }), (e: unknown) => {
      assert.ok(e instanceof TypeError)
      assert.equal(e.message, 'chyba v potomkovi')
      assert.match(e.stack ?? '', /bad\.workflow\.ts:3:/, e.stack)
      return true
    })
    assert.deepEqual(
      m.events.map((e) => e.t),
      ['load', 'enter', 'exit'],
    )

    // rodič ji může zachytit
    const m2 = hooksWith({ bad: child("throw new Error('x1')\n", 'bad') })
    const res = await run("try { await workflow('bad') } catch (e) { return 'caught:' + e.message }\n", { hooks: m2.hooks })
    assert.equal(res.value, 'caught:x1')
  })

  it('potomek v parallel() který selže → null, ostatní doběhnou', async () => {
    const m = hooksWith({ ok: child('return 1\n', 'ok'), bad: child("throw new Error('x')\n", 'bad') })
    const res = await run("return await parallel([() => workflow('ok'), () => workflow('bad')])\n", { hooks: m.hooks })
    assert.deepEqual(res.value, [1, null])
  })

  it('neexistující workflow: chyba z loadWorkflow dorazí s kódem', async () => {
    const m = hooksWith({})
    const res = await run(
      "try { await workflow('neni') } catch (e) { return { code: e.code, msg: e.message } }\n",
      { hooks: m.hooks },
    )
    const v = res.value as { code: string; msg: string }
    assert.equal(v.code, 'WORKFLOW_NOT_FOUND')
    assert.match(v.msg, /Workflow „neni“ nenalezeno/)
    assert.equal(m.events.filter((e) => e.t === 'enter').length, 0)
  })

  it('neplatný skript potomka → ScriptValidationError s diagnostikou, enter se nezavolá', async () => {
    const m = hooksWith({ broken: { source: "import x from 'y'\nreturn 1\n", filename: 'broken.ts' } })
    await assert.rejects(run("await workflow('broken')\n", { hooks: m.hooks }), (e: unknown) => {
      assert.ok(e instanceof ScriptValidationError)
      assert.match(e.message, /Vnořené workflow „broken“ je neplatné/)
      assert.ok(e.diagnostics.some((d) => /broken\.ts/.test(d)))
      return true
    })
    assert.equal(m.events.filter((e) => e.t === 'enter').length, 0)
  })

  it('špatný první argument workflow()', async () => {
    for (const bad of ['', '123', '{}', 'null', '{ scriptPath: 5 }']) {
      const res = await run(`try { await workflow(${bad === '' ? "''" : bad}); return 'nehodilo' } catch (e) { return e.message }\n`)
      assert.match(String(res.value), /workflow\(\): první argument/, bad)
    }
  })

  it('potomek má vlastní determinismus guardy a vlastní globály', async () => {
    const m = hooksWith({ sub: child("try { Date.now() } catch (e) { return e.code }\n") })
    assert.equal((await run("return await workflow('sub')\n", { hooks: m.hooks })).value, 'NON_DETERMINISTIC')
  })
})
