/** Regression tests: budget of concurrent agents, cache after moving the project, lock holder identity. */
import assert from 'node:assert/strict'
import { renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { runWorkflow } from '../../src/engine/engine.ts'
import { lockHolderAlive, processStartTime } from '../../src/engine/proc.ts'
import { makeProject, makeRunner, scriptDeps } from './helpers.ts'

describe('USD budget with concurrent agents', () => {
  test('the second agent waits for the reservation to be released and gets the remainder (not an error, not the whole limit)', async () => {
    const p = makeProject()
    try {
      const stub = makeRunner({ delayMs: 30, costUsd: 0.08 })
      const summary = await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: stub.runner, concurrency: 2, maxUsd: 0.1 },
        scriptDeps(async (api) => api.parallel([() => api.agent('first'), () => api.agent('second')])),
      )
      assert.equal(summary.status, 'completed')
      assert.ok(Array.isArray(summary.result))
      assert.ok((summary.result as unknown[]).every((r) => r !== null), 'both agents got a result')
      assert.equal(stub.calls.length, 2)
      // the first reserved the whole limit, the second got only the remainder after its spending
      assert.ok(Math.abs((stub.calls[0].maxBudgetUsd ?? -1) - 0.1) < 1e-9)
      assert.ok(Math.abs((stub.calls[1].maxBudgetUsd ?? -1) - 0.02) < 1e-9)
    } finally {
      p.cleanup()
    }
  })

  test('sequential agents get the whole remainder (demand = 1), not a share based on the number of slots', async () => {
    const p = makeProject()
    try {
      const stub = makeRunner({ costUsd: 0.01 })
      await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: stub.runner, concurrency: 4, maxUsd: 0.1 },
        scriptDeps(async (api) => {
          await api.agent('a')
          await api.agent('b')
          return null
        }),
      )
      assert.ok(Math.abs((stub.calls[0].maxBudgetUsd ?? -1) - 0.1) < 1e-9)
      assert.ok(Math.abs((stub.calls[1].maxBudgetUsd ?? -1) - 0.09) < 1e-9)
    } finally {
      p.cleanup()
    }
  })
})

describe('cache after moving the project', () => {
  test('the cache key uses the path relative to the project → resume from a renamed directory is a 100% cache hit', async () => {
    const p = makeProject()
    const moved = `${p.cwd}-moved`
    try {
      const body = scriptDeps(async (api) => [await api.agent('x'), await api.agent('y')])
      const s1 = await runWorkflow({ workflow: p.script(), cwd: p.cwd, runner: makeRunner().runner }, body)
      assert.equal(s1.status, 'completed')
      renameSync(p.cwd, moved)
      const stub = makeRunner()
      const s2 = await runWorkflow({ workflow: '', cwd: moved, runner: stub.runner, resumeRunId: s1.runId }, body)
      assert.equal(s2.status, 'completed', s2.error)
      assert.equal(s2.totals.cachedAgents, 2)
      assert.equal(stub.calls.length, 0)
    } finally {
      rmSync(moved, { recursive: true, force: true })
      p.cleanup()
    }
  })
})

describe('lock holder identity', () => {
  test('a reused PID (different start time) is not the holder; its own start time is', () => {
    const own = processStartTime(process.pid)
    if (own === null) return // outside Linux (/proc) the identity cannot be verified
    assert.equal(lockHolderAlive({ pid: process.pid, start: own }), true)
    assert.equal(lockHolderAlive({ pid: process.pid, start: `${own}-other` }), false)
    assert.equal(lockHolderAlive({ pid: process.pid }), true)
    assert.equal(lockHolderAlive({ pid: 0 }), false)
  })

  test('lock with a foreign start time (reused PID) does not block resume', async () => {
    const p = makeProject()
    try {
      const s1 = await runWorkflow({ workflow: p.script(), cwd: p.cwd, runner: makeRunner().runner }, scriptDeps(async (api) => api.agent('z')))
      const lock = join(s1.runDir, '.lock')
      const { writeFileSync } = await import('node:fs')
      writeFileSync(lock, JSON.stringify({ pid: process.pid, start: 'foreign-process', ts: new Date().toISOString() }))
      if (processStartTime(process.pid) === null) return
      const s2 = await runWorkflow({ workflow: '', cwd: p.cwd, runner: makeRunner().runner, resumeRunId: s1.runId }, scriptDeps(async (api) => api.agent('z')))
      assert.equal(s2.status, 'completed', s2.error)
    } finally {
      p.cleanup()
    }
  })
})
