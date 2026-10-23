/**
 * Pure renderers: RunEvent → lines of text, run summary, event digest for `status`.
 * No I/O or clocks; everything is deterministic so snapshots can be tested.
 */
import type { RunEvent, RunSummary, RunTotals, TokenUsage } from '../types.ts'
import {
  formatAge,
  formatClock,
  formatCount,
  formatDuration,
  formatTable,
  formatUsd,
  plural,
  safeJson,
  truncate,
} from './format.ts'
import type { Style } from './format.ts'

// ───────────────────────── rendering individual events ─────────────────────────

export interface RenderOptions {
  style: Style
  /** Prepend `[HH:MM:SS]` (from the event's `ts`). */
  timestamps?: boolean
  /** Also show agent_tool and the prompt preview. */
  verbose?: boolean
}

export interface AgentInfo {
  label: string
  phase: string | null
  workflowPath: string[]
}

/** State needed for rendering (agent_done carries no label → we remember it from the start). */
export interface RenderState {
  agents: Map<number, AgentInfo>
}

export function createRenderState(): RenderState {
  return { agents: new Map() }
}

function indentFor(path: string[]): string {
  return '  '.repeat(Math.max(0, path.length - 1))
}

function usageText(u: TokenUsage): string {
  return `in ${formatCount(u.inputTokens)} out ${formatCount(u.outputTokens)}`
}

function toolsText(n: number): string {
  return `${n} ${plural(n, 'tool', 'tools', 'tools')}`
}

function agentsText(n: number): string {
  return `${n} ${plural(n, 'agent', 'agents', 'agents')}`
}

/**
 * Renders one event into 0..N lines (without a trailing \n). Only mutates the passed `state`.
 */
export function renderEvent(e: RunEvent, state: RenderState, opts: RenderOptions): string[] {
  const s = opts.style
  const lines: string[] = []
  const prefix = opts.timestamps ? s.dim(`[${formatClock(e.ts) || '--:--:--'}] `) : ''
  const push = (text: string) => {
    for (const l of text.split('\n')) lines.push(prefix + l)
  }

  switch (e.t) {
    case 'run_start': {
      push(
        `${s.bold('ultracode')} ${e.runId}  ${s.bold(e.name)}${e.resumed ? s.yellow('  (resumed)') : ''}`,
      )
      if (e.description) push(s.dim(`  ${e.description}`))
      if (opts.verbose) {
        push(s.dim(`  script: ${e.scriptPath}`))
        push(s.dim(`  cwd:    ${e.cwd}`))
        if (e.args !== undefined) push(s.dim(`  args:   ${truncate(safeJson(e.args), 200)}`))
      }
      break
    }
    case 'phase': {
      push(`${indentFor(e.workflowPath)}${s.cyan(s.bold(`== Phase: ${e.title}`))}`)
      break
    }
    case 'log': {
      const ind = indentFor(e.workflowPath)
      const [first, ...rest] = e.message.split('\n')
      push(`${ind}${s.dim('[log]')} ${first}`)
      for (const r of rest) push(`${ind}      ${r}`)
      break
    }
    case 'workflow_enter': {
      push(`${indentFor(e.workflowPath)}${s.cyan(`>> nested workflow: ${e.name}`)}`)
      break
    }
    case 'workflow_exit': {
      push(`${indentFor(e.workflowPath)}${s.cyan(`<< end of nested workflow: ${e.name}`)}`)
      break
    }
    case 'agent_start': {
      state.agents.set(e.id, { label: e.label, phase: e.phase, workflowPath: e.workflowPath })
      const ind = indentFor(e.workflowPath)
      const model = e.model ? s.dim(`  [${e.model}]`) : ''
      push(`${ind}  #${e.id} ${s.dim('start  ')} ${e.label}${model}`)
      if (opts.verbose && e.promptPreview) push(s.dim(`${ind}         ${truncate(e.promptPreview, 160)}`))
      break
    }
    case 'agent_tool': {
      if (!opts.verbose) break
      const info = state.agents.get(e.id)
      push(s.dim(`${indentFor(info?.workflowPath ?? [])}  #${e.id} tool  ${e.tool}`))
      break
    }
    case 'agent_retry': {
      const info = state.agents.get(e.id)
      push(
        `${indentFor(info?.workflowPath ?? [])}  #${e.id} ${s.yellow('retry  ')} attempt ${e.attempt}${e.resumeSessionId ? ' (resuming session)' : ''}: ${e.reason}`,
      )
      break
    }
    case 'agent_done': {
      const info = state.agents.get(e.id)
      const label = info?.label ?? `agent ${e.id}`
      const ind = indentFor(info?.workflowPath ?? [])
      if (e.ok && e.cached) {
        push(`${ind}  #${e.id} ${s.green('cache  ')} ${label}`)
      } else if (e.ok) {
        const parts = [formatDuration(e.durationMs), usageText(e.usage), formatUsd(e.costUsd)]
        if (e.toolCalls > 0) parts.push(toolsText(e.toolCalls))
        push(`${ind}  #${e.id} ${s.green('done   ')} ${label}  ${s.dim(parts.join('  '))}`)
      } else {
        const parts = [formatDuration(e.durationMs), formatUsd(e.costUsd)]
        push(`${ind}  #${e.id} ${s.red('FAILED ')} ${label}  ${s.dim(parts.join('  '))}`)
        if (e.error) push(`${ind}         ${s.red(truncate(e.error, 300))}`)
      }
      break
    }
    case 'budget': {
      const parts: string[] = []
      if (e.limitOutputTokens !== null) {
        const pct = e.limitOutputTokens > 0 ? Math.round((e.spentOutputTokens / e.limitOutputTokens) * 100) : 0
        parts.push(`${formatCount(e.spentOutputTokens)} / ${formatCount(e.limitOutputTokens)} output tokens (${pct} %)`)
      }
      if (e.limitUsd !== null) {
        parts.push(`${formatUsd(e.spentUsd)} / ${formatUsd(e.limitUsd)}`)
      }
      if (parts.length > 0) push(s.dim(`  budget: ${parts.join('  |  ')}`))
      break
    }
    case 'run_end': {
      const color = e.status === 'completed' ? s.green : e.status === 'aborted' ? s.yellow : s.red
      push(
        `${s.bold('== End:')} ${color(e.status)}  ${formatDuration(e.durationMs)}  ${agentsText(e.totals.agents)}  ${formatUsd(e.totals.costUsd)}`,
      )
      if (e.error) push(s.red(`   ${e.error}`))
      break
    }
  }
  return lines
}

