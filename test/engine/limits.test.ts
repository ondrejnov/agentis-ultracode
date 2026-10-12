import assert from 'node:assert/strict'
import { availableParallelism } from 'node:os'
import { describe, test } from 'node:test'
import { resolveConcurrency, runWorkflow } from '../../src/engine/engine.ts'
import { Semaphore } from '../../src/engine/semaphore.ts'
import { eventsOf, journalOf, makeProject, makeRunner, scriptDeps } from './helpers.ts'

describe('souběžnost (semafor)', () => {
  test('opts.concurrency je skutečně dodržen (a využit)', async () => {
    const p = makeProject()
    try {
      const stub = makeRunner({ delayMs: 25 })
      const summary = await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: stub.runner, concurrency: 3 },
        scriptDeps(async (api) => api.parallel(Array.from({ length: 10 }, (_, i) => () => api.agent(`job ${i}`)))),
      )
      assert.equal(summary.status, 'completed')
      assert.equal(stub.calls.length, 10)
      assert.equal(stub.maxInFlight, 3)
      assert.equal(stub.inFlight, 0)
      assert.equal((summary.result as unknown[]).filter(Boolean).length, 10)
    } finally {
      p.cleanup()
    }
  })

  test('concurrency 1 serializuje a zachová FIFO pořadí startu; id agentů = pořadí startu', async () => {
    const p = makeProject()
    try {
      const stub = makeRunner({ delayMs: 5 })
      const summary = await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: stub.runner, concurrency: 1 },
        scriptDeps(async (api) => api.parallel(Array.from({ length: 5 }, (_, i) => () => api.agent(`job ${i}`)))),
      )
      assert.equal(stub.maxInFlight, 1)
      assert.deepEqual(stub.prompts(), ['job 0', 'job 1', 'job 2', 'job 3', 'job 4'])
      const starts = eventsOf(summary).filter((e) => e.t === 'agent_start')
      assert.deepEqual(starts.map((e) => (e.t === 'agent_start' ? [e.id, e.promptPreview] : null)), [
        [1, 'job 0'],
        [2, 'job 1'],
        [3, 'job 2'],
        [4, 'job 3'],
        [5, 'job 4'],
      ])
    } finally {
      p.cleanup()
    }
  })

  test('env ULTRACODE_MAX_CONCURRENCY se použije, opts.concurrency ho přebíjí', async () => {
    const p = makeProject()
    const prev = process.env.ULTRACODE_MAX_CONCURRENCY
    try {
      process.env.ULTRACODE_MAX_CONCURRENCY = '2'
      const body = scriptDeps(async (api) => api.parallel(Array.from({ length: 8 }, (_, i) => () => api.agent(`j${i}`))))
      const a = makeRunner({ delayMs: 20 })
      await runWorkflow({ workflow: p.script(), cwd: p.cwd, runner: a.runner }, body)
      assert.equal(a.maxInFlight, 2)
      const b = makeRunner({ delayMs: 20 })
      await runWorkflow({ workflow: p.script(), cwd: p.cwd, runner: b.runner, concurrency: 4 }, body)
      assert.equal(b.maxInFlight, 4)
    } finally {
      if (prev === undefined) delete process.env.ULTRACODE_MAX_CONCURRENCY
      else process.env.ULTRACODE_MAX_CONCURRENCY = prev
      p.cleanup()
    }
  })

  test('resolveConcurrency: default min(16, max(1, cpus-2)), neplatné hodnoty se ignorují', () => {
    const expected = Math.min(16, Math.max(1, availableParallelism() - 2))
    assert.equal(resolveConcurrency(undefined, {}), expected)
    assert.equal(resolveConcurrency(undefined, { ULTRACODE_MAX_CONCURRENCY: 'abc' }), expected)
    assert.equal(resolveConcurrency(undefined, { ULTRACODE_MAX_CONCURRENCY: '0' }), expected)
    assert.equal(resolveConcurrency(undefined, { ULTRACODE_MAX_CONCURRENCY: '7' }), 7)
    assert.equal(resolveConcurrency(5, { ULTRACODE_MAX_CONCURRENCY: '7' }), 5)
    assert.equal(resolveConcurrency(0, { ULTRACODE_MAX_CONCURRENCY: '7' }), 7)
    assert.equal(resolveConcurrency(2.9, {}), 2)
  })

  test('Semaphore: abort vyřadí čekatele a slot se nikdy neztratí', async () => {
    const sem = new Semaphore(1)
    const r1 = await sem.acquire()
    const ac = new AbortController()
    const waiting = sem.acquire(ac.signal)
    const waiting2 = sem.acquire()
    ac.abort()
    await assert.rejects(waiting, (e: any) => e.code === 'ABORTED')
    assert.equal(sem.waiting, 1)
    r1()
    r1() // idempotentní
    const r2 = await waiting2
    assert.equal(sem.inUse, 1)
    r2()
    assert.equal(sem.inUse, 0)
    assert.equal(sem.peak, 1)
    await assert.rejects(sem.acquire(AbortSignal.abort()), (e: any) => e.code === 'ABORTED')
    assert.throws(() => new Semaphore(0))
  })
})

