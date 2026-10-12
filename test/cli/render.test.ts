import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  formatAge,
  formatCount,
  formatDuration,
  formatTable,
  formatUsd,
  makeStyle,
  plural,
  stripAnsi,
} from '../../src/cli/format.ts'
import {
  createRenderState,
  digestEvents,
  renderEvent,
  renderRunList,
  renderStatus,
  renderSummary,
} from '../../src/cli/render.ts'
import type { RunEvent } from '../../src/types.ts'
import { ev, makeSummary } from './helpers.ts'

const plain = makeStyle(false)
const USAGE = { inputTokens: 1200, outputTokens: 345, cacheReadTokens: 0, cacheCreationTokens: 0 }

function renderAll(events: RunEvent[], opts: { timestamps?: boolean; verbose?: boolean } = {}): string[] {
  const state = createRenderState()
  return events.flatMap((e) => renderEvent(e, state, { style: plain, ...opts }))
}

describe('formatting helpers', () => {
  it('formatDuration', () => {
    assert.equal(formatDuration(0), '0 ms')
    assert.equal(formatDuration(250), '250 ms')
    assert.equal(formatDuration(12_300), '12.3 s')
    assert.equal(formatDuration(65_000), '1m05s')
    assert.equal(formatDuration(3_720_000), '1h02m')
    assert.equal(formatDuration(-5), '0 ms')
    assert.equal(formatDuration(Number.NaN), '0 ms')
  })

  it('formatCount and formatUsd', () => {
    assert.equal(formatCount(950), '950')
    assert.equal(formatCount(1200), '1.2k')
    assert.equal(formatCount(2000), '2k')
    assert.equal(formatCount(3_400_000), '3.4M')
    assert.equal(formatUsd(0), '$0.00')
    assert.equal(formatUsd(0.0123), '$0.0123')
    assert.equal(formatUsd(12.345), '$12.35')
  })

  it('plural and formatAge', () => {
    assert.equal(plural(1, 'agent', 'agents', 'agents'), 'agent')
    assert.equal(plural(3, 'agent', 'agents', 'agents'), 'agents')
    assert.equal(plural(0, 'agent', 'agents', 'agents'), 'agents')
    assert.equal(plural(11, 'agent', 'agents', 'agents'), 'agents')
    assert.equal(formatAge(5_000), '5 s ago')
    assert.equal(formatAge(3 * 60_000), '3 min ago')
    assert.equal(formatAge(5 * 3_600_000), '5 h ago')
    assert.equal(formatAge(3 * 86_400_000), '3 days ago')
  })

  it('makeStyle(false) emits no escape sequences, makeStyle(true) does', () => {
    assert.equal(makeStyle(false).red('x'), 'x')
    const on = makeStyle(true).red('x')
    assert.match(on, /\u001b\[31mx\u001b\[39m/)
    assert.equal(stripAnsi(on), 'x')
  })

  it('formatTable aligns by visible width (ANSI is not counted)', () => {
    const s = makeStyle(true)
    const rows = formatTable([
      [s.green('a'), 'x'],
      ['bbbb', 'y'],
    ])
    assert.deepEqual(rows.map(stripAnsi), ['a     x', 'bbbb  y'])
  })
})

describe('renderEvent (snapshots without colors)', () => {
  it('typical run progress', () => {
    const events: RunEvent[] = [
      ev('run_start', { runId: 'wf_1', name: 'demo', description: 'Showcase', args: { a: 1 }, cwd: '/p', scriptPath: '/p/demo.ts', resumed: false, phases: [] }),
      ev('phase', { title: 'Scan', workflowPath: ['demo'] }),
      ev('log', { message: 'Found 3 files', workflowPath: ['demo'] }),
      ev('agent_start', { id: 1, label: 'scan-a', phase: 'Scan', workflowPath: ['demo'], promptPreview: 'Scan…' }),
      ev('agent_tool', { id: 1, tool: 'Read' }),
      ev('agent_retry', { id: 1, attempt: 2, reason: 'stall 600 s' }),
      ev('agent_done', { id: 1, ok: true, cached: false, durationMs: 12_300, usage: USAGE, costUsd: 0.0123, toolCalls: 3 }),
      ev('agent_start', { id: 2, label: 'scan-b', phase: 'Scan', workflowPath: ['demo'], promptPreview: 'x' }),
      ev('agent_done', { id: 2, ok: true, cached: true, durationMs: 1, usage: USAGE, costUsd: 0, toolCalls: 0 }),
      ev('agent_start', { id: 3, label: 'scan-c', phase: 'Scan', workflowPath: ['demo'], promptPreview: 'x', model: 'haiku' }),
      ev('agent_done', { id: 3, ok: false, cached: false, durationMs: 5000, usage: USAGE, costUsd: 0.5, toolCalls: 1, error: 'exit 1: boom' }),
      ev('budget', { spentOutputTokens: 1200, spentUsd: 0.5, limitOutputTokens: 5000, limitUsd: 2 }),
    ]
    assert.deepEqual(renderAll(events), [
      'ultracode wf_1  demo',
      '  Showcase',
      '== Phase: Scan',
      '[log] Found 3 files',
      '  #1 start   scan-a',
      '  #1 retry   attempt 2: stall 600 s',
      '  #1 done    scan-a  12.3 s  in 1.2k out 345  $0.0123  3 tools',
      '  #2 start   scan-b',
      '  #2 cache   scan-b',
      '  #3 start   scan-c  [haiku]',
      '  #3 FAILED  scan-c  5.0 s  $0.5000',
      '         exit 1: boom',
      '  budget: 1.2k / 5k output tokens (24 %)  |  $0.5000 / $2.00',
    ])
  })

  it('verbose adds tools and prompt preview, timestamps show the hour from ts', () => {
    const events: RunEvent[] = [
      { t: 'agent_start', ts: '2026-01-01T10:05:09.000Z', id: 1, label: 'a', phase: null, workflowPath: ['w'], promptPreview: 'Do X\nread Y' },
      { t: 'agent_tool', ts: '2026-01-01T10:05:10.000Z', id: 1, tool: 'Grep' },
    ]
    assert.deepEqual(renderAll(events, { verbose: true, timestamps: true }), [
      '[10:05:09]   #1 start   a',
      '[10:05:09]          Do X read Y',
      '[10:05:10]   #1 tool  Grep',
    ])
    assert.deepEqual(renderAll(events), ['  #1 start   a'])
  })

  it('nested workflow is indented and marks entry/exit', () => {
    const events: RunEvent[] = [
      ev('workflow_enter', { name: 'child', workflowPath: ['parent', 'child'] }),
      ev('phase', { title: 'Sub', workflowPath: ['parent', 'child'] }),
      ev('agent_start', { id: 1, label: 'x', phase: 'Sub', workflowPath: ['parent', 'child'], promptPreview: '' }),
      ev('workflow_exit', { name: 'child', workflowPath: ['parent', 'child'] }),
    ]
    assert.deepEqual(renderAll(events), [
      '  >> nested workflow: child',
      '  == Phase: Sub',
      '    #1 start   x',
      '  << end of nested workflow: child',
    ])
  })

  it('multi-line log is aligned; budget without limits is not printed', () => {
    const lines = renderAll([
      ev('log', { message: 'a\nb', workflowPath: ['w'] }),
      ev('budget', { spentOutputTokens: 5, spentUsd: 0, limitOutputTokens: null, limitUsd: null }),
    ])
    assert.deepEqual(lines, ['[log] a', '      b'])
  })

  it('resume and run_end', () => {
    const lines = renderAll([
      ev('run_start', { runId: 'wf_2', name: 'demo', description: '', args: null, cwd: '/', scriptPath: '/s', resumed: true, phases: [] }),
      ev('run_end', {
        status: 'failed',
        durationMs: 65_000,
        totals: makeSummary().totals,
        error: 'Budget exceeded',
      }),
    ])
    assert.deepEqual(lines, [
      'ultracode wf_2  demo  (resumed)',
      '== End: failed  1m05s  3 agents  $0.0421',
      '   Budget exceeded',
    ])
  })

  it('with colors the output contains escape sequences, without them it does not', () => {
    const e = ev('agent_done', { id: 1, ok: false, cached: false, durationMs: 1, usage: USAGE, costUsd: 0, toolCalls: 0, error: 'x' })
    const colored = renderEvent(e, createRenderState(), { style: makeStyle(true) })
    assert.ok(colored.join('\n').includes('\u001b['))
    const plainOut = renderEvent(e, createRenderState(), { style: plain })
    assert.ok(!plainOut.join('\n').includes('\u001b['))
  })

  it('agent_done without a previous start does not crash (uses a fallback label)', () => {
    const lines = renderAll([ev('agent_done', { id: 9, ok: true, cached: false, durationMs: 100, usage: USAGE, costUsd: 0.001, toolCalls: 0 })])
    assert.equal(lines.length, 1)
    assert.match(lines[0], /#9 done {4}agent 9/)
  })
})

describe('renderSummary', () => {
  it('successful run', () => {
    assert.deepEqual(renderSummary(makeSummary(), plain), [
      '-- Summary --',
      'Run:      wf_aaaaaaaa-111  demo',
      'Status:   completed',
      'Duration: 1m05s',
      'Agents:   3 agents (from cache 1)',
      'Tools:    7',
      'Tokens:   in 1.5k, out 2.5k, cache read 10k, cache write 500',
      'Cost:     $0.0421',
      'Folder:   /proj/.ultracode/runs/wf_aaaaaaaa-111',
    ])
  })

  it('failed run with an error and an exceeded budget', () => {
    const s = makeSummary({
      status: 'failed',
      error: 'Script threw an error',
      budgetExceeded: true,
    })
    s.totals.failedAgents = 2
    const lines = renderSummary(s, plain)
    assert.ok(lines.includes('Status:   failed  (budget exceeded)'))
    assert.ok(lines.includes('Agents:   3 agents (from cache 1, failed 2)'))
    assert.ok(lines.includes('Error:    Script threw an error'))
  })
})

describe('digestEvents + renderStatus', () => {
  const events: RunEvent[] = [
    ev('run_start', { runId: 'wf_1', name: 'demo', description: '', args: null, cwd: '/', scriptPath: '/s', resumed: false, phases: [{ title: 'Scan' }, { title: 'Fix' }] }),
    ev('phase', { title: 'Scan', workflowPath: ['demo'] }),
    ev('agent_start', { id: 1, label: 'a', phase: null, workflowPath: ['demo'], promptPreview: '' }),
    ev('agent_retry', { id: 1, attempt: 2, reason: 'x' }),
    ev('agent_done', { id: 1, ok: true, cached: false, durationMs: 2000, usage: USAGE, costUsd: 0.01, toolCalls: 1 }),
    ev('phase', { title: 'Fix', workflowPath: ['demo'] }),
    ev('agent_start', { id: 2, label: 'b', phase: 'Fix', workflowPath: ['demo'], promptPreview: '' }),
    ev('agent_start', { id: 3, label: 'c', phase: 'Fix', workflowPath: ['demo'], promptPreview: '' }),
    ev('agent_done', { id: 3, ok: false, cached: false, durationMs: 100, usage: USAGE, costUsd: 0, toolCalls: 0, error: 'error c' }),
    ev('log', { message: 'hello', workflowPath: ['demo'] }),
  ]

  it('digest: agents, phases, current phase, retries', () => {
    const d = digestEvents(events)
    assert.deepEqual(d.agents.map((a) => [a.id, a.state, a.phase, a.retries]), [
      [1, 'done', 'Scan', 1],
      [2, 'running', 'Fix', 0],
      [3, 'failed', 'Fix', 0],
    ])
    assert.deepEqual(d.phases, [
      { title: 'Scan', agents: 1 },
      { title: 'Fix', agents: 2 },
    ])
    assert.equal(d.currentPhase, 'Fix')
    assert.equal(d.ended, false)
    assert.deepEqual(d.logs, ['hello'])
  })

  it('digest: resume appends after an old run_end – after a new run_start the run is no longer ended', () => {
    const resumed = [
      ...events,
      ev('run_end', { status: 'aborted', durationMs: 10, totals: makeSummary().totals }),
    ]
    assert.equal(digestEvents(resumed).ended, true)
    const again = [
      ...resumed,
      ev('run_start', { runId: 'wf_1', name: 'demo', description: '', args: null, cwd: '/', scriptPath: '/s', resumed: true, phases: [{ title: 'Scan' }, { title: 'Fix' }] }),
      ev('phase', { title: 'Fix', workflowPath: ['demo'] }),
    ]
    const d = digestEvents(again)
    assert.equal(d.ended, false)
    const lines = renderStatus({
      summary: makeSummary({ status: 'running', durationMs: 0 }),
      digest: d,
      nowMs: Date.parse('2026-01-01T10:02:00.000Z'),
      style: plain,
    })
    assert.ok(lines.some((l) => l.startsWith('  > Fix')), lines.join('\n'))
  })

  it('status of a running run: duration from nowMs, active phase, agents table', () => {
    const summary = makeSummary({ status: 'running', durationMs: 0, startedAt: '2026-01-01T10:00:00.000Z' })
    const lines = renderStatus({
      summary,
      digest: digestEvents(events),
      nowMs: Date.parse('2026-01-01T10:02:00.000Z'),
      style: plain,
    })
    assert.deepEqual(lines, [
      'Run wf_aaaaaaaa-111  demo',
      'Status:   running',
      'Duration: 2m00s (running)',
      'Script:   /proj/.ultracode/workflows/demo.workflow.ts',
      'Folder:   /proj/.ultracode/runs/wf_aaaaaaaa-111',
      '',
      'Phases:',
      '    Scan  1 agent',
      '  > Fix  2 agents',
      '',
      'Agents:',
      '  #1  done     a  2.0 s  $0.0100  retry 1x',
      '  #2  running  b',
      '  #3  FAILED   c  100 ms  $0.00  error c',
      '',
      'Totals:',
      '  Agents:   3 agents (from cache 1)',
      '  Tools:    7',
      '  Tokens:   in 1.5k, out 2.5k, cache read 10k, cache write 500',
      '  Cost:     $0.0421',
    ])
  })

  it('status of a completed run shows the result', () => {
    const lines = renderStatus({
      summary: makeSummary({ result: { ok: true } }),
      digest: digestEvents([]),
      nowMs: 0,
      style: plain,
    })
    assert.ok(lines.includes('Result:   {"ok":true}'))
  })
})

describe('renderRunList', () => {
  it('table of runs', () => {
    const now = Date.parse('2026-01-01T10:10:00.000Z')
    const lines = renderRunList(
      [makeSummary(), makeSummary({ runId: 'wf_bbbbbbbb-222', name: 'other', status: 'failed', startedAt: '2026-01-01T09:00:00.000Z' })],
      now,
      plain,
    )
    assert.deepEqual(lines, [
      '  ID               WORKFLOW  STATUS     AGE         AGENTS  COST',
      '  wf_aaaaaaaa-111  demo      completed  10 min ago  3       $0.0421',
      '  wf_bbbbbbbb-222  other     failed     1 h ago     3       $0.0421',
    ])
    assert.deepEqual(renderRunList([], now, plain), [])
  })
})
