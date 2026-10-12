import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { runWorkflow } from '../../src/engine/engine.ts'
import { readEvents, readRunSummary } from '../../src/engine/store.ts'
import type { RunEvent } from '../../src/types.ts'
import { eventsOf, journalOf, makeProject, makeRunner, readJsonFile, scriptDeps, waitFor } from './helpers.ts'

describe('runWorkflow: základní běh', () => {
  test('založí adresář běhu se všemi soubory a vrátí konzistentní summary', async () => {
    const p = makeProject()
    try {
      const file = p.script('wf.workflow.ts', '// name: demo\n// phases: Scan,Fix\n')
      const stub = makeRunner()
      const seen: RunEvent[] = []
      const summary = await runWorkflow(
        { workflow: file, cwd: p.cwd, args: { topic: 'x' }, runner: stub.runner, onEvent: (e) => seen.push(e) },
        scriptDeps(async (api) => {
          api.phase('Scan')
          const a = await api.agent('first prompt', { label: 'first' })
          api.log('mezivýsledek')
          const b = await api.agent('second', { schema: { type: 'object', properties: { value: { type: 'string' } } } })
          return { a, b, args: api.args }
        }),
      )

      assert.match(summary.runId, /^wf_[0-9a-f]{8}-[0-9a-f]{3}$/)
      assert.equal(summary.status, 'completed')
      assert.equal(summary.name, 'demo')
      assert.equal(summary.runDir, join(p.cwd, '.ultracode', 'runs', summary.runId))
      assert.deepEqual(summary.result, { a: 'out:first prompt', b: { value: 'second' }, args: { topic: 'x' } })
      assert.equal(summary.totals.agents, 2)
      assert.equal(summary.totals.cachedAgents, 0)
      assert.equal(summary.totals.failedAgents, 0)
      assert.equal(summary.totals.toolCalls, 2)
      assert.equal(summary.totals.usage.outputTokens, 20)
      assert.ok(Math.abs(summary.totals.costUsd - 0.002) < 1e-9)
      assert.equal(summary.budgetExceeded, undefined)
      assert.ok(summary.durationMs >= 0)
      assert.ok(Date.parse(summary.endedAt) >= Date.parse(summary.startedAt))

      for (const f of ['run.json', 'script.ts', 'args.json', 'events.jsonl', 'journal.jsonl', 'result.json']) {
        assert.ok(existsSync(join(summary.runDir, f)), `chybí ${f}`)
      }
      assert.deepEqual(readJsonFile(join(summary.runDir, 'args.json')), { topic: 'x' })
      assert.deepEqual(readJsonFile(join(summary.runDir, 'result.json')), summary.result)
      assert.deepEqual(readJsonFile(join(summary.runDir, 'run.json')), JSON.parse(JSON.stringify(summary)))
      assert.deepEqual(readRunSummary(p.cwd, summary.runId), summary)

      // runner dostal správný požadavek
      assert.equal(stub.calls.length, 2)
      assert.equal(stub.calls[0].cwd, p.cwd)
      assert.equal(stub.calls[0].outDir, join(summary.runDir, 'agents', '1'))
      assert.equal(stub.calls[1].outDir, join(summary.runDir, 'agents', '2'))
      assert.deepEqual(stub.calls[1].schema, { type: 'object', properties: { value: { type: 'string' } } })

      // onEvent dostane přesně to, co je v events.jsonl
      assert.deepEqual(seen, JSON.parse(JSON.stringify(eventsOf(summary))))
      assert.deepEqual(readEvents(p.cwd, summary.runId), seen)
    } finally {
      p.cleanup()
    }
  })

  test('events: logický sled, párování start/done, ISO ts a totals odpovídají součtu událostí', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      const stub = makeRunner({ delayMs: 10, outputTokens: (r) => r.prompt.length })
      const summary = await runWorkflow(
        { workflow: file, cwd: p.cwd, runner: stub.runner, concurrency: 2 },
        scriptDeps(async (api) => {
          api.phase('Prvni')
          await api.parallel([1, 2, 3].map((i) => () => api.agent(`worker ${i}`)))
          api.phase('Druha')
          await api.agent('final', { phase: 'Explicitni' })
          return 'ok'
        }),
      )
      const events = eventsOf(summary)
      assert.equal(events[0].t, 'run_start')
      assert.equal(events[events.length - 1].t, 'run_end')
      assert.equal(events.filter((e) => e.t === 'run_start').length, 1)
      assert.equal(events.filter((e) => e.t === 'run_end').length, 1)

      let prev = 0
      for (const e of events) {
        assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
        const t = Date.parse(e.ts)
        assert.ok(t >= prev, 'ts nesmí klesat')
        prev = t
      }

      const starts = events.filter((e) => e.t === 'agent_start')
      const dones = events.filter((e) => e.t === 'agent_done')
      assert.equal(starts.length, 4)
      assert.equal(dones.length, 4)
      assert.deepEqual(starts.map((s) => s.t === 'agent_start' && s.id), [1, 2, 3, 4])
      for (const s of starts) {
        if (s.t !== 'agent_start') continue
        const si = events.indexOf(s)
        const d = events.find((e) => e.t === 'agent_done' && e.id === s.id)
        assert.ok(d && events.indexOf(d) > si, `agent ${s.id}: done musí následovat po start`)
        const tools = events.filter((e) => e.t === 'agent_tool' && e.id === s.id)
        assert.equal(tools.length, 1)
        assert.ok(events.indexOf(tools[0]) > si && events.indexOf(tools[0]) < events.indexOf(d))
      }
      // fáze
      const phaseOf = (prompt: string) => {
        const s = starts.find((e) => e.t === 'agent_start' && e.promptPreview === prompt)
        return s && s.t === 'agent_start' ? s.phase : undefined
      }
      assert.equal(phaseOf('worker 1'), 'Prvni')
      assert.equal(phaseOf('worker 3'), 'Prvni')
      assert.equal(phaseOf('final'), 'Explicitni')
      assert.deepEqual(
        events.filter((e) => e.t === 'phase').map((e) => (e.t === 'phase' ? e.title : '')),
        ['Prvni', 'Druha'],
      )

      // totals = součet agent_done
      let out = 0
      let cost = 0
      let tools = 0
      for (const d of dones) {
        if (d.t !== 'agent_done') continue
        out += d.usage.outputTokens
        cost += d.costUsd
        tools += d.toolCalls
      }
      assert.equal(summary.totals.usage.outputTokens, out)
      assert.ok(Math.abs(summary.totals.costUsd - cost) < 1e-9)
      assert.equal(summary.totals.toolCalls, tools)
      const end = events[events.length - 1]
      assert.ok(end.t === 'run_end')
      assert.deepEqual(end.totals, summary.totals)
      assert.equal(end.status, 'completed')

      // budget události jsou monotónní
      const budgets = events.filter((e) => e.t === 'budget')
      assert.equal(budgets.length, 4)
      let last = -1
      for (const b of budgets) {
        if (b.t !== 'budget') continue
        assert.ok(b.spentOutputTokens >= last)
        last = b.spentOutputTokens
        assert.equal(b.limitOutputTokens, null)
        assert.equal(b.limitUsd, null)
      }
      assert.equal(last, out)
    } finally {
      p.cleanup()
    }
  })

  test('run.json se během běhu průběžně aktualizuje (status running + totals)', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      const stub = makeRunner()
      let midway: any
      await runWorkflow(
        { workflow: file, cwd: p.cwd, runner: stub.runner },
        scriptDeps(async (api) => {
          await api.agent('one')
          const runDir = join(p.cwd, '.ultracode', 'runs')
          await waitFor(() => {
            try {
              const dirs = readdirSync(runDir)
              const j = readJsonFile(join(runDir, dirs[0], 'run.json'))
              if (j.totals.agents >= 1) midway = j
              return j.totals.agents >= 1
            } catch {
              return false
            }
          })
          await api.agent('two')
          return null
        }),
      )
      assert.ok(midway)
      assert.equal(midway.status, 'running')
      assert.equal(midway.endedAt, '')
      assert.equal(midway.totals.agents, 1)
    } finally {
      p.cleanup()
    }
  })

  test('jméno workflow se najde přes discovery (.ultracode/workflows)', async () => {
    const p = makeProject()
    try {
      p.script('.ultracode/workflows/find-flaky.workflow.ts', '// name: find-flaky\n')
      const stub = makeRunner()
      const summary = await runWorkflow({ workflow: 'find-flaky', cwd: p.cwd, runner: stub.runner }, scriptDeps(async () => 42))
      assert.equal(summary.status, 'completed')
      assert.equal(summary.name, 'find-flaky')
      assert.equal(summary.result, 42)
      assert.match(summary.scriptPath, /find-flaky\.workflow\.ts$/)
    } finally {
      p.cleanup()
    }
  })

  test('výchozí model/effort z RunOptions, volba agenta má přednost; cwd agenta se resolvuje', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      const stub = makeRunner()
      await runWorkflow(
        { workflow: file, cwd: p.cwd, runner: stub.runner, model: 'sonnet', effort: 'low', permissionMode: 'acceptEdits' },
        scriptDeps(async (api) => {
          await api.agent('a')
          await api.agent('b', { model: 'opus', effort: 'high', cwd: 'sub/dir', tools: ['Read'], disallowedTools: ['Bash'], systemPrompt: 'SP', stallMs: 5, timeoutMs: 9, maxUsd: 1.5 })
          return null
        }),
      )
      assert.equal(stub.calls[0].model, 'sonnet')
      assert.equal(stub.calls[0].effort, 'low')
      assert.equal(stub.calls[0].permissionMode, 'acceptEdits')
      assert.equal(stub.calls[1].model, 'opus')
      assert.equal(stub.calls[1].effort, 'high')
      assert.equal(stub.calls[1].cwd, join(p.cwd, 'sub', 'dir'))
      assert.deepEqual(stub.calls[1].allowedTools, ['Read'])
      assert.deepEqual(stub.calls[1].disallowedTools, ['Bash'])
      assert.equal(stub.calls[1].appendSystemPrompt, 'SP')
      assert.equal(stub.calls[1].stallMs, 5)
      assert.equal(stub.calls[1].timeoutMs, 9)
      assert.equal(stub.calls[1].maxBudgetUsd, 1.5)
    } finally {
      p.cleanup()
    }
  })

  test('tools = skutečný whitelist: agent běží v dontAsk, ledaže volající zvolil režim; bez tools se režim nenastavuje', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      const stub = makeRunner()
      await runWorkflow(
        { workflow: file, cwd: p.cwd, runner: stub.runner },
        scriptDeps(async (api) => {
          await api.agent('bez nástrojů')
          await api.agent('s nástroji', { tools: ['Read', 'Grep'] })
          await api.agent('prázdný seznam', { tools: [] })
          return null
        }),
      )
      assert.equal(stub.calls[0].permissionMode, undefined)
      assert.equal(stub.calls[1].permissionMode, 'dontAsk')
      assert.deepEqual(stub.calls[1].allowedTools, ['Read', 'Grep'])
      // prázdný whitelist je explicitní zákaz všeho → také dontAsk (jinak by agent dostal všechny nástroje)
      assert.equal(stub.calls[2].permissionMode, 'dontAsk')

      const explicit = makeRunner()
      await runWorkflow(
        { workflow: file, cwd: p.cwd, runner: explicit.runner, permissionMode: 'acceptEdits', claudeBin: '/opt/claude-x' },
        scriptDeps(async (api) => {
          await api.agent('s nástroji', { tools: ['Read'] })
          return null
        }),
      )
      assert.equal(explicit.calls[0].permissionMode, 'acceptEdits')
      assert.equal(explicit.calls[0].bin, '/opt/claude-x')
    } finally {
      p.cleanup()
    }
  })

  test('vnořené workflow: loadWorkflow + workflow_enter/exit a fáze potomka nepřebíjí rodiče', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      const child = p.script('child.workflow.ts', '// name: child\n')
      const stub = makeRunner()
      const summary = await runWorkflow(
        { workflow: file, cwd: p.cwd, runner: stub.runner },
        scriptDeps(async (api) => {
          api.phase('Parent')
          const loaded = await api.hooks.loadWorkflow({ scriptPath: child }, { workflowPath: api.path })
          assert.equal(loaded.filename, child)
          assert.match(loaded.source, /name: child/)
          const byName = await api.hooks.loadWorkflow('child', { workflowPath: api.path }).catch((e) => e)
          assert.equal(byName.code, 'WORKFLOW_NOT_FOUND')
          const childPath = [...api.path, 'child']
          api.hooks.workflowEnter('child', { workflowPath: childPath })
          api.hooks.phase('ChildPhase', { workflowPath: childPath })
          await api.hooks.agent('child agent', {}, { workflowPath: childPath })
          api.hooks.workflowExit('child', { workflowPath: childPath })
          await api.agent('parent agent')
          return null
        }),
      )
      const events = eventsOf(summary)
      const types = events.map((e) => e.t)
      assert.ok(types.indexOf('workflow_enter') < types.indexOf('workflow_exit'))
      const phases = new Map(
        events.filter((e) => e.t === 'agent_start').map((e) => [e.t === 'agent_start' ? e.promptPreview : '', e.t === 'agent_start' ? e.phase : null]),
      )
      assert.equal(phases.get('child agent'), 'ChildPhase')
      assert.equal(phases.get('parent agent'), 'Parent')
      const childStart = events.find((e) => e.t === 'agent_start' && e.promptPreview === 'child agent')
      assert.ok(childStart && childStart.t === 'agent_start')
      assert.deepEqual(childStart.workflowPath, ['wf', 'child'])
    } finally {
      p.cleanup()
    }
  })
})

