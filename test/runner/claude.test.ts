import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SUBAGENT_SYSTEM_PROMPT, runClaude } from '../../src/runner/claude.ts'
import type { ClaudeProgress, ClaudeRunRequest } from '../../src/types.ts'
import {
  FIXTURES,
  argOf,
  childPidFromStream,
  collectProgress,
  isAlive,
  makeSandbox,
  readLog,
  waitDead,
} from './helpers.ts'
import type { Sandbox } from './helpers.ts'

let sb: Sandbox
const savedEnv = { ...process.env }

function setup(): Sandbox {
  sb = makeSandbox()
  return sb
}

function req(prompt: string, extra: Partial<ClaudeRunRequest> = {}): ClaudeRunRequest {
  return { prompt, cwd: sb.cwd, outDir: sb.outDir, stallMs: 10_000, ...extra }
}

afterEach(() => {
  // vrať prostředí do původního stavu a uklid
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
  Object.assign(process.env, savedEnv)
  sb?.cleanup()
})

describe('runClaude – základní průchod', () => {
  it('textový výsledek + artefakty v outDir', async () => {
    setup()
    const r = await runClaude(req('Řekni ahoj [[fake:tokens 42]] [[fake:cost 0.02]]'))
    assert.equal(r.ok, true)
    assert.equal(r.text, 'echo: Řekni ahoj')
    assert.equal(r.structured, null)
    assert.equal(r.attempts, 1)
    assert.equal(r.error, undefined)
    assert.equal(r.usage.outputTokens, 42)
    assert.equal(r.costUsd, 0.02)
    assert.equal(r.numTurns, 1)
    assert.ok(typeof r.sessionId === 'string' && r.sessionId.length > 0)
    assert.ok(r.durationMs >= 0)

    // artefakty
    assert.equal(readFileSync(join(sb.outDir, 'prompt.txt'), 'utf8'), 'Řekni ahoj [[fake:tokens 42]] [[fake:cost 0.02]]')
    const stream = readFileSync(join(sb.outDir, 'stream.jsonl'), 'utf8').trim().split('\n')
    assert.ok(stream.length >= 3)
    assert.equal(JSON.parse(stream[0]!).subtype, 'init')
    assert.equal(JSON.parse(stream.at(-1)!).type, 'result')
    assert.ok(existsSync(join(sb.outDir, 'stderr.txt')))
    const saved = JSON.parse(readFileSync(join(sb.outDir, 'result.json'), 'utf8'))
    assert.deepEqual(saved, JSON.parse(JSON.stringify(r)))
  })

  it('schema: structured z direktivy json; text je jeho JSON', async () => {
    setup()
    const schema = { type: 'object', properties: { n: { type: 'number' }, tags: { type: 'array' } }, required: ['n'] }
    const r = await runClaude(req('vrať data [[fake:json {"n":7,"tags":[["a"]]}]]', { schema }))
    assert.equal(r.ok, true)
    assert.deepEqual(r.structured, { n: 7, tags: [['a']] })
    assert.equal(r.text, '{"n":7,"tags":[["a"]]}')
    assert.equal(argOf(readLog(sb)[0]!.args, '--json-schema'), JSON.stringify(schema))
  })

  it('schema bez direktivy: minimální objekt podle schema', async () => {
    setup()
    const schema = {
      type: 'object',
      properties: { s: { type: 'string' }, n: { type: 'number' }, b: { type: 'boolean' }, a: { type: 'array' }, o: { type: 'object' } },
    }
    const r = await runClaude(req('x', { schema }))
    assert.equal(r.ok, true)
    assert.deepEqual(r.structured, { s: 'x', n: 1, b: true, a: [], o: {} })
  })

  it('velký výstup s vícebajtovými znaky přes hranice chunků', async () => {
    setup()
    const big = 'řa'.repeat(150_000) // ~450 kB, hranice chunků padnou doprostřed znaku
    const r = await runClaude(req(`[[fake:text ${big}]]`))
    assert.equal(r.ok, true)
    assert.equal(r.text, big)
  })

  it('stderr procesu se zapisuje do stderr.txt', async () => {
    setup()
    const r = await runClaude(req('x [[fake:stderr varování z claude]]'))
    assert.equal(r.ok, true)
    assert.match(readFileSync(join(sb.outDir, 'stderr.txt'), 'utf8'), /varování z claude/)
  })

  it('souběžná volání neblokují jedno druhé', async () => {
    setup()
    const runs = await Promise.all(
      [1, 2, 3, 4].map((i) => runClaude({ ...req(`paralelní ${i} [[fake:sleep 400]]`), outDir: join(sb.root, `out${i}`) })),
    )
    assert.ok(runs.every((r) => r.ok))
    const log = readLog(sb)
    assert.equal(log.length, 4)
    const maxStart = Math.max(...log.map((e) => Date.parse(e.startedAt)))
    const minEnd = Math.min(...log.map((e) => Date.parse(e.endedAt)))
    assert.ok(maxStart < minEnd, 'všechny běhy se musely překrývat')
  })
})

