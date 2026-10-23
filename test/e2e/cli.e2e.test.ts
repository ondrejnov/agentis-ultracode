/**
 * E2E: real process `node bin/ultracode.mjs …` + real engine, script host and runner on top of fake-claude.
 * Verifies the behaviour from the user's/Agentis' point of view: stdout = JSON, exit codes, run directory, resume after a kill,
 * budget, validation and the concurrency limit (from the fake-claude log).
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, it } from 'node:test'

const ROOT = resolve(import.meta.dirname, '..', '..')
const BIN = join(ROOT, 'bin', 'ultracode.mjs')
const FAKE = join(ROOT, 'test', 'fixtures', 'fake-claude.mjs')

// ───────────────────────── helpers ─────────────────────────

/** `run --json` stdout is a JSON Lines stream; the last line is `{"t":"summary","summary":{…}}`. */
function summaryOf(stdout: string): any {
  const last = JSON.parse(stdout.trim().split('\n').at(-1)!)
  assert.equal(last.t, 'summary')
  return last.summary
}

interface Sandbox {
  cwd: string
  log: string
  state: string
  env: NodeJS.ProcessEnv
  script(name: string, content: string): string
}

const sandboxes: string[] = []

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'ultracode-e2e-'))
  sandboxes.push(root)
  const log = join(root, 'fake.log')
  const state = join(root, 'state')
  const cwd = join(root, 'proj')
  mkdirSync(cwd, { recursive: true })
  return {
    cwd,
    log,
    state,
    env: {
      ...process.env,
      ULTRACODE_CLAUDE_BIN: FAKE,
      FAKE_CLAUDE_LOG: log,
      FAKE_CLAUDE_STATE_DIR: state,
      ULTRACODE_RETRY_BACKOFF_MS: '5',
      ULTRACODE_KILL_GRACE_MS: '500',
      NO_COLOR: '1',
      // e2e tests the current sources, not a possibly older dist/ (dist is tested separately)
      ULTRACODE_FORCE_SRC: '1',
    },
    script(name, content) {
      const dir = join(cwd, '.ultracode', 'workflows')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, name)
      writeFileSync(file, content)
      return file
    },
  }
}

