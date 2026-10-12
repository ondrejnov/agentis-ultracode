/**
 * Runner for a single agent: spawns `agentiscode --adapter claude --json` (a wrapper over `claude -p`, which
 * normalizes its output into unified JSON Lines events), monitors output, stall watchdog, retry, abort and cleanup
 * of the whole process group.
 *
 * ── agentiscode `--json` format (agentiscode-cli, wraps `claude -p --output-format stream-json --verbose`) ──
 *  - stdout = JSONL, one flat object per line with `type`: `session` {session_id, model}, `text` {text, message_id},
 *    `reasoning` {text}, `tool` {id, name, status: running → completed|error, input|output}, `step` {usage, message_id}
 *    (per-message usage, emitted once per `message_id`), `api_retry` (claude itself repeats API calls up to 10×),
 *    `stderr` {line} (claude's stderr is forwarded HERE, not to agentiscode's stderr), `error` {message, exit_code},
 *    finally exactly one `result`.
 *  - `result` {session_id, usage, cost_usd, is_error, result, subtype, structured_output, num_turns,
 *    api_error_status, terminal_reason, errors} mirrors claude's own `result` event. `usage` in it is authoritative,
 *    `step` usages are only running snapshots. When claude did not emit a result (crash, kill), agentiscode
 *    synthesizes one with `synthetic: true` (is_error:true after an `error` event) → we treat it as a missing result.
 *  - Schema (`--json-schema`): claude internally adds a `StructuredOutput` tool; we do NOT count it as a tool call.
 *    When the model does not call the tool, the result is `is_error:false` without `structured_output` → `schema`
 *    failure. An invalid schema is rejected by claude immediately: exit 1, stderr "--json-schema is not a valid JSON
 *    Schema…" (arrives as `stderr` events), synthetic result.
 *  - API errors: `result` with `is_error:true`, exit 1. `subtype` is often still `success`; `api_error_status` tells them
 *    apart (HTTP code or missing on a network error). Exceeded budget: `subtype:"error_max_budget_usd"`.
 *  - agentiscode writes `[agentiscode] command: …` and its own argument errors to its real stderr.
 *  - `cost_usd` is only in the `result` event → for killed attempts the cost is unknown (counted as 0),
 *    but tokens are still counted from the `step` snapshots.
 *  - Every parsed event is also forwarded as `onProgress({kind:'event'})`, so the engine can stream the whole
 *    agent log (for `ultracode run --json`).
 *
 * Claude-specific flags are passed through `--extra-args-json` (JSON array appended verbatim to the `claude` argv);
 * the permission mode and disallowed tools via agentiscode's `--permission-mode` / `--disallowed-tools`.
 *
 * Note on permissions: `--allowedTools` in `bypassPermissions` mode restricts NOTHING (verified). The tool whitelist
 * is only enforced in `dontAsk`; tool bans (`--disallowedTools`) work in all modes.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { EMPTY_USAGE } from '../types.ts'
import type {
  ClaudeErrorKind,
  ClaudeProgress,
  ClaudeRunRequest,
  ClaudeRunResult,
  TokenUsage,
} from '../types.ts'

// ───────────────────────── constants ─────────────────────────

export const DEFAULT_SUBAGENT_SYSTEM_PROMPT = [
  'You are a subagent in an automated workflow. Your final message is returned to a script, not to a human.',
  'Return only the requested data, without introduction, summary or apologies.',
  'Do not ask anything, nobody will answer. If something is unclear, make a reasonable assumption and continue.',
  'Stay within the assigned scope of work and do not touch files outside it.',
].join('\n')

const DEFAULT_STALL_MS = 600_000
/** Longest interval `setTimeout` can handle (a higher value would fire immediately). */
const MAX_TIMER_MS = 2_147_483_647
const DEFAULT_MAX_ATTEMPTS = 3
const MAX_ATTEMPTS_CAP = 6
const DEFAULT_BACKOFF_MS = 2000
/** After SIGTERM we wait this many ms for exit, then SIGKILL the whole group. */
const DEFAULT_KILL_GRACE_MS = 3000
/** After SIGKILL we wait this many ms for 'close', then give up and release the pipes (child outside the group). */
const FORCE_SETTLE_MS = 3000
/** After the `result` event we let the process run this many ms before killing it. */
const DEFAULT_RESULT_GRACE_MS = 5000
/** After the leader's 'exit' we wait this many ms for the pipes to drain (children outside the group may hold them). */
const DEFAULT_EXIT_DRAIN_MS = 2000
/** Stdout lines larger than this are discarded (memory protection); the raw record in stream.jsonl does not save them. */
const MAX_LINE_CHARS = 64 * 1024 * 1024
const STDERR_TAIL_CHARS = 8192
const INTERNAL_TOOLS = new Set(['StructuredOutput'])
/** agentiscode's own banner on stderr; it carries the whole argv (system prompt, schema) → kept out of error messages. */
const AGENTISCODE_BANNER = /^\[agentiscode\] command: .*$/gm

