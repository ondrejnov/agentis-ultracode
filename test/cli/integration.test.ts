/**
 * Lehká integrace CLI se SKUTEČNÝM enginem, store a discovery nad falešným claude.
 * Přeskočí se, pokud runtime ještě není kompletní (host skriptu nebo fake claude chybí).
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { main } from '../../src/cli/cli.ts'
import { makeIO, tmpDir, writeFile } from './helpers.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const FAKE = join(ROOT, 'test', 'fixtures', 'fake-claude.mjs')
const READY = existsSync(join(ROOT, 'src', 'script', 'host.ts')) && existsSync(join(ROOT, 'src', 'engine', 'engine.ts')) && existsSync(FAKE)

const SCRIPT = `export const meta = {
  name: 'cli-int',
  description: 'integrační test CLI',
  phases: [{ title: 'Jedna' }],
}
phase('Jedna')
log('start ' + JSON.stringify(args))
const r = await agent('Vrať pozdrav [[fake:json {"greeting":"ahoj"}]]', { label: 'pozdrav', schema: { type: 'object', properties: { greeting: { type: 'string' } }, required: ['greeting'] } })
return { greeting: r && r.greeting, args }
`

describe('integrace s reálným enginem a falešným claude', { skip: !READY && 'runtime ještě není kompletní' }, () => {
  it('run → status → logs → list → resume (100 % cache)', async () => {
    const prevBin = process.env.ULTRACODE_CLAUDE_BIN
    process.env.ULTRACODE_CLAUDE_BIN = FAKE
    try {
      const cwd = tmpDir('uc-int-')
      writeFile(join(cwd, '.ultracode', 'workflows', 'cli-int.workflow.ts'), SCRIPT)

      // run přes jméno workflow (discovery)
      const run = makeIO({ cwd })
      const code = await main(['run', 'cli-int', '--args', '{"k":1}', '--cwd', cwd, '--concurrency', '2'], run.io, {})
      assert.equal(code, 0, run.err())
      assert.deepEqual(JSON.parse(run.out()), { greeting: 'ahoj', args: { k: 1 } })
      assert.match(run.err(), /== Fáze: Jedna/)
      assert.match(run.err(), /\[log\] start \{"k":1\}/)
      assert.match(run.err(), /#1 hotovo +pozdrav/)
      const runId = /Běh: {6}(\S+)/.exec(run.err())?.[1]
      assert.ok(runId, 'souhrn musí obsahovat runId')

      const status = makeIO({ cwd })
      assert.equal(await main(['status', runId, '--cwd', cwd], status.io, {}), 0)
      assert.match(status.out(), /Stav: {5}completed/)
      assert.match(status.out(), /#1 {2}hotovo {2}pozdrav/)

      const latest = makeIO({ cwd })
      assert.equal(await main(['status', '--cwd', cwd], latest.io, {}), 0)
      assert.match(latest.out(), new RegExp(runId))

      const logs = makeIO({ cwd })
      assert.equal(await main(['logs', runId, '--cwd', cwd], logs.io, {}), 0)
      assert.match(logs.out(), /== Konec: completed/)

      const agent = makeIO({ cwd })
      assert.equal(await main(['logs', runId, '--agent', '1', '--cwd', cwd], agent.io, {}), 0)
      assert.match(agent.out(), /-- Prompt --\n.*Vrať pozdrav/)

      const list = makeIO({ cwd })
      assert.equal(await main(['list', '--cwd', cwd], list.io, {}), 0)
      assert.match(list.out(), new RegExp(`${runId}\\s+cli-int\\s+completed`))
      assert.match(list.out(), /cli-int {2}projekt/)

      // resume: stejný skript i args z běhu → agent z cache
      const resumed = makeIO({ cwd })
      const code2 = await main(['resume', runId, '--cwd', cwd], resumed.io, {})
      assert.equal(code2, 0, resumed.err())
      assert.deepEqual(JSON.parse(resumed.out()), { greeting: 'ahoj', args: { k: 1 } })
      assert.match(resumed.err(), /#\d+ cache +pozdrav/)
    } finally {
      if (prevBin === undefined) delete process.env.ULTRACODE_CLAUDE_BIN
      else process.env.ULTRACODE_CLAUDE_BIN = prevBin
    }
  })

  it('neplatný skript → exit 2 (engine hází ScriptValidationError)', async () => {
    const cwd = tmpDir('uc-int-')
    writeFile(join(cwd, 'bad.workflow.ts'), 'const x = 1\nreturn x\n')
    const cap = makeIO({ cwd })
    const code = await main(['run', 'bad.workflow.ts', '--cwd', cwd], cap.io, {})
    assert.equal(code, 2, cap.err())
    assert.equal(cap.out(), '')
  })

  it('neznámé workflow → exit 2', async () => {
    const cwd = tmpDir('uc-int-')
    const cap = makeIO({ cwd })
    assert.equal(await main(['run', 'neexistuje-xyz', '--cwd', cwd], cap.io, {}), 2)
    assert.match(cap.err(), /nenalezeno/)
  })
})
