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
  const older = makeSummary({ runId: 'wf_old00000-000', name: 'starsi', startedAt: '2025-12-31T10:00:00.000Z' })
  const newer = makeSummary()
  const store = makeStore([{ summary: newer, events: EVENTS }, { summary: older }])

  it('bez id vezme nejnovější běh (první z listRuns) a vypisuje na stdout', async () => {
    const cap = makeIO()
    const code = await main(['status'], cap.io, { store, now: () => NOW })
    assert.equal(code, 0)
    const out = cap.out()
    assert.match(out, /^Běh wf_aaaaaaaa-111 {2}demo/)
    assert.match(out, /Stav: {5}completed/)
    assert.match(out, /Fáze:\n {4}Scan {2}1 agent/)
    assert.match(out, /#1 {2}hotovo {2}scan-a {2}7\.0 s {2}\$0\.0100/)
    assert.equal(cap.err(), '')
    assert.ok(store.calls.includes('listRuns'))
  })

  it('s runId použije zadaný běh', async () => {
    const cap = makeIO()
    assert.equal(await main(['status', 'wf_old00000-000'], cap.io, { store, now: () => NOW }), 0)
    assert.match(cap.out(), /starsi/)
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

  it('neznámé runId i žádné běhy → exit 2', async () => {
    const a = makeIO()
    assert.equal(await main(['status', 'wf_neni'], a.io, { store }), 2)
    assert.match(a.err(), /nenalezen/)
    assert.equal(a.out(), '')
    const b = makeIO()
    assert.equal(await main(['status'], b.io, { store: makeStore([]) }), 2)
    assert.match(b.err(), /Žádné běhy/)
  })

  it('nebezpečné runId (průchod adresáři) → exit 2', async () => {
    const cap = makeIO()
    assert.equal(await main(['status', '../../etc'], cap.io, { store }), 2)
  })

  it('běžící běh: doba se počítá z hodin', async () => {
    const running = makeSummary({ runId: 'wf_run00000-000', status: 'running', durationMs: 0, startedAt: '2026-01-01T10:28:00.000Z' })
    const cap = makeIO()
    await main(['status', 'wf_run00000-000'], cap.io, { store: makeStore([{ summary: running }]), now: () => NOW })
    assert.match(cap.out(), /Doba: {5}2m00s \(běží\)/)
  })
})

describe('list', () => {
  const runs: RunSummary[] = [
    makeSummary({ runId: 'wf_r3', name: 'tri', startedAt: '2026-01-01T10:20:00.000Z' }),
    makeSummary({ runId: 'wf_r2', name: 'dva', status: 'failed', startedAt: '2026-01-01T09:00:00.000Z' }),
    makeSummary({ runId: 'wf_r1', name: 'jedna', startedAt: '2025-12-30T09:00:00.000Z' }),
  ]
  const store = makeStore(runs.map((summary) => ({ summary })))
  const discovery = makeDiscovery([
    { name: 'hello', path: '/p/.ultracode/workflows/hello.workflow.ts', description: 'Pozdrav', scope: 'project' },
    { name: 'global', path: '/home/u/.ultracode/workflows/global.ts', scope: 'user' },
  ])

  it('vypíše běhy i workflow', async () => {
    const cap = makeIO()
    assert.equal(await main(['list'], cap.io, { store, discovery, now: () => NOW }), 0)
    const out = cap.out()
    assert.match(out, /Běhy \(3\):/)
    assert.match(out, /wf_r3 {2}tri {7}completed {2}před 10 min/)
    assert.match(out, /wf_r2 {2}dva {7}failed/)
    assert.match(out, /wf_r1 {2}jedna {5}completed {2}před 2 dny/)
    assert.match(out, /Workflow \(2\):/)
    assert.match(out, /hello {3}projekt {3}Pozdrav {2}\/p\/\.ultracode\/workflows\/hello\.workflow\.ts/)
    assert.match(out, /global {2}uživatel {3}/)
    assert.equal(cap.err(), '')
  })

  it('--limit omezí počet běhů a ukáže celkový počet', async () => {
    const cap = makeIO()
    await main(['list', '--limit', '2'], cap.io, { store, discovery, now: () => NOW })
    assert.match(cap.out(), /Běhy \(2 z 3\):/)
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

  it('prázdný stav a selhání discovery nespadnou', async () => {
    const cap = makeIO()
    const badDiscovery = {
      listWorkflows: () => {
        throw new Error('disk')
      },
      findWorkflow: () => '',
    }
    assert.equal(await main(['list'], cap.io, { store: makeStore([]), discovery: badDiscovery }), 0)
    assert.match(cap.out(), /žádné/)
    assert.match(cap.out(), /nelze vyhledat: disk/)
  })

  it('neplatný --limit → 2', async () => {
    const cap = makeIO()
    assert.equal(await main(['list', '--limit', 'x'], cap.io, { store, discovery }), 2)
  })
})

describe('logs', () => {
  const summary = makeSummary()
  const store = makeStore([{ summary, events: EVENTS }])

  it('vypíše události čitelně s časem na stdout', async () => {
    const cap = makeIO()
    assert.equal(await main(['logs', 'wf_aaaaaaaa-111'], cap.io, { store }), 0)
    assert.deepEqual(cap.out().trimEnd().split('\n'), [
      '[10:00:00] ultracode wf_aaaaaaaa-111  demo',
      '[10:00:00]   d',
      '[10:00:01] == Fáze: Scan',
      '[10:00:02]   #1 start   scan-a',
      '[10:00:09]   #1 hotovo  scan-a  7.0 s  in 100 out 50  $0.0100  2 nástroje',
      '[10:01:05] == Konec: completed  1m05s  3 agenti  $0.0421',
    ])
  })

  it('--json: jeden event na řádek', async () => {
    const cap = makeIO()
    await main(['logs', 'wf_aaaaaaaa-111', '--json'], cap.io, { store })
    const lines = cap.out().trimEnd().split('\n')
    assert.equal(lines.length, EVENTS.length)
    assert.equal(JSON.parse(lines[1]).t, 'phase')
  })

  it('neznámý běh → 2; chybějící runId → 2', async () => {
    const a = makeIO()
    assert.equal(await main(['logs', 'wf_nope'], a.io, { store }), 2)
    const b = makeIO()
    assert.equal(await main(['logs'], b.io, { store }), 2)
  })

  describe('--follow', () => {
    /** Store, jehož events.jsonl roste s každým čtením; stav běhu přepne až s run_end. */
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

    it('dopisuje nové události a skončí po run_end (každá událost právě jednou)', async () => {
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
      assert.equal(lines.filter((l) => l.includes('== Fáze: Scan')).length, 1)
      assert.equal(lines.filter((l) => l.includes('#1 start')).length, 1)
      assert.ok(lines.at(-1)!.includes('== Konec: completed'))
      assert.ok(sleeps >= 3 && sleeps < 10, `sleeps=${sleeps}`)
    })

    it('resume: starý run_end v events.jsonl neukončí --follow, dokud neskončí i obnovený běh', async () => {
      const [start, phase, aStart, , end] = EVENTS
      const resumed: RunEvent = { ...(start as Extract<RunEvent, { t: 'run_start' }>), resumed: true, ts: '2026-01-01T11:00:00.000Z' }
      const aDone2: RunEvent = { t: 'agent_done', ts: '2026-01-01T11:00:05.000Z', id: 1, ok: true, cached: false, durationMs: 100, usage: USAGE, costUsd: 0, toolCalls: 0 }
      const end2: RunEvent = { ...(end as Extract<RunEvent, { t: 'run_end' }>), ts: '2026-01-01T11:00:06.000Z' }
      // první čtení už obsahuje run_end přerušeného běhu; run.json je ale znovu running (probíhá resume)
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
      assert.equal(lines.filter((l) => l.includes('== Konec')).length, 2)
      assert.ok(lines.at(-1)!.includes('== Konec'))
    })

    it('resume: starý run_end bez nového run_start (běh ještě startuje) → čeká dál, ne konec', async () => {
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

    it('už dokončený běh: nečeká, vypíše a skončí', async () => {
      const cap = makeIO()
      const code = await main(['logs', 'wf_aaaaaaaa-111', '--follow'], cap.io, {
        store,
        sleep: async () => {
          throw new Error('nemělo se čekat')
        },
      })
      assert.equal(code, 0)
      assert.match(cap.out(), /== Konec/)
    })

    it('abort signálem → 130', async () => {
      const ctrl = new AbortController()
      const st = growingStore([[EVENTS[0]]])
      // běh nikdy neskončí; sleep abortne
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

    it('ticho delší než followIdleMs při stavu running → exit 1 (žádné nekonečné čekání)', async () => {
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
      assert.match(cap.err(), /pravděpodobně spadl/)
    })

    it('běh skončil bez run_end (pád) → follow se ukončí podle stavu v run.json', async () => {
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
    it('vypíše prompt, výsledek a stderr agenta z adresáře běhu', async () => {
      const root = tmpDir()
      const dir = join(root, 'wf_aaaaaaaa-111', 'agents', '1')
      writeFile(join(dir, 'prompt.txt'), 'Projdi soubory a vrať seznam.\n')
      writeFile(join(dir, 'result.json'), JSON.stringify({ ok: true, structured: { files: ['a.ts'] } }))
      writeFile(join(dir, 'stderr.txt'), 'warning: něco\n')
      const st = { ...makeStore([{ summary, events: EVENTS }]), runsRoot: () => root }
      const cap = makeIO()
      const code = await main(['logs', 'wf_aaaaaaaa-111', '--agent', '1'], cap.io, { store: st })
      assert.equal(code, 0)
      const out = cap.out()
      assert.match(out, /^Agent #1 {2}scan-a {2}\(fáze Scan\)/)
      assert.match(out, /-- Prompt --\nProjdi soubory a vrať seznam\.\n/)
      assert.match(out, /-- Výsledek --\n\{\n {2}"ok": true,/)
      assert.match(out, /"files": \[\n {6}"a\.ts"/)
      assert.match(out, /-- stderr --\nwarning: něco/)
    })

    it('--json: prompt + result jako objekt', async () => {
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

    it('neexistující agent → 2; neplatné číslo → 2; --follow + --agent → 2', async () => {
      const root = tmpDir()
      const st = { ...makeStore([{ summary }]), runsRoot: () => root }
      const a = makeIO()
      assert.equal(await main(['logs', 'wf_aaaaaaaa-111', '--agent', '9'], a.io, { store: st }), 2)
      assert.match(a.err(), /Agent #9 .* nenalezen/)
      assert.equal(await main(['logs', 'wf_aaaaaaaa-111', '--agent', 'x'], makeIO().io, { store: st }), 2)
      assert.equal(await main(['logs', 'wf_aaaaaaaa-111', '--agent', '1', '--follow'], makeIO().io, { store: st }), 2)
    })
  })
})
