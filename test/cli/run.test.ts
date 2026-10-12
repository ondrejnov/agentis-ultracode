import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { main } from '../../src/cli/cli.ts'
import { AbortedError, ScriptValidationError, WorkflowNotFoundError } from '../../src/errors.ts'
import type { RunEvent } from '../../src/types.ts'
import { T0, ev, fakeEngine, makeDiscovery, makeIO, makeStore, makeSummary, tmpDir, writeFile } from './helpers.ts'

const USAGE = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 }

const SAMPLE_EVENTS: RunEvent[] = [
  ev('run_start', { runId: 'wf_aaaaaaaa-111', name: 'demo', description: 'Ukázka', args: null, cwd: '/p', scriptPath: '/p/demo.ts', resumed: false, phases: [] }),
  ev('phase', { title: 'Scan', workflowPath: ['demo'] }),
  ev('agent_start', { id: 1, label: 'scan', phase: 'Scan', workflowPath: ['demo'], promptPreview: 'p' }),
  ev('agent_done', { id: 1, ok: true, cached: false, durationMs: 1500, usage: USAGE, costUsd: 0.002, toolCalls: 0 }),
  { t: 'run_end', ts: T0, status: 'completed', durationMs: 65_000, totals: makeSummary().totals },
]

describe('run: výstup a exit kódy', () => {
  it('completed: stdout = JSON výsledek, stderr = průběh + souhrn, exit 0', async () => {
    const cap = makeIO({ cwd: '/proj' })
    const eng = fakeEngine(makeSummary({ result: { files: ['a', 'b'], n: 2 } }), SAMPLE_EVENTS)
    const code = await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow })
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(cap.out()), { files: ['a', 'b'], n: 2 })
    assert.equal(cap.out(), '{"files":["a","b"],"n":2}\n', 'mimo TTY kompaktní JSON a nic jiného na stdout')
    const err = cap.err()
    assert.match(err, /ultracode wf_aaaaaaaa-111 {2}demo/)
    assert.match(err, /== Fáze: Scan/)
    assert.match(err, /#1 hotovo {2}scan {2}1\.5 s/)
    assert.match(err, /-- Souhrn --/)
    assert.match(err, /Stav: {5}completed/)
    assert.doesNotMatch(err, /== Konec:/, 'run_end nahrazuje souhrn, nevypisuje se dvakrát')
    assert.ok(!cap.out().includes('Souhrn'))
  })

  it('stdout na TTY je odsazený JSON', async () => {
    const cap = makeIO({ isTTY: true, stdoutIsTTY: true })
    const eng = fakeEngine(makeSummary({ result: { a: 1 } }))
    await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow })
    assert.equal(cap.out(), '{\n  "a": 1\n}\n')
  })

  it('--json: na stdout celé RunSummary', async () => {
    const cap = makeIO()
    const summary = makeSummary({ result: [1, 2] })
    const eng = fakeEngine(summary)
    const code = await main(['run', 'demo', '--json'], cap.io, { runWorkflow: eng.runWorkflow })
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(cap.out()), JSON.parse(JSON.stringify(summary)))
  })

  it('completed bez výsledku → null', async () => {
    const cap = makeIO()
    const eng = fakeEngine(makeSummary())
    assert.equal(await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow }), 0)
    assert.equal(cap.out(), 'null\n')
  })

  it('failed: exit 1, stdout prázdný, chyba na stderr', async () => {
    const cap = makeIO()
    const eng = fakeEngine(makeSummary({ status: 'failed', error: 'Skript: TypeError x', result: undefined }))
    const code = await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow })
    assert.equal(code, 1)
    assert.equal(cap.out(), '')
    assert.match(cap.err(), /Chyba: {4}Skript: TypeError x/)
  })

  it('failed s --json stále vypíše shrnutí na stdout', async () => {
    const cap = makeIO()
    const eng = fakeEngine(makeSummary({ status: 'failed', error: 'x' }))
    const code = await main(['run', 'demo', '--json'], cap.io, { runWorkflow: eng.runWorkflow })
    assert.equal(code, 1)
    assert.equal(JSON.parse(cap.out()).status, 'failed')
  })

  it('aborted → 130', async () => {
    const cap = makeIO()
    const eng = fakeEngine(makeSummary({ status: 'aborted', error: 'Běh byl přerušen.' }))
    assert.equal(await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow }), 130)
    assert.equal(cap.out(), '')
  })

  it('--quiet potlačí průběh i souhrn, ale chyby ne', async () => {
    const ok = makeIO()
    const engOk = fakeEngine(makeSummary({ result: 7 }), SAMPLE_EVENTS)
    assert.equal(await main(['run', 'demo', '--quiet'], ok.io, { runWorkflow: engOk.runWorkflow }), 0)
    assert.equal(ok.err(), '')
    assert.equal(ok.out(), '7\n')

    const bad = makeIO()
    const engBad = fakeEngine(makeSummary({ status: 'failed', error: 'selhalo to' }), SAMPLE_EVENTS)
    assert.equal(await main(['run', 'demo', '-q'], bad.io, { runWorkflow: engBad.runWorkflow }), 1)
    assert.match(bad.err(), /selhalo to/)
    assert.doesNotMatch(bad.err(), /Fáze/)
  })

  it('překročený rozpočet se oznámí v souhrnu', async () => {
    const cap = makeIO()
    const eng = fakeEngine(makeSummary({ budgetExceeded: true, result: 1 }))
    assert.equal(await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow }), 0)
    assert.match(cap.err(), /rozpočet překročen/)
  })
})