describe('runWorkflow: cache a resume', () => {
  test('resume zdědí model/effort z původního běhu (jsou v klíči cache); explicitní volba je přepíše', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      const body = scriptDeps(async (api) => {
        const a = await api.agent('alpha')
        return { a }
      })
      const s1 = await runWorkflow({ workflow: file, cwd: p.cwd, runner: makeRunner().runner, model: 'haiku', effort: 'low', maxUsd: 5 }, body)
      assert.equal(s1.status, 'completed')

      // bez --model/--effort: cache hit, runner se nevolá
      const stub2 = makeRunner()
      const s2 = await runWorkflow({ workflow: '', cwd: p.cwd, runner: stub2.runner, resumeRunId: s1.runId }, body)
      assert.equal(stub2.calls.length, 0)
      assert.equal(s2.totals.cachedAgents, 1)

      // explicitní jiný model: jiný klíč → agent poběží znovu, s novým modelem
      const stub3 = makeRunner()
      const s3 = await runWorkflow({ workflow: '', cwd: p.cwd, runner: stub3.runner, resumeRunId: s1.runId, model: 'sonnet' }, body)
      assert.equal(stub3.calls.length, 1)
      assert.equal(stub3.calls[0].model, 'sonnet')
      assert.equal(stub3.calls[0].effort, 'low')
      assert.equal(s3.totals.cachedAgents, 0)

      // a nová hodnota se uloží pro další resume
      const stub4 = makeRunner()
      await runWorkflow({ workflow: '', cwd: p.cwd, runner: stub4.runner, resumeRunId: s1.runId }, body)
      assert.equal(stub4.calls.length, 0)
    } finally {
      p.cleanup()
    }
  })

  test('resume po dokončeném běhu: 100 % cache hit, žádný runner, nulová spotřeba', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      const body = scriptDeps(async (api) => {
        const a = await api.agent('alpha')
        const b = await api.agent(`beta uses ${a}`, { schema: { type: 'object', properties: { value: { type: 'string' } } } })
        return { a, b }
      })
      const s1 = await runWorkflow({ workflow: file, cwd: p.cwd, runner: makeRunner().runner }, body)
      assert.equal(s1.status, 'completed')

      const stub2 = makeRunner()
      const s2 = await runWorkflow({ workflow: file, cwd: p.cwd, runner: stub2.runner, resumeRunId: s1.runId }, body)
      assert.equal(stub2.calls.length, 0)
      assert.equal(s2.runId, s1.runId)
      assert.equal(s2.runDir, s1.runDir)
      assert.equal(s2.status, 'completed')
      assert.deepEqual(s2.result, s1.result)
      assert.equal(s2.totals.agents, 2)
      assert.equal(s2.totals.cachedAgents, 2)
      // přehrané výsledky z cache se počítají do totals (run má kompletní součty), nová útrata je nulová
      assert.equal(s2.totals.costUsd, s1.totals.costUsd)
      assert.equal(s2.totals.usage.outputTokens, s1.totals.usage.outputTokens)
      assert.equal(stub2.calls.length, 0)

      const events = readEvents(p.cwd, s1.runId)
      const starts = events.filter((e) => e.t === 'run_start')
      assert.equal(starts.length, 2)
      assert.ok(starts[0].t === 'run_start' && starts[0].resumed === false)
      assert.ok(starts[1].t === 'run_start' && starts[1].resumed === true)
      const cachedDones = events.filter((e) => e.t === 'agent_done' && e.cached)
      assert.equal(cachedDones.length, 2)
      // cache hit nezapisuje do journalu znovu
      assert.equal(journalOf(s1).length, 2)
      // run.json odpovídá poslednímu běhu
      assert.equal(readRunSummary(p.cwd, s1.runId)?.status, 'completed')
    } finally {
      p.cleanup()
    }
  })

  test('resume po zabitém běhu (abort uprostřed): hotové agenty vrátí z cache, zbytek doběhne', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      const ac = new AbortController()
      const stub1 = makeRunner()
      const s1 = await runWorkflow(
        { workflow: file, cwd: p.cwd, runner: stub1.runner, signal: ac.signal },
        scriptDeps(async (api) => {
          await api.agent('step 1')
          await api.agent('step 2')
          ac.abort()
          await api.agent('step 3')
          return 'dokončeno'
        }),
      )
      assert.equal(s1.status, 'aborted')
      assert.equal(stub1.calls.length, 2)
      assert.equal(journalOf(s1).length, 2)
      assert.equal(readRunSummary(p.cwd, s1.runId)?.status, 'aborted')

      const stub2 = makeRunner()
      const s2 = await runWorkflow(
        { workflow: '', cwd: p.cwd, runner: stub2.runner, resumeRunId: s1.runId },
        scriptDeps(async (api) => {
          const r = []
          for (const n of [1, 2, 3]) r.push(await api.agent(`step ${n}`))
          return r
        }),
      )
      assert.equal(s2.status, 'completed')
      assert.deepEqual(stub2.prompts(), ['step 3'])
      assert.deepEqual(s2.result, ['out:step 1', 'out:step 2', 'out:step 3'])
      assert.equal(s2.totals.cachedAgents, 2)
      assert.equal(s2.totals.agents, 3)
      // nový agent dostal id navazující na předchozí a nepřepsal adresáře agents/1,2
      // cache hity také spotřebují id (1,2 z původního běhu, 3,4 cached), nový agent má 5
      assert.equal(stub2.calls[0].outDir, join(s1.runDir, 'agents', '5'))
    } finally {
      p.cleanup()
    }
  })

  test('resume bez workflow použije uloženou kopii skriptu a args.json', async () => {
    const p = makeProject()
    try {
      const file = p.script('orig.workflow.ts', '// name: stored\n')
      const body = scriptDeps(async (api) => ({ got: api.args, a: await api.agent(`topic ${api.args.t}`) }))
      const s1 = await runWorkflow({ workflow: file, cwd: p.cwd, args: { t: 'kočky' }, runner: makeRunner().runner }, body)
      const stub2 = makeRunner()
      let seenSource = ''
      const s2 = await runWorkflow(
        { workflow: '', cwd: p.cwd, resumeRunId: s1.runId, runner: stub2.runner },
        scriptDeps(async (api, req) => {
          seenSource = req.source
          return { got: api.args, a: await api.agent(`topic ${api.args.t}`) }
        }),
      )
      assert.match(seenSource, /name: stored/)
      assert.deepEqual(s2.result, s1.result)
      assert.equal(stub2.calls.length, 0)
      assert.equal(s2.name, 'stored')
      assert.match(s2.scriptPath, /script\.ts$/)
    } finally {
      p.cleanup()
    }
  })

  test('duplicitní stejné prompty: n-té volání dostane n-tý uložený výsledek', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      let counter = 0
      const stub1 = makeRunner({ respond: () => `r${++counter}` })
      const s1 = await runWorkflow(
        { workflow: file, cwd: p.cwd, runner: stub1.runner },
        scriptDeps(async (api) => [await api.agent('same'), await api.agent('same'), await api.agent('same')]),
      )
      assert.deepEqual(s1.result, ['r1', 'r2', 'r3'])
      const j = journalOf(s1)
      assert.deepEqual(j.map((e) => e.seq), [0, 1, 2])
      assert.equal(new Set(j.map((e) => e.key)).size, 1)

      const stub2 = makeRunner({ respond: () => 'nové' })
      const s2 = await runWorkflow(
        { workflow: file, cwd: p.cwd, runner: stub2.runner, resumeRunId: s1.runId },
        scriptDeps(async (api) => [await api.agent('same'), await api.agent('same'), await api.agent('same'), await api.agent('same')]),
      )
      assert.deepEqual(s2.result, ['r1', 'r2', 'r3', 'nové'])
      assert.equal(stub2.calls.length, 1)
      assert.equal(s2.totals.cachedAgents, 3)
    } finally {
      p.cleanup()
    }
  })

  test('duplicitní prompty v parallel(): výsledky se přiřadí podle pořadí volání, ne podle doběhnutí', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      let counter = 0
      // pozdější volání skončí dřív
      const stub1 = makeRunner({ respond: () => `r${++counter}`, delayMs: (r) => (counter === 0 && r.prompt === 'dup' ? 5 : 1) })
      const body = scriptDeps(async (api) => api.parallel([0, 1, 2].map(() => () => api.agent('dup'))))
      const s1 = await runWorkflow({ workflow: file, cwd: p.cwd, runner: stub1.runner }, body)
      assert.equal(s1.status, 'completed')
      const first = s1.result as string[]
      const stub2 = makeRunner()
      const s2 = await runWorkflow({ workflow: file, cwd: p.cwd, runner: stub2.runner, resumeRunId: s1.runId }, body)
      assert.deepEqual(s2.result, first)
      assert.equal(stub2.calls.length, 0)
    } finally {
      p.cleanup()
    }
  })

  test('noCache přeskočí cache pro konkrétní volání', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      const s1 = await runWorkflow({ workflow: file, cwd: p.cwd, runner: makeRunner().runner }, scriptDeps(async (api) => [await api.agent('x'), await api.agent('y')]))
      const stub2 = makeRunner({ respond: () => 'čerstvé' })
      const s2 = await runWorkflow(
        { workflow: file, cwd: p.cwd, runner: stub2.runner, resumeRunId: s1.runId },
        scriptDeps(async (api) => [await api.agent('x', { noCache: true }), await api.agent('y')]),
      )
      assert.deepEqual(stub2.prompts(), ['x'])
      assert.deepEqual(s2.result, ['čerstvé', 'out:y'])
      assert.equal(s2.totals.cachedAgents, 1)
      // nový výsledek se zapsal; další resume už vrací jeho
      const stub3 = makeRunner()
      const s3 = await runWorkflow(
        { workflow: file, cwd: p.cwd, runner: stub3.runner, resumeRunId: s1.runId },
        scriptDeps(async (api) => [await api.agent('x'), await api.agent('y')]),
      )
      assert.deepEqual(s3.result, ['čerstvé', 'out:y'])
      assert.equal(stub3.calls.length, 0)
    } finally {
      p.cleanup()
    }
  })

  test('změna upstream vstupu změní prompty downstream agentů → ti běží znovu, nezávislý agent zůstane v cache', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      const body = scriptDeps(async (api) => {
        const research = await api.agent(`research ${api.args.topic}`)
        const article = await api.agent(`write using: ${research}`)
        const fixed = await api.agent('nezávislý krok')
        return { research, article, fixed }
      })
      const s1 = await runWorkflow({ workflow: file, cwd: p.cwd, args: { topic: 'A' }, runner: makeRunner().runner }, body)
      assert.equal(s1.totals.agents, 3)

      const stub2 = makeRunner()
      const s2 = await runWorkflow({ workflow: file, cwd: p.cwd, args: { topic: 'B' }, resumeRunId: s1.runId, runner: stub2.runner }, body)
      assert.deepEqual(stub2.prompts(), ['research B', 'write using: out:research B'])
      assert.equal(s2.totals.cachedAgents, 1)
      assert.equal((s2.result as any).fixed, 'out:nezávislý krok')

      // beze změny args se použijí uložené args z původního běhu
      const stub3 = makeRunner()
      const s3 = await runWorkflow({ workflow: file, cwd: p.cwd, resumeRunId: s1.runId, runner: stub3.runner }, body)
      // args.json se po resume s novými args přepsal → poslední resume je celý z cache
      assert.equal(stub3.calls.length, 0)
      assert.deepEqual(s3.result, s2.result)
    } finally {
      p.cleanup()
    }
  })

  test('změna volby (model/schema/cwd/tools/systemPrompt) je cache miss', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      const s1 = await runWorkflow({ workflow: file, cwd: p.cwd, runner: makeRunner().runner }, scriptDeps(async (api) => api.agent('p', { model: 'haiku' })))
      const variants: Array<Record<string, unknown>> = [
        { model: 'sonnet' },
        { model: 'haiku', effort: 'high' },
        { model: 'haiku', tools: ['Read'] },
        { model: 'haiku', systemPrompt: 'jinak' },
        { model: 'haiku', cwd: 'jinde' },
        { model: 'haiku', disallowedTools: ['Bash'] },
        { model: 'haiku', schema: { type: 'object', properties: { value: { type: 'string' } } } },
      ]
      for (const v of variants) {
        const stub = makeRunner()
        await runWorkflow({ workflow: file, cwd: p.cwd, runner: stub.runner, resumeRunId: s1.runId }, scriptDeps(async (api) => api.agent('p', v as any)))
        assert.equal(stub.calls.length, 1, `varianta ${JSON.stringify(v)} měla běžet znovu`)
      }
      // shodná volba (jiné pořadí klíčů) → hit
      const stub = makeRunner()
      await runWorkflow({ workflow: file, cwd: p.cwd, runner: stub.runner, resumeRunId: s1.runId }, scriptDeps(async (api) => api.agent('p', { model: 'haiku' })))
      assert.equal(stub.calls.length, 0)
    } finally {
      p.cleanup()
    }
  })

  test('výchozí model z RunOptions je součástí klíče (změna --model = cache miss)', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      const body = scriptDeps(async (api) => api.agent('p'))
      const s1 = await runWorkflow({ workflow: file, cwd: p.cwd, runner: makeRunner().runner, model: 'haiku' }, body)
      const same = makeRunner()
      await runWorkflow({ workflow: file, cwd: p.cwd, runner: same.runner, model: 'haiku', resumeRunId: s1.runId }, body)
      assert.equal(same.calls.length, 0)
      const other = makeRunner()
      await runWorkflow({ workflow: file, cwd: p.cwd, runner: other.runner, model: 'opus', resumeRunId: s1.runId }, body)
      assert.equal(other.calls.length, 1)
    } finally {
      p.cleanup()
    }
  })

  test('poškozený/useknutý poslední řádek journalu (zabitý proces) resume nerozbije', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      const body = scriptDeps(async (api) => [await api.agent('a'), await api.agent('b')])
      const s1 = await runWorkflow({ workflow: file, cwd: p.cwd, runner: makeRunner().runner }, body)
      const jp = join(s1.runDir, 'journal.jsonl')
      const lines = readFileSync(jp, 'utf8').trim().split('\n')
      writeFileSync(jp, lines[0] + '\n' + lines[1].slice(0, 40)) // druhý záznam useknutý
      appendFileSync(jp, '')
      const stub2 = makeRunner()
      const s2 = await runWorkflow({ workflow: file, cwd: p.cwd, runner: stub2.runner, resumeRunId: s1.runId }, body)
      assert.deepEqual(stub2.prompts(), ['b'])
      assert.equal(s2.status, 'completed')
      // journal je po resume zase použitelný (poslední záznam je kompletní)
      const stub3 = makeRunner()
      await runWorkflow({ workflow: file, cwd: p.cwd, runner: stub3.runner, resumeRunId: s1.runId }, body)
      assert.equal(stub3.calls.length, 0)
    } finally {
      p.cleanup()
    }
  })

  test('neexistující resumeRunId je chyba použití; bez resume vzniká nový běh s novým ID', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      await assert.rejects(
        runWorkflow({ workflow: file, cwd: p.cwd, resumeRunId: 'wf_00000000-000', runner: makeRunner().runner }, scriptDeps(async () => null)),
        (e: any) => e.code === 'RUN_NOT_FOUND',
      )
      await assert.rejects(
        runWorkflow({ workflow: file, cwd: p.cwd, resumeRunId: '../etc', runner: makeRunner().runner }, scriptDeps(async () => null)),
        (e: any) => e.code === 'RUN_NOT_FOUND',
      )
      const a = await runWorkflow({ workflow: file, cwd: p.cwd, runner: makeRunner().runner }, scriptDeps(async () => 1))
      const b = await runWorkflow({ workflow: file, cwd: p.cwd, runner: makeRunner().runner }, scriptDeps(async () => 1))
      assert.notEqual(a.runId, b.runId)
      const c = await runWorkflow({ workflow: file, cwd: p.cwd, runId: 'muj-beh', runner: makeRunner().runner }, scriptDeps(async () => 1))
      assert.equal(c.runId, 'muj-beh')
      await assert.rejects(
        runWorkflow({ workflow: file, cwd: p.cwd, runId: 'muj-beh', runner: makeRunner().runner }, scriptDeps(async () => 1)),
        (e: any) => e.code === 'RUN_EXISTS',
      )
    } finally {
      p.cleanup()
    }
  })
})