// ───────────────────────── run summary ─────────────────────────

/** A "Label:  value" line with the value column aligned to 10 characters. */
function kv(label: string, value: string): string {
  return `${label}:`.padEnd(10) + value
}

function totalsLines(t: RunTotals, s: Style): string[] {
  const agents = [agentsText(t.agents)]
  const extra: string[] = []
  if (t.cachedAgents > 0) extra.push(`from cache ${t.cachedAgents}`)
  if (t.failedAgents > 0) extra.push(s.red(`failed ${t.failedAgents}`))
  const agentLine = extra.length > 0 ? `${agents[0]} (${extra.join(', ')})` : agents[0]
  const u = t.usage
  return [
    kv('Agents', agentLine),
    kv('Tools', String(t.toolCalls)),
    kv('Tokens', `in ${formatCount(u.inputTokens)}, out ${formatCount(u.outputTokens)}, cache read ${formatCount(u.cacheReadTokens)}, cache write ${formatCount(u.cacheCreationTokens)}`),
    kv('Cost', formatUsd(t.costUsd)),
  ]
}

/** Final run summary (stderr after `run`). */
export function renderSummary(summary: RunSummary, style: Style): string[] {
  const s = style
  const statusColor = summary.status === 'completed' ? s.green : summary.status === 'aborted' ? s.yellow : s.red
  const lines: string[] = []
  lines.push(s.bold('-- Summary --'))
  lines.push(kv('Run', `${summary.runId}  ${summary.name}`))
  lines.push(kv('Status', `${statusColor(summary.status)}${summary.budgetExceeded ? s.yellow('  (budget exceeded)') : ''}`))
  lines.push(kv('Duration', formatDuration(summary.durationMs)))
  lines.push(...totalsLines(summary.totals, s))
  if (summary.error) lines.push(s.red(kv('Error', summary.error)))
  lines.push(kv('Folder', summary.runDir))
  return lines
}

// ───────────────────────── event digest (status) ─────────────────────────

export type AgentState = 'running' | 'done' | 'cached' | 'failed'

export interface AgentRow {
  id: number
  label: string
  phase: string | null
  workflowPath: string[]
  state: AgentState
  durationMs?: number
  costUsd?: number
  usage?: TokenUsage
  toolCalls?: number
  retries: number
  error?: string
}

export interface PhaseRow {
  title: string
  agents: number
}

export interface EventDigest {
  agents: AgentRow[]
  phases: PhaseRow[]
  currentPhase: string | null
  logs: string[]
  ended: boolean
}

/** Builds the agent and phase state from events.jsonl. Robust against incomplete (in-progress) logs. */
export function digestEvents(events: RunEvent[]): EventDigest {
  const agents = new Map<number, AgentRow>()
  const phases: PhaseRow[] = []
  const phaseIndex = new Map<string, PhaseRow>()
  const logs: string[] = []
  let current: string | null = null
  let ended = false

  const ensurePhase = (title: string): PhaseRow => {
    let row = phaseIndex.get(title)
    if (!row) {
      row = { title, agents: 0 }
      phaseIndex.set(title, row)
      phases.push(row)
    }
    return row
  }

  for (const e of events) {
    switch (e.t) {
      case 'run_start':
        // resume appends to the same events.jsonl: the old run_end stops applying
        ended = false
        for (const p of e.phases ?? []) ensurePhase(p.title)
        break
      case 'phase':
        current = e.title
        ensurePhase(e.title)
        break
      case 'log':
        logs.push(e.message)
        break
      case 'agent_start': {
        const phase = e.phase ?? current
        agents.set(e.id, {
          id: e.id,
          label: e.label,
          phase,
          workflowPath: e.workflowPath,
          state: 'running',
          retries: 0,
        })
        if (phase) ensurePhase(phase).agents++
        break
      }
      case 'agent_retry': {
        const a = agents.get(e.id)
        if (a) a.retries++
        break
      }
      case 'agent_done': {
        const a = agents.get(e.id) ?? {
          id: e.id,
          label: `agent ${e.id}`,
          phase: null,
          workflowPath: [],
          state: 'running' as AgentState,
          retries: 0,
        }
        a.state = e.ok ? (e.cached ? 'cached' : 'done') : 'failed'
        a.durationMs = e.durationMs
        a.costUsd = e.costUsd
        a.usage = e.usage
        a.toolCalls = e.toolCalls
        if (e.error) a.error = e.error
        agents.set(e.id, a)
        break
      }
      case 'run_end':
        ended = true
        break
      default:
        break
    }
  }
  return {
    agents: [...agents.values()].sort((a, b) => a.id - b.id),
    phases,
    currentPhase: current,
    logs,
    ended,
  }
}

