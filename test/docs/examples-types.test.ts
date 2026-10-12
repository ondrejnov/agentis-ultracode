/**
 * Typová kontrola `examples/*.workflow.ts` proti `types/workflow.d.ts`.
 *
 * `tsc -p tsconfig.json` příklady nezahrnuje (top-level `return` je pro TypeScript chyba TS1108 a ta by
 * navíc potlačila všechny sémantické diagnostiky), proto je tu kontrolujeme přes TypeScript API:
 * syntaktickou chybu TS1108 ignorujeme a sémantické diagnostiky bereme vždy.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dirname, '..', '..')
const EXAMPLES = join(ROOT, 'examples')

test('examples/*.workflow.ts nemají typové chyby', () => {
  const files = readdirSync(EXAMPLES).filter((f) => f.endsWith('.workflow.ts')).map((f) => join(EXAMPLES, f))
  assert.ok(files.length > 0)

  const cfg = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT)
  const program = ts.createProgram([...files, join(ROOT, 'types', 'workflow.d.ts')], { ...parsed.options, noEmit: true })

  const problems: string[] = []
  for (const f of files) {
    const sf = program.getSourceFile(f)
    assert.ok(sf, `nelze načíst ${f}`)
    const diags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)].filter((d) => d.code !== 1108)
    for (const d of diags) {
      const line = sf.getLineAndCharacterOfPosition(d.start ?? 0).line + 1
      problems.push(`${f.slice(ROOT.length + 1)}:${line} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
    }
  }
  assert.deepEqual(problems, [])
})
