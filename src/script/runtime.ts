/**
 * Runtime globals for a workflow script – code that runs INSIDE the script's vm context.
 *
 * `installRuntime` is intentionally a standalone function with no references to the surrounding module: it reaches the context via
 * `Function.prototype.toString()` (see sandbox.ts) and is executed in the script's realm. Therefore `Promise`,
 * `Array`, `Error` and the results of `parallel()`/`pipeline()` objects of the same realm as the script code
 * (`instanceof Array`, `Array.isArray`, `await` work as expected) and the script never gets a reference
 * to objects of the outer realm (those would allow an escape to `process`).
 *
 * Across the realm boundary ONLY strings (JSON) and numbers pass:
 *  - `bridge.call(method, json)`  → Promise<string> with an envelope `{ok:true,value}` / `{ok:false,error}` (never rejects),
 *  - `bridge.fire(method, json)`  → synchronous envelope (phase/log),
 *  - `bridge.slot(i)`             → number from the budget SharedArrayBuffer,
 *  - `bridge.determinism(what)`   → text chyby DeterminismError.
 */

export interface RuntimeBridge {
  call(method: string, payload: string): Promise<string>
  fire(method: string, payload: string): string
  slot(index: number): number
  determinism(what: string): string
}

export interface RuntimeConfig {
  argsJson: string | undefined
  maxItems: number
}

