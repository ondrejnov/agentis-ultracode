/**
 * Workflow diagram for Agentis: a small, generic JSON language (groups → nodes → edges) that the Agentis frontend only
 * renders. Built from `meta.phases[].agents` (planned nodes and `inputs` arrows) and the runtime agent runs.
 *
 * Contract (version 1) is shared with Agentis `frontend/app/components/workflow-diagram/types.ts` – change both together.
 */
import type { PhaseAgentMeta } from '../types.ts'

export type DiagramStatus = 'pending' | 'running' | 'done' | 'failed' | 'aborted'

/** Fixed keys; the frontend formats and localizes them. */
export interface DiagramStats {
  model?: string
  duration_ms?: number
  cost_usd?: number
  attempts?: number
  runs?: number
  cached?: boolean
}

export interface DiagramItem {
  label: string
  status: DiagramStatus
  stats?: DiagramStats
  error?: string | null
}

export interface DiagramNode {
  id: string
  group: string | null
  label: string
  detail?: string
  status: DiagramStatus
  stats?: DiagramStats
  items?: DiagramItem[]
}

export interface DiagramGroup {
  id: string
  label: string
  detail?: string
  status: DiagramStatus
}

/** `from` / `to` are ids of nodes or groups. */
export interface DiagramEdge {
  from: string
  to: string
  kind?: 'data' | 'barrier'
}

export interface Diagram {
  version: 1
  groups: DiagramGroup[]
  nodes: DiagramNode[]
  edges: DiagramEdge[]
  truncated?: boolean
}

export interface DiagramAgentRun {
  id: number
  label: string
  phase: string | null
  model?: string
  status: Exclude<DiagramStatus, 'pending'>
  cached: boolean
  attempts: number
  duration_ms: number | null
  cost_usd: number
  error: string | null
}

export interface DiagramInput {
  phases: Array<{ title: string; detail?: string; status: 'pending' | 'running' | 'done'; agents?: PhaseAgentMeta[] }>
  /** In start order. */
  runs: DiagramAgentRun[]
}

export const DIAGRAM_MAX_NODES = 200
export const DIAGRAM_MAX_ITEMS = 200

interface NodeDraft {
  node: DiagramNode
  inputs: string[]
  runs: DiagramAgentRun[]
}

export function buildDiagram(input: DiagramInput): Diagram {
  let truncated = false
  const drafts: NodeDraft[] = []
  const byLabel = new Map<string, NodeDraft>()
  const byRuntimeKey = new Map<string, NodeDraft>()
  const ids = new Set<string>()

  const uniqueId = (base: string): string => {
    let id = base
    for (let n = 2; ids.has(id); n++) id = `${base} (${n})`
    ids.add(id)
    return id
  }
  const addNode = (label: string, group: string | null, detail: string | undefined, inputs: string[]): NodeDraft | null => {
    if (drafts.length >= DIAGRAM_MAX_NODES) {
      truncated = true
      return null
    }
    const draft: NodeDraft = {
      node: { id: uniqueId(label), group, label, ...(detail ? { detail } : {}), status: 'pending' },
      inputs,
      runs: [],
    }
    drafts.push(draft)
    return draft
  }

  for (const phase of input.phases) {
    for (const a of phase.agents ?? []) {
      if (byLabel.has(a.label)) continue
      const draft = addNode(a.label, phase.title, a.detail, a.inputs ?? [])
      if (draft) byLabel.set(a.label, draft)
    }
  }
  for (const run of input.runs) {
    let draft = byLabel.get(run.label) ?? byRuntimeKey.get(`${run.phase ?? ''}\u0000${run.label}`) ?? null
    if (!draft) {
      draft = addNode(run.label, run.phase, undefined, [])
      if (!draft) continue
      byRuntimeKey.set(`${run.phase ?? ''}\u0000${run.label}`, draft)
    }
    draft.runs.push(run)
  }

  for (const { node, runs } of drafts) {
    if (runs.length === 0) continue
    node.status = runs.some((r) => r.status === 'running') ? 'running' : runs.at(-1)!.status
    node.stats = statsOf(runs)
    if (runs.length > DIAGRAM_MAX_ITEMS) truncated = true
    node.items = runs.slice(-DIAGRAM_MAX_ITEMS).map((r) => ({
      label: `#${r.id}`,
      status: r.status,
      stats: statsOf([r]),
      error: r.error,
    }))
  }

  const edges: DiagramEdge[] = []
  for (const { node, inputs } of drafts) {
    for (const label of inputs) {
      const from = byLabel.get(label)
      if (from) edges.push({ from: from.node.id, to: node.id, kind: 'data' })
    }
  }

  const groupOfNode = new Map(drafts.map((d) => [d.node.id, d.node.group]))
  const groups: DiagramGroup[] = input.phases.map((p) => {
    const failed = drafts.some((d) => d.node.group === p.title && d.node.status === 'failed')
    return {
      id: p.title,
      label: p.title,
      ...(p.detail ? { detail: p.detail } : {}),
      status: p.status === 'done' && failed ? 'failed' : p.status,
    }
  })
  for (let i = 1; i < groups.length; i++) {
    const from = groups[i - 1]!.id
    const to = groups[i]!.id
    const linked = edges.some((e) => groupOfNode.get(e.from) === from && groupOfNode.get(e.to) === to)
    if (!linked) edges.push({ from, to, kind: 'barrier' })
  }

  return { version: 1, groups, nodes: drafts.map((d) => d.node), edges, ...(truncated ? { truncated: true } : {}) }
}

function statsOf(runs: DiagramAgentRun[]): DiagramStats {
  const last = runs.at(-1)!
  const durations = runs.map((r) => r.duration_ms).filter((d): d is number => d !== null)
  return {
    ...(last.model ? { model: last.model } : {}),
    ...(durations.length > 0 ? { duration_ms: durations.reduce((a, b) => a + b, 0) } : {}),
    cost_usd: runs.reduce((a, r) => a + r.cost_usd, 0),
    attempts: runs.reduce((a, r) => a + r.attempts, 0),
    runs: runs.length,
    ...(runs.every((r) => r.cached) ? { cached: true } : {}),
  }
}
