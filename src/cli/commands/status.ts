/** `ultracode status [runId]`. */
import { resolveStore } from '../defaults.ts'
import { bool, parseCommandLine } from '../options.ts'
import { digestEvents, renderStatus } from '../render.ts'
import { safeJson } from '../format.ts'
import type { CommandContext } from '../types.ts'
import { UsageError } from '../types.ts'
import { assertSafeRunId, errorLine, nowMs, resolveCwd, styleFor, writeLines, jsonIndent } from './shared.ts'

export async function statusCommand(ctx: CommandContext, argv: string[]): Promise<number> {
  const { io } = ctx
  const parsed = parseCommandLine('status', argv)
  if (parsed.positionals.length > 1) throw new UsageError('Příkaz status bere nejvýše jedno runId.')
  const cwd = resolveCwd(ctx, parsed.values)
  const store = await resolveStore(ctx.deps)

  let runId = parsed.positionals[0]
  if (runId === undefined) {
    const runs = await store.listRuns(cwd)
    if (runs.length === 0) {
      errorLine(ctx, `Žádné běhy v ${store.runsRoot(cwd)}.`)
      return 2
    }
    runId = runs[0].runId
  }

  assertSafeRunId(runId)
  const summary = await store.readRunSummary(cwd, runId)
  if (!summary) {
    errorLine(ctx, `Běh „${runId}“ nenalezen v ${store.runsRoot(cwd)}. Seznam: ultracode list`)
    return 2
  }
  const events = await store.readEvents(cwd, runId)
  const digest = digestEvents(events)

  if (bool(parsed.values.json)) {
    io.stdout.write(`${safeJson({ summary, phases: digest.phases, currentPhase: digest.currentPhase, agents: digest.agents }, jsonIndent(io))}\n`)
    return 0
  }
  const style = styleFor(ctx, parsed.values)
  writeLines(io.stdout, renderStatus({ summary, digest, nowMs: nowMs(ctx), style }))
  return 0
}
