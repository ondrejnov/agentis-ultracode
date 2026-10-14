/**
 * Shared types and contracts between runtime modules.
 *
 * Rules for all of `src/`:
 *  - only “erasable” TypeScript (no `enum`, `namespace`, parameter properties, `import x = require`),
 *    so that the code can run directly via Node type-stripping (tests) and also be compiled with `tsc` (dist);
 *  - relative imports with the `.ts` extension (`import { x } from './y.ts'`);
 *  - `import type` for type-only imports (verbatimModuleSyntax).
 *
 * This file is the CONTRACT. Modules must not change it without agreement — when something is missing, add it
 * in your own module and list it in the final report so the integrator can carry it over here.
 */

// ───────────────────────── basic ─────────────────────────

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** JSON Schema (the subset supported by `claude --json-schema`). The root must be `type: 'object'`. */
export interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  additionalProperties?: boolean | JsonSchema
  [key: string]: unknown
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export const EMPTY_USAGE: TokenUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
})

export type PermissionMode = 'bypassPermissions' | 'acceptEdits' | 'auto' | 'dontAsk' | 'plan' | 'manual'

// ───────────────────────── workflow script ─────────────────────────

export interface PhaseMeta {
  title: string
  detail?: string
  model?: string
}

/** `export const meta = {...}` in a script. MUST be a pure literal (no variables/calls/spread/templates with ${}). */
export interface WorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: PhaseMeta[]
}

/** Options of one `agent(prompt, opts)` call in a script (public API — see types/workflow.d.ts). */
export interface AgentOptions {
  /** Display label in the log/events. */
  label?: string
  /** Explicit assignment to a phase (inside pipeline/parallel, so it does not race with the global phase()). */
  phase?: string
  /** JSON Schema → the agent returns a validated object instead of text. */
  schema?: JsonSchema
  model?: string
  effort?: EffortLevel
  /** Agent working directory; default = the run cwd. */
  cwd?: string
  /** Tool whitelist (`--allowedTools`), e.g. ['Read','Grep','Bash(git diff:*)']; the engine then runs the agent in `dontAsk`. */
  tools?: string[]
  disallowedTools?: string[]
  /** Appended after the agent's default system prompt (`--append-system-prompt`). */
  systemPrompt?: string
  /** How many ms of output silence count as a stall (default 600 000). */
  stallMs?: number
  /** Hard limit on the length of one agent in ms (default none). */
  timeoutMs?: number
  /** Spending cap of one agent (`--max-budget-usd`). */
  maxUsd?: number
  /** Disables use of the cache from a previous run (resume) for this call. */
  noCache?: boolean
}

// ───────────────────────── claude runner (module 1) ─────────────────────────

/** An exceeded agent budget (`--max-budget-usd`) and HTTP errors are reported as `api`, invalid CLI arguments as `exit`. */
export type ClaudeErrorKind = 'stall' | 'timeout' | 'exit' | 'api' | 'schema' | 'aborted' | 'spawn'

/**
 * Existing Agentis run to which every agent attaches its session as a secondary one (agentiscode `--task-id`/`--run-id`).
 * The endpoint and tokens are not here: agentiscode reads them from the inherited env (`AGENTIS_ENDPOINT`, …).
 */
export interface AgentisTelemetryTarget {
  taskId: string
  runId: string
  /** Session of the orchestrator that started the workflow; agents' sessions are shown under it. */
  parentSessionId?: string
}

