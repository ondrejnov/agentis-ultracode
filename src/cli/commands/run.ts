/** `ultracode run` a `ultracode resume`. */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { RunEvent, RunOptions, RunSummary } from '../../types.ts'
import { resolveRunWorkflow, resolveStore } from '../defaults.ts'
import { safeJson } from '../format.ts'
import {
  bool,
  parseCommandLine,
  parseEffort,
  parsePositiveInt,
  parsePositiveNumber,
  str,
} from '../options.ts'
import { createRenderState, renderEvent, renderSummary } from '../render.ts'
import type { CommandContext } from '../types.ts'
import { UsageError } from '../types.ts'
import {
  assertSafeRunId,
  errorCode,
  errorLine,
  errorMessage,
  looksLikePath,
  resolveCwd,
  styleFor,
  writeLines, jsonIndent } from './shared.ts'

/** Zpracuje `--args` / `--args-file`; `undefined` = args nezadány. */
function readArgs(ctx: CommandContext, values: Record<string, string | boolean | undefined>): { value: unknown; given: boolean } {
  const inline = str(values.args)
  const file = str(values['args-file'])
  if (inline !== undefined && file !== undefined) {
    throw new UsageError('Volby --args a --args-file nelze použít současně.')
  }
  if (inline !== undefined) {
    try {
      return { value: JSON.parse(inline), given: true }
    } catch (e) {
      throw new UsageError(
        `Hodnota --args není platný JSON: ${errorMessage(e)}\n  Zadáno: ${inline.length > 200 ? `${inline.slice(0, 200)}…` : inline}\n  Tip: řetězce musí být v uvozovkách, např. --args '{"cesta":"src"}'.`,
      )
    }
  }
  if (file !== undefined) {
    const abs = resolve(ctx.io.cwd, file)
    let text: string
    try {
      text = readFileSync(abs, 'utf8')
    } catch (e) {
      throw new UsageError(`Soubor --args-file „${file}“ nelze přečíst: ${errorMessage(e)}`)
    }
    try {
      return { value: JSON.parse(text), given: true }
    } catch (e) {
      throw new UsageError(`Soubor --args-file „${file}“ neobsahuje platný JSON: ${errorMessage(e)}`)
    }
  }
  return { value: undefined, given: false }
}

