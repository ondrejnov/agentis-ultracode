/**
 * Reads run state from disk: `<cwd>/.ultracode/runs/<runId>/{run.json,events.jsonl,...}`.
 * All functions are synchronous and robust against corrupt/incomplete files (they never throw).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { RunEvent, RunStatus, RunSummary, RunTotals } from '../types.ts'
import { lockHolderAlive } from './proc.ts'

const STATUSES: ReadonlySet<string> = new Set(['running', 'completed', 'failed', 'aborted'])

export function runsRoot(cwd: string): string {
  return join(resolve(cwd), '.ultracode', 'runs')
}

/** runId may contain only safe characters (no `/`, `..`) — protection against path traversal outside runs/. */
export function isSafeRunId(runId: string): boolean {
  return typeof runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)
}

export function runDirOf(cwd: string, runId: string): string {
  return join(runsRoot(cwd), runId)
}

export function emptyTotals(): RunTotals {
  return {
    agents: 0,
    cachedAgents: 0,
    failedAgents: 0,
    toolCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0,
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function normalizeTotals(raw: unknown): RunTotals {
  const base = emptyTotals()
  if (!isRecord(raw)) return base
  const usage = isRecord(raw.usage) ? raw.usage : {}
  return {
    agents: num(raw.agents),
    cachedAgents: num(raw.cachedAgents),
    failedAgents: num(raw.failedAgents),
    toolCalls: num(raw.toolCalls),
    usage: {
      inputTokens: num(usage.inputTokens),
      outputTokens: num(usage.outputTokens),
      cacheReadTokens: num(usage.cacheReadTokens),
      cacheCreationTokens: num(usage.cacheCreationTokens),
    },
    costUsd: num(raw.costUsd),
  }
}

/** Fills in missing fields from the run.json record; returns null if the base (status/startedAt) is missing too. */
function normalizeSummary(raw: unknown, dirName: string, runDir: string): RunSummary | null {
  if (!isRecord(raw)) return null
  if (typeof raw.status !== 'string' || !STATUSES.has(raw.status)) return null
  if (typeof raw.startedAt !== 'string' || Number.isNaN(Date.parse(raw.startedAt))) return null
  const summary: RunSummary = {
    runId: typeof raw.runId === 'string' && raw.runId ? raw.runId : dirName,
    name: typeof raw.name === 'string' ? raw.name : '',
    status: raw.status as RunStatus,
    startedAt: raw.startedAt,
    endedAt: typeof raw.endedAt === 'string' ? raw.endedAt : '',
    durationMs: num(raw.durationMs),
    runDir: typeof raw.runDir === 'string' && raw.runDir ? raw.runDir : runDir,
    scriptPath: typeof raw.scriptPath === 'string' ? raw.scriptPath : '',
    totals: normalizeTotals(raw.totals),
  }
  if ('result' in raw) summary.result = raw.result
  if (typeof raw.error === 'string') summary.error = raw.error
  if (raw.budgetExceeded === true) summary.budgetExceeded = true
  return summary
}

/** Corrupt/missing run.json: attempts to reconstruct it from events.jsonl (run_start/run_end). */
function reconstructFromEvents(cwd: string, runId: string, runDir: string): RunSummary | null {
  const events = readEvents(cwd, runId)
  const start = events.find((e) => e.t === 'run_start')
  if (!start || start.t !== 'run_start') return null
  const end = [...events].reverse().find((e) => e.t === 'run_end')
  const endEv = end && end.t === 'run_end' ? end : null
  const summary: RunSummary = {
    runId,
    name: start.name,
    status: endEv ? endEv.status : 'running',
    startedAt: start.ts,
    endedAt: endEv ? endEv.ts : '',
    durationMs: endEv ? endEv.durationMs : 0,
    runDir,
    scriptPath: start.scriptPath,
    totals: endEv ? normalizeTotals(endEv.totals) : emptyTotals(),
  }
  if (endEv?.error) summary.error = endEv.error
  return summary
}

/** Is a live process still holding the run lock (`.lock`)? */
function isLockHeld(runDir: string): boolean {
  const lock = readJson(join(runDir, '.lock'))
  if (!isRecord(lock)) return false
  const pid = Number(lock.pid)
  if (!Number.isInteger(pid) || pid <= 0) return false
  return lockHolderAlive({ pid, ...(typeof lock.start === 'string' ? { start: lock.start } : {}) })
}

/** Is some process holding the run lock right now (the run is running or being resumed)? */
export function runLockHeld(cwd: string, runId: string): boolean {
  if (!isSafeRunId(runId)) return false
  return isLockHeld(runDirOf(cwd, runId))
}

export function readRunSummary(cwd: string, runId: string): RunSummary | null {
  if (!isSafeRunId(runId)) return null
  const runDir = runDirOf(cwd, runId)
  const summary =
    normalizeSummary(readJson(join(runDir, 'run.json')), runId, runDir) ?? reconstructFromEvents(cwd, runId, runDir)
  // A process killed forcibly (SIGKILL, OOM, machine failure) did not manage to close the state: run.json stayed `running`.
  // Without a live lock holder this is not a running run but an interrupted one — `resume` finishes it from the journal.
  if (summary && summary.status === 'running' && !isLockHeld(runDir)) {
    summary.status = 'aborted'
    summary.error = summary.error ?? 'The run process is no longer running (it was terminated forcibly); it can be continued with the resume command.'
  }
  return summary
}

/** All runs, newest first (by startedAt, ties broken by runId). */
export function listRuns(cwd: string): RunSummary[] {
  let names: string[]
  try {
    names = readdirSync(runsRoot(cwd), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  const out: RunSummary[] = []
  for (const name of names) {
    if (!isSafeRunId(name)) continue
    const s = readRunSummary(cwd, name)
    if (s) out.push(s)
  }
  out.sort((a, b) => {
    const d = Date.parse(b.startedAt) - Date.parse(a.startedAt)
    if (d !== 0) return d
    return a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0
  })
  return out
}

/** Run events in write order; unreadable lines are skipped, a missing file yields `[]`. */
export function readEvents(cwd: string, runId: string): RunEvent[] {
  if (!isSafeRunId(runId)) return []
  let text: string
  try {
    text = readFileSync(join(runDirOf(cwd, runId), 'events.jsonl'), 'utf8')
  } catch {
    return []
  }
  const out: RunEvent[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const e = JSON.parse(line)
      if (isRecord(e) && typeof e.t === 'string') out.push(e as unknown as RunEvent)
    } catch {
      // ignore a truncated line
    }
  }
  return out
}
