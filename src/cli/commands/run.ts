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

/** Handles `--args` / `--args-file`; `undefined` = args not given. */
function readArgs(ctx: CommandContext, values: Record<string, string | boolean | undefined>): { value: unknown; given: boolean } {
  const inline = str(values.args)
  const file = str(values['args-file'])
  if (inline !== undefined && file !== undefined) {
    throw new UsageError('The --args and --args-file options cannot be used together.')
  }
  if (inline !== undefined) {
    try {
      return { value: JSON.parse(inline), given: true }
    } catch (e) {
      throw new UsageError(
        `Value of --args is not valid JSON: ${errorMessage(e)}\n  Given: ${inline.length > 200 ? `${inline.slice(0, 200)}…` : inline}\n  Tip: strings must be in quotes, e.g. --args '{"path":"src"}'.`,
      )
    }
  }
  if (file !== undefined) {
    const abs = resolve(ctx.io.cwd, file)
    let text: string
    try {
      text = readFileSync(abs, 'utf8')
    } catch (e) {
      throw new UsageError(`File --args-file "${file}" cannot be read: ${errorMessage(e)}`)
    }
    try {
      return { value: JSON.parse(text), given: true }
    } catch (e) {
      throw new UsageError(`File --args-file "${file}" does not contain valid JSON: ${errorMessage(e)}`)
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
    if (pos.length !== 1) throw new UsageError('The resume command requires exactly one runId: ultracode resume <runId>')
    if (resumeRunId !== undefined && resumeRunId !== pos[0]) {
      throw new UsageError(`runId "${pos[0]}" and --resume "${resumeRunId}" differ.`)
    }
    resumeRunId = pos[0]
  } else {
    if (pos.length > 1) throw new UsageError(`The run command takes a single argument (workflow), got ${pos.length}.`)
    if (pos.length === 1) workflowRef = pos[0]
    if (workflowRef === '' && resumeRunId === undefined) {
      throw new UsageError('Missing workflow. Usage: ultracode run <workflow|path> [options]')
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
  if (model !== undefined && model.trim() === '') throw new UsageError('The --model option must not be empty.')
  if (runId !== undefined) assertSafeRunId(runId, '--run-id')
  if (resumeRunId !== undefined) assertSafeRunId(resumeRunId)

  if (workflowRef !== '' && looksLikePath(workflowRef)) {
    const abs = resolve(io.cwd, workflowRef)
    if (!existsSync(abs)) throw new UsageError(`Workflow file "${workflowRef}" does not exist (${abs}).`)
    workflowRef = abs
  }

  // ── check that the run being resumed exists ──
  if (resumeRunId !== undefined) {
    const store = await resolveStore(deps)
    const prev = await store.readRunSummary(cwd, resumeRunId)
    if (!prev) {
      throw new UsageError(`Run "${resumeRunId}" not found in ${store.runsRoot(cwd)}. List: ultracode list`)
    }
    if (prev.status === 'running') {
      io.stderr.write(
        style.yellow(
          `Warning: run ${resumeRunId} is still in state running according to run.json (another process may still be running).\n`,
        ),
      )
    }
  }

  const runWorkflow = await resolveRunWorkflow(deps)

  const quiet = bool(v.quiet)
  const asJson = bool(v.json)
  const renderState = createRenderState()
  const renderOpts = { style, verbose: bool(v.verbose) }
  // --json: stdout is a live JSON Lines stream — every run event including each agent's own log (`agent_event`),
  // closed by one `{"t":"summary",…}` line with the whole RunSummary.
  const writeJsonLine = (value: unknown) => {
    try {
      io.stdout.write(`${safeJson(value)}\n`)
    } catch {
      // a closed stdout must not crash the run
    }
  }
  const onEvent = (e: RunEvent) => {
    if (asJson) writeJsonLine(e)
    if (quiet) return
    if (e.t === 'run_end' || e.t === 'agent_event') return // the summary prints the conclusion; agent logs are JSON-only
    try {
      writeLines(io.stderr, renderEvent(e, renderState, renderOpts))
    } catch {
      // printing progress must not crash the run
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

  // ── output ──
  if (!quiet) {
    writeLines(io.stderr, ['', ...renderSummary(summary, style)])
  } else if (summary.status !== 'completed' && summary.error) {
    errorLine(ctx, summary.error)
  }
  if (summary.budgetExceeded && quiet) {
    errorLine(ctx, 'Budget was exceeded, the result is partial.')
  }

  if (asJson) {
    writeJsonLine({ t: 'summary', ts: new Date().toISOString(), summary })
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

/** Engine error codes that mean incorrect usage (non-existent/locked run, `--run-id` collision, …) → exit 2. */
const USAGE_CODES = new Set(['RUN_NOT_FOUND', 'RUN_EXISTS', 'RUN_LOCKED', 'INVALID_RUN_ID', 'USAGE', 'SCRIPT_MISSING'])

/** The engine throws only for incorrect usage; everything else is an unexpected error. */
function handleThrown(ctx: CommandContext, e: unknown): number {
  const code = errorCode(e)
  if (code === 'SCRIPT_INVALID') {
    errorLine(ctx, `Invalid script: ${errorMessage(e)}`)
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
  errorLine(ctx, `Run ended with an unexpected error: ${errorMessage(e)}`)
  return 1
}
