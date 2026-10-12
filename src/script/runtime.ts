/**
 * Runtime globálů pro skript workflow – kód, který běží UVNITŘ vm kontextu skriptu.
 *
 * `installRuntime` je záměrně samostatná funkce bez odkazů na okolní modul: do kontextu se dostane přes
 * `Function.prototype.toString()` (viz sandbox.ts) a vykoná se v realmu skriptu. Díky tomu jsou `Promise`,
 * `Array`, `Error` i výsledky `parallel()`/`pipeline()` objekty téhož realmu jako kód skriptu
 * (`instanceof Array`, `Array.isArray`, `await` fungují očekávaně) a skript nikdy nedostane referenci
 * na objekty vnějšího realmu (ty by umožnily únik k `process`).
 *
 * Přes hranici realmu jdou VÝHRADNĚ řetězce (JSON) a čísla:
 *  - `bridge.call(method, json)`  → Promise<string> s obálkou `{ok:true,value}` / `{ok:false,error}` (nikdy nerejectne),
 *  - `bridge.fire(method, json)`  → synchronní obálka (phase/log),
 *  - `bridge.slot(i)`             → číslo z SharedArrayBuffer rozpočtu,
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
    const err: any = new NativeError(String(info && info.message !== undefined ? info.message : 'Neznámá chyba'))
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
      // Chyba z vnořeného workflow: ponecháme její původní stack (řádky potomka) a přidáme rámce volajícího.
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
      if (s === undefined) throw new NativeError('hodnota není serializovatelná')
      return s
    } catch (e) {
      throw new TypeError(what + ': argumenty nelze serializovat do JSON (' + describe(e) + ')')
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
          fire('log', { message: who + ': ' + where + ' selhala a výsledek je null: ' + describe(e) })
        } catch (_) {
          /* log nesmí shodit běh */
        }
      },
      flush(): void {
        if (count <= MAX_REPORTED_FAILURES) return
        try {
          fire('log', { message: who + ': dalších ' + (count - MAX_REPORTED_FAILURES) + ' chyb nezobrazeno (celkem ' + count + ')' })
        } catch (_) {
          /* nic */
        }
      },
    }
  }

  function checkCount(who: string, count: number): void {
    if (count > cfg.maxItems) {
      throw new RangeError(who + ': příliš mnoho položek (' + count + '), maximum je ' + cfg.maxItems + '. Rozděl práci na dávky.')
    }
  }

  async function parallel(thunks: unknown): Promise<any[]> {
    if (!isArray(thunks)) throw new TypeError('parallel(): očekává pole funkcí (thunků), např. parallel(items.map((x) => () => agent(...)))')
    checkCount('parallel()', (thunks as unknown[]).length)
    const failures = failureReporter('parallel()')
    // Všechny thunky se spustí synchronně v pořadí; selhání jednoho je jen null v jeho pozici.
    // Hotový Promise místo funkce se tolerantně awaituje (jinak by se jeho výsledek tiše ztratil).
    const results = await promiseAll(
      arrayFrom(thunks as unknown[], async (thunk: any, index: number) => {
        try {
          return typeof thunk === 'function' ? await thunk() : await thunk
        } catch (e) {
          failures.add('položka ' + index, e)
          return null
        }
      }),
    )
    failures.flush()
    return results
  }

  async function pipeline(items: unknown, ...stages: unknown[]): Promise<any[]> {
    if (!isArray(items)) throw new TypeError('pipeline(): první argument musí být pole položek')
    checkCount('pipeline()', (items as unknown[]).length)
    for (let s = 0; s < stages.length; s++) {
      if (typeof stages[s] !== 'function') throw new TypeError('pipeline(): stage ' + (s + 1) + ' musí být funkce (prev, original, index)')
    }
    const failures = failureReporter('pipeline()')
    // Každá položka prochází stagemi samostatně – žádná bariéra mezi stagemi.
    const results = await promiseAll(
      arrayFrom(items as unknown[], async (item: unknown, index: number) => {
        let current: unknown = item
        for (let s = 0; s < stages.length; s++) {
          try {
            current = await (stages[s] as Function)(current, item, index)
          } catch (e) {
            failures.add('položka ' + index + ', stage ' + (s + 1), e)
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
    if (typeof title !== 'string' || title.trim() === '') throw new TypeError('phase(): titul musí být neprázdný řetězec')
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
        return '[nelze zobrazit]'
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

  // ───────── globály ─────────

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
