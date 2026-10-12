/** `ultracode list`: runs + available workflows. */
import { resolveDiscovery, resolveStore } from '../defaults.ts'
import { formatTable, safeJson } from '../format.ts'
import { bool, parseCommandLine, parsePositiveInt, str } from '../options.ts'
import { renderRunList } from '../render.ts'
import type { CommandContext, WorkflowInfo } from '../types.ts'
import { UsageError } from '../types.ts'
import { errorMessage, nowMs, resolveCwd, styleFor, writeLines, jsonIndent } from './shared.ts'

export async function listCommand(ctx: CommandContext, argv: string[]): Promise<number> {
  const { io } = ctx
  const parsed = parseCommandLine('list', argv)
  if (parsed.positionals.length > 0) throw new UsageError('The list command takes no arguments.')
  const limit = parsePositiveInt('limit', str(parsed.values.limit)) ?? 20
  const cwd = resolveCwd(ctx, parsed.values)
  const store = await resolveStore(ctx.deps)
  const discovery = await resolveDiscovery(ctx.deps)

  const allRuns = await store.listRuns(cwd)
  const runs = allRuns.slice(0, limit)
  let workflows: WorkflowInfo[] = []
  let discoveryError: string | undefined
  try {
    workflows = discovery.listWorkflows(cwd)
  } catch (e) {
    discoveryError = errorMessage(e)
  }

  if (bool(parsed.values.json)) {
    io.stdout.write(`${safeJson({ runs, workflows }, jsonIndent(io))}\n`)
    return 0
  }

  const s = styleFor(ctx, parsed.values)
  const out: string[] = []
  out.push(s.bold(`Runs (${runs.length}${allRuns.length > runs.length ? ` z ${allRuns.length}` : ''}):`))
  if (runs.length === 0) out.push(`  ${s.dim(`none (${store.runsRoot(cwd)})`)}`)
  else out.push(...renderRunList(runs, nowMs(ctx), s))

  out.push('')
  out.push(s.bold(`Workflows (${workflows.length}):`))
  if (discoveryError) {
    out.push(`  ${s.red(`cannot discover: ${discoveryError}`)}`)
  } else if (workflows.length === 0) {
    out.push(`  ${s.dim('none (create them with: ultracode init)')}`)
  } else {
    const rows = workflows.map((w) => [
      w.name,
      s.dim(w.scope === 'project' ? 'project' : 'user'),
      w.description ?? '',
      s.dim(w.path),
    ])
    out.push(...formatTable(rows, '  '))
  }
  writeLines(io.stdout, out)
  return 0
}
