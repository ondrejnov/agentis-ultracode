/**
 * Orchestrace jednoho běhu workflow: najde a ověří skript, založí adresář běhu, implementuje `ScriptHooks`
 * (limity, rozpočet, cache z journalu, semafor souběžnosti, runner), zapisuje události/journal/run.json
 * a na konci vrací `RunSummary`.
 *
 * `runWorkflow` NEHÁZÍ pro selhání skriptu ani agentů (vrací summary se stavem `failed`/`aborted`);
 * hází jen pro chybné použití: neexistující workflow/běh, neplatný skript (ScriptValidationError).
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

// ───────────────────────── veřejné typy ─────────────────────────

/** Strukturální podoba výsledku `parseScript` (src/script/parse.ts) — záměrně bez importu typu. */
export interface ParsedScriptLike {
  ok: boolean
  meta: WorkflowMeta | null
  diagnostics: Array<{ level: 'error' | 'warning'; message: string; line?: number }>
  code?: string
}

export interface EngineDeps {
  /** Injektovaný host skriptu (default `runScript` ze src/script/host.ts). */
  runScript?: (req: RunScriptRequest) => Promise<RunScriptResult>
  /** Injektovaný parser (default `parseScript` ze src/script/parse.ts). */
  parseScript?: (source: string, filename: string) => ParsedScriptLike
  /** Jak dlouho po přerušení čekat na doběhnutí skriptu/agentů, než se běh uzavře (default 10 000 ms). */
  abortGraceMs?: number
}

export const DEFAULT_MAX_AGENTS = 1000
const DEFAULT_ABORT_GRACE_MS = 10_000
const SCRIPT_EXTENSIONS = ['.ts', '.js', '.mjs', '.mts', '.cjs', '.cts']

// ───────────────────────── pomocné funkce ─────────────────────────

/** `wf_<8 hex>-<3 hex>` jako v Claude Code. */
export function generateRunId(): string {
  return `wf_${randomBytes(4).toString('hex')}-${randomInt(0x1000).toString(16).padStart(3, '0')}`
}

/** Souběžnost: `opts.concurrency` > env `ULTRACODE_MAX_CONCURRENCY` > `min(16, max(1, cpus-2))`. */
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

/** Čitelný popis chyby včetně (zkráceného) stacku; zvládne i chyby serializované přes worker (prosté objekty). */
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

/** Nalezne zdrojový soubor skriptu pro `opts.workflow` (cesta nebo jméno). */
function resolveScriptFile(ref: string, cwd: string): string {
  if (looksLikePath(ref)) {
    const direct = resolve(cwd, ref)
    try {
      if (statSync(direct).isFile()) return direct
    } catch {
      // zkusíme ještě jako jméno (např. `team/foo`)
    }
  }
  return findWorkflow(ref, cwd)
}

/** Volby běhu, které se ukládají do `options.json`, aby je `resume` zdědil (model/effort jsou součástí klíče cache). */
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

/** Explicitně zadané volby mají přednost, chybějící se doplní z uložených (jen při resume). */
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

// ───────────────────────── hlavní funkce ─────────────────────────

/** Je proces s daným pid naživu? (EPERM = existuje, jen nemáme právo mu signalizovat.) */

