/**
 * Čtení stavu běhů z disku: `<cwd>/.ultracode/runs/<runId>/{run.json,events.jsonl,...}`.
 * Všechny funkce jsou synchronní a odolné vůči poškozeným/neúplným souborům (nikdy nehází).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { RunEvent, RunStatus, RunSummary, RunTotals } from '../types.ts'
import { lockHolderAlive } from './proc.ts'

const STATUSES: ReadonlySet<string> = new Set(['running', 'completed', 'failed', 'aborted'])

export function runsRoot(cwd: string): string {
  return join(resolve(cwd), '.ultracode', 'runs')
}

/** runId smí obsahovat jen bezpečné znaky (žádné `/`, `..`) — ochrana proti průchodu mimo runs/. */
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

/** Doplní chybějící pole ze zápisu v run.json; vrací null, pokud chybí i základ (status/startedAt). */
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

/** Poškozený/chybějící run.json: pokus o rekonstrukci z events.jsonl (run_start/run_end). */
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

/** Drží zámek běhu (`.lock`) ještě živý proces? */
function isLockHeld(runDir: string): boolean {
  const lock = readJson(join(runDir, '.lock'))
  if (!isRecord(lock)) return false
  const pid = Number(lock.pid)
  if (!Number.isInteger(pid) || pid <= 0) return false
  return lockHolderAlive({ pid, ...(typeof lock.start === 'string' ? { start: lock.start } : {}) })
}

/** Drží právě teď nějaký proces zámek běhu (běh běží, nebo se obnovuje)? */
export function runLockHeld(cwd: string, runId: string): boolean {
  if (!isSafeRunId(runId)) return false
  return isLockHeld(runDirOf(cwd, runId))
}

export function readRunSummary(cwd: string, runId: string): RunSummary | null {
  if (!isSafeRunId(runId)) return null
  const runDir = runDirOf(cwd, runId)
  const summary =
    normalizeSummary(readJson(join(runDir, 'run.json')), runId, runDir) ?? reconstructFromEvents(cwd, runId, runDir)
  // Proces zabitý násilně (SIGKILL, OOM, výpadek stroje) nestihl stav uzavřít: run.json zůstal `running`.
  // Bez živého držitele zámku to není běh, ale přerušený běh — `resume` ho dodělá z journalu.
  if (summary && summary.status === 'running' && !isLockHeld(runDir)) {
    summary.status = 'aborted'
    summary.error = summary.error ?? 'Proces běhu už neběží (byl ukončen násilně); lze pokračovat příkazem resume.'
  }
  return summary
}

/** Všechny běhy, nejnovější první (podle startedAt, při shodě podle runId). */
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

/** Události běhu v pořadí zápisu; nečitelné řádky se přeskočí, chybějící soubor dává `[]`. */
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
      // useknutý řádek ignorujeme
    }
  }
  return out
}
