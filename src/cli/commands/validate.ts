/** `ultracode validate <cesta...>`. */
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
  if (parsed.positionals.length === 0) throw new UsageError('Chybí cesta ke skriptu: ultracode validate <cesta...>')
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
        const what = r.meta ? `${r.meta.name}${phases > 0 ? `, ${phases} ${plural(phases, 'fáze', 'fáze', 'fází')}` : ''}` : ''
        out.push(`${style.green('OK')}  ${r.path}${what ? style.dim(`  (${what})`) : ''}`)
      } else {
        out.push(`${style.red('CHYBA')}  ${r.path}`)
      }
      for (const d of [...errors, ...warnings]) {
        const loc = d.line !== undefined ? `${r.path}:${d.line}` : r.path
        const tag = d.level === 'error' ? style.red('chyba') : style.yellow('varování')
        out.push(`  ${loc}: ${tag}: ${d.message}`)
      }
      if (!r.ok && errors.length === 0) out.push(`  ${r.path}: ${style.red('chyba')}: skript je neplatný (parser nevrátil podrobnosti)`)
    }
    const bad = reports.filter((r) => !r.ok).length
    out.push(
      bad === 0
        ? style.green(`Vše v pořádku (${reports.length} ${plural(reports.length, 'soubor', 'soubory', 'souborů')}).`)
        : style.red(`Neplatné skripty: ${bad} z ${reports.length}.`),
    )
    // výsledek validace je výstup příkazu → stdout
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
  // jméno workflow (ne cesta) → zkus vyhledání
  if (!existsSync(abs) && !looksLikePath(ref)) {
    try {
      const discovery = await resolveDiscovery(ctx.deps)
      abs = discovery.findWorkflow(ref, cwd)
    } catch {
      // zůstane původní cesta → hláška „nelze přečíst“ níže
    }
  }
  let source: string
  try {
    if (statSync(abs).isDirectory()) throw new Error('je to adresář')
    source = readFileSync(abs, 'utf8')
  } catch (e) {
    return {
      path: ref,
      ok: false,
      meta: null,
      diagnostics: [{ level: 'error', message: `soubor nelze přečíst: ${errorMessage(e)}` }],
    }
  }
  try {
    const res = parseScript(source, abs)
    return { path: ref, ok: res.ok, meta: res.meta, diagnostics: res.diagnostics }
  } catch (e) {
    // parseScript nemá házet, ale CLI nesmí kvůli jednomu souboru spadnout
    return {
      path: ref,
      ok: false,
      meta: null,
      diagnostics: [{ level: 'error', message: `parser selhal: ${errorMessage(e)}` }],
    }
  }
}
