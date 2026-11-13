/** Regression tests: cache after moving the project, lock holder identity. */
import assert from 'node:assert/strict'
import { renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { runWorkflow } from '../../src/engine/engine.ts'
import { lockHolderAlive, processStartTime } from '../../src/engine/proc.ts'
import { makeProject, makeRunner, scriptDeps } from './helpers.ts'

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
