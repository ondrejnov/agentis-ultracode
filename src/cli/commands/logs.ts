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
  if (parsed.positionals.length !== 1) throw new UsageError('Příkaz logs vyžaduje právě jedno runId: ultracode logs <runId>')
  const runId = parsed.positionals[0]
  assertSafeRunId(runId)
  const follow = bool(v.follow)
  const agentRaw = str(v.agent)
  const agentId = parsePositiveInt('agent', agentRaw)
  if (follow && agentId !== undefined) throw new UsageError('Volby --follow a --agent nelze kombinovat.')

  const cwd = resolveCwd(ctx, v)
  const store = await resolveStore(deps)
  const summary = await store.readRunSummary(cwd, runId)
  if (!summary) {
    errorLine(ctx, `Běh „${runId}“ nenalezen v ${store.runsRoot(cwd)}. Seznam: ultracode list`)
    return 2
  }
  const style = styleFor(ctx, v)

  // ── --agent: prompt + výsledek ──
  if (agentId !== undefined) {
    return printAgent(ctx, store.runsRoot(cwd), runId, agentId, await store.readEvents(cwd, runId), style, bool(v.json))
  }

  // ── události ──
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

  // Běh „žije“, dokud ho někdo drží zámkem (.lock): engine ho drží po celou dobu běhu i při resume.
  // Podle run.json ani podle run_end v logu to nejde poznat spolehlivě – přerušený běh má run_end a resume
  // do téhož events.jsonl dopisuje nový run_start, a run.json se přepisuje až s zpožděním.
  // Náhrada store bez runLockHeld: spoléhá na status z run.json, proto ho čteme znovu (ne z prvního čtení).
  const lockHeld = async (): Promise<boolean> => {
    if (store.runLockHeld) return store.runLockHeld(cwd, runId)
    return (await store.readRunSummary(cwd, runId))?.status === 'running'
  }

  // Zámek se čte PŘED událostmi: co engine zapsal před uvolněním zámku, se tak v čtení určitě ukáže.
  let held = await lockHeld()
  let events = await store.readEvents(cwd, runId)
  emit(events)
  let seen = events.length
  if (!follow || !held) return 0

  // ── --follow: do konce běhu (uvolnění zámku), zrušení, nebo ticha delší než followIdleMs ──
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
      errorLine(ctx, `Běh ${runId} neposlal ${Math.round(idleMs / 60_000)} min žádnou událost; pravděpodobně spadl. Sledování ukončeno.`)
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
    errorLine(ctx, `Agent #${agentId} v běhu ${runId} nenalezen (${dir}).`)
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
  const title = start && start.t === 'agent_start' ? `Agent #${agentId}  ${start.label}${start.phase ? `  (fáze ${start.phase})` : ''}` : `Agent #${agentId}`
  out.push(style.bold(title))
  out.push(style.dim(dir))
  out.push('')
  out.push(style.bold('-- Prompt --'))
  out.push(prompt === null ? style.dim('(chybí prompt.txt)') : prompt.replace(/\n+$/, ''))
  out.push('')
  out.push(style.bold('-- Výsledek --'))
  if (resultRaw === null) {
    out.push(style.dim('(chybí result.json – agent možná ještě běží)'))
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