afterEach(() => {
  while (sandboxes.length > 0) {
    const d = sandboxes.pop()!
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

interface Finished {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

interface Running {
  child: ReturnType<typeof spawn>
  done: Promise<Finished>
}

function start(sb: Sandbox, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Running {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: sb.cwd,
    env: { ...sb.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', (c: Buffer) => (stdout += c.toString()))
  child.stderr!.on('data', (c: Buffer) => (stderr += c.toString()))
  const done = new Promise<Finished>((res, rej) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL')
      rej(new Error(`ultracode ${args.join(' ')} did not finish in time.\nstderr:\n${stderr}`))
    }, 60_000)
    child.on('close', (code, signal) => {
      clearTimeout(t)
      res({ code, signal, stdout, stderr })
    })
  })
  return { child, done }
}

async function run(sb: Sandbox, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<Finished> {
  return start(sb, args, extraEnv).done
}

interface FakeLog {
  pid: number
  startedAt: string
  endedAt: string
  args: string[]
  cwd: string
  prompt: string
  env: { CLAUDE_CODE_DISABLE_WORKFLOWS: string | null; IS_SANDBOX?: string | null }
  attempt: number
}

function readFakeLog(sb: Sandbox): FakeLog[] {
  if (!existsSync(sb.log)) return []
  return readFileSync(sb.log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FakeLog)
}

function readJsonl<T = any>(file: string): T[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T)
}

function readJson<T = any>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

function runDirs(sb: Sandbox): string[] {
  const root = join(sb.cwd, '.ultracode', 'runs')
  if (!existsSync(root)) return []
  return readdirSync(root).map((d) => join(root, d))
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Timeout waiting for: ${what}`)
}

/** Maximum number of concurrently running fake-claude processes according to [startedAt, endedAt]. */
function maxOverlap(entries: FakeLog[]): number {
  const points: Array<[number, number]> = []
  for (const e of entries) {
    points.push([Date.parse(e.startedAt), 1])
    points.push([Date.parse(e.endedAt), -1])
  }
  // at the same time the end (-1) comes first, so the overlap is not overestimated
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let cur = 0
  let max = 0
  for (const [, d] of points) {
    cur += d
    if (cur > max) max = cur
  }
  return max
}

const SCHEMA_VALUE = `{ type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }`

// ───────────────────────── tests ─────────────────────────

describe('e2e: ultracode run', () => {
  it('successful pipeline run: JSON stdout, exit 0, complete run directory', async () => {
    const sb = makeSandbox()
    sb.script(
      'pipe.workflow.ts',
      `export const meta = {
  name: 'pipe',
  description: 'e2e pipeline',
  phases: [{ title: 'Analysis' }, { title: 'Fix' }],
}
phase('Analysis')
const files: string[] = args.files
log('files: ' + files.length)
const out = await pipeline(
  files,
  (f: string) => agent('Analyze ' + f + ' [[fake:json {"value":"analysis-' + f + '"}]]', { label: 'analysis ' + f, phase: 'Analysis', schema: ${SCHEMA_VALUE} }),
  (a: { value: string } | null, f: string) =>
    agent('Fix ' + f + ' per ' + (a ? a.value : 'nothing') + ' [[fake:text fixed-' + f + ']]', { label: 'fix ' + f, phase: 'Fix' }),
)
return { fixed: out, spent: budget.spent() }
`,
    )
    const r = await run(sb, ['run', 'pipe', '--cwd', sb.cwd, '--args', '{"files":["a.php","b.php","c.php"]}', '--concurrency', '2'])
    assert.equal(r.code, 0, r.stderr)

    // stdout = pure JSON result of the script; progress is on stderr only
    const result = JSON.parse(r.stdout)
    assert.deepEqual(result.fixed, ['fixed-a.php', 'fixed-b.php', 'fixed-c.php'])
    assert.equal(typeof result.spent, 'number')
    assert.match(r.stderr, /Analysis/)
    assert.match(r.stderr, /files: 3/)

    // run directory
    const dirs = runDirs(sb)
    assert.equal(dirs.length, 1)
    const dir = dirs[0]
    for (const f of ['run.json', 'script.ts', 'args.json', 'options.json', 'events.jsonl', 'journal.jsonl', 'result.json']) {
      assert.ok(existsSync(join(dir, f)), `missing ${f}`)
    }
    const runJson = readJson(join(dir, 'run.json'))
    assert.equal(runJson.status, 'completed')
    assert.equal(runJson.name, 'pipe')
    assert.equal(runJson.runId, dir.split('/').pop())
    assert.match(runJson.runId, /^wf_[0-9a-f]{8}-[0-9a-f]{3}$/)
    assert.equal(runJson.totals.agents, 6)
    assert.equal(runJson.totals.failedAgents, 0)
    assert.equal(runJson.totals.cachedAgents, 0)
    assert.deepEqual(readJson(join(dir, 'result.json')), result)
    assert.deepEqual(readJson(join(dir, 'args.json')), { files: ['a.php', 'b.php', 'c.php'] })

    const events = readJsonl(join(dir, 'events.jsonl'))
    assert.equal(events[0].t, 'run_start')
    assert.equal(events.at(-1).t, 'run_end')
    assert.equal(events.at(-1).status, 'completed')
    const starts = events.filter((e) => e.t === 'agent_start')
    const dones = events.filter((e) => e.t === 'agent_done')
    assert.equal(starts.length, 6)
    assert.equal(dones.length, 6)
    assert.ok(dones.every((e) => e.ok === true && e.cached === false))
    assert.deepEqual(
      [...new Set(starts.map((e) => e.phase))].sort(),
      ['Analysis', 'Fix'],
    )
    assert.equal(events.filter((e) => e.t === 'phase').length, 1)

    const journal = readJsonl(join(dir, 'journal.jsonl'))
    assert.equal(journal.length, 6)
    assert.ok(journal.every((j) => j.ok === true && typeof j.key === 'string'))

    for (let id = 1; id <= 6; id++) {
      const ad = join(dir, 'agents', String(id))
      for (const f of ['prompt.txt', 'stream.jsonl', 'result.json']) assert.ok(existsSync(join(ad, f)), `agents/${id}/${f}`)
    }
    const agentResult = readJson(join(dir, 'agents', '1', 'result.json'))
    assert.equal(agentResult.ok, true)

    // how agentiscode was called: isolation from recursive workflows, bypass, schema, cwd
    const log = readFakeLog(sb)
    assert.equal(log.length, 6)
    for (const e of log) {
      assert.equal(e.env.CLAUDE_CODE_DISABLE_WORKFLOWS, '1')
      assert.equal(e.cwd, sb.cwd)
      assert.equal(e.args[e.args.indexOf('--adapter') + 1], 'claude')
      assert.ok(e.args.includes('--json'))
      assert.equal(e.env.IS_SANDBOX, '1')
      assert.ok(!e.args.includes('--permission-mode'))
      assert.match(e.args[e.args.indexOf('--disallowed-tools') + 1], /(^|,)Workflow(,|$)/)
    }
    const claudeArgs = (e: { args: string[] }) => JSON.parse(e.args[e.args.indexOf('--extra-args-json') + 1]!) as string[]
    assert.equal(log.filter((e) => claudeArgs(e).includes('--json-schema')).length, 3)

    // dependency: the fix received the analysis result in its prompt
    assert.ok(log.some((e) => e.prompt.includes('Fix b.php per analysis-b.php')))
  })

  it('agent failure → null in the result, run completed, failure in totals; other agents unaffected', async () => {
    const sb = makeSandbox()
    sb.script(
      'fail.workflow.ts',
      `export const meta = { name: 'fail', description: 'one agent fails' }
const r = await parallel([
  () => agent('Good agent [[fake:text ok]]', { label: 'good' }),
  () => agent('Bad agent [[fake:fail]]', { label: 'bad' }),
])
return { r, nullCount: r.filter((x: unknown) => x === null).length }
`,
    )
    const r = await run(sb, ['run', 'fail', '--cwd', sb.cwd])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { r: ['ok', null], nullCount: 1 })

    const dir = runDirs(sb)[0]
    const runJson = readJson(join(dir, 'run.json'))
    assert.equal(runJson.status, 'completed')
    assert.equal(runJson.totals.agents, 2)
    assert.equal(runJson.totals.failedAgents, 1)

    // only the successful agent belongs to the journal (a failure is repeated on resume)
    assert.equal(readJsonl(join(dir, 'journal.jsonl')).length, 1)
    const failed = readJsonl(join(dir, 'events.jsonl')).filter((e) => e.t === 'agent_done' && e.ok === false)
    assert.equal(failed.length, 1)
    assert.match(String(failed[0].error), /exit/)

    // runner retried the bad agent repeatedly (retry), the good one only once
    const log = readFakeLog(sb)
    assert.equal(log.filter((e) => e.prompt.includes('Good agent')).length, 1)
    assert.equal(log.filter((e) => e.prompt.includes('Bad agent')).length, 3)
  })

  it('resume after a killed run (SIGTERM): finished agents from cache, only the rest runs', async () => {
    const sb = makeSandbox()
    sb.script(
      'resumable.workflow.ts',
      `export const meta = { name: 'resumable', description: 'resume after kill' }
const first = await parallel(
  ['x', 'y', 'z'].map((n) => () => agent('Quick step ' + n + ' [[fake:text done-' + n + ']]', { label: 'quick ' + n })),
)
const last = await agent('Final step ' + (args && args.slow ? '[[fake:sleep 60000]]' : '') + ' [[fake:text end]]', { label: 'final' })
return { first, last }
`,
    )
    const first = start(sb, ['run', 'resumable', '--cwd', sb.cwd, '--args', '{"slow":true}', '--concurrency', '3'])
    // wait until 3 quick agents are done and the final one is running
    await waitFor(() => {
      const d = runDirs(sb)[0]
      if (!d) return false
      const ev = readJsonl(join(d, 'events.jsonl'))
      return ev.filter((e) => e.t === 'agent_done').length === 3 && ev.filter((e) => e.t === 'agent_start').length === 4
    }, '3 finished agents and a running fourth one')
    // the fourth process must really be running (init event in the stream), otherwise SIGTERM arrives before its handler
    await waitFor(() => {
      const f = join(runDirs(sb)[0], 'agents', '4', 'stream.jsonl')
      return existsSync(f) && readFileSync(f, 'utf8').includes('"session"')
    }, 'the fourth agent started')
    first.child.kill('SIGTERM')
    const f1 = await first.done
    assert.equal(f1.code, 130, f1.stderr)
    assert.equal(f1.stdout, '')

    const dir = runDirs(sb)[0]
    const runId = dir.split('/').pop()!
    const after = readJson(join(dir, 'run.json'))
    assert.equal(after.status, 'aborted')
    assert.equal(readJsonl(join(dir, 'journal.jsonl')).length, 3)
    const evAfter = readJsonl(join(dir, 'events.jsonl'))
    assert.equal(evAfter.at(-1).t, 'run_end')
    assert.equal(evAfter.at(-1).status, 'aborted')

    // killed agent really is not running (the log is written when the process is terminated by SIGTERM)
    await waitFor(() => readFakeLog(sb).some((e) => e.prompt.includes('Final step')), 'termination of the killed agent')

    const before = readFakeLog(sb).length
    const second = await run(sb, ['resume', runId, '--cwd', sb.cwd, '--args', '{"slow":false}'])
    assert.equal(second.code, 0, second.stderr)
    assert.deepEqual(JSON.parse(second.stdout), { first: ['done-x', 'done-y', 'done-z'], last: 'end' })

    const fin = readJson(join(dir, 'run.json'))
    assert.equal(fin.status, 'completed')
    assert.equal(fin.runId, runId)
    assert.equal(fin.totals.cachedAgents, 3)
    assert.equal(fin.totals.agents, 4)
    // new claude process only for the final step
    const newRuns = readFakeLog(sb).slice(before)
    assert.equal(newRuns.length, 1)
    assert.match(newRuns[0].prompt, /Final step/)

    // agent sequence numbers continue (artifacts of the first run are not overwritten)
    const events = readJsonl(join(dir, 'events.jsonl'))
    const ids = events.filter((e) => e.t === 'agent_start').map((e) => e.id)
    assert.equal(new Set(ids).size, ids.length, `agent ids must be unique: ${ids.join(',')}`)
    assert.equal(events.filter((e) => e.t === 'run_start').length, 2)
    assert.equal(events.filter((e) => e.t === 'agent_done' && e.cached === true).length, 3)
    assert.equal(events.at(-1).status, 'completed')

    // 100 % cache on the third run
    const third = await run(sb, ['resume', runId, '--cwd', sb.cwd])
    assert.equal(third.code, 0, third.stderr)
    assert.equal(readFakeLog(sb).length, before + 1)
  })

  it('nested workflow(): the parent phase survives the child; agents and events have the correct path', async () => {
    const sb = makeSandbox()
    sb.script(
      'child.workflow.ts',
      `export const meta = { name: 'child', description: 'child', phases: [{ title: 'Child' }] }
phase('Child')
const r = await agent('Child ' + args.n + ' [[fake:text c' + args.n + ']]')
return { child: r }
`,
    )
    sb.script(
      'parent.workflow.ts',
      `export const meta = { name: 'parent', description: 'parent', phases: [{ title: 'Parent' }] }
phase('Parent')
const a = await agent('Parent before [[fake:text before]]')
const c = await workflow('child', { n: 1 })
const b = await agent('Parent after [[fake:text after]]')
return { a, c, b }
`,
    )
    const r = await run(sb, ['run', 'parent', '--cwd', sb.cwd])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { a: 'before', c: { child: 'c1' }, b: 'after' })
    const events = readJsonl(join(runDirs(sb)[0], 'events.jsonl'))
    const startOf = (needle: string) => events.find((e) => e.t === 'agent_start' && e.promptPreview.includes(needle))
    assert.equal(startOf('Parent before').phase, 'Parent')
    assert.deepEqual(startOf('Parent before').workflowPath, ['parent'])
    assert.equal(startOf('Child 1').phase, 'Child')
    assert.deepEqual(startOf('Child 1').workflowPath, ['parent', 'child'])
    assert.equal(startOf('Parent after').phase, 'Parent', "parent's phase must not be lost after the child")
    assert.deepEqual(startOf('Parent after').workflowPath, ['parent'])
    const enter = events.find((e) => e.t === 'workflow_enter')
    assert.deepEqual(enter.workflowPath, ['parent', 'child'])
    assert.equal(enter.name, 'child')
  })

  it('--max-usd: sequential loop ends with a budget error (exit 1, budgetExceeded), concurrent parallel finishes partially', async () => {
    const sb = makeSandbox()
    sb.script(
      'seq.workflow.ts',
      `export const meta = { name: 'seq', description: 'loop over budget' }
const done: string[] = []
for (let i = 0; i < 6; i++) {
  const r = await agent('Step ' + i + ' [[fake:cost 0.02]] [[fake:text r' + i + ']]', { label: 'step ' + i })
  done.push(r)
}
return done
`,
    )
    const r = await run(sb, ['run', 'seq', '--cwd', sb.cwd, '--max-usd', '0.03', '--concurrency', '1', '--json'])
    assert.equal(r.code, 1, r.stderr)
    const summary = summaryOf(r.stdout)
    assert.equal(summary.status, 'failed')
    assert.equal(summary.budgetExceeded, true)
    assert.equal(summary.totals.agents, 2)
    assert.ok(Math.abs(summary.totals.costUsd - 0.04) < 1e-9, `costUsd=${summary.totals.costUsd}`)
    assert.match(summary.error, /budget|USD/i)
    assert.equal(readFakeLog(sb).length, 2)

    // parallel: items after the budget is exhausted are null, the run completes with a partial result
    sb.script(
      'par.workflow.ts',
      `export const meta = { name: 'par', description: 'parallel over budget' }
const r = await parallel([0, 1, 2, 3, 4].map((i) => () => agent('P' + i + ' [[fake:cost 0.02]] [[fake:text p' + i + ']]')))
return r
`,
    )
    const p = await run(sb, ['run', 'par', '--cwd', sb.cwd, '--max-usd', '0.03', '--concurrency', '1', '--json'])
    assert.equal(p.code, 0, p.stderr)
    const ps = summaryOf(p.stdout)
    assert.equal(ps.status, 'completed')
    assert.equal(ps.budgetExceeded, true)
    assert.deepEqual(ps.result, ['p0', 'p1', null, null, null])
  })

  it('--json streams run events and every agent\'s own log as JSON Lines, ending with the summary', async () => {
    const sb = makeSandbox()
    sb.script(
      'stream.workflow.ts',
      `export const meta = { name: 'stream', description: 'json stream' }
phase('Work')
const r = await parallel(['a', 'b'].map((n) => () => agent('Do ' + n + ' [[fake:tools 2]] [[fake:text out-' + n + ']]', { label: 'worker ' + n })))
return r
`,
    )
    const r = await run(sb, ['run', 'stream', '--cwd', sb.cwd, '--json', '--quiet'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stderr, '')
    const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(lines[0].t, 'run_start')
    assert.equal(lines.at(-2).t, 'run_end')
    assert.deepEqual(summaryOf(r.stdout).result, ['out-a', 'out-b'])

    const starts = lines.filter((e) => e.t === 'agent_start')
    assert.equal(starts.length, 2)
    for (const s of starts) {
      const own = lines.filter((e) => e.t === 'agent_event' && e.id === s.id)
      assert.ok(own.every((e) => e.label === s.label && e.attempt === 1))
      const types = own.map((e) => e.event.type)
      assert.equal(types[0], 'session')
      assert.equal(types.at(-1), 'result')
      assert.equal(own.filter((e) => e.event.type === 'tool' && e.event.status === 'running').length, 2)
      assert.ok(own.some((e) => e.event.type === 'text'))
      // agent events come between the agent's start and done
      const idx = (e: unknown) => lines.indexOf(e)
      const done = lines.find((e) => e.t === 'agent_done' && e.id === s.id)
      assert.ok(own.every((e) => idx(e) > idx(s) && idx(e) < idx(done)))
    }
    // agent_event is live-only: events.jsonl keeps only the run-level events
    const persisted = readJsonl(join(runDirs(sb)[0], 'events.jsonl'))
    assert.ok(!persisted.some((e) => e.t === 'agent_event'))
    assert.ok(persisted.some((e) => e.t === 'agent_start'))
  })

  it('--max-agents: exceeding the agent limit = budget error', async () => {
    const sb = makeSandbox()
    sb.script(
      'many.workflow.ts',
      `export const meta = { name: 'many', description: 'too many agents' }
const r = await parallel([0, 1, 2, 3].map((i) => () => agent('A' + i + ' [[fake:text a' + i + ']]')))
return r
`,
    )
    const r = await run(sb, ['run', 'many', '--cwd', sb.cwd, '--max-agents', '2', '--concurrency', '1', '--json'])
    assert.equal(r.code, 0, r.stderr)
    const s = summaryOf(r.stdout)
    assert.equal(s.budgetExceeded, true)
    assert.deepEqual(s.result, ['a0', 'a1', null, null])
    assert.equal(readFakeLog(sb).length, 2)
  })

  it('concurrency does not exceed --concurrency (and uses it)', async () => {
    const sb = makeSandbox()
    sb.script(
      'conc.workflow.ts',
      `export const meta = { name: 'conc', description: 'concurrency' }
const r = await parallel(Array.from({ length: 9 }, (_, i) => () => agent('Task ' + i + ' [[fake:sleep 500]] [[fake:text u' + i + ']]')))
return r.length
`,
    )
    const r = await run(sb, ['run', 'conc', '--cwd', sb.cwd, '--concurrency', '3'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout), 9)
    const log = readFakeLog(sb)
    assert.equal(log.length, 9)
    const overlap = maxOverlap(log)
    assert.ok(overlap <= 3, `${overlap} agents ran concurrently, limit is 3`)
    assert.ok(overlap >= 2, `concurrency was not used (max ${overlap})`)

    // with --concurrency 1 agents run strictly one by one
    const seq = makeSandbox()
    seq.script('conc.workflow.ts', readFileSync(join(sb.cwd, '.ultracode', 'workflows', 'conc.workflow.ts'), 'utf8').replace('length: 9', 'length: 4'))
    const r2 = await run(seq, ['run', 'conc', '--cwd', seq.cwd, '--concurrency', '1'])
    assert.equal(r2.code, 0, r2.stderr)
    const log2 = readFakeLog(seq)
    assert.equal(log2.length, 4)
    assert.equal(maxOverlap(log2), 1)
  })

  it('env ULTRACODE_MAX_CONCURRENCY applies when --concurrency is not given', async () => {
    const sb = makeSandbox()
    sb.script(
      'envc.workflow.ts',
      `export const meta = { name: 'envc', description: 'concurrency from env' }
const r = await parallel(Array.from({ length: 6 }, (_, i) => () => agent('E' + i + ' [[fake:sleep 400]]')))
return r.length
`,
    )
    const r = await run(sb, ['run', 'envc', '--cwd', sb.cwd], { ULTRACODE_MAX_CONCURRENCY: '2' })
    assert.equal(r.code, 0, r.stderr)
    const overlap = maxOverlap(readFakeLog(sb))
    assert.ok(overlap <= 2 && overlap >= 2, `overlap=${overlap}`)
  })
})

describe('e2e: validate and invalid usage', () => {
  it('validate of an invalid script → exit 2 and diagnostics; valid → exit 0', async () => {
    const sb = makeSandbox()
    const bad = sb.script('bad.workflow.ts', `import fs from 'node:fs'\nexport const meta = { name: 'bad', description: 'x' }\nreturn 1\n`)
    const good = sb.script('good.workflow.ts', `export const meta = { name: 'good', description: 'ok' }\nreturn 1\n`)
    const v = await run(sb, ['validate', bad, '--cwd', sb.cwd])
    assert.equal(v.code, 2, v.stdout + v.stderr)
    assert.match(v.stdout + v.stderr, /import/)
    const ok = await run(sb, ['validate', good, '--cwd', sb.cwd])
    assert.equal(ok.code, 0, ok.stdout + ok.stderr)
  })

  it('run of an invalid script → exit 2, claude is not started and no run directory is created', async () => {
    const sb = makeSandbox()
    const bad = sb.script('bad2.workflow.ts', `export const meta = { name: 'bad2', description: 'x' }\nconst t = Date.now()\nconst fs = await import('node:fs')\nreturn t\n`)
    const r = await run(sb, ['run', bad, '--cwd', sb.cwd])
    assert.equal(r.code, 2, r.stderr)
    assert.equal(r.stdout, '')
    assert.equal(runDirs(sb).length, 0)
    assert.equal(readFakeLog(sb).length, 0)
  })

  it('unknown workflow → exit 2; unknown command → exit 2', async () => {
    const sb = makeSandbox()
    const r = await run(sb, ['run', 'does-not-exist-anywhere', '--cwd', sb.cwd])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /not found/)
    const u = await run(sb, ['blabla'])
    assert.equal(u.code, 2)
  })

  it('error in the script during the run → exit 1, empty stdout, status failed with an error', async () => {
    const sb = makeSandbox()
    sb.script('boom.workflow.ts', `export const meta = { name: 'boom', description: 'error' }\nawait agent('x [[fake:text ok]]')\nthrow new Error('deliberately broken')\n`)
    const r = await run(sb, ['run', 'boom', '--cwd', sb.cwd])
    assert.equal(r.code, 1)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /deliberately broken/)
    const run1 = readJson(join(runDirs(sb)[0], 'run.json'))
    assert.equal(run1.status, 'failed')
    assert.match(run1.error, /deliberately broken/)
  })

  it('concurrent resume of a running run → exit 2 (lock); --run-id collision → exit 2', async () => {
    const sb = makeSandbox()
    sb.script(
      'lock.workflow.ts',
      `export const meta = { name: 'lock', description: 'lock' }
return await agent('Slow [[fake:sleep 1500]] [[fake:text done]]')
`,
    )
    const first = start(sb, ['run', 'lock', '--cwd', sb.cwd, '--run-id', 'lock-1'])
    await waitFor(() => existsSync(join(sb.cwd, '.ultracode', 'runs', 'lock-1', '.lock')), 'run lock')
    const second = await run(sb, ['resume', 'lock-1', '--cwd', sb.cwd])
    assert.equal(second.code, 2, second.stderr)
    assert.match(second.stderr, /is currently in use by another process/)
    const dup = await run(sb, ['run', 'lock', '--cwd', sb.cwd, '--run-id', 'lock-1'])
    assert.equal(dup.code, 2, dup.stderr)
    assert.match(dup.stderr, /already exists/)
    const f = await first.done
    assert.equal(f.code, 0, f.stderr)
    assert.equal(JSON.parse(f.stdout), 'done')
    assert.equal(existsSync(join(sb.cwd, '.ultracode', 'runs', 'lock-1', '.lock')), false)
  })

  it('run killed by SIGKILL: status shows it as aborted and resume finishes it (lock of a dead pid)', async () => {
    const sb = makeSandbox()
    sb.script(
      'kill9.workflow.ts',
      `export const meta = { name: 'kill9', description: 'SIGKILL' }
const a = await agent('Quick [[fake:text first]]')
const b = await agent('Slow [[fake:sleep 1200]] [[fake:text second]]')
return { a, b }
`,
    )
    const first = start(sb, ['run', 'kill9', '--cwd', sb.cwd, '--run-id', 'kill9-1'])
    const events = join(sb.cwd, '.ultracode', 'runs', 'kill9-1', 'events.jsonl')
    await waitFor(() => readJsonl(events).filter((e) => e.t === 'agent_start').length === 2, 'start of the second agent')
    first.child.kill('SIGKILL')
    await first.done

    const st = await run(sb, ['status', 'kill9-1', '--cwd', sb.cwd, '--json'])
    assert.equal(st.code, 0, st.stderr)
    assert.equal(JSON.parse(st.stdout).summary.status, 'aborted')

    const resumed = await run(sb, ['resume', 'kill9-1', '--cwd', sb.cwd])
    assert.equal(resumed.code, 0, resumed.stderr)
    assert.deepEqual(JSON.parse(resumed.stdout), { a: 'first', b: 'second' })
    const fin = readJson(join(sb.cwd, '.ultracode', 'runs', 'kill9-1', 'run.json'))
    assert.equal(fin.status, 'completed')
    assert.equal(fin.totals.cachedAgents, 1)
  })

  it('status and list read the run from disk', async () => {
    const sb = makeSandbox()
    sb.script('st.workflow.ts', `export const meta = { name: 'st', description: 'status' }\nreturn await agent('s [[fake:text hello]]')\n`)
    const r = await run(sb, ['run', 'st', '--cwd', sb.cwd])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout), 'hello')
    const runId = runDirs(sb)[0].split('/').pop()!
    const st = await run(sb, ['status', runId, '--cwd', sb.cwd, '--json'])
    assert.equal(st.code, 0, st.stderr)
    assert.equal(JSON.parse(st.stdout).summary.status, 'completed')
    const ls = await run(sb, ['list', '--cwd', sb.cwd, '--json'])
    assert.equal(ls.code, 0, ls.stderr)
    assert.match(ls.stdout, new RegExp(runId))
  })
})

describe('e2e: built dist', () => {
  it('tsc build into a temp directory → `node <out>/cli/cli.js run` works (worker.js, dynamic imports, direct run)', { timeout: 120_000 }, async () => {
    const sb = makeSandbox()
    const out = mkdtempSync(join(tmpdir(), 'ultracode-dist-'))
    sandboxes.push(out)
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
    const build = await new Promise<{ code: number | null; out: string }>((res) => {
      const c = spawn(process.execPath, [tsc, '-p', join(ROOT, 'tsconfig.build.json'), '--outDir', out, '--sourceMap', 'false'], { cwd: ROOT })
      let buf = ''
      c.stdout.on('data', (d: Buffer) => (buf += d))
      c.stderr.on('data', (d: Buffer) => (buf += d))
      c.on('close', (code) => res({ code, out: buf }))
    })
    assert.equal(build.code, 0, build.out)
    assert.ok(existsSync(join(out, 'script', 'worker.js')))

    sb.script(
      'dist.workflow.ts',
      `export const meta = { name: 'dist', description: 'dist run' }
const r = await parallel([1, 2].map((n) => () => agent('D' + n + ' [[fake:text d' + n + ']]')))
return r
`,
    )
    const child = spawn(process.execPath, [join(out, 'cli', 'cli.js'), 'run', 'dist', '--cwd', sb.cwd], {
      cwd: sb.cwd,
      env: sb.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d))
    child.stderr.on('data', (d: Buffer) => (stderr += d))
    const code = await new Promise<number | null>((res) => child.on('close', res))
    assert.equal(code, 0, stderr)
    assert.deepEqual(JSON.parse(stdout), ['d1', 'd2'])
    assert.equal(readFakeLog(sb).length, 2)
  })
})