describe('runClaude – argumenty a prostředí', () => {
  it('argv: Workflow zakázán, bypassPermissions, model, effort, schema, system prompt, rozpočet', async () => {
    setup()
    const schema = { type: 'object', properties: { a: { type: 'string' } } }
    const r = await runClaude(
      req('x', {
        model: 'haiku',
        effort: 'low',
        schema,
        appendSystemPrompt: 'Mluv jen česky.',
        disallowedTools: ['WebFetch', 'Workflow'],
        allowedTools: ['Read', 'Bash(git diff:*)'],
        maxBudgetUsd: 0.5,
        extraArgs: ['--add-dir', '/tmp'],
      }),
    )
    assert.equal(r.ok, true)
    const { args, cwd } = readLog(sb)[0]!
    assert.equal(args[0], '-p')
    assert.equal(argOf(args, '--output-format'), 'stream-json')
    assert.ok(args.includes('--verbose'))
    assert.ok(args.includes('--no-session-persistence'))
    assert.equal(argOf(args, '--permission-mode'), 'bypassPermissions')
    assert.equal(argOf(args, '--disallowedTools'), 'Workflow,WebFetch')
    assert.equal(argOf(args, '--allowedTools'), 'Read,Bash(git diff:*)')
    assert.equal(argOf(args, '--model'), 'haiku')
    assert.equal(argOf(args, '--effort'), 'low')
    assert.equal(argOf(args, '--max-budget-usd'), '0.5')
    assert.equal(argOf(args, '--add-dir'), '/tmp')
    const sys = argOf(args, '--append-system-prompt')!
    assert.ok(sys.startsWith(DEFAULT_SUBAGENT_SYSTEM_PROMPT))
    assert.ok(sys.endsWith('Mluv jen česky.'))
    assert.equal(cwd, sb.cwd.replace(/^\/private/, ''))
    // prompt nikdy v argv, jde přes stdin
    assert.ok(!args.includes('x'))
  })

  it('výchozí system prompt je i bez appendSystemPrompt; custom permissionMode', async () => {
    setup()
    await runClaude(req('x', { permissionMode: 'dontAsk' }))
    const { args } = readLog(sb)[0]!
    assert.equal(argOf(args, '--append-system-prompt'), DEFAULT_SUBAGENT_SYSTEM_PROMPT)
    assert.equal(argOf(args, '--permission-mode'), 'dontAsk')
    assert.equal(argOf(args, '--disallowedTools'), 'Workflow')
    assert.ok(!args.includes('--allowedTools'))
    assert.ok(!args.includes('--json-schema'))
    assert.ok(!args.includes('--model'))
  })

  it('env: CLAUDE_CODE_DISABLE_WORKFLOWS=1 vždy (i proti req.env), vlastní env projde', async () => {
    setup()
    await runClaude(req('x', { env: { CLAUDE_CODE_DISABLE_WORKFLOWS: '0', ULTRACODE_TEST_ENV: 'hodnota' } }))
    const { env } = readLog(sb)[0]!
    assert.equal(env.CLAUDE_CODE_DISABLE_WORKFLOWS, '1')
    assert.equal(env.ULTRACODE_TEST_ENV, 'hodnota')
  })

  it('req.bin má přednost před env ULTRACODE_CLAUDE_BIN (a nic nemění v process.env)', async () => {
    setup()
    const real = process.env['ULTRACODE_CLAUDE_BIN']
    process.env['ULTRACODE_CLAUDE_BIN'] = '/neexistuje/claude'
    const r = await runClaude(req('x', { bin: real }))
    assert.equal(r.ok, true, r.error?.message)
    assert.equal(process.env['ULTRACODE_CLAUDE_BIN'], '/neexistuje/claude')
    assert.equal(readLog(sb).length, 1)
  })

  it('cwd agenta = req.cwd', async () => {
    setup()
    await runClaude(req('x'))
    assert.equal(readLog(sb)[0]!.cwd, sb.cwd)
  })
})

