import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { main } from '../../src/cli/cli.ts'
import { AbortedError, ScriptValidationError, WorkflowNotFoundError } from '../../src/errors.ts'
import type { RunEvent } from '../../src/types.ts'
import { T0, ev, fakeEngine, makeDiscovery, makeIO, makeStore, makeSummary, tmpDir, writeFile } from './helpers.ts'

const USAGE = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 }

const SAMPLE_EVENTS: RunEvent[] = [
  ev('run_start', { runId: 'wf_aaaaaaaa-111', name: 'demo', description: 'Showcase', args: null, cwd: '/p', scriptPath: '/p/demo.ts', resumed: false, phases: [] }),
  ev('phase', { title: 'Scan', workflowPath: ['demo'] }),
  ev('agent_start', { id: 1, label: 'scan', phase: 'Scan', workflowPath: ['demo'], promptPreview: 'p' }),
  ev('agent_done', { id: 1, ok: true, cached: false, durationMs: 1500, usage: USAGE, costUsd: 0.002, toolCalls: 0 }),
  { t: 'run_end', ts: T0, status: 'completed', durationMs: 65_000, totals: makeSummary().totals },
]

describe('run: output and exit codes', () => {
  it('completed: stdout = JSON result, stderr = progress + summary, exit 0', async () => {
    const cap = makeIO({ cwd: '/proj' })
    const eng = fakeEngine(makeSummary({ result: { files: ['a', 'b'], n: 2 } }), SAMPLE_EVENTS)
    const code = await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow })
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(cap.out()), { files: ['a', 'b'], n: 2 })
    assert.equal(cap.out(), '{"files":["a","b"],"n":2}\n', 'outside a TTY compact JSON and nothing else on stdout')
    const err = cap.err()
    assert.match(err, /ultracode wf_aaaaaaaa-111 {2}demo/)
    assert.match(err, /== Phase: Scan/)
    assert.match(err, /#1 done {4}scan {2}1\.5 s/)
    assert.match(err, /-- Summary --/)
    assert.match(err, /Status: {3}completed/)
    assert.doesNotMatch(err, /== End:/, 'run_end is replaced by the summary, not printed twice')
    assert.ok(!cap.out().includes('Summary'))
  })

  it('stdout on a TTY is indented JSON', async () => {
    const cap = makeIO({ isTTY: true, stdoutIsTTY: true })
    const eng = fakeEngine(makeSummary({ result: { a: 1 } }))
    await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow })
    assert.equal(cap.out(), '{\n  "a": 1\n}\n')
  })

  it('--json: whole RunSummary on stdout', async () => {
    const cap = makeIO()
    const summary = makeSummary({ result: [1, 2] })
    const eng = fakeEngine(summary)
    const code = await main(['run', 'demo', '--json'], cap.io, { runWorkflow: eng.runWorkflow })
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(cap.out()), JSON.parse(JSON.stringify(summary)))
  })

  it('completed without a result → null', async () => {
    const cap = makeIO()
    const eng = fakeEngine(makeSummary())
    assert.equal(await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow }), 0)
    assert.equal(cap.out(), 'null\n')
  })

  it('failed: exit 1, stdout empty, error on stderr', async () => {
    const cap = makeIO()
    const eng = fakeEngine(makeSummary({ status: 'failed', error: 'Script: TypeError x', result: undefined }))
    const code = await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow })
    assert.equal(code, 1)
    assert.equal(cap.out(), '')
    assert.match(cap.err(), /Error: {4}Script: TypeError x/)
  })

  it('failed with --json still prints the summary to stdout', async () => {
    const cap = makeIO()
    const eng = fakeEngine(makeSummary({ status: 'failed', error: 'x' }))
    const code = await main(['run', 'demo', '--json'], cap.io, { runWorkflow: eng.runWorkflow })
    assert.equal(code, 1)
    assert.equal(JSON.parse(cap.out()).status, 'failed')
  })

  it('aborted → 130', async () => {
    const cap = makeIO()
    const eng = fakeEngine(makeSummary({ status: 'aborted', error: 'Run was aborted.' }))
    assert.equal(await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow }), 130)
    assert.equal(cap.out(), '')
  })

  it('--quiet suppresses progress and summary, but not errors', async () => {
    const ok = makeIO()
    const engOk = fakeEngine(makeSummary({ result: 7 }), SAMPLE_EVENTS)
    assert.equal(await main(['run', 'demo', '--quiet'], ok.io, { runWorkflow: engOk.runWorkflow }), 0)
    assert.equal(ok.err(), '')
    assert.equal(ok.out(), '7\n')

    const bad = makeIO()
    const engBad = fakeEngine(makeSummary({ status: 'failed', error: 'it failed' }), SAMPLE_EVENTS)
    assert.equal(await main(['run', 'demo', '-q'], bad.io, { runWorkflow: engBad.runWorkflow }), 1)
    assert.match(bad.err(), /it failed/)
    assert.doesNotMatch(bad.err(), /Phase/)
  })

  it('exceeded budget is reported in the summary', async () => {
    const cap = makeIO()
    const eng = fakeEngine(makeSummary({ budgetExceeded: true, result: 1 }))
    assert.equal(await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow }), 0)
    assert.match(cap.err(), /budget exceeded/)
  })
})

