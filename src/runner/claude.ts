/**
 * Runner jednoho agenta: spuštění `claude -p` (stream-json), sledování výstupu, stall watchdog,
 * retry, abort a úklid celé skupiny procesů.
 *
 * ── Empiricky zjištěný formát `claude -p --output-format stream-json --verbose` (claude 2.1.x) ──
 *  - stdout = JSONL. Typy řádků: `system` (subtype `init`, `hook_started`, `hook_response`,
 *    `thinking_tokens`, `api_retry`), `assistant`, `user`, `rate_limit_event`, nakonec `result`.
 *  - `assistant` event nese právě JEDEN content blok (thinking | text | tool_use) a stejné `message.id`
 *    se opakuje napříč bloky jedné zprávy → tool_use deduplikujeme podle `content[].id`.
 *    `message.usage.output_tokens` je jen průběžný snímek (podhodnocený); autoritativní je `result.usage`.
 *    Vstupní/cache pole průběžných snímků sedí přesně se součtem ve `result.usage`.
 *  - Schema (`--json-schema`): claude interně přidá nástroj `StructuredOutput`; jeho `tool_use` NEPOČÍTÁME
 *    jako tool call. Výsledek je v `result.structured_output` (a `result` je jeho JSON text). Když model
 *    nástroj nezavolá (např. protimluvné schema), `result` event je `is_error:false` a `structured_output`
 *    chybí → to je naše selhání `schema`. Neplatné schema odmítne CLI hned: exit 1, stderr
 *    „--json-schema is not a valid JSON Schema…“, žádný stdout JSON.
 *  - Chyby API: `result` s `is_error:true`, exit 1. `subtype` bývá i tak `success`; rozlišuje `api_error_status`
 *    (HTTP kód nebo null při síťové chybě) a `terminal_reason: "api_error"`; text chyby je v `result`.
 *    Překročený rozpočet: `subtype:"error_max_budget_usd"`, `errors:[…]`, `terminal_reason:"budget_exhausted"`.
 *  - claude samo opakuje API volání (až 10×, `system/api_retry`) – ty počítáme jako aktivitu (neresetuje se
 *    kvůli nim stall) a náš retry je až druhá vrstva.
 *  - Chybné argumenty: exit 1, zpráva na stderr, žádný stdout JSON (kromě hooků).
 *  - `total_cost_usd` je jen v `result` eventu → u zabitých pokusů je cena neznámá (počítá se 0),
 *    tokeny se ale započítají z průběžných snímků.
 *
 * Pozn. k oprávněním: `--allowedTools` v režimu `bypassPermissions` NIC neomezuje (ověřeno). Whitelist nástrojů
 * se vynutí až v `dontAsk`; zákaz nástrojů (`--disallowedTools`) funguje ve všech režimech.
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

// ───────────────────────── konstanty ─────────────────────────

export const DEFAULT_SUBAGENT_SYSTEM_PROMPT = [
  'Jsi subagent v automatizovaném workflow. Tvoje finální zpráva se vrací skriptu, ne člověku.',
  'Vrať pouze požadovaná data, bez úvodu, shrnutí a omluv.',
  'Neptej se na nic, nikdo ti neodpoví. Pokud něco není jasné, udělej rozumný předpoklad a pokračuj.',
  'Drž se zadaného rozsahu práce a nesahej na soubory mimo něj.',
].join('\n')

const DEFAULT_STALL_MS = 600_000
/** Nejdelší interval, který `setTimeout` snese (vyšší hodnota by se vykonala okamžitě). */
const MAX_TIMER_MS = 2_147_483_647
const DEFAULT_MAX_ATTEMPTS = 3
const MAX_ATTEMPTS_CAP = 6
const DEFAULT_BACKOFF_MS = 2000
/** Po SIGTERM tolik ms počkáme na ukončení, pak SIGKILL celé skupiny. */
const DEFAULT_KILL_GRACE_MS = 3000
/** Po SIGKILL tolik ms počkáme na 'close', pak to vzdáme a uvolníme roury (potomek mimo skupinu). */
const FORCE_SETTLE_MS = 3000
/** Po `result` eventu tolik ms necháme proces doběhnout, než ho zabijeme. */
const DEFAULT_RESULT_GRACE_MS = 5000
/** Po 'exit' vedoucího procesu tolik ms čekáme na dočtení rour (potomci mimo skupinu je mohou držet). */
const DEFAULT_EXIT_DRAIN_MS = 2000
/** Řádek stdoutu větší než tohle zahodíme (ochrana paměti); surový záznam v stream.jsonl to nezachrání. */
const MAX_LINE_CHARS = 64 * 1024 * 1024
const STDERR_TAIL_CHARS = 8192
const INTERNAL_TOOLS = new Set(['StructuredOutput'])

