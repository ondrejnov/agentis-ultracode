/**
 * Čisté renderery: RunEvent → řádky textu, souhrn běhu, digest událostí pro `status`.
 * Žádné I/O ani hodiny; všechno deterministické, aby šlo testovat snapshoty.
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

// ───────────────────────── render jednotlivých událostí ─────────────────────────

export interface RenderOptions {
  style: Style
  /** Předřadit `[HH:MM:SS]` (z `ts` události). */
  timestamps?: boolean
  /** Zobrazit i agent_tool a náhled promptu. */
  verbose?: boolean
}

export interface AgentInfo {
  label: string
  phase: string | null
  workflowPath: string[]
}

/** Stav potřebný k vykreslení (agent_done nenese label → pamatujeme si ho ze startu). */
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
  return `${n} ${plural(n, 'nástroj', 'nástroje', 'nástrojů')}`
}

function agentsText(n: number): string {
  return `${n} ${plural(n, 'agent', 'agenti', 'agentů')}`
}

/**
 * Vykreslí jednu událost do 0..N řádků (bez koncového \n). Mění pouze předaný `state`.
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
        `${s.bold('ultracode')} ${e.runId}  ${s.bold(e.name)}${e.resumed ? s.yellow('  (pokračování)') : ''}`,
      )
      if (e.description) push(s.dim(`  ${e.description}`))
      if (opts.verbose) {
        push(s.dim(`  skript: ${e.scriptPath}`))
        push(s.dim(`  cwd:    ${e.cwd}`))
        if (e.args !== undefined) push(s.dim(`  args:   ${truncate(safeJson(e.args), 200)}`))
      }
      break
    }
    case 'phase': {
      push(`${indentFor(e.workflowPath)}${s.cyan(s.bold(`== Fáze: ${e.title}`))}`)
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
      push(`${indentFor(e.workflowPath)}${s.cyan(`>> vnořené workflow: ${e.name}`)}`)
      break
    }
    case 'workflow_exit': {
      push(`${indentFor(e.workflowPath)}${s.cyan(`<< konec vnořeného workflow: ${e.name}`)}`)
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
      push(s.dim(`${indentFor(info?.workflowPath ?? [])}  #${e.id} nástroj  ${e.tool}`))
      break
    }
    case 'agent_retry': {
      const info = state.agents.get(e.id)
      push(
        `${indentFor(info?.workflowPath ?? [])}  #${e.id} ${s.yellow('retry  ')} pokus ${e.attempt}: ${e.reason}`,
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
        push(`${ind}  #${e.id} ${s.green('hotovo ')} ${label}  ${s.dim(parts.join('  '))}`)
      } else {
        const parts = [formatDuration(e.durationMs), formatUsd(e.costUsd)]
        push(`${ind}  #${e.id} ${s.red('SELHAL ')} ${label}  ${s.dim(parts.join('  '))}`)
        if (e.error) push(`${ind}         ${s.red(truncate(e.error, 300))}`)
      }
      break
    }
    case 'budget': {
      const parts: string[] = []
      if (e.limitOutputTokens !== null) {
        const pct = e.limitOutputTokens > 0 ? Math.round((e.spentOutputTokens / e.limitOutputTokens) * 100) : 0
        parts.push(`${formatCount(e.spentOutputTokens)} / ${formatCount(e.limitOutputTokens)} výstupních tokenů (${pct} %)`)
      }
      if (e.limitUsd !== null) {
        parts.push(`${formatUsd(e.spentUsd)} / ${formatUsd(e.limitUsd)}`)
      }
      if (parts.length > 0) push(s.dim(`  rozpočet: ${parts.join('  |  ')}`))
      break
    }
    case 'run_end': {
      const color = e.status === 'completed' ? s.green : e.status === 'aborted' ? s.yellow : s.red
      push(
        `${s.bold('== Konec:')} ${color(e.status)}  ${formatDuration(e.durationMs)}  ${agentsText(e.totals.agents)}  ${formatUsd(e.totals.costUsd)}`,
      )
      if (e.error) push(s.red(`   ${e.error}`))
      break
    }
  }
  return lines
}

// ───────────────────────── souhrn běhu ─────────────────────────

/** Řádek „Popisek:  hodnota“ se sloupcem hodnot zarovnaným na 10 znaků. */
function kv(label: string, value: string): string {
  return `${label}:`.padEnd(10) + value
}