describe('run: barvy', () => {
  const run = async (opts: Parameters<typeof makeIO>[0], extra: string[] = []) => {
    const cap = makeIO(opts)
    const eng = fakeEngine(makeSummary({ result: 1 }), SAMPLE_EVENTS)
    await main(['run', 'demo', ...extra], cap.io, { runWorkflow: eng.runWorkflow })
    return cap
  }
  it('na TTY jsou barvy jen na stderr', async () => {
    const cap = await run({ isTTY: true })
    assert.match(cap.err(), /\u001b\[/)
    assert.ok(!cap.out().includes('\u001b['))
  })
  it('bez TTY, s NO_COLOR i s --no-color žádné barvy', async () => {
    assert.doesNotMatch((await run({ isTTY: false })).err(), /\u001b\[/)
    assert.doesNotMatch((await run({ isTTY: true, env: { NO_COLOR: '1' } })).err(), /\u001b\[/)
    assert.doesNotMatch((await run({ isTTY: true }, ['--no-color'])).err(), /\u001b\[/)
    assert.doesNotMatch((await run({ isTTY: true, env: { TERM: 'dumb' } })).err(), /\u001b\[/)
  })
})

describe('run: mapování voleb na RunOptions', () => {
  it('všechny volby se předají enginu', async () => {
    const cwd = tmpDir()
    const cap = makeIO({ cwd: '/jinde' })
    const eng = fakeEngine(makeSummary({ result: 1 }))
    const ctrl = new AbortController()
    const code = await main(
      [
        'run', 'demo',
        '--args', '{"paths":["a","b"],"n":3}',
        '--cwd', cwd,
        '--concurrency', '3',
        '--max-agents', '50',
        '--max-tokens', '90000',
        '--max-usd', '1.5',
        '--model', 'haiku',
        '--effort', 'xhigh',
        '--run-id', 'my-run_1',
      ],
      cap.io,
      { runWorkflow: eng.runWorkflow, signal: ctrl.signal },
    )
    assert.equal(code, 0)
    assert.equal(eng.calls.length, 1)
    const o = eng.calls[0]
    assert.equal(o.workflow, 'demo')
    assert.deepEqual(o.args, { paths: ['a', 'b'], n: 3 })
    assert.equal(o.cwd, cwd)
    assert.equal(o.concurrency, 3)
    assert.equal(o.maxAgents, 50)
    assert.equal(o.maxOutputTokens, 90000)
    assert.equal(o.maxUsd, 1.5)
    assert.equal(o.model, 'haiku')
    assert.equal(o.effort, 'xhigh')
    assert.equal(o.runId, 'my-run_1')
    assert.equal(o.resumeRunId, undefined)
    assert.equal(o.signal, ctrl.signal)
    assert.equal(typeof o.onEvent, 'function')
  })

  it('bez voleb se nepředávají klíče navíc (args zůstává undefined)', async () => {
    const cap = makeIO({ cwd: '/proj' })
    const eng = fakeEngine(makeSummary({ result: 1 }))
    await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow })
    const o = eng.calls[0]
    assert.ok(!('args' in o))
    assert.ok(!('model' in o))
    assert.ok(!('concurrency' in o))
    assert.equal(o.cwd, '/proj')
  })

  it('--args může být skalár / null / pole', async () => {
    for (const [raw, expected] of [['null', null], ['"txt"', 'txt'], ['[1,2]', [1, 2]], ['42', 42]] as const) {
      const eng = fakeEngine(makeSummary({ result: 1 }))
      await main(['run', 'demo', '--args', raw], makeIO().io, { runWorkflow: eng.runWorkflow })
      assert.deepEqual(eng.calls[0].args, expected)
      assert.ok('args' in eng.calls[0])
    }
  })

  it('--args-file načte JSON relativně k cwd procesu', async () => {
    const dir = tmpDir()
    writeFile(join(dir, 'in.json'), '{"x":[1,2,3]}')
    const eng = fakeEngine(makeSummary({ result: 1 }))
    const code = await main(['run', 'demo', '--args-file', 'in.json'], makeIO({ cwd: dir }).io, { runWorkflow: eng.runWorkflow })
    assert.equal(code, 0)
    assert.deepEqual(eng.calls[0].args, { x: [1, 2, 3] })
  })

  it('cesta ke skriptu se převede na absolutní vůči cwd procesu (ne --cwd)', async () => {
    const dir = tmpDir()
    const proj = tmpDir()
    writeFile(join(dir, 'sub', 'my.workflow.ts'), 'x')
    const eng = fakeEngine(makeSummary({ result: 1 }))
    await main(['run', './sub/my.workflow.ts', '--cwd', proj], makeIO({ cwd: dir }).io, { runWorkflow: eng.runWorkflow })
    assert.equal(eng.calls[0].workflow, join(dir, 'sub', 'my.workflow.ts'))
    assert.equal(eng.calls[0].cwd, proj)
  })

  it('jméno workflow se předá beze změny', async () => {
    const eng = fakeEngine(makeSummary({ result: 1 }))
    await main(['run', 'php8-upgrade'], makeIO().io, { runWorkflow: eng.runWorkflow })
    assert.equal(eng.calls[0].workflow, 'php8-upgrade')
  })
})

describe('run: chybné použití (exit 2, engine se nevolá)', () => {
  const expectUsage = async (argv: string[], pattern: RegExp, extra: Parameters<typeof makeIO>[0] = {}) => {
    const cap = makeIO(extra)
    const eng = fakeEngine(makeSummary())
    const code = await main(argv, cap.io, { runWorkflow: eng.runWorkflow, store: makeStore([]) })
    assert.equal(code, 2, `argv=${JSON.stringify(argv)} stderr=${cap.err()}`)
    assert.match(cap.err(), pattern)
    assert.equal(cap.out(), '')
    assert.equal(eng.calls.length, 0, 'engine nesmí být volán')
  }

  it('neplatný JSON v --args', async () => {
    await expectUsage(['run', 'demo', '--args', '{nope'], /--args není platný JSON/)
  })
  it('--args i --args-file současně', async () => {
    await expectUsage(['run', 'demo', '--args', '{}', '--args-file', 'x.json'], /nelze použít současně/)
  })
  it('--args-file neexistuje / není JSON', async () => {
    const dir = tmpDir()
    await expectUsage(['run', 'demo', '--args-file', 'chybi.json'], /nelze přečíst/, { cwd: dir })
    writeFile(join(dir, 'bad.json'), '{oops')
    await expectUsage(['run', 'demo', '--args-file', 'bad.json'], /neobsahuje platný JSON/, { cwd: dir })
  })
  it('chybí workflow', async () => {
    await expectUsage(['run'], /Chybí workflow/)
  })
  it('příliš mnoho argumentů', async () => {
    await expectUsage(['run', 'a', 'b'], /jediný argument/)
  })
  it('neplatné číselné volby a effort', async () => {
    await expectUsage(['run', 'demo', '--concurrency', '0'], /--concurrency/)
    await expectUsage(['run', 'demo', '--max-usd', 'moc'], /--max-usd/)
    await expectUsage(['run', 'demo', '--max-tokens', '-5'], /--max-tokens|nejednoznačn/)
    await expectUsage(['run', 'demo', '--effort', 'turbo'], /--effort/)
  })
  it('neznámá volba', async () => {
    await expectUsage(['run', 'demo', '--rychle'], /Neznámá volba --rychle/)
  })
  it('neexistující --cwd', async () => {
    await expectUsage(['run', 'demo', '--cwd', '/neexistuje/vubec'], /--cwd/)
  })
  it('neexistující soubor skriptu', async () => {
    await expectUsage(['run', './nic.workflow.ts'], /neexistuje/, { cwd: tmpDir() })
  })
  it('nebezpečné --run-id', async () => {
    await expectUsage(['run', 'demo', '--run-id', '../evil'], /Neplatné --run-id/)
  })
})

describe('run: chyby z enginu', () => {
  it('ScriptValidationError → exit 2 s diagnostikou', async () => {
    const cap = makeIO()
    const eng = fakeEngine(() => {
      throw new ScriptValidationError('Skript je neplatný', ['řádek 3: chybí meta', 'řádek 9: import()'])
    })
    const code = await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow })
    assert.equal(code, 2)
    assert.match(cap.err(), /Neplatný skript: Skript je neplatný/)
    assert.match(cap.err(), /- řádek 3: chybí meta/)
    assert.match(cap.err(), /- řádek 9: import\(\)/)
    assert.equal(cap.out(), '')
  })

  it('WorkflowNotFoundError → exit 2', async () => {
    const cap = makeIO()
    const eng = fakeEngine(() => {
      throw new WorkflowNotFoundError('nic', ['/a', '/b'])
    })
    assert.equal(await main(['run', 'nic'], cap.io, { runWorkflow: eng.runWorkflow }), 2)
    assert.match(cap.err(), /nenalezeno/)
    assert.match(cap.err(), /\/a, \/b/)
  })

  it('AbortedError → 130', async () => {
    const cap = makeIO()
    const eng = fakeEngine(() => {
      throw new AbortedError()
    })
    assert.equal(await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow }), 130)
  })

  it('neočekávaná výjimka → exit 1, ne pád', async () => {
    const cap = makeIO()
    const eng = fakeEngine(() => {
      throw new Error('kaboom')
    })
    assert.equal(await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow }), 1)
    assert.match(cap.err(), /neočekávanou chybou: kaboom/)
  })

  it('vadný onEvent renderer nesmí shodit běh (výjimka v události)', async () => {
    const cap = makeIO()
    const bad = { t: 'agent_done', ts: T0, id: 1, ok: true, cached: false, durationMs: 1, costUsd: 0, toolCalls: 0 } as unknown as RunEvent
    const eng = fakeEngine(makeSummary({ result: 1 }), [bad])
    assert.equal(await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow }), 0)
  })
})

