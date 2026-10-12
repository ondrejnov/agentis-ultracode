/**
 * Vstupní bod worker threadu, ve kterém běží skript workflow (spouští ho host.ts).
 *
 * Worker nikdy nespouští `claude` ani nesahá na disk: všechno, co skript potřebuje od enginu (agent, phase, log,
 * loadWorkflow, …), jde přes `postMessage` na hlavní vlákno jako RPC s korelačním id. Díky tomu lze skript
 * při abortu bezpodmínečně utnout `worker.terminate()` i uprostřed `while (true) {}`.
 */

import { parentPort, workerData } from 'node:worker_threads'
import type { AgentOptions, HookCall, LoadedScript, ScriptHooks } from '../types.ts'
import { BUDGET_SLOTS } from '../types.ts'
import { reviveError, serializeError } from './protocol.ts'
import type { MainToWorker, WorkerFire, WorkerInit, WorkerRpc, WorkerToMain } from './protocol.ts'
import { runInSandbox } from './sandbox.ts'

const port = parentPort
if (!port) throw new Error('worker.ts lze spustit jen jako worker thread (použij runScript z host.ts).')
const send = (m: WorkerToMain): void => port.postMessage(m)

const init = workerData as WorkerInit
let finished = false

// ───────── RPC na hlavní vlákno ─────────

let nextId = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
let idleCheck: NodeJS.Immediate | null = null

/**
 * Detekce uváznutí: skript čeká na Promise, kterou už nikdo nevyřeší (žádné RPC neběží, žádný timer neexistuje,
 * mikrotasky jsou vyprázdněné). Bez toho by běh visel do nekonečna.
 */
function scheduleIdleCheck(): void {
  if (finished || idleCheck) return
  idleCheck = setImmediate(() => {
    idleCheck = null
    if (finished || pending.size > 0) return
    finished = true
    send({
      t: 'error',
      error: {
        name: 'Error',
        message:
          'Skript uvázl: čeká na Promise, která se nikdy nevyřeší, a přitom neběží žádný agent ani jiná operace ' +
          '(například `await new Promise(() => {})` nebo zapomenuté resolve).',
      },
    })
  })
}

function rpc<T extends WorkerRpc>(method: T['method'], params: T['params']): Promise<unknown> {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ t: 'rpc', id, method, params } as WorkerToMain)
  })
}

function fire(msg: WorkerFire): void {
  send({ t: 'fire', ...msg } as WorkerToMain)
}

port.on('message', (m: MainToWorker) => {
  if (m.t !== 'rpcResult') return
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  if (m.ok) p.resolve(m.value)
  else p.reject(reviveError(m.error))
  scheduleIdleCheck()
})

const hooks: ScriptHooks = {
  agent: (prompt: string, opts: AgentOptions, call: HookCall) => rpc<WorkerRpc>('agent', [prompt, opts, call]),
  loadWorkflow: (ref: string | { scriptPath: string }, call: HookCall) =>
    rpc<WorkerRpc>('loadWorkflow', [ref, call]) as Promise<LoadedScript>,
  phase: (title: string, call: HookCall) => fire({ method: 'phase', params: [title, call] }),
  log: (message: string, call: HookCall) => fire({ method: 'log', params: [message, call] }),
  workflowEnter: (name: string, call: HookCall) => fire({ method: 'workflowEnter', params: [name, call] }),
  workflowExit: (name: string, call: HookCall) => fire({ method: 'workflowExit', params: [name, call] }),
}

// ───────── běh skriptu ─────────

const budget = new Float64Array(init.budgetBuffer, 0, BUDGET_SLOTS)

runInSandbox(
  { code: init.code, filename: init.filename, meta: init.meta },
  { hooks, budget, maxItems: init.maxItems },
  { argsJson: init.argsJson, workflowPath: [init.meta.name], depth: 0 },
).then(
  (json) => {
    if (finished) return
    finished = true
    send({ t: 'done', json })
  },
  (err: unknown) => {
    if (finished) return
    finished = true
    send({ t: 'error', error: serializeError(err) })
  },
)
scheduleIdleCheck()
