/**
 * `runScript()` – runs a workflow script in a worker thread and serves its RPC (agent, phase, log, …)
 * against the `ScriptHooks` of the engine. The main thread never executes script code, so abort always works:
 * `worker.terminate()` stops even an infinite loop.
 */

import { Worker } from 'node:worker_threads'
import { AbortedError, ScriptValidationError } from '../errors.ts'
import type { RunScriptRequest, RunScriptResult } from '../types.ts'
import { BUDGET_SLOTS } from '../types.ts'
import { formatDiagnostic, parseScript } from './parse.ts'
import { reviveError, serializeError } from './protocol.ts'
import type { MainToWorker, WorkerInit, WorkerToMain } from './protocol.ts'

export const DEFAULT_MAX_ITEMS = 4096

/** worker.ts / worker.js depending on what we run from (type-stripping vs. compiled dist). */
function workerUrl(): URL {
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
  return new URL(`./worker${ext}`, import.meta.url)
}

export async function runScript(req: RunScriptRequest): Promise<RunScriptResult> {
  if (req.signal?.aborted) throw new AbortedError()

  const parsed = parseScript(req.source, req.filename)
  if (!parsed.ok || !parsed.meta) {
    const lines = parsed.diagnostics.map((d) => formatDiagnostic(d, req.filename))
    const first = parsed.diagnostics.find((d) => d.level === 'error')
    throw new ScriptValidationError(
      `Script “${req.filename}” is invalid: ${first ? `${first.line ? `line ${first.line}: ` : ''}${first.message}` : 'unknown error'}`,
      lines,
    )
  }
  const meta = parsed.meta

  if (!(req.budgetBuffer instanceof SharedArrayBuffer) || req.budgetBuffer.byteLength < BUDGET_SLOTS * 8) {
    throw new TypeError(`budgetBuffer must be a SharedArrayBuffer of at least ${BUDGET_SLOTS * 8} bytes.`)
  }
  const maxItems = req.maxItems ?? DEFAULT_MAX_ITEMS
  if (!Number.isInteger(maxItems) || maxItems < 1) throw new RangeError('maxItems must be a positive integer.')

  let argsJson: string | undefined
  try {
    argsJson = req.args === undefined ? undefined : JSON.stringify(req.args)
  } catch (e) {
    throw new TypeError(`The args value cannot be serialized to JSON: ${(e as Error).message}`)
  }

  const init: WorkerInit = {
    code: parsed.code,
    filename: req.filename,
    meta,
    argsJson,
    budgetBuffer: req.budgetBuffer,
    maxItems,
  }

  return new Promise<RunScriptResult>((resolve, reject) => {
    const worker = new Worker(workerUrl(), { workerData: init, name: `ultracode-script:${meta.name}` })
    let settled = false

    const finish = (outcome: { value: unknown } | { error: unknown }): void => {
      if (settled) return
      settled = true
      req.signal?.removeEventListener('abort', onAbort)
      // Wait for terminate() to finish so that no live worker remains after runScript returns.
      worker.terminate().then(
        () => done(outcome),
        () => done(outcome),
      )
    }
    const done = (outcome: { value: unknown } | { error: unknown }): void => {
      if ('error' in outcome) reject(outcome.error)
      else resolve({ meta, value: outcome.value })
    }

    const onAbort = (): void => finish({ error: new AbortedError() })
    req.signal?.addEventListener('abort', onAbort, { once: true })

    const reply = (m: MainToWorker): void => {
      if (settled) return
      try {
        worker.postMessage(m)
      } catch (e) {
        // The hook result cannot be cloned (functions, symbols…) – the script gets a clear error.
        if (m.t === 'rpcResult' && m.ok) {
          worker.postMessage({
            t: 'rpcResult',
            id: m.id,
            ok: false,
            error: serializeError(new TypeError(`Hook result cannot be passed to the script: ${(e as Error).message}`)),
          } satisfies MainToWorker)
        }
      }
    }

    const handleRpc = (msg: Extract<WorkerToMain, { t: 'rpc' }>): void => {
      let promise: Promise<unknown>
      try {
        switch (msg.method) {
          case 'agent':
            promise = Promise.resolve(req.hooks.agent(...msg.params))
            break
          case 'loadWorkflow':
            promise = Promise.resolve(req.hooks.loadWorkflow(...msg.params))
            break
          default:
            promise = Promise.reject(new Error(`Unknown RPC method: ${(msg as { method: string }).method}`))
        }
      } catch (e) {
        promise = Promise.reject(e)
      }
      promise.then(
        (value) => reply({ t: 'rpcResult', id: msg.id, ok: true, value: value === undefined ? null : value }),
        (error: unknown) => reply({ t: 'rpcResult', id: msg.id, ok: false, error: serializeError(error) }),
      )
    }

    const handleFire = (msg: Extract<WorkerToMain, { t: 'fire' }>): void => {
      if (settled) return
      try {
        switch (msg.method) {
          case 'phase':
            req.hooks.phase(...msg.params)
            break
          case 'log':
            req.hooks.log(...msg.params)
            break
          case 'workflowEnter':
            req.hooks.workflowEnter(...msg.params)
            break
          case 'workflowExit':
            req.hooks.workflowExit(...msg.params)
            break
        }
      } catch {
        // fire-and-forget: an error in an observation hook must not crash the script run
      }
    }

    worker.on('message', (msg: WorkerToMain) => {
      if (settled) return
      switch (msg.t) {
        case 'rpc':
          handleRpc(msg)
          break
        case 'fire':
          handleFire(msg)
          break
        case 'done': {
          try {
            finish({ value: JSON.parse(msg.json) })
          } catch (e) {
            finish({ error: e })
          }
          break
        }
        case 'error':
          finish({ error: reviveError(msg.error) })
          break
      }
    })
    worker.on('error', (err) => finish({ error: err }))
    worker.on('exit', (code) => {
      if (settled) return
      finish({
        error: new Error(
          code === 0
            ? 'Script worker exited without a result.'
            : `Script worker exited with code ${code} (probably out of memory or the process crashed).`,
        ),
      })
    })

    if (req.signal?.aborted) onAbort()
  })
}
