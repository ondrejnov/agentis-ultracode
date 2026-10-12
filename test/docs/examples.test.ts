/**
 * Testy příkladů `examples/*.workflow.ts`:
 *  1) statické kontroly, které nezávisí na ostatních modulech (reference na typy, bez importů,
 *     bez nedeterministických volání, meta je čistý literál, phases ↔ phase()/opts.phase);
 *  2) `parseScript()` z `src/script/parse.ts` (načítá se dynamicky; dokud soubor neexistuje, testy se přeskočí).
 *
 * Spuštění: node --test test/docs/
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = join(import.meta.dirname, '..', '..')
const EXAMPLES_DIR = join(ROOT, 'examples')
const EXPECTED = ['audit-routes', 'fix-until-green', 'deep-research', 'php8-upgrade']

interface DiagnosticLike {
  level: 'error' | 'warning'
  message: string
  line?: number
}
interface ParsedLike {
  ok: boolean
  meta: { name: string; description: string; phases?: Array<{ title: string; detail?: string }> } | null
  diagnostics: DiagnosticLike[]
  code: string
}
type ParseFn = (source: string, filename: string) => ParsedLike

const PARSE_PATH = join(ROOT, 'src', 'script', 'parse.ts')
let parseScript: ParseFn | null = null
let parseLoadError: string | null = null
if (existsSync(PARSE_PATH)) {
  try {
    const mod = (await import(pathToFileURL(PARSE_PATH).href)) as { parseScript?: ParseFn }
    if (typeof mod.parseScript === 'function') parseScript = mod.parseScript
    else parseLoadError = 'src/script/parse.ts neexportuje parseScript'
  } catch (e) {
    parseLoadError = 'src/script/parse.ts nejde načíst: ' + (e instanceof Error ? e.message : String(e))
  }
}

const files = existsSync(EXAMPLES_DIR) ? readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.workflow.ts')).sort() : []

/** Vytáhne text literálu `export const meta = {...}` (konec = první `}` na začátku řádku). */
function metaLiteral(source: string): string {
  const start = source.indexOf('export const meta =')
  assert.ok(start >= 0, 'chybí `export const meta =`')
  const open = source.indexOf('{', start)
  const end = source.indexOf('\n}', open)
  assert.ok(end > open, 'nenalezen konec meta literálu')
  return source.slice(open, end + 2)
}

function evalLiteral(text: string): { name: string; description: string; phases?: Array<{ title: string }> } {
  // čistý literál: smí obsahovat jen JSON-like hodnoty, takže ho jde vyhodnotit bez globálů
  return new Function('"use strict"; return (' + text + ')')()
}

/** Tituly použité ve skriptu: phase('X') a `phase: 'X'`. */
function usedPhaseTitles(source: string): Set<string> {
  const titles = new Set<string>()
  for (const m of source.matchAll(/\bphase\(\s*'([^']+)'\s*\)/g)) titles.add(m[1])
  for (const m of source.matchAll(/\bphase:\s*'([^']+)'/g)) titles.add(m[1])
  return titles
}

describe('examples: soubory', () => {
  test('všechny očekávané příklady existují', () => {
    for (const name of EXPECTED) {
      assert.ok(files.includes(name + '.workflow.ts'), `chybí examples/${name}.workflow.ts`)
    }
  })
})

for (const file of files) {
  const source = readFileSync(join(EXAMPLES_DIR, file), 'utf8')

  describe(`examples/${file}: statické kontroly`, () => {
    test('začíná odkazem na typy a nemá importy', () => {
      assert.match(source, /^\/\/\/ <reference path="\.\.\/types\/workflow\.d\.ts" \/>/)
      assert.doesNotMatch(source, /^\s*import\s/m, 'skript nesmí mít import')
      assert.doesNotMatch(source, /\brequire\(|\bimport\(/, 'skript nesmí používat require()/import()')
    })

    test('bez nedeterministických volání', () => {
      const code = source.replace(/\/\/.*$/gm, '') // komentáře nevadí
      assert.doesNotMatch(code, /Date\.now\(|Math\.random\(|new Date\(\s*\)/)
    })

    test('meta je čistý literál se jménem podle souboru a popisem', () => {
      const text = metaLiteral(source)
      assert.doesNotMatch(text, /\$\{|\.\.\.|`/, 'meta nesmí obsahovat interpolaci, spread ani šablony')
      const meta = evalLiteral(text)
      assert.equal(meta.name, file.replace(/\.workflow\.ts$/, ''))
      assert.ok(meta.description && meta.description.length > 10)
      assert.ok(Array.isArray(meta.phases) && meta.phases.length > 0, 'meta.phases musí být neprázdné')
    })

    test('phases v meta odpovídají phase() a opts.phase (obousměrně)', () => {
      const meta = evalLiteral(metaLiteral(source))
      const declared = new Set((meta.phases ?? []).map((p) => p.title))
      const used = usedPhaseTitles(source)
      for (const t of used) assert.ok(declared.has(t), `fáze „${t}“ se používá, ale není v meta.phases`)
      for (const t of declared) assert.ok(used.has(t), `fáze „${t}“ je v meta.phases, ale skript ji nikdy nespustí`)
    })

    test('obsahuje return výsledku a ošetřuje null (filtr nebo podmínka)', () => {
      assert.match(source, /^return\s/m, 'skript musí vracet výsledek')
      assert.match(source, /present\(|filter\(Boolean\)|=== null|!== null|if \(!\w+\)/, 'chybí zjevné ošetření null')
    })
  })

  describe(`examples/${file}: parseScript`, () => {
    const skip = parseScript
      ? false
      : parseLoadError ?? 'src/script/parse.ts zatím neexistuje (modul SCRIPT); test spustí integrátor'

    test('projde parseScript bez error diagnostik', { skip }, () => {
      const parsed = (parseScript as ParseFn)(source, join(EXAMPLES_DIR, file))
      const errors = parsed.diagnostics.filter((d) => d.level === 'error')
      assert.deepEqual(errors, [], 'error diagnostiky: ' + JSON.stringify(errors))
      assert.equal(parsed.ok, true)
      assert.ok(parsed.meta, 'meta musí být vyparsována')
      assert.equal(parsed.meta?.name, file.replace(/\.workflow\.ts$/, ''))
      assert.ok(typeof parsed.code === 'string' && parsed.code.length > 0)
    })

    test('bez warningů o nesouladu phases', { skip }, () => {
      const parsed = (parseScript as ParseFn)(source, join(EXAMPLES_DIR, file))
      const phaseWarnings = parsed.diagnostics.filter((d) => d.level === 'warning' && /phase|fáz/i.test(d.message))
      assert.deepEqual(phaseWarnings, [], 'warningy: ' + JSON.stringify(phaseWarnings))
    })

    test('vyparsované phases odpovídají meta literálu', { skip }, () => {
      const parsed = (parseScript as ParseFn)(source, join(EXAMPLES_DIR, file))
      const expected = (evalLiteral(metaLiteral(source)).phases ?? []).map((p) => p.title)
      assert.deepEqual((parsed.meta?.phases ?? []).map((p) => p.title), expected)
    })
  })
}
