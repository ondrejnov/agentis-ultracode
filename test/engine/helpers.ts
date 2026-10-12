/**
 * Společné pomůcky testů enginu: dočasný projekt, stub runneru (ClaudeRunner), stub parseru a hostu skriptu.
 * Skript "workflow" je v testech obyčejná async funkce nad ScriptHooks — engine tak testujeme izolovaně
 * od modulů SCRIPT a RUNNER.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EngineDeps, ParsedScriptLike } from '../../src/engine/engine.ts'
import { EMPTY_USAGE } from '../../src/types.ts'
import type {
  AgentOptions,
  ClaudeRunRequest,
  ClaudeRunResult,
  ClaudeRunner,
  RunEvent,
  RunScriptRequest,
  RunScriptResult,
  RunSummary,
} from '../../src/types.ts'

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export interface TempProject {
  cwd: string
  /** Napíše skript (obsah je pro stuby nepodstatný) a vrátí absolutní cestu. */
  script(name?: string, content?: string): string
  cleanup(): void
}

export function makeProject(): TempProject {
  const cwd = mkdtempSync(join(tmpdir(), 'ultracode-engine-'))
  return {
    cwd,
    script(name = 'wf.workflow.ts', content = '// name: wf\n') {
      const p = join(cwd, name)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, content)
      return p
    },
    cleanup() {
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

// ───────────────────────── stub runneru ─────────────────────────

export interface StubRunnerOptions {
  /** Prodleva v ms; může záviset na promptu. */
  delayMs?: number | ((req: ClaudeRunRequest) => number)
  outputTokens?: number | ((req: ClaudeRunRequest) => number)
  costUsd?: number
  /** Vrací chybovou zprávu → agent selže (ok:false). */
  fail?: (req: ClaudeRunRequest, n: number) => string | undefined
  /** Vlastní odpověď; default `out:<prompt>` resp. `{ value: <prompt> }` při schema. */
  respond?: (req: ClaudeRunRequest, n: number) => unknown
  /** Vyhodí výjimku místo vrácení výsledku. */
  throws?: (req: ClaudeRunRequest, n: number) => boolean
}

export interface StubRunner {
  runner: ClaudeRunner
  calls: ClaudeRunRequest[]
  prompts(): string[]
  readonly inFlight: number
  readonly maxInFlight: number
}

export function makeRunner(o: StubRunnerOptions = {}): StubRunner {
  const calls: ClaudeRunRequest[] = []
  let inFlight = 0
  let maxInFlight = 0
  const runner: ClaudeRunner = async (req) => {
    const n = calls.length + 1
    calls.push(req)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    const started = Date.now()
    try {
      req.onProgress?.({ kind: 'start', attempt: 1 })
      const delay = typeof o.delayMs === 'function' ? o.delayMs(req) : (o.delayMs ?? 0)
      const aborted = await new Promise<boolean>((resolve) => {
        if (req.signal?.aborted) return resolve(true)
        const t = setTimeout(() => {
          req.signal?.removeEventListener('abort', onAbort)
          resolve(false)
        }, delay)
        const onAbort = () => {
          clearTimeout(t)
          resolve(true)
        }
        req.signal?.addEventListener('abort', onAbort, { once: true })
      })
      const base: ClaudeRunResult = {
        ok: true,
        text: null,
        structured: undefined,
        usage: { ...EMPTY_USAGE },
        costUsd: 0,
        numTurns: 1,
        toolCalls: 0,
        durationMs: Date.now() - started,
        attempts: 1,
      }
      if (aborted) {
        return { ...base, ok: false, error: { kind: 'aborted', message: 'přerušeno' } }
      }
      if (o.throws?.(req, n)) throw new Error('runner exploded')
      const failMsg = o.fail?.(req, n)
      const tokens = typeof o.outputTokens === 'function' ? o.outputTokens(req) : (o.outputTokens ?? 10)
      const usage = { inputTokens: 5, outputTokens: tokens, cacheReadTokens: 0, cacheCreationTokens: 0 }
      if (failMsg !== undefined) {
        return { ...base, ok: false, usage, costUsd: o.costUsd ?? 0, error: { kind: 'exit', message: failMsg } }
      }
      const answer = o.respond ? o.respond(req, n) : req.schema ? { value: req.prompt } : `out:${req.prompt}`
      req.onProgress?.({ kind: 'tool', name: 'Read' })
      const res: ClaudeRunResult = {
        ...base,
        usage,
        costUsd: o.costUsd ?? 0.001,
        toolCalls: 1,
        sessionId: `sess-${n}`,
      }
      if (req.schema) res.structured = answer
      else res.text = typeof answer === 'string' ? answer : JSON.stringify(answer)
      return res
    } finally {
      inFlight--
    }
  }
  return {
    runner,
    calls,
    prompts: () => calls.map((c) => c.prompt),
    get inFlight() {
      return inFlight
    },
    get maxInFlight() {
      return maxInFlight
    },
  }
}

// ───────────────────────── stub parseru a hostu ─────────────────────────

export function stubParse(source: string, _filename: string): ParsedScriptLike {
  if (source.includes('INVALID')) {
    return {
      ok: false,
      meta: null,
      diagnostics: [
        { level: 'error', message: 'chybí export const meta', line: 1 },
        { level: 'warning', message: 'jen varování' },
      ],
    }
  }
  const m = /\/\/ name: (\S+)/.exec(source)
  const phases = /\/\/ phases: (.+)/.exec(source)
  return {
    ok: true,
    meta: {
      name: m ? m[1] : 'test-wf',
      description: 'testovací workflow',
      ...(phases ? { phases: phases[1].split(',').map((t) => ({ title: t.trim() })) } : {}),
    },
    diagnostics: [],
  }
}

/** API připomínající globály skriptu, postavené nad hooks z enginu. */
export interface ScriptApi {
  agent(prompt: string, opts?: AgentOptions): Promise<any>
  phase(title: string): void
  log(message: string): void
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>
  args: any
  budget: { spent(): number; spentUsd(): number; total: number | null; totalUsd: number | null }
  hooks: RunScriptRequest['hooks']
  path: string[]
  signal?: AbortSignal
}

export function makeApi(req: RunScriptRequest, path: string[] = ['test-wf']): ScriptApi {
  const call = { workflowPath: path }
  const view = new Float64Array(req.budgetBuffer)
  return {
    agent: (prompt, opts = {}) => req.hooks.agent(prompt, opts, call),
    phase: (t) => req.hooks.phase(t, call),
    log: (m) => req.hooks.log(m, call),
    parallel: (thunks) => Promise.all(thunks.map((t) => t().catch(() => null))),
    args: req.args,
    budget: {
      spent: () => view[0],
      spentUsd: () => view[2],
      total: view[1] < 0 ? null : view[1],
      totalUsd: view[3] < 0 ? null : view[3],
    },
    hooks: req.hooks,
    path,
    signal: req.signal,
  }
}

/** deps pro runWorkflow: tělo skriptu je zadaná funkce; návratová hodnota = výsledek skriptu. */
export function scriptDeps(body: (api: ScriptApi, req: RunScriptRequest) => Promise<unknown> | unknown, extra: EngineDeps = {}): EngineDeps {
  return {
    parseScript: stubParse,
    runScript: async (req): Promise<RunScriptResult> => {
      const meta = stubParse(req.source, req.filename).meta ?? { name: 'test-wf', description: '' }
      const value = await body(makeApi(req, [meta.name]), req)
      return { meta, value }
    },
    ...extra,
  }
}

// ───────────────────────── čtení výstupů ─────────────────────────

export function readJsonl<T = any>(path: string): T[] {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T)
}

export function readJsonFile<T = any>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export function eventsOf(summary: RunSummary): RunEvent[] {
  return readJsonl<RunEvent>(join(summary.runDir, 'events.jsonl'))
}

export function journalOf(summary: RunSummary): any[] {
  return readJsonl(join(summary.runDir, 'journal.jsonl'))
}

/** Počká, až podmínka platí (max `timeoutMs`). */
export async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: vypršel čas')
    await sleep(5)
  }
}
