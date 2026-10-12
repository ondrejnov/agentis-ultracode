/** `ultracode logs <runId> [--follow] [--agent n]`. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunEvent } from '../../types.ts'
import { resolveStore } from '../defaults.ts'
import { safeJson } from '../format.ts'
import { bool, parseCommandLine, parsePositiveInt, str } from '../options.ts'
import { createRenderState, renderEvent } from '../render.ts'
import type { CommandContext } from '../types.ts'
import { UsageError } from '../types.ts'
import { assertSafeRunId, errorLine, nowMs, resolveCwd, sleepMs, styleFor, writeLines, jsonIndent } from './shared.ts'

export async function logsCommand(ctx: CommandContext, argv: string[]): Promise<number> {
  const { io, deps } = ctx
  const parsed = parseCommandLine('logs', argv)
  const v = parsed.values
  if (parsed.positionals.length !== 1) throw new UsageError('The logs command requires exactly one runId: ultracode logs <runId>')
  const runId = parsed.positionals[0]
  assertSafeRunId(runId)
  const follow = bool(v.follow)
  const agentRaw = str(v.agent)
  const agentId = parsePositiveInt('agent', agentRaw)
  if (follow && agentId !== undefined) throw new UsageError('The --follow and --agent options cannot be combined.')

  const cwd = resolveCwd(ctx, v)
  const store = await resolveStore(deps)
  const summary = await store.readRunSummary(cwd, runId)
  if (!summary) {
    errorLine(ctx, `Run "${runId}" not found in ${store.runsRoot(cwd)}. List: ultracode list`)
    return 2
  }
  const style = styleFor(ctx, v)

  // ── --agent: prompt + result ──
  if (agentId !== undefined) {
    return printAgent(ctx, store.runsRoot(cwd), runId, agentId, await store.readEvents(cwd, runId), style, bool(v.json))
  }

  // ── events ──
  const renderState = createRenderState()
  const renderOpts = { style, timestamps: true }
  const asJson = bool(v.json)
  const emit = (events: RunEvent[]) => {
    if (asJson) {
      for (const e of events) io.stdout.write(`${safeJson(e)}\n`)
    } else {
      for (const e of events) writeLines(io.stdout, renderEvent(e, renderState, renderOpts))
    }
  }

  // A run is "alive" while something holds its lock (.lock): the engine holds it for the whole run, including on resume.
  // This cannot be reliably determined from run.json or from run_end in the log – an interrupted run has run_end and resume
  // appends a new run_start to the same events.jsonl, and run.json is only rewritten with a delay.
  // A store replacement without runLockHeld relies on the status in run.json, so we read it again (not from the first read).
  const lockHeld = async (): Promise<boolean> => {
    if (store.runLockHeld) return store.runLockHeld(cwd, runId)
    return (await store.readRunSummary(cwd, runId))?.status === 'running'
  }

  // The lock is read BEFORE the events: anything the engine wrote before releasing the lock is then guaranteed to show up.
  let held = await lockHeld()
  let events = await store.readEvents(cwd, runId)
  emit(events)
  let seen = events.length
  if (!follow || !held) return 0

  // ── --follow: until the run ends (lock released), cancellation, or silence longer than followIdleMs ──
  const pollMs = deps.followPollMs ?? 500
  const idleMs = deps.followIdleMs ?? 30 * 60_000
  let lastChange = nowMs(ctx)
  while (true) {
    if (deps.signal?.aborted) return 130
    await sleepMs(ctx, pollMs)
    if (deps.signal?.aborted) return 130
    held = await lockHeld()
    events = await store.readEvents(cwd, runId)
    if (events.length > seen) {
      emit(events.slice(seen))
      seen = events.length
      lastChange = nowMs(ctx)
    }
    if (!held) return 0
    if (nowMs(ctx) - lastChange >= idleMs) {
      errorLine(ctx, `Run ${runId} sent no event for ${Math.round(idleMs / 60_000)} min; it has probably crashed. Stopped following.`)
      return 1
    }
  }
}

function readIfExists(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function printAgent(
  ctx: CommandContext,
  runsRoot: string,
  runId: string,
  agentId: number,
  events: RunEvent[],
  style: ReturnType<typeof styleFor>,
  asJson: boolean,
): number {
  const dir = join(runsRoot, runId, 'agents', String(agentId))
  const prompt = readIfExists(join(dir, 'prompt.txt'))
  const resultRaw = readIfExists(join(dir, 'result.json'))
  const stderrTxt = readIfExists(join(dir, 'stderr.txt'))
  if (prompt === null && resultRaw === null && stderrTxt === null) {
    errorLine(ctx, `Agent #${agentId} not found in run ${runId} (${dir}).`)
    return 2
  }
  let result: unknown = null
  if (resultRaw !== null) {
    try {
      result = JSON.parse(resultRaw)
    } catch {
      result = resultRaw
    }
  }

  if (asJson) {
    ctx.io.stdout.write(`${safeJson({ id: agentId, dir, prompt, result, stderr: stderrTxt }, jsonIndent(ctx.io))}\n`)
    return 0
  }

  const start = events.find((e) => e.t === 'agent_start' && e.id === agentId)
  const out: string[] = []
  const title = start && start.t === 'agent_start' ? `Agent #${agentId}  ${start.label}${start.phase ? `  (phase ${start.phase})` : ''}` : `Agent #${agentId}`
  out.push(style.bold(title))
  out.push(style.dim(dir))
  out.push('')
  out.push(style.bold('-- Prompt --'))
  out.push(prompt === null ? style.dim('(prompt.txt is missing)') : prompt.replace(/\n+$/, ''))
  out.push('')
  out.push(style.bold('-- Result --'))
  if (resultRaw === null) {
    out.push(style.dim('(result.json is missing – the agent may still be running)'))
  } else if (typeof result === 'string') {
    out.push(result)
  } else {
    out.push(safeJson(result, 2))
  }
  if (stderrTxt !== null && stderrTxt.trim() !== '') {
    out.push('')
    out.push(style.bold('-- stderr --'))
    out.push(stderrTxt.replace(/\n+$/, ''))
  }
  writeLines(ctx.io.stdout, out)
  return 0
}
