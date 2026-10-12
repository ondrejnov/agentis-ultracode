/**
 * E2E: skutečný proces `node bin/ultracode.mjs …` + skutečný engine, host skriptu a runner nad fake-claude.
 * Ověřuje chování z pohledu uživatele/Agentisu: stdout = JSON, exit kódy, adresář běhu, resume po zabití,
 * rozpočet, validace a limit souběžnosti (z logu fake-claude).
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

// ───────────────────────── pomůcky ─────────────────────────

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
      // e2e testují aktuální zdrojáky, ne případný starší dist/ (dist se testuje zvlášť)
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
      // ignoruj
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
      rej(new Error(`ultracode ${args.join(' ')} neskončil včas.\nstderr:\n${stderr}`))
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
  env: { CLAUDE_CODE_DISABLE_WORKFLOWS: string | null }
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
  throw new Error(`Timeout čekání na: ${what}`)
}

/** Maximální počet současně běžících procesů fake-claude podle [startedAt, endedAt]. */
function maxOverlap(entries: FakeLog[]): number {
  const points: Array<[number, number]> = []
  for (const e of entries) {
    points.push([Date.parse(e.startedAt), 1])
    points.push([Date.parse(e.endedAt), -1])
  }
  // při shodném čase nejdřív konec (-1), ať se nepřeceňuje překryv
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

// ───────────────────────── testy ─────────────────────────

describe('e2e: ultracode run', () => {
  it('úspěšný pipeline běh: stdout JSON, exit 0, kompletní adresář běhu', async () => {
    const sb = makeSandbox()
    sb.script(
      'pipe.workflow.ts',
      `export const meta = {
  name: 'pipe',
  description: 'e2e pipeline',
  phases: [{ title: 'Analýza' }, { title: 'Oprava' }],
}
phase('Analýza')
const files: string[] = args.files
log('soubory: ' + files.length)
const out = await pipeline(
  files,
  (f: string) => agent('Analyzuj ' + f + ' [[fake:json {"value":"analyza-' + f + '"}]]', { label: 'analyza ' + f, phase: 'Analýza', schema: ${SCHEMA_VALUE} }),
  (a: { value: string } | null, f: string) =>
    agent('Oprav ' + f + ' podle ' + (a ? a.value : 'nic') + ' [[fake:text opraveno-' + f + ']]', { label: 'oprava ' + f, phase: 'Oprava' }),
)
return { opraveno: out, spent: budget.spent() }
`,
    )
    const r = await run(sb, ['run', 'pipe', '--cwd', sb.cwd, '--args', '{"files":["a.php","b.php","c.php"]}', '--concurrency', '2'])
    assert.equal(r.code, 0, r.stderr)

    // stdout = čistý JSON výsledku skriptu; průběh je jen na stderr
    const result = JSON.parse(r.stdout)
    assert.deepEqual(result.opraveno, ['opraveno-a.php', 'opraveno-b.php', 'opraveno-c.php'])
    assert.equal(typeof result.spent, 'number')
    assert.match(r.stderr, /Analýza/)
    assert.match(r.stderr, /soubory: 3/)

    // adresář běhu
    const dirs = runDirs(sb)
    assert.equal(dirs.length, 1)
    const dir = dirs[0]
    for (const f of ['run.json', 'script.ts', 'args.json', 'options.json', 'events.jsonl', 'journal.jsonl', 'result.json']) {
      assert.ok(existsSync(join(dir, f)), `chybí ${f}`)
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
      ['Analýza', 'Oprava'],
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

    // jak byl claude volán: izolace od rekurzivních workflow, bypass, schema, cwd
    const log = readFakeLog(sb)
    assert.equal(log.length, 6)
    for (const e of log) {
      assert.equal(e.env.CLAUDE_CODE_DISABLE_WORKFLOWS, '1')
      assert.equal(e.cwd, sb.cwd)
      assert.ok(e.args.includes('-p'))
      assert.ok(e.args.includes('stream-json'))
      assert.equal(e.args[e.args.indexOf('--permission-mode') + 1], 'bypassPermissions')
      assert.match(e.args[e.args.indexOf('--disallowedTools') + 1], /(^|,)Workflow(,|$)/)
    }
    assert.equal(log.filter((e) => e.args.includes('--json-schema')).length, 3)

    // závislost: oprava dostala výsledek analýzy v promptu
    assert.ok(log.some((e) => e.prompt.includes('Oprav b.php podle analyza-b.php')))
  })

  it('selhání agenta → null ve výsledku, běh dokončen, selhání v totals; ostatní agenti nedotčeni', async () => {
    const sb = makeSandbox()
    sb.script(
      'fail.workflow.ts',
      `export const meta = { name: 'fail', description: 'jeden agent selže' }
const r = await parallel([
  () => agent('Dobrý agent [[fake:text ok]]', { label: 'dobry' }),
  () => agent('Špatný agent [[fake:fail]]', { label: 'spatny' }),
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

    // do journalu patří jen úspěšný agent (selhání se při resume zopakuje)
    assert.equal(readJsonl(join(dir, 'journal.jsonl')).length, 1)
    const failed = readJsonl(join(dir, 'events.jsonl')).filter((e) => e.t === 'agent_done' && e.ok === false)
    assert.equal(failed.length, 1)
    assert.match(String(failed[0].error), /exit/)

    // runner zkusil špatného agenta opakovaně (retry), dobrého jen jednou
    const log = readFakeLog(sb)
    assert.equal(log.filter((e) => e.prompt.includes('Dobrý agent')).length, 1)
    assert.equal(log.filter((e) => e.prompt.includes('Špatný agent')).length, 3)
  })

  it('resume po zabitém běhu (SIGTERM): hotoví agenti z cache, doběhne jen zbytek', async () => {
    const sb = makeSandbox()
    sb.script(
      'resumable.workflow.ts',
      `export const meta = { name: 'resumable', description: 'resume po zabití' }
const first = await parallel(
  ['x', 'y', 'z'].map((n) => () => agent('Rychlý krok ' + n + ' [[fake:text hotovo-' + n + ']]', { label: 'rychly ' + n })),
)
const last = await agent('Závěrečný krok ' + (args && args.slow ? '[[fake:sleep 60000]]' : '') + ' [[fake:text konec]]', { label: 'zaver' })
return { first, last }
`,
    )
    const first = start(sb, ['run', 'resumable', '--cwd', sb.cwd, '--args', '{"slow":true}', '--concurrency', '3'])
    // počkej, až jsou hotoví 3 rychlí agenti a běží závěrečný
    await waitFor(() => {
      const d = runDirs(sb)[0]
      if (!d) return false
      const ev = readJsonl(join(d, 'events.jsonl'))
      return ev.filter((e) => e.t === 'agent_done').length === 3 && ev.filter((e) => e.t === 'agent_start').length === 4
    }, '3 hotoví agenti a běžící čtvrtý')
    // čtvrtý proces musí být opravdu rozběhnutý (init event ve streamu), jinak SIGTERM přijde dřív než jeho handler
    await waitFor(() => {
      const f = join(runDirs(sb)[0], 'agents', '4', 'stream.jsonl')
      return existsSync(f) && readFileSync(f, 'utf8').includes('"init"')
    }, 'rozběhnutí čtvrtého agenta')
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

    // zabitý agent opravdu neběží (log vznikne při ukončení procesu SIGTERM)
    await waitFor(() => readFakeLog(sb).some((e) => e.prompt.includes('Závěrečný krok')), 'ukončení zabitého agenta')

    const before = readFakeLog(sb).length
    const second = await run(sb, ['resume', runId, '--cwd', sb.cwd, '--args', '{"slow":false}'])
    assert.equal(second.code, 0, second.stderr)
    assert.deepEqual(JSON.parse(second.stdout), { first: ['hotovo-x', 'hotovo-y', 'hotovo-z'], last: 'konec' })

    const fin = readJson(join(dir, 'run.json'))
    assert.equal(fin.status, 'completed')
    assert.equal(fin.runId, runId)
    assert.equal(fin.totals.cachedAgents, 3)
    assert.equal(fin.totals.agents, 4)
    // nový proces claude jen pro závěrečný krok
    const newRuns = readFakeLog(sb).slice(before)
    assert.equal(newRuns.length, 1)
    assert.match(newRuns[0].prompt, /Závěrečný krok/)

    // pořadová čísla agentů navazují (nepřepisují se artefakty prvního běhu)
    const events = readJsonl(join(dir, 'events.jsonl'))
    const ids = events.filter((e) => e.t === 'agent_start').map((e) => e.id)
    assert.equal(new Set(ids).size, ids.length, `id agentů musí být unikátní: ${ids.join(',')}`)
    assert.equal(events.filter((e) => e.t === 'run_start').length, 2)
    assert.equal(events.filter((e) => e.t === 'agent_done' && e.cached === true).length, 3)
    assert.equal(events.at(-1).status, 'completed')

    // 100% cache při třetím běhu
    const third = await run(sb, ['resume', runId, '--cwd', sb.cwd])
    assert.equal(third.code, 0, third.stderr)
    assert.equal(readFakeLog(sb).length, before + 1)
  })

  it('vnořené workflow(): fáze rodiče přežije potomka, agenti i události mají správnou cestu', async () => {
    const sb = makeSandbox()
    sb.script(
      'child.workflow.ts',
      `export const meta = { name: 'child', description: 'potomek', phases: [{ title: 'Dítě' }] }
phase('Dítě')
const r = await agent('Potomek ' + args.n + ' [[fake:text c' + args.n + ']]')
return { child: r }
`,
    )
    sb.script(
      'parent.workflow.ts',
      `export const meta = { name: 'parent', description: 'rodič', phases: [{ title: 'Rodič' }] }
phase('Rodič')
const a = await agent('Rodič před [[fake:text pred]]')
const c = await workflow('child', { n: 1 })
const b = await agent('Rodič po [[fake:text po]]')
return { a, c, b }
`,
    )
    const r = await run(sb, ['run', 'parent', '--cwd', sb.cwd])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { a: 'pred', c: { child: 'c1' }, b: 'po' })
    const events = readJsonl(join(runDirs(sb)[0], 'events.jsonl'))
    const startOf = (needle: string) => events.find((e) => e.t === 'agent_start' && e.promptPreview.includes(needle))
    assert.equal(startOf('Rodič před').phase, 'Rodič')
    assert.deepEqual(startOf('Rodič před').workflowPath, ['parent'])
    assert.equal(startOf('Potomek 1').phase, 'Dítě')
    assert.deepEqual(startOf('Potomek 1').workflowPath, ['parent', 'child'])
    assert.equal(startOf('Rodič po').phase, 'Rodič', 'fáze rodiče se po potomkovi nesmí ztratit')
    assert.deepEqual(startOf('Rodič po').workflowPath, ['parent'])
    const enter = events.find((e) => e.t === 'workflow_enter')
    assert.deepEqual(enter.workflowPath, ['parent', 'child'])
    assert.equal(enter.name, 'child')
  })

  it('--max-usd: sekvenční smyčka skončí chybou rozpočtu (exit 1, budgetExceeded), souběžné parallel doběhne částečně', async () => {
    const sb = makeSandbox()
    sb.script(
      'seq.workflow.ts',
      `export const meta = { name: 'seq', description: 'smyčka nad rozpočtem' }
const done: string[] = []
for (let i = 0; i < 6; i++) {
  const r = await agent('Krok ' + i + ' [[fake:cost 0.02]] [[fake:text r' + i + ']]', { label: 'krok ' + i })
  done.push(r)
}
return done
`,
    )
    const r = await run(sb, ['run', 'seq', '--cwd', sb.cwd, '--max-usd', '0.03', '--concurrency', '1', '--json'])
    assert.equal(r.code, 1, r.stderr)
    const summary = JSON.parse(r.stdout)
    assert.equal(summary.status, 'failed')
    assert.equal(summary.budgetExceeded, true)
    assert.equal(summary.totals.agents, 2)
    assert.ok(Math.abs(summary.totals.costUsd - 0.04) < 1e-9, `costUsd=${summary.totals.costUsd}`)
    assert.match(summary.error, /rozpočet|USD/i)
    assert.equal(readFakeLog(sb).length, 2)

    // parallel: položky po vyčerpání rozpočtu jsou null, běh se dokončí s částečným výsledkem
    sb.script(
      'par.workflow.ts',
      `export const meta = { name: 'par', description: 'parallel nad rozpočtem' }
const r = await parallel([0, 1, 2, 3, 4].map((i) => () => agent('P' + i + ' [[fake:cost 0.02]] [[fake:text p' + i + ']]')))
return r
`,
    )
    const p = await run(sb, ['run', 'par', '--cwd', sb.cwd, '--max-usd', '0.03', '--concurrency', '1', '--json'])
    assert.equal(p.code, 0, p.stderr)
    const ps = JSON.parse(p.stdout)
    assert.equal(ps.status, 'completed')
    assert.equal(ps.budgetExceeded, true)
    assert.deepEqual(ps.result, ['p0', 'p1', null, null, null])
  })

  it('--max-agents: překročení limitu agentů = chyba rozpočtu', async () => {
    const sb = makeSandbox()
    sb.script(
      'many.workflow.ts',
      `export const meta = { name: 'many', description: 'moc agentů' }
const r = await parallel([0, 1, 2, 3].map((i) => () => agent('A' + i + ' [[fake:text a' + i + ']]')))
return r
`,
    )
    const r = await run(sb, ['run', 'many', '--cwd', sb.cwd, '--max-agents', '2', '--concurrency', '1', '--json'])
    assert.equal(r.code, 0, r.stderr)
    const s = JSON.parse(r.stdout)
    assert.equal(s.budgetExceeded, true)
    assert.deepEqual(s.result, ['a0', 'a1', null, null])
    assert.equal(readFakeLog(sb).length, 2)
  })

  it('souběžnost nepřekročí --concurrency (a využije ji)', async () => {
    const sb = makeSandbox()
    sb.script(
      'conc.workflow.ts',
      `export const meta = { name: 'conc', description: 'souběžnost' }
const r = await parallel(Array.from({ length: 9 }, (_, i) => () => agent('Úloha ' + i + ' [[fake:sleep 500]] [[fake:text u' + i + ']]')))
return r.length
`,
    )
    const r = await run(sb, ['run', 'conc', '--cwd', sb.cwd, '--concurrency', '3'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout), 9)
    const log = readFakeLog(sb)
    assert.equal(log.length, 9)
    const overlap = maxOverlap(log)
    assert.ok(overlap <= 3, `souběžně běželo ${overlap} agentů, limit je 3`)
    assert.ok(overlap >= 2, `souběžnost se nevyužila (max ${overlap})`)

    // s --concurrency 1 běží agenti striktně po jednom
    const seq = makeSandbox()
    seq.script('conc.workflow.ts', readFileSync(join(sb.cwd, '.ultracode', 'workflows', 'conc.workflow.ts'), 'utf8').replace('length: 9', 'length: 4'))
    const r2 = await run(seq, ['run', 'conc', '--cwd', seq.cwd, '--concurrency', '1'])
    assert.equal(r2.code, 0, r2.stderr)
    const log2 = readFakeLog(seq)
    assert.equal(log2.length, 4)
    assert.equal(maxOverlap(log2), 1)
  })

  it('env ULTRACODE_MAX_CONCURRENCY platí, když není --concurrency', async () => {
    const sb = makeSandbox()
    sb.script(
      'envc.workflow.ts',
      `export const meta = { name: 'envc', description: 'souběžnost z env' }
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

describe('e2e: validate a chybné použití', () => {
  it('validate neplatného skriptu → exit 2 a diagnostika; platný → exit 0', async () => {
    const sb = makeSandbox()
    const bad = sb.script('bad.workflow.ts', `import fs from 'node:fs'\nexport const meta = { name: 'bad', description: 'x' }\nreturn 1\n`)
    const good = sb.script('good.workflow.ts', `export const meta = { name: 'good', description: 'ok' }\nreturn 1\n`)
    const v = await run(sb, ['validate', bad, '--cwd', sb.cwd])
    assert.equal(v.code, 2, v.stdout + v.stderr)
    assert.match(v.stdout + v.stderr, /import/)
    const ok = await run(sb, ['validate', good, '--cwd', sb.cwd])
    assert.equal(ok.code, 0, ok.stdout + ok.stderr)
  })

  it('run neplatného skriptu → exit 2, claude se nespustí a nevznikne adresář běhu', async () => {
    const sb = makeSandbox()
    const bad = sb.script('bad2.workflow.ts', `export const meta = { name: 'bad2', description: 'x' }\nconst t = Date.now()\nconst fs = await import('node:fs')\nreturn t\n`)
    const r = await run(sb, ['run', bad, '--cwd', sb.cwd])
    assert.equal(r.code, 2, r.stderr)
    assert.equal(r.stdout, '')
    assert.equal(runDirs(sb).length, 0)
    assert.equal(readFakeLog(sb).length, 0)
  })

  it('neznámé workflow → exit 2; neznámý příkaz → exit 2', async () => {
    const sb = makeSandbox()
    const r = await run(sb, ['run', 'neexistuje-nikde', '--cwd', sb.cwd])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /nenalezeno/)
    const u = await run(sb, ['blabla'])
    assert.equal(u.code, 2)
  })

  it('chyba ve skriptu za běhu → exit 1, stdout prázdný, status failed s chybou', async () => {
    const sb = makeSandbox()
    sb.script('boom.workflow.ts', `export const meta = { name: 'boom', description: 'chyba' }\nawait agent('x [[fake:text ok]]')\nthrow new Error('rozbito schválně')\n`)
    const r = await run(sb, ['run', 'boom', '--cwd', sb.cwd])
    assert.equal(r.code, 1)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /rozbito schválně/)
    const run1 = readJson(join(runDirs(sb)[0], 'run.json'))
    assert.equal(run1.status, 'failed')
    assert.match(run1.error, /rozbito schválně/)
  })

  it('souběžný resume běžícího běhu → exit 2 (zámek); kolize --run-id → exit 2', async () => {
    const sb = makeSandbox()
    sb.script(
      'lock.workflow.ts',
      `export const meta = { name: 'lock', description: 'zámek' }
return await agent('Pomalý [[fake:sleep 1500]] [[fake:text hotovo]]')
`,
    )
    const first = start(sb, ['run', 'lock', '--cwd', sb.cwd, '--run-id', 'zamek-1'])
    await waitFor(() => existsSync(join(sb.cwd, '.ultracode', 'runs', 'zamek-1', '.lock')), 'zámek běhu')
    const second = await run(sb, ['resume', 'zamek-1', '--cwd', sb.cwd])
    assert.equal(second.code, 2, second.stderr)
    assert.match(second.stderr, /používá jiný proces/)
    const dup = await run(sb, ['run', 'lock', '--cwd', sb.cwd, '--run-id', 'zamek-1'])
    assert.equal(dup.code, 2, dup.stderr)
    assert.match(dup.stderr, /už existuje/)
    const f = await first.done
    assert.equal(f.code, 0, f.stderr)
    assert.equal(JSON.parse(f.stdout), 'hotovo')
    assert.equal(existsSync(join(sb.cwd, '.ultracode', 'runs', 'zamek-1', '.lock')), false)
  })

  it('běh zabitý přes SIGKILL: status ho ukáže jako aborted a resume ho dodělá (zámek mrtvého pid)', async () => {
    const sb = makeSandbox()
    sb.script(
      'kill9.workflow.ts',
      `export const meta = { name: 'kill9', description: 'SIGKILL' }
const a = await agent('Rychlý [[fake:text prvni]]')
const b = await agent('Pomalý [[fake:sleep 1200]] [[fake:text druhy]]')
return { a, b }
`,
    )
    const first = start(sb, ['run', 'kill9', '--cwd', sb.cwd, '--run-id', 'kill9-1'])
    const events = join(sb.cwd, '.ultracode', 'runs', 'kill9-1', 'events.jsonl')
    await waitFor(() => readJsonl(events).filter((e) => e.t === 'agent_start').length === 2, 'start druhého agenta')
    first.child.kill('SIGKILL')
    await first.done

    const st = await run(sb, ['status', 'kill9-1', '--cwd', sb.cwd, '--json'])
    assert.equal(st.code, 0, st.stderr)
    assert.equal(JSON.parse(st.stdout).summary.status, 'aborted')

    const resumed = await run(sb, ['resume', 'kill9-1', '--cwd', sb.cwd])
    assert.equal(resumed.code, 0, resumed.stderr)
    assert.deepEqual(JSON.parse(resumed.stdout), { a: 'prvni', b: 'druhy' })
    const fin = readJson(join(sb.cwd, '.ultracode', 'runs', 'kill9-1', 'run.json'))
    assert.equal(fin.status, 'completed')
    assert.equal(fin.totals.cachedAgents, 1)
  })

  it('status a list čtou běh z disku', async () => {
    const sb = makeSandbox()
    sb.script('st.workflow.ts', `export const meta = { name: 'st', description: 'status' }\nreturn await agent('s [[fake:text ahoj]]')\n`)
    const r = await run(sb, ['run', 'st', '--cwd', sb.cwd])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout), 'ahoj')
    const runId = runDirs(sb)[0].split('/').pop()!
    const st = await run(sb, ['status', runId, '--cwd', sb.cwd, '--json'])
    assert.equal(st.code, 0, st.stderr)
    assert.equal(JSON.parse(st.stdout).summary.status, 'completed')
    const ls = await run(sb, ['list', '--cwd', sb.cwd, '--json'])
    assert.equal(ls.code, 0, ls.stderr)
    assert.match(ls.stdout, new RegExp(runId))
  })
})

describe('e2e: přeložený dist', () => {
  it('tsc build do dočasného adresáře → `node <out>/cli/cli.js run` funguje (worker.js, dynamické importy, přímé spuštění)', { timeout: 120_000 }, async () => {
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
      `export const meta = { name: 'dist', description: 'dist běh' }
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