/* eslint-disable */
export function installRuntime(bridge: RuntimeBridge, cfg: RuntimeConfig): void {
  'use strict'

  const NativeDate = Date
  const NativeMath = Math
  const NativeError = Error as ErrorConstructor & { captureStackTrace?: (target: object, skip?: Function) => void; stackTraceLimit?: number }
  const NativeReflect = Reflect
  const jsonParse = JSON.parse.bind(JSON)
  const jsonStringify = JSON.stringify.bind(JSON)
  const defineProperty = Object.defineProperty.bind(Object)
  const promiseAll = Promise.all.bind(Promise)
  const mathMax = NativeMath.max.bind(NativeMath)
  const arrayFrom = Array.from.bind(Array)
  const isArray = Array.isArray.bind(Array)

  NativeError.stackTraceLimit = 50

  // ───────── chyby ─────────

  function makeError(
    info: { name?: string; message?: string; code?: string; stack?: string; diagnostics?: string[] },
    skipFn?: Function,
  ): any {
    const err: any = new NativeError(String(info && info.message !== undefined ? info.message : 'Unknown error'))
    if (info && info.name && info.name !== 'Error') {
      try {
        defineProperty(err, 'name', { value: String(info.name), configurable: true, writable: true, enumerable: false })
      } catch (_) {
        /* nic */
      }
    }
    if (info && info.code) err.code = String(info.code)
    if (info && isArray(info.diagnostics)) err.diagnostics = info.diagnostics
    if (skipFn && typeof NativeError.captureStackTrace === 'function') NativeError.captureStackTrace(err, skipFn)
    if (info && typeof info.stack === 'string' && info.stack !== '') {
      // Error from a nested workflow: we keep its original stack (child lines) and add the caller's frames.
      const own = String(err.stack)
        .split('\n')
        .filter((l: string) => /^\s+at /.test(l))
      err.stack = info.stack + (own.length > 0 ? '\n' + own.join('\n') : '')
    }
    return err
  }

  function describe(e: any): string {
    if (e && typeof e === 'object' && e.message !== undefined) {
      const name = e.name && e.name !== 'Error' ? String(e.name) + ': ' : ''
      return name + String(e.message)
    }
    return String(e)
  }

  function safeStringify(value: unknown, what: string): string {
    try {
      const s = jsonStringify(value)
      if (s === undefined) throw new NativeError('value is not serializable')
      return s
    } catch (e) {
      throw new TypeError(what + ': arguments cannot be serialized to JSON (' + describe(e) + ')')
    }
  }

  function unwrap(raw: string, skipFn: Function): any {
    const r = jsonParse(raw)
    if (!r.ok) throw makeError(r.error, skipFn)
    return r.value
  }

  function fire(method: string, payload: unknown): void {
    const r = jsonParse(bridge.fire(method, safeStringify(payload, method + '()')))
    if (!r.ok) throw makeError(r.error)
  }

  function determinism(what: string): any {
    return makeError({ name: 'DeterminismError', message: bridge.determinism(what), code: 'NON_DETERMINISTIC' }, determinism)
  }

  // ───────── determinismus ─────────

  NativeMath.random = function random(): number {
    throw determinism('Math.random()')
  }
  ;(NativeDate as any).now = function now(): number {
    throw determinism('Date.now()')
  }
  const GuardedDate: any = function Date(this: unknown, ...a: unknown[]): unknown {
    if (new.target === undefined) throw determinism('Date()')
    if (a.length === 0) throw determinism('new Date()')
    return NativeReflect.construct(NativeDate, a, new.target === GuardedDate ? NativeDate : new.target)
  }
  GuardedDate.prototype = NativeDate.prototype
  GuardedDate.UTC = NativeDate.UTC
  GuardedDate.parse = NativeDate.parse
  GuardedDate.now = (NativeDate as any).now
  defineProperty(NativeDate.prototype, 'constructor', { value: GuardedDate, writable: true, configurable: true, enumerable: false })

  // ───────── agent / workflow ─────────

  async function agent(prompt: unknown, opts?: unknown): Promise<any> {
    const payload = safeStringify({ prompt, opts: opts === undefined ? null : opts }, 'agent()')
    return unwrap(await bridge.call('agent', payload), agent)
  }

  async function workflow(nameOrRef: unknown, wfArgs?: unknown): Promise<any> {
    const payload = safeStringify(
      { ref: nameOrRef, hasArgs: wfArgs !== undefined, args: wfArgs === undefined ? null : wfArgs },
      'workflow()',
    )
    return unwrap(await bridge.call('workflow', payload), workflow)
  }

  // ───────── parallel / pipeline ─────────

  const MAX_REPORTED_FAILURES = 10

  function failureReporter(who: string) {
    let count = 0
    return {
      add(where: string, e: unknown): void {
        count++
        if (count > MAX_REPORTED_FAILURES) return
        try {
          fire('log', { message: who + ': ' + where + ' failed and its result is null: ' + describe(e) })
        } catch (_) {
          /* logging must not crash the run */
        }
      },
      flush(): void {
        if (count <= MAX_REPORTED_FAILURES) return
        try {
          fire('log', { message: who + ': ' + (count - MAX_REPORTED_FAILURES) + ' more errors not shown (total ' + count + ')' })
        } catch (_) {
          /* nic */
        }
      },
    }
  }

  function checkCount(who: string, count: number): void {
    if (count > cfg.maxItems) {
      throw new RangeError(who + ': too many items (' + count + '), maximum is ' + cfg.maxItems + '. Split the work into batches.')
    }
  }

  async function parallel(thunks: unknown): Promise<any[]> {
    if (!isArray(thunks)) throw new TypeError('parallel(): expects an array of functions (thunks), e.g. parallel(items.map((x) => () => agent(...)))')
    checkCount('parallel()', (thunks as unknown[]).length)
    const failures = failureReporter('parallel()')
    // All thunks are started synchronously in order; a failure of one is just null in its position.
    // A ready Promise instead of a function is awaited leniently (otherwise its result would be silently lost).
    const results = await promiseAll(
      arrayFrom(thunks as unknown[], async (thunk: any, index: number) => {
        try {
          return typeof thunk === 'function' ? await thunk() : await thunk
        } catch (e) {
          failures.add('item ' + index, e)
          return null
        }
      }),
    )
    failures.flush()
    return results
  }

  async function pipeline(items: unknown, ...stages: unknown[]): Promise<any[]> {
    if (!isArray(items)) throw new TypeError('pipeline(): the first argument must be an array of items')
    checkCount('pipeline()', (items as unknown[]).length)
    for (let s = 0; s < stages.length; s++) {
      if (typeof stages[s] !== 'function') throw new TypeError('pipeline(): stage ' + (s + 1) + ' must be a function (prev, original, index)')
    }
    const failures = failureReporter('pipeline()')
    // Each item passes through the stages independently – no barrier between stages.
    const results = await promiseAll(
      arrayFrom(items as unknown[], async (item: unknown, index: number) => {
        let current: unknown = item
        for (let s = 0; s < stages.length; s++) {
          try {
            current = await (stages[s] as Function)(current, item, index)
          } catch (e) {
            failures.add('item ' + index + ', stage ' + (s + 1), e)
            return null
          }
        }
        return current
      }),
    )
    failures.flush()
    return results
  }

  // ───────── phase / log / console ─────────

  function phase(title: unknown): void {
    if (typeof title !== 'string' || title.trim() === '') throw new TypeError('phase(): the title must be a non-empty string')
    fire('phase', { title })
  }

  function formatValue(v: unknown): string {
    if (typeof v === 'string') return v
    if (v === undefined) return 'undefined'
    if (v !== null && typeof v === 'object' && (v as any).message !== undefined && (v as any).name !== undefined) {
      return String((v as any).name) + ': ' + String((v as any).message)
    }
    try {
      const s = jsonStringify(v)
      return s === undefined ? String(v) : s
    } catch (_) {
      try {
        return String(v)
      } catch (__) {
        return '[cannot display]'
      }
    }
  }

  function log(message?: unknown): void {
    fire('log', { message: formatValue(message) })
  }

  function consoleMethod(prefix: string) {
    return function (...parts: unknown[]): void {
      log(prefix + parts.map(formatValue).join(' '))
    }
  }
  const consoleObject = {
    log: consoleMethod(''),
    info: consoleMethod(''),
    debug: consoleMethod(''),
    warn: consoleMethod('[warn] '),
    error: consoleMethod('[error] '),
  }

  // ───────── budget ─────────

  const budget = {
    get total(): number | null {
      const v = bridge.slot(1)
      return v < 0 ? null : v
    },
    get totalUsd(): number | null {
      const v = bridge.slot(3)
      return v < 0 ? null : v
    },
    spent(): number {
      return bridge.slot(0)
    },
    remaining(): number {
      const total = bridge.slot(1)
      return total < 0 ? Infinity : mathMax(0, total - bridge.slot(0))
    },
    spentUsd(): number {
      return bridge.slot(2)
    },
    remainingUsd(): number {
      const total = bridge.slot(3)
      return total < 0 ? Infinity : mathMax(0, total - bridge.slot(2))
    },
  }

  // ───────── globals ─────────

  const g: any = globalThis
  function define(name: string, value: unknown): void {
    defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false })
  }
  define('Date', GuardedDate)
  define('agent', agent)
  define('parallel', parallel)
  define('pipeline', pipeline)
  define('phase', phase)
  define('log', log)
  define('workflow', workflow)
  define('budget', budget)
  define('console', consoleObject)
  define('args', cfg.argsJson === undefined ? undefined : jsonParse(cfg.argsJson))
}
/* eslint-enable */