describe('limit agentů', () => {
  test('maxAgents: další volání vyhodí BudgetExceededError, v parallel() se změní na null, běh doběhne', async () => {
    const p = makeProject()
    try {
      const stub = makeRunner()
      const summary = await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: stub.runner, maxAgents: 3 },
        scriptDeps(async (api) => api.parallel(Array.from({ length: 5 }, (_, i) => () => api.agent(`p${i}`)))),
      )
      assert.equal(summary.status, 'completed')
      assert.equal(summary.budgetExceeded, true)
      assert.equal(stub.calls.length, 3)
      assert.deepEqual(summary.result, ['out:p0', 'out:p1', 'out:p2', null, null])
      assert.equal(summary.totals.agents, 3)
    } finally {
      p.cleanup()
    }
  })

  test('maxAgents: nezachycená chyba ve skriptu → failed s budgetExceeded', async () => {
    const p = makeProject()
    try {
      const stub = makeRunner()
      const summary = await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: stub.runner, maxAgents: 2 },
        scriptDeps(async (api) => {
          for (let i = 0; i < 5; i++) await api.agent(`s${i}`)
          return 'nikdy'
        }),
      )
      assert.equal(summary.status, 'failed')
      assert.equal(summary.budgetExceeded, true)
      assert.match(summary.error ?? '', /limit 2 agentů/)
      assert.equal(stub.calls.length, 2)
    } finally {
      p.cleanup()
    }
  })

  test('cache hity se do maxAgents počítají (každé volání agent() je agent), ale nespotřebují rozpočet', async () => {
    const p = makeProject()
    try {
      const body = scriptDeps(async (api) => [await api.agent('a'), await api.agent('b')])
      const s1 = await runWorkflow({ workflow: p.script(), cwd: p.cwd, runner: makeRunner().runner, maxOutputTokens: 1000 }, body)
      const stub = makeRunner()
      const s2 = await runWorkflow({ workflow: p.script(), cwd: p.cwd, runner: stub.runner, resumeRunId: s1.runId, maxOutputTokens: 1 }, body)
      assert.equal(s2.status, 'completed')
      assert.equal(s2.budgetExceeded, undefined)
      assert.equal(stub.calls.length, 0)
    } finally {
      p.cleanup()
    }
  })
})