/**
 * Zámek adresáře běhu proti souběžnému `resume` (dva procesy by si přepisovaly run.json a artefakty agentů).
 * Zámek s mrtvým pid (zabitý proces) se přepíše. Vrací funkci pro uvolnění.
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
          // úklid zámku není kritický
        }
      }
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err
    }
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue // zámek mezitím zmizel → zkus znovu
    }
    let holder: LockHolder | null = null
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown; start?: unknown }
      const pid = Number(parsed.pid)
      if (Number.isInteger(pid) && pid > 0) holder = { pid, ...(typeof parsed.start === 'string' ? { start: parsed.start } : {}) }
    } catch {
      // poškozený/prázdný zámek: bereme jako opuštěný
    }
    if (holder && lockHolderAlive(holder)) {
      throw new UltracodeError('RUN_LOCKED', `Běh „${runId}“ právě používá jiný proces (pid ${holder.pid}). Počkej na jeho dokončení nebo ho ukonči.`)
    }
    // Opuštěný zámek NEMAŽEME přímo: dva procesy by si smazaly zámek jeden druhého (TOCTOU).
    // Přejmenujeme ho na unikátní jméno – přejmenovat jde jen jednou – a ověříme, že jsme přesunuli právě ten opuštěný.
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
    // Mezitím někdo zamkl čerstvě a přesunuli jsme jeho zámek: vrátíme ho zpět (link selže, pokud už jiný zámek existuje).
    try {
      linkSync(parked, file)
    } catch {
      // ignoruj
    }
    rmSync(parked, { force: true })
    throw new UltracodeError('RUN_LOCKED', `Běh „${runId}“ právě zamkl jiný proces. Zkus to znovu za chvíli.`)
  }
  throw new UltracodeError('RUN_LOCKED', `Běh „${runId}“ se nepodařilo zamknout.`)
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

  // ── 1) kontrola použití: resume, skript, argumenty (před jakýmkoli zápisem na disk) ──
  const resumed = opts.resumeRunId !== undefined
  let runId: string
  let runDir: string
  if (resumed) {
    runId = String(opts.resumeRunId)
    if (!isSafeRunId(runId)) throw new UltracodeError('RUN_NOT_FOUND', `Neplatné ID běhu „${runId}“.`)
    runDir = runDirOf(cwd, runId)
    if (!isDirectory(runDir) || !(existsSync(join(runDir, 'run.json')) || existsSync(join(runDir, 'journal.jsonl')) || existsSync(join(runDir, 'events.jsonl')))) {
      throw new UltracodeError('RUN_NOT_FOUND', `Běh „${runId}“ nenalezen v ${runsRoot(cwd)}.`)
    }
  } else {
    runId = ''
    runDir = ''
    if (opts.runId !== undefined && !isSafeRunId(opts.runId)) {
      throw new UltracodeError('INVALID_RUN_ID', `Neplatné ID běhu „${opts.runId}“ (povolena písmena, číslice, „.“, „_“, „-“).`)
    }
  }

  const ref = (opts.workflow ?? '').trim()
  let scriptPath: string
  let usingStoredCopy = false
  if (ref) {
    scriptPath = resolveScriptFile(ref, cwd)
  } else if (resumed) {
    const stored = findStoredScript(runDir)
    if (!stored) throw new UltracodeError('SCRIPT_MISSING', `Běh „${runId}“ nemá uloženou kopii skriptu; zadej workflow explicitně.`)
    scriptPath = stored
    usingStoredCopy = true
  } else {
    throw new UltracodeError('USAGE', 'Není zadáno workflow (cesta ke skriptu ani jméno).')
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
    const lines = (errors.length > 0 ? errors : parsed.diagnostics).map((d) => (d.line !== undefined ? `řádek ${d.line}: ${d.message}` : d.message))
    throw new ScriptValidationError(`Neplatný skript ${basename(scriptPath)}: ${lines[0] ?? 'neznámá chyba'}`, lines)
  }
  const meta: WorkflowMeta = parsed.meta ?? { name: basename(scriptPath).replace(/(\.workflow)?\.[cm]?[jt]s$/, ''), description: '' }
  const warnings = parsed.diagnostics.filter((d) => d.level === 'warning')

  const runScriptFn = deps.runScript ?? (await loadRunScript())
  const runner: ClaudeRunner = opts.runner ?? (await loadRunner())

  // ── 3) adresář běhu ──
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
          if (opts.runId !== undefined) throw new UltracodeError('RUN_EXISTS', `Běh „${candidate}“ už existuje.`)
          if (attempt < 10) continue
        }
        throw err
      }
    }
  }

  // zámek proti souběžnému použití stejného běhu (resume ve dvou procesech)
  lock.release = await acquireRunLock(runDir, runId)

  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const effectiveScriptPath = scriptPath

  // kopie skriptu + args (u resume s uloženou kopií se nepřepisují)
  if (!usingStoredCopy) {
    const ext = SCRIPT_EXTENSIONS.includes(extname(scriptPath)) ? extname(scriptPath) : '.ts'
    const copyName = `script${ext}`
    try {
      for (const f of readdirSync(runDir)) {
        if (/^script\.[a-z]+$/.test(f) && f !== copyName) await rm(join(runDir, f), { force: true })
      }
    } catch {
      // úklid starých kopií není kritický
    }
    await writeFile(join(runDir, copyName), source, 'utf8')
  }
  // args.json: nový běh vždy; resume jen při explicitních args (nebo když soubor chybí)
  if (!resumed || opts.args !== undefined || !existsSync(join(runDir, 'args.json'))) {
    await writeFileAtomic(join(runDir, 'args.json'), JSON.stringify(args === undefined ? null : args, null, 2) + '\n')
  }

  // volby běhu: při resume se chybějící zdědí z options.json (model/effort jsou v klíči cache, jinak by resume běžel znovu)
  const eff = mergeOptions(opts, resumed ? readStoredOptions(runDir) : {})
  try {
    await writeFileAtomic(join(runDir, 'options.json'), JSON.stringify(eff, null, 2) + '\n')
  } catch {
    // ukládání voleb není kritické
  }

  // ── 4) stav běhu ──
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
    safeCallback({ t: 'log', ts: nowIso(), message: `Varování: zápis souboru ${what} selhal (${(err as Error)?.message ?? err}).`, workflowPath: [meta.name] })
  }
  const safeCallback = (e: RunEvent) => {
    try {
      opts.onEvent?.(e)
    } catch {
      // chyba v onEvent nesmí ovlivnit běh
    }
  }

  if (resumed) {
    // useknutý poslední řádek po zabitém procesu nesmí slepit další záznam
    await ensureTrailingNewline(join(runDir, 'journal.jsonl')).catch(() => {})
    await ensureTrailingNewline(join(runDir, 'events.jsonl')).catch(() => {})
  }
  const events = new JsonlAppender(join(runDir, 'events.jsonl'), onWriteError('events.jsonl'))
  const journalWriter = new JsonlAppender(join(runDir, 'journal.jsonl'), onWriteError('journal.jsonl'))
  // po uzavření běhu (run_end) se už nic nezapisuje — opožděná volání visícího skriptu/agenta nesmí
  // přidat události za run_end ani přepsat finální run.json
  let closed = false
  const emit = (e: RunEvent): void => {
    if (closed) return
    void events.append(e)
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

  // cache z journalu původního běhu (pouze při resume); načíst PŘED přidáním nových záznamů
  const cache = resumed ? await JournalCache.load(join(runDir, 'journal.jsonl')) : new JournalCache()

  // ids agentů navazují na dřívější běhy (events.jsonl + adresáře agents/<n>/), aby resume nepřepsal artefakty
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
      // žádné agents/ → nic dalšího
    }
  }

  // ── 5) hooks ──
  const internalAbort = new AbortController()
  const runSignal: AbortSignal = userSignal ? AbortSignal.any([userSignal, internalAbort.signal]) : internalAbort.signal
  const concurrencyLimit = resolveConcurrency(eff.concurrency)
  const semaphore = new Semaphore(concurrencyLimit)
  // Rozpočet v USD: součet stropů přidělených běžícím agentům (rezervace), aby souběžní agenti nečerpali každý celý zbytek.
  let reservedUsd = 0
  let runningAgents = 0
  // agenti čekající na uvolnění rezervace (když zbytek rozpočtu není rozdělitelný, počkají, místo aby selhali)
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
      emit({ t: 'log', ts: nowIso(), message: `Překročen limit: ${message}`, workflowPath: call.workflowPath })
    }
    return new BudgetExceededError(message)
  }

  const checkBudget = (call: HookCall): void => {
    if (limitTokens !== null && spentTokens >= limitTokens) {
      throw budgetError(`Vyčerpán rozpočet výstupních tokenů (${spentTokens} z ${limitTokens}).`, call)
    }
    if (limitUsd !== null && spentUsd >= limitUsd) {
      throw budgetError(`Vyčerpán rozpočet v USD (${spentUsd.toFixed(4)} z ${limitUsd}).`, call)
    }
  }

  const publishBudget = (): void => {
    budgetView[0] = spentTokens
    budgetView[2] = spentUsd
    emit({ t: 'budget', ts: nowIso(), spentOutputTokens: spentTokens, spentUsd, limitOutputTokens: limitTokens, limitUsd })
  }

  const runAgent = async (prompt: string, aopts: AgentOptions, call: HookCall): Promise<unknown> => {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw new UltracodeError('INVALID_PROMPT', 'agent(): prompt musí být neprázdný řetězec.')
    }
    if (runSignal.aborted) return null
    if ((aopts as { isolation?: unknown }).isolation !== undefined) {
      throw new UltracodeError('UNSUPPORTED_OPTION', 'agent(): volba `isolation` (worktree) není ve v1 podporována; rozděl práci mezi agenty po cestách (partitions).')
    }

    // (1) limit agentů a rozpočet
    if (agentCalls >= maxAgents) {
      throw budgetError(`Překročen limit ${maxAgents} agentů na běh.`, call)
    }
    agentCalls++
    // rozpočet se kontroluje až před skutečným spuštěním (za cache): už zaplacený výsledek nesmí shodit resume

    // efektivní hodnoty
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
      // relativně k projektu: přesunutí/přejmenování projektu nesmí zneplatnit cache
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

    // (3) semafor souběžnosti
    let release: () => void
    try {
      release = await semaphore.acquire(runSignal)
    } catch {
      return null // přerušeno během čekání
    }
    runningAgents++
    let myCap = 0
    try {
      if (runSignal.aborted) return null
      // během čekání se mohl rozpočet vyčerpat → znovu (hlídání souběžně startujících)
      checkBudget(call)

      // (4) spuštění agenta
      const id = ++agentSeq
      emit({ t: 'agent_start', ts: nowIso(), id, label, phase, workflowPath: call.workflowPath, ...(model !== undefined ? { model } : {}), promptPreview: previewOf(prompt) })

      let maxBudgetUsd = aopts.maxUsd
      if (limitUsd !== null) {
        let avail = limitUsd - spentUsd - reservedUsd
        while (avail <= 0) {
          // nic není k rozdělení: buď čekáme na běžící agenty (vrátí rezervaci), nebo je rozpočet opravdu vyčerpán
          if (reservedUsd <= 0 || runSignal.aborted) throw budgetError(`Vyčerpán rozpočet v USD (${spentUsd.toFixed(4)} z ${limitUsd}).`, call)
          await new Promise<void>((resolveWait) => budgetWaiters.push(resolveWait))
          if (runSignal.aborted) return null
          checkBudget(call)
          avail = limitUsd - spentUsd - reservedUsd
        }
        // podíl podle skutečné poptávky (běžící + čekající agenti); součet přidělených stropů nepřekročí zbývající rozpočet
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
          else if (p.kind === 'retry') emit({ t: 'agent_retry', ts: nowIso(), id, attempt: p.attempt, reason: p.reason })
        },
      }
      if (opts.claudeBin) req.bin = opts.claudeBin
      if (model !== undefined) req.model = model
      if (effort !== undefined) req.effort = effort
      if (aopts.schema !== undefined) req.schema = aopts.schema
      if (aopts.systemPrompt !== undefined) req.appendSystemPrompt = aopts.systemPrompt
      if (aopts.tools !== undefined) req.allowedTools = aopts.tools
      if (aopts.disallowedTools !== undefined) req.disallowedTools = aopts.disallowedTools
      // `--allowedTools` v bypassPermissions nic neomezuje (ověřeno). Zadá-li skript `tools`, chceme skutečný whitelist,
      // proto agent běží v `dontAsk` (cokoli mimo seznam se odmítne bez dotazu), pokud režim výslovně nevolil volající.
      // I prázdný seznam `tools: []` je explicitní volba → dontAsk (jinak by agent dostal všechny nástroje).
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

      if (closed) return null // běh už byl uzavřen (např. po grace době při abortu)

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
            errorText = 'schema: agent nevrátil strukturovaný výstup.'
          } else {
            value = r.structured
          }
        } else {
          value = r.text ?? ''
        }
      } else {
        errorText = r.error ? `${r.error.kind}: ${r.error.message}` : 'agent selhal'
      }

      // (5) journal (jen ok), totals, rozpočet, události
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
  await runJson.request() // run.json (status running) existuje dřív než první agent
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
    emit({ t: 'log', ts: nowIso(), message: `Varování skriptu${w.line !== undefined ? ` (řádek ${w.line})` : ''}: ${w.message}`, workflowPath: [meta.name] })
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
      // přerušeno ještě před startem skriptu
    } else {
      const req: RunScriptRequest = { source, filename: scriptPath, args, hooks, budgetBuffer, signal: runSignal }
      const scriptPromise = Promise.resolve().then(() => runScriptFn(req))
      let graceTimer: NodeJS.Timeout | undefined
      let onAbort: (() => void) | undefined
      const guarded = new Promise<RunScriptResult>((resolveG, rejectG) => {
        scriptPromise.then(resolveG, rejectG)
        if (userSignal) {
          onAbort = () => {
            graceTimer = setTimeout(() => rejectG(new AbortedError(`Skript se po přerušení neukončil do ${abortGraceMs} ms.`)), abortGraceMs)
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

  // uklidit zbylé agenty (nečekané/nedoawaitované) a počkat, až skončí procesy
  internalAbort.abort()
  if (inflight.size > 0) {
    await raceWithTimeout(Promise.allSettled([...inflight]), abortGraceMs)
  }

  // ── 7) uzavření běhu ──
  const aborted = userSignal?.aborted === true
  if (aborted) {
    status = 'aborted'
    runError = 'Běh byl přerušen.'
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

  // Neplatný skript před prvním agentem je chyba použití; objeví-li se až u vnořeného workflow po utracení agentů,
  // běh skončí jako failed se svým výsledkem (jinak by se útrata ztratila a výstup nevznikl).
  if (scriptFailed && scriptError instanceof ScriptValidationError && agentCalls === 0) throw scriptError
  return currentSummary()
}

// ───────────────────────── líné načtení závislostí ─────────────────────────

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
