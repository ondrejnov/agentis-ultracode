import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { runWorkflow } from '../../src/engine/engine.ts'
import { listRuns, readEvents, readRunSummary } from '../../src/engine/store.ts'
import { ScriptValidationError, WorkflowNotFoundError } from '../../src/errors.ts'
import type { RunEvent } from '../../src/types.ts'
import { eventsOf, journalOf, makeProject, makeRunner, readJsonFile, scriptDeps, sleep, waitFor } from './helpers.ts'

describe('selhání agentů', () => {
  test('selhání agenta → null, failedAgents, důvod v eventu, nezapíše se do journalu; resume ho spustí znovu', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      const stub = makeRunner({ fail: (r) => (r.prompt.includes('bad') ? 'claude exit 1' : undefined), outputTokens: 5 })
      const body = scriptDeps(async (api) => [await api.agent('good one'), await api.agent('bad one'), await api.agent('good two')])
      const s1 = await runWorkflow({ workflow: file, cwd: p.cwd, runner: stub.runner }, body)
      assert.equal(s1.status, 'completed')
      assert.deepEqual(s1.result, ['out:good one', null, 'out:good two'])
      assert.equal(s1.totals.agents, 3)
      assert.equal(s1.totals.failedAgents, 1)
      const dones = eventsOf(s1).filter((e) => e.t === 'agent_done')
      const failed = dones.find((e) => e.t === 'agent_done' && !e.ok)
      assert.ok(failed && failed.t === 'agent_done')
      assert.match(failed.error ?? '', /exit: claude exit 1/)
      assert.equal(journalOf(s1).length, 2)

      const stub2 = makeRunner()
      const s2 = await runWorkflow({ workflow: file, cwd: p.cwd, runner: stub2.runner, resumeRunId: s1.runId }, body)
      assert.deepEqual(stub2.prompts(), ['bad one'])
      assert.deepEqual(s2.result, ['out:good one', 'out:bad one', 'out:good two'])
      assert.equal(s2.totals.failedAgents, 0)
    } finally {
      p.cleanup()
    }
  })

  test('výjimka z runneru se promění v null (běh nespadne)', async () => {
    const p = makeProject()
    try {
      const stub = makeRunner({ throws: (r) => r.prompt === 'kaboom' })
      const summary = await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: stub.runner },
        scriptDeps(async (api) => [await api.agent('kaboom'), await api.agent('fine')]),
      )
      assert.equal(summary.status, 'completed')
      assert.deepEqual(summary.result, [null, 'out:fine'])
      assert.equal(summary.totals.failedAgents, 1)
      const failed = eventsOf(summary).find((e) => e.t === 'agent_done' && !e.ok)
      assert.ok(failed && failed.t === 'agent_done')
      assert.match(failed.error ?? '', /runner exploded/)
    } finally {
      p.cleanup()
    }
  })

  test('se schema bez structured_output je to selhání (null), ne prázdný objekt', async () => {
    const p = makeProject()
    try {
      const stub = makeRunner({ respond: () => null })
      const summary = await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: stub.runner },
        scriptDeps(async (api) => api.agent('s', { schema: { type: 'object', properties: { a: { type: 'string' } } } })),
      )
      assert.equal(summary.result, null)
      assert.equal(summary.totals.failedAgents, 1)
      assert.equal(journalOf(summary).length, 0)
    } finally {
      p.cleanup()
    }
  })

  test('agent_retry a agent_tool z onProgress se zapíšou jako události', async () => {
    const p = makeProject()
    try {
      const runner = async (req: any) => {
        req.onProgress?.({ kind: 'start', attempt: 1 })
        req.onProgress?.({ kind: 'tool', name: 'Grep' })
        req.onProgress?.({ kind: 'retry', attempt: 2, reason: 'stall 600s' })
        req.onProgress?.({ kind: 'tool', name: 'Edit' })
        return {
          ok: true,
          text: 'hotovo',
          structured: undefined,
          usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
          costUsd: 0.5,
          numTurns: 2,
          toolCalls: 2,
          durationMs: 12,
          attempts: 2,
        }
      }
      const summary = await runWorkflow({ workflow: p.script(), cwd: p.cwd, runner }, scriptDeps(async (api) => api.agent('t')))
      const ev = eventsOf(summary)
      const kinds = ev.filter((e) => e.t.startsWith('agent_')).map((e) => e.t)
      assert.deepEqual(kinds, ['agent_start', 'agent_tool', 'agent_retry', 'agent_tool', 'agent_done'])
      const retry = ev.find((e) => e.t === 'agent_retry')
      assert.ok(retry && retry.t === 'agent_retry')
      assert.equal(retry.attempt, 2)
      assert.equal(retry.reason, 'stall 600s')
      const done = ev.find((e) => e.t === 'agent_done')
      assert.ok(done && done.t === 'agent_done')
      assert.equal(done.durationMs, 12)
      assert.equal(done.toolCalls, 2)
      assert.equal(summary.totals.toolCalls, 2)
    } finally {
      p.cleanup()
    }
  })
})