// ───────────────────────── veřejné pomocné funkce ─────────────────────────

/** Spustitelný soubor `claude`: env `ULTRACODE_CLAUDE_BIN`, jinak `claude` z PATH. */
export function resolveClaudeBin(): string {
  const fromEnv = process.env['ULTRACODE_CLAUDE_BIN']
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : 'claude'
}

/**
 * Sestaví argv pro `claude` (bez prompt – ten jde na stdin). Čistá funkce.
 * Nástroje se předávají jako JEDEN argument oddělený čárkou (variadic volby by jinak mohly pohltit další argumenty;
 * specifikace s mezerou typu `Bash(git diff:*)` takto ověřeně fungují).
 */
export function buildClaudeArgs(req: ClaudeRunRequest): string[] {
  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--permission-mode',
    req.permissionMode ?? 'bypassPermissions',
  ]
  // Workflow zakazujeme vždy (kromě env CLAUDE_CODE_DISABLE_WORKFLOWS), ať se děti nerozběhnou rekurzivně.
  const disallowed = ['Workflow', ...(req.disallowedTools ?? [])]
  args.push('--disallowedTools', uniqueNonEmpty(disallowed).join(','))
  const allowed = uniqueNonEmpty(req.allowedTools ?? [])
  if (allowed.length > 0) args.push('--allowedTools', allowed.join(','))
  if (req.model) args.push('--model', req.model)
  if (req.effort) args.push('--effort', req.effort)
  if (req.schema) args.push('--json-schema', JSON.stringify(req.schema))
  const system = req.appendSystemPrompt?.trim()
    ? `${DEFAULT_SUBAGENT_SYSTEM_PROMPT}\n\n${req.appendSystemPrompt.trim()}`
    : DEFAULT_SUBAGENT_SYSTEM_PROMPT
  args.push('--append-system-prompt', system)
  if (typeof req.maxBudgetUsd === 'number' && Number.isFinite(req.maxBudgetUsd) && req.maxBudgetUsd > 0) {
    args.push('--max-budget-usd', String(req.maxBudgetUsd))
  }
  if (req.extraArgs && req.extraArgs.length > 0) args.push(...req.extraArgs)
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

// ───────────────────────── interní typy ─────────────────────────

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
  /** Smí se pokus zopakovat? */
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

// ───────────────────────── evidence běžících agentů ─────────────────────────

