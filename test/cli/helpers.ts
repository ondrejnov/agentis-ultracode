/** Sdílené pomůcky testů CLI: zachycení I/O, podvržený store/discovery/engine. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliDeps, CliDiscovery, CliIO, CliStore, WorkflowInfo } from '../../src/cli/types.ts'
import type { RunEvent, RunOptions, RunSummary } from '../../src/types.ts'

export interface Captured {
  io: CliIO
  out(): string
  err(): string
}

export function makeIO(opts: { isTTY?: boolean; stdoutIsTTY?: boolean; env?: Record<string, string | undefined>; cwd?: string } = {}): Captured {
  let out = ''
  let err = ''
  const io: CliIO = {
    stdout: { write: (c: string) => ((out += c), true) },
    stderr: { write: (c: string) => ((err += c), true) },
    isTTY: opts.isTTY ?? false,
    env: opts.env ?? {},
    cwd: opts.cwd ?? process.cwd(),
  }
  if (opts.stdoutIsTTY !== undefined) io.stdoutIsTTY = opts.stdoutIsTTY
  return { io, out: () => out, err: () => err }
}

export function tmpDir(prefix = 'uc-cli-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

export function makeSummary(p: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'wf_aaaaaaaa-111',
    name: 'demo',
    status: 'completed',
    startedAt: '2026-01-01T10:00:00.000Z',
    endedAt: '2026-01-01T10:01:05.000Z',
    durationMs: 65_000,
    runDir: '/proj/.ultracode/runs/wf_aaaaaaaa-111',
    scriptPath: '/proj/.ultracode/workflows/demo.workflow.ts',
    totals: {
      agents: 3,
      cachedAgents: 1,
      failedAgents: 0,
      toolCalls: 7,
      usage: { inputTokens: 1500, outputTokens: 2500, cacheReadTokens: 10_000, cacheCreationTokens: 500 },
      costUsd: 0.0421,
    },
    ...p,
  }
}

export const T0 = '2026-01-01T10:00:00.000Z'

export function ev<T extends RunEvent['t']>(t: T, rest: Omit<Extract<RunEvent, { t: T }>, 't' | 'ts'> & { ts?: string }): RunEvent {
  return { t, ts: T0, ...rest } as unknown as RunEvent
}

export interface FakeRun {
  summary: RunSummary
  events?: RunEvent[]
}

export function makeStore(runs: FakeRun[], root = '/proj/.ultracode/runs'): CliStore & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    runsRoot: () => root,
    listRuns: () => {
      calls.push('listRuns')
      return runs.map((r) => r.summary)
    },
    readRunSummary: (_cwd, id) => runs.find((r) => r.summary.runId === id)?.summary ?? null,
    readEvents: (_cwd, id) => runs.find((r) => r.summary.runId === id)?.events ?? [],
  }
}

export function makeDiscovery(workflows: WorkflowInfo[] = [], map: Record<string, string> = {}): CliDiscovery {
  return {
    listWorkflows: () => workflows,
    findWorkflow: (ref) => {
      const p = map[ref]
      if (!p) throw Object.assign(new Error(`Workflow „${ref}“ nenalezeno.`), { code: 'WORKFLOW_NOT_FOUND' })
      return p
    },
  }
}

/** Engine, který zaznamená volání a vrátí zadané shrnutí (případně pošle události přes onEvent). */
export function fakeEngine(result: RunSummary | ((o: RunOptions) => Promise<RunSummary> | RunSummary), events: RunEvent[] = []) {
  const calls: RunOptions[] = []
  const runWorkflow: NonNullable<CliDeps['runWorkflow']> = async (opts) => {
    calls.push(opts)
    for (const e of events) opts.onEvent?.(e)
    return typeof result === 'function' ? await result(opts) : result
  }
  return { calls, runWorkflow }
}
