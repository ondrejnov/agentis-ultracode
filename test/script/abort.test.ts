import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AbortedError } from '../../src/errors.ts'
import { deferred, makeHooks, run, runWithMeta, waitFor } from './helpers.ts'

describe('abort', () => {
  it('abort uprostřed čekání na agenta → AbortedError, skript se nedokončí', async () => {
    const m = makeHooks({ agent: () => new Promise(() => {}) })
    const ac = new AbortController()
    const t0 = Date.now()
    const p = run("log('před')\nawait agent('visí navždy')\nlog('PO – nesmí se stát')\n", { hooks: m.hooks, signal: ac.signal })
    await waitFor(() => m.prompts().length === 1)
    ac.abort()
    await assert.rejects(p, (e: unknown) => {
      assert.ok(e instanceof AbortedError)
      assert.equal(e.code, 'ABORTED')
      return true
    })
    assert.ok(Date.now() - t0 < 3000)
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(m.logs(), ['před'])
  })

  it('abort přeruší i nekonečnou synchronní smyčku while(true){}', async () => {
    const m = makeHooks()
    const ac = new AbortController()
    const t0 = Date.now()
    const p = run("log('start')\nwhile (true) {}\n", { hooks: m.hooks, signal: ac.signal })
    await waitFor(() => m.logs().length === 1)
    await new Promise((r) => setTimeout(r, 50)) // ať smyčka opravdu točí
    ac.abort()
    await assert.rejects(p, AbortedError)
    assert.ok(Date.now() - t0 < 3000, 'abort musí zabrat okamžitě, ne po dokončení smyčky')
  })

  it('abort přeruší nekonečnou smyčku s mikrotasky (await v cyklu)', async () => {
    const m = makeHooks()
    const ac = new AbortController()
    const p = run("log('start')\nlet i = 0\nwhile (true) { i++; await Promise.resolve() }\n", { hooks: m.hooks, signal: ac.signal })
    await waitFor(() => m.logs().length === 1)
    ac.abort()
    await assert.rejects(p, AbortedError)
  })

  it('už přerušený signál: odmítne hned a nespustí nic', async () => {
    const m = makeHooks()
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(run("log('x')\n", { hooks: m.hooks, signal: ac.signal }), AbortedError)
    assert.equal(m.events.length, 0)
  })

  it('abort po dokončení nic nezmění; signál se po běhu odpojí', async () => {
    const ac = new AbortController()
    const res = await run('return 1\n', { signal: ac.signal })
    assert.equal(res.value, 1)
    ac.abort() // nesmí vyhodit ani způsobit nezachycenou rejection
    await new Promise((r) => setTimeout(r, 20))
  })

  it('abort při čekání na loadWorkflow i uvnitř potomka', async () => {
    const gate = deferred<never>()
    const m = makeHooks({ loadWorkflow: () => gate.promise })
    const ac = new AbortController()
    const p = run("await workflow('x')\n", { hooks: m.hooks, signal: ac.signal })
    await waitFor(() => m.events.some((e) => e.t === 'load'))
    ac.abort()
    await assert.rejects(p, AbortedError)

    const m2 = makeHooks({
      loadWorkflow: () => ({ source: "export const meta = { name: 'c', description: 'd' }\nlog('child-start')\nwhile (true) {}\n", filename: 'c.ts' }),
    })
    const ac2 = new AbortController()
    const p2 = run("await workflow('c')\n", { hooks: m2.hooks, signal: ac2.signal })
    await waitFor(() => m2.logs().includes('child-start'))
    ac2.abort()
    await assert.rejects(p2, AbortedError)
  })

  it('po abortu hooky, které doběhnou později, nic nerozbijí (žádná nezachycená chyba)', async () => {
    const late = deferred<string>()
    const m = makeHooks({ agent: () => late.promise })
    const ac = new AbortController()
    const p = run("await agent('x')\n", { hooks: m.hooks, signal: ac.signal })
    await waitFor(() => m.prompts().length === 1)
    ac.abort()
    await assert.rejects(p, AbortedError)
    late.resolve('pozdě') // hook dokončí po terminaci workeru
    await new Promise((r) => setTimeout(r, 50))
  })

  it('opakované běhy po abortu fungují (žádný sdílený stav)', async () => {
    for (let i = 0; i < 3; i++) {
      const ac = new AbortController()
      const p = runWithMeta("export const meta = { name: 'loop', description: 'd' }\nwhile (true) {}\n", { signal: ac.signal })
      setTimeout(() => ac.abort(), 30)
      await assert.rejects(p, AbortedError)
    }
    assert.equal((await run('return "ok"\n')).value, 'ok')
  })
})
