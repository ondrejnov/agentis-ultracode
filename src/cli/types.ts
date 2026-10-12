/**
 * Typy CLI: I/O rozhraní a injektovatelné závislosti.
 * Závislosti na enginu a skriptu jsou deklarovány strukturálně (podle sdílených kontraktů),
 * aby šlo v testech podvrhnout a CLI se nevázalo na konkrétní soubory cizích modulů.
 */
import type { RunEvent, RunOptions, RunSummary, WorkflowMeta } from '../types.ts'

export interface CliWritable {
  write(chunk: string): unknown
}

export interface CliIO {
  stdout: CliWritable
  stderr: CliWritable
  /** Barvy (stderr) se používají jen na TTY. */
  isTTY?: boolean
  /** Je stdout terminál? Pak je JSON odsazený; default = `isTTY`. */
  stdoutIsTTY?: boolean
  env: Record<string, string | undefined>
  cwd: string
}

type MaybePromise<T> = T | Promise<T>

export interface CliStore {
  runsRoot(cwd: string): string
  listRuns(cwd: string): MaybePromise<RunSummary[]>
  readRunSummary(cwd: string, runId: string): MaybePromise<RunSummary | null>
  readEvents(cwd: string, runId: string): MaybePromise<RunEvent[]>
  /** Volitelné (testovací náhrady ho nemusí mít): drží proces běh? */
  runLockHeld?(cwd: string, runId: string): MaybePromise<boolean>
}

export interface WorkflowInfo {
  name: string
  path: string
  description?: string
  scope: 'project' | 'user'
}

export interface CliDiscovery {
  findWorkflow(ref: string, cwd: string): string
  listWorkflows(cwd: string): WorkflowInfo[]
}

export interface ScriptDiagnosticLike {
  level: 'error' | 'warning'
  message: string
  line?: number
}

export interface ParsedScriptLike {
  ok: boolean
  meta: WorkflowMeta | null
  diagnostics: ScriptDiagnosticLike[]
  code: string
}

export type RunWorkflowFn = (opts: RunOptions) => Promise<RunSummary>
export type ParseScriptFn = (source: string, filename: string) => ParsedScriptLike

export interface CliDeps {
  runWorkflow?: RunWorkflowFn
  store?: CliStore
  discovery?: CliDiscovery
  parseScript?: ParseScriptFn
  /** Kořen balíčku (kde leží `types/`, `skills/`, `package.json`). Default se odvodí z `import.meta.url`. */
  packageRoot?: string
  /** Abort signál (SIGINT/SIGTERM z `bin/ultracode.mjs`). */
  signal?: AbortSignal
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Perioda dotazování u `logs --follow` (default 500 ms). */
  followPollMs?: number
  /** Po kolika ms bez nové události se `logs --follow` vzdá, když běh stále hlásí `running` (default 30 min). */
  followIdleMs?: number
}

/** Chyba použití (neznámá volba, chybějící argument…) → exit 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** Kontext předávaný příkazům. */
export interface CommandContext {
  io: CliIO
  deps: CliDeps
  /** Absolutní cesta k balíčku. */
  packageRoot: string
}