describe('chyby skriptu a použití', () => {
  test('chyba skriptu → status failed s error včetně stack řádku; nehází', async () => {
    const p = makeProject()
    try {
      const stub = makeRunner()
      const summary = await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: stub.runner },
        scriptDeps(async (api) => {
          await api.agent('před chybou')
          throw new TypeError('boom ve skriptu')
        }),
      )
      assert.equal(summary.status, 'failed')
      assert.match(summary.error ?? '', /TypeError: boom ve skriptu/)
      assert.match(summary.error ?? '', /\n\s+at /)
      assert.equal(summary.result, undefined)
      assert.equal(existsSync(join(summary.runDir, 'result.json')), false)
      const onDisk = readRunSummary(p.cwd, summary.runId)
      assert.equal(onDisk?.status, 'failed')
      assert.equal(onDisk?.error, summary.error)
      assert.equal(onDisk?.totals.agents, 1)
      const events = eventsOf(summary)
      const end = events[events.length - 1]
      assert.ok(end.t === 'run_end' && end.status === 'failed' && /boom/.test(end.error ?? ''))
    } finally {
      p.cleanup()
    }
  })

  test('chyba serializovaná přes worker (prostý objekt se stackem) se zobrazí čitelně', async () => {
    const p = makeProject()
    try {
      const summary = await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: makeRunner().runner },
        {
          parseScript: scriptDeps(async () => 0).parseScript,
          runScript: async () => {
            throw { name: 'ReferenceError', message: 'x is not defined', stack: 'ReferenceError: x is not defined\n    at wf.ts:3:1' }
          },
        },
      )
      assert.equal(summary.status, 'failed')
      assert.match(summary.error ?? '', /ReferenceError: x is not defined\n\s+at wf\.ts:3:1/)
    } finally {
      p.cleanup()
    }
  })

  test('neplatný skript → ScriptValidationError s diagnostikou a bez založeného běhu', async () => {
    const p = makeProject()
    try {
      const file = p.script('bad.workflow.ts', '// INVALID\n')
      await assert.rejects(
        runWorkflow({ workflow: file, cwd: p.cwd, runner: makeRunner().runner }, scriptDeps(async () => null)),
        (e: unknown) => {
          assert.ok(e instanceof ScriptValidationError)
          assert.deepEqual(e.diagnostics, ['řádek 1: chybí export const meta'])
          assert.match(e.message, /bad\.workflow\.ts/)
          return true
        },
      )
      assert.deepEqual(listRuns(p.cwd), [])
      assert.equal(existsSync(join(p.cwd, '.ultracode', 'runs')), false)
    } finally {
      p.cleanup()
    }
  })

  test('neexistující workflow → WorkflowNotFoundError; prázdné workflow bez resume → chyba použití', async () => {
    const p = makeProject()
    try {
      await assert.rejects(runWorkflow({ workflow: 'neexistuje', cwd: p.cwd, runner: makeRunner().runner }, scriptDeps(async () => null)), WorkflowNotFoundError)
      await assert.rejects(runWorkflow({ workflow: './nope.ts', cwd: p.cwd, runner: makeRunner().runner }, scriptDeps(async () => null)), WorkflowNotFoundError)
      await assert.rejects(
        runWorkflow({ workflow: '', cwd: p.cwd, runner: makeRunner().runner }, scriptDeps(async () => null)),
        (e: any) => e.code === 'USAGE',
      )
    } finally {
      p.cleanup()
    }
  })

  test('agent() s neprázdným promptem je povinný a isolation je odmítnuto jasnou chybou', async () => {
    const p = makeProject()
    try {
      const stub = makeRunner()
      const summary = await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: stub.runner },
        scriptDeps(async (api) => {
          const errs: string[] = []
          for (const call of [() => api.agent('   '), () => api.agent('x', { isolation: 'worktree' } as any)]) {
            try {
              await call()
            } catch (e) {
              errs.push((e as { code: string }).code)
            }
          }
          return errs
        }),
      )
      assert.deepEqual(summary.result, ['INVALID_PROMPT', 'UNSUPPORTED_OPTION'])
      assert.equal(stub.calls.length, 0)
    } finally {
      p.cleanup()
    }
  })

  test('chyba v onEvent callbacku běh neovlivní', async () => {
    const p = makeProject()
    try {
      const summary = await runWorkflow(
        {
          workflow: p.script(),
          cwd: p.cwd,
          runner: makeRunner().runner,
          onEvent: () => {
            throw new Error('callback selhal')
          },
        },
        scriptDeps(async (api) => api.agent('x')),
      )
      assert.equal(summary.status, 'completed')
      assert.equal(readEvents(p.cwd, summary.runId).length > 3, true)
    } finally {
      p.cleanup()
    }
  })

  test('varování z parseru se objeví jako log události', async () => {
    const p = makeProject()
    try {
      const deps = scriptDeps(async () => null)
      deps.parseScript = () => ({ ok: true, meta: { name: 'w', description: 'd' }, diagnostics: [{ level: 'warning', message: 'phase X není v meta', line: 7 }] })
      const summary = await runWorkflow({ workflow: p.script(), cwd: p.cwd, runner: makeRunner().runner }, deps)
      const logs = eventsOf(summary).filter((e) => e.t === 'log')
      assert.equal(logs.length, 1)
      assert.ok(logs[0].t === 'log' && /řádek 7.*phase X/.test(logs[0].message))
    } finally {
      p.cleanup()
    }
  })
})