export async function runCommand(ctx: CommandContext, argv: string[], mode: 'run' | 'resume'): Promise<number> {
  const { io, deps } = ctx
  const parsed = parseCommandLine(mode, argv)
  const v = parsed.values
  const pos = parsed.positionals
  const style = styleFor(ctx, v)

  // ── workflow / resume ──
  let workflowRef = ''
  let resumeRunId: string | undefined = str(v.resume)
  if (mode === 'resume') {
    if (pos.length !== 1) throw new UsageError('Příkaz resume vyžaduje právě jedno runId: ultracode resume <runId>')
    if (resumeRunId !== undefined && resumeRunId !== pos[0]) {
      throw new UsageError(`runId „${pos[0]}“ a --resume „${resumeRunId}“ se liší.`)
    }
    resumeRunId = pos[0]
  } else {
    if (pos.length > 1) throw new UsageError(`Příkaz run bere jediný argument (workflow), dostal jsem ${pos.length}.`)
    if (pos.length === 1) workflowRef = pos[0]
    if (workflowRef === '' && resumeRunId === undefined) {
      throw new UsageError('Chybí workflow. Použití: ultracode run <workflow|cesta> [volby]')
    }
  }

  // ── volby ──
  const cwd = resolveCwd(ctx, v)
  const argsInfo = readArgs(ctx, v)
  const concurrency = parsePositiveInt('concurrency', str(v.concurrency))
  const maxAgents = parsePositiveInt('max-agents', str(v['max-agents']))
  const maxOutputTokens = parsePositiveInt('max-tokens', str(v['max-tokens']))
  const maxUsd = parsePositiveNumber('max-usd', str(v['max-usd']))
  const effort = parseEffort(str(v.effort))
  const model = str(v.model)
  const runId = str(v['run-id'])
  if (model !== undefined && model.trim() === '') throw new UsageError('Volba --model nesmí být prázdná.')
  if (runId !== undefined) assertSafeRunId(runId, '--run-id')
  if (resumeRunId !== undefined) assertSafeRunId(resumeRunId)

  if (workflowRef !== '' && looksLikePath(workflowRef)) {
    const abs = resolve(io.cwd, workflowRef)
    if (!existsSync(abs)) throw new UsageError(`Soubor workflow „${workflowRef}“ neexistuje (${abs}).`)
    workflowRef = abs
  }

  // ── kontrola, že obnovovaný běh existuje ──
  if (resumeRunId !== undefined) {
    const store = await resolveStore(deps)
    const prev = await store.readRunSummary(cwd, resumeRunId)
    if (!prev) {
      throw new UsageError(`Běh „${resumeRunId}“ nenalezen v ${store.runsRoot(cwd)}. Seznam: ultracode list`)
    }
    if (prev.status === 'running') {
      io.stderr.write(
        style.yellow(
          `Pozor: běh ${resumeRunId} je podle run.json stále ve stavu running (možná ještě běží jiný proces).\n`,
        ),
      )
    }
  }

  const runWorkflow = await resolveRunWorkflow(deps)

  const quiet = bool(v.quiet)
  const asJson = bool(v.json)
  const renderState = createRenderState()
  const renderOpts = { style, verbose: bool(v.verbose) }
  const onEvent = (e: RunEvent) => {
    if (quiet) return
    if (e.t === 'run_end') return // závěr vypíše souhrn
    try {
      writeLines(io.stderr, renderEvent(e, renderState, renderOpts))
    } catch {
      // výpis průběhu nesmí shodit běh
    }
  }

  const opts: RunOptions = { workflow: workflowRef, cwd, onEvent }
  if (argsInfo.given) opts.args = argsInfo.value
  if (resumeRunId !== undefined) opts.resumeRunId = resumeRunId
  if (runId !== undefined) opts.runId = runId
  if (concurrency !== undefined) opts.concurrency = concurrency
  if (maxAgents !== undefined) opts.maxAgents = maxAgents
  if (maxOutputTokens !== undefined) opts.maxOutputTokens = maxOutputTokens
  if (maxUsd !== undefined) opts.maxUsd = maxUsd
  if (model !== undefined) opts.model = model
  if (effort !== undefined) opts.effort = effort
  if (deps.signal) opts.signal = deps.signal

  let summary: RunSummary
  try {
    summary = await runWorkflow(opts)
  } catch (e) {
    return handleThrown(ctx, e)
  }

  // ── výstup ──
  if (!quiet) {
    writeLines(io.stderr, ['', ...renderSummary(summary, style)])
  } else if (summary.status !== 'completed' && summary.error) {
    errorLine(ctx, summary.error)
  }
  if (summary.budgetExceeded && quiet) {
    errorLine(ctx, 'Rozpočet byl překročen, výsledek je částečný.')
  }

  if (asJson) {
    io.stdout.write(`${safeJson(summary, jsonIndent(io))}\n`)
  } else if (summary.status === 'completed') {
    io.stdout.write(`${safeJson(summary.result === undefined ? null : summary.result, jsonIndent(io))}\n`)
  }

  switch (summary.status) {
    case 'completed':
      return 0
    case 'aborted':
      return 130
    default:
      return 1
  }
}

/** Kódy chyb enginu, které znamenají chybné použití (neexistující/zamčený běh, kolize `--run-id`, …) → exit 2. */
const USAGE_CODES = new Set(['RUN_NOT_FOUND', 'RUN_EXISTS', 'RUN_LOCKED', 'INVALID_RUN_ID', 'USAGE', 'SCRIPT_MISSING'])

/** Engine hází jen pro chybné použití; vše ostatní je neočekávaná chyba. */
function handleThrown(ctx: CommandContext, e: unknown): number {
  const code = errorCode(e)
  if (code === 'SCRIPT_INVALID') {
    errorLine(ctx, `Neplatný skript: ${errorMessage(e)}`)
    const diags = (e as { diagnostics?: unknown }).diagnostics
    if (Array.isArray(diags)) {
      for (const d of diags) ctx.io.stderr.write(`  - ${String(d)}\n`)
    }
    return 2
  }
  if (code === 'WORKFLOW_NOT_FOUND' || (code !== undefined && USAGE_CODES.has(code))) {
    errorLine(ctx, errorMessage(e))
    return 2
  }
  if (code === 'ABORTED') {
    errorLine(ctx, errorMessage(e))
    return 130
  }
  errorLine(ctx, `Běh skončil neočekávanou chybou: ${errorMessage(e)}`)
  return 1
}
