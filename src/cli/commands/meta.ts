/** `ultracode meta <workflow|path>`: prints the workflow's `meta` as JSON. */
import { resolveParseScript } from '../defaults.ts'
import { safeJson } from '../format.ts'
import { parseCommandLine } from '../options.ts'
import type { CommandContext } from '../types.ts'
import { UsageError } from '../types.ts'
import { jsonIndent, resolveCwd } from './shared.ts'
import { validateOne } from './validate.ts'

export async function metaCommand(ctx: CommandContext, argv: string[]): Promise<number> {
  const { io } = ctx
  const parsed = parseCommandLine('meta', argv)
  if (parsed.positionals.length !== 1) throw new UsageError('Expected exactly one argument: ultracode meta <workflow|path>')
  const cwd = resolveCwd(ctx, parsed.values)
  const parseScript = await resolveParseScript(ctx.deps)

  const report = await validateOne(ctx, parsed.positionals[0], cwd, parseScript)
  if (!report.ok || !report.meta) {
    const errors = report.diagnostics.filter((d) => d.level === 'error')
    for (const d of errors) io.stderr.write(`ultracode: ${report.path}: ${d.message}\n`)
    if (errors.length === 0) io.stderr.write(`ultracode: ${report.path}: script is invalid\n`)
    return 2
  }
  io.stdout.write(`${safeJson(report.meta, jsonIndent(io))}\n`)
  return 0
}
