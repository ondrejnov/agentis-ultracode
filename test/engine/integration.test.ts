/**
 * Integrace enginu se skutečným parserem/hostem skriptu (modul SCRIPT) a runnerem (modul RUNNER)
 * nad falešným `claude` (test/fixtures/fake-claude.mjs).
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runWorkflow } from '../../src/engine/engine.ts'
import { readEvents } from '../../src/engine/store.ts'
import { makeProject, readJsonFile, sleep, waitFor } from './helpers.ts'

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url))

const SCRIPT = `export const meta = {
  name: 'integrace',
  description: 'Fan-out přes pipeline s fake claude',
  phases: [{ title: 'Hledání' }, { title: 'Oprava' }],
}
phase('Hledání')
const items = args.items
const results = await pipeline(
  items,
  (item) => agent('Najdi chyby v ' + item + ' [[fake:json {"item":"' + item + '","found":2}]] [[fake:tokens 50]]', {
    label: 'find ' + item,
    schema: { type: 'object', properties: { item: { type: 'string' }, found: { type: 'number' } }, required: ['item', 'found'] },
  }),
  (found, item) => agent('Oprav ' + item + ' (' + found.found + ') [[fake:text opraveno-' + item + ']]', { label: 'fix ' + item, phase: 'Oprava' }),
)
log('hotovo: ' + results.filter(Boolean).length)
return { results, spent: budget.spent() }
`

function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k]
    process.env[k] = v
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

function readLog(path: string): Array<{ startedAt: number | string; endedAt: number | string; prompt: string; cwd: string; args: string[] }> {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

describe('integrace s reálným host/parse a fake-claude', () => {
  test('pipeline přes skutečný skript, resume = 100 % cache, claudeBin nemění process.env', async () => {
    const p = makeProject()
    const logFile = join(p.cwd, 'fake.log')
    try {
      const file = p.script('integrace.workflow.ts', SCRIPT)
      const before = process.env.ULTRACODE_CLAUDE_BIN
      const s1 = await withEnv({ FAKE_CLAUDE_LOG: logFile, FAKE_CLAUDE_STATE_DIR: join(p.cwd, 'state') }, () =>
        runWorkflow({ workflow: file, cwd: p.cwd, args: { items: ['a.php', 'b.php', 'c.php'] }, claudeBin: FAKE, concurrency: 2 }),
      )
      assert.equal(process.env.ULTRACODE_CLAUDE_BIN, before)
      assert.equal(s1.status, 'completed', s1.error)
      const result = s1.result as { results: string[]; spent: number }
      assert.deepEqual(result.results, ['opraveno-a.php', 'opraveno-b.php', 'opraveno-c.php'])
      assert.equal(s1.totals.agents, 6)
      assert.equal(s1.totals.failedAgents, 0)
      assert.equal(s1.totals.usage.outputTokens, result.spent)
      assert.ok(result.spent >= 150)

      const calls = readLog(logFile)
      assert.equal(calls.length, 6)
      // souběžnost 2 platí i pro skutečné procesy
      const iv = calls.map((c) => [Number(new Date(c.startedAt)), Number(new Date(c.endedAt))] as const)
      let peak = 0
      for (const [s] of iv) peak = Math.max(peak, iv.filter(([a, b]) => a <= s && s < b).length)
      assert.ok(peak <= 2, `souběžnost ${peak} > 2`)

      const events = readEvents(p.cwd, s1.runId)
      const phases = events.filter((e) => e.t === 'agent_start').map((e) => (e.t === 'agent_start' ? e.phase : null))
      assert.equal(phases.filter((x) => x === 'Hledání').length, 3)
      assert.equal(phases.filter((x) => x === 'Oprava').length, 3)
      assert.ok(existsSync(join(s1.runDir, 'agents', '1', 'prompt.txt')))

      // resume: nic se nespustí
      const s2 = await withEnv({ FAKE_CLAUDE_LOG: logFile, FAKE_CLAUDE_STATE_DIR: join(p.cwd, 'state') }, () =>
        runWorkflow({ workflow: file, cwd: p.cwd, claudeBin: FAKE, resumeRunId: s1.runId }),
      )
      assert.equal(s2.status, 'completed', s2.error)
      assert.equal(s2.totals.cachedAgents, 6)
      // přehrané výsledky z cache nesou svou původní cenu; nový FAKE běh nic nestál
      assert.equal(s2.totals.costUsd, s1.totals.costUsd)
      assert.deepEqual((s2.result as any).results, result.results)
      assert.equal(readLog(logFile).length, 6)
      assert.deepEqual(readJsonFile(join(s2.runDir, 'args.json')), { items: ['a.php', 'b.php', 'c.php'] })
    } finally {
      p.cleanup()
    }
  })

  test('abort: skutečné procesy fake-claude jsou zabity a běh skončí aborted', async () => {
    const p = makeProject()
    const logFile = join(p.cwd, 'fake.log')
    try {
      const file = p.script(
        'slow.workflow.ts',
        `export const meta = { name: 'slow', description: 'pomalé' }
const r = await parallel([1, 2, 3].map((i) => () => agent('pomalý ' + i + ' [[fake:sleep 20000]]')))
return r`,
      )
      const ac = new AbortController()
      const t0 = Date.now()
      const s = await withEnv({ FAKE_CLAUDE_LOG: logFile }, async () => {
        let started = 0
        const promise = runWorkflow({
          workflow: file,
          cwd: p.cwd,
          claudeBin: FAKE,
          signal: ac.signal,
          concurrency: 3,
          onEvent: (e) => {
            if (e.t === 'agent_start') started++
          },
        })
        await waitFor(() => started === 3, 8000)
        await sleep(200)
        ac.abort()
        return promise
      })
      assert.ok(Date.now() - t0 < 15000)
      assert.equal(s.status, 'aborted')
      assert.equal(readJsonFile(join(s.runDir, 'run.json')).status, 'aborted')
    } finally {
      p.cleanup()
    }
  })

  test('chyba skriptu z hostu (throw) → failed; neplatný skript → ScriptValidationError před založením běhu', async () => {
    const p = makeProject()
    try {
      const bad = p.script('bad.workflow.ts', `export const meta = { name: 'bad', description: 'x' }\nthrow new Error('ze skriptu')\n`)
      const s = await runWorkflow({ workflow: bad, cwd: p.cwd, claudeBin: FAKE })
      assert.equal(s.status, 'failed')
      assert.match(s.error ?? '', /ze skriptu/)

      const invalid = p.script('invalid.workflow.ts', `const x = 1\nreturn x\n`) // chybí meta
      await assert.rejects(runWorkflow({ workflow: invalid, cwd: p.cwd, claudeBin: FAKE }), (e: any) => e.code === 'SCRIPT_INVALID' && Array.isArray(e.diagnostics))
    } finally {
      p.cleanup()
    }
  })
})
