import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildDiagram, DIAGRAM_MAX_NODES, type DiagramAgentRun } from '../../src/engine/diagram.ts'

const run = (id: number, label: string, phase: string | null, over: Partial<DiagramAgentRun> = {}): DiagramAgentRun => ({
  id,
  label,
  phase,
  status: 'done',
  cached: false,
  attempts: 1,
  duration_ms: 1000,
  cost_usd: 0.5,
  error: null,
  ...over,
})

describe('workflow diagram', () => {
  test('declared agents become planned nodes with data edges; runs fill in their state', () => {
    const d = buildDiagram({
      phases: [
        { title: 'Implement', detail: 'two partitions', status: 'done', agents: [{ label: 'backend' }, { label: 'frontend', detail: 'ui' }] },
        { title: 'Verify', status: 'running', agents: [{ label: 'review', inputs: ['backend', 'frontend'] }, { label: 'docs' }] },
      ],
      runs: [
        run(1, 'backend', 'Implement', { model: 'opus' }),
        run(2, 'frontend', 'Implement', { status: 'failed', error: 'boom', attempts: 2 }),
        run(3, 'review', 'Verify', { status: 'running', duration_ms: null, cost_usd: 0 }),
      ],
    })
    assert.equal(d.version, 1)
    assert.deepEqual(d.groups, [
      { id: 'Implement', label: 'Implement', detail: 'two partitions', status: 'failed' },
      { id: 'Verify', label: 'Verify', status: 'running' },
    ])
    assert.deepEqual(
      d.nodes.map((n) => [n.id, n.group, n.status]),
      [['backend', 'Implement', 'done'], ['frontend', 'Implement', 'failed'], ['review', 'Verify', 'running'], ['docs', 'Verify', 'pending']],
    )
    assert.deepEqual(d.nodes[0]!.stats, { model: 'opus', duration_ms: 1000, cost_usd: 0.5, attempts: 1, runs: 1 })
    assert.deepEqual(d.nodes[1]!.items, [{ label: '#2', status: 'failed', stats: { duration_ms: 1000, cost_usd: 0.5, attempts: 2, runs: 1 }, error: 'boom' }])
    assert.equal(d.nodes[3]!.items, undefined)
    assert.deepEqual(d.edges, [
      { from: 'backend', to: 'review', kind: 'data' },
      { from: 'frontend', to: 'review', kind: 'data' },
    ])
  })

  test('without declarations nodes come from runs and consecutive groups get a barrier edge', () => {
    const d = buildDiagram({
      phases: [
        { title: 'Scan', status: 'done' },
        { title: 'Fix', status: 'done' },
      ],
      runs: [run(1, 'scan', 'Scan'), run(2, 'scan', 'Scan', { cached: true }), run(3, 'fix', 'Fix'), run(4, 'fix', null)],
    })
    assert.deepEqual(
      d.nodes.map((n) => [n.id, n.group, n.stats?.runs]),
      [['scan', 'Scan', 2], ['fix', 'Fix', 1], ['fix (2)', null, 1]],
    )
    assert.deepEqual(d.edges, [{ from: 'Scan', to: 'Fix', kind: 'barrier' }])
  })

  test('node count is capped and marked as truncated', () => {
    const runs = Array.from({ length: DIAGRAM_MAX_NODES + 5 }, (_, i) => run(i + 1, `a${i}`, null))
    const d = buildDiagram({ phases: [], runs })
    assert.equal(d.nodes.length, DIAGRAM_MAX_NODES)
    assert.equal(d.truncated, true)
  })
})
