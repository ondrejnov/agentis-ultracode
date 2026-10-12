/**
 * Sdílené typy a kontrakty mezi moduly runtime.
 *
 * Pravidla pro celý `src/`:
 *  - pouze „erasable“ TypeScript (žádné `enum`, `namespace`, parameter properties, `import x = require`),
 *    aby kód šel spustit přímo přes Node type-stripping (testy) i zkompilovat přes `tsc` (dist);
 *  - relativní importy s příponou `.ts` (`import { x } from './y.ts'`);
 *  - `import type` pro čistě typové importy (verbatimModuleSyntax).
 *
 * Tento soubor je KONTRAKT. Moduly ho nesmí měnit bez dohody — když něco chybí, přidej to
 * do svého modulu a vyjmenuj v závěrečném reportu, ať to integrátor promítne sem.
 */

// ───────────────────────── základní ─────────────────────────

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** JSON Schema (podmnožina, kterou umí `claude --json-schema`). Kořen musí být `type: 'object'`. */
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

// ───────────────────────── skript workflow ─────────────────────────

export interface PhaseMeta {
  title: string
  detail?: string
  model?: string
}

/** `export const meta = {...}` ve skriptu. MUSÍ být čistý literál (žádné proměnné/volání/spread/šablony s ${}). */
export interface WorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: PhaseMeta[]
}

/** Volby jednoho `agent(prompt, opts)` volání ve skriptu (veřejné API – viz types/workflow.d.ts). */
export interface AgentOptions {
  /** Zobrazovaný popisek v logu/eventech. */
  label?: string
  /** Explicitní přiřazení k fázi (uvnitř pipeline/parallel, aby nezávodilo s globálním phase()). */
  phase?: string
  /** JSON Schema → agent vrací validovaný objekt místo textu. */
  schema?: JsonSchema
  model?: string
  effort?: EffortLevel
  /** Pracovní adresář agenta; default = cwd běhu. */
  cwd?: string
  /** Whitelist nástrojů (`--allowedTools`), např. ['Read','Grep','Bash(git diff:*)']; engine pak pustí agenta v `dontAsk`. */
  tools?: string[]
  disallowedTools?: string[]
  /** Přidá se za výchozí system prompt agenta (`--append-system-prompt`). */
  systemPrompt?: string
  /** Kolik ms ticha na výstupu se považuje za zaseknutí (default 600 000). */
  stallMs?: number
  /** Tvrdý limit délky jednoho agenta v ms (default žádný). */
  timeoutMs?: number
  /** Strop útrat jednoho agenta (`--max-budget-usd`). */
  maxUsd?: number
  /** Vypne použití cache z předchozího běhu (resume) pro tohle volání. */
  noCache?: boolean
}

// ───────────────────────── claude runner (modul 1) ─────────────────────────

/** Překročený rozpočet agenta (`--max-budget-usd`) a HTTP chyby se hlásí jako `api`, chybné argumenty CLI jako `exit`. */
export type ClaudeErrorKind = 'stall' | 'timeout' | 'exit' | 'api' | 'schema' | 'aborted' | 'spawn'

export interface ClaudeRunRequest {
  prompt: string
  cwd: string
  /** Adresář pro artefakty tohoto agenta: prompt.txt, stream.jsonl, stderr.txt, result.json. Runner ho vytvoří. */
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
  /** Další surové argumenty pro `claude`. */
  extraArgs?: string[]
  /** Spustitelný soubor `claude`; default env `ULTRACODE_CLAUDE_BIN`, jinak `claude` z PATH. */
  bin?: string
  /** Doplňuje (nepřepisuje celé) prostředí potomka. */
  env?: Record<string, string>
  /** Default 600_000. */
  stallMs?: number
  timeoutMs?: number
  /** Kolik pokusů celkem při stall / přechodné chybě (default 3, max 6). */
  maxAttempts?: number
  signal?: AbortSignal
  onProgress?: (e: ClaudeProgress) => void
}

export type ClaudeProgress =
  | { kind: 'start'; attempt: number; pid?: number }
  | { kind: 'tool'; name: string }
  | { kind: 'text'; chars: number }
  /** KUMULATIVNÍ spotřeba za celé volání `runClaude` (včetně předchozích pokusů); průběžné outputTokens jsou jen odhad. */
  | { kind: 'usage'; usage: TokenUsage }
  /** `attempt` je číslo NADCHÁZEJÍCÍHO pokusu. */
  | { kind: 'retry'; attempt: number; reason: string }

