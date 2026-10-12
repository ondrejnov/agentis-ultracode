#!/usr/bin/env node
/**
 * Fake agent for tests (ULTRACODE_CLAUDE_BIN=<this file>).
 *
 * Imitates `agentiscode --adapter claude --json …` wrapping `claude -p` (format verified on a real agentiscode +
 * claude 2.1.x, see sample-stream-*.jsonl): claude-specific flags arrive in `--extra-args-json`, output is the
 * unified agentiscode JSON Lines (session/text/tool/step/stderr/error/result), claude's stderr is forwarded as
 * `stderr` events and a crash without a result ends with an `error` event + synthetic result.
 * Reads the prompt from stdin, looks for directives anywhere in the prompt.
 *
 * SHARED CONTRACT (must not change):
 *   [[fake:json {...}]]    with --json-schema returns structured_output = this JSON
 *                          (without a directive a minimal object is generated from the schema:
 *                          string→"x", number/integer→1, boolean→true, array→[], object→object with its properties)
 *   [[fake:text ABC]]      final text = ABC (default "echo: " + first 200 characters of the prompt without directives)
 *   [[fake:sleep 300]]     waits 300 ms before the result
 *   [[fake:tools 3]]       emits 3 tool_use events
 *   [[fake:tokens 120]]    output_tokens=120 (default 10); [[fake:cost 0.02]] total_cost_usd (default 0.001)
 *   [[fake:fail]]          always exits with 1 and a message on stderr
 *   [[fake:fail-times N]]  the first N attempts with the same prompt exit with 1, the next ones succeed
 *                          (counter in $FAKE_CLAUDE_STATE_DIR, key = sha1 of the prompt)
 *   [[fake:stall]]         prints init and then hangs forever (until killed); [[fake:stall-times N]] the same for the first N attempts
 *   [[fake:apierror]]      result with is_error:true, subtype:"error_during_execution", exit 1
 *   Each run appends a JSON line to $FAKE_CLAUDE_LOG:
 *     {pid,startedAt,endedAt,args,cwd,prompt,env:{CLAUDE_CODE_DISABLE_WORKFLOWS},attempt}
 *   (the line is written on exit – also on SIGTERM/SIGINT; no line is written after SIGKILL).
 *
 * EXTENSIONS (superset of the contract, nothing above is changed):
 *   [[fake:apierror 529]]       like apierror, but with api_error_status 529 (transient error; another code = another status)
 *   [[fake:apierror-times N]]   the first N attempts fail with API error 529 (transient), the next ones succeed
 *   [[fake:input 42]]           input_tokens (default 10)
 *   [[fake:cache 100 50]]       cache_read_input_tokens, cache_creation_input_tokens (default 0 0)
 *   [[fake:turns 7]]            num_turns (default 1 + number of tools)
 *   [[fake:stderr TEXT]]        writes TEXT to stderr (during the run)
 *   [[fake:heartbeat 100 5]]    5× every 100 ms writes a dot to stderr (activity without stdout), then continues
 *   [[fake:child]]              starts a child `sleep 600` (in the same process group, holds stdout/stderr);
 *                               its pid is in the event {"type":"fake_child","pid":N}
 *                               and in the log line as childPid
 *   [[fake:ignore-term]]        ignores SIGTERM (only SIGKILL can kill it)
 *   [[fake:no-newline]]         last (result) line without a trailing \n
 *   [[fake:garbage]]            inserts invalid JSON lines and a fragment of an incomplete line into the output
 *   [[fake:hang-after-result]]  after the result event the process does not exit (hangs)
 *   [[fake:no-result]]          exits with 0 with only agentiscode's synthetic result (claude produced none)
 *   [[fake:missing-structured]] with --json-schema returns a successful result WITHOUT structured_output
 *   [[fake:exit-code N]]        after the result event exits with code N (default 0, 1 for errors)
 *
 * Environment variables: FAKE_CLAUDE_LOG (log file), FAKE_CLAUDE_STATE_DIR (attempt counters;
 * default $TMPDIR/fake-claude-state-<ppid>, i.e. bound to the parent process = runner).
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, fstatSync, mkdirSync, openSync, closeSync, writeSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const startedAt = new Date().toISOString()
const argv = process.argv.slice(2)

/** agentiscode argv with `--extra-args-json` expanded in place (= what reaches `claude`). */
const effectiveArgv = (() => {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--extra-args-json' && i + 1 < argv.length) {
      out.push(...JSON.parse(argv[++i]))
    } else out.push(argv[i])
  }
  return out
})()