describe('runClaude – progress a agregace', () => {
  it('tool progress, start s pid, text a usage', async () => {
    setup()
    const p = collectProgress()
    const r = await runClaude(req('x [[fake:tools 3]]', { onProgress: p.push }))
    assert.equal(r.ok, true)
    assert.equal(r.toolCalls, 3)
    assert.equal(r.numTurns, 4)
    const tools = p.events.filter((e): e is Extract<ClaudeProgress, { kind: 'tool' }> => e.kind === 'tool')
    assert.deepEqual(tools.map((t) => t.name), ['Read', 'Bash', 'Grep'])
    const start = p.events.find((e) => e.kind === 'start')
    assert.ok(start && start.kind === 'start' && start.attempt === 1 && typeof start.pid === 'number')
    assert.equal(p.events[0]!.kind, 'start')
    assert.ok(p.events.some((e) => e.kind === 'text' && e.chars > 0))
    const usages = p.events.filter((e) => e.kind === 'usage')
    assert.ok(usages.length >= 1)
    const lastUsage = usages.at(-1)!
    assert.equal(lastUsage.kind === 'usage' && lastUsage.usage.outputTokens, 10)
  })

  it('StructuredOutput se nepočítá jako tool call', async () => {
    setup()
    const p = collectProgress()
    const r = await runClaude(
      req('x [[fake:tools 1]]', { schema: { type: 'object', properties: { a: { type: 'string' } } }, onProgress: p.push }),
    )
    assert.equal(r.ok, true)
    assert.equal(r.toolCalls, 1)
    assert.deepEqual(p.events.filter((e) => e.kind === 'tool').map((e) => (e as { name: string }).name), ['Read'])
  })

  it('selhaný pokus (přechodná API chyba) se počítá do usage/cost; agregace přes pokusy', async () => {
    setup()
    const p = collectProgress()
    const r = await runClaude(
      req('x [[fake:apierror-times 1]] [[fake:tokens 100]] [[fake:input 5]] [[fake:cache 7 3]] [[fake:cost 0.5]] [[fake:tools 1]]', {
        onProgress: p.push,
      }),
    )
    assert.equal(r.ok, true)
    assert.equal(r.attempts, 2)
    assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 200, cacheReadTokens: 14, cacheCreationTokens: 6 })
    assert.equal(r.costUsd, 1.0)
    // chybový pokus emituje tool_use PŘED chybou (1) + úspěšný pokus (1)
    assert.equal(r.toolCalls, 2)
    assert.equal(r.numTurns, 4)
    const retry = p.events.find((e) => e.kind === 'retry')
    assert.ok(retry && retry.kind === 'retry' && retry.attempt === 2 && /529|overloaded/i.test(retry.reason))
    const starts = p.events.filter((e) => e.kind === 'start')
    assert.deepEqual(starts.map((s) => (s as { attempt: number }).attempt), [1, 2])
    // průběžné usage je kumulativní přes pokusy (druhý pokus začíná nad 100)
    const outs = p.events.filter((e) => e.kind === 'usage').map((e) => (e as { usage: { outputTokens: number } }).usage.outputTokens)
    assert.ok(Math.max(...outs) === 200)
    assert.deepEqual(outs, [...outs].sort((a, b) => a - b), 'kumulativní usage nesmí klesat')
  })

  it('výjimka v onProgress neshodí runner', async () => {
    setup()
    const r = await runClaude(
      req('x [[fake:tools 1]]', {
        onProgress: () => {
          throw new Error('boom')
        },
      }),
    )
    assert.equal(r.ok, true)
  })
})