/**
 * Skupiny procesů běžících agentů. Potomci jsou `detached` (vlastní skupina), takže je neposlal SIGINT
 * z terminálu ani je neukončí smrt rodiče → při ukončení procesu (i `process.exit`) je v 'exit' hooku
 * zabijeme synchronně. (SIGINT/SIGTERM musí zachytit volající – CLI – a přerušit přes AbortSignal.)
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
      // chyba v posluchači nesmí shodit runner
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

  // artefakty
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
      error: { kind: 'spawn', message: `Nelze vytvořit adresář agenta ${req.outDir}: ${errMsg(err)}` },
    }
  }

  if (typeof req.prompt !== 'string' || req.prompt.trim() === '') {
    return finish(false, 0, {}, { kind: 'spawn', message: 'Prompt agenta je prázdný.' })
  }
  if (!isDirectory(req.cwd)) {
    return finish(false, 0, {}, { kind: 'spawn', message: `Pracovní adresář agenta neexistuje: ${req.cwd}` })
  }

  const maxAttempts = clampInt(req.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS_CAP)
  const tun: Tunables = {
    // NaN / záporné / nulové hodnoty nesmí tiše vypnout watchdog → spadnou na výchozí; příliš velké se ořežou na limit setTimeout.
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
    // Subagenti nesmí spouštět další workflow (globální setting uživatele by jinak rekurzoval).
    CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
  }

  let schemaRetries = 0
  let attempt = 0
  let last: Outcome | null = null

  while (attempt < maxAttempts) {
    if (req.signal?.aborted) {
      return finish(false, attempt, last ?? {}, { kind: 'aborted', message: 'Běh agenta byl přerušen.' })
    }
    attempt++
    rotateAttemptFiles(req.outDir, attempt)

    // Rozpočet je kumulativní přes všechny pokusy: každý další pokus dostane jen to, co zbylo.
    // Bez toho by `--max-budget-usd` nechalo agenta utratit až maxAttempts-násobek limitu.
    const budgetLeft = req.maxBudgetUsd === undefined ? undefined : req.maxBudgetUsd - total.costUsd
    if (budgetLeft !== undefined && !(budgetLeft > 0)) {
      return finish(false, attempt - 1, last ?? {}, { kind: 'api', message: `Vyčerpán rozpočet agenta (--max-budget-usd ${req.maxBudgetUsd}).` })
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

    const err = outcome.error ?? { kind: 'exit' as const, message: 'Neznámá chyba agenta.' }
    if (err.kind === 'aborted' || req.signal?.aborted) {
      return finish(false, attempt, outcome, { kind: 'aborted', message: 'Běh agenta byl přerušen.' })
    }
    let retryable = outcome.retryable
    if (err.kind === 'schema' && retryable) {
      // Schema: claude už samo interně vynucuje StructuredOutput (několik kol). Pokud po tom výstup chybí,
      // je to ve většině případů deterministické (protimluvné/nesplnitelné schema), proto max 1 další pokus.
      if (schemaRetries >= 1) retryable = false
      else schemaRetries++
    }
    if (!retryable || attempt >= maxAttempts) {
      return finish(false, attempt, outcome, err)
    }

    emit({ kind: 'retry', attempt: attempt + 1, reason: `${err.kind}: ${err.message}` })
    const aborted = await sleepAbortable(tun.backoffMs * attempt, req.signal)
    if (aborted) return finish(false, attempt, outcome, { kind: 'aborted', message: 'Běh agenta byl přerušen.' })
  }

  // sem se dostaneme jen při maxAttempts < 1, což clampInt vylučuje
  return finish(false, attempt, last ?? {}, { kind: 'exit', message: 'Agent nebyl spuštěn.' })
}

// ───────────────────────── jeden pokus ─────────────────────────

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
        detached: true, // vedoucí vlastní skupiny → process.kill(-pid) zabije i potomky
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve(failOutcome('spawn', `Nelze spustit „${ctx.bin}“: ${errMsg(err)}`, false))
      return
    }
    const pid = child.pid
    if (pid !== undefined) trackGroup(pid)

    // ── stav pokusu ──
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
    const textKeys = new Set<string>()
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

    // ── události ze streamu ──
    const handleEvent = (o: Json): void => {
      if (typeof o.session_id === 'string') sessionId = o.session_id
      switch (o.type) {
        case 'assistant': {
          const msg = o.message as Json | undefined
          if (!msg) return
          if (typeof msg.id === 'string' && msg.usage) {
            const prev = messageUsage.get(msg.id)
            const cur = toUsage(msg.usage)
            messageUsage.set(msg.id, prev ? maxUsage(prev, cur) : cur)
            const run = runningUsage()
            if (run.outputTokens + run.inputTokens !== lastUsageSig) {
              lastUsageSig = run.outputTokens + run.inputTokens
              ctx.emit({ kind: 'usage', usage: addUsage(ctx.baseUsage, run) })
            }
          }
          const content: unknown = msg.content
          if (!Array.isArray(content)) return
          for (const block of content as Json[]) {
            if (block?.type === 'tool_use' && typeof block.name === 'string') {
              const id = typeof block.id === 'string' ? block.id : `${o.uuid ?? ''}:${toolCalls}`
              if (toolIds.has(id)) continue
              toolIds.add(id)
              if (INTERNAL_TOOLS.has(block.name)) continue
              toolCalls++
              ctx.emit({ kind: 'tool', name: block.name })
            } else if (block?.type === 'text' && typeof block.text === 'string') {
              const key = `${o.uuid ?? msg.id ?? ''}:${block.text.length}`
              if (textKeys.has(key)) continue
              textKeys.add(key)
              ctx.emit({ kind: 'text', chars: block.text.length })
            }
          }
          return
        }
        case 'result': {
          if (resultEvent) return // bereme první result
          resultEvent = o
          clearTimeout(stallTimer)
          clearTimeout(timeoutTimer)
          if (o.usage) ctx.emit({ kind: 'usage', usage: addUsage(ctx.baseUsage, toUsage(o.usage)) })
          // proces by měl skončit sám; kdyby visel, po grace periodě ho ukončíme
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
        return // nevalidní/nekompletní JSON řádek ignorujeme (je ale v stream.jsonl)
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        try {
          handleEvent(parsed as Json)
        } catch {
          // chyba při zpracování jednoho eventu nesmí shodit pokus
        }
      }
    }

    const flushStdout = (): void => {
      outBuf += outDecoder.end()
      if (outBuf.length > 0 && !lineOverflow) handleLine(outBuf) // poslední řádek bez \n
      outBuf = ''
    }

    // ── ukončování ──
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
      // poslední úklid: nic z naší skupiny nesmí přežít
      if (pid !== undefined) {
        killGroup(pid, 'SIGKILL')
        activeGroups.delete(pid)
      }
      try {
        flushStdout()
      } catch {
        // ignoruj
      }
      try {
        child.stdout?.destroy()
        child.stderr?.destroy()
        child.stdin?.destroy()
        child.unref()
      } catch {
        // ignoruj
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

    // ── výsledek pokusu ──
    const buildOutcome = (): Outcome => {
      const stderrText = stderrTail.trim()
      const tail = stderrText ? ` | stderr: ${truncate(stderrText, 500)}` : ''
      const running = runningUsage()
      const res = resultEvent as Json | null
      // Chybový result event často nese usage nulové – tokeny už ale byly utraceny, vezmi průběžný snímek.
      const resUsage = res?.usage ? toUsage(res.usage) : null
      const usage = resUsage && resUsage.inputTokens + resUsage.outputTokens + resUsage.cacheReadTokens + resUsage.cacheCreationTokens > 0 ? resUsage : running
      const costUsd = res && typeof res.total_cost_usd === 'number' ? res.total_cost_usd : 0
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
        const hint = code === 'ENOENT' ? ' (soubor neexistuje nebo není v PATH)' : code === 'EACCES' ? ' (chybí právo ke spuštění)' : ''
        return fail('spawn', `Nelze spustit „${ctx.bin}“${hint}: ${spawnError.message}`, false)
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

      // kill z naší strany má přednost před nečistým výsledkem
      if (killReason === 'aborted') return fail('aborted', 'Běh agenta byl přerušen.', false)
      if (killReason === 'timeout') {
        return fail('timeout', `Agent překročil tvrdý limit ${tun.timeoutMs} ms a byl ukončen.${tail}`, false)
      }
      if (killReason === 'stall') {
        return fail(
          'stall',
          `Agent nevydal žádný výstup po dobu ${tun.stallMs} ms (zaseknutý) a byl ukončen.${tail}`,
          true,
        )
      }

      if (res) {
        if (res.is_error !== true) {
          // úspěšný result, ale chybí structured_output
          return fail(
            'schema',
            'Agent nevrátil strukturovaný výstup odpovídající schématu (chybí structured_output).',
            true,
          )
        }
        const text = describeResultError(res)
        const subtype = typeof res.subtype === 'string' ? res.subtype : ''
        if (subtype === 'error_max_structured_output_retries') {
          return fail('schema', `Agent nedokázal vrátit výstup validní vůči schématu: ${text}`, true)
        }
        if (subtype === 'error_max_budget_usd') {
          return fail('api', `Agent překročil svůj rozpočet (--max-budget-usd): ${text}`, false)
        }
        if (subtype === 'error_max_turns') {
          return fail('api', `Agent vyčerpal maximální počet kol: ${text}`, false)
        }
        const status = typeof res.api_error_status === 'number' ? res.api_error_status : null
        const transient = isTransientApiError(status, text)
        return fail('api', `Chyba API${status ? ` (HTTP ${status})` : ''}: ${truncate(text, 600)}`, transient)
      }

      // žádný result event
      const how = exitSignal ? `signálem ${exitSignal}` : `s kódem ${exitCode}`
      if (/is not a valid JSON Schema/i.test(stderrText)) {
        return fail('schema', `claude odmítlo schéma: ${truncate(stderrText, 600)}`, false)
      }
      if (/unknown option|is invalid\. Allowed choices|Input must be provided|required option .* not specified/i.test(stderrText)) {
        return fail('exit', `claude odmítlo argumenty (${how}): ${truncate(stderrText, 600)}`, false)
      }
      if (exitCode === 0 && !exitSignal) {
        return fail('exit', `claude skončilo bez výsledku (chybí event result).${tail}`, true)
      }
      return fail('exit', `claude skončilo ${how} bez výsledku.${tail}`, true)
    }

    // ── obsluha procesu ──
    child.on('error', (err) => {
      // 'error' po úspěšném spawnu (pid existuje) neřešíme – proces dál běží a skončí přes 'exit'/'close'.
      if (pid !== undefined) return
      spawnError = err
      exited = true // po chybě spawnu 'exit' nepřijde
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
      // zbytek skupiny (potomci, které claude/nástroje po sobě nechaly) končí s ním
      if (pid !== undefined) killGroup(pid, 'SIGKILL')
      // roury může držet potomek mimo naši skupinu → po krátké době nečekáme dál
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
        if (lineOverflow) lineOverflow = false // konec přetékajícího řádku
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
      if (text) {
        writeArtifactAppend(stderrFile, text)
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS)
      }
    })
    child.stderr?.on('error', () => {})

    child.stdin?.on('error', () => {}) // EPIPE, když proces skončí dřív, než přečte prompt
    try {
      child.stdin?.end(req.prompt)
    } catch {
      // ignoruj
    }

    // ── watchdogy ──
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

// ───────────────────────── klasifikace chyb ─────────────────────────

/** Text chyby z `result` eventu (is_error:true). */
function describeResultError(res: Json): string {
  if (typeof res.result === 'string' && res.result.trim()) return res.result.trim()
  if (Array.isArray(res.errors) && res.errors.length > 0) return res.errors.map(String).join('; ')
  if (typeof res.subtype === 'string') return res.subtype
  return 'neznámá chyba'
}

