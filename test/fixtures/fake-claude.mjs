#!/usr/bin/env node
/**
 * Falešný `claude` pro testy (ULTRACODE_CLAUDE_BIN=<tento soubor>).
 *
 * Napodobuje `claude -p --output-format stream-json --verbose` (formát ověřený na reálném claude 2.1.x,
 * viz sample-stream-*.jsonl). Prompt čte ze stdin, direktivy hledá kdekoli v promptu.
 *
 * SDÍLENÝ KONTRAKT (nesmí se měnit):
 *   [[fake:json {...}]]    při --json-schema vrátí structured_output = tento JSON
 *                          (bez direktivy se vygeneruje minimální objekt podle schema:
 *                          string→"x", number/integer→1, boolean→true, array→[], object→objekt s vlastnostmi)
 *   [[fake:text ABC]]      finální text = ABC (default "echo: " + prvních 200 znaků promptu bez direktiv)
 *   [[fake:sleep 300]]     počká 300 ms před výsledkem
 *   [[fake:tools 3]]       vyemituje 3 tool_use eventy
 *   [[fake:tokens 120]]    output_tokens=120 (default 10); [[fake:cost 0.02]] total_cost_usd (default 0.001)
 *   [[fake:fail]]          vždy skončí exit 1 se zprávou na stderr
 *   [[fake:fail-times N]]  prvních N pokusů se stejným promptem skončí exit 1, další uspějí
 *                          (počítadlo v $FAKE_CLAUDE_STATE_DIR, klíč = sha1 promptu)
 *   [[fake:stall]]         vypíše init a pak visí navždy (až do zabití); [[fake:stall-times N]] totéž prvních N pokusů
 *   [[fake:apierror]]      result s is_error:true, subtype:"error_during_execution", exit 1
 *   Každé spuštění přidá řádek JSON do $FAKE_CLAUDE_LOG:
 *     {pid,startedAt,endedAt,args,cwd,prompt,env:{CLAUDE_CODE_DISABLE_WORKFLOWS},attempt}
 *   (řádek se zapisuje při ukončení – i při SIGTERM/SIGINT; po SIGKILL řádek nevznikne).
 *
 * ROZŠÍŘENÍ (nadmnožina kontraktu, nic z výše uvedeného nemění):
 *   [[fake:apierror 529]]       jako apierror, ale s api_error_status 529 (přechodná chyba; jiný kód = jiný status)
 *   [[fake:apierror-times N]]   prvních N pokusů API chyba 529 (přechodná), další uspějí
 *   [[fake:input 42]]           input_tokens (default 10)
 *   [[fake:cache 100 50]]       cache_read_input_tokens, cache_creation_input_tokens (default 0 0)
 *   [[fake:turns 7]]            num_turns (default 1 + počet tools)
 *   [[fake:stderr TEXT]]        zapíše TEXT na stderr (v průběhu běhu)
 *   [[fake:heartbeat 100 5]]    5× po 100 ms zapíše tečku na stderr (aktivita bez stdout), pak pokračuje
 *   [[fake:child]]              spustí potomka `sleep 600` (ve stejné skupině procesů, drží stdout/stderr);
 *                               jeho pid je v eventu {"type":"system","subtype":"fake_child","pid":N}
 *                               a v řádku logu jako childPid
 *   [[fake:ignore-term]]        ignoruje SIGTERM (zabít jde jen SIGKILL)
 *   [[fake:no-newline]]         poslední (result) řádek bez koncového \n
 *   [[fake:garbage]]            do výstupu vloží nevalidní JSON řádky a kus rozepsaného řádku
 *   [[fake:hang-after-result]]  po result eventu proces nekončí (visí)
 *   [[fake:no-result]]          skončí exit 0 bez result eventu
 *   [[fake:missing-structured]] při --json-schema vrátí úspěšný result BEZ structured_output
 *   [[fake:exit-code N]]        po result eventu skončí s kódem N (default 0, u chyb 1)
 *
 * Proměnné prostředí: FAKE_CLAUDE_LOG (soubor logu), FAKE_CLAUDE_STATE_DIR (počítadla pokusů;
 * default $TMPDIR/fake-claude-state-<ppid>, tedy vázané na rodičovský proces = runner).
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, fstatSync, mkdirSync, openSync, closeSync, writeSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const startedAt = new Date().toISOString()
const argv = process.argv.slice(2)

function argValue(name) {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
}

const outputFormat = argValue('--output-format') ?? 'text'
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

// ───────── direktivy ─────────

const directives = [] // {name, value, start, end}

/** Najde `]]`, za kterým je validní JSON (JSON může obsahovat `]]`, např. [[1]]). */
function parseJsonDirective(text, from) {
  let idx = text.indexOf(']]', from)
  while (idx >= 0) {
    const candidate = text.slice(from, idx).trim()
    try {
      return { value: JSON.parse(candidate), end: idx + 2 }
    } catch {
      // zkus další ]]
    }
    idx = text.indexOf(']]', idx + 1)
  }
  // zkus i variantu, kdy JSON končí `]` těsně před `]]`
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

// ───────── počítadlo pokusů ─────────

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
  // bez počítadla
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
      // rozšíření pro testy předávání env (nadmnožina kontraktu)
      ULTRACODE_TEST_ENV: process.env.ULTRACODE_TEST_ENV ?? null,
    },
    attempt,
    ...(childPid !== null ? { childPid } : {}),
  }
  try {
    appendFileSync(logFile, JSON.stringify(entry) + '\n')
  } catch {
    // ignoruj
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

// ───────── výstup ─────────

const sessionId = randomUUID()
function emit(obj, { newline = true } = {}) {
  if (outputFormat !== 'stream-json') return
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

function assistantEvent(content, extra = {}) {
  return {
    type: 'assistant',
    message: {
      model: model ?? 'fake-model',
      id: `msg_${randomUUID().slice(0, 12)}`,
      type: 'message',
      role: 'assistant',
      content: [content],
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ...extra,
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
  }
}

async function main() {
  const t0 = Date.now()
  const stderrText = val('stderr')
  if (stderrText) process.stderr.write(String(stderrText) + '\n')

  emit({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: sessionId,
    model: model ?? 'fake-model',
    permissionMode: argValue('--permission-mode') ?? 'default',
    tools: ['Read', 'Bash', 'Grep'],
    uuid: randomUUID(),
  })

  if (has('child')) {
    const c = spawn('sleep', ['600'], { stdio: 'inherit' }) // ve STEJNÉ skupině, drží roury
    c.unref()
    childPid = c.pid ?? null
    emit({ type: 'system', subtype: 'fake_child', pid: childPid, session_id: sessionId, uuid: randomUUID() })
  }

  // fail / stall (podle pokusu)
  if (has('fail')) {
    process.stderr.write('fake-claude: simulované selhání (fail)\n')
    process.exitCode = 1
    return
  }
  const failTimes = num('fail-times', 0)
  if (failTimes > 0 && attempt <= failTimes) {
    process.stderr.write(`fake-claude: simulované selhání (fail-times ${failTimes}, pokus ${attempt})\n`)
    process.exitCode = 1
    return
  }
  const stallTimes = num('stall-times', 0)
  if (has('stall') || (stallTimes > 0 && attempt <= stallTimes)) {
    setInterval(() => {}, 1 << 30) // visí do zabití
    await new Promise(() => {})
  }

  if (has('garbage')) {
    process.stdout.write('tohle neni json {\n')
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"te\n')
  }

  // tools
  const toolsN = Math.max(0, Math.floor(num('tools', 0)))
  const toolNames = ['Read', 'Bash', 'Grep']
  for (let i = 0; i < toolsN; i++) {
    const id = `toolu_fake_${attempt}_${i}`
    emit(assistantEvent({ type: 'tool_use', id, name: toolNames[i % toolNames.length], input: { n: i } }))
    emit({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
      session_id: sessionId,
      uuid: randomUUID(),
    })
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

  if (has('no-result')) return

  const usage = usageObject()
  const cost = num('cost', 0.001)
  const numTurns = num('turns', 1 + toolsN)
  const base = {
    type: 'result',
    duration_ms: Date.now() - t0,
    duration_api_ms: Date.now() - t0,
    num_turns: numTurns,
    session_id: sessionId,
    total_cost_usd: cost,
    usage: { ...usage, service_tier: 'standard' },
    permission_denials: [],
    uuid: randomUUID(),
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
        api_error_status: status,
        terminal_reason: 'api_error',
        result: status === 529 ? 'API Error: 529 overloaded_error (fake)' : `API Error: simulovaná chyba${status ? ` ${status}` : ''} (fake)`,
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
      emit(assistantEvent({ type: 'tool_use', id: `toolu_fake_so_${attempt}`, name: 'StructuredOutput', input: structured }))
    }
    if (has('text')) text = String(val('text'))
    else if (structured !== undefined) text = JSON.stringify(structured)
    else text = 'echo: ' + cleanPrompt.slice(0, 200)
    emit(assistantEvent({ type: 'text', text }))
    emit(
      {
        ...base,
        subtype: 'success',
        is_error: false,
        api_error_status: null,
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

if (outputFormat !== 'stream-json') {
  // režim `--output-format text|json` – jen minimální podpora
  const text = has('text') ? String(val('text')) : 'echo: ' + cleanPrompt.slice(0, 200)
  if (outputFormat === 'json') process.stdout.write(JSON.stringify({ type: 'result', result: text, is_error: false }) + '\n')
  else process.stdout.write(text + '\n')
  writeLog()
} else {
  await main()
}
