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
  claudeArgsOf,
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
  // restore the environment to its original state and clean up
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
  Object.assign(process.env, savedEnv)
  sb?.cleanup()
})

describe('runClaude – basic run', () => {
  it('text result + artifacts in outDir', async () => {
    setup()
    const r = await runClaude(req('Say hello [[fake:tokens 42]] [[fake:cost 0.02]]'))
    assert.equal(r.ok, true)
    assert.equal(r.text, 'echo: Say hello')
    assert.equal(r.structured, null)
    assert.equal(r.attempts, 1)
    assert.equal(r.error, undefined)
    assert.equal(r.usage.outputTokens, 42)
    assert.equal(r.costUsd, 0.02)
    assert.equal(r.numTurns, 1)
    assert.ok(typeof r.sessionId === 'string' && r.sessionId.length > 0)
    assert.ok(r.durationMs >= 0)

    // artefakty
    assert.equal(readFileSync(join(sb.outDir, 'prompt.txt'), 'utf8'), 'Say hello [[fake:tokens 42]] [[fake:cost 0.02]]')
    const stream = readFileSync(join(sb.outDir, 'stream.jsonl'), 'utf8').trim().split('\n')
    assert.ok(stream.length >= 3)
    assert.equal(JSON.parse(stream[0]!).type, 'session')
    assert.equal(JSON.parse(stream.at(-1)!).type, 'result')
    assert.ok(existsSync(join(sb.outDir, 'stderr.txt')))
    const saved = JSON.parse(readFileSync(join(sb.outDir, 'result.json'), 'utf8'))
    assert.deepEqual(saved, JSON.parse(JSON.stringify(r)))
  })

  it('schema: structured from the json directive; text is its JSON', async () => {
    setup()
    const schema = { type: 'object', properties: { n: { type: 'number' }, tags: { type: 'array' } }, required: ['n'] }
    const r = await runClaude(req('return data [[fake:json {"n":7,"tags":[["a"]]}]]', { schema }))
    assert.equal(r.ok, true)
    assert.deepEqual(r.structured, { n: 7, tags: [['a']] })
    assert.equal(r.text, '{"n":7,"tags":[["a"]]}')
    assert.equal(argOf(claudeArgsOf(readLog(sb)[0]!.args), '--json-schema'), JSON.stringify(schema))
  })

  it('schema without directive: minimal object according to the schema', async () => {
    setup()
    const schema = {
      type: 'object',
      properties: { s: { type: 'string' }, n: { type: 'number' }, b: { type: 'boolean' }, a: { type: 'array' }, o: { type: 'object' } },
    }
    const r = await runClaude(req('x', { schema }))
    assert.equal(r.ok, true)
    assert.deepEqual(r.structured, { s: 'x', n: 1, b: true, a: [], o: {} })
  })

  it('large output with multibyte characters across chunk boundaries', async () => {
    setup()
    const big = 'řa'.repeat(150_000) // ~450 kB, chunk boundaries fall in the middle of a character
    const r = await runClaude(req(`[[fake:text ${big}]]`))
    assert.equal(r.ok, true)
    assert.equal(r.text, big)
  })

  it('process stderr is written to stderr.txt', async () => {
    setup()
    const r = await runClaude(req('x [[fake:stderr warning from claude]]'))
    assert.equal(r.ok, true)
    assert.match(readFileSync(join(sb.outDir, 'stderr.txt'), 'utf8'), /warning from claude/)
  })

  it('concurrent calls do not block each other', async () => {
    setup()
    const runs = await Promise.all(
      [1, 2, 3, 4].map((i) => runClaude({ ...req(`parallel ${i} [[fake:sleep 400]]`), outDir: join(sb.root, `out${i}`) })),
    )
    assert.ok(runs.every((r) => r.ok))
    const log = readLog(sb)
    assert.equal(log.length, 4)
    const maxStart = Math.max(...log.map((e) => Date.parse(e.startedAt)))
    const minEnd = Math.min(...log.map((e) => Date.parse(e.endedAt)))
    assert.ok(maxStart < minEnd, 'all runs had to overlap')
  })
})

