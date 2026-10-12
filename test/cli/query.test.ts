/** status, list, logs. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { main } from '../../src/cli/cli.ts'
import type { CliStore } from '../../src/cli/types.ts'
import type { RunEvent, RunSummary } from '../../src/types.ts'
import { ev, makeDiscovery, makeIO, makeStore, makeSummary, tmpDir, writeFile } from './helpers.ts'

const USAGE = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 }

const EVENTS: RunEvent[] = [
  { t: 'run_start', ts: '2026-01-01T10:00:00.000Z', runId: 'wf_aaaaaaaa-111', name: 'demo', description: 'd', args: null, cwd: '/p', scriptPath: '/p/demo.ts', resumed: false, phases: [{ title: 'Scan' }] },
  { t: 'phase', ts: '2026-01-01T10:00:01.000Z', title: 'Scan', workflowPath: ['demo'] },
  { t: 'agent_start', ts: '2026-01-01T10:00:02.000Z', id: 1, label: 'scan-a', phase: 'Scan', workflowPath: ['demo'], promptPreview: 'x' },
  { t: 'agent_done', ts: '2026-01-01T10:00:09.000Z', id: 1, ok: true, cached: false, durationMs: 7000, usage: USAGE, costUsd: 0.01, toolCalls: 2 },
  { t: 'run_end', ts: '2026-01-01T10:01:05.000Z', status: 'completed', durationMs: 65_000, totals: makeSummary().totals },
]

const NOW = Date.parse('2026-01-01T10:30:00.000Z')

describe('status', () => {
  const older = makeSummary({ runId: 'wf_old00000-000', name: 'older', startedAt: '2025-12-31T10:00:00.000Z' })
  const newer = makeSummary()
  const store = makeStore([{ summary: newer, events: EVENTS }, { summary: older }])

  it('without id takes the latest run (first of listRuns) and prints to stdout', async () => {
    const cap = makeIO()
    const code = await main(['status'], cap.io, { store, now: () => NOW })
    assert.equal(code, 0)
    const out = cap.out()
    assert.match(out, /^Run wf_aaaaaaaa-111 {2}demo/)
    assert.match(out, /Status: {3}completed/)
    assert.match(out, /Phases:\n {4}Scan {2}1 agent/)
    assert.match(out, /#1 {2}done {2}scan-a {2}7\.0 s {2}\$0\.0100/)
    assert.equal(cap.err(), '')
    assert.ok(store.calls.includes('listRuns'))
  })

  it('with runId uses the given run', async () => {
    const cap = makeIO()
    assert.equal(await main(['status', 'wf_old00000-000'], cap.io, { store, now: () => NOW }), 0)
    assert.match(cap.out(), /older/)
  })

  it('--json: summary + agents + phases', async () => {
    const cap = makeIO()
    assert.equal(await main(['status', '--json'], cap.io, { store, now: () => NOW }), 0)
    const j = JSON.parse(cap.out())
    assert.equal(j.summary.runId, 'wf_aaaaaaaa-111')
    assert.equal(j.agents.length, 1)
    assert.equal(j.agents[0].state, 'done')
    assert.deepEqual(j.phases, [{ title: 'Scan', agents: 1 }])
  })

  it('unknown runId and no runs → exit 2', async () => {
    const a = makeIO()
    assert.equal(await main(['status', 'wf_neni'], a.io, { store }), 2)
    assert.match(a.err(), /not found/)
    assert.equal(a.out(), '')
    const b = makeIO()
    assert.equal(await main(['status'], b.io, { store: makeStore([]) }), 2)
    assert.match(b.err(), /No runs/)
  })

  it('dangerous runId (directory traversal) → exit 2', async () => {
    const cap = makeIO()
    assert.equal(await main(['status', '../../etc'], cap.io, { store }), 2)
  })

  it('running run: duration is computed from the clock', async () => {
    const running = makeSummary({ runId: 'wf_run00000-000', status: 'running', durationMs: 0, startedAt: '2026-01-01T10:28:00.000Z' })
    const cap = makeIO()
    await main(['status', 'wf_run00000-000'], cap.io, { store: makeStore([{ summary: running }]), now: () => NOW })
    assert.match(cap.out(), /Duration: {1}2m00s \(running\)/)
  })
})

describe('list', () => {
  const runs: RunSummary[] = [
    makeSummary({ runId: 'wf_r3', name: 'three', startedAt: '2026-01-01T10:20:00.000Z' }),
    makeSummary({ runId: 'wf_r2', name: 'two', status: 'failed', startedAt: '2026-01-01T09:00:00.000Z' }),
    makeSummary({ runId: 'wf_r1', name: 'one', startedAt: '2025-12-30T09:00:00.000Z' }),
  ]
  const store = makeStore(runs.map((summary) => ({ summary })))
  const discovery = makeDiscovery([
    { name: 'hello', path: '/p/.ultracode/workflows/hello.workflow.ts', description: 'Greeting', scope: 'project' },
    { name: 'global', path: '/home/u/.ultracode/workflows/global.ts', scope: 'user' },
  ])

  it('lists runs and workflows', async () => {
    const cap = makeIO()
    assert.equal(await main(['list'], cap.io, { store, discovery, now: () => NOW }), 0)
    const out = cap.out()
    assert.match(out, /Runs \(3\):/)
    assert.match(out, /wf_r3 {2}three {5}completed {2}10 min ago/)
    assert.match(out, /wf_r2 {2}two {7}failed/)
    assert.match(out, /wf_r1 {2}one {7}completed {2}2 days ago/)
    assert.match(out, /Workflows \(2\):/)
    assert.match(out, /hello {3}project {2}Greeting {2}\/p\/\.ultracode\/workflows\/hello\.workflow\.ts/)
    assert.match(out, /global {2}user {3}/)
    assert.equal(cap.err(), '')
  })

  it('--limit limits the number of runs and shows the total', async () => {
    const cap = makeIO()
    await main(['list', '--limit', '2'], cap.io, { store, discovery, now: () => NOW })
    assert.match(cap.out(), /Runs \(2 z 3\):/)
    assert.doesNotMatch(cap.out(), /wf_r1/)
  })

  it('--json', async () => {
    const cap = makeIO()
    await main(['list', '--json', '--limit', '1'], cap.io, { store, discovery })
    const j = JSON.parse(cap.out())
    assert.equal(j.runs.length, 1)
    assert.equal(j.runs[0].runId, 'wf_r3')
    assert.equal(j.workflows.length, 2)
  })

  it('empty state and discovery failure do not crash', async () => {
    const cap = makeIO()
    const badDiscovery = {
      listWorkflows: () => {
        throw new Error('disk')
      },
      findWorkflow: () => '',
    }
    assert.equal(await main(['list'], cap.io, { store: makeStore([]), discovery: badDiscovery }), 0)
    assert.match(cap.out(), /none/)
    assert.match(cap.out(), /cannot discover: disk/)
  })

  it('invalid --limit → 2', async () => {
    const cap = makeIO()
    assert.equal(await main(['list', '--limit', 'x'], cap.io, { store, discovery }), 2)
  })
})

describe('logs', () => {
  const summary = makeSummary()
  const store = makeStore([{ summary, events: EVENTS }])

  it('prints events readably with time to stdout', async () => {
    const cap = makeIO()
    assert.equal(await main(['logs', 'wf_aaaaaaaa-111'], cap.io, { store }), 0)
    assert.deepEqual(cap.out().trimEnd().split('\n'), [
      '[10:00:00] ultracode wf_aaaaaaaa-111  demo',
      '[10:00:00]   d',
      '[10:00:01] == Phase: Scan',
      '[10:00:02]   #1 start   scan-a',
      '[10:00:09]   #1 done    scan-a  7.0 s  in 100 out 50  $0.0100  2 tools',
      '[10:01:05] == End: completed  1m05s  3 agents  $0.0421',
    ])
  })

  it('--json: one event per line', async () => {
    const cap = makeIO()
    await main(['logs', 'wf_aaaaaaaa-111', '--json'], cap.io, { store })
    const lines = cap.out().trimEnd().split('\n')
    assert.equal(lines.length, EVENTS.length)
    assert.equal(JSON.parse(lines[1]).t, 'phase')
  })

  it('unknown run → 2; missing runId → 2', async () => {
    const a = makeIO()
    assert.equal(await main(['logs', 'wf_nope'], a.io, { store }), 2)
    const b = makeIO()
    assert.equal(await main(['logs'], b.io, { store }), 2)
  })

  describe('--follow', () => {
    /** Store whose events.jsonl grows with each read; the run status switches only with run_end. */
    function growingStore(chunks: RunEvent[][], finalStatus: RunSummary['status'] = 'completed') {
      let reads = 0
      const all: RunEvent[] = []
      const running = makeSummary({ status: 'running' })
      const store: CliStore & { reads(): number } = {
        runsRoot: () => '/r',
        listRuns: () => [running],
        readRunSummary: () => (reads >= chunks.length ? makeSummary({ status: finalStatus }) : running),
        readEvents: () => {
          const next = chunks[Math.min(reads, chunks.length - 1)]
          if (reads < chunks.length) all.push(...next)
          reads++
          return [...all]
        },
        reads: () => reads,
      }
      return store
    }

    it('appends new events and ends after run_end (each event exactly once)', async () => {
      const [start, phase, aStart, aDone, end] = EVENTS
      const st = growingStore([[start], [phase, aStart], [aDone], [end]])
      let sleeps = 0
      const cap = makeIO()
      const code = await main(['logs', 'wf_aaaaaaaa-111', '--follow'], cap.io, {
        store: st,
        sleep: async () => {
          sleeps++
        },
      })
      assert.equal(code, 0)
      const lines = cap.out().trimEnd().split('\n')
      assert.equal(lines.filter((l) => l.includes('== Phase: Scan')).length, 1)
      assert.equal(lines.filter((l) => l.includes('#1 start')).length, 1)
      assert.ok(lines.at(-1)!.includes('== End: completed'))
      assert.ok(sleeps >= 3 && sleeps < 10, `sleeps=${sleeps}`)
    })

    it('resume: an old run_end in events.jsonl does not end --follow until the resumed run also ends', async () => {
      const [start, phase, aStart, , end] = EVENTS
      const resumed: RunEvent = { ...(start as Extract<RunEvent, { t: 'run_start' }>), resumed: true, ts: '2026-01-01T11:00:00.000Z' }
      const aDone2: RunEvent = { t: 'agent_done', ts: '2026-01-01T11:00:05.000Z', id: 1, ok: true, cached: false, durationMs: 100, usage: USAGE, costUsd: 0, toolCalls: 0 }
      const end2: RunEvent = { ...(end as Extract<RunEvent, { t: 'run_end' }>), ts: '2026-01-01T11:00:06.000Z' }
      // the first read already contains run_end of the interrupted run; run.json is however running again (resume in progress)
      const st = growingStore([[start, phase, aStart, end], [resumed, phase], [aDone2], [end2]])
      let sleeps = 0
      const cap = makeIO()
      const code = await main(['logs', 'wf_aaaaaaaa-111', '--follow'], cap.io, {
        store: st,
        sleep: async () => {
          sleeps++
        },
      })
      assert.equal(code, 0)
      assert.ok(sleeps >= 2, `sleeps=${sleeps}`)
      const lines = cap.out().trimEnd().split('\n')
      assert.equal(lines.filter((l) => l.includes('== End')).length, 2)
      assert.ok(lines.at(-1)!.includes('== End'))
    })

    it('resume: old run_end without a new run_start (run is still starting) → keeps waiting, not end', async () => {
      const ctrl = new AbortController()
      const st = growingStore([[EVENTS[0], EVENTS[4]]])
      st.readRunSummary = () => makeSummary({ status: 'running' })
      let sleeps = 0
      const cap = makeIO()
      const code = await main(['logs', 'wf_aaaaaaaa-111', '--follow'], cap.io, {
        store: st,
        signal: ctrl.signal,
        sleep: async () => {
          if (++sleeps >= 3) ctrl.abort()
        },
      })
      assert.equal(sleeps, 3)
      assert.equal(code, 130)
    })

    it('already finished run: does not wait, prints and exits', async () => {
      const cap = makeIO()
      const code = await main(['logs', 'wf_aaaaaaaa-111', '--follow'], cap.io, {
        store,
        sleep: async () => {
          throw new Error('should not have waited')
        },
      })
      assert.equal(code, 0)
      assert.match(cap.out(), /== End/)
    })

    it('abort by signal → 130', async () => {
      const ctrl = new AbortController()
      const st = growingStore([[EVENTS[0]]])
      // run never ends; sleep aborts
      st.readRunSummary = () => makeSummary({ status: 'running' })
      const cap = makeIO()
      const code = await main(['logs', 'wf_aaaaaaaa-111', '--follow'], cap.io, {
        store: st,
        signal: ctrl.signal,
        sleep: async () => {
          ctrl.abort()
        },
      })
      assert.equal(code, 130)
    })

    it('silence longer than followIdleMs with running status → exit 1 (no endless waiting)', async () => {
      let now = 0
      const st = growingStore([[EVENTS[0]]])
      st.readRunSummary = () => makeSummary({ status: 'running' })
      const cap = makeIO()
      const code = await main(['logs', 'wf_aaaaaaaa-111', '--follow'], cap.io, {
        store: st,
        now: () => now,
        followIdleMs: 5000,
        followPollMs: 1000,
        sleep: async (ms) => {
          now += ms
        },
      })
      assert.equal(code, 1)
      assert.match(cap.err(), /probably crashed/)
    })

    it('run ended without run_end (crash) → follow ends according to the state in run.json', async () => {
      const st = growingStore([[EVENTS[0]]], 'failed')
      st.readRunSummary = (() => {
        let n = 0
        return () => makeSummary({ status: ++n > 2 ? 'failed' : 'running' })
      })()
      const cap = makeIO()
      const code = await main(['logs', 'wf_aaaaaaaa-111', '--follow'], cap.io, {
        store: st,
        sleep: async () => {},
      })
      assert.equal(code, 0)
    })
  })

  describe('--agent', () => {
    it('prints the prompt, result and stderr of the agent from the run directory', async () => {
      const root = tmpDir()
      const dir = join(root, 'wf_aaaaaaaa-111', 'agents', '1')
      writeFile(join(dir, 'prompt.txt'), 'Scan the files and return a list.\n')
      writeFile(join(dir, 'result.json'), JSON.stringify({ ok: true, structured: { files: ['a.ts'] } }))
      writeFile(join(dir, 'stderr.txt'), 'warning: something\n')
      const st = { ...makeStore([{ summary, events: EVENTS }]), runsRoot: () => root }
      const cap = makeIO()
      const code = await main(['logs', 'wf_aaaaaaaa-111', '--agent', '1'], cap.io, { store: st })
      assert.equal(code, 0)
      const out = cap.out()
      assert.match(out, /^Agent #1 {2}scan-a {2}\(phase Scan\)/)
      assert.match(out, /-- Prompt --\nScan the files and return a list\.\n/)
      assert.match(out, /-- Result --\n\{\n {2}"ok": true,/)
      assert.match(out, /"files": \[\n {6}"a\.ts"/)
      assert.match(out, /-- stderr --\nwarning: something/)
    })

    it('--json: prompt + result as an object', async () => {
      const root = tmpDir()
      const dir = join(root, 'wf_aaaaaaaa-111', 'agents', '2')
      writeFile(join(dir, 'prompt.txt'), 'P')
      writeFile(join(dir, 'result.json'), '{"text":"T"}')
      const st = { ...makeStore([{ summary }]), runsRoot: () => root }
      const cap = makeIO()
      await main(['logs', 'wf_aaaaaaaa-111', '--agent', '2', '--json'], cap.io, { store: st })
      const j = JSON.parse(cap.out())
      assert.equal(j.prompt, 'P')
      assert.deepEqual(j.result, { text: 'T' })
      assert.equal(j.stderr, null)
    })

    it('nonexistent agent → 2; invalid number → 2; --follow + --agent → 2', async () => {
      const root = tmpDir()
      const st = { ...makeStore([{ summary }]), runsRoot: () => root }
      const a = makeIO()
      assert.equal(await main(['logs', 'wf_aaaaaaaa-111', '--agent', '9'], a.io, { store: st }), 2)
      assert.match(a.err(), /Agent #9 not found/)
      assert.equal(await main(['logs', 'wf_aaaaaaaa-111', '--agent', 'x'], makeIO().io, { store: st }), 2)
      assert.equal(await main(['logs', 'wf_aaaaaaaa-111', '--agent', '1', '--follow'], makeIO().io, { store: st }), 2)
    })
  })
})
