/** `ultracode validate <path...>`. */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WorkflowMeta } from '../../types.ts'
import { resolveDiscovery, resolveParseScript } from '../defaults.ts'
import { plural, safeJson } from '../format.ts'
import { bool, parseCommandLine } from '../options.ts'
import type { CommandContext, ParseScriptFn, ScriptDiagnosticLike } from '../types.ts'
import { UsageError } from '../types.ts'
import { errorMessage, looksLikePath, resolveCwd, styleFor, writeLines, jsonIndent } from './shared.ts'

interface FileReport {
  path: string
  ok: boolean
  meta: WorkflowMeta | null
  diagnostics: ScriptDiagnosticLike[]
}

export async function validateCommand(ctx: CommandContext, argv: string[]): Promise<number> {
  const { io } = ctx
  const parsed = parseCommandLine('validate', argv)
  if (parsed.positionals.length === 0) throw new UsageError('Missing script path: ultracode validate <path...>')
  const cwd = resolveCwd(ctx, parsed.values)
  const parseScript = await resolveParseScript(ctx.deps)
  const style = styleFor(ctx, parsed.values)
  const asJson = bool(parsed.values.json)

  const reports: FileReport[] = []
  for (const ref of parsed.positionals) {
    reports.push(await validateOne(ctx, ref, cwd, parseScript))
  }

  if (asJson) {
    io.stdout.write(`${safeJson(reports, jsonIndent(io))}\n`)
  } else {
    const out: string[] = []
    for (const r of reports) {
      const errors = r.diagnostics.filter((d) => d.level === 'error')
      const warnings = r.diagnostics.filter((d) => d.level === 'warning')
      if (r.ok) {
        const phases = r.meta?.phases?.length ?? 0
        const what = r.meta ? `${r.meta.name}${phases > 0 ? `, ${phases} ${plural(phases, 'phase', 'phases', 'phases')}` : ''}` : ''
        out.push(`${style.green('OK')}  ${r.path}${what ? style.dim(`  (${what})`) : ''}`)
      } else {
        out.push(`${style.red('ERROR')}  ${r.path}`)
      }
      for (const d of [...errors, ...warnings]) {
        const loc = d.line !== undefined ? `${r.path}:${d.line}` : r.path
        const tag = d.level === 'error' ? style.red('error') : style.yellow('warning')
        out.push(`  ${loc}: ${tag}: ${d.message}`)
      }
      if (!r.ok && errors.length === 0) out.push(`  ${r.path}: ${style.red('error')}: script is invalid (the parser returned no details)`)
    }
    const bad = reports.filter((r) => !r.ok).length
    out.push(
      bad === 0
        ? style.green(`All good (${reports.length} ${plural(reports.length, 'file', 'files', 'files')}).`)
        : style.red(`Invalid scripts: ${bad} of ${reports.length}.`),
    )
    // the validation result is command output → stdout
    writeLines(io.stdout, out)
  }
  return reports.every((r) => r.ok) ? 0 : 2
}

async function validateOne(
  ctx: CommandContext,
  ref: string,
  cwd: string,
  parseScript: ParseScriptFn,
): Promise<FileReport> {
  let abs = resolve(ctx.io.cwd, ref)
  // workflow name (not a path) → try discovery
  if (!existsSync(abs) && !looksLikePath(ref)) {
    try {
      const discovery = await resolveDiscovery(ctx.deps)
      abs = discovery.findWorkflow(ref, cwd)
    } catch {
      // the original path stays → the "cannot be read" message below
    }
  }
  let source: string
  try {
    if (statSync(abs).isDirectory()) throw new Error('it is a directory')
    source = readFileSync(abs, 'utf8')
  } catch (e) {
    return {
      path: ref,
      ok: false,
      meta: null,
      diagnostics: [{ level: 'error', message: `file cannot be read: ${errorMessage(e)}` }],
    }
  }
  try {
    const res = parseScript(source, abs)
    return { path: ref, ok: res.ok, meta: res.meta, diagnostics: res.diagnostics }
  } catch (e) {
    // parseScript should not throw, but the CLI must not crash because of a single file
    return {
      path: ref,
      ok: false,
      meta: null,
      diagnostics: [{ level: 'error', message: `parser failed: ${errorMessage(e)}` }],
    }
  }
}