// ───────────────────────── public helper functions ─────────────────────────

/**
 * Agent executable: env `ULTRACODE_AGENT_BIN`, then the older `ULTRACODE_CLAUDE_BIN`, otherwise `agentiscode` from PATH.
 */
export function resolveClaudeBin(): string {
  for (const name of ['ULTRACODE_AGENT_BIN', 'ULTRACODE_CLAUDE_BIN']) {
    const fromEnv = process.env[name]
    if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  }
  return 'agentiscode'
}

/** agentiscode `--adapter`: env `ULTRACODE_AGENT_ADAPTER`, otherwise `claude` (schemas etc. are claude-specific). */
export function resolveAgentAdapter(): string {
  const fromEnv = process.env['ULTRACODE_AGENT_ADAPTER']
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : 'claude'
}

/**
 * Builds the argv for `agentiscode` (without the prompt – that goes to stdin). Pure function apart from the adapter env.
 * Tools are passed as ONE comma-separated argument (variadic options could otherwise swallow further arguments;
 * specs with a space such as `Bash(git diff:*)` are verified to work this way).
 */
export function buildClaudeArgs(req: ClaudeRunRequest): string[] {
  // We always disable Workflow (except via env CLAUDE_CODE_DISABLE_WORKFLOWS), so child agents do not start recursively.
  // agentiscode adds AskUserQuestion itself and merges both into a single `--disallowedTools`.
  const disallowed = uniqueNonEmpty(['Workflow', ...(req.disallowedTools ?? [])])
  const args: string[] = [
    '--adapter',
    resolveAgentAdapter(),
    '--json',
    '--permission-mode',
    req.permissionMode ?? 'bypassPermissions',
    '--disallowed-tools',
    disallowed.join(','),
  ]
  if (req.model) args.push('--model', req.model)
  if (req.effort) args.push('--effort', req.effort)

  // flags agentiscode has no own option for go verbatim to `claude`
  const claudeArgs: string[] = ['--no-session-persistence']
  const allowed = uniqueNonEmpty(req.allowedTools ?? [])
  if (allowed.length > 0) claudeArgs.push('--allowedTools', allowed.join(','))
  if (req.schema) claudeArgs.push('--json-schema', JSON.stringify(req.schema))
  const system = req.appendSystemPrompt?.trim()
    ? `${DEFAULT_SUBAGENT_SYSTEM_PROMPT}\n\n${req.appendSystemPrompt.trim()}`
    : DEFAULT_SUBAGENT_SYSTEM_PROMPT
  claudeArgs.push('--append-system-prompt', system)
  if (typeof req.maxBudgetUsd === 'number' && Number.isFinite(req.maxBudgetUsd) && req.maxBudgetUsd > 0) {
    claudeArgs.push('--max-budget-usd', String(req.maxBudgetUsd))
  }
  if (req.extraArgs && req.extraArgs.length > 0) claudeArgs.push(...req.extraArgs)
  args.push('--extra-args-json', JSON.stringify(claudeArgs))
  return args
}

