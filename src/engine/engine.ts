/**
 * Orchestrates one workflow run: finds and validates the script, creates the run directory, implements `ScriptHooks`
 * (limits, budget, journal cache, concurrency semaphore, runner), writes events/journal/run.json
 * and returns a `RunSummary` at the end.
 *
 * `runWorkflow` does NOT throw for script or agent failures (it returns a summary with status `failed`/`aborted`);
 * it throws only for misuse: a nonexistent workflow/run or an invalid script (ScriptValidationError).
 */
import { randomBytes, randomInt } from 'node:crypto'
import { existsSync, linkSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { basename, extname, join, relative, resolve } from 'node:path'
import {
  AbortedError,
  BudgetExceededError,
  ScriptValidationError,
  UltracodeError,
  WorkflowNotFoundError,
} from '../errors.ts'
import {
  type AgentisTelemetryTarget,
  BUDGET_SLOTS,
  EMPTY_USAGE,
  type AgentOptions,
  type ClaudeRunRequest,
  type ClaudeRunResult,
  type ClaudeRunner,
  type EffortLevel,
  type HookCall,
  type LoadedScript,
  type PermissionMode,
  type PhaseMeta,
  type RunEvent,
  type RunOptions,
  type RunScriptRequest,
  type RunScriptResult,
  type RunStatus,
  type RunSummary,
  type RunTotals,
  type ScriptHooks,
  type TokenUsage,
  type WorkflowMeta,
} from '../types.ts'
import { findWorkflow, looksLikePath } from './discovery.ts'
import { JsonlAppender, StateFileWriter, ensureTrailingNewline, writeFileAtomic } from './io.ts'
import { JournalCache, computeCallKey, type JournalEntry } from './journal.ts'
import { currentLockHolder, lockHolderAlive, type LockHolder } from './proc.ts'
import { Semaphore } from './semaphore.ts'
import { emptyTotals, isSafeRunId, readEvents, runDirOf, runsRoot } from './store.ts'

// ───────────────────────── public types ─────────────────────────

/** Structural shape of the `parseScript` result (src/script/parse.ts) — intentionally without importing the type. */
export interface ParsedScriptLike {
  ok: boolean
  meta: WorkflowMeta | null
  diagnostics: Array<{ level: 'error' | 'warning'; message: string; line?: number }>
  code?: string
}

export interface EngineDeps {
  /** Injected script host (default `runScript` from src/script/host.ts). */
  runScript?: (req: RunScriptRequest) => Promise<RunScriptResult>
  /** Injected parser (default `parseScript` from src/script/parse.ts). */
  parseScript?: (source: string, filename: string) => ParsedScriptLike
  /** How long to wait after an abort for the script/agents to finish before the run is closed (default 10 000 ms). */
  abortGraceMs?: number
}

export const DEFAULT_MAX_AGENTS = 1000
const DEFAULT_ABORT_GRACE_MS = 10_000
const SCRIPT_EXTENSIONS = ['.ts', '.js', '.mjs', '.mts', '.cjs', '.cts']

// ───────────────────────── helper functions ─────────────────────────

/** `wf_<8 hex>-<3 hex>` as in Claude Code. */
export function generateRunId(): string {
  return `wf_${randomBytes(4).toString('hex')}-${randomInt(0x1000).toString(16).padStart(3, '0')}`
}

/** Concurrency: `opts.concurrency` > env `ULTRACODE_MAX_CONCURRENCY` > `min(16, max(1, cpus-2))`. */
export function resolveConcurrency(requested?: number, env: NodeJS.ProcessEnv = process.env): number {
  if (typeof requested === 'number' && Number.isFinite(requested) && requested >= 1) return Math.floor(requested)
  const fromEnv = Number.parseInt(env.ULTRACODE_MAX_CONCURRENCY ?? '', 10)
  if (Number.isFinite(fromEnv) && fromEnv >= 1) return fromEnv
  let cpus = 1
  try {
    cpus = availableParallelism()
  } catch {
    cpus = 1
  }
  return Math.min(16, Math.max(1, cpus - 2))
}

/**
 * Agentis telemetry target: on when ultracode runs inside an Agentis run (env `AGENTIS_TASK_ID`, `AGENTIS_RUN_ID`
 * and `AGENTIS_ENDPOINT`, which agentiscode needs), unless `ULTRACODE_AGENTIS_TELEMETRY` is `0`/`false`/`no`/`off`.
 * Parent session = the Claude Code session that started ultracode (`CLAUDE_CODE_SESSION_ID`, then `AGENTIS_SESSION_ID`).
 */
export function resolveAgentisTelemetry(env: NodeJS.ProcessEnv = process.env): AgentisTelemetryTarget | null {
  if (/^(0|false|no|off)$/i.test(env.ULTRACODE_AGENTIS_TELEMETRY?.trim() ?? '')) return null
  const taskId = env.AGENTIS_TASK_ID?.trim()
  const runId = env.AGENTIS_RUN_ID?.trim()
  if (!taskId || !runId || !env.AGENTIS_ENDPOINT?.trim()) return null
  const parentSessionId = env.CLAUDE_CODE_SESSION_ID?.trim() || env.AGENTIS_SESSION_ID?.trim()
  return parentSessionId ? { taskId, runId, parentSessionId } : { taskId, runId }
}

function nowIso(): string {
  return new Date().toISOString()
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

function sanitizeUsage(u: Partial<TokenUsage> | undefined | null): TokenUsage {
  return {
    inputTokens: num(u?.inputTokens),
    outputTokens: num(u?.outputTokens),
    cacheReadTokens: num(u?.cacheReadTokens),
    cacheCreationTokens: num(u?.cacheCreationTokens),
  }
}

function addUsage(into: TokenUsage, u: TokenUsage): void {
  into.inputTokens += u.inputTokens
  into.outputTokens += u.outputTokens
  into.cacheReadTokens += u.cacheReadTokens
  into.cacheCreationTokens += u.cacheCreationTokens
}

function cloneTotals(t: RunTotals): RunTotals {
  return { ...t, usage: { ...t.usage } }
}

/** Human-readable error description including a (shortened) stack; also handles errors serialized through the worker (plain objects). */
function describeError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: unknown; message?: unknown; stack?: unknown }
    const message = typeof e.message === 'string' ? e.message : ''
    const name = typeof e.name === 'string' ? e.name : 'Error'
    if (typeof e.stack === 'string' && e.stack.trim()) {
      const lines = e.stack.split('\n')
      const text = lines.slice(0, 12).join('\n')
      return message && !text.includes(message) ? `${name}: ${message}\n${text}` : text
    }
    if (message) return `${name}: ${message}`
  }
  return String(err)
}

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string') return (err as { code: string }).code
  return undefined
}