export interface ClaudeRunResult {
  ok: boolean
  /** Finální text agenta (pole `result` z výstupu `claude`). */
  text: string | null
  /** Validovaný objekt, pokud byl zadán schema (`structured_output`); `null` při neúspěchu nebo bez schema. */
  structured: unknown
  sessionId?: string
  usage: TokenUsage
  costUsd: number
  numTurns: number
  toolCalls: number
  durationMs: number
  /** Kolikátý pokus byl úspěšný / poslední; 0, když se `claude` vůbec nespustil. `runClaude` nikdy nehází. */
  attempts: number
  error?: { kind: ClaudeErrorKind; message: string }
}

/** Signatura funkce, kterou exportuje `src/runner/claude.ts` (jako `runClaude`). Injektovatelná kvůli testům. */
export type ClaudeRunner = (req: ClaudeRunRequest) => Promise<ClaudeRunResult>

// ───────────────────────── script host (modul 2) ─────────────────────────

export interface LoadedScript {
  source: string
  /** Cesta/jméno pro chybové hlášky a stack trace. */
  filename: string
}

/** Kontext volání, aby engine uměl seskupit agenty a události podle (vnořeného) workflow. */
export interface HookCall {
  /** ['php8-upgrade'] nebo ['php8-upgrade', 'child-name'] u vnořeného workflow(). */
  workflowPath: string[]
}

/**
 * Co script host (běží ve workeru) volá zpět na hlavním vlákně. Implementuje engine.
 * Všechny hodnoty musí být JSON-serializovatelné (přecházejí přes postMessage).
 */
export interface ScriptHooks {
  /** Vrací výsledek agenta (objekt při schema, jinak string) nebo `null` při terminálním selhání/přeskočení. */
  agent(prompt: string, opts: AgentOptions, call: HookCall): Promise<unknown>
  phase(title: string, call: HookCall): void
  log(message: string, call: HookCall): void
  /** Najde skript vnořeného workflow podle jména nebo `{scriptPath}`. Vyhodí chybu, když neexistuje. */
  loadWorkflow(ref: string | { scriptPath: string }, call: HookCall): Promise<LoadedScript>
  /** Vnořené workflow začalo / skončilo (pro seskupení v eventech). */
  workflowEnter(name: string, call: HookCall): void
  workflowExit(name: string, call: HookCall): void
}

/**
 * Rozložení SharedArrayBuffer (Float64Array) pro `budget` – synchronní čtení ve skriptu:
 *   [0] spentOutputTokens   [1] totalOutputTokens (-1 = bez limitu)
 *   [2] spentUsd            [3] totalUsd          (-1 = bez limitu)
 * Zapisuje pouze engine (hlavní vlákno).
 */
export const BUDGET_SLOTS = 4

export interface RunScriptRequest {
  source: string
  filename: string
  /** Hodnota globálu `args` (JSON). `undefined` → ve skriptu `undefined`. */
  args: unknown
  hooks: ScriptHooks
  budgetBuffer: SharedArrayBuffer
  signal?: AbortSignal
  /** Strop položek v jednom parallel()/pipeline() (default 4096). */
  maxItems?: number
}

export interface RunScriptResult {
  meta: WorkflowMeta
  /** To, co skript `return`nul (JSON-serializovatelné; undefined → null). */
  value: unknown
}

// ───────────────────────── engine (modul 3) ─────────────────────────

export type RunStatus = 'running' | 'completed' | 'failed' | 'aborted'

export interface RunOptions {
  /** Cesta ke skriptu (.ts/.js) NEBO jméno workflow k nalezení v adresářích s workflow. */
  workflow: string
  args?: unknown
  /** Projektový adresář: cwd agentů + kořen `.ultracode/` (runs, workflows). Default process.cwd(). */
  cwd?: string
  /** Pokračovat v existujícím běhu (cache z journalu). */
  resumeRunId?: string
  runId?: string
  concurrency?: number
  /** Celkem agentů za běh (default 1000). */
  maxAgents?: number
  maxOutputTokens?: number
  maxUsd?: number
  /** Výchozí model/effort pro agenty, kteří je nespecifikují. */
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  claudeBin?: string
  /** Injektovaný runner (testy). Default `runClaude` z `src/runner/claude.ts`. */
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
  /** ISO čas konce; prázdný řetězec `''`, dokud běh neskončil (`status: 'running'`). */
  endedAt: string
  durationMs: number
  runDir: string
  scriptPath: string
  /** Návratová hodnota skriptu (u `completed`). */
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
  | { t: 'agent_done'; ts: string; id: number; ok: boolean; cached: boolean; durationMs: number; usage: TokenUsage; costUsd: number; toolCalls: number; error?: string }
  | { t: 'budget'; ts: string; spentOutputTokens: number; spentUsd: number; limitOutputTokens: number | null; limitUsd: number | null }
  | { t: 'run_end'; ts: string; status: RunStatus; durationMs: number; totals: RunTotals; error?: string }
