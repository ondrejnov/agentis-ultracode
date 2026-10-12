/**
 * CLI types: I/O interfaces and injectable dependencies.
 * Engine and script dependencies are declared structurally (per the shared contracts),
 * so tests can substitute them and the CLI is not bound to concrete files of other modules.
 */
import type { RunEvent, RunOptions, RunSummary, WorkflowMeta } from '../types.ts'

export interface CliWritable {
  write(chunk: string): unknown
}

export interface CliIO {
  stdout: CliWritable
  stderr: CliWritable
  /** Colors (stderr) are used only on a TTY. */
  isTTY?: boolean
  /** Is stdout a terminal? Then JSON is indented; default = `isTTY`. */
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
  /** Optional (test stand-ins need not have it): does a process hold the run? */
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
  /** Package root (where `types/`, `skills/`, `package.json` live). Default is derived from `import.meta.url`. */
  packageRoot?: string
  /** Abort signal (SIGINT/SIGTERM from `bin/ultracode.mjs`). */
  signal?: AbortSignal
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Polling interval for `logs --follow` (default 500 ms). */
  followPollMs?: number
  /** After how many ms without a new event `logs --follow` gives up while the run still reports `running` (default 30 min). */
  followIdleMs?: number
}

/** Usage error (unknown option, missing argument…) → exit 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** Context passed to commands. */
export interface CommandContext {
  io: CliIO
  deps: CliDeps
  /** Absolute path to the package. */
  packageRoot: string
}
