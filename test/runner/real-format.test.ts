/**
 * Ověření, že runner rozumí REÁLNÉMU formátu `claude -p --output-format stream-json`.
 * Místo claude se přehrávají uložené streamy (test/fixtures/sample-stream-*.jsonl) přes replay-claude.mjs.
 */
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { runClaude } from '../../src/runner/claude.ts'
import type { ClaudeProgress, ClaudeRunRequest, ClaudeRunResult } from '../../src/types.ts'
import { FIXTURES, REPLAY_CLAUDE, collectProgress, makeSandbox } from './helpers.ts'
import type { Sandbox } from './helpers.ts'

let sb: Sandbox
const savedEnv = { ...process.env }

function replay(fixture: string, exit: number, extra: Partial<ClaudeRunRequest> = {}): Promise<ClaudeRunResult> {
  sb = makeSandbox(REPLAY_CLAUDE)
  process.env['REPLAY_FILE'] = join(FIXTURES, fixture)
  process.env['REPLAY_EXIT'] = String(exit)
  return runClaude({ prompt: 'x', cwd: sb.cwd, outDir: sb.outDir, stallMs: 10_000, ...extra })
}

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
  Object.assign(process.env, savedEnv)
  sb?.cleanup()
})

describe('reálný stream: nástroje', () => {
  it('Read tool, usage z result eventu, cena, text', async () => {
    const p = collectProgress()
    const r = await replay('sample-stream-tools.jsonl', 0, { onProgress: p.push })
    assert.equal(r.ok, true)
    assert.equal(r.text, 'Soubor má 5 řádků.')
    assert.equal(r.toolCalls, 1)
    assert.equal(r.numTurns, 2)
    assert.deepEqual(r.usage, { inputTokens: 4, outputTokens: 244, cacheReadTokens: 32195, cacheCreationTokens: 15258 })
    assert.ok(Math.abs(r.costUsd - 0.00349595) < 1e-9)
    assert.equal(r.sessionId, '5c89970f-b8fd-450e-bd0e-2d990fa7e21a')
    const tools = p.events.filter((e): e is Extract<ClaudeProgress, { kind: 'tool' }> => e.kind === 'tool')
    assert.deepEqual(tools.map((t) => t.name), ['Read'])
    assert.ok(p.events.some((e) => e.kind === 'text' && e.chars === 'Soubor má 5 řádků.'.length))
  })
})

describe('reálný stream: schema', () => {
  it('structured_output z result eventu; StructuredOutput se nepočítá jako tool', async () => {
    const r = await replay('sample-stream-schema.jsonl', 0, {
      schema: { type: 'object', properties: { lines: { type: 'number' }, first: { type: 'string' } }, required: ['lines', 'first'] },
    })
    assert.equal(r.ok, true)
    assert.deepEqual(r.structured, { lines: 4, first: 'a' })
    assert.equal(r.text, '{"lines":4,"first":"a"}')
    assert.equal(r.toolCalls, 1) // jen Read
    assert.equal(r.usage.outputTokens, 465)
  })

  it('claude nezavolalo StructuredOutput (protimluvné schema) → kind schema, 1 retry', async () => {
    const r = await replay('sample-stream-schema-missing.jsonl', 0, {
      schema: { type: 'object', properties: { x: { type: 'integer' } }, required: ['x'] },
      maxAttempts: 4,
    })
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'schema')
    assert.equal(r.attempts, 2)
    // tokeny z obou pokusů jsou započítány
    assert.equal(r.usage.outputTokens, 742 * 2)
  })
})

describe('reálný stream: chyby', () => {
  it('neexistující model (HTTP 404, subtype success + is_error) → api, bez retry', async () => {
    const r = await replay('sample-stream-apierror.jsonl', 1)
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'api')
    assert.equal(r.attempts, 1)
    assert.match(r.error!.message, /404/)
    assert.match(r.error!.message, /nonexistent-model-xyz/)
  })

  it('překročený rozpočet agenta → api, bez retry, cena započítána', async () => {
    const r = await replay('sample-stream-budget.jsonl', 1)
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'api')
    assert.equal(r.attempts, 1)
    assert.match(r.error!.message, /rozpočet/)
    assert.ok(r.costUsd > 0)
  })

  it('síťová chyba bez HTTP kódu (ECONNREFUSED) je přechodná → opakuje se', async () => {
    const r = await replay('sample-stream-api-retry.jsonl', 1, { maxAttempts: 2 })
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'api')
    assert.equal(r.attempts, 2)
    assert.match(r.error!.message, /ECONNREFUSED/)
  })

  it('stderr „not a valid JSON Schema“ bez stdout JSON → schema, bez retry', async () => {
    sb = makeSandbox(REPLAY_CLAUDE)
    // prázdný stream + chyba na stderr, jak se chová reálné CLI při neplatném schématu
    process.env['REPLAY_FILE'] = join(FIXTURES, 'empty.jsonl')
    process.env['REPLAY_EXIT'] = '1'
    process.env['REPLAY_STDERR'] = 'Error: --json-schema is not a valid JSON Schema: data/properties/x/type must be equal to one of the allowed values'
    const r = await runClaude({ prompt: 'x', cwd: sb.cwd, outDir: sb.outDir })
    assert.equal(r.ok, false)
    assert.equal(r.error?.kind, 'schema')
    assert.equal(r.attempts, 1)
  })
})
