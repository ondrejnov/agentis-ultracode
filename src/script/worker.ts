/**
 * Entry point of the worker thread that runs the workflow script (started by host.ts).
 *
 * The worker never runs `claude` nor touches the disk: everything the script needs from the engine (agent, phase, log,
 * loadWorkflow, …), goes through `postMessage` to the main thread as RPC with a correlation id. This lets the script
 * be unconditionally stopped on abort by `worker.terminate()` even in the middle of `while (true) {}`.
 */

import { parentPort, workerData } from 'node:worker_threads'
import type { AgentOptions, HookCall, LoadedScript, ScriptHooks } from '../types.ts'
import { BUDGET_SLOTS } from '../types.ts'
import { reviveError, serializeError } from './protocol.ts'
import type { MainToWorker, WorkerFire, WorkerInit, WorkerRpc, WorkerToMain } from './protocol.ts'
import { runInSandbox } from './sandbox.ts'

const port = parentPort
if (!port) throw new Error('worker.ts can only be run as a worker thread (use runScript from host.ts).')
const send = (m: WorkerToMain): void => port.postMessage(m)

const init = workerData as WorkerInit
let finished = false

// ───────── RPC to the main thread ─────────

let nextId = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
let idleCheck: NodeJS.Immediate | null = null

/**
 * Deadlock detection: the script waits on a Promise that nobody will ever resolve (no RPC is running, no timer exists,
 * microtasks are drained). Without it the run would hang forever.
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
          'Script is stuck: it waits on a Promise that will never resolve, and no agent or other operation is running ' +
          '(for example `await new Promise(() => {})` or a forgotten resolve).',
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

// ───────── script run ─────────

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