function uniqueNonEmpty(items: string[]): string[] {
  const out: string[] = []
  for (const raw of items) {
    const s = typeof raw === 'string' ? raw.trim() : ''
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

// ───────────────────────── internal types ─────────────────────────

type Json = Record<string, any>

type KillReason = 'stall' | 'timeout' | 'aborted' | 'done'

interface Outcome {
  ok: boolean
  text: string | null
  structured: unknown
  sessionId?: string
  usage: TokenUsage
  costUsd: number
  numTurns: number
  toolCalls: number
  error?: { kind: ClaudeErrorKind; message: string }
  /** May the attempt be retried? */
  retryable: boolean
}

interface Tunables {
  stallMs: number
  timeoutMs: number | undefined
  killGraceMs: number
  resultGraceMs: number
  exitDrainMs: number
  backoffMs: number
}

// ───────────────────────── registry of running agents ─────────────────────────

/**
 * Process groups of running agents. Children are `detached` (own group), so a SIGINT from the terminal
 * does not reach them and the parent's death does not end them → on process exit (including `process.exit`) they are killed in the 'exit' hook
 * killed synchronously. (SIGINT/SIGTERM must be caught by the caller – the CLI – and abort via AbortSignal.)
 */
const activeGroups = new Set<number>()
let exitHookInstalled = false

function trackGroup(pid: number): void {
  activeGroups.add(pid)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const p of activeGroups) killGroup(p, 'SIGKILL')
    activeGroups.clear()
  })
}

// ───────────────────────── runClaude ─────────────────────────