describe('runClaude – arguments and environment', () => {
  it('argv: Workflow disabled, bypassPermissions, model, effort, schema, system prompt, budget', async () => {
    setup()
    const schema = { type: 'object', properties: { a: { type: 'string' } } }
    const r = await runClaude(
      req('x', {
        model: 'haiku',
        effort: 'low',
        schema,
        appendSystemPrompt: 'Speak English only.',
        disallowedTools: ['WebFetch', 'Workflow'],
        allowedTools: ['Read', 'Bash(git diff:*)'],
        maxBudgetUsd: 0.5,
        extraArgs: ['--add-dir', '/tmp'],
      }),
    )
    assert.equal(r.ok, true)
    const { args, cwd } = readLog(sb)[0]!
    const claude = claudeArgsOf(args)
    assert.equal(argOf(args, '--adapter'), 'claude')
    assert.ok(args.includes('--json'))
    assert.ok(claude.includes('--no-session-persistence'))
    assert.equal(argOf(args, '--permission-mode'), 'bypassPermissions')
    assert.equal(argOf(args, '--disallowed-tools'), 'Workflow,WebFetch')
    assert.equal(argOf(claude, '--allowedTools'), 'Read,Bash(git diff:*)')
    assert.equal(argOf(args, '--model'), 'haiku')
    assert.equal(argOf(args, '--effort'), 'low')
    assert.equal(argOf(claude, '--max-budget-usd'), '0.5')
    assert.equal(argOf(claude, '--add-dir'), '/tmp')
    const sys = argOf(claude, '--append-system-prompt')!
    assert.ok(sys.startsWith(DEFAULT_SUBAGENT_SYSTEM_PROMPT))
    assert.ok(sys.endsWith('Speak English only.'))
    assert.equal(cwd, sb.cwd.replace(/^\/private/, ''))
    // prompt never in argv, goes via stdin
    assert.ok(!args.includes('x'))
  })

  it('default system prompt is present even without appendSystemPrompt; custom permissionMode', async () => {
    setup()
    await runClaude(req('x', { permissionMode: 'dontAsk' }))
    const { args } = readLog(sb)[0]!
    const claude = claudeArgsOf(args)
    assert.equal(argOf(claude, '--append-system-prompt'), DEFAULT_SUBAGENT_SYSTEM_PROMPT)
    assert.equal(argOf(args, '--permission-mode'), 'dontAsk')
    assert.equal(argOf(args, '--disallowed-tools'), 'Workflow')
    assert.ok(!claude.includes('--allowedTools'))
    assert.ok(!claude.includes('--json-schema'))
    assert.ok(!args.includes('--model'))
  })

  it('env: CLAUDE_CODE_DISABLE_WORKFLOWS=1 always (even against req.env), custom env passes through', async () => {
    setup()
    await runClaude(req('x', { env: { CLAUDE_CODE_DISABLE_WORKFLOWS: '0', ULTRACODE_TEST_ENV: 'value' } }))
    const { env } = readLog(sb)[0]!
    assert.equal(env.CLAUDE_CODE_DISABLE_WORKFLOWS, '1')
    assert.equal(env.ULTRACODE_TEST_ENV, 'value')
  })

  it('env: AGENTISCODE_DIE_WITH_PARENT=1 by default, can be turned off', async () => {
    setup()
    await runClaude(req('x'))
    await runClaude(req('y', { env: { AGENTISCODE_DIE_WITH_PARENT: '0' } }))
    const [on, off] = readLog(sb)
    assert.equal(on!.env.AGENTISCODE_DIE_WITH_PARENT, '1')
    assert.equal(off!.env.AGENTISCODE_DIE_WITH_PARENT, '0')
  })

  it('req.bin takes precedence over env ULTRACODE_CLAUDE_BIN (and changes nothing in process.env)', async () => {
    setup()
    const real = process.env['ULTRACODE_CLAUDE_BIN']
    process.env['ULTRACODE_CLAUDE_BIN'] = '/nonexistent/claude'
    const r = await runClaude(req('x', { bin: real }))
    assert.equal(r.ok, true, r.error?.message)
    assert.equal(process.env['ULTRACODE_CLAUDE_BIN'], '/nonexistent/claude')
    assert.equal(readLog(sb).length, 1)
  })

  it('agent cwd = req.cwd', async () => {
    setup()
    await runClaude(req('x'))
    assert.equal(readLog(sb)[0]!.cwd, sb.cwd)
  })
})