describe('runClaude – retry', () => {
  it('fail-times 1 → druhý pokus uspěje', async () => {
    setup()
    const p = collectProgress()
    const r = await runClaude(req('retry [[fake:fail-times 1]]', { onProgress: p.push }))
    assert.equal(r.ok, true)
    assert.equal(r.attempts, 2)
    assert.equal(readLog(sb).length, 2)
    assert.deepEqual(readLog(sb).map((e) => e.attempt), [1, 2])
    assert.ok(p.events.some((e) => e.kind === 'retry'))
    // záznam prvního pokusu je odsunut, stream.jsonl je z posledního
    assert.ok(existsSync(join(sb.outDir, 'stderr.attempt-1.txt')))
    assert.match(readFileSync(join(sb.outDir, 'stderr.attempt-1.txt'), 'utf8'), /simulované selhání/)
    assert.equal(readFileSync(join(sb.outDir, 'stderr.txt'), 'utf8'), '')
    assert.ok(readFileSync(join(sb.outDir, 'stream.jsonl'), 'utf8').includes('"type":"result"'))
  })

  it('fail → ok:false po maxAttempts (default 3), kind exit, bez usage', async () => {
    setup()
    const r = await runClaude(req('vždy padá [[fake:fail]]'))
    assert.equal(r.ok, false)
    assert.equal(r.attempts, 3)
    assert.equal(readLog(sb).length, 3)
    assert.equal(r.error?.kind, 'exit')
    assert.match(r.error!.message, /kódem 1/)
    assert.match(r.error!.message, /simulované selhání/)
    assert.equal(r.text, null)
    assert.equal(r.costUsd, 0)
  })

  it('maxAttempts se respektuje a je zastropováno na 6', async () => {
    setup()
    const r2 = await runClaude(req('a [[fake:fail]]', { maxAttempts: 2 }))
    assert.equal(r2.attempts, 2)
    const r1 = await runClaude(req('b [[fake:fail]]', { maxAttempts: 1 }))
    assert.equal(r1.attempts, 1)
    const r6 = await runClaude(req('c [[fake:fail]]', { maxAttempts: 100 }))
    assert.equal(r6.attempts, 6)
    assert.equal(readLog(sb).length, 2 + 1 + 6)
  })

  it('exit 0 bez result eventu je chyba a opakuje se', async () => {
    setup()
    const r = await runClaude(req('x [[fake:no-result]]', { maxAttempts: 2 }))
    assert.equal(r.ok, false)
    assert.equal(r.attempts, 2)
    assert.equal(r.error?.kind, 'exit')
    assert.match(r.error!.message, /result/)
  })

  it('trvalá API chyba (bez přechodného kódu) se neopakuje', async () => {
    setup()
    const r = await runClaude(req('x [[fake:apierror]] [[fake:tokens 33]]'))
    assert.equal(r.ok, false)
    assert.equal(r.attempts, 1)
    assert.equal(r.error?.kind, 'api')
    assert.equal(r.usage.outputTokens, 33) // utracené tokeny se započítají i při selhání
    assert.equal(readLog(sb).length, 1)
  })

  it('přechodná API chyba 529 se opakuje do maxAttempts', async () => {
    setup()
    const r = await runClaude(req('x [[fake:apierror 529]]'))
    assert.equal(r.ok, false)
    assert.equal(r.attempts, 3)
    assert.equal(r.error?.kind, 'api')
    assert.match(r.error!.message, /529/)
    assert.equal(r.usage.outputTokens, 30)
  })

  it('HTTP 401 se neopakuje', async () => {
    setup()
    const r = await runClaude(req('x [[fake:apierror 401]]'))
    assert.equal(r.attempts, 1)
    assert.equal(r.error?.kind, 'api')
  })

  it('schema: chybí structured_output → kind schema, max 1 další pokus', async () => {
    setup()
    const r = await runClaude(
      req('x [[fake:missing-structured]]', {
        schema: { type: 'object', properties: { a: { type: 'string' } } },
        maxAttempts: 5,
      }),
    )
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'schema')
    assert.equal(r.attempts, 2)
  })

  it('backoff roste s pokusem a je přerušitelný abortem', async () => {
    setup()
    process.env['ULTRACODE_RETRY_BACKOFF_MS'] = '60000'
    const ac = new AbortController()
    const t0 = Date.now()
    const timer = setTimeout(() => ac.abort(), 300)
    const r = await runClaude(req('x [[fake:fail]]', { signal: ac.signal }))
    clearTimeout(timer)
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'aborted')
    assert.equal(r.attempts, 1)
    assert.ok(Date.now() - t0 < 5000, 'abort musí přerušit čekání na backoff')
  })
})