export async function runClaude(req: ClaudeRunRequest): Promise<ClaudeRunResult> {
  const startedAt = Date.now()
  const total = {
    usage: { ...EMPTY_USAGE } as TokenUsage,
    costUsd: 0,
    numTurns: 0,
    toolCalls: 0,
  }
  const emit = (e: ClaudeProgress): void => {
    if (!req.onProgress) return
    try {
      req.onProgress(e)
    } catch {
      // an error in the listener must not crash the runner
    }
  }
  const finish = (
    ok: boolean,
    attempts: number,
    last: Partial<Outcome>,
    error?: { kind: ClaudeErrorKind; message: string },
  ): ClaudeRunResult => {
    const result: ClaudeRunResult = {
      ok,
      text: ok ? (last.text ?? null) : null,
      structured: ok ? (last.structured ?? null) : null,
      ...(last.sessionId ? { sessionId: last.sessionId } : {}),
      usage: total.usage,
      costUsd: total.costUsd,
      numTurns: total.numTurns,
      toolCalls: total.toolCalls,
      durationMs: Date.now() - startedAt,
      attempts,
      ...(error ? { error } : {}),
    }
    writeArtifact(join(req.outDir, 'result.json'), JSON.stringify(result, null, 2) + '\n')
    return result
  }

  // artifacts
  try {
    mkdirSync(req.outDir, { recursive: true })
    writeFileSync(join(req.outDir, 'prompt.txt'), req.prompt)
  } catch (err) {
    return {
      ok: false,
      text: null,
      structured: null,
      usage: total.usage,
      costUsd: 0,
      numTurns: 0,
      toolCalls: 0,
      durationMs: Date.now() - startedAt,
      attempts: 0,
      error: { kind: 'spawn', message: `Cannot create agent directory ${req.outDir}: ${errMsg(err)}` },
    }
  }

  if (typeof req.prompt !== 'string' || req.prompt.trim() === '') {
    return finish(false, 0, {}, { kind: 'spawn', message: 'Agent prompt is empty.' })
  }
  if (!isDirectory(req.cwd)) {
    return finish(false, 0, {}, { kind: 'spawn', message: `Agent working directory does not exist: ${req.cwd}` })
  }

  const maxAttempts = clampInt(req.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS_CAP)
  const tun: Tunables = {
    // NaN / negative / zero values must not silently disable the watchdog → they fall back to the default; overly large values are clamped to the setTimeout limit.
    stallMs: req.stallMs === undefined || !(req.stallMs > 0) ? DEFAULT_STALL_MS : Math.min(req.stallMs, MAX_TIMER_MS),
    timeoutMs: req.timeoutMs && req.timeoutMs > 0 ? Math.min(req.timeoutMs, MAX_TIMER_MS) : undefined,
    killGraceMs: envInt('ULTRACODE_KILL_GRACE_MS', DEFAULT_KILL_GRACE_MS),
    resultGraceMs: envInt('ULTRACODE_RESULT_GRACE_MS', DEFAULT_RESULT_GRACE_MS),
    exitDrainMs: envInt('ULTRACODE_EXIT_DRAIN_MS', DEFAULT_EXIT_DRAIN_MS),
    backoffMs: envInt('ULTRACODE_RETRY_BACKOFF_MS', DEFAULT_BACKOFF_MS),
  }
  const bin = req.bin && req.bin.trim() ? req.bin.trim() : resolveClaudeBin()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(req.env ?? {}),
    // Subagents must not start other workflows (the user's global setting would otherwise recurse).
    CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
  }

  let schemaRetries = 0
  let attempt = 0
  let last: Outcome | null = null

  while (attempt < maxAttempts) {
    if (req.signal?.aborted) {
      return finish(false, attempt, last ?? {}, { kind: 'aborted', message: 'Agent run was aborted.' })
    }
    attempt++
    rotateAttemptFiles(req.outDir, attempt)

    // The budget is cumulative across all attempts: each further attempt gets only what is left.
    // Without this, `--max-budget-usd` would let the agent spend up to maxAttempts times the limit.
    const budgetLeft = req.maxBudgetUsd === undefined ? undefined : req.maxBudgetUsd - total.costUsd
    if (budgetLeft !== undefined && !(budgetLeft > 0)) {
      return finish(false, attempt - 1, last ?? {}, { kind: 'api', message: `Agent budget exhausted (--max-budget-usd ${req.maxBudgetUsd}).` })
    }
    const args = buildClaudeArgs({ ...req, maxBudgetUsd: budgetLeft })

    const baseUsage = total.usage
    const outcome = await runAttempt({
      req,
      bin,
      args,
      env,
      attempt,
      tun,
      baseUsage,
      emit,
    })
    last = outcome
    total.usage = addUsage(total.usage, outcome.usage)
    total.costUsd += outcome.costUsd
    total.numTurns += outcome.numTurns
    total.toolCalls += outcome.toolCalls
    emit({ kind: 'usage', usage: total.usage })

    if (outcome.ok) return finish(true, attempt, outcome)

    const err = outcome.error ?? { kind: 'exit' as const, message: 'Unknown agent error.' }
    if (err.kind === 'aborted' || req.signal?.aborted) {
      return finish(false, attempt, outcome, { kind: 'aborted', message: 'Agent run was aborted.' })
    }
    let retryable = outcome.retryable
    if (err.kind === 'schema' && retryable) {
      // Schema: claude already enforces StructuredOutput internally (several rounds). If the output is still missing after that,
      // it is mostly deterministic (contradictory/unsatisfiable schema), hence at most 1 more attempt.
      if (schemaRetries >= 1) retryable = false
      else schemaRetries++
    }
    if (!retryable || attempt >= maxAttempts) {
      return finish(false, attempt, outcome, err)
    }

    emit({ kind: 'retry', attempt: attempt + 1, reason: `${err.kind}: ${err.message}` })
    const aborted = await sleepAbortable(tun.backoffMs * attempt, req.signal)
    if (aborted) return finish(false, attempt, outcome, { kind: 'aborted', message: 'Agent run was aborted.' })
  }

  // we only get here when maxAttempts < 1, which clampInt rules out
  return finish(false, attempt, last ?? {}, { kind: 'exit', message: 'Agent was not started.' })
}

// ───────────────────────── single attempt ─────────────────────────

interface AttemptContext {
  req: ClaudeRunRequest
  bin: string
  args: string[]
  env: NodeJS.ProcessEnv
  attempt: number
  tun: Tunables
  baseUsage: TokenUsage
  emit: (e: ClaudeProgress) => void
}