function deriveLabel(prompt: string): string {
  const first = prompt.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? 'agent'
  return first.length > 60 ? first.slice(0, 57) + '...' : first
}

function previewOf(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? flat.slice(0, 197) + '...' : flat
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function findStoredScript(runDir: string): string | null {
  let files: string[]
  try {
    files = readdirSync(runDir)
  } catch {
    return null
  }
  for (const ext of SCRIPT_EXTENSIONS) {
    if (files.includes(`script${ext}`)) return join(runDir, `script${ext}`)
  }
  return null
}

function readStoredArgs(runDir: string): unknown {
  try {
    const v = JSON.parse(readFileSync(join(runDir, 'args.json'), 'utf8'))
    return v === null ? undefined : v
  } catch {
    return undefined
  }
}

/** Finds the source file of the script for `opts.workflow` (a path or a name). */
function resolveScriptFile(ref: string, cwd: string): string {
  if (looksLikePath(ref)) {
    const direct = resolve(cwd, ref)
    try {
      if (statSync(direct).isFile()) return direct
    } catch {
      // try it as a name too (e.g. `team/foo`)
    }
  }
  return findWorkflow(ref, cwd)
}

/** Run options saved to `options.json` so that `resume` inherits them (model/effort are part of the cache key). */
interface StoredRunOptions {
  model?: string
  effort?: EffortLevel
  concurrency?: number
  maxAgents?: number
  maxOutputTokens?: number
  maxUsd?: number
  permissionMode?: PermissionMode
}

function readStoredOptions(runDir: string): StoredRunOptions {
  try {
    const v = JSON.parse(readFileSync(join(runDir, 'options.json'), 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as StoredRunOptions) : {}
  } catch {
    return {}
  }
}

/** Explicitly given options take precedence; missing ones are filled in from the stored options (only on resume). */
function mergeOptions(opts: RunOptions, stored: StoredRunOptions): StoredRunOptions {
  const out: StoredRunOptions = { ...stored }
  if (opts.model !== undefined) out.model = opts.model
  if (opts.effort !== undefined) out.effort = opts.effort
  if (opts.concurrency !== undefined) out.concurrency = opts.concurrency
  if (opts.maxAgents !== undefined) out.maxAgents = opts.maxAgents
  if (opts.maxOutputTokens !== undefined) out.maxOutputTokens = opts.maxOutputTokens
  if (opts.maxUsd !== undefined) out.maxUsd = opts.maxUsd
  if (opts.permissionMode !== undefined) out.permissionMode = opts.permissionMode
  return out
}

function pathKey(path: string[]): string {
  return path.join('\u0000')
}

// ───────────────────────── main functions ─────────────────────────

/** Is the process with the given pid alive? (EPERM = it exists, we just lack the permission to signal it.) */

/**
 * Lock on the run directory against a concurrent `resume` (two processes would overwrite each other's run.json and agent artifacts).
 * A lock held by a dead pid (killed process) is overwritten. Returns a release function.
 */
async function acquireRunLock(runDir: string, runId: string): Promise<() => void> {
  const file = join(runDir, '.lock')
  const payload = JSON.stringify({ ...currentLockHolder(), ts: new Date().toISOString() })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(file, payload, { encoding: 'utf8', flag: 'wx' })
      return () => {
        try {
          rmSync(file, { force: true })
        } catch {
          // lock cleanup is not critical
        }
      }
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err
    }
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue // the lock disappeared meanwhile → retry
    }
    let holder: LockHolder | null = null
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown; start?: unknown }
      const pid = Number(parsed.pid)
      if (Number.isInteger(pid) && pid > 0) holder = { pid, ...(typeof parsed.start === 'string' ? { start: parsed.start } : {}) }
    } catch {
      // corrupt/empty lock: treat it as abandoned
    }
    if (holder && lockHolderAlive(holder)) {
      throw new UltracodeError('RUN_LOCKED', `Run “${runId}” is currently in use by another process (pid ${holder.pid}). Wait for it to finish or stop it.`)
    }
    // We do NOT delete the abandoned lock directly: two processes would delete each other's lock (TOCTOU).
    // We rename it to a unique name (a rename succeeds only once) and verify that we moved exactly the abandoned lock.
    const parked = `${file}.stale-${process.pid}-${randomBytes(6).toString('hex')}`
    try {
      renameSync(file, parked)
    } catch (err) {
      if (errorCode(err) === 'ENOENT') continue
      throw err
    }
    let moved: string | null = null
    try {
      moved = readFileSync(parked, 'utf8')
    } catch {
      // ignoruj
    }
    if (moved === raw) {
      rmSync(parked, { force: true })
      continue
    }
    // Meanwhile someone locked freshly and we moved their lock: put it back (the link fails if another lock already exists).
    try {
      linkSync(parked, file)
    } catch {
      // ignoruj
    }
    rmSync(parked, { force: true })
    throw new UltracodeError('RUN_LOCKED', `Run “${runId}” was just locked by another process. Try again in a moment.`)
  }
  throw new UltracodeError('RUN_LOCKED', `Failed to lock run “${runId}”.`)
}