function argValue(name) {
  const i = effectiveArgv.indexOf(name)
  return i >= 0 && i + 1 < effectiveArgv.length ? effectiveArgv[i + 1] : undefined
}

const outputFormat = argv.includes('--json') ? 'json-lines' : 'text'
const schemaArg = argValue('--json-schema')
const model = argValue('--model')

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}
const prompt = readStdin()

// ───────── directives ─────────

const directives = [] // {name, value, start, end}

/** Finds a `]]` followed by valid JSON (the JSON may contain `]]`, e.g. [[1]]). */
function parseJsonDirective(text, from) {
  let idx = text.indexOf(']]', from)
  while (idx >= 0) {
    const candidate = text.slice(from, idx).trim()
    try {
      return { value: JSON.parse(candidate), end: idx + 2 }
    } catch {
      // try the next ]]
    }
    idx = text.indexOf(']]', idx + 1)
  }
  // also try the variant where the JSON ends with `]` right before `]]`
  return null
}

{
  const re = /\[\[fake:([a-z-]+)/g
  let m
  while ((m = re.exec(prompt)) !== null) {
    const name = m[1]
    const afterName = m.index + m[0].length
    if (name === 'json') {
      const parsed = parseJsonDirective(prompt, afterName)
      if (parsed) {
        directives.push({ name, value: parsed.value, start: m.index, end: parsed.end })
        re.lastIndex = parsed.end
        continue
      }
    }
    const close = prompt.indexOf(']]', afterName)
    if (close < 0) continue
    directives.push({ name, value: prompt.slice(afterName, close).trim(), start: m.index, end: close + 2 })
    re.lastIndex = close + 2
  }
}

const has = (name) => directives.some((d) => d.name === name)
const val = (name) => directives.find((d) => d.name === name)?.value
const num = (name, def) => {
  const v = val(name)
  if (v === undefined) return def
  const first = String(v).trim().split(/\s+/)[0]
  if (first === '') return def
  const n = Number(first)
  return Number.isFinite(n) ? n : def
}

let cleanPrompt = prompt
for (const d of [...directives].sort((a, b) => b.start - a.start)) {
  cleanPrompt = cleanPrompt.slice(0, d.start) + cleanPrompt.slice(d.end)
}
cleanPrompt = cleanPrompt.replace(/\s+/g, ' ').trim()

// ───────── attempt counter ─────────

const promptHash = createHash('sha1').update(prompt).digest('hex')
const stateDir = process.env.FAKE_CLAUDE_STATE_DIR || join(tmpdir(), `fake-claude-state-${process.ppid}`)
let attempt = 1
try {
  mkdirSync(stateDir, { recursive: true })
  const fd = openSync(join(stateDir, `${promptHash}.count`), 'a+')
  writeSync(fd, 'x')
  attempt = fstatSync(fd).size
  closeSync(fd)
} catch {
  // without counter
}

// ───────── log ─────────

let childPid = null
let logged = false
function writeLog() {
  if (logged) return
  logged = true
  const logFile = process.env.FAKE_CLAUDE_LOG
  if (!logFile) return
  const entry = {
    pid: process.pid,
    startedAt,
    endedAt: new Date().toISOString(),
    args: argv,
    cwd: process.cwd(),
    prompt,
    env: {
      CLAUDE_CODE_DISABLE_WORKFLOWS: process.env.CLAUDE_CODE_DISABLE_WORKFLOWS ?? null,
      // extension for testing env passing (superset of the contract)
      ULTRACODE_TEST_ENV: process.env.ULTRACODE_TEST_ENV ?? null,
    },
    attempt,
    ...(childPid !== null ? { childPid } : {}),
  }
  try {
    appendFileSync(logFile, JSON.stringify(entry) + '\n')
  } catch {
    // ignore
  }
}

const ignoreTerm = has('ignore-term')
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    writeLog()
    if (!ignoreTerm) process.exit(128 + (sig === 'SIGTERM' ? 15 : sig === 'SIGINT' ? 2 : 1))
  })
}
process.on('exit', writeLog)