describe('runClaude – progress and aggregation', () => {
  it('tool progress, start with pid, text and usage', async () => {
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

  it('StructuredOutput is not counted as a tool call', async () => {
    setup()
    const p = collectProgress()
    const r = await runClaude(
      req('x [[fake:tools 1]]', { schema: { type: 'object', properties: { a: { type: 'string' } } }, onProgress: p.push }),
    )
    assert.equal(r.ok, true)
    assert.equal(r.toolCalls, 1)
    assert.deepEqual(p.events.filter((e) => e.kind === 'tool').map((e) => (e as { name: string }).name), ['Read'])
  })

  it('failed attempt (transient API error) is counted in usage/cost; aggregation across attempts', async () => {
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
    // the failed attempt emits tool_use BEFORE the error (1) + the successful attempt (1)
    assert.equal(r.toolCalls, 2)
    assert.equal(r.numTurns, 4)
    const retry = p.events.find((e) => e.kind === 'retry')
    assert.ok(retry && retry.kind === 'retry' && retry.attempt === 2 && /529|overloaded/i.test(retry.reason))
    const starts = p.events.filter((e) => e.kind === 'start')
    assert.deepEqual(starts.map((s) => (s as { attempt: number }).attempt), [1, 2])
    // running usage is cumulative across attempts (the second attempt starts above 100)
    const outs = p.events.filter((e) => e.kind === 'usage').map((e) => (e as { usage: { outputTokens: number } }).usage.outputTokens)
    assert.ok(Math.max(...outs) === 200)
    assert.deepEqual(outs, [...outs].sort((a, b) => a - b), 'cumulative usage must not decrease')
  })

  it('exception in onProgress does not crash the runner', async () => {
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

describe('runClaude – agent event stream', () => {
  it('every parsed agentiscode event is forwarded with the attempt number', async () => {
    setup()
    const p = collectProgress()
    const r = await runClaude(req('stream [[fake:fail-times 1]] [[fake:tools 1]]', { onProgress: p.push }))
    assert.equal(r.ok, true)
    const evs = p.events.filter((e) => e.kind === 'event')
    const byAttempt = (n: number) => evs.filter((e) => e.attempt === n).map((e) => e.event.type)
    assert.deepEqual(byAttempt(1), ['session', 'stderr', 'error', 'result'])
    assert.equal(byAttempt(2)[0], 'session')
    assert.equal(byAttempt(2).at(-1), 'result')
    assert.ok(byAttempt(2).includes('tool'))
  })

  it('agentiscode banner stays in stderr.txt but not in error messages', async () => {
    setup()
    const r = await runClaude(req('x [[fake:fail]]', { maxAttempts: 1 }))
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'exit')
    assert.match(r.error!.message, /simulated failure/)
    assert.doesNotMatch(r.error!.message, /\[agentiscode\] command/)
    assert.match(readFileSync(join(sb.outDir, 'stderr.txt'), 'utf8'), /\[agentiscode\] command/)
  })
})

describe('runClaude – retry', () => {
  it('fail-times 1 → second attempt succeeds', async () => {
    setup()
    const p = collectProgress()
    const r = await runClaude(req('retry [[fake:fail-times 1]]', { onProgress: p.push }))
    assert.equal(r.ok, true)
    assert.equal(r.attempts, 2)
    assert.equal(readLog(sb).length, 2)
    assert.deepEqual(readLog(sb).map((e) => e.attempt), [1, 2])
    assert.ok(p.events.some((e) => e.kind === 'retry'))
    // the first attempt's record is moved aside, stream.jsonl is from the last one
    assert.ok(existsSync(join(sb.outDir, 'stderr.attempt-1.txt')))
    assert.match(readFileSync(join(sb.outDir, 'stderr.attempt-1.txt'), 'utf8'), /simulated failure/)
    assert.doesNotMatch(readFileSync(join(sb.outDir, 'stderr.txt'), 'utf8'), /simulated failure/)
    assert.ok(readFileSync(join(sb.outDir, 'stream.jsonl'), 'utf8').includes('"type":"result"'))
  })

  it('fail → ok:false after maxAttempts (default 3), kind exit, no usage', async () => {
    setup()
    const r = await runClaude(req('always fails [[fake:fail]]'))
    assert.equal(r.ok, false)
    assert.equal(r.attempts, 3)
    assert.equal(readLog(sb).length, 3)
    assert.equal(r.error?.kind, 'exit')
    assert.match(r.error!.message, /code 1/)
    assert.match(r.error!.message, /simulated failure/)
    assert.equal(r.text, null)
    assert.equal(r.costUsd, 0)
  })

  it('maxAttempts is respected and capped at 6', async () => {
    setup()
    const r2 = await runClaude(req('a [[fake:fail]]', { maxAttempts: 2 }))
    assert.equal(r2.attempts, 2)
    const r1 = await runClaude(req('b [[fake:fail]]', { maxAttempts: 1 }))
    assert.equal(r1.attempts, 1)
    const r6 = await runClaude(req('c [[fake:fail]]', { maxAttempts: 100 }))
    assert.equal(r6.attempts, 6)
    assert.equal(readLog(sb).length, 2 + 1 + 6)
  })

  it('exit 0 without a result event is an error and is retried', async () => {
    setup()
    const r = await runClaude(req('x [[fake:no-result]]', { maxAttempts: 2 }))
    assert.equal(r.ok, false)
    assert.equal(r.attempts, 2)
    assert.equal(r.error?.kind, 'exit')
    assert.match(r.error!.message, /result/)
  })

  it('permanent API error (without transient code) is not retried', async () => {
    setup()
    const r = await runClaude(req('x [[fake:apierror]] [[fake:tokens 33]]'))
    assert.equal(r.ok, false)
    assert.equal(r.attempts, 1)
    assert.equal(r.error?.kind, 'api')
    assert.equal(r.usage.outputTokens, 33) // spent tokens are counted even on failure
    assert.equal(readLog(sb).length, 1)
  })

  it('transient API error 529 is retried up to maxAttempts', async () => {
    setup()
    const r = await runClaude(req('x [[fake:apierror 529]]'))
    assert.equal(r.ok, false)
    assert.equal(r.attempts, 3)
    assert.equal(r.error?.kind, 'api')
    assert.match(r.error!.message, /529/)
    assert.equal(r.usage.outputTokens, 30)
  })

  it('HTTP 401 is not retried', async () => {
    setup()
    const r = await runClaude(req('x [[fake:apierror 401]]'))
    assert.equal(r.attempts, 1)
    assert.equal(r.error?.kind, 'api')
  })

  it('schema: structured_output missing → kind schema, max 1 more attempt', async () => {
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

  it('backoff grows with the attempt and is interruptible by abort', async () => {
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
    assert.ok(Date.now() - t0 < 5000, 'abort must interrupt the backoff wait')
  })
})

describe('runClaude – stall, timeout, abort, process cleanup', () => {
  it('stall → kill and retry; after the attempts are exhausted kind stall; the process is dead', async () => {
    setup()
    const p = collectProgress()
    const t0 = Date.now()
    const r = await runClaude(req('hangs [[fake:stall]]', { stallMs: 150, maxAttempts: 2, onProgress: p.push }))
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'stall')
    assert.equal(r.attempts, 2)
    assert.ok(Date.now() - t0 < 6000)
    const pids = p.events.filter((e) => e.kind === 'start').map((e) => (e as { pid?: number }).pid!)
    assert.equal(pids.length, 2)
    for (const pid of pids) assert.equal(await waitDead(pid), true, `process ${pid} must be dead`)
    assert.equal(readLog(sb).length, 2) // SIGTERM handler wrote both runs
  })

  it('stall-times 1 → second attempt succeeds', async () => {
    setup()
    const r = await runClaude(req('x [[fake:stall-times 1]]', { stallMs: 200 }))
    assert.equal(r.ok, true)
    assert.equal(r.attempts, 2)
    assert.equal(r.text, 'echo: x')
  })

  it('silence longer than stallMs = stall; running output (even just stderr) resets the watchdog', async () => {
    setup()
    // 900 ms of silence with a 300 ms threshold → stall
    const quiet = await runClaude(req('x [[fake:sleep 900]]', { stallMs: 300, maxAttempts: 1 }))
    assert.equal(quiet.ok, false)
    assert.equal(quiet.error?.kind, 'stall')
    // ~1000 ms in total, but something on stderr every 100 ms → the 300 ms threshold must not be exceeded
    const alive = await runClaude(req('y [[fake:heartbeat 100 10]]', { stallMs: 300, maxAttempts: 1 }))
    assert.equal(alive.ok, true)
    assert.ok(alive.durationMs >= 900)
  })

  it('timeout is a hard limit of the attempt and is not retried', async () => {
    setup()
    const t0 = Date.now()
    const r = await runClaude(req('slow [[fake:sleep 20000]]', { timeoutMs: 300, maxAttempts: 3 }))
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'timeout')
    assert.equal(r.attempts, 1)
    assert.ok(Date.now() - t0 < 5000)
    assert.equal(readLog(sb).length, 1)
  })

  it('abort mid-run: the child is really dead, no retry', async () => {
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

  it('already aborted signal: agent is not started at all', async () => {
    setup()
    const ac = new AbortController()
    ac.abort()
    const r = await runClaude(req('x', { signal: ac.signal }))
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'aborted')
    assert.equal(r.attempts, 0)
    assert.equal(readLog(sb).length, 0)
  })

  it('side processes in the group are killed on stall', async () => {
    setup()
    const r = await runClaude(req('x [[fake:child]] [[fake:stall]]', { stallMs: 200, maxAttempts: 1 }))
    assert.equal(r.error?.kind, 'stall')
    const childPid = childPidFromStream(sb.outDir)
    assert.ok(typeof childPid === 'number')
    assert.equal(await waitDead(childPid!), true, 'child (sleep) must be killed together with the leader')
  })

  it('side processes holding pipes after a normal end do not block the runner and are killed', async () => {
    setup()
    const t0 = Date.now()
    const r = await runClaude(req('x [[fake:child]] [[fake:text done]]'))
    assert.equal(r.ok, true)
    assert.equal(r.text, 'done')
    assert.ok(Date.now() - t0 < 8000, 'must not wait for sleep 600')
    const childPid = childPidFromStream(sb.outDir)
    assert.ok(typeof childPid === 'number')
    assert.equal(await waitDead(childPid!), true)
  })

  it('process ignoring SIGTERM is killed with SIGKILL after the grace period', async () => {
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

  it('process hanging after the result event is terminated after the grace period and the result stands', async () => {
    setup()
    process.env['ULTRACODE_RESULT_GRACE_MS'] = '200'
    const p = collectProgress()
    const r = await runClaude(req('x [[fake:hang-after-result]] [[fake:text ok]]', { onProgress: p.push }))
    assert.equal(r.ok, true)
    assert.equal(r.text, 'ok')
    const pid = (p.events.find((e) => e.kind === 'start') as { pid: number }).pid
    assert.equal(await waitDead(pid), true)
  })

  it('no process remains after a successful run', async () => {
    setup()
    const p = collectProgress()
    const r = await runClaude(req('x', { onProgress: p.push }))
    assert.equal(r.ok, true)
    const pid = (p.events.find((e) => e.kind === 'start') as { pid: number }).pid
    assert.equal(isAlive(pid), false)
  })
})

describe('runClaude – cleanup when the parent exits', () => {
  it('when the host exits without abort, the agent and its child are killed in the exit hook', async () => {
    setup()
    const host = join(FIXTURES, 'orphan-host.ts')
    const res = spawnSync(process.execPath, [host], {
      env: { ...process.env, ORPHAN_CWD: sb.cwd, ORPHAN_OUT: sb.outDir },
      encoding: 'utf8',
      timeout: 20_000,
    })
    assert.equal(res.status, 0, res.stderr)
    const m = /PID (\d+)/.exec(res.stdout)
    assert.ok(m, 'host must print the agent pid')
    const pid = Number(m![1])
    assert.equal(await waitDead(pid), true, 'agent must be killed')
    const childPid = childPidFromStream(sb.outDir)
    assert.ok(typeof childPid === 'number')
    assert.equal(await waitDead(childPid!), true, 'agent child must be killed')
  })
})

describe('runClaude – resilience to bad output', () => {
  it('last line without \\n is read and processed', async () => {
    setup()
    const r = await runClaude(req('x [[fake:no-newline]] [[fake:text without newline]]'))
    assert.equal(r.ok, true)
    assert.equal(r.text, 'without newline')
    const raw = readFileSync(join(sb.outDir, 'stream.jsonl'), 'utf8')
    assert.ok(raw.includes('without newline'))
  })

  it('invalid JSON lines are ignored, but stay in the raw stream.jsonl', async () => {
    setup()
    const r = await runClaude(req('x [[fake:garbage]] [[fake:tools 1]]'))
    assert.equal(r.ok, true)
    assert.equal(r.toolCalls, 1)
    const raw = readFileSync(join(sb.outDir, 'stream.jsonl'), 'utf8')
    assert.ok(raw.includes('this is not json {'))
  })
})

describe('runClaude – start', () => {
  it('nonexistent binary → kind spawn, no retry', async () => {
    setup()
    process.env['ULTRACODE_CLAUDE_BIN'] = join(sb.root, 'nonexistent-claude')
    const r = await runClaude(req('x'))
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'spawn')
    assert.equal(r.attempts, 1)
    assert.match(r.error!.message, /does not exist|Cannot start/)
  })

  it('nonexistent cwd → kind spawn', async () => {
    setup()
    const r = await runClaude(req('x', { cwd: join(sb.root, 'nowhere') }))
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'spawn')
    assert.match(r.error!.message, /nowhere/)
  })

  it('empty prompt → kind spawn, claude is not started', async () => {
    setup()
    const r = await runClaude(req('   '))
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'spawn')
    assert.equal(readLog(sb).length, 0)
  })
})