function runAttempt(ctx: AttemptContext): Promise<Outcome> {
  const { req, tun } = ctx
  const streamFile = join(req.outDir, 'stream.jsonl')
  const stderrFile = join(req.outDir, 'stderr.txt')

  return new Promise<Outcome>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(ctx.bin, ctx.args, {
        cwd: req.cwd,
        env: ctx.env,
        detached: true, // leader gets its own group → process.kill(-pid) also kills children
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve(failOutcome('spawn', `Cannot start "${ctx.bin}": ${errMsg(err)}`, false))
      return
    }
    const pid = child.pid
    if (pid !== undefined) trackGroup(pid)

    // ── attempt state ──
    let settled = false
    let spawnError: Error | null = null
    let killReason: KillReason | null = null
    let lastActivity = Date.now()
    let exited = false
    let exitCode: number | null = null
    let exitSignal: NodeJS.Signals | null = null
    let resultEvent: Json | null = null
    let sessionId: string | undefined
    let stderrTail = ''
    let outBuf = ''
    let lineOverflow = false
    const toolIds = new Set<string>()
    const messageUsage = new Map<string, TokenUsage>()
    let toolCalls = 0
    let lastUsageSig = -1

    let stallTimer: NodeJS.Timeout | undefined
    let timeoutTimer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined
    let forceTimer: NodeJS.Timeout | undefined
    let resultTimer: NodeJS.Timeout | undefined
    let drainTimer: NodeJS.Timeout | undefined

    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')

    const runningUsage = (): TokenUsage => {
      let u: TokenUsage = { ...EMPTY_USAGE }
      for (const m of messageUsage.values()) u = addUsage(u, m)
      return u
    }

    // ── stream events ──
    const appendStderr = (text: string): void => {
      writeArtifactAppend(stderrFile, text)
      const clean = text.replace(AGENTISCODE_BANNER, '')
      if (clean.trim()) stderrTail = (stderrTail + clean).slice(-STDERR_TAIL_CHARS)
    }

    const handleEvent = (o: Json): void => {
      if (typeof o.session_id === 'string' && o.session_id) sessionId = o.session_id
      switch (o.type) {
        case 'step': {
          if (!o.usage) return
          const key = typeof o.message_id === 'string' ? o.message_id : `step:${messageUsage.size}`
          const prev = messageUsage.get(key)
          const cur = toUsage(o.usage)
          messageUsage.set(key, prev ? maxUsage(prev, cur) : cur)
          const run = runningUsage()
          if (run.outputTokens + run.inputTokens !== lastUsageSig) {
            lastUsageSig = run.outputTokens + run.inputTokens
            ctx.emit({ kind: 'usage', usage: addUsage(ctx.baseUsage, run) })
          }
          return
        }
        case 'tool': {
          if (o.status !== 'running' || typeof o.name !== 'string') return
          const id = typeof o.id === 'string' && o.id ? o.id : `tool:${toolIds.size}`
          if (toolIds.has(id)) return
          toolIds.add(id)
          if (INTERNAL_TOOLS.has(o.name)) return
          toolCalls++
          ctx.emit({ kind: 'tool', name: o.name })
          return
        }
        case 'text': {
          if (typeof o.text === 'string' && o.text) ctx.emit({ kind: 'text', chars: o.text.length })
          return
        }
        case 'stderr': {
          if (typeof o.line === 'string') appendStderr(o.line + '\n')
          return
        }
        case 'error': {
          // claude exited without a result; the reason is mostly already in the forwarded stderr lines
          if (typeof o.message === 'string' && !stderrTail.includes(o.message)) appendStderr(o.message + '\n')
          return
        }
        case 'result': {
          if (resultEvent) return // we take the first result
          if (o.synthetic === true) return // computed by agentiscode: claude itself produced no result
          resultEvent = o
          clearTimeout(stallTimer)
          clearTimeout(timeoutTimer)
          if (o.usage) ctx.emit({ kind: 'usage', usage: addUsage(ctx.baseUsage, toUsage(o.usage)) })
          // the process should exit on its own; if it hangs, we kill it after the grace period
          if (!exited && Number.isFinite(tun.resultGraceMs)) {
            resultTimer = setTimeout(() => terminate('done'), tun.resultGraceMs)
          }
          return
        }
        default:
          return
      }
    }

    const handleLine = (rawLine: string): void => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line.trim() === '') return
      writeArtifactAppend(streamFile, line + '\n')
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        return // invalid/incomplete JSON line is ignored (but it is in stream.jsonl)
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        try {
          handleEvent(parsed as Json)
        } catch {
          // an error while processing one event must not crash the attempt
        }
        ctx.emit({ kind: 'event', attempt: ctx.attempt, event: parsed as Record<string, unknown> })
      }
    }

    const flushStdout = (): void => {
      outBuf += outDecoder.end()
      if (outBuf.length > 0 && !lineOverflow) handleLine(outBuf) // last line without \n
      outBuf = ''
    }

    // ── termination ──
    const clearAll = (): void => {
      clearTimeout(stallTimer)
      clearTimeout(timeoutTimer)
      clearTimeout(killTimer)
      clearTimeout(forceTimer)
      clearTimeout(resultTimer)
      clearTimeout(drainTimer)
    }

    const settle = (): void => {
      if (settled) return
      settled = true
      clearAll()
      req.signal?.removeEventListener('abort', onAbort)
      // final cleanup: nothing from our group may survive
      if (pid !== undefined) {
        killGroup(pid, 'SIGKILL')
        activeGroups.delete(pid)
      }
      try {
        flushStdout()
      } catch {
        // ignore
      }
      try {
        child.stdout?.destroy()
        child.stderr?.destroy()
        child.stdin?.destroy()
        child.unref()
      } catch {
        // ignore
      }
      resolve(buildOutcome())
    }

    const terminate = (reason: KillReason): void => {
      if (killReason !== null || settled) return
      killReason = reason
      clearTimeout(stallTimer)
      clearTimeout(timeoutTimer)
      clearTimeout(resultTimer)
      if (pid === undefined || exited) return
      killGroup(pid, 'SIGTERM')
      killTimer = setTimeout(() => {
        killGroup(pid, 'SIGKILL')
        forceTimer = setTimeout(settle, FORCE_SETTLE_MS)
      }, tun.killGraceMs)
    }

    const onAbort = (): void => terminate('aborted')

    // ── attempt result ──
    const buildOutcome = (): Outcome => {
      const stderrText = stderrTail.trim()
      const tail = stderrText ? ` | stderr: ${truncate(stderrText, 500)}` : ''
      const running = runningUsage()
      const res = resultEvent as Json | null
      // An error result event often carries zero usage – but the tokens were already spent, so take the running snapshot.
      const resUsage = res?.usage ? toUsage(res.usage) : null
      const usage = resUsage && resUsage.inputTokens + resUsage.outputTokens + resUsage.cacheReadTokens + resUsage.cacheCreationTokens > 0 ? resUsage : running
      const costUsd = res && typeof res.cost_usd === 'number' ? res.cost_usd : 0
      const numTurns = res && typeof res.num_turns === 'number' ? res.num_turns : messageUsage.size
      const base = { usage, costUsd, numTurns, toolCalls, ...(sessionId ? { sessionId } : {}) }
      const fail = (kind: ClaudeErrorKind, message: string, retryable: boolean): Outcome => ({
        ok: false,
        text: null,
        structured: null,
        ...base,
        error: { kind, message },
        retryable,
      })

      if (spawnError) {
        const code = (spawnError as NodeJS.ErrnoException).code
        const hint = code === 'ENOENT' ? ' (file does not exist or is not in PATH)' : code === 'EACCES' ? ' (missing execute permission)' : ''
        return fail('spawn', `Cannot start "${ctx.bin}"${hint}: ${spawnError.message}`, false)
      }

      const cleanSuccess =
        res !== null &&
        res.is_error !== true &&
        (!req.schema || (res.structured_output !== undefined && res.structured_output !== null))

      if (res && cleanSuccess) {
        return {
          ok: true,
          text: typeof res.result === 'string' ? res.result : null,
          structured: req.schema ? res.structured_output : null,
          ...base,
          retryable: false,
        }
      }

      // a kill from our side takes precedence over an unclean result
      if (killReason === 'aborted') return fail('aborted', 'Agent run was aborted.', false)
      if (killReason === 'timeout') {
        return fail('timeout', `Agent exceeded the hard limit of ${tun.timeoutMs} ms and was terminated.${tail}`, false)
      }
      if (killReason === 'stall') {
        return fail(
          'stall',
          `Agent produced no output for ${tun.stallMs} ms (stalled) and was terminated.${tail}`,
          true,
        )
      }

      if (res) {
        if (res.is_error !== true) {
          // successful result, but structured_output is missing
          return fail(
            'schema',
            'Agent did not return structured output matching the schema (structured_output missing).',
            true,
          )
        }
        const text = describeResultError(res)
        const subtype = typeof res.subtype === 'string' ? res.subtype : ''
        if (subtype === 'error_max_structured_output_retries') {
          return fail('schema', `Agent could not return output valid against the schema: ${text}`, true)
        }
        if (subtype === 'error_max_budget_usd') {
          return fail('api', `Agent exceeded its budget (--max-budget-usd): ${text}`, false)
        }
        if (subtype === 'error_max_turns') {
          return fail('api', `Agent exhausted the maximum number of turns: ${text}`, false)
        }
        const status = typeof res.api_error_status === 'number' ? res.api_error_status : null
        const transient = isTransientApiError(status, text)
        return fail('api', `API error${status ? ` (HTTP ${status})` : ''}: ${truncate(text, 600)}`, transient)
      }

      // no result event
      const how = exitSignal ? `by signal ${exitSignal}` : `with code ${exitCode}`
      if (/is not a valid JSON Schema/i.test(stderrText)) {
        return fail('schema', `claude rejected the schema: ${truncate(stderrText, 600)}`, false)
      }
      if (/unknown option|is invalid\. Allowed choices|Input must be provided|required option .* not specified/i.test(stderrText)) {
        return fail('exit', `claude rejected the arguments (${how}): ${truncate(stderrText, 600)}`, false)
      }
      if (/agentiscode: error:|unrecognized arguments|invalid choice/i.test(stderrText)) {
        return fail('exit', `agentiscode rejected the arguments (${how}): ${truncate(stderrText, 600)}`, false)
      }
      if (exitCode === 0 && !exitSignal) {
        return fail('exit', `Agent ended without a result (missing result event).${tail}`, true)
      }
      return fail('exit', `Agent ended ${how} without a result.${tail}`, true)
    }

    // ── process handling ──
    child.on('error', (err) => {
      // 'error' after a successful spawn (pid exists) is not handled – the process keeps running and ends via 'exit'/'close'.
      if (pid !== undefined) return
      spawnError = err
      exited = true // no 'exit' comes after a spawn error
      settle()
    })

    child.on('exit', (code, signal) => {
      exited = true
      exitCode = code
      exitSignal = signal
      clearTimeout(killTimer)
      clearTimeout(resultTimer)
      clearTimeout(stallTimer)
      clearTimeout(timeoutTimer)
      // the rest of the group (children left behind by claude/tools) ends with it
      if (pid !== undefined) killGroup(pid, 'SIGKILL')
      // a child outside our group may hold the pipes → after a short time we stop waiting
      drainTimer = setTimeout(settle, tun.exitDrainMs)
    })

    child.on('close', () => {
      exited = true
      settle()
    })

    child.stdout?.on('data', (chunk: Buffer) => {
      lastActivity = Date.now()
      if (settled) return
      outBuf += outDecoder.write(chunk)
      let idx = outBuf.indexOf('\n')
      while (idx >= 0) {
        const line = outBuf.slice(0, idx)
        outBuf = outBuf.slice(idx + 1)
        if (lineOverflow) lineOverflow = false // end of the overflowing line
        else handleLine(line)
        idx = outBuf.indexOf('\n')
      }
      if (outBuf.length > MAX_LINE_CHARS) {
        outBuf = ''
        lineOverflow = true
      }
    })
    child.stdout?.on('error', () => {})

    child.stderr?.on('data', (chunk: Buffer) => {
      lastActivity = Date.now()
      if (settled) return
      const text = errDecoder.write(chunk)
      if (text) appendStderr(text)
    })
    child.stderr?.on('error', () => {})

    child.stdin?.on('error', () => {}) // EPIPE when the process exits before reading the prompt
    try {
      child.stdin?.end(req.prompt)
    } catch {
      // ignore
    }

    // ── watchdogs ──
    if (Number.isFinite(tun.stallMs)) {
      const check = (): void => {
        if (settled || killReason !== null || resultEvent) return
        const idle = Date.now() - lastActivity
        if (idle >= tun.stallMs) terminate('stall')
        else stallTimer = setTimeout(check, tun.stallMs - idle)
      }
      stallTimer = setTimeout(check, tun.stallMs)
    }
    if (tun.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => terminate('timeout'), tun.timeoutMs)
    }
    if (req.signal) {
      if (req.signal.aborted) onAbort()
      else req.signal.addEventListener('abort', onAbort, { once: true })
    }

    ctx.emit({ kind: 'start', attempt: ctx.attempt, ...(pid !== undefined ? { pid } : {}) })
  })
}

