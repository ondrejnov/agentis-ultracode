/**
 * Sandbox for one workflow script: vm context + bridge between the script realm and the engine hooks.
 *
 * Knows nothing about worker_threads – it receives `ScriptHooks` (in the worker this is a proxy over postMessage, in tests a mock).
 * A nested `workflow()` runs in a NEW vm context with the same code (`runInSandbox` recursively).
 */

import { Script, createContext } from 'node:vm'
import { DeterminismError, ScriptValidationError } from '../errors.ts'
import type { HookCall, ScriptHooks, WorkflowMeta } from '../types.ts'
import { formatDiagnostic, parseScript } from './parse.ts'
import { serializeError } from './protocol.ts'
import { installRuntime } from './runtime.ts'
import type { RuntimeBridge, RuntimeConfig } from './runtime.ts'
import { validateAgentCall } from './validate.ts'

export interface SandboxScript {
  /** Output of `parseScript().code` – an expression with an async function. */
  code: string
  filename: string
  meta: WorkflowMeta
}

export interface SandboxShared {
  hooks: ScriptHooks
  /** View of the budget SharedArrayBuffer (Float64Array, BUDGET_SLOTS). */
  budget: Float64Array
  maxItems: number
}

export interface SandboxRun {
  argsJson: string | undefined
  /** `['root']` or `['root', 'child']`. */
  workflowPath: string[]
  /** 0 = root script, 1 = nested workflow. */
  depth: number
}

/** Deepest allowed nesting of `workflow()` (root has depth 0). */
const MAX_NESTING_DEPTH = 1

let runtimeSource: string | undefined

function getRuntimeSource(): string {
  runtimeSource ??= `(${installRuntime.toString()})`
  return runtimeSource
}

const ok = (value: unknown): string => JSON.stringify({ ok: true, value: value === undefined ? null : value })
const fail = (e: unknown, keepStack = false): string => {
  const error = serializeError(e)
  // The stack of an error from an engine hook (internal main-thread frames) tells the script nothing; the child's stack does.
  if (!keepStack) delete error.stack
  return JSON.stringify({ ok: false, error })
}

/**
 * Runs the script and returns its return value as a JSON string (`undefined` → `'null'`).
 * Throws the script error (with the original message and a stack with script line numbers).
 */
export async function runInSandbox(script: SandboxScript, shared: SandboxShared, run: SandboxRun): Promise<string> {
  const { hooks } = shared
  const call = (): HookCall => ({ workflowPath: [...run.workflowPath] })

  const handleCall = async (method: string, payloadJson: string): Promise<string> => {
    try {
      const payload = JSON.parse(payloadJson) as Record<string, unknown>
      switch (method) {
        case 'agent': {
          const v = validateAgentCall(payload.prompt, payload.opts)
          for (const w of v.warnings) hooks.log(w, call())
          const value = await hooks.agent(v.prompt, v.opts, call())
          return ok(value)
        }
        case 'workflow': {
          try {
            const json = await runChild(payload.ref, payload.hasArgs === true ? JSON.stringify(payload.args) : undefined)
            return `{"ok":true,"value":${json}}`
          } catch (e) {
            return fail(e, true)
          }
        }
        default:
          throw new Error(`Unknown bridge call: ${method}`)
      }
    } catch (e) {
      return fail(e)
    }
  }

  const handleFire = (method: string, payloadJson: string): string => {
    try {
      const payload = JSON.parse(payloadJson) as Record<string, unknown>
      switch (method) {
        case 'phase':
          hooks.phase(String(payload.title), call())
          break
        case 'log':
          hooks.log(String(payload.message), call())
          break
        default:
          throw new Error(`Unknown bridge event: ${method}`)
      }
      return '{"ok":true,"value":null}'
    } catch (e) {
      return fail(e)
    }
  }

  const runChild = async (ref: unknown, argsJson: string | undefined): Promise<string> => {
    if (run.depth >= MAX_NESTING_DEPTH) {
      throw new Error(
        'workflow() cannot be called from a nested workflow: nesting is allowed only one level deep. ' +
          'Call both workflows one after another from the root script.',
      )
    }
    let hookRef: string | { scriptPath: string }
    if (typeof ref === 'string' && ref.trim() !== '') {
      hookRef = ref
    } else if (
      ref !== null &&
      typeof ref === 'object' &&
      typeof (ref as { scriptPath?: unknown }).scriptPath === 'string' &&
      (ref as { scriptPath: string }).scriptPath !== ''
    ) {
      hookRef = { scriptPath: (ref as { scriptPath: string }).scriptPath }
    } else {
      throw new TypeError('workflow(): the first argument must be a workflow name (string) or { scriptPath }.')
    }

    const loaded = await hooks.loadWorkflow(hookRef, call())
    const parsed = parseScript(loaded.source, loaded.filename)
    if (!parsed.ok || !parsed.meta) {
      const lines = parsed.diagnostics.map((d) => formatDiagnostic(d, loaded.filename))
      const first = parsed.diagnostics.find((d) => d.level === 'error')
      throw new ScriptValidationError(
        `Nested workflow “${typeof hookRef === 'string' ? hookRef : hookRef.scriptPath}” is invalid: ${first ? first.message : 'unknown error'}`,
        lines,
      )
    }
    const name = parsed.meta.name
    // enter/exit carry the CHILD path (['parent', 'child']), as do the agent/phase/log hooks inside it
    const childPath = [...run.workflowPath, name]
    hooks.workflowEnter(name, { workflowPath: childPath })
    try {
      return await runInSandbox(
        { code: parsed.code, filename: loaded.filename, meta: parsed.meta },
        shared,
        { argsJson, workflowPath: childPath, depth: run.depth + 1 },
      )
    } finally {
      try {
        hooks.workflowExit(name, { workflowPath: childPath })
      } catch {
        /* an error in the exit hook must not override the result or the original error */
      }
    }
  }

  const bridge: RuntimeBridge = {
    call: handleCall,
    fire: handleFire,
    slot: (index) => shared.budget[index] ?? 0,
    determinism: (what) => new DeterminismError(what).message,
  }
  const config: RuntimeConfig = { argsJson: run.argsJson, maxItems: shared.maxItems }

  // Each run has its own context → its own globals, its own Date/Math guards.
  const context = createContext({}, { name: `ultracode:${script.meta.name}`, codeGeneration: { strings: false, wasm: false } })
  const install = new Script(getRuntimeSource(), { filename: 'ultracode-runtime.js' }).runInContext(context) as (
    b: RuntimeBridge,
    c: RuntimeConfig,
  ) => void
  install(bridge, config)

  const fn = new Script(script.code, { filename: script.filename }).runInContext(context) as unknown
  if (typeof fn !== 'function') throw new Error('Script did not create an executable function (internal parser error).')

  const value: unknown = await (fn as () => Promise<unknown>).call(undefined)
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch (e) {
    throw new TypeError(`The script's return value cannot be serialized to JSON: ${(e as Error).message}`)
  }
  return json === undefined ? 'null' : json
}
