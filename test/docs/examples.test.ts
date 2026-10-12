/**
 * Tests of the examples `examples/*.workflow.ts`:
 *  1) static checks that do not depend on other modules (type reference, no imports,
 *     no non-deterministic calls, meta is a pure literal, phases ↔ phase()/opts.phase);
 *  2) `parseScript()` from `src/script/parse.ts` (loaded dynamically; until the file exists, the tests are skipped).
 *
 * Run: node --test test/docs/
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
    else parseLoadError = 'src/script/parse.ts does not export parseScript'
  } catch (e) {
    parseLoadError = 'src/script/parse.ts cannot be loaded: ' + (e instanceof Error ? e.message : String(e))
  }
}

const files = existsSync(EXAMPLES_DIR) ? readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.workflow.ts')).sort() : []

/** Extracts the text of the literal `export const meta = {...}` (end = first `}` at the start of a line). */
function metaLiteral(source: string): string {
  const start = source.indexOf('export const meta =')
  assert.ok(start >= 0, 'missing `export const meta =`')
  const open = source.indexOf('{', start)
  const end = source.indexOf('\n}', open)
  assert.ok(end > open, 'end of meta literal not found')
  return source.slice(open, end + 2)
}

function evalLiteral(text: string): { name: string; description: string; phases?: Array<{ title: string }> } {
  // pure literal: may contain only JSON-like values, so it can be evaluated without globals
  return new Function('"use strict"; return (' + text + ')')()
}

/** Titles used in the script: phase('X') and `phase: 'X'`. */
function usedPhaseTitles(source: string): Set<string> {
  const titles = new Set<string>()
  for (const m of source.matchAll(/\bphase\(\s*'([^']+)'\s*\)/g)) titles.add(m[1])
  for (const m of source.matchAll(/\bphase:\s*'([^']+)'/g)) titles.add(m[1])
  return titles
}

describe('examples: files', () => {
  test('all expected examples exist', () => {
    for (const name of EXPECTED) {
      assert.ok(files.includes(name + '.workflow.ts'), `missing examples/${name}.workflow.ts`)
    }
  })
})

for (const file of files) {
  const source = readFileSync(join(EXAMPLES_DIR, file), 'utf8')

  describe(`examples/${file}: static checks`, () => {
    test('starts with a reference to the types and has no imports', () => {
      assert.match(source, /^\/\/\/ <reference path="\.\.\/types\/workflow\.d\.ts" \/>/)
      assert.doesNotMatch(source, /^\s*import\s/m, 'script must not have an import')
      assert.doesNotMatch(source, /\brequire\(|\bimport\(/, 'script must not use require()/import()')
    })

    test('no non-deterministic calls', () => {
      const code = source.replace(/\/\/.*$/gm, '') // comments do not matter
      assert.doesNotMatch(code, /Date\.now\(|Math\.random\(|new Date\(\s*\)/)
    })

    test('meta is a pure literal with the name matching the file and a description', () => {
      const text = metaLiteral(source)
      assert.doesNotMatch(text, /\$\{|\.\.\.|`/, 'meta must not contain interpolation, spread or template literals')
      const meta = evalLiteral(text)
      assert.equal(meta.name, file.replace(/\.workflow\.ts$/, ''))
      assert.ok(meta.description && meta.description.length > 10)
      assert.ok(Array.isArray(meta.phases) && meta.phases.length > 0, 'meta.phases must not be empty')
    })

    test('phases in meta match phase() and opts.phase (both ways)', () => {
      const meta = evalLiteral(metaLiteral(source))
      const declared = new Set((meta.phases ?? []).map((p) => p.title))
      const used = usedPhaseTitles(source)
      for (const t of used) assert.ok(declared.has(t), `phase “${t}” is used but not in meta.phases`)
      for (const t of declared) assert.ok(used.has(t), `phase “${t}” is in meta.phases but the script never runs it`)
    })

    test('returns the result and handles null (filter or condition)', () => {
      assert.match(source, /^return\s/m, 'script must return the result')
      assert.match(source, /present\(|filter\(Boolean\)|=== null|!== null|if \(!\w+\)/, 'missing obvious null handling')
    })
  })

  describe(`examples/${file}: parseScript`, () => {
    const skip = parseScript
      ? false
      : parseLoadError ?? 'src/script/parse.ts does not exist yet (SCRIPT module); the integrator will run this test'

    test('parses with parseScript without error diagnostics', { skip }, () => {
      const parsed = (parseScript as ParseFn)(source, join(EXAMPLES_DIR, file))
      const errors = parsed.diagnostics.filter((d) => d.level === 'error')
      assert.deepEqual(errors, [], 'error diagnostics: ' + JSON.stringify(errors))
      assert.equal(parsed.ok, true)
      assert.ok(parsed.meta, 'meta must be parsed')
      assert.equal(parsed.meta?.name, file.replace(/\.workflow\.ts$/, ''))
      assert.ok(typeof parsed.code === 'string' && parsed.code.length > 0)
    })

    test('no warnings about phase mismatch', { skip }, () => {
      const parsed = (parseScript as ParseFn)(source, join(EXAMPLES_DIR, file))
      const phaseWarnings = parsed.diagnostics.filter((d) => d.level === 'warning' && /phase/i.test(d.message))
      assert.deepEqual(phaseWarnings, [], 'warnings: ' + JSON.stringify(phaseWarnings))
    })

    test('parsed phases match the meta literal', { skip }, () => {
      const parsed = (parseScript as ParseFn)(source, join(EXAMPLES_DIR, file))
      const expected = (evalLiteral(metaLiteral(source)).phases ?? []).map((p) => p.title)
      assert.deepEqual((parsed.meta?.phases ?? []).map((p) => p.title), expected)
    })
  })
}