describe('resume', () => {
  const prev = makeSummary({ runId: 'wf_prev0001-abc', status: 'failed' })

  it('resume <runId> → workflow prázdné + resumeRunId, args se nepředávají', async () => {
    const cap = makeIO()
    const eng = fakeEngine(makeSummary({ result: 'ok' }))
    const code = await main(['resume', 'wf_prev0001-abc'], cap.io, {
      runWorkflow: eng.runWorkflow,
      store: makeStore([{ summary: prev }]),
    })
    assert.equal(code, 0)
    const o = eng.calls[0]
    assert.equal(o.workflow, '')
    assert.equal(o.resumeRunId, 'wf_prev0001-abc')
    assert.ok(!('args' in o))
    assert.equal(cap.out(), '"ok"\n')
  })

  it('resume přebírá stejné volby (--args, --max-usd, --concurrency)', async () => {
    const eng = fakeEngine(makeSummary({ result: 1 }))
    await main(['resume', 'wf_prev0001-abc', '--args', '{"x":1}', '--max-usd', '3', '--concurrency', '2'], makeIO().io, {
      runWorkflow: eng.runWorkflow,
      store: makeStore([{ summary: prev }]),
    })
    const o = eng.calls[0]
    assert.deepEqual(o.args, { x: 1 })
    assert.equal(o.maxUsd, 3)
    assert.equal(o.concurrency, 2)
  })

  it('run <wf> --resume <id> zachová workflow a doplní resumeRunId', async () => {
    const eng = fakeEngine(makeSummary({ result: 1 }))
    await main(['run', 'demo', '--resume', 'wf_prev0001-abc'], makeIO().io, {
      runWorkflow: eng.runWorkflow,
      store: makeStore([{ summary: prev }]),
    })
    assert.equal(eng.calls[0].workflow, 'demo')
    assert.equal(eng.calls[0].resumeRunId, 'wf_prev0001-abc')
  })

  it('run --resume <id> bez workflow je povoleno', async () => {
    const eng = fakeEngine(makeSummary({ result: 1 }))
    const code = await main(['run', '--resume', 'wf_prev0001-abc'], makeIO().io, {
      runWorkflow: eng.runWorkflow,
      store: makeStore([{ summary: prev }]),
    })
    assert.equal(code, 0)
    assert.equal(eng.calls[0].workflow, '')
  })

  it('neexistující běh → exit 2, engine se nevolá', async () => {
    const cap = makeIO()
    const eng = fakeEngine(makeSummary())
    const code = await main(['resume', 'wf_nope'], cap.io, { runWorkflow: eng.runWorkflow, store: makeStore([]) })
    assert.equal(code, 2)
    assert.match(cap.err(), /Běh „wf_nope“ nenalezen/)
    assert.equal(eng.calls.length, 0)
  })

  it('chybějící / nadbytečné runId, rozpor s --resume', async () => {
    for (const argv of [['resume'], ['resume', 'a', 'b'], ['resume', 'wf_prev0001-abc', '--resume', 'jiny']]) {
      const eng = fakeEngine(makeSummary())
      const cap = makeIO()
      const code = await main(argv, cap.io, { runWorkflow: eng.runWorkflow, store: makeStore([{ summary: prev }]) })
      assert.equal(code, 2, argv.join(' '))
      assert.equal(eng.calls.length, 0)
    }
  })

  it('běh ve stavu running → varování, ale pokračuje', async () => {
    const cap = makeIO()
    const eng = fakeEngine(makeSummary({ result: 1 }))
    const code = await main(['resume', 'wf_prev0001-abc'], cap.io, {
      runWorkflow: eng.runWorkflow,
      store: makeStore([{ summary: makeSummary({ runId: 'wf_prev0001-abc', status: 'running' }) }]),
    })
    assert.equal(code, 0)
    assert.match(cap.err(), /Pozor: běh wf_prev0001-abc je podle run\.json stále ve stavu running/)
  })

  it('průběh obnoveného běhu se vykreslí jako pokračování', async () => {
    const cap = makeIO()
    const start = ev('run_start', { runId: 'wf_prev0001-abc', name: 'demo', description: '', args: null, cwd: '/', scriptPath: '/s', resumed: true, phases: [] })
    const eng = fakeEngine(makeSummary({ result: 1 }), [start])
    await main(['resume', 'wf_prev0001-abc'], cap.io, { runWorkflow: eng.runWorkflow, store: makeStore([{ summary: prev }]) })
    assert.match(cap.err(), /\(pokračování\)/)
  })
})

describe('dispatcher', () => {
  it('main nikdy nevolá process.exit a nehází (neznámý příkaz)', async () => {
    const cap = makeIO()
    const code = await main(['frobnicate'], cap.io, {})
    assert.equal(code, 2)
    assert.match(cap.err(), /neznámý příkaz „frobnicate“/)
  })

  it('discovery fake je kompatibilní (kontrola helperu)', () => {
    assert.throws(() => makeDiscovery().findWorkflow('x', '/'), /nenalezeno/)
  })
})