// ───────────────────────── error classification ─────────────────────────

/** Error text from a `result` event (is_error:true). */
function describeResultError(res: Json): string {
  if (typeof res.result === 'string' && res.result.trim()) return res.result.trim()
  if (Array.isArray(res.errors) && res.errors.length > 0) return res.errors.map(String).join('; ')
  if (typeof res.subtype === 'string') return res.subtype
  return 'unknown error'
}

/**
 * Is the API error transient (is it worth retrying)?
 * Permanent: 400/401/403/404 (bad key, nonexistent model…), exhausted limit/credit.
 * Transient: 408/409/425/429/5xx (including 529 overloaded), or without an HTTP code, network errors/timeouts.
 */
export function isTransientApiError(status: number | null, text: string): boolean {
  if (
    /usage limit|hit your limit|credit balance|invalid api key|not logged in|please run \/login|authentication|unrecognized_model|may not exist|issue with the selected model|prompt is too long|context.{0,10}(window|length)/i.test(
      text,
    )
  ) {
    return false
  }
  if (status !== null) return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
  return /overloaded|rate.?limit|too many requests|timed? ?out|timeout|ECONN(RESET|REFUSED|ABORTED)|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|connection (error|refused|reset|closed)|network|temporar|try again|server error|internal error|bad gateway|service unavailable|\b5\d\d\b/i.test(
    text,
  )
}