export interface ClaudeRunRequest {
  prompt: string
  cwd: string
  /** Directory for this agent's artifacts: prompt.txt, stream.jsonl, stderr.txt, result.json. The runner creates it. */
  outDir: string
  model?: string
  effort?: EffortLevel
  schema?: JsonSchema
  appendSystemPrompt?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  /** Default `bypassPermissions`. */
  permissionMode?: PermissionMode
  maxBudgetUsd?: number
  /** Additional raw arguments for `claude` (passed through agentiscode `--extra-args-json`). */
  extraArgs?: string[]
  /** Agentis run the agent reports its live transcript into (agentiscode telemetry); none = no telemetry. */
  agentis?: AgentisTelemetryTarget
  /** Title of the agent's session in Agentis (only with `agentis`). */
  title?: string
  /** Agent executable (agentiscode); default from env `ULTRACODE_AGENT_BIN` / `ULTRACODE_CLAUDE_BIN`, otherwise `agentiscode` from PATH. */
  bin?: string
  /** Adds to (does not replace) the child process environment. */
  env?: Record<string, string>
  /** Default 600_000. */
  stallMs?: number
  timeoutMs?: number
  /** Total number of attempts on a stall / transient error (default 3, max 6). */
  maxAttempts?: number
  signal?: AbortSignal
  onProgress?: (e: ClaudeProgress) => void
}

export type ClaudeProgress =
  | { kind: 'start'; attempt: number; pid?: number }
  | { kind: 'tool'; name: string }
  | { kind: 'text'; chars: number }
  /** CUMULATIVE usage for the whole `runClaude` call (including previous attempts); intermediate outputTokens are only an estimate. */
  | { kind: 'usage'; usage: TokenUsage }
  /** `attempt` is the number of the UPCOMING attempt. */
  | { kind: 'retry'; attempt: number; reason: string }
  /** One raw event of the agent's agentiscode `--json` stream (session/text/reasoning/tool/step/result/…). */
  | { kind: 'event'; attempt: number; event: Record<string, unknown> }

export interface ClaudeRunResult {
  ok: boolean
  /** The agent's final text (the `result` field of the `claude` output). */
  text: string | null
  /** Validated object if a schema was given (`structured_output`); `null` on failure or without a schema. */
  structured: unknown
  sessionId?: string
  usage: TokenUsage
  costUsd: number
  numTurns: number
  toolCalls: number
  durationMs: number
  /** Which attempt succeeded / was the last one; 0 when `claude` was not started at all. `runClaude` never throws. */
  attempts: number
  error?: { kind: ClaudeErrorKind; message: string }
}

/** Signature of the function exported by `src/runner/claude.ts` (as `runClaude`). Injectable for tests. */
export type ClaudeRunner = (req: ClaudeRunRequest) => Promise<ClaudeRunResult>

// ───────────────────────── script host (module 2) ─────────────────────────

export interface LoadedScript {
  source: string
  /** Path/name for error messages and stack traces. */
  filename: string
}

/** Call context, so the engine can group agents and events by (nested) workflow. */
export interface HookCall {
  /** ['php8-upgrade'] or ['php8-upgrade', 'child-name'] for a nested workflow(). */
  workflowPath: string[]
}

/**
 * What the script host (running in a worker) calls back on the main thread. Implemented by the engine.
 * All values must be JSON-serializable (they cross postMessage).
 */
export interface ScriptHooks {
  /** Returns the agent result (an object when a schema is given, otherwise a string) or `null` on a terminal failure/skip. */
  agent(prompt: string, opts: AgentOptions, call: HookCall): Promise<unknown>
  phase(title: string, call: HookCall): void
  log(message: string, call: HookCall): void
  /** Finds the script of a nested workflow by name or `{scriptPath}`. Throws an error when it does not exist. */
  loadWorkflow(ref: string | { scriptPath: string }, call: HookCall): Promise<LoadedScript>
  /** A nested workflow started / ended (for grouping in events). */
  workflowEnter(name: string, call: HookCall): void
  workflowExit(name: string, call: HookCall): void
}

/**
 * Layout of the SharedArrayBuffer (Float64Array) for `budget` — synchronous reads in the script:
 *   [0] spentOutputTokens   [1] totalOutputTokens (-1 = no limit)
 *   [2] spentUsd            [3] totalUsd          (-1 = no limit)
 * Only the engine (main thread) writes to it.
 */