const STATE_LABEL: Record<AgentState, string> = {
  running: 'running',
  done: 'done',
  cached: 'cache',
  failed: 'FAILED',
}

export interface StatusRenderInput {
  summary: RunSummary
  digest: EventDigest
  /** Current time in ms (for the age and the duration of a running run). */
  nowMs: number
  style: Style
  /** Max. number of agent rows (newest); default 40. */
  maxAgents?: number
}

/** Text of the `status` command. */
export function renderStatus(input: StatusRenderInput): string[] {
  const { summary, digest, style: s } = input
  const lines: string[] = []
  const statusColor = summary.status === 'completed' ? s.green : summary.status === 'running' ? s.cyan : summary.status === 'aborted' ? s.yellow : s.red
  const startedMs = Date.parse(summary.startedAt)
  const duration =
    summary.status === 'running' && Number.isFinite(startedMs)
      ? Math.max(0, input.nowMs - startedMs)
      : summary.durationMs

  lines.push(`${s.bold('Run')} ${summary.runId}  ${s.bold(summary.name)}`)
  lines.push(kv('Status', `${statusColor(summary.status)}${summary.budgetExceeded ? s.yellow('  (budget exceeded)') : ''}`))
  lines.push(kv('Duration', `${formatDuration(duration)}${summary.status === 'running' ? s.dim(' (running)') : ''}`))
  lines.push(kv('Script', summary.scriptPath))
  lines.push(kv('Folder', summary.runDir))

  if (digest.phases.length > 0) {
    lines.push('')
    lines.push(s.bold('Phases:'))
    for (const p of digest.phases) {
      const active = !digest.ended && p.title === digest.currentPhase
      const mark = active ? s.cyan('>') : ' '
      lines.push(`  ${mark} ${p.title}  ${s.dim(agentsText(p.agents))}`)
    }
  }

  if (digest.agents.length > 0) {
    const max = input.maxAgents ?? 40
    const shown = digest.agents.slice(-max)
    lines.push('')
    lines.push(s.bold(`Agents${digest.agents.length > shown.length ? ` (last ${shown.length} of ${digest.agents.length})` : ''}:`))
    const rows = shown.map((a) => {
      const color = a.state === 'done' || a.state === 'cached' ? s.green : a.state === 'failed' ? s.red : s.cyan
      const detail: string[] = []
      if (a.durationMs !== undefined) detail.push(formatDuration(a.durationMs))
      if (a.costUsd !== undefined && a.state !== 'cached') detail.push(formatUsd(a.costUsd))
      if (a.retries > 0) detail.push(`retry ${a.retries}x`)
      if (a.error) detail.push(truncate(a.error, 80))
      return [`#${a.id}`, color(STATE_LABEL[a.state]), a.label, s.dim(detail.join('  '))]
    })
    lines.push(...formatTable(rows, '  '))
  }

  lines.push('')
  lines.push(s.bold('Totals:'))
  for (const l of totalsLines(summary.totals, s)) lines.push(`  ${l}`)

  if (summary.error) {
    lines.push('')
    lines.push(s.red(kv('Error', summary.error)))
  }
  if (summary.status === 'completed' && summary.result !== undefined) {
    lines.push('')
    lines.push(kv('Result', truncate(safeJson(summary.result), 300)))
  }
  return lines
}

// ───────────────────────── run list ─────────────────────────

/** Table of runs for `list`. */
export function renderRunList(runs: RunSummary[], nowMs: number, s: Style): string[] {
  if (runs.length === 0) return []
  const header = ['ID', 'WORKFLOW', 'STATUS', 'AGE', 'AGENTS', 'COST'].map((h) => s.dim(h))
  const rows = runs.map((r) => {
    const color = r.status === 'completed' ? s.green : r.status === 'running' ? s.cyan : r.status === 'aborted' ? s.yellow : s.red
    const started = Date.parse(r.startedAt)
    const age = Number.isFinite(started) ? formatAge(nowMs - started) : '?'
    return [r.runId, r.name, color(r.status), age, String(r.totals.agents), formatUsd(r.totals.costUsd)]
  })
  return formatTable([header, ...rows], '  ')
}