function failOutcome(kind: ClaudeErrorKind, message: string, retryable: boolean): Outcome {
  return {
    ok: false,
    text: null,
    structured: null,
    usage: { ...EMPTY_USAGE },
    costUsd: 0,
    numTurns: 0,
    toolCalls: 0,
    error: { kind, message },
    retryable,
  }
}

// ───────────────────────── helpers ─────────────────────────

/** Kills the whole process group (leader = pid). Returns whether the signal was delivered. */
function killGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false
    try {
      process.kill(pid, signal)
      return true
    } catch {
      return false
    }
  }
}

function toUsage(u: unknown): TokenUsage {
  const o = (u ?? {}) as Json
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    inputTokens: n(o['input_tokens']),
    outputTokens: n(o['output_tokens']),
    cacheReadTokens: n(o['cache_read_input_tokens']),
    cacheCreationTokens: n(o['cache_creation_input_tokens']),
  }
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  }
}

function maxUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
    cacheCreationTokens: Math.max(a.cacheCreationTokens, b.cacheCreationTokens),
  }
}

function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def
  return Math.min(max, Math.max(min, Math.floor(v)))
}

function envInt(name: string, def: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return def
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : def
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function writeArtifact(file: string, data: string): void {
  try {
    writeFileSync(file, data)
  } catch {
    // artifacts are auxiliary; a write failure does not crash the agent
  }
}

function writeArtifactAppend(file: string, data: string): void {
  try {
    appendFileSync(file, data)
  } catch {
    // see above
  }
}

/**
 * Before attempt N>1 moves the record of the previous attempt aside (stream.attempt-<N-1>.jsonl, stderr.attempt-<N-1>.txt)
 * and creates empty stream.jsonl/stderr.txt so these two files always match the LAST attempt.
 */
function rotateAttemptFiles(outDir: string, attempt: number): void {
  const stream = join(outDir, 'stream.jsonl')
  const stderr = join(outDir, 'stderr.txt')
  if (attempt > 1) {
    try {
      renameSync(stream, join(outDir, `stream.attempt-${attempt - 1}.jsonl`))
    } catch {
      // may not exist
    }
    try {
      renameSync(stderr, join(outDir, `stderr.attempt-${attempt - 1}.txt`))
    } catch {
      // may not exist
    }
  }
  writeArtifact(stream, '')
  writeArtifact(stderr, '')
}

/** Sleep interruptible by a signal. Returns true if interrupted by an abort. */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true)
  if (ms <= 0) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(t)
      resolve(true)
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(false)
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