describe('run: colors', () => {
  const run = async (opts: Parameters<typeof makeIO>[0], extra: string[] = []) => {
    const cap = makeIO(opts)
    const eng = fakeEngine(makeSummary({ result: 1 }), SAMPLE_EVENTS)
    await main(['run', 'demo', ...extra], cap.io, { runWorkflow: eng.runWorkflow })
    return cap
  }
  it('on a TTY colors appear only on stderr', async () => {
    const cap = await run({ isTTY: true })
    assert.match(cap.err(), /\u001b\[/)
    assert.ok(!cap.out().includes('\u001b['))
  })
  it('without a TTY, with NO_COLOR and with --no-color there are no colors', async () => {
    assert.doesNotMatch((await run({ isTTY: false })).err(), /\u001b\[/)
    assert.doesNotMatch((await run({ isTTY: true, env: { NO_COLOR: '1' } })).err(), /\u001b\[/)
    assert.doesNotMatch((await run({ isTTY: true }, ['--no-color'])).err(), /\u001b\[/)
    assert.doesNotMatch((await run({ isTTY: true, env: { TERM: 'dumb' } })).err(), /\u001b\[/)
  })
})

describe('run: mapping of options to RunOptions', () => {
  it('all options are passed to the engine', async () => {
    const cwd = tmpDir()
    const cap = makeIO({ cwd: '/elsewhere' })
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

  it('without options no extra keys are passed (args stays undefined)', async () => {
    const cap = makeIO({ cwd: '/proj' })
    const eng = fakeEngine(makeSummary({ result: 1 }))
    await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow })
    const o = eng.calls[0]
    assert.ok(!('args' in o))
    assert.ok(!('model' in o))
    assert.ok(!('concurrency' in o))
    assert.equal(o.cwd, '/proj')
  })

  it('--args may be a scalar / null / array', async () => {
    for (const [raw, expected] of [['null', null], ['"txt"', 'txt'], ['[1,2]', [1, 2]], ['42', 42]] as const) {
      const eng = fakeEngine(makeSummary({ result: 1 }))
      await main(['run', 'demo', '--args', raw], makeIO().io, { runWorkflow: eng.runWorkflow })
      assert.deepEqual(eng.calls[0].args, expected)
      assert.ok('args' in eng.calls[0])
    }
  })

  it('--args-file loads JSON relative to the process cwd', async () => {
    const dir = tmpDir()
    writeFile(join(dir, 'in.json'), '{"x":[1,2,3]}')
    const eng = fakeEngine(makeSummary({ result: 1 }))
    const code = await main(['run', 'demo', '--args-file', 'in.json'], makeIO({ cwd: dir }).io, { runWorkflow: eng.runWorkflow })
    assert.equal(code, 0)
    assert.deepEqual(eng.calls[0].args, { x: [1, 2, 3] })
  })

  it('script path is made absolute relative to the process cwd (not --cwd)', async () => {
    const dir = tmpDir()
    const proj = tmpDir()
    writeFile(join(dir, 'sub', 'my.workflow.ts'), 'x')
    const eng = fakeEngine(makeSummary({ result: 1 }))
    await main(['run', './sub/my.workflow.ts', '--cwd', proj], makeIO({ cwd: dir }).io, { runWorkflow: eng.runWorkflow })
    assert.equal(eng.calls[0].workflow, join(dir, 'sub', 'my.workflow.ts'))
    assert.equal(eng.calls[0].cwd, proj)
  })

  it('workflow name is passed unchanged', async () => {
    const eng = fakeEngine(makeSummary({ result: 1 }))
    await main(['run', 'php8-upgrade'], makeIO().io, { runWorkflow: eng.runWorkflow })
    assert.equal(eng.calls[0].workflow, 'php8-upgrade')
  })
})

describe('run: invalid usage (exit 2, engine is not called)', () => {
  const expectUsage = async (argv: string[], pattern: RegExp, extra: Parameters<typeof makeIO>[0] = {}) => {
    const cap = makeIO(extra)
    const eng = fakeEngine(makeSummary())
    const code = await main(argv, cap.io, { runWorkflow: eng.runWorkflow, store: makeStore([]) })
    assert.equal(code, 2, `argv=${JSON.stringify(argv)} stderr=${cap.err()}`)
    assert.match(cap.err(), pattern)
    assert.equal(cap.out(), '')
    assert.equal(eng.calls.length, 0, 'engine must not be called')
  }

  it('invalid JSON in --args', async () => {
    await expectUsage(['run', 'demo', '--args', '{nope'], /Value of --args is not valid JSON/)
  })
  it('--args and --args-file together', async () => {
    await expectUsage(['run', 'demo', '--args', '{}', '--args-file', 'x.json'], /cannot be used together/)
  })
  it('--args-file does not exist / is not JSON', async () => {
    const dir = tmpDir()
    await expectUsage(['run', 'demo', '--args-file', 'missing.json'], /cannot be read/, { cwd: dir })
    writeFile(join(dir, 'bad.json'), '{oops')
    await expectUsage(['run', 'demo', '--args-file', 'bad.json'], /does not contain valid JSON/, { cwd: dir })
  })
  it('missing workflow', async () => {
    await expectUsage(['run'], /Missing workflow/)
  })
  it('too many arguments', async () => {
    await expectUsage(['run', 'a', 'b'], /takes a single argument/)
  })
  it('invalid numeric options and effort', async () => {
    await expectUsage(['run', 'demo', '--concurrency', '0'], /--concurrency/)
    await expectUsage(['run', 'demo', '--max-usd', 'lots'], /--max-usd/)
    await expectUsage(['run', 'demo', '--max-tokens', '-5'], /--max-tokens|ambiguous/)
    await expectUsage(['run', 'demo', '--effort', 'turbo'], /--effort/)
  })
  it('unknown option', async () => {
    await expectUsage(['run', 'demo', '--fast'], /Unknown option --fast/)
  })
  it('non-existent --cwd', async () => {
    await expectUsage(['run', 'demo', '--cwd', '/does/not/exist/at/all'], /--cwd/)
  })
  it('non-existent script file', async () => {
    await expectUsage(['run', './nothing.workflow.ts'], /does not exist/, { cwd: tmpDir() })
  })
  it('dangerous --run-id', async () => {
    await expectUsage(['run', 'demo', '--run-id', '../evil'], /Invalid --run-id/)
  })
})

describe('run: engine errors', () => {
  it('ScriptValidationError → exit 2 with diagnostics', async () => {
    const cap = makeIO()
    const eng = fakeEngine(() => {
      throw new ScriptValidationError('Script is invalid', ['line 3: meta missing', 'line 9: import()'])
    })
    const code = await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow })
    assert.equal(code, 2)
    assert.match(cap.err(), /Invalid script: Script is invalid/)
    assert.match(cap.err(), /- line 3: meta missing/)
    assert.match(cap.err(), /- line 9: import\(\)/)
    assert.equal(cap.out(), '')
  })

  it('WorkflowNotFoundError → exit 2', async () => {
    const cap = makeIO()
    const eng = fakeEngine(() => {
      throw new WorkflowNotFoundError('nothing', ['/a', '/b'])
    })
    assert.equal(await main(['run', 'nothing'], cap.io, { runWorkflow: eng.runWorkflow }), 2)
    assert.match(cap.err(), /not found/)
    assert.match(cap.err(), /\/a, \/b/)
  })

  it('AbortedError → 130', async () => {
    const cap = makeIO()
    const eng = fakeEngine(() => {
      throw new AbortedError()
    })
    assert.equal(await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow }), 130)
  })

  it('unexpected exception → exit 1, not a crash', async () => {
    const cap = makeIO()
    const eng = fakeEngine(() => {
      throw new Error('kaboom')
    })
    assert.equal(await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow }), 1)
    assert.match(cap.err(), /unexpected error:[\s\S]*kaboom/)
  })

  it('a faulty onEvent renderer must not crash the run (exception in an event)', async () => {
    const cap = makeIO()
    const bad = { t: 'agent_done', ts: T0, id: 1, ok: true, cached: false, durationMs: 1, costUsd: 0, toolCalls: 0 } as unknown as RunEvent
    const eng = fakeEngine(makeSummary({ result: 1 }), [bad])
    assert.equal(await main(['run', 'demo'], cap.io, { runWorkflow: eng.runWorkflow }), 0)
  })
})

