import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { runWorkflow } from '../../src/engine/engine.ts'
import { isSafeRunId, listRuns, readEvents, readRunSummary, runsRoot } from '../../src/engine/store.ts'
import { makeProject, makeRunner, scriptDeps, sleep } from './helpers.ts'

function writeRun(cwd: string, runId: string, files: Record<string, string>): string {
  const dir = join(runsRoot(cwd), runId)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

function runJson(runId: string, startedAt: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    runId,
    name: 'n-' + runId,
    status: 'completed',
    startedAt,
    endedAt: startedAt,
    durationMs: 5,
    runDir: '/x',
    scriptPath: '/x/s.ts',
    totals: { agents: 1, cachedAgents: 0, failedAgents: 0, toolCalls: 0, usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 }, costUsd: 0.1 },
    ...extra,
  })
}

describe('store', () => {
  test('runsRoot and safe IDs', () => {
    assert.equal(runsRoot('/a/b'), '/a/b/.ultracode/runs')
    assert.ok(isSafeRunId('wf_003aa2c5-8ce'))
    for (const bad of ['', '..', '../x', 'a/b', '.hidden', 'a b']) assert.equal(isSafeRunId(bad), false, bad)
  })

  test('listRuns: newest first, resilient to a corrupt run.json and foreign files', () => {
    const p = makeProject()
    try {
      writeRun(p.cwd, 'wf_aaaaaaaa-001', { 'run.json': runJson('wf_aaaaaaaa-001', '2026-01-01T10:00:00.000Z') })
      writeRun(p.cwd, 'wf_bbbbbbbb-002', { 'run.json': runJson('wf_bbbbbbbb-002', '2026-01-03T10:00:00.000Z', { status: 'failed', error: 'x' }) })
      writeRun(p.cwd, 'wf_cccccccc-003', { 'run.json': runJson('wf_cccccccc-003', '2026-01-02T10:00:00.000Z', { result: { a: 1 }, budgetExceeded: true }) })
      writeRun(p.cwd, 'wf_corrupt0-004', { 'run.json': '{"runId": "wf_corru' }) // truncated JSON, no events
      writeRun(p.cwd, 'wf_empty000-005', {})
      writeRun(p.cwd, 'wf_badshape-006', { 'run.json': JSON.stringify({ hello: 'world' }) })
      writeFileSync(join(runsRoot(p.cwd), 'stray-file.txt'), 'x')

      const runs = listRuns(p.cwd)
      assert.deepEqual(runs.map((r) => r.runId), ['wf_bbbbbbbb-002', 'wf_cccccccc-003', 'wf_aaaaaaaa-001'])
      assert.equal(runs[0].status, 'failed')
      assert.equal(runs[0].error, 'x')
      assert.deepEqual(runs[1].result, { a: 1 })
      assert.equal(runs[1].budgetExceeded, true)
      assert.equal(runs[2].totals.usage.outputTokens, 2)
    } finally {
      p.cleanup()
    }
  })

  test('listRuns on a non-existent directory returns []', () => {
    const p = makeProject()
    try {
      assert.deepEqual(listRuns(p.cwd), [])
      assert.equal(readRunSummary(p.cwd, 'wf_nic-000'), null)
      assert.deepEqual(readEvents(p.cwd, 'wf_nic-000'), [])
    } finally {
      p.cleanup()
    }
  })

  test('a corrupt run.json is reconstructed from events.jsonl (run_start/run_end)', () => {
    const p = makeProject()
    try {
      const start = { t: 'run_start', ts: '2026-02-01T00:00:00.000Z', runId: 'wf_rec00000-001', name: 'rec', description: '', args: null, cwd: '/c', scriptPath: '/c/s.ts', resumed: false, phases: [] }
      const end = { t: 'run_end', ts: '2026-02-01T00:00:09.000Z', status: 'failed', durationMs: 9000, totals: { agents: 2, cachedAgents: 0, failedAgents: 1, toolCalls: 0, usage: { inputTokens: 0, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0 }, costUsd: 1 }, error: 'bum' }
      writeRun(p.cwd, 'wf_rec00000-001', { 'run.json': 'garbage', 'events.jsonl': JSON.stringify(start) + '\n' + JSON.stringify(end) + '\n' })
      writeRun(p.cwd, 'wf_run00000-002', { 'events.jsonl': JSON.stringify({ ...start, runId: 'wf_run00000-002', ts: '2026-02-02T00:00:00.000Z' }) + '\n' })
      const runs = listRuns(p.cwd)
      assert.deepEqual(runs.map((r) => r.runId), ['wf_run00000-002', 'wf_rec00000-001'])
      assert.equal(runs[1].status, 'failed')
      assert.equal(runs[1].error, 'bum')
      assert.equal(runs[1].totals.usage.outputTokens, 7)
      // without run_end and without a live lock holder it is a forcibly terminated (aborted) run, not a running one
      assert.equal(runs[0].status, 'aborted')
      assert.match(runs[0].error ?? '', /no longer running/)
      // with the lock of a live process (ours) it really is a running run
      writeFileSync(join(p.cwd, '.ultracode', 'runs', 'wf_run00000-002', '.lock'), JSON.stringify({ pid: process.pid, ts: 'x' }))
      assert.equal(readRunSummary(p.cwd, 'wf_run00000-002')?.status, 'running')
      // a dead process lock does not change it
      writeFileSync(join(p.cwd, '.ultracode', 'runs', 'wf_run00000-002', '.lock'), JSON.stringify({ pid: 2 ** 22 + 999, ts: 'x' }))
      assert.equal(readRunSummary(p.cwd, 'wf_run00000-002')?.status, 'aborted')
    } finally {
      p.cleanup()
    }
  })

  test('readEvents skips unreadable lines and keeps order; readRunSummary rejects paths outside runs/', () => {
    const p = makeProject()
    try {
      writeRun(p.cwd, 'wf_ev000000-001', {
        'events.jsonl': ['{"t":"log","ts":"1","message":"a","workflowPath":[]}', 'this is not json', '{"nope":1}', '{"t":"phase","ts":"2","title":"T","workflowPath":[]}', '{"t":"log","ts":"3","mess'].join('\n'),
      })
      const ev = readEvents(p.cwd, 'wf_ev000000-001')
      assert.deepEqual(ev.map((e) => e.t), ['log', 'phase'])
      writeFileSync(join(p.cwd, 'run.json'), runJson('x', '2026-01-01T00:00:00.000Z'))
      assert.equal(readRunSummary(p.cwd, '../../run.json'), null)
      assert.deepEqual(readEvents(p.cwd, '../x'), [])
    } finally {
      p.cleanup()
    }
  })

  test('listRuns on real runs: order by startedAt and match with the return value', async () => {
    const p = makeProject()
    try {
      const deps = scriptDeps(async (api) => api.agent('x'))
      const a = await runWorkflow({ workflow: p.script(), cwd: p.cwd, runner: makeRunner().runner }, deps)
      await sleep(5)
      const b = await runWorkflow({ workflow: p.script(), cwd: p.cwd, runner: makeRunner().runner }, deps)
      await sleep(5)
      const c = await runWorkflow({ workflow: p.script(), cwd: p.cwd, runner: makeRunner({ fail: () => 'x' }).runner }, deps)
      const runs = listRuns(p.cwd)
      assert.deepEqual(runs.map((r) => r.runId), [c.runId, b.runId, a.runId])
      assert.deepEqual(runs[2], JSON.parse(JSON.stringify(a)))
      assert.equal(runs[0].totals.failedAgents, 1)
    } finally {
      p.cleanup()
    }
  })
})