// ───────── output ─────────

const sessionId = randomUUID()
function emit(obj, { newline = true } = {}) {
  if (outputFormat !== 'json-lines') return
  process.stdout.write(JSON.stringify(obj) + (newline ? '\n' : ''))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function minimalFromSchema(schema) {
  if (!schema || typeof schema !== 'object') return {}
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  let type = schema.type
  if (Array.isArray(type)) type = type.find((t) => t !== 'null') ?? type[0]
  if (!type && schema.properties) type = 'object'
  switch (type) {
    case 'string':
      return 'x'
    case 'number':
    case 'integer':
      return 1
    case 'boolean':
      return true
    case 'array':
      return []
    case 'null':
      return null
    case 'object':
    default: {
      const out = {}
      for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = minimalFromSchema(v)
      return out
    }
  }
}

function usageObject() {
  return {
    input_tokens: num('input', 10),
    output_tokens: num('tokens', 10),
    cache_read_input_tokens: Number(String(val('cache') ?? '0 0').split(/\s+/)[0]) || 0,
    cache_creation_input_tokens: Number(String(val('cache') ?? '0 0').split(/\s+/)[1]) || 0,
  }
}

/** One assistant message the way agentiscode emits it: the content block + a per-message `step` with usage. */
function emitAssistant(content) {
  const messageId = `msg_${randomUUID().slice(0, 12)}`
  if (content.type === 'tool_use') {
    emit({ type: 'tool', id: content.id, name: content.name, status: 'running', input: content.input, title: content.name, message_id: messageId })
  } else {
    emit({ type: 'text', text: content.text, message_id: messageId })
  }
  emit({
    type: 'step',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    cost_usd: null,
    message_id: messageId,
  })
}

/** claude died without a result: agentiscode forwards its stderr, adds an `error` and a synthetic result, exits 1. */
function emitCrash(stderrLine) {
  emit({ type: 'stderr', line: stderrLine })
  emit({ type: 'error', message: `claude skončil s kódem 1: ${stderrLine}`, exit_code: 1, stderr: stderrLine })
  emit({ type: 'result', session_id: sessionId, usage: null, cost_usd: null, is_error: true, synthetic: true })
}

async function main() {
  const t0 = Date.now()
  process.stderr.write(`[agentiscode] command: agentiscode ${argv.join(' ')}\n`)
  const stderrText = val('stderr')
  if (stderrText) emit({ type: 'stderr', line: String(stderrText) })

  emit({
    type: 'session',
    adapter: 'claude',
    session_id: sessionId,
    model: model ?? 'fake-model',
    provider: 'anthropic',
    cwd: process.cwd(),
  })

  if (has('child')) {
    const c = spawn('sleep', ['600'], { stdio: 'inherit' }) // in the SAME group, holds the pipes
    c.unref()
    childPid = c.pid ?? null
    emit({ type: 'fake_child', pid: childPid, session_id: sessionId })
  }

  // fail / stall (depending on the attempt)
  if (has('fail')) {
    emitCrash('fake-claude: simulated failure (fail)')
    process.exitCode = 1
    return
  }
  const failTimes = num('fail-times', 0)
  if (failTimes > 0 && attempt <= failTimes) {
    emitCrash(`fake-claude: simulated failure (fail-times ${failTimes}, attempt ${attempt})`)
    process.exitCode = 1
    return
  }
  const stallTimes = num('stall-times', 0)
  if (has('stall') || (stallTimes > 0 && attempt <= stallTimes)) {
    setInterval(() => {}, 1 << 30) // hangs until killed
    await new Promise(() => {})
  }

  if (has('garbage')) {
    process.stdout.write('this is not json {\n')
    process.stdout.write('{"type":"text","text":"te\n')
  }

  // tools
  const toolsN = Math.max(0, Math.floor(num('tools', 0)))
  const toolNames = ['Read', 'Bash', 'Grep']
  for (let i = 0; i < toolsN; i++) {
    const id = `toolu_fake_${attempt}_${i}`
    emitAssistant({ type: 'tool_use', id, name: toolNames[i % toolNames.length], input: { n: i } })
    emit({ type: 'tool', id, status: 'completed', output: 'ok' })
  }

  if (has('heartbeat')) {
    const [intervalRaw, countRaw] = String(val('heartbeat')).trim().split(/\s+/)
    const interval = Number(intervalRaw) || 100
    const count = Number(countRaw) || 5
    for (let i = 0; i < count; i++) {
      await sleep(interval)
      process.stderr.write('.')
    }
  }

  const sleepMs = num('sleep', 0)
  if (sleepMs > 0) await sleep(sleepMs)

  if (has('no-result')) {
    emit({ type: 'result', session_id: sessionId, usage: null, cost_usd: null, is_error: false, synthetic: true })
    return
  }

  const usage = usageObject()
  const cost = num('cost', 0.001)
  const numTurns = num('turns', 1 + toolsN)
  const base = {
    type: 'result',
    session_id: sessionId,
    usage: { ...usage, cache_write_tokens: 0 },
    cost_usd: cost,
    duration_ms: Date.now() - t0,
    num_turns: numTurns,
  }

  let exitCode = num('exit-code', 0)
  const apiTimes = num('apierror-times', 0)
  const wantsApiError = has('apierror') || (apiTimes > 0 && attempt <= apiTimes)

  if (wantsApiError) {
    const rawStatus = has('apierror') ? String(val('apierror')).trim().split(/\s+/)[0] : ''
    const explicit = rawStatus === '' ? NaN : Number(rawStatus)
    const status = Number.isFinite(explicit) ? explicit : apiTimes > 0 ? 529 : null
    emit(
      {
        ...base,
        subtype: 'error_during_execution',
        is_error: true,
        ...(status !== null ? { api_error_status: status } : {}),
        terminal_reason: 'api_error',
        result: status === 529 ? 'API Error: 529 overloaded_error (fake)' : `API Error: simulated error${status ? ` ${status}` : ''} (fake)`,
      },
      { newline: !has('no-newline') },
    )
    exitCode = exitCode || 1
  } else {
    let structured
    let text
    if (schemaArg !== undefined && !has('missing-structured')) {
      const j = val('json')
      structured = j !== undefined && typeof j === 'object' ? j : minimalFromSchema(safeParse(schemaArg))
      emitAssistant({ type: 'tool_use', id: `toolu_fake_so_${attempt}`, name: 'StructuredOutput', input: structured })
    }
    if (has('text')) text = String(val('text'))
    else if (structured !== undefined) text = JSON.stringify(structured)
    else text = 'echo: ' + cleanPrompt.slice(0, 200)
    emitAssistant({ type: 'text', text })
    emit(
      {
        ...base,
        subtype: 'success',
        is_error: false,
        terminal_reason: 'completed',
        result: text,
        ...(structured !== undefined ? { structured_output: structured } : {}),
      },
      { newline: !has('no-newline') },
    )
  }

  if (has('hang-after-result')) {
    setInterval(() => {}, 1 << 30)
    await new Promise(() => {})
  }
  process.exitCode = exitCode
}

function safeParse(s) {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

if (outputFormat !== 'json-lines') {
  // text mode (without --json) – minimal support only
  const text = has('text') ? String(val('text')) : 'echo: ' + cleanPrompt.slice(0, 200)
  process.stdout.write(text + '\n')
  writeLog()
} else {
  await main()
}
