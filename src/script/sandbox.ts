/**
 * Sandbox jednoho skriptu workflow: vm kontext + most (bridge) mezi realmem skriptu a hooks enginu.
 *
 * Neví nic o worker_threads – dostane `ScriptHooks` (ve workeru je to proxy přes postMessage, v testech mock).
 * Vnořené `workflow()` se spouští v NOVÉM vm kontextu tímtéž kódem (`runInSandbox` rekurzivně).
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
  /** Výstup `parseScript().code` – výraz s async funkcí. */
  code: string
  filename: string
  meta: WorkflowMeta
}

export interface SandboxShared {
  hooks: ScriptHooks
  /** Pohled na SharedArrayBuffer rozpočtu (Float64Array, BUDGET_SLOTS). */
  budget: Float64Array
  maxItems: number
}

export interface SandboxRun {
  argsJson: string | undefined
  /** `['root']` nebo `['root', 'child']`. */
  workflowPath: string[]
  /** 0 = kořenový skript, 1 = vnořené workflow. */
  depth: number
}

/** Nejhlubší povolené vnoření `workflow()` (kořen má hloubku 0). */
const MAX_NESTING_DEPTH = 1

let runtimeSource: string | undefined

function getRuntimeSource(): string {
  runtimeSource ??= `(${installRuntime.toString()})`
  return runtimeSource
}

const ok = (value: unknown): string => JSON.stringify({ ok: true, value: value === undefined ? null : value })
const fail = (e: unknown, keepStack = false): string => {
  const error = serializeError(e)
  // Stack chyby z hooku enginu (interní rámce hlavního vlákna) skriptu nic neřekne; stack potomka ano.
  if (!keepStack) delete error.stack
  return JSON.stringify({ ok: false, error })
}

/**
 * Spustí skript a vrátí jeho návratovou hodnotu jako JSON řetězec (`undefined` → `'null'`).
 * Hází chybu skriptu (s původní zprávou a stackem s čísly řádků skriptu).
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
          throw new Error(`Neznámé volání mostu: ${method}`)
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
          throw new Error(`Neznámá událost mostu: ${method}`)
      }
      return '{"ok":true,"value":null}'
    } catch (e) {
      return fail(e)
    }
  }

  const runChild = async (ref: unknown, argsJson: string | undefined): Promise<string> => {
    if (run.depth >= MAX_NESTING_DEPTH) {
      throw new Error(
        'workflow() nelze volat z vnořeného workflow: vnoření je povoleno jen o jednu úroveň. ' +
          'Zavolej oba workflow postupně z kořenového skriptu.',
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
      throw new TypeError('workflow(): první argument musí být jméno workflow (řetězec) nebo { scriptPath }.')
    }

    const loaded = await hooks.loadWorkflow(hookRef, call())
    const parsed = parseScript(loaded.source, loaded.filename)
    if (!parsed.ok || !parsed.meta) {
      const lines = parsed.diagnostics.map((d) => formatDiagnostic(d, loaded.filename))
      const first = parsed.diagnostics.find((d) => d.level === 'error')
      throw new ScriptValidationError(
        `Vnořené workflow „${typeof hookRef === 'string' ? hookRef : hookRef.scriptPath}“ je neplatné: ${first ? first.message : 'neznámá chyba'}`,
        lines,
      )
    }
    const name = parsed.meta.name
    // enter/exit nesou cestu POTOMKA (['rodič', 'potomek']), stejně jako hooky agent/phase/log uvnitř něj
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
        /* chyba v exit hooku nesmí přebít výsledek ani původní chybu */
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

  // Každý běh má vlastní kontext → vlastní globály, vlastní Date/Math guardy.
  const context = createContext({}, { name: `ultracode:${script.meta.name}`, codeGeneration: { strings: false, wasm: false } })
  const install = new Script(getRuntimeSource(), { filename: 'ultracode-runtime.js' }).runInContext(context) as (
    b: RuntimeBridge,
    c: RuntimeConfig,
  ) => void
  install(bridge, config)

  const fn = new Script(script.code, { filename: script.filename }).runInContext(context) as unknown
  if (typeof fn !== 'function') throw new Error('Skript nevytvořil spustitelnou funkci (interní chyba parseru).')

  const value: unknown = await (fn as () => Promise<unknown>).call(undefined)
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch (e) {
    throw new TypeError(`Návratová hodnota skriptu nejde serializovat do JSON: ${(e as Error).message}`)
  }
  return json === undefined ? 'null' : json
}
