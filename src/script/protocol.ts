/**
 * Zprávy mezi hlavním vláknem (host.ts) a workerem (worker.ts) + (de)serializace chyb.
 */

import { fileURLToPath } from 'node:url'
import { AbortedError, BudgetExceededError, ScriptValidationError, UltracodeError } from '../errors.ts'
import type { AgentOptions, HookCall, LoadedScript, WorkflowMeta } from '../types.ts'

export interface SerializedError {
  name: string
  message: string
  stack?: string
  code?: string
  diagnostics?: string[]
}

/** Vstup workeru (`workerData`). */
export interface WorkerInit {
  code: string
  filename: string
  meta: WorkflowMeta
  argsJson: string | undefined
  budgetBuffer: SharedArrayBuffer
  maxItems: number
}

export type WorkerRpc =
  | { method: 'agent'; params: [prompt: string, opts: AgentOptions, call: HookCall] }
  | { method: 'loadWorkflow'; params: [ref: string | { scriptPath: string }, call: HookCall] }

export type WorkerFire =
  | { method: 'phase'; params: [title: string, call: HookCall] }
  | { method: 'log'; params: [message: string, call: HookCall] }
  | { method: 'workflowEnter'; params: [name: string, call: HookCall] }
  | { method: 'workflowExit'; params: [name: string, call: HookCall] }

export type WorkerToMain =
  | ({ t: 'rpc'; id: number } & WorkerRpc)
  | ({ t: 'fire' } & WorkerFire)
  | { t: 'done'; json: string }
  | { t: 'error'; error: SerializedError }

export type MainToWorker =
  | { t: 'rpcResult'; id: number; ok: true; value: unknown }
  | { t: 'rpcResult'; id: number; ok: false; error: SerializedError }

export type { LoadedScript }

const THIS_DIR = fileURLToPath(new URL('.', import.meta.url))

/** Odstraní z stacku interní rámce (runtime, node:internal, tento adresář), ať zůstanou řádky skriptu. */
export function cleanStack(stack: string): string {
  return stack
    .split('\n')
    .filter((line) => {
      if (!/^\s+at /.test(line)) return true
      return !(line.includes('ultracode-runtime') || line.includes('node:') || line.includes(THIS_DIR))
    })
    .join('\n')
}

export function serializeError(e: unknown): SerializedError {
  if (e !== null && typeof e === 'object') {
    const o = e as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown; diagnostics?: unknown }
    const message = o.message !== undefined ? String(o.message) : safeString(e)
    const out: SerializedError = {
      name: typeof o.name === 'string' && o.name ? o.name : 'Error',
      message,
    }
    if (typeof o.stack === 'string') out.stack = cleanStack(o.stack)
    if (typeof o.code === 'string') out.code = o.code
    if (Array.isArray(o.diagnostics) && o.diagnostics.every((d) => typeof d === 'string')) out.diagnostics = o.diagnostics as string[]
    return out
  }
  return { name: 'Error', message: safeString(e) }
}

function safeString(v: unknown): string {
  try {
    return String(v)
  } catch {
    return '[nelze zobrazit]'
  }
}

const NATIVE_ERRORS: Record<string, ErrorConstructor | undefined> = {
  TypeError,
  RangeError,
  SyntaxError,
  ReferenceError,
  EvalError,
  URIError,
}

/** Znovu vytvoří chybu na hlavním vlákně; známé typy (`code`) dostanou své třídy z src/errors.ts. */
export function reviveError(s: SerializedError): Error {
  let err: Error
  switch (s.code) {
    case 'BUDGET_EXCEEDED':
      err = new BudgetExceededError(s.message)
      break
    case 'ABORTED':
      err = new AbortedError(s.message)
      break
    case 'SCRIPT_INVALID':
      err = new ScriptValidationError(s.message, s.diagnostics ?? [])
      break
    default:
      if (s.code) {
        err = new UltracodeError(s.code, s.message)
      } else {
        const Ctor = NATIVE_ERRORS[s.name] ?? Error
        err = new Ctor(s.message)
      }
  }
  if (s.name && s.name !== err.name) {
    try {
      Object.defineProperty(err, 'name', { value: s.name, configurable: true, writable: true, enumerable: false })
    } catch {
      /* nic */
    }
  }
  if (s.stack) err.stack = s.stack
  return err
}