describe('runClaude – stall, timeout, abort, úklid procesů', () => {
  it('stall → zabití a retry; po vyčerpání pokusů kind stall; proces je mrtvý', async () => {
    setup()
    const p = collectProgress()
    const t0 = Date.now()
    const r = await runClaude(req('visí [[fake:stall]]', { stallMs: 150, maxAttempts: 2, onProgress: p.push }))
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'stall')
    assert.equal(r.attempts, 2)
    assert.ok(Date.now() - t0 < 6000)
    const pids = p.events.filter((e) => e.kind === 'start').map((e) => (e as { pid?: number }).pid!)
    assert.equal(pids.length, 2)
    for (const pid of pids) assert.equal(await waitDead(pid), true, `proces ${pid} musí být mrtvý`)
    assert.equal(readLog(sb).length, 2) // SIGTERM handler zapsal oba běhy
  })

  it('stall-times 1 → druhý pokus uspěje', async () => {
    setup()
    const r = await runClaude(req('x [[fake:stall-times 1]]', { stallMs: 200 }))
    assert.equal(r.ok, true)
    assert.equal(r.attempts, 2)
    assert.equal(r.text, 'echo: x')
  })

  it('ticho delší než stallMs = stall; průběžný výstup (i jen stderr) watchdog resetuje', async () => {
    setup()
    // 900 ms ticha při prahu 300 ms → stall
    const quiet = await runClaude(req('x [[fake:sleep 900]]', { stallMs: 300, maxAttempts: 1 }))
    assert.equal(quiet.ok, false)
    assert.equal(quiet.error?.kind, 'stall')
    // celkem ~1000 ms, ale každých 100 ms něco na stderr → práh 300 ms se nesmí překročit
    const alive = await runClaude(req('y [[fake:heartbeat 100 10]]', { stallMs: 300, maxAttempts: 1 }))
    assert.equal(alive.ok, true)
    assert.ok(alive.durationMs >= 900)
  })

  it('timeout je tvrdý limit pokusu a neretryuje se', async () => {
    setup()
    const t0 = Date.now()
    const r = await runClaude(req('pomalý [[fake:sleep 20000]]', { timeoutMs: 300, maxAttempts: 3 }))
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'timeout')
    assert.equal(r.attempts, 1)
    assert.ok(Date.now() - t0 < 5000)
    assert.equal(readLog(sb).length, 1)
  })

  it('abort uprostřed: potomek je opravdu mrtvý, bez retry', async () => {
    setup()
    const ac = new AbortController()
    let pid: number | undefined
    const t0 = Date.now()
    const promise = runClaude(
      req('x [[fake:stall]]', {
        signal: ac.signal,
        maxAttempts: 3,
        onProgress: (e) => {
          if (e.kind === 'start') {
            pid = e.pid
            setTimeout(() => ac.abort(), 150)
          }
        },
      }),
    )
    const r = await promise
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'aborted')
    assert.equal(r.attempts, 1)
    assert.ok(typeof pid === 'number')
    assert.equal(await waitDead(pid!), true)
    assert.ok(Date.now() - t0 < 5000)
    assert.equal(readLog(sb).length, 1)
  })

  it('už přerušený signal: agent se vůbec nespustí', async () => {
    setup()
    const ac = new AbortController()
    ac.abort()
    const r = await runClaude(req('x', { signal: ac.signal }))
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'aborted')
    assert.equal(r.attempts, 0)
    assert.equal(readLog(sb).length, 0)
  })

  it('vedlejší procesy ve skupině jsou zabity při stallu', async () => {
    setup()
    const r = await runClaude(req('x [[fake:child]] [[fake:stall]]', { stallMs: 200, maxAttempts: 1 }))
    assert.equal(r.error?.kind, 'stall')
    const childPid = childPidFromStream(sb.outDir)
    assert.ok(typeof childPid === 'number')
    assert.equal(await waitDead(childPid!), true, 'potomek (sleep) musí být zabit společně s vedoucím')
  })

  it('vedlejší procesy držící roury po normálním konci nezablokují runner a jsou zabity', async () => {
    setup()
    const t0 = Date.now()
    const r = await runClaude(req('x [[fake:child]] [[fake:text hotovo]]'))
    assert.equal(r.ok, true)
    assert.equal(r.text, 'hotovo')
    assert.ok(Date.now() - t0 < 8000, 'nesmí čekat na sleep 600')
    const childPid = childPidFromStream(sb.outDir)
    assert.ok(typeof childPid === 'number')
    assert.equal(await waitDead(childPid!), true)
  })

  it('proces ignorující SIGTERM je po grace periodě zabit SIGKILLem', async () => {
    setup()
    const p = collectProgress()
    const t0 = Date.now()
    const r = await runClaude(req('x [[fake:stall]] [[fake:ignore-term]] [[fake:child]]', { stallMs: 150, maxAttempts: 1, onProgress: p.push }))
    assert.equal(r.error?.kind, 'stall')
    assert.ok(Date.now() - t0 < 8000)
    const pid = (p.events.find((e) => e.kind === 'start') as { pid: number }).pid
    assert.equal(await waitDead(pid), true)
    const childPid = childPidFromStream(sb.outDir)
    assert.equal(await waitDead(childPid!), true)
  })

  it('proces visící po result eventu je po grace periodě ukončen a výsledek platí', async () => {
    setup()
    process.env['ULTRACODE_RESULT_GRACE_MS'] = '200'
    const p = collectProgress()
    const r = await runClaude(req('x [[fake:hang-after-result]] [[fake:text ok]]', { onProgress: p.push }))
    assert.equal(r.ok, true)
    assert.equal(r.text, 'ok')
    const pid = (p.events.find((e) => e.kind === 'start') as { pid: number }).pid
    assert.equal(await waitDead(pid), true)
  })

  it('po úspěšném běhu nezůstane žádný proces', async () => {
    setup()
    const p = collectProgress()
    const r = await runClaude(req('x', { onProgress: p.push }))
    assert.equal(r.ok, true)
    const pid = (p.events.find((e) => e.kind === 'start') as { pid: number }).pid
    assert.equal(isAlive(pid), false)
  })
})

