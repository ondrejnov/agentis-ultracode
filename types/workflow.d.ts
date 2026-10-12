/**
 * Ambient types for workflow scripts (`*.workflow.ts`) run via `ultracode run`.
 *
 * Usage at the top of a script:
 *   /// <reference path="../../types/workflow.d.ts" />
 * (or `ultracode types --out .ultracode/` and a reference to the generated file).
 *
 * A script has NO imports; everything below is a global injected by the runtime. The script body is
 * an async context: use top-level `await` and finally `return` result (JSON).
 */

type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** JSON Schema; the root MUST be `{ type: 'object', properties: {...} }` a `required ⊆ properties`. */
interface WorkflowJsonSchema {
  type?: string | string[]
  properties?: Record<string, WorkflowJsonSchema>
  required?: string[]
  items?: WorkflowJsonSchema
  enum?: unknown[]
  additionalProperties?: boolean | WorkflowJsonSchema
  description?: string
  [key: string]: unknown
}

interface WorkflowPhaseMeta {
  /** Must exactly match the title in `phase('…')`. */
  title: string
  detail?: string
  model?: string
}

/** `export const meta` – a plain literal: no variables, function calls, spread or templates with ${}. */
interface WorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: WorkflowPhaseMeta[]
}

interface AgentOptions {
  /** Agent label in the log and events. */
  label?: string
  /** Explicit phase – use inside `pipeline()`/`parallel()` instead of the global `phase()`. */
  phase?: string
  /** Forces structured output; `agent()` then returns a validated object. */
  schema?: WorkflowJsonSchema
  /** Model alias (`sonnet`, `opus`, `haiku`, …) or full name. Default: inherited from the run. Preferably omit. */
  model?: string
  /** Reasoning effort level. Default: inherited from the run. `low` for mechanical steps. */
  effort?: EffortLevel
  /** Agent working directory (default: the run's cwd). */
  cwd?: string
  /**
   * Tool allowlist (`--allowedTools`), e.g. `['Read','Grep','Bash(git diff:*)']`. An agent with `tools`
   * runs in `dontAsk`: anything outside the list is rejected. Without `tools` applies `bypassPermissions`.
   */
  tools?: string[]
  disallowedTools?: string[]
  /** Appended to the agent's default system prompt. */
  systemPrompt?: string
  /** Output silence in ms after which the agent is considered stuck and restarted (default 600000). */
  stallMs?: number
  /** Hard limit for one agent ATTEMPT in ms (a stall restart starts a new attempt and the limit applies again). */
  timeoutMs?: number
  /** Agent spend cap in USD; cumulative across restarts (the remainder is passed to the next attempt). Spend of killed attempts without a result is not counted (cost is unknown). */
  maxUsd?: number
  /** On resume, do not use the stored result of this call. */
  noCache?: boolean
}

type AgentOptionsWithSchema = AgentOptions & { schema: WorkflowJsonSchema }

/**
 * Runs one agent (`claude -p`). Without `schema` returns the final text; with `schema` a validated object.
 * Returns `null` when the agent fails terminally (after retry/stall restarts) or is aborted – ALWAYS before
 * use, filter with `.filter(Boolean)` / handle `null`.
 * Throws only on a script error (invalid schema, exceeded budget, …).
 */
declare function agent<T = any>(prompt: string, opts: AgentOptionsWithSchema): Promise<T | null>
declare function agent<T = string>(prompt: string, opts?: AgentOptions): Promise<T | null>

/**
 * Runs thunks concurrently and waits for all of them (BARRIER). A thunk that throws yields `null`.
 * The function never rejects. Max 4096 items.
 */
declare function parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>

/**
 * Sends each item independently through all stages (WITHOUT a barrier between stages) – the default choice for multi-step work.
 * Each stage receives `(previousResult, originalItem, index)`. A stage that throws gives the item
 * `null` and the remaining stages are skipped for it. The result is an array in the same order as `items`.
 * Max 4096 items.
 */
declare function pipeline<I, A>(items: I[], s1: (item: I, original: I, index: number) => Promise<A> | A): Promise<Array<A | null>>
declare function pipeline<I, A, B>(items: I[], s1: (item: I, original: I, index: number) => Promise<A> | A, s2: (prev: A, original: I, index: number) => Promise<B> | B): Promise<Array<B | null>>
declare function pipeline<I, A, B, C>(items: I[], s1: (item: I, original: I, index: number) => Promise<A> | A, s2: (prev: A, original: I, index: number) => Promise<B> | B, s3: (prev: B, original: I, index: number) => Promise<C> | C): Promise<Array<C | null>>
declare function pipeline<I, A, B, C, D>(items: I[], s1: (item: I, original: I, index: number) => Promise<A> | A, s2: (prev: A, original: I, index: number) => Promise<B> | B, s3: (prev: B, original: I, index: number) => Promise<C> | C, s4: (prev: C, original: I, index: number) => Promise<D> | D): Promise<Array<D | null>>
declare function pipeline(items: any[], ...stages: Array<(prev: any, original: any, index: number) => any>): Promise<any[]>

/** Starts a new phase; the following `agent()` calls are grouped under the title. The title must be in `meta.phases`. */
declare function phase(title: string): void

/** Prints a progress message to the user (stderr + events.jsonl). */
declare function log(message: string): void

/** Workflow input (`--args '<json>'`); `undefined` when not given. Arrays/objects are real JSON values. */
declare const args: any

/**
 * Run budget (from `--max-tokens` / `--max-usd`). `total` is `null` when no limit is set.
 * The limit is a hard cap: once reached, further `agent()` calls throw an error.
 */
declare const budget: {
  /** Output token cap or `null`. */
  total: number | null
  /** USD spend cap or `null`. */
  totalUsd: number | null
  /** Spent output tokens (whole run including nested workflows). */
  spent(): number
  /** `max(0, total - spent())`, or `Infinity` without a limit. */
  remaining(): number
  spentUsd(): number
  remainingUsd(): number
}

/**
 * Runs another workflow inline and returns its return value. Shares limits, the agent counter and the budget.
 * Nesting is limited to one level (workflow() inside a child throws an error).
 */
declare function workflow(nameOrRef: string | { scriptPath: string }, args?: any): Promise<any>