describe('abort', () => {
  test('abort za běhu: status aborted, procesy uklizeny, journal zachován a běh jde obnovit', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      const ac = new AbortController()
      const stub = makeRunner({ delayMs: (r) => (r.prompt.startsWith('slow') ? 10_000 : 0) })
      const seen: RunEvent[] = []
      const body = scriptDeps(async (api) => {
        const first = await api.agent('fast')
        const rest = await api.parallel([() => api.agent('slow 1'), () => api.agent('slow 2')])
        return { first, rest }
      })
      const t0 = Date.now()
      const promise = runWorkflow(
        { workflow: file, cwd: p.cwd, runner: stub.runner, signal: ac.signal, onEvent: (e) => seen.push(e) },
        body,
      )
      await waitFor(() => seen.filter((e) => e.t === 'agent_start' && e.promptPreview.startsWith('slow')).length === 2)
      ac.abort()
      const s1 = await promise
      assert.ok(Date.now() - t0 < 3000, 'abort musí běh ukončit rychle')
      assert.equal(s1.status, 'aborted')
      assert.equal(stub.inFlight, 0)
      assert.ok(stub.calls[1].signal?.aborted && stub.calls[2].signal?.aborted, 'signal se musí předat runneru')
      // run.json je konzistentní a čitelný
      const onDisk = readJsonFile(join(s1.runDir, 'run.json'))
      assert.equal(onDisk.status, 'aborted')
      assert.ok(onDisk.endedAt)
      assert.equal(onDisk.totals.agents, 3)
      assert.equal(onDisk.totals.failedAgents, 2)
      const events = eventsOf(s1)
      const end = events[events.length - 1]
      assert.ok(end.t === 'run_end' && end.status === 'aborted')
      // journal: jen dokončený agent
      assert.deepEqual(journalOf(s1).map((e) => e.label), ['fast'])

      // resume doběhne bez opakování 'fast'
      const stub2 = makeRunner()
      const s2 = await runWorkflow({ workflow: file, cwd: p.cwd, runner: stub2.runner, resumeRunId: s1.runId }, body)
      assert.equal(s2.status, 'completed')
      assert.deepEqual(stub2.prompts(), ['slow 1', 'slow 2'])
      assert.equal(s2.totals.cachedAgents, 1)
    } finally {
      p.cleanup()
    }
  })

  test('abort ve frontě za semaforem: čekající agenti se nespustí a vrací null', async () => {
    const p = makeProject()
    try {
      const ac = new AbortController()
      const stub = makeRunner({ delayMs: 10_000 })
      const promise = runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: stub.runner, signal: ac.signal, concurrency: 1 },
        scriptDeps(async (api) => api.parallel(Array.from({ length: 5 }, (_, i) => () => api.agent(`w${i}`)))),
      )
      await waitFor(() => stub.calls.length === 1)
      ac.abort()
      const s = await promise
      assert.equal(s.status, 'aborted')
      assert.equal(stub.calls.length, 1)
      assert.equal(s.totals.agents, 1)
    } finally {
      p.cleanup()
    }
  })

  test('skript, který abort ignoruje a visí, se po grace době uzavře jako aborted', async () => {
    const p = makeProject()
    try {
      const ac = new AbortController()
      const t0 = Date.now()
      const promise = runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: makeRunner().runner, signal: ac.signal },
        {
          parseScript: scriptDeps(async () => 0).parseScript,
          runScript: () => new Promise(() => {}),
          abortGraceMs: 80,
        },
      )
      await sleep(20)
      ac.abort()
      const s = await promise
      assert.equal(s.status, 'aborted')
      assert.ok(Date.now() - t0 < 2000)
      assert.equal(readRunSummary(p.cwd, s.runId)?.status, 'aborted')
    } finally {
      p.cleanup()
    }
  })

  test('opožděný výsledek agenta po uzavření běhu nic nepřidá za run_end ani do journalu', async () => {
    const p = makeProject()
    try {
      const ac = new AbortController()
      let calls = 0
      // runner ignoruje signal a skončí až po 250 ms (už po uzavření běhu)
      const stuckRunner = async () => {
        calls++
        await sleep(250)
        return {
          ok: true,
          text: 'pozdě',
          structured: undefined,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
          costUsd: 0.1,
          numTurns: 1,
          toolCalls: 0,
          durationMs: 250,
          attempts: 1,
        }
      }
      const deps = scriptDeps(async (api) => {
        await api.agent('visí')
        return 'nikdy'
      })
      const promise = runWorkflow({ workflow: p.script(), cwd: p.cwd, runner: stuckRunner, signal: ac.signal }, { ...deps, abortGraceMs: 40 })
      await waitFor(() => calls === 1)
      ac.abort()
      const s = await promise
      assert.equal(s.status, 'aborted')
      const before = eventsOf(s).length
      await sleep(400)
      const events = eventsOf(s)
      assert.equal(events.length, before)
      assert.equal(events[events.length - 1].t, 'run_end')
      assert.equal(journalOf(s).length, 0)
      assert.equal(readRunSummary(p.cwd, s.runId)?.totals.costUsd, 0)
    } finally {
      p.cleanup()
    }
  })

  test('signál přerušený před startem: skript ani runner se nespustí, běh je aborted a resumovatelný', async () => {
    const p = makeProject()
    try {
      const stub = makeRunner()
      let scriptRan = false
      const deps = scriptDeps(async (api) => {
        scriptRan = true
        return api.agent('x')
      })
      const s = await runWorkflow({ workflow: p.script(), cwd: p.cwd, runner: stub.runner, signal: AbortSignal.abort() }, deps)
      assert.equal(s.status, 'aborted')
      assert.equal(scriptRan, false)
      assert.equal(stub.calls.length, 0)
      const s2 = await runWorkflow({ workflow: '', cwd: p.cwd, runner: stub.runner, resumeRunId: s.runId }, deps)
      assert.equal(s2.status, 'completed')
      assert.equal(s2.runId, s.runId)
    } finally {
      p.cleanup()
    }
  })

  test('nedoawaitovaný agent po skončení skriptu je zrušen (žádní sirotci) a běh se nezasekne', async () => {
    const p = makeProject()
    try {
      const stub = makeRunner({ delayMs: 10_000 })
      const t0 = Date.now()
      const s = await runWorkflow(
        { workflow: p.script(), cwd: p.cwd, runner: stub.runner },
        scriptDeps(async (api) => {
          void api.agent('fire and forget')
          await sleep(20)
          return 'hotovo'
        }),
      )
      assert.ok(Date.now() - t0 < 3000)
      assert.equal(s.status, 'completed')
      assert.equal(stub.inFlight, 0)
      assert.ok(stub.calls[0].signal?.aborted)
      assert.equal(s.totals.failedAgents, 1)
    } finally {
      p.cleanup()
    }
  })
})
