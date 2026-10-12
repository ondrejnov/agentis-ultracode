/**
 * Helper functions for SCRIPT module tests: engine hook mock (no real claude) and shortcuts for runScript.
 */

import { runScript } from '../../src/script/host.ts'
import { BUDGET_SLOTS } from '../../src/types.ts'
import type { AgentOptions, HookCall, LoadedScript, RunScriptResult, ScriptHooks } from '../../src/types.ts'

export type RecordedEvent =
  | { t: 'agent'; prompt: string; opts: AgentOptions; call: HookCall }
  | { t: 'phase'; title: string; call: HookCall }
  | { t: 'log'; message: string; call: HookCall }
  | { t: 'enter'; name: string; call: HookCall }
  | { t: 'exit'; name: string; call: HookCall }
  | { t: 'load'; ref: string | { scriptPath: string }; call: HookCall }

export interface MockHooks {
  hooks: ScriptHooks
  events: RecordedEvent[]
  /** All agent() calls (prompts) in order of arrival. */
  prompts(): string[]
  logs(): string[]
}

export interface MockOptions {
  agent?: (prompt: string, opts: AgentOptions, call: HookCall) => Promise<unknown> | unknown
  loadWorkflow?: (ref: string | { scriptPath: string }, call: HookCall) => Promise<LoadedScript> | LoadedScript
}

export function makeHooks(options: MockOptions = {}): MockHooks {
  const events: RecordedEvent[] = []
  const hooks: ScriptHooks = {
    async agent(prompt, opts, call) {
      events.push({ t: 'agent', prompt, opts, call })
      if (options.agent) return options.agent(prompt, opts, call)
      return `echo:${prompt}`
    },
    phase(title, call) {
      events.push({ t: 'phase', title, call })
    },
    log(message, call) {
      events.push({ t: 'log', message, call })
    },
    async loadWorkflow(ref, call) {
      events.push({ t: 'load', ref, call })
      if (options.loadWorkflow) return options.loadWorkflow(ref, call)
      throw new Error('loadWorkflow is not configured in this test')
    },
    workflowEnter(name, call) {
      events.push({ t: 'enter', name, call })
    },
    workflowExit(name, call) {
      events.push({ t: 'exit', name, call })
    },
  }
  return {
    hooks,
    events,
    prompts: () => events.filter((e) => e.t === 'agent').map((e) => (e as { prompt: string }).prompt),
    logs: () => events.filter((e) => e.t === 'log').map((e) => (e as { message: string }).message),
  }
}

export function budgetBuffer(init: { spent?: number; total?: number; spentUsd?: number; totalUsd?: number } = {}): SharedArrayBuffer {
  const buf = new SharedArrayBuffer(BUDGET_SLOTS * 8)
  const v = new Float64Array(buf)
  v[0] = init.spent ?? 0
  v[1] = init.total ?? -1
  v[2] = init.spentUsd ?? 0
  v[3] = init.totalUsd ?? -1
  return buf
}

/** Minimal valid meta; the script body starts on LINE 2. */
export const META = "export const meta = { name: 't', description: 'test' }\n"

export interface RunOpts {
  args?: unknown
  hooks?: ScriptHooks
  budget?: SharedArrayBuffer
  signal?: AbortSignal
  maxItems?: number
  filename?: string
}

/** Runs `body` (with meta added on line 1). */
export function run(body: string, opts: RunOpts = {}): Promise<RunScriptResult> {
  return runWithMeta(META + body, opts)
}

export function runWithMeta(source: string, opts: RunOpts = {}): Promise<RunScriptResult> {
  return runScript({
    source,
    filename: opts.filename ?? 'wf.ts',
    args: opts.args,
    hooks: opts.hooks ?? makeHooks().hooks,
    budgetBuffer: opts.budget ?? budgetBuffer(),
    signal: opts.signal,
    maxItems: opts.maxItems,
  })
}

/** Manual Promise, resolved by the test when it wants. */
export interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Waits until `predicate()` becomes true (checked every 5 ms), or throws after `timeoutMs`. */
export async function waitFor(predicate: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout while waiting for: ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
