import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { Script } from 'node:vm'
import { formatDiagnostic, parseScript } from '../../src/script/parse.ts'
import { scanSource } from '../../src/script/scan.ts'

const META = "export const meta = { name: 'wf', description: 'a description' }\n"

function errors(src: string) {
  return parseScript(src, 'x.ts').diagnostics.filter((d) => d.level === 'error')
}
function warnings(src: string) {
  return parseScript(src, 'x.ts').diagnostics.filter((d) => d.level === 'warning')
}
function hasError(src: string, re: RegExp): boolean {
  return errors(src).some((d) => re.test(d.message))
}

describe('parseScript: meta', () => {
  it('accepts minimal meta and returns executable code', () => {
    const r = parseScript(META + 'return 1\n', 'x.ts')
    assert.equal(r.ok, true)
    assert.deepEqual(r.meta, { name: 'wf', description: 'a description' })
    assert.deepEqual(r.diagnostics, [])
    const fn = new Script(r.code).runInThisContext() as () => Promise<number>
    assert.equal(typeof fn, 'function')
  })

  it('accepts meta with phases, whenToUse, comments, trailing commas and various key types', () => {
    const src = `// header
/** docs */
export const meta = {
  name: "find-flaky.v2", // comment with } and ) and { inside
  'description': \`Finds flaky tests (and fixes them) {no} 'yes' "no"\`,
  whenToUse: 'when "something" (or } no)',
  phases: [
    { title: 'Scan', detail: 'grep in log: a, b, c' },
    { title: "Fix", model: 'sonnet', }, /* block } */
  ],
}
phase('Scan'); phase('Fix')
`
    const r = parseScript(src, 'x.ts')
    assert.deepEqual(r.diagnostics, [])
    assert.equal(r.ok, true)
    assert.equal(r.meta?.name, 'find-flaky.v2')
    assert.equal(r.meta?.description, "Finds flaky tests (and fixes them) {no} 'yes' \"no\"")
    assert.equal(r.meta?.whenToUse, 'when "something" (or } no)')
    assert.deepEqual(r.meta?.phases, [
      { title: 'Scan', detail: 'grep in log: a, b, c' },
      { title: 'Fix', model: 'sonnet' },
    ])
  })

  it('decodes escape sequences in strings', () => {
    const r = parseScript("export const meta = { name: 'a', description: 'ř\\u00e1dek\\n\\x41\\'\\\\' }\n", 'x.ts')
    assert.equal(r.ok, true)
    assert.equal(r.meta?.description, "řádek\nA'\\")
  })

  it('accepts TS type annotation and `as const` / `satisfies`', () => {
    for (const head of [
      "export const meta: WorkflowMeta = { name: 'a', description: 'd' }",
      "export const meta = { name: 'a', description: 'd' } as const",
      "export const meta = { name: 'a', description: 'd' } satisfies WorkflowMeta",
      "export const meta: { name: string; description: string } = { name: 'a', description: 'd' };",
    ]) {
      const r = parseScript(head + '\nreturn 1\n', 'x.ts')
      assert.deepEqual(r.diagnostics, [], head)
      assert.equal(r.ok, true, head)
      assert.equal(r.meta?.name, 'a')
    }
  })

  it('rejects meta that is not a plain literal (variable, call, spread, template with ${}, concatenation)', () => {
    const cases: Array<[string, RegExp]> = [
      ["const N = 'a'\nexport const meta = { name: N, description: 'd' }", /identifier “N”/],
      ["export const meta = { name: 'a', description: String('d') }", /calling or accessing “String”/],
      ["const base = {}\nexport const meta = { ...base, name: 'a', description: 'd' }", /spread/],
      ["export const meta = { name: 'a', description: `x ${1 + 1}` }", /template string with \$\{\}/],
      ["export const meta = { name: 'a', description: 'x' + 'y' }", /concatenation/],
      ["export const meta = { name: 'a', description: 'd', [key]: 1 }", /computed keys/],
      ["export const meta = { name: 'a', description }", /shorthand/],
      ["export const meta = { name: 'a', description: 'd', phases: [ { title: T } ] }", /identifier “T”/],
      ["export const meta = makeMeta()", /object literal/],
      ["export const meta = { name: 'a', description: 'd' }.name", /plain literal/],
      ["export const meta = { name: 'a', description: (() => 'd')() }", /disallowed expression/],
      ["export const meta = { name: 'a', description: 'd', run() {} }", /method “run\(\)” is not allowed/],
    ]
    for (const [src, re] of cases) {
      const r = parseScript(src + '\nreturn 1\n', 'x.ts')
      assert.equal(r.ok, false, src)
      assert.equal(r.meta, null, src)
      assert.ok(
        r.diagnostics.some((d) => d.level === 'error' && re.test(d.message)),
        `${src}\n→ ${JSON.stringify(r.diagnostics)}`,
      )
    }
  })

  it('missing or non-exported meta is an error', () => {
    assert.ok(hasError('return 1\n', /missing `export const meta/))
    assert.ok(hasError("const meta = { name: 'a', description: 'd' }\nreturn 1\n", /must be exported/))
    assert.ok(hasError('', /is empty/))
    assert.ok(hasError('   \n\n', /is empty/))
  })

  it('meta that is not the first statement is only a warning (and still works)', () => {
    const src = "const X = 1\nexport const meta = { name: 'a', description: 'd' }\nreturn X\n"
    const r = parseScript(src, 'x.ts')
    assert.equal(r.ok, true)
    const w = r.diagnostics.find((d) => d.level === 'warning')
    assert.match(w?.message ?? '', /first statement/)
    assert.equal(w?.line, 2)
  })

  it('comments and blank lines before meta are not warnings', () => {
    const r = parseScript("\n\n// comment\n/* block */\nexport const meta = { name: 'a', description: 'd' }\n", 'x.ts')
    assert.deepEqual(r.diagnostics, [])
  })

  it('validates name, description and phases (types and line numbers)', () => {
    const e1 = parseScript("export const meta = { name: 'a b', description: 'd' }\n", 'x.ts')
    assert.match(e1.diagnostics[0]!.message, /meta\.name “a b” is invalid/)
    assert.equal(e1.diagnostics[0]!.line, 1)

    const e2 = parseScript("\n\nexport const meta = {\n  name: 'ok',\n  description: '   ',\n}\n", 'x.ts')
    assert.match(e2.diagnostics[0]!.message, /description must not be empty/)
    assert.equal(e2.diagnostics[0]!.line, 5)

    assert.ok(hasError("export const meta = { name: 5, description: 'd' }", /meta\.name must be a string/))
    assert.ok(hasError("export const meta = { description: 'd' }", /meta\.name is required/))
    assert.ok(hasError("export const meta = { name: 'a' }", /meta\.description is required/))
    assert.ok(hasError("export const meta = { name: 'a', description: 'd', phases: 'x' }", /meta\.phases must be an array/))
    assert.ok(hasError("export const meta = { name: 'a', description: 'd', phases: ['x'] }", /phases\[0\] must be an object/))
    assert.ok(hasError("export const meta = { name: 'a', description: 'd', phases: [{ detail: 'x' }] }", /phases\[0\]\.title is required/))
    assert.ok(hasError("export const meta = { name: 'a', description: 'd', phases: [{ title: 1 }] }", /title must be a non-empty string/))
    assert.ok(hasError("export const meta = { name: 'a', description: 'd', phases: [{ title: 'A', model: 1 }] }", /model must be a string/))
    assert.ok(hasError("export const meta = { name: '', description: 'd' }", /is invalid/))
    assert.ok(hasError("export const meta = { name: '-x', description: 'd' }", /is invalid/))
  })

  it('unknown key and duplicate key in meta are warnings', () => {
    const r = parseScript("export const meta = { name: 'a', description: 'd', color: 'red', name: 'b' }\n", 'x.ts')
    assert.equal(r.ok, true)
    assert.equal(r.meta?.name, 'b')
    const msgs = r.diagnostics.map((d) => d.message).join('\n')
    assert.match(msgs, /unknown key “color”/)
    assert.match(msgs, /duplicate key “name”/)
  })
})

describe('parseScript: forbidden constructs', () => {
  it('static import (all forms), import(), import.meta', () => {
    assert.ok(hasError(META + "import fs from 'node:fs'\n", /static `import`/))
    assert.ok(hasError(META + "import { a, b } from './x.ts'\n", /static `import`/))
    assert.ok(hasError(META + "import * as x from 'y'\n", /static `import`/))
    assert.ok(hasError(META + "import 'side-effect'\n", /static `import`/))
    assert.ok(hasError(META + "import type { T } from './types.ts'\n", /static `import`/))
    assert.ok(hasError(META + "const m = await import('x')\n", /dynamic `import\(\)`/))
    assert.ok(hasError(META + 'const u = import.meta.url\n', /import\.meta/))
  })

  it('require() and export (default and named)', () => {
    assert.ok(hasError(META + "const fs = require('fs')\n", /`require\(\)`/))
    assert.ok(hasError(META + 'export default 1\n', /export default/))
    assert.ok(hasError(META + 'export const x = 1\n', /`export` is not allowed/))
    assert.ok(hasError(META + 'export function f() {}\n', /`export` is not allowed/))
  })

  it('correct line number for forbidden constructs', () => {
    const r = parseScript(META + "\n\nconst a = 1\nconst fs = require('fs')\n", 'x.ts')
    const e = r.diagnostics.find((d) => /require/.test(d.message))
    assert.equal(e?.line, 5)
    assert.equal(r.ok, false)
    assert.equal(r.code, '')
  })

  it('text in strings, comments, regexes and properties does not trigger a false alarm', () => {
    const src =
      META +
      `// import x from 'y'; require('z'); export default 1
/* import('x') ; Date.now() */
const s1 = "import x from 'y'"
const s2 = 'require("fs") and export default and Date.now() and Math.random()'
const s3 = \`import() \${1} require('x')\`
const re = /import\\s+x from "y"|require\\(/
const o = { import: 1, export: 2, require: 3 }
const p = o.import + o.export + o.require
const lib = { require(x) { return x }, import(y) { return y } }
lib.require('a'); lib.import('b')
return [s1, s2, s3, re.source, p]
`
    const r = parseScript(src, 'x.ts')
    assert.deepEqual(r.diagnostics, [], JSON.stringify(r.diagnostics))
    assert.equal(r.ok, true)
  })

  it('a custom function/method named require or import is not a module-system call', () => {
    const src = META + 'function require(x) { return x }\nconst r = require("a")\nconst o = { import(y) { return y } }\nreturn [r, o]\n'
    assert.deepEqual(errors(src), [])
  })

  it('regex literal with quotes does not confuse the scanner; division is told apart from regex', () => {
    const src = META + `const re = /['"\`]/g
const q = 10 / 2 / 5
const t = "text"; const u = t.length / 2
import x from 'y'
`
    const r = parseScript(src, 'x.ts')
    const e = r.diagnostics.find((d) => /static `import`/.test(d.message))
    assert.equal(e?.line, 5)
  })

  it('nested templates with code in ${} are checked as code', () => {
    const src = META + 'const s = `a ${ `b ${ Date.now() } c` } d`\nreturn s\n'
    const w = warnings(src)
    assert.equal(w.length, 1)
    assert.match(w[0]!.message, /Date\.now\(\)/)
    assert.equal(w[0]!.line, 2)
  })

  it('unterminated string/comment/template is an error', () => {
    assert.ok(hasError(META + "const a = 'abc\nreturn a\n", /unterminated string/))
    assert.ok(hasError(META + '/* never ends\nreturn 1\n', /unterminated comment/))
    assert.ok(hasError(META + 'const a = `abc\nreturn a\n', /unterminated template/))
  })
})

describe('parseScript: warnings', () => {
  it('Date.now, Math.random and new Date() without argument', () => {
    const w = warnings(META + 'const a = Date.now()\nconst b = Math.random()\nconst c = new Date()\nconst d = new Date;\n')
    const msgs = w.map((x) => x.message)
    assert.equal(w.length, 4)
    assert.match(msgs[0]!, /Date\.now\(\)/)
    assert.match(msgs[1]!, /Math\.random\(\)/)
    assert.match(msgs[2]!, /new Date\(\)/)
    assert.match(msgs[3]!, /new Date\(\)/)
    assert.deepEqual(
      w.map((x) => x.line),
      [2, 3, 4, 5],
    )
  })

  it('new Date(arg), Date.UTC and Date.parse do not warn; Date.now with spaces does', () => {
    assert.deepEqual(warnings(META + 'const a = new Date(0); const b = Date.UTC(2020, 1, 1); const c = Date.parse("2020-01-01")\n'), [])
    assert.equal(warnings(META + 'const a = Date . now ()\n').length, 1)
  })

  it('warning does not invalidate the script', () => {
    const r = parseScript(META + 'const t = Date.now()\nreturn t\n', 'x.ts')
    assert.equal(r.ok, true)
    assert.notEqual(r.code, '')
  })

  it('phase() outside meta.phases and meta.phases without phase()', () => {
    const src = `export const meta = { name: 'a', description: 'd', phases: [{ title: 'Scan' }, { title: 'Fix' }, { title: 'Review' }] }
phase('Scan')
phase('Unknown')
const r = await agent('x', { phase: 'Fix' })
`
    const msgs = warnings(src).map((w) => w.message)
    assert.equal(msgs.length, 2, msgs.join('\n'))
    assert.ok(msgs.some((m) => /phase “Unknown” is not listed in meta\.phases/.test(m)))
    assert.ok(msgs.some((m) => /meta\.phases contains “Review”/.test(m)))
  })

  it('dynamic phase(x) title suppresses the “phase never called” warning; without meta.phases nothing is reported', () => {
    const dyn = `export const meta = { name: 'a', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] }
for (const t of ['A', 'B']) phase(t)
`
    assert.deepEqual(warnings(dyn), [])
    assert.deepEqual(warnings(META + "phase('anything')\n"), [])
  })

  it('phase with a variable (option or call) suppresses the “phase never called” warning', () => {
    const src = `export const meta = { name: 'a', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] }
const t = 'A'
await agent('x', { phase: t })
`
    assert.deepEqual(warnings(src), [])
  })

  it('warning points to the phase title line in meta', () => {
    const src = `export const meta = {
  name: 'a',
  description: 'd',
  phases: [
    { title: 'A' },
    { title: 'Unused' },
  ],
}
phase('A')
`
    const w = warnings(src)
    assert.equal(w.length, 1)
    assert.equal(w[0]!.line, 6)
  })
})

describe('parseScript: TypeScript and conversion to code', () => {
  it('removes types, interfaces, generics, as const; values remain', async () => {
    const src =
      META +
      `interface Item { id: number; tags?: string[] }
type Result = { ok: boolean }
const items: Item[] = [{ id: 1 }, { id: 2, tags: ['x'] }]
const f = <T,>(x: T): T => x
function g(n: number): Result { return { ok: n > 0 } }
const K = { a: 1 } as const
return { n: items.length, same: f<number>(5), r: g(1).ok, a: K.a, last: items[1]!.tags![0] }
`
    const r = parseScript(src, 'x.ts')
    assert.deepEqual(r.diagnostics, [])
    assert.equal(r.ok, true)
    const fn = new Script(r.code).runInThisContext() as () => Promise<unknown>
    assert.deepEqual(await fn(), { n: 2, same: 5, r: true, a: 1, last: 'x' })
  })

  it('keeps line numbers (body wrapped on the first line, no inserted lines)', () => {
    const src = META + 'const a = 1\n\n\nconst b = 2\n'
    const r = parseScript(src, 'x.ts')
    const lines = r.code.split('\n')
    assert.equal(lines.length, src.split('\n').length + 1) // only the trailing `\n})`
    assert.match(lines[0]!, /^\(async function \(\) \{'use strict';/)
    assert.match(lines[0]!, /const meta/)
    assert.equal(lines[1]!.trim(), 'const a = 1')
    assert.equal(lines[4]!.trim(), 'const b = 2')
  })

  it('top-level return and await are fine; BOM is ignored', async () => {
    const r = parseScript('﻿' + META + 'const v = await Promise.resolve(41)\nreturn v + 1\n', 'x.ts')
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics))
    const fn = new Script(r.code).runInThisContext() as () => Promise<number>
    assert.equal(await fn(), 42)
  })

  it('script in strict mode (an undeclared variable is an error only at run time)', async () => {
    const r = parseScript(META + 'undeclared = 1\n', 'x.ts')
    assert.equal(r.ok, true)
    const fn = new Script(r.code).runInThisContext() as () => Promise<unknown>
    await assert.rejects(fn(), ReferenceError)
  })

  it('enum, namespace and parameter property → “unsupported TS syntax” error with a line', () => {
    const e = errors(META + 'const a = 1\nenum Color { Red, Green }\nreturn Color.Red\n')
    assert.equal(e.length, 1)
    assert.match(e[0]!.message, /unsupported TS syntax: enum/)
    assert.equal(e[0]!.line, 3)

    const n = errors(META + 'namespace N { export const a = 1 }\nreturn N.a\n')
    assert.match(n[0]!.message, /unsupported TS syntax: namespace/)

    const p = errors(META + 'class A { constructor(private x: number) {} }\nreturn new A(1)\n')
    assert.match(p[0]!.message, /unsupported TS syntax: parameter property/)
    assert.equal(p[0]!.line, 2)
  })

  it('syntax error has the line number of the original script', () => {
    const e = errors(META + 'const a = 1\nconst b = = 2\nreturn a\n')
    assert.equal(e.length, 1)
    assert.match(e[0]!.message, /syntax error/)
    assert.equal(e[0]!.line, 3)
  })

  it('error caught only at compilation (duplicate declaration) has a line', () => {
    const e = errors(META + 'let a = 1\nlet a = 2\n')
    assert.equal(e.length, 1)
    assert.match(e[0]!.message, /already been declared|syntax error/)
    assert.equal(e[0]!.line, 3)
  })

  it('formatDiagnostic', () => {
    assert.equal(formatDiagnostic({ level: 'error', message: 'x', line: 3 }, 'a.ts'), 'error: a.ts:3: x')
    assert.equal(formatDiagnostic({ level: 'warning', message: 'y' }, 'a.ts'), 'warning: a.ts: y')
  })

  it('never throws, even on nonsense input', () => {
    const garbage: unknown[] = [undefined, null, 42, {}, '\0\0\0', '`${', '/*', "'", '{{{{', 'export const meta = {', 'export const meta = { name: ', '  ']
    for (const g of garbage) {
      const r = parseScript(g as string, 'x.ts')
      assert.equal(r.ok, false)
      assert.ok(r.diagnostics.some((d) => d.level === 'error'))
    }
  })

  it('real script from Claude Code (php8-upgrade) passes without diagnostics', () => {
    const file =
      '/root/.claude/projects/-var-www-new-svitidla-com/ce557bae-5b58-49af-abdc-c58098f5e47a/workflows/scripts/php8-upgrade-wf_003aa2c5-8ce.js'
    if (!existsSync(file)) return
    const r = parseScript(readFileSync(file, 'utf8'), file)
    assert.deepEqual(r.diagnostics, [])
    assert.equal(r.ok, true)
    assert.equal(r.meta?.name, 'php8-upgrade')
    assert.equal(r.meta?.phases?.length, 3)
  })
})

describe('scanSource', () => {
  it('mask has the same length and keeps line endings', () => {
    const src = "const a = 'x\\'y' // c\n/* a\nb */ const b = `t ${ 1 + `n` } u`\n"
    const s = scanSource(src)
    assert.equal(s.masked.length, src.length)
    assert.equal(s.masked.split('\n').length, src.split('\n').length)
    assert.deepEqual(s.problems, [])
    assert.equal(s.substitutions.length, 1)
    assert.ok(!s.masked.includes('//'))
    assert.ok(s.masked.includes('const a ='))
    assert.ok(s.masked.includes('1 + '))
  })
})