export async function runWorkflow(opts: RunOptions, deps: EngineDeps = {}): Promise<RunSummary> {
  const lock: { release?: () => void } = {}
  try {
    return await runWorkflowImpl(opts, deps, lock)
  } finally {
    lock.release?.()
  }
}

async function runWorkflowImpl(opts: RunOptions, deps: EngineDeps, lock: { release?: () => void }): Promise<RunSummary> {
  const cwd = resolve(opts.cwd ?? process.cwd())
  const userSignal = opts.signal
  const abortGraceMs = deps.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS

  // ── 1) usage check: resume, script, arguments (before any write to disk) ──
  const resumed = opts.resumeRunId !== undefined
  let runId: string
  let runDir: string
  if (resumed) {
    runId = String(opts.resumeRunId)
    if (!isSafeRunId(runId)) throw new UltracodeError('RUN_NOT_FOUND', `Invalid run ID “${runId}”.`)
    runDir = runDirOf(cwd, runId)
    if (!isDirectory(runDir) || !(existsSync(join(runDir, 'run.json')) || existsSync(join(runDir, 'journal.jsonl')) || existsSync(join(runDir, 'events.jsonl')))) {
      throw new UltracodeError('RUN_NOT_FOUND', `Run “${runId}” not found in ${runsRoot(cwd)}.`)
    }
  } else {
    runId = ''
    runDir = ''
    if (opts.runId !== undefined && !isSafeRunId(opts.runId)) {
      throw new UltracodeError('INVALID_RUN_ID', `Invalid run ID “${opts.runId}” (allowed: letters, digits, “.”, “_”, “-”).`)
    }
  }

  const ref = (opts.workflow ?? '').trim()
  let scriptPath: string
  let usingStoredCopy = false
  if (ref) {
    scriptPath = resolveScriptFile(ref, cwd)
  } else if (resumed) {
    const stored = findStoredScript(runDir)
    if (!stored) throw new UltracodeError('SCRIPT_MISSING', `Run “${runId}” has no stored copy of the script; specify the workflow explicitly.`)
    scriptPath = stored
    usingStoredCopy = true
  } else {
    throw new UltracodeError('USAGE', 'No workflow specified (neither a script path nor a name).')
  }

  let source: string
  try {
    source = await readFile(scriptPath, 'utf8')
  } catch (err) {
    throw new WorkflowNotFoundError(ref || scriptPath, [scriptPath + ` (${(err as Error).message})`])
  }

  const args: unknown = opts.args !== undefined ? opts.args : resumed ? readStoredArgs(runDir) : undefined

  // ── 2) parse + validace ──
  const parse = deps.parseScript ?? (await loadParseScript())
  const parsed = parse(source, scriptPath)
  if (!parsed.ok) {
    const errors = parsed.diagnostics.filter((d) => d.level === 'error')
    const lines = (errors.length > 0 ? errors : parsed.diagnostics).map((d) => (d.line !== undefined ? `line ${d.line}: ${d.message}` : d.message))
    throw new ScriptValidationError(`Invalid script ${basename(scriptPath)}: ${lines[0] ?? 'unknown error'}`, lines)
  }
  const meta: WorkflowMeta = parsed.meta ?? { name: basename(scriptPath).replace(/(\.workflow)?\.[cm]?[jt]s$/, ''), description: '' }
  const warnings = parsed.diagnostics.filter((d) => d.level === 'warning')

  const runScriptFn = deps.runScript ?? (await loadRunScript())
  const runner: ClaudeRunner = opts.runner ?? (await loadRunner())

  // ── 3) run directory ──
  if (!resumed) {
    await mkdir(runsRoot(cwd), { recursive: true })
    for (let attempt = 0; ; attempt++) {
      const candidate = opts.runId ?? generateRunId()
      try {
        await mkdir(runDirOf(cwd, candidate))
        runId = candidate
        runDir = runDirOf(cwd, candidate)
        break
      } catch (err) {
        if (errorCode(err) === 'EEXIST') {
          if (opts.runId !== undefined) throw new UltracodeError('RUN_EXISTS', `Run “${candidate}” already exists.`)
          if (attempt < 10) continue
        }
        throw err
      }
    }
  }

  // lock against concurrent use of the same run (resume in two processes)
  lock.release = await acquireRunLock(runDir, runId)

  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const effectiveScriptPath = scriptPath

  // copy of the script + args (not overwritten on resume when a stored copy exists)
  if (!usingStoredCopy) {
    const ext = SCRIPT_EXTENSIONS.includes(extname(scriptPath)) ? extname(scriptPath) : '.ts'
    const copyName = `script${ext}`
    try {
      for (const f of readdirSync(runDir)) {
        if (/^script\.[a-z]+$/.test(f) && f !== copyName) await rm(join(runDir, f), { force: true })
      }
    } catch {
      // cleanup of old copies is not critical
    }
    await writeFile(join(runDir, copyName), source, 'utf8')
  }
  // args.json: always written for a new run; on resume only with explicit args (or when the file is missing)
  if (!resumed || opts.args !== undefined || !existsSync(join(runDir, 'args.json'))) {
    await writeFileAtomic(join(runDir, 'args.json'), JSON.stringify(args === undefined ? null : args, null, 2) + '\n')
  }

  // run options: on resume, missing ones are inherited from options.json (model/effort are in the cache key, otherwise resume would run again)
  const eff = mergeOptions(opts, resumed ? readStoredOptions(runDir) : {})
  try {
    await writeFileAtomic(join(runDir, 'options.json'), JSON.stringify(eff, null, 2) + '\n')
  } catch {
    // saving options is not critical
  }

  // ── 4) run state ──
  const totals: RunTotals = emptyTotals()
  let budgetExceeded = false
  let status: RunStatus = 'running'
  let runError: string | undefined
  let runResult: unknown
  let endedAt = ''
  let durationMs = 0

  const limitTokens = typeof eff.maxOutputTokens === 'number' && Number.isFinite(eff.maxOutputTokens) && eff.maxOutputTokens >= 0 ? eff.maxOutputTokens : null
  const limitUsd = typeof eff.maxUsd === 'number' && Number.isFinite(eff.maxUsd) && eff.maxUsd >= 0 ? eff.maxUsd : null
  const maxAgents = typeof eff.maxAgents === 'number' && Number.isFinite(eff.maxAgents) && eff.maxAgents >= 0 ? Math.floor(eff.maxAgents) : DEFAULT_MAX_AGENTS
  let spentTokens = 0
  let spentUsd = 0

  const budgetBuffer = new SharedArrayBuffer(BUDGET_SLOTS * Float64Array.BYTES_PER_ELEMENT)
  const budgetView = new Float64Array(budgetBuffer)
  budgetView[0] = 0
  budgetView[1] = limitTokens ?? -1
  budgetView[2] = 0
  budgetView[3] = limitUsd ?? -1

  const warnedWriteErrors = new Set<string>()
  const onWriteError = (what: string) => (err: unknown) => {
    if (warnedWriteErrors.has(what)) return
    warnedWriteErrors.add(what)
    safeCallback({ t: 'log', ts: nowIso(), message: `Warning: writing file ${what} failed (${(err as Error)?.message ?? err}).`, workflowPath: [meta.name] })
  }
  const safeCallback = (e: RunEvent) => {
    try {
      opts.onEvent?.(e)
    } catch {
      // an error in onEvent must not affect the run
    }
  }

  if (resumed) {
    // a truncated last line after a killed process must not be glued to the next record
    await ensureTrailingNewline(join(runDir, 'journal.jsonl')).catch(() => {})
    await ensureTrailingNewline(join(runDir, 'events.jsonl')).catch(() => {})
  }
  const events = new JsonlAppender(join(runDir, 'events.jsonl'), onWriteError('events.jsonl'))
  const journalWriter = new JsonlAppender(join(runDir, 'journal.jsonl'), onWriteError('journal.jsonl'))
  // after the run is closed (run_end) nothing more is written — delayed calls from a hanging script/agent must not
  // add events after run_end or overwrite the final run.json
  let closed = false
  const emit = (e: RunEvent): void => {
    if (closed) return
    void events.append(e)
    safeCallback(e)
  }
  /** Only to the listener (high-volume agent log; the agent's own stream.jsonl keeps it on disk). */
  const emitLive = (e: RunEvent): void => {
    if (closed || !opts.onEvent) return
    safeCallback(e)
  }

  const currentSummary = (): RunSummary => {
    const running = status === 'running'
    const s: RunSummary = {
      runId,
      name: meta.name,
      status,
      startedAt,
      endedAt: running ? '' : endedAt,
      durationMs: running ? Date.now() - startedAtMs : durationMs,
      runDir,
      scriptPath: effectiveScriptPath,
      totals: cloneTotals(totals),
    }
    if (status === 'completed') s.result = runResult === undefined ? null : runResult
    if (runError !== undefined) s.error = runError
    if (budgetExceeded) s.budgetExceeded = true
    return s
  }
  const runJson = new StateFileWriter(join(runDir, 'run.json'), currentSummary, onWriteError('run.json'))

  // cache from the journal of the original run (resume only); load it BEFORE adding new records
  const cache = resumed ? await JournalCache.load(join(runDir, 'journal.jsonl')) : new JournalCache()

  // agent ids continue from earlier runs (events.jsonl + agents/<n>/ directories), so that resume does not overwrite artifacts
  let agentSeq = 0
  if (resumed) {
    for (const e of readEvents(cwd, runId)) {
      if (e.t === 'agent_start' && e.id > agentSeq) agentSeq = e.id
    }
    try {
      for (const d of readdirSync(join(runDir, 'agents'))) {
        const n = Number(d)
        if (Number.isInteger(n) && n > agentSeq) agentSeq = n
      }
    } catch {
      // no agents/ → nothing more to do
    }
  }

  // ── 5) hooks ──
  const internalAbort = new AbortController()
  const runSignal: AbortSignal = userSignal ? AbortSignal.any([userSignal, internalAbort.signal]) : internalAbort.signal
  const concurrencyLimit = resolveConcurrency(eff.concurrency)
  const agentis = opts.agentis === undefined ? resolveAgentisTelemetry() : opts.agentis
  const semaphore = new Semaphore(concurrencyLimit)
  // USD budget: sum of the caps allocated to running agents (reservations), so that concurrent agents do not each draw the whole remainder.
  let reservedUsd = 0
  let runningAgents = 0
  // agents waiting for a reservation to be released (if the remaining budget cannot be split, they wait instead of failing)
  const budgetWaiters: Array<() => void> = []
  const inflight = new Set<Promise<unknown>>()
  const seqByKey = new Map<string, number>()
  const phaseByPath = new Map<string, string>()
  let agentCalls = 0

  const currentPhase = (path: string[]): string | null => {
    for (let i = path.length; i >= 1; i--) {
      const p = phaseByPath.get(pathKey(path.slice(0, i)))
      if (p !== undefined) return p
    }
    return null
  }

  const budgetError = (message: string, call: HookCall): BudgetExceededError => {
    if (!budgetExceeded) {
      budgetExceeded = true
      emit({ t: 'log', ts: nowIso(), message: `Limit exceeded: ${message}`, workflowPath: call.workflowPath })
    }
    return new BudgetExceededError(message)
  }

  const checkBudget = (call: HookCall): void => {
    if (limitTokens !== null && spentTokens >= limitTokens) {
      throw budgetError(`Output token budget exhausted (${spentTokens} of ${limitTokens}).`, call)
    }
    if (limitUsd !== null && spentUsd >= limitUsd) {
      throw budgetError(`USD budget exhausted (${spentUsd.toFixed(4)} of ${limitUsd}).`, call)
    }
  }

  const publishBudget = (): void => {
    budgetView[0] = spentTokens
    budgetView[2] = spentUsd
    emit({ t: 'budget', ts: nowIso(), spentOutputTokens: spentTokens, spentUsd, limitOutputTokens: limitTokens, limitUsd })
  }

  const runAgent = async (prompt: string, aopts: AgentOptions, call: HookCall): Promise<unknown> => {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw new UltracodeError('INVALID_PROMPT', 'agent(): prompt must be a non-empty string.')
    }
    if (runSignal.aborted) return null
    if ((aopts as { isolation?: unknown }).isolation !== undefined) {
      throw new UltracodeError('UNSUPPORTED_OPTION', 'agent(): the `isolation` option (worktree) is not supported in v1; split the work between agents by path (partitions).')
    }

    // (1) agent limit and budget
    if (agentCalls >= maxAgents) {
      throw budgetError(`Agent limit of ${maxAgents} per run exceeded.`, call)
    }
    agentCalls++
    // the budget is checked only just before the real start (after the cache): an already paid result must not break resume

    // effective values
    const model = aopts.model ?? eff.model
    const effort = aopts.effort ?? eff.effort
    const agentCwd = aopts.cwd ? resolve(cwd, aopts.cwd) : cwd
    const phase = aopts.phase ?? currentPhase(call.workflowPath)
    const label = aopts.label && aopts.label.trim() ? aopts.label : deriveLabel(prompt)

    // (2) cache lookup
    const key = computeCallKey({
      prompt,
      schema: aopts.schema ?? null,
      model,
      effort,
      // relative to the project: moving/renaming the project must not invalidate the cache
      cwd: relative(cwd, agentCwd) || '.',
      tools: aopts.tools,
      disallowedTools: aopts.disallowedTools,
      systemPrompt: aopts.systemPrompt,
    })
    const seq = seqByKey.get(key) ?? 0
    seqByKey.set(key, seq + 1)

    if (resumed && !aopts.noCache) {
      const hit = cache.lookup(key, seq)
      if (hit) {
        const id = ++agentSeq
        emit({ t: 'agent_start', ts: nowIso(), id, label, phase, workflowPath: call.workflowPath, ...(model !== undefined ? { model } : {}), promptPreview: previewOf(prompt) })
        const hitUsage = sanitizeUsage(hit.usage)
        const hitCost = num(hit.costUsd)
        totals.agents++
        totals.cachedAgents++
        addUsage(totals.usage, hitUsage)
        totals.costUsd += hitCost
        totals.toolCalls += num(hit.toolCalls)
        spentTokens += hitUsage.outputTokens
        spentUsd += hitCost
        publishBudget()
        emit({ t: 'agent_done', ts: nowIso(), id, ok: true, cached: true, durationMs: 0, usage: hitUsage, costUsd: hitCost, toolCalls: num(hit.toolCalls) })
        void runJson.request()
        return hit.result
      }
    }

    // (3) concurrency semaphore
    let release: () => void
    try {
      release = await semaphore.acquire(runSignal)
    } catch {
      return null // aborted while waiting
    }
    runningAgents++
    let myCap = 0
    try {
      if (runSignal.aborted) return null
      // the budget may have been exhausted while waiting → check again (guards agents starting concurrently)
      checkBudget(call)

      // (4) start the agent
      const id = ++agentSeq
      emit({ t: 'agent_start', ts: nowIso(), id, label, phase, workflowPath: call.workflowPath, ...(model !== undefined ? { model } : {}), promptPreview: previewOf(prompt) })

      let maxBudgetUsd = aopts.maxUsd
      if (limitUsd !== null) {
        let avail = limitUsd - spentUsd - reservedUsd
        while (avail <= 0) {
          // nothing to split: either we wait for running agents (they return their reservation), or the budget is really exhausted
          if (reservedUsd <= 0 || runSignal.aborted) throw budgetError(`USD budget exhausted (${spentUsd.toFixed(4)} of ${limitUsd}).`, call)
          await new Promise<void>((resolveWait) => budgetWaiters.push(resolveWait))
          if (runSignal.aborted) return null
          checkBudget(call)
          avail = limitUsd - spentUsd - reservedUsd
        }
        // share based on actual demand (running + waiting agents); the sum of allocated caps will not exceed the remaining budget
        const share = avail / Math.max(1, runningAgents + semaphore.waiting)
        maxBudgetUsd = maxBudgetUsd === undefined ? share : Math.min(maxBudgetUsd, share)
        myCap = maxBudgetUsd
        reservedUsd += myCap
      }
      const req: ClaudeRunRequest = {
        prompt,
        cwd: agentCwd,
        outDir: join(runDir, 'agents', String(id)),
        signal: runSignal,
        onProgress: (p) => {
          if (p.kind === 'tool') emit({ t: 'agent_tool', ts: nowIso(), id, tool: p.name })
          else if (p.kind === 'retry') {
            emit({
              t: 'agent_retry',
              ts: nowIso(),
              id,
              attempt: p.attempt,
              reason: p.reason,
              ...(p.resumeSessionId ? { resumeSessionId: p.resumeSessionId } : {}),
            })
          } else if (p.kind === 'event') emitLive({ t: 'agent_event', ts: nowIso(), id, label, attempt: p.attempt, event: p.event })
        },
      }
      if (opts.claudeBin) req.bin = opts.claudeBin
      if (agentis) {
        req.agentis = agentis
        req.title = `${phase ? `[${phase}] ` : ''}${label} #${id}`
      }
      if (model !== undefined) req.model = model
      if (effort !== undefined) req.effort = effort
      if (aopts.schema !== undefined) req.schema = aopts.schema
      if (aopts.systemPrompt !== undefined) req.appendSystemPrompt = aopts.systemPrompt
      if (aopts.tools !== undefined) req.allowedTools = aopts.tools
      if (aopts.disallowedTools !== undefined) req.disallowedTools = aopts.disallowedTools
      // `--allowedTools` restricts nothing under bypassPermissions (verified). If the script gives `tools`, we want a real whitelist,
      // so the agent runs in `dontAsk` (anything outside the list is rejected without asking), unless the caller explicitly chose a mode.
      // Even an empty list `tools: []` is an explicit choice → dontAsk (otherwise the agent would get all tools).
      if (eff.permissionMode !== undefined) req.permissionMode = eff.permissionMode
      else if (aopts.tools !== undefined) req.permissionMode = 'dontAsk'
      if (maxBudgetUsd !== undefined) req.maxBudgetUsd = maxBudgetUsd
      if (aopts.stallMs !== undefined) req.stallMs = aopts.stallMs
      if (aopts.timeoutMs !== undefined) req.timeoutMs = aopts.timeoutMs

      const t0 = Date.now()
      let r: ClaudeRunResult
      try {
        r = await runner(req)
      } catch (err) {
        r = {
          ok: false,
          text: null,
          structured: undefined,
          usage: { ...EMPTY_USAGE },
          costUsd: 0,
          numTurns: 0,
          toolCalls: 0,
          durationMs: Date.now() - t0,
          attempts: 0,
          error: { kind: runSignal.aborted ? 'aborted' : 'spawn', message: (err as Error)?.message ?? String(err) },
        }
      }

      if (closed) return null // the run is already closed (e.g. after the grace period on abort)

      const usage = sanitizeUsage(r.usage)
      const costUsd = num(r.costUsd)
      const toolCalls = num(r.toolCalls)
      let ok = r.ok === true
      let errorText: string | undefined
      let value: unknown = null
      if (ok) {
        if (aopts.schema !== undefined) {
          if (r.structured === undefined || r.structured === null) {
            ok = false
            errorText = 'schema: agent did not return structured output.'
          } else {
            value = r.structured
          }
        } else {
          value = r.text ?? ''
        }
      } else {
        errorText = r.error ? `${r.error.kind}: ${r.error.message}` : 'agent failed'
      }

      // (5) journal (ok only), totals, budget, events
      if (ok) {
        const entry: JournalEntry = {
          key,
          seq,
          ok: true,
          label,
          result: value,
          usage,
          costUsd,
          ts: nowIso(),
          id,
          durationMs: num(r.durationMs),
          toolCalls,
        }
        if (r.sessionId !== undefined) entry.sessionId = r.sessionId
        await journalWriter.append(entry)
      }
      totals.agents++
      if (!ok) totals.failedAgents++
      totals.toolCalls += toolCalls
      addUsage(totals.usage, usage)
      totals.costUsd += costUsd
      spentTokens += usage.outputTokens
      spentUsd += costUsd

      emit({
        t: 'agent_done',
        ts: nowIso(),
        id,
        ok,
        cached: false,
        durationMs: num(r.durationMs) || Date.now() - t0,
        usage,
        costUsd,
        toolCalls,
        ...(errorText !== undefined ? { error: errorText } : {}),
      })
      publishBudget()
      void runJson.request()
      return ok ? value : null
    } finally {
      runningAgents--
      reservedUsd -= myCap
      for (const wake of budgetWaiters.splice(0)) wake()
      release()
    }
  }

  const trackedAgent = (prompt: string, aopts: AgentOptions, call: HookCall): Promise<unknown> => {
    const p = runAgent(prompt, aopts ?? {}, call)
    const tracker = p.then(
      () => undefined,
      () => undefined,
    )
    inflight.add(tracker)
    void tracker.then(() => inflight.delete(tracker))
    return p
  }

  const hooks: ScriptHooks = {
    agent: trackedAgent,
    phase(title, call) {
      phaseByPath.set(pathKey(call.workflowPath), title)
      emit({ t: 'phase', ts: nowIso(), title, workflowPath: call.workflowPath })
    },
    log(message, call) {
      emit({ t: 'log', ts: nowIso(), message: String(message), workflowPath: call.workflowPath })
    },
    async loadWorkflow(refOrObj, _call): Promise<LoadedScript> {
      const file = typeof refOrObj === 'string' ? resolveScriptFile(refOrObj, cwd) : resolve(cwd, refOrObj.scriptPath)
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch {
        throw new WorkflowNotFoundError(typeof refOrObj === 'string' ? refOrObj : refOrObj.scriptPath, [file])
      }
      return { source: text, filename: file }
    },
    workflowEnter(name, call) {
      phaseByPath.delete(pathKey(call.workflowPath))
      emit({ t: 'workflow_enter', ts: nowIso(), name, workflowPath: call.workflowPath })
    },
    workflowExit(name, call) {
      phaseByPath.delete(pathKey(call.workflowPath))
      emit({ t: 'workflow_exit', ts: nowIso(), name, workflowPath: call.workflowPath })
    },
  }

  // ── 6) start ──
  const phases: PhaseMeta[] = Array.isArray(meta.phases) ? meta.phases : []
  await runJson.request() // run.json (status running) exists before the first agent
  emit({
    t: 'run_start',
    ts: startedAt,
    runId,
    name: meta.name,
    description: meta.description ?? '',
    args: args === undefined ? null : args,
    cwd,
    scriptPath: effectiveScriptPath,
    resumed,
    phases,
  })
  for (const w of warnings) {
    emit({ t: 'log', ts: nowIso(), message: `Script warning${w.line !== undefined ? ` (line ${w.line})` : ''}: ${w.message}`, workflowPath: [meta.name] })
  }

  let scriptError: unknown
  let scriptFailed = false
  const raceWithTimeout = async (p: Promise<unknown>, ms: number): Promise<void> => {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>((res) => {
      timer = setTimeout(res, ms)
    })
    try {
      await Promise.race([p, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  try {
    if (userSignal?.aborted) {
      // aborted before the script started
    } else {
      const req: RunScriptRequest = { source, filename: scriptPath, args, hooks, budgetBuffer, signal: runSignal }
      const scriptPromise = Promise.resolve().then(() => runScriptFn(req))
      let graceTimer: NodeJS.Timeout | undefined
      let onAbort: (() => void) | undefined
      const guarded = new Promise<RunScriptResult>((resolveG, rejectG) => {
        scriptPromise.then(resolveG, rejectG)
        if (userSignal) {
          onAbort = () => {
            graceTimer = setTimeout(() => rejectG(new AbortedError(`Script did not finish within ${abortGraceMs} ms after the abort.`)), abortGraceMs)
          }
          if (userSignal.aborted) onAbort()
          else userSignal.addEventListener('abort', onAbort, { once: true })
        }
      })
      try {
        const res = await guarded
        runResult = res.value === undefined ? null : res.value
      } finally {
        if (graceTimer) clearTimeout(graceTimer)
        if (onAbort) userSignal?.removeEventListener('abort', onAbort)
      }
    }
  } catch (err) {
    scriptFailed = true
    scriptError = err
  }

  // clean up remaining agents (unexpected/not awaited) and wait until their processes end
  internalAbort.abort()
  if (inflight.size > 0) {
    await raceWithTimeout(Promise.allSettled([...inflight]), abortGraceMs)
  }

  // ── 7) close the run ──
  const aborted = userSignal?.aborted === true
  if (aborted) {
    status = 'aborted'
    runError = 'Run was aborted.'
  } else if (scriptFailed) {
    status = 'failed'
    runError = describeError(scriptError)
    if (errorCode(scriptError) === 'BUDGET_EXCEEDED') budgetExceeded = true
  } else {
    status = 'completed'
  }
  const endedMs = Date.now()
  endedAt = new Date(endedMs).toISOString()
  durationMs = endedMs - startedAtMs

  if (status === 'completed') {
    try {
      await writeFileAtomic(join(runDir, 'result.json'), JSON.stringify(runResult === undefined ? null : runResult, null, 2) + '\n')
    } catch (err) {
      onWriteError('result.json')(err)
    }
  }
  emit({ t: 'run_end', ts: endedAt, status, durationMs, totals: cloneTotals(totals), ...(runError !== undefined ? { error: runError } : {}) })
  closed = true
  await events.flush()
  await journalWriter.flush()
  await runJson.request()

  // An invalid script before the first agent is a usage error; if it only surfaces in a nested workflow after agents have spent budget,
  // the run ends as failed with its result (otherwise the spending would be lost and no output produced).
  if (scriptFailed && scriptError instanceof ScriptValidationError && agentCalls === 0) throw scriptError
  return currentSummary()
}

// ───────────────────────── lazy dependency loading ─────────────────────────

async function loadParseScript(): Promise<(source: string, filename: string) => ParsedScriptLike> {
  const mod = (await import('../script/parse.ts')) as { parseScript: (source: string, filename: string) => ParsedScriptLike }
  return mod.parseScript
}

async function loadRunScript(): Promise<(req: RunScriptRequest) => Promise<RunScriptResult>> {
  const mod = (await import('../script/host.ts')) as { runScript: (req: RunScriptRequest) => Promise<RunScriptResult> }
  return mod.runScript
}

async function loadRunner(): Promise<ClaudeRunner> {
  const mod = (await import('../runner/claude.ts')) as { runClaude: ClaudeRunner }
  return mod.runClaude
}
