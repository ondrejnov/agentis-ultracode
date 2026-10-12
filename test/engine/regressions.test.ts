/** Regresní testy: rozpočet souběžných agentů, cache po přesunu projektu, identita držitele zámku. */
import assert from 'node:assert/strict'
import { renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { runWorkflow } from '../../src/engine/engine.ts'
import { lockHolderAlive, processStartTime } from '../../src/engine/proc.ts'
import { makeProject, makeRunner, scriptDeps } from './helpers.ts'

describe('rozpočet v USD u souběžných agentů', () => {
  test('druhý agent počká na uvolnění rezervace a dostane zbytek (ne chybu, ne celý limit)', async () => {
    const p = makeProject()
    try {
      const stub = makeRunner({ delayMs: 30, costUsd: 0.08 })
      const summary = await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: stub.runner, concurrency: 2, maxUsd: 0.1 },
        scriptDeps(async (api) => api.parallel([() => api.agent('první'), () => api.agent('druhý')])),
      )
      assert.equal(summary.status, 'completed')
      assert.ok(Array.isArray(summary.result))
      assert.ok((summary.result as unknown[]).every((r) => r !== null), 'oba agenti dostali výsledek')
      assert.equal(stub.calls.length, 2)
      // první si rezervoval celý limit, druhý dostal jen zbytek po jeho útratě
      assert.ok(Math.abs((stub.calls[0].maxBudgetUsd ?? -1) - 0.1) < 1e-9)
      assert.ok(Math.abs((stub.calls[1].maxBudgetUsd ?? -1) - 0.02) < 1e-9)
    } finally {
      p.cleanup()
    }
  })

  test('sekvenční agenti dostanou celý zbytek (poptávka = 1), ne podíl podle počtu slotů', async () => {
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

describe('cache po přesunu projektu', () => {
  test('klíč cache používá cestu relativně k projektu → resume z přejmenovaného adresáře je 100% cache hit', async () => {
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

describe('identita držitele zámku', () => {
  test('přepoužité PID (jiný start time) není držitel; vlastní start time ano', () => {
    const own = processStartTime(process.pid)
    if (own === null) return // mimo Linux (/proc) nelze identitu ověřit
    assert.equal(lockHolderAlive({ pid: process.pid, start: own }), true)
    assert.equal(lockHolderAlive({ pid: process.pid, start: `${own}-jiny` }), false)
    assert.equal(lockHolderAlive({ pid: process.pid }), true)
    assert.equal(lockHolderAlive({ pid: 0 }), false)
  })

  test('zámek s cizím start time (přepoužité PID) nebrání resume', async () => {
    const p = makeProject()
    try {
      const s1 = await runWorkflow({ workflow: p.script(), cwd: p.cwd, runner: makeRunner().runner }, scriptDeps(async (api) => api.agent('z')))
      const lock = join(s1.runDir, '.lock')
      const { writeFileSync } = await import('node:fs')
      writeFileSync(lock, JSON.stringify({ pid: process.pid, start: 'cizi-proces', ts: new Date().toISOString() }))
      if (processStartTime(process.pid) === null) return
      const s2 = await runWorkflow({ workflow: '', cwd: p.cwd, runner: makeRunner().runner, resumeRunId: s1.runId }, scriptDeps(async (api) => api.agent('z')))
      assert.equal(s2.status, 'completed', s2.error)
    } finally {
      p.cleanup()
    }
  })
})
