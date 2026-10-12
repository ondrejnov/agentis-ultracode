import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOST = new URL('../../src/script/host.ts', import.meta.url).href

/** Spustí `code` jako ESM soubor v novém procesu `node`. */
function runModule(code: string): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ultracode-script-test-'))
  try {
    const file = join(dir, 'main.mjs')
    writeFileSync(file, code)
    return spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 20_000 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('chování v samostatném procesu', () => {
  it('běh skriptu (vč. vnořeného workflow a TS) nevypíše nic na stderr (žádný ExperimentalWarning) a proces skončí', () => {
    const code = `
import { runScript } from ${JSON.stringify(HOST)}
const hooks = {
  agent: async (p) => 'A:' + p,
  phase() {}, log() {}, workflowEnter() {}, workflowExit() {},
  loadWorkflow: async () => ({ source: "export const meta = { name: 'c', description: 'd' }\\nconst n: number = 2\\nreturn n * 21\\n", filename: 'c.ts' }),
}
const r = await runScript({
  source: "export const meta = { name: 'p', description: 'd' }\\nconst t: string = 'x'\\nconst c = await workflow('c')\\nreturn { a: await agent(t), c }\\n",
  filename: 'p.ts', args: undefined, hooks, budgetBuffer: new SharedArrayBuffer(32),
})
process.stdout.write(JSON.stringify(r.value))
`
    const res = runModule(code)
    assert.equal(res.status, 0, res.stderr)
    assert.equal(res.stderr, '')
    assert.deepEqual(JSON.parse(res.stdout), { a: 'A:x', c: 42 })
  })

  it('pád skriptu nevypíše stack trace workeru na stderr a proces skončí s kódem 0, když chybu zachytíme', () => {
    const code = `
import { runScript } from ${JSON.stringify(HOST)}
const hooks = { agent: async () => null, phase() {}, log() {}, workflowEnter() {}, workflowExit() {}, loadWorkflow: async () => { throw new Error('x') } }
try {
  await runScript({ source: "export const meta = { name: 'p', description: 'd' }\\nthrow new Error('kaboom')\\n", filename: 'p.ts', args: undefined, hooks, budgetBuffer: new SharedArrayBuffer(32) })
} catch (e) { process.stdout.write(e.message) }
`
    const res = runModule(code)
    assert.equal(res.status, 0, res.stderr)
    assert.equal(res.stdout, 'kaboom')
    assert.equal(res.stderr, '')
  })
})