/**
 * Je chyba API přechodná (má smysl zkusit znovu)?
 * Trvalé: 400/401/403/404 (špatný klíč, neexistující model…), vyčerpaný limit/kredit.
 * Přechodné: 408/409/425/429/5xx (včetně 529 overloaded), nebo bez HTTP kódu síťové chyby/timeouty.
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

// ───────────────────────── pomocné ─────────────────────────

/** Zabije celou skupinu procesů (vedoucí = pid). Vrací, zda se signál podařilo doručit. */
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
    // artefakty jsou pomocné; selhání zápisu neshazuje agenta
  }
}

function writeArtifactAppend(file: string, data: string): void {
  try {
    appendFileSync(file, data)
  } catch {
    // viz výše
  }
}

/**
 * Před pokusem N>1 odsune záznam předchozího pokusu (stream.attempt-<N-1>.jsonl, stderr.attempt-<N-1>.txt)
 * a založí prázdné stream.jsonl/stderr.txt, aby tyto dva soubory vždy odpovídaly POSLEDNÍMU pokusu.
 */
function rotateAttemptFiles(outDir: string, attempt: number): void {
  const stream = join(outDir, 'stream.jsonl')
  const stderr = join(outDir, 'stderr.txt')
  if (attempt > 1) {
    try {
      renameSync(stream, join(outDir, `stream.attempt-${attempt - 1}.jsonl`))
    } catch {
      // nemusí existovat
    }
    try {
      renameSync(stderr, join(outDir, `stderr.attempt-${attempt - 1}.txt`))
    } catch {
      // nemusí existovat
    }
  }
  writeArtifact(stream, '')
  writeArtifact(stderr, '')
}

/** Spánek přerušitelný signálem. Vrací true, pokud byl přerušen abortem. */
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
