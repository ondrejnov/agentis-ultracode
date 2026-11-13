import assert from 'node:assert/strict'
import { availableParallelism } from 'node:os'
import { describe, test } from 'node:test'
import { resolveAgentisTelemetry, resolveConcurrency, runWorkflow } from '../../src/engine/engine.ts'
import { Semaphore } from '../../src/engine/semaphore.ts'
import { eventsOf, journalOf, makeProject, makeRunner, scriptDeps } from './helpers.ts'

describe('concurrency (semaphore)', () => {
  test('opts.concurrency is really respected (and used)', async () => {
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

  test('concurrency 1 serializes and keeps FIFO start order; agent ids = start order', async () => {
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

  test('env ULTRACODE_MAX_CONCURRENCY is used, opts.concurrency overrides it', async () => {
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

  test('resolveConcurrency: default min(16, max(1, cpus-2)), invalid values are ignored', () => {
    const expected = Math.min(16, Math.max(1, availableParallelism() - 2))
    assert.equal(resolveConcurrency(undefined, {}), expected)
    assert.equal(resolveConcurrency(undefined, { ULTRACODE_MAX_CONCURRENCY: 'abc' }), expected)
    assert.equal(resolveConcurrency(undefined, { ULTRACODE_MAX_CONCURRENCY: '0' }), expected)
    assert.equal(resolveConcurrency(undefined, { ULTRACODE_MAX_CONCURRENCY: '7' }), 7)
    assert.equal(resolveConcurrency(5, { ULTRACODE_MAX_CONCURRENCY: '7' }), 5)
    assert.equal(resolveConcurrency(0, { ULTRACODE_MAX_CONCURRENCY: '7' }), 7)
    assert.equal(resolveConcurrency(2.9, {}), 2)
  })

  test('Semaphore: abort removes waiters and a slot is never lost', async () => {
    const sem = new Semaphore(1)
    const r1 = await sem.acquire()
    const ac = new AbortController()
    const waiting = sem.acquire(ac.signal)
    const waiting2 = sem.acquire()
    ac.abort()
    await assert.rejects(waiting, (e: any) => e.code === 'ABORTED')
    assert.equal(sem.waiting, 1)
    r1()
    r1() // idempotent
    const r2 = await waiting2
    assert.equal(sem.inUse, 1)
    r2()
    assert.equal(sem.inUse, 0)
    assert.equal(sem.peak, 1)
    await assert.rejects(sem.acquire(AbortSignal.abort()), (e: any) => e.code === 'ABORTED')
    assert.throws(() => new Semaphore(0))
  })
})

describe('agent limit', () => {
  test('maxAgents: the next call throws BudgetExceededError, becomes null in parallel(), and the run finishes', async () => {
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

  test('maxAgents: uncaught error in script → failed with budgetExceeded', async () => {
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
      assert.match(summary.error ?? '', /Agent limit of 2 per run exceeded/)
      assert.equal(stub.calls.length, 2)
    } finally {
      p.cleanup()
    }
  })

})

describe('budget', () => {
  test('the usage of a failed agent is still counted', async () => {
    const p = makeProject()
    try {
      const stub = makeRunner({ outputTokens: 40, costUsd: 0.01, fail: () => 'boom' })
      const summary = await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: stub.runner },
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

  test('without limits budget.total is null and usage is still counted', async () => {
    const p = makeProject()
    try {
      const summary = await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: makeRunner({ outputTokens: 7 }).runner },
        scriptDeps(async (api) => {
          await api.agent('x')
          return { total: api.budget.total, spent: api.budget.spent() }
        }),
      )
      assert.deepEqual(summary.result, { total: null, spent: 7 })
    } finally {
      p.cleanup()
    }
  })
})

describe('Agentis telemetry', () => {
  const env = { AGENTIS_TASK_ID: 'task-1', AGENTIS_RUN_ID: 'run-1', AGENTIS_ENDPOINT: 'https://agentis.local/api' }

  test('resolveAgentisTelemetry: on only inside an Agentis run, opt-out via ULTRACODE_AGENTIS_TELEMETRY', () => {
    assert.deepEqual(resolveAgentisTelemetry(env), { taskId: 'task-1', runId: 'run-1' })
    assert.deepEqual(resolveAgentisTelemetry({ ...env, AGENTIS_SESSION_ID: 'ses-a', CLAUDE_CODE_SESSION_ID: 'ses-c' }), { taskId: 'task-1', runId: 'run-1', parentSessionId: 'ses-c' })
    assert.deepEqual(resolveAgentisTelemetry({ ...env, AGENTIS_SESSION_ID: 'ses-a' }), { taskId: 'task-1', runId: 'run-1', parentSessionId: 'ses-a' })
    assert.equal(resolveAgentisTelemetry({}), null)
    assert.equal(resolveAgentisTelemetry({ ...env, AGENTIS_ENDPOINT: '' }), null)
    assert.equal(resolveAgentisTelemetry({ ...env, AGENTIS_RUN_ID: ' ' }), null)
    for (const off of ['0', 'false', 'OFF', 'no']) assert.equal(resolveAgentisTelemetry({ ...env, ULTRACODE_AGENTIS_TELEMETRY: off }), null)
    assert.notEqual(resolveAgentisTelemetry({ ...env, ULTRACODE_AGENTIS_TELEMETRY: '1' }), null)
    // under the node test runner it is off unless forced on (tests must not write into a real Agentis transcript)
    assert.equal(resolveAgentisTelemetry({ ...env, NODE_TEST_CONTEXT: 'child-v8' }), null)
    assert.notEqual(resolveAgentisTelemetry({ ...env, NODE_TEST_CONTEXT: 'child-v8', ULTRACODE_AGENTIS_TELEMETRY: '1' }), null)
  })

  test('every agent gets the target and a session title "[phase] label #id"; null turns it off', async () => {
    const p = makeProject()
    try {
      const agentis = { taskId: 'task-1', runId: 'run-1', parentSessionId: 'ses-main' }
      const body = scriptDeps(async (api) => [await api.agent('a', { label: 'scan', phase: 'Scan' }), await api.agent('b')])
      const on = makeRunner()
      await runWorkflow({ workflow: p.script(), cwd: p.cwd, runner: on.runner, agentis }, body)
      assert.deepEqual(on.calls.map((r) => r.agentis), [agentis, agentis])
      assert.equal(on.calls[0]!.title, '[Scan] scan #1')
      assert.match(on.calls[1]!.title!, /^[^[].* #2$/) // no phase → no "[…]" prefix
      const off = makeRunner()
      await runWorkflow({ workflow: p.script(), cwd: p.cwd, runner: off.runner, agentis: null }, body)
      assert.deepEqual(off.calls.map((r) => [r.agentis, r.title]), [[undefined, undefined], [undefined, undefined]])
    } finally {
      p.cleanup()
    }
  })
})