export const BUDGET_SLOTS = 4

export interface RunScriptRequest {
  source: string
  filename: string
  /** Value of the global `args` (JSON). `undefined` → `undefined` in the script. */
  args: unknown
  hooks: ScriptHooks
  budgetBuffer: SharedArrayBuffer
  signal?: AbortSignal
  /** Cap on items in one parallel()/pipeline() (default 4096). */
  maxItems?: number
}

export interface RunScriptResult {
  meta: WorkflowMeta
  /** What the script `return`ed (JSON-serializable; undefined → null). */
  value: unknown
}

// ───────────────────────── engine (modul 3) ─────────────────────────

export type RunStatus = 'running' | 'completed' | 'failed' | 'aborted'

export interface RunOptions {
  /** Path to the script (.ts/.js) OR the name of a workflow to find in the workflow directories. */
  workflow: string
  args?: unknown
  /** Project directory: agents' cwd + root of `.ultracode/` (runs, workflows). Default process.cwd(). */
  cwd?: string
  /** Continue an existing run (cache from the journal). */
  resumeRunId?: string
  runId?: string
  concurrency?: number
  /** Total agents per run (default 1000). */
  maxAgents?: number
  maxOutputTokens?: number
  maxUsd?: number
  /** Default model/effort for agents that do not specify them. */
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  claudeBin?: string
  /** Agentis telemetry of agents; default from env (`resolveAgentisTelemetry`), `null` = off. */
  agentis?: AgentisTelemetryTarget | null
  /** Injected runner (tests). Default `runClaude` from `src/runner/claude.ts`. */
  runner?: ClaudeRunner
  signal?: AbortSignal
  onEvent?: (e: RunEvent) => void
}

export interface RunTotals {
  agents: number
  cachedAgents: number
  failedAgents: number
  toolCalls: number
  usage: TokenUsage
  costUsd: number
}

export interface RunSummary {
  runId: string
  name: string
  status: RunStatus
  startedAt: string
  /** ISO end time; empty string `''` until the run ends (`status: 'running'`). */
  endedAt: string
  durationMs: number
  runDir: string
  scriptPath: string
  /** Return value of the script (for `completed`). */
  result?: unknown
  error?: string
  totals: RunTotals
  budgetExceeded?: boolean
}

export type RunEvent =
  | { t: 'run_start'; ts: string; runId: string; name: string; description: string; args: unknown; cwd: string; scriptPath: string; resumed: boolean; phases: PhaseMeta[] }
  | { t: 'phase'; ts: string; title: string; workflowPath: string[] }
  | { t: 'log'; ts: string; message: string; workflowPath: string[] }
  | { t: 'workflow_enter'; ts: string; name: string; workflowPath: string[] }
  | { t: 'workflow_exit'; ts: string; name: string; workflowPath: string[] }
  | { t: 'agent_start'; ts: string; id: number; label: string; phase: string | null; workflowPath: string[]; model?: string; promptPreview: string }
  | { t: 'agent_tool'; ts: string; id: number; tool: string }
  | { t: 'agent_retry'; ts: string; id: number; attempt: number; reason: string }
  /**
   * One event from the agent's own log (agentiscode `--json` format, see src/runner/claude.ts). LIVE ONLY: delivered to
   * `onEvent` but not written to events.jsonl (the full stream is in agents/<id>/stream.jsonl).
   */
  | { t: 'agent_event'; ts: string; id: number; label: string; attempt: number; event: Record<string, unknown> }
  | { t: 'agent_done'; ts: string; id: number; ok: boolean; cached: boolean; durationMs: number; usage: TokenUsage; costUsd: number; toolCalls: number; error?: string }
  | { t: 'budget'; ts: string; spentOutputTokens: number; spentUsd: number; limitOutputTokens: number | null; limitUsd: number | null }
  | { t: 'run_end'; ts: string; status: RunStatus; durationMs: number; totals: RunTotals; error?: string }