describe('runWorkflow: zámek běhu', () => {
  test('.lock zmizí po dokončení i po selhání skriptu; resume běhu se stejným pid zámku je odmítnut', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      const ok = await runWorkflow({ workflow: file, cwd: p.cwd, runner: makeRunner().runner }, scriptDeps(async () => 1))
      assert.equal(existsSync(join(ok.runDir, '.lock')), false)
      const bad = await runWorkflow(
        { workflow: file, cwd: p.cwd, runner: makeRunner().runner },
        scriptDeps(async () => {
          throw new Error('boom')
        }),
      )
      assert.equal(bad.status, 'failed')
      assert.equal(existsSync(join(bad.runDir, '.lock')), false)

      // souběžný resume téhož běhu (zámek drží živý proces) → RUN_LOCKED a cizí zámek zůstane
      const slow = makeRunner({ delayMs: 200 })
      const first = runWorkflow(
        { workflow: file, cwd: p.cwd, runner: slow.runner, resumeRunId: ok.runId },
        scriptDeps(async (api) => api.agent('pomalý')),
      )
      await waitFor(() => existsSync(join(ok.runDir, '.lock')))
      await assert.rejects(
        runWorkflow({ workflow: file, cwd: p.cwd, runner: makeRunner().runner, resumeRunId: ok.runId }, scriptDeps(async () => 1)),
        (e: any) => e.code === 'RUN_LOCKED' && /pid/.test(e.message),
      )
      assert.equal(existsSync(join(ok.runDir, '.lock')), true, 'odmítnutý pokus nesmí smazat cizí zámek')
      const done = await first
      assert.equal(done.status, 'completed')
      assert.equal(existsSync(join(ok.runDir, '.lock')), false)
    } finally {
      p.cleanup()
    }
  })

  test('zámek mrtvého procesu (zabitý běh) nebrání resume', async () => {
    const p = makeProject()
    try {
      const file = p.script()
      const first = await runWorkflow({ workflow: file, cwd: p.cwd, runner: makeRunner().runner }, scriptDeps(async (api) => api.agent('a')))
      writeFileSync(join(first.runDir, '.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, ts: 'x' }))
      const stub = makeRunner()
      const second = await runWorkflow({ workflow: '', cwd: p.cwd, runner: stub.runner, resumeRunId: first.runId }, scriptDeps(async (api) => api.agent('a')))
      assert.equal(second.status, 'completed')
      assert.equal(second.totals.cachedAgents, 1)
      assert.equal(existsSync(join(first.runDir, '.lock')), false)
      // poškozený zámek se bere jako opuštěný
      writeFileSync(join(first.runDir, '.lock'), '{nesmysl')
      const third = await runWorkflow({ workflow: '', cwd: p.cwd, runner: stub.runner, resumeRunId: first.runId }, scriptDeps(async (api) => api.agent('a')))
      assert.equal(third.status, 'completed')
    } finally {
      p.cleanup()
    }
  })
})
