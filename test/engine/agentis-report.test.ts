import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createAgentisReporter, normalizeAgentisEndpoint } from '../../src/engine/agentis-report.ts'
import { runWorkflow } from '../../src/engine/engine.ts'
import { makeProject, makeRunner, scriptDeps } from './helpers.ts'

function fakeFetch(fail = false) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
    if (fail) return new Response('nope', { status: 500 })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), { status: 200 })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe('agentis workflow reporter', () => {
  test('endpoint normalization', () => {
    assert.equal(normalizeAgentisEndpoint('https://a.local/'), 'https://a.local/api')
    assert.equal(normalizeAgentisEndpoint('https://a.local/api/'), 'https://a.local/api')
  })

  test('the run reports its phases, agents and final status as one workflow item', async () => {
    const p = makeProject()
    try {
      const { calls, fetchImpl } = fakeFetch()
      const agentis = { taskId: 'task-1', runId: 'run-1', parentSessionId: 'ses-main' }
      const deps = scriptDeps(
        async (api) => {
          api.phase('Scan')
          await api.agent('a', { label: 'scan' })
          api.phase('Fix')
          await api.agent('b', { label: 'fix' })
          return 'ok'
        },
        { agentisReporter: (target) => createAgentisReporter(target, { endpoint: 'https://a.local', token: 'tok', fetchImpl, minIntervalMs: 0 }) },
      )
      const summary = await runWorkflow({ workflow: p.script(), cwd: p.cwd, runner: makeRunner().runner, agentis }, deps)

      assert.ok(calls.length >= 3)
      for (const c of calls) {
        assert.equal(c.url, 'https://a.local/api')
        assert.equal(c.headers['X-Auth-Token'], 'tok')
        assert.equal(c.body.method, 'run.ultracode_event')
        assert.equal(c.body.params.run_id, 'run-1')
        assert.equal(c.body.params.session_id, 'ses-main')
        assert.equal(c.body.params.workflow_run_id, summary.runId)
      }
      assert.equal(calls[0]!.body.params.state.status, 'running')
      const last = calls.at(-1)!.body.params.state
      assert.equal(last.status, 'completed')
      assert.equal(last.ultracode_run_id, summary.runId)
      assert.deepEqual(last.agents, { started: 2, running: 0, done: 2, failed: 0, cached: 0 })
      assert.deepEqual(
        last.phases.map((ph: any) => [ph.title, ph.status, ph.agents]),
        [['Scan', 'done', 1], ['Fix', 'done', 1]],
      )
      assert.ok(last.ended_at)
      assert.deepEqual(
        last.diagram.nodes.map((n: any) => [n.id, n.group, n.status, n.items.length]),
        [['scan', 'Scan', 'done', 1], ['fix', 'Fix', 'done', 1]],
      )
      assert.deepEqual(last.diagram.edges, [{ from: 'Scan', to: 'Fix', kind: 'barrier' }])
    } finally {
      p.cleanup()
    }
  })

  test('a failing Agentis does not break the run and is reported once', async () => {
    const p = makeProject()
    try {
      const { calls, fetchImpl } = fakeFetch(true)
      const errors: string[] = []
      const deps = scriptDeps(async (api) => api.agent('a'), {
        agentisReporter: (target) => createAgentisReporter(target, { endpoint: 'https://a.local', fetchImpl, minIntervalMs: 0, onError: (m) => errors.push(m) }),
      })
      const summary = await runWorkflow({ workflow: p.script(), cwd: p.cwd, runner: makeRunner().runner, agentis: { taskId: 't', runId: 'r' } }, deps)
      assert.equal(summary.status, 'completed')
      assert.ok(calls.length >= 2)
      assert.equal(errors.length, 1)
      assert.equal(calls[0]!.body.params.session_id, null)
    } finally {
      p.cleanup()
    }
  })

  test('without an Agentis target nothing is reported', async () => {
    const p = makeProject()
    try {
      let created = 0
      const deps = scriptDeps(async (api) => api.agent('a'), { agentisReporter: () => (created++, null) })
      await runWorkflow({ workflow: p.script(), cwd: p.cwd, runner: makeRunner().runner, agentis: null }, deps)
      assert.equal(created, 0)
    } finally {
      p.cleanup()
    }
  })
})