describe('runClaude – úklid při ukončení rodiče', () => {
  it('když host skončí bez abortu, agent i jeho potomek jsou zabiti v exit hooku', async () => {
    setup()
    const host = join(FIXTURES, 'orphan-host.ts')
    const res = spawnSync(process.execPath, [host], {
      env: { ...process.env, ORPHAN_CWD: sb.cwd, ORPHAN_OUT: sb.outDir },
      encoding: 'utf8',
      timeout: 20_000,
    })
    assert.equal(res.status, 0, res.stderr)
    const m = /PID (\d+)/.exec(res.stdout)
    assert.ok(m, 'host musí vypsat pid agenta')
    const pid = Number(m![1])
    assert.equal(await waitDead(pid), true, 'agent musí být zabit')
    const childPid = childPidFromStream(sb.outDir)
    assert.ok(typeof childPid === 'number')
    assert.equal(await waitDead(childPid!), true, 'potomek agenta musí být zabit')
  })
})

describe('runClaude – odolnost proti špatnému výstupu', () => {
  it('poslední řádek bez \\n je dočten a zpracován', async () => {
    setup()
    const r = await runClaude(req('x [[fake:no-newline]] [[fake:text bez nového řádku]]'))
    assert.equal(r.ok, true)
    assert.equal(r.text, 'bez nového řádku')
    const raw = readFileSync(join(sb.outDir, 'stream.jsonl'), 'utf8')
    assert.ok(raw.includes('bez nového řádku'))
  })

  it('nevalidní JSON řádky se ignorují, zůstanou v surovém stream.jsonl', async () => {
    setup()
    const r = await runClaude(req('x [[fake:garbage]] [[fake:tools 1]]'))
    assert.equal(r.ok, true)
    assert.equal(r.toolCalls, 1)
    const raw = readFileSync(join(sb.outDir, 'stream.jsonl'), 'utf8')
    assert.ok(raw.includes('tohle neni json {'))
  })
})

describe('runClaude – spuštění', () => {
  it('neexistující binárka → kind spawn, bez retry', async () => {
    setup()
    process.env['ULTRACODE_CLAUDE_BIN'] = join(sb.root, 'neexistuje-claude')
    const r = await runClaude(req('x'))
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'spawn')
    assert.equal(r.attempts, 1)
    assert.match(r.error!.message, /neexistuje|Nelze spustit/)
  })

  it('neexistující cwd → kind spawn', async () => {
    setup()
    const r = await runClaude(req('x', { cwd: join(sb.root, 'nikde') }))
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'spawn')
    assert.match(r.error!.message, /nikde/)
  })

  it('prázdný prompt → kind spawn, claude se nespustí', async () => {
    setup()
    const r = await runClaude(req('   '))
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'spawn')
    assert.equal(readLog(sb).length, 0)
  })
})
