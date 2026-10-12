/**
 * `runScript()` – spustí skript workflow ve worker threadu a obsluhuje jeho RPC (agent, phase, log, …)
 * proti `ScriptHooks` enginu. Hlavní vlákno nikdy nevykonává kód skriptu, takže abort funguje vždy:
 * `worker.terminate()` utne i nekonečnou smyčku.
 */

import { Worker } from 'node:worker_threads'
import { AbortedError, ScriptValidationError } from '../errors.ts'
import type { RunScriptRequest, RunScriptResult } from '../types.ts'
import { BUDGET_SLOTS } from '../types.ts'
import { formatDiagnostic, parseScript } from './parse.ts'
import { reviveError, serializeError } from './protocol.ts'
import type { MainToWorker, WorkerInit, WorkerToMain } from './protocol.ts'

export const DEFAULT_MAX_ITEMS = 4096

/** worker.ts / worker.js podle toho, z čeho běžíme (type-stripping vs. zkompilovaný dist). */
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
      `Skript „${req.filename}“ je neplatný: ${first ? `${first.line ? `řádek ${first.line}: ` : ''}${first.message}` : 'neznámá chyba'}`,
      lines,
    )
  }
  const meta = parsed.meta

  if (!(req.budgetBuffer instanceof SharedArrayBuffer) || req.budgetBuffer.byteLength < BUDGET_SLOTS * 8) {
    throw new TypeError(`budgetBuffer musí být SharedArrayBuffer o velikosti alespoň ${BUDGET_SLOTS * 8} bajtů.`)
  }
  const maxItems = req.maxItems ?? DEFAULT_MAX_ITEMS
  if (!Number.isInteger(maxItems) || maxItems < 1) throw new RangeError('maxItems musí být kladné celé číslo.')

  let argsJson: string | undefined
  try {
    argsJson = req.args === undefined ? undefined : JSON.stringify(req.args)
  } catch (e) {
    throw new TypeError(`Hodnota args nejde serializovat do JSON: ${(e as Error).message}`)
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
      // Počkáme na doběhnutí terminate(), aby po návratu runScript nezůstal žádný živý worker.
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
        // Výsledek hooku nejde naklonovat (funkce, symboly…) – skript dostane srozumitelnou chybu.
        if (m.t === 'rpcResult' && m.ok) {
          worker.postMessage({
            t: 'rpcResult',
            id: m.id,
            ok: false,
            error: serializeError(new TypeError(`Výsledek hooku nelze předat skriptu: ${(e as Error).message}`)),
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
            promise = Promise.reject(new Error(`Neznámá RPC metoda: ${(msg as { method: string }).method}`))
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
        // fire-and-forget: chyba v hooku pozorování nesmí shodit běh skriptu
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
            ? 'Worker skriptu skončil bez výsledku.'
            : `Worker skriptu skončil s kódem ${code} (pravděpodobně došla paměť nebo proces spadl).`,
        ),
      })
    })

    if (req.signal?.aborted) onAbort()
  })
}
