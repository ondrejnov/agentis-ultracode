import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { JsonlAppender, StateFileWriter, ensureTrailingNewline, writeFileAtomic } from '../../src/engine/io.ts'
import { JournalCache, canonicalJson, computeCallKey, parseJournal } from '../../src/engine/journal.ts'
import { readFileSync } from 'node:fs'

const base = { prompt: 'p', cwd: '/c' }

describe('journal: klíče', () => {
  test('canonicalJson: pořadí klíčů nehraje roli, undefined se vynechá', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: undefined }], c: null } }), canonicalJson({ a: { c: null, d: [1, { y: undefined, z: 1 }] }, b: 1 }))
    assert.equal(canonicalJson({ a: undefined }), '{}')
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]))
  })

  test('computeCallKey: stabilní, citlivý na každou složku, množina nástrojů je bez pořadí', () => {
    const k = computeCallKey(base)
    assert.match(k, /^[0-9a-f]{64}$/)
    assert.equal(computeCallKey({ ...base }), k)
    assert.equal(computeCallKey({ ...base, tools: ['A', 'B'] }), computeCallKey({ ...base, tools: ['B', 'A'] }))
    assert.equal(computeCallKey({ ...base, model: undefined, schema: undefined }), k)
    const variants = [
      { prompt: 'q' },
      { cwd: '/d' },
      { model: 'opus' },
      { effort: 'high' },
      { tools: [] },
      { tools: ['Read'] },
      { disallowedTools: ['Bash'] },
      { systemPrompt: 's' },
      { schema: { type: 'object', properties: {} } },
    ]
    const keys = new Set([k])
    for (const v of variants) keys.add(computeCallKey({ ...base, ...v } as any))
    assert.equal(keys.size, variants.length + 1)
  })

  test('schema: pořadí klíčů ve schématu nemění klíč', () => {
    const a = { type: 'object', properties: { x: { type: 'string' }, y: { type: 'number' } }, required: ['x'] }
    const b = { required: ['x'], properties: { y: { type: 'number' }, x: { type: 'string' } }, type: 'object' }
    assert.equal(computeCallKey({ ...base, schema: a }), computeCallKey({ ...base, schema: b }))
  })
})

describe('journal: čtení', () => {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
  const entry = (key: string, seq: number, result: unknown, ok = true) => JSON.stringify({ key, seq, ok, label: 'l', result, usage, costUsd: 0, ts: 't' })

  test('parseJournal: přeskočí prázdné, poškozené a neúspěšné řádky', () => {
    const text = [entry('k', 0, 'a'), '', 'nesmysl', entry('k', 1, 'b', false), '{"key":"k"}', entry('k', 2, { o: 1 }), '{"key":"k","seq":3,"ok":tr'].join('\n')
    const e = parseJournal(text)
    assert.deepEqual(e.map((x) => [x.seq, x.result]), [[0, 'a'], [2, { o: 1 }]])
  })

  test('JournalCache: lookup podle key+seq, pozdější záznam přepisuje dřívější, chybějící soubor = prázdná cache', async () => {
    const cache = new JournalCache(parseJournal([entry('k', 0, 'old'), entry('k', 1, 'x'), entry('k', 0, 'new')].join('\n')))
    assert.equal(cache.lookup('k', 0)?.result, 'new')
    assert.equal(cache.lookup('k', 1)?.result, 'x')
    assert.equal(cache.lookup('k', 2), undefined)
    assert.equal(cache.lookup('other', 0), undefined)
    assert.equal(cache.size, 2)
    assert.equal((await JournalCache.load('/neexistuje/journal.jsonl')).size, 0)
  })
})

describe('io', () => {
  test('JsonlAppender: souběžné appendy zachovají pořadí a nepoškodí řádky', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ultracode-io-'))
    try {
      const path = join(dir, 'sub', 'x.jsonl')
      const w = new JsonlAppender(path)
      const ps: Promise<void>[] = []
      for (let i = 0; i < 500; i++) ps.push(w.append({ i, pad: 'č'.repeat(i % 50) }))
      await Promise.all(ps)
      await w.flush()
      const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      assert.equal(lines.length, 500)
      assert.deepEqual(lines.map((l) => l.i), Array.from({ length: 500 }, (_, i) => i))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('StateFileWriter: slučuje žádosti, zapisuje poslední stav atomicky', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ultracode-io-'))
    try {
      const path = join(dir, 'run.json')
      let n = 0
      const w = new StateFileWriter(path, () => ({ n }))
      const ps = []
      for (let i = 0; i < 20; i++) {
        n = i
        ps.push(w.request())
      }
      await Promise.all(ps)
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { n: 19 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('writeFileAtomic nezanechá dočasné soubory; ensureTrailingNewline doplní konec řádku jen když chybí', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ultracode-io-'))
    try {
      const { readdirSync } = await import('node:fs')
      await writeFileAtomic(join(dir, 'a.json'), '{}')
      assert.deepEqual(readdirSync(dir), ['a.json'])
      const f = join(dir, 'j.jsonl')
      await ensureTrailingNewline(f) // neexistuje → bez chyby
      writeFileSync(f, '')
      await ensureTrailingNewline(f)
      assert.equal(readFileSync(f, 'utf8'), '')
      writeFileSync(f, '{"a":1}')
      await ensureTrailingNewline(f)
      assert.equal(readFileSync(f, 'utf8'), '{"a":1}\n')
      await ensureTrailingNewline(f)
      assert.equal(readFileSync(f, 'utf8'), '{"a":1}\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('JsonlAppender hlásí chybu zápisu přes onError a nikdy neodmítne', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ultracode-io-'))
    try {
      writeFileSync(join(dir, 'soubor'), 'x')
      const errors: unknown[] = []
      const w = new JsonlAppender(join(dir, 'soubor', 'nelze.jsonl'), (e) => errors.push(e))
      await w.append({ a: 1 })
      assert.equal(errors.length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