function totalsLines(t: RunTotals, s: Style): string[] {
  const agents = [agentsText(t.agents)]
  const extra: string[] = []
  if (t.cachedAgents > 0) extra.push(`z cache ${t.cachedAgents}`)
  if (t.failedAgents > 0) extra.push(s.red(`selhalo ${t.failedAgents}`))
  const agentLine = extra.length > 0 ? `${agents[0]} (${extra.join(', ')})` : agents[0]
  const u = t.usage
  return [
    kv('Agenti', agentLine),
    kv('Nástroje', String(t.toolCalls)),
    kv('Tokeny', `in ${formatCount(u.inputTokens)}, out ${formatCount(u.outputTokens)}, cache čtení ${formatCount(u.cacheReadTokens)}, cache zápis ${formatCount(u.cacheCreationTokens)}`),
    kv('Cena', formatUsd(t.costUsd)),
  ]
}

/** Závěrečný souhrn běhu (stderr po `run`). */
export function renderSummary(summary: RunSummary, style: Style): string[] {
  const s = style
  const statusColor = summary.status === 'completed' ? s.green : summary.status === 'aborted' ? s.yellow : s.red
  const lines: string[] = []
  lines.push(s.bold('-- Souhrn --'))
  lines.push(kv('Běh', `${summary.runId}  ${summary.name}`))
  lines.push(kv('Stav', `${statusColor(summary.status)}${summary.budgetExceeded ? s.yellow('  (rozpočet překročen)') : ''}`))
  lines.push(kv('Doba', formatDuration(summary.durationMs)))
  lines.push(...totalsLines(summary.totals, s))
  if (summary.error) lines.push(s.red(kv('Chyba', summary.error)))
  lines.push(kv('Adresář', summary.runDir))
  return lines
}

// ───────────────────────── digest událostí (status) ─────────────────────────

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

/** Z events.jsonl poskládá stav agentů a fází. Odolné vůči neúplným (rozpracovaným) logům. */
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
        // resume dopisuje do téhož events.jsonl: starý run_end přestává platit
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
  running: 'běží',
  done: 'hotovo',
  cached: 'cache',
  failed: 'SELHAL',
}

export interface StatusRenderInput {
  summary: RunSummary
  digest: EventDigest
  /** Aktuální čas v ms (kvůli stáří a době probíhajícího běhu). */
  nowMs: number
  style: Style
  /** Max. počet řádků agentů (nejnovější); default 40. */
  maxAgents?: number
}

/** Text příkazu `status`. */
export function renderStatus(input: StatusRenderInput): string[] {
  const { summary, digest, style: s } = input
  const lines: string[] = []
  const statusColor = summary.status === 'completed' ? s.green : summary.status === 'running' ? s.cyan : summary.status === 'aborted' ? s.yellow : s.red
  const startedMs = Date.parse(summary.startedAt)
  const duration =
    summary.status === 'running' && Number.isFinite(startedMs)
      ? Math.max(0, input.nowMs - startedMs)
      : summary.durationMs

  lines.push(`${s.bold('Běh')} ${summary.runId}  ${s.bold(summary.name)}`)
  lines.push(kv('Stav', `${statusColor(summary.status)}${summary.budgetExceeded ? s.yellow('  (rozpočet překročen)') : ''}`))
  lines.push(kv('Doba', `${formatDuration(duration)}${summary.status === 'running' ? s.dim(' (běží)') : ''}`))
  lines.push(kv('Skript', summary.scriptPath))
  lines.push(kv('Adresář', summary.runDir))

  if (digest.phases.length > 0) {
    lines.push('')
    lines.push(s.bold('Fáze:'))
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
    lines.push(s.bold(`Agenti${digest.agents.length > shown.length ? ` (posledních ${shown.length} z ${digest.agents.length})` : ''}:`))
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
  lines.push(s.bold('Součty:'))
  for (const l of totalsLines(summary.totals, s)) lines.push(`  ${l}`)

  if (summary.error) {
    lines.push('')
    lines.push(s.red(kv('Chyba', summary.error)))
  }
  if (summary.status === 'completed' && summary.result !== undefined) {
    lines.push('')
    lines.push(kv('Výsledek', truncate(safeJson(summary.result), 300)))
  }
  return lines
}

// ───────────────────────── seznam běhů ─────────────────────────

/** Tabulka běhů pro `list`. */
export function renderRunList(runs: RunSummary[], nowMs: number, s: Style): string[] {
  if (runs.length === 0) return []
  const header = ['ID', 'WORKFLOW', 'STAV', 'STÁŘÍ', 'AGENTI', 'CENA'].map((h) => s.dim(h))
  const rows = runs.map((r) => {
    const color = r.status === 'completed' ? s.green : r.status === 'running' ? s.cyan : r.status === 'aborted' ? s.yellow : s.red
    const started = Date.parse(r.startedAt)
    const age = Number.isFinite(started) ? formatAge(nowMs - started) : '?'
    return [r.runId, r.name, color(r.status), age, String(r.totals.agents), formatUsd(r.totals.costUsd)]
  })
  return formatTable([header, ...rows], '  ')
}