describe('resume', () => {
  const prev = makeSummary({ runId: 'wf_prev0001-abc', status: 'failed' })

  it('resume <runId> → empty workflow + resumeRunId, args are not passed', async () => {
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

  it('resume takes over the same options (--args, --max-usd, --concurrency)', async () => {
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

  it('run <wf> --resume <id> keeps the workflow and fills in resumeRunId', async () => {
    const eng = fakeEngine(makeSummary({ result: 1 }))
    await main(['run', 'demo', '--resume', 'wf_prev0001-abc'], makeIO().io, {
      runWorkflow: eng.runWorkflow,
      store: makeStore([{ summary: prev }]),
    })
    assert.equal(eng.calls[0].workflow, 'demo')
    assert.equal(eng.calls[0].resumeRunId, 'wf_prev0001-abc')
  })

  it('run --resume <id> without a workflow is allowed', async () => {
    const eng = fakeEngine(makeSummary({ result: 1 }))
    const code = await main(['run', '--resume', 'wf_prev0001-abc'], makeIO().io, {
      runWorkflow: eng.runWorkflow,
      store: makeStore([{ summary: prev }]),
    })
    assert.equal(code, 0)
    assert.equal(eng.calls[0].workflow, '')
  })

  it('non-existent run → exit 2, engine is not called', async () => {
    const cap = makeIO()
    const eng = fakeEngine(makeSummary())
    const code = await main(['resume', 'wf_nope'], cap.io, { runWorkflow: eng.runWorkflow, store: makeStore([]) })
    assert.equal(code, 2)
    assert.match(cap.err(), /Run "wf_nope" not found/)
    assert.equal(eng.calls.length, 0)
  })

  it('missing / surplus runId, conflict with --resume', async () => {
    for (const argv of [['resume'], ['resume', 'a', 'b'], ['resume', 'wf_prev0001-abc', '--resume', 'other']]) {
      const eng = fakeEngine(makeSummary())
      const cap = makeIO()
      const code = await main(argv, cap.io, { runWorkflow: eng.runWorkflow, store: makeStore([{ summary: prev }]) })
      assert.equal(code, 2, argv.join(' '))
      assert.equal(eng.calls.length, 0)
    }
  })

  it('run in state running → warning, but continues', async () => {
    const cap = makeIO()
    const eng = fakeEngine(makeSummary({ result: 1 }))
    const code = await main(['resume', 'wf_prev0001-abc'], cap.io, {
      runWorkflow: eng.runWorkflow,
      store: makeStore([{ summary: makeSummary({ runId: 'wf_prev0001-abc', status: 'running' }) }]),
    })
    assert.equal(code, 0)
    assert.match(cap.err(), /Warning: run wf_prev0001-abc is still in state running according to run\.json/)
  })

  it('progress of the resumed run is rendered as a continuation', async () => {
    const cap = makeIO()
    const start = ev('run_start', { runId: 'wf_prev0001-abc', name: 'demo', description: '', args: null, cwd: '/', scriptPath: '/s', resumed: true, phases: [] })
    const eng = fakeEngine(makeSummary({ result: 1 }), [start])
    await main(['resume', 'wf_prev0001-abc'], cap.io, { runWorkflow: eng.runWorkflow, store: makeStore([{ summary: prev }]) })
    assert.match(cap.err(), /\(resumed\)/)
  })
})

describe('dispatcher', () => {
  it('main never calls process.exit and does not throw (unknown command)', async () => {
    const cap = makeIO()
    const code = await main(['frobnicate'], cap.io, {})
    assert.equal(code, 2)
    assert.match(cap.err(), /unknown command "frobnicate"/)
  })

  it('fake discovery is compatible (helper check)', () => {
    assert.throws(() => makeDiscovery().findWorkflow('x', '/'), /not found/)
  })
})