describe('rozpočet', () => {
  test('výstupní tokeny: po dosažení stropu další agent() vyhodí, budget čte spotřebu přes SAB', async () => {
    const p = makeProject()
    try {
      const stub = makeRunner({ outputTokens: 60 })
      let caught: string | undefined
      let spentAfter2 = -1
      const summary = await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: stub.runner, maxOutputTokens: 100 },
        scriptDeps(async (api) => {
          assert.equal(api.budget.total, 100)
          assert.equal(api.budget.totalUsd, null)
          assert.equal(api.budget.spent(), 0)
          await api.agent('1')
          await api.agent('2')
          spentAfter2 = api.budget.spent()
          try {
            await api.agent('3')
          } catch (e) {
            caught = (e as { code?: string }).code
          }
          return 'konec'
        }),
      )
      assert.equal(stub.calls.length, 2)
      assert.equal(spentAfter2, 120)
      assert.equal(caught, 'BUDGET_EXCEEDED')
      assert.equal(summary.status, 'completed')
      assert.equal(summary.budgetExceeded, true)
      assert.equal(summary.totals.usage.outputTokens, 120)
      const lastBudget = eventsOf(summary).filter((e) => e.t === 'budget').pop()
      assert.ok(lastBudget && lastBudget.t === 'budget')
      assert.equal(lastBudget.spentOutputTokens, 120)
      assert.equal(lastBudget.limitOutputTokens, 100)
      assert.equal(lastBudget.limitUsd, null)
    } finally {
      p.cleanup()
    }
  })

  test('USD: strop se dodrží a agentovi se předá zbývající částka jako --max-budget-usd', async () => {
    const p = makeProject()
    try {
      const stub = makeRunner({ costUsd: 0.03 })
      const summary = await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: stub.runner, maxUsd: 0.05 },
        scriptDeps(async (api) => {
          const out: unknown[] = []
          for (let i = 0; i < 4; i++) {
            try {
              out.push(await api.agent(`u${i}`))
            } catch {
              out.push('BUDGET')
            }
          }
          assert.ok(api.budget.spentUsd() >= 0.06 - 1e-9)
          return out
        }),
      )
      assert.deepEqual(summary.result, ['out:u0', 'out:u1', 'BUDGET', 'BUDGET'])
      assert.equal(stub.calls.length, 2)
      assert.ok(Math.abs((stub.calls[0].maxBudgetUsd ?? -1) - 0.05) < 1e-9)
      assert.ok(Math.abs((stub.calls[1].maxBudgetUsd ?? -1) - 0.02) < 1e-9)
      assert.equal(summary.budgetExceeded, true)
    } finally {
      p.cleanup()
    }
  })

  test('souběžně startující agenti: fronta za semaforem znovu zkontroluje rozpočet', async () => {
    const p = makeProject()
    try {
      const stub = makeRunner({ outputTokens: 30, delayMs: 5 })
      const summary = await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: stub.runner, concurrency: 1, maxOutputTokens: 50 },
        scriptDeps(async (api) => api.parallel(Array.from({ length: 6 }, (_, i) => () => api.agent(`q${i}`)))),
      )
      // 30 → 60 >= 50: dál už nikdo nesmí odstartovat, ač všech 6 volání prošlo první kontrolou
      assert.equal(stub.calls.length, 2)
      assert.deepEqual(summary.result, ['out:q0', 'out:q1', null, null, null, null])
      assert.equal(summary.budgetExceeded, true)
      assert.equal(summary.status, 'completed')
    } finally {
      p.cleanup()
    }
  })

  test('selhaný agent také spotřebuje rozpočet (tokeny a USD se ztratily)', async () => {
    const p = makeProject()
    try {
      const stub = makeRunner({ outputTokens: 40, costUsd: 0.01, fail: () => 'boom' })
      const summary = await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: stub.runner, maxOutputTokens: 1000 },
        scriptDeps(async (api) => {
          await api.agent('a')
          return api.budget.spent()
        }),
      )
      assert.equal(summary.result, 40)
      assert.equal(summary.totals.failedAgents, 1)
      assert.ok(Math.abs(summary.totals.costUsd - 0.01) < 1e-9)
      assert.equal(journalOf(summary).length, 0)
    } finally {
      p.cleanup()
    }
  })

  test('bez limitů je budget.total null a spotřeba se přesto počítá', async () => {
    const p = makeProject()
    try {
      const summary = await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: makeRunner({ outputTokens: 7 }).runner },
        scriptDeps(async (api) => {
          await api.agent('x')
          return { total: api.budget.total, totalUsd: api.budget.totalUsd, spent: api.budget.spent() }
        }),
      )
      assert.deepEqual(summary.result, { total: null, totalUsd: null, spent: 7 })
    } finally {
      p.cleanup()
    }
  })
})
