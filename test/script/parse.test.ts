import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { Script } from 'node:vm'
import { formatDiagnostic, parseScript } from '../../src/script/parse.ts'
import { scanSource } from '../../src/script/scan.ts'

const META = "export const meta = { name: 'wf', description: 'popis' }\n"

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
  it('přijme minimální meta a vrátí spustitelný kód', () => {
    const r = parseScript(META + 'return 1\n', 'x.ts')
    assert.equal(r.ok, true)
    assert.deepEqual(r.meta, { name: 'wf', description: 'popis' })
    assert.deepEqual(r.diagnostics, [])
    const fn = new Script(r.code).runInThisContext() as () => Promise<number>
    assert.equal(typeof fn, 'function')
  })

  it('přijme meta s phases, whenToUse, komentáři, koncovými čárkami a různými typy klíčů', () => {
    const src = `// hlavička
/** dokumentace */
export const meta = {
  name: "find-flaky.v2", // komentář s } a ) a { uvnitř
  'description': \`Hledá flaky testy (a opravuje je) {ne} 'ano' "ne"\`,
  whenToUse: 'když "něco" (nebo } ne)',
  phases: [
    { title: 'Scan', detail: 'grep v logu: a, b, c' },
    { title: "Fix", model: 'sonnet', }, /* blok } */
  ],
}
phase('Scan'); phase('Fix')
`
    const r = parseScript(src, 'x.ts')
    assert.deepEqual(r.diagnostics, [])
    assert.equal(r.ok, true)
    assert.equal(r.meta?.name, 'find-flaky.v2')
    assert.equal(r.meta?.description, "Hledá flaky testy (a opravuje je) {ne} 'ano' \"ne\"")
    assert.equal(r.meta?.whenToUse, 'když "něco" (nebo } ne)')
    assert.deepEqual(r.meta?.phases, [
      { title: 'Scan', detail: 'grep v logu: a, b, c' },
      { title: 'Fix', model: 'sonnet' },
    ])
  })

  it('dekóduje escape sekvence v řetězcích', () => {
    const r = parseScript("export const meta = { name: 'a', description: 'ř\\u00e1dek\\n\\x41\\'\\\\' }\n", 'x.ts')
    assert.equal(r.ok, true)
    assert.equal(r.meta?.description, "řádek\nA'\\")
  })

  it('přijme TS anotaci typu a `as const` / `satisfies`', () => {
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

  it('odmítne meta, které není čistý literál (proměnná, volání, spread, šablona s ${}, zřetězení)', () => {
    const cases: Array<[string, RegExp]> = [
      ["const N = 'a'\nexport const meta = { name: N, description: 'd' }", /identifikátor „N“/],
      ["export const meta = { name: 'a', description: String('d') }", /volání nebo přístup k „String“/],
      ["const base = {}\nexport const meta = { ...base, name: 'a', description: 'd' }", /spread/],
      ["export const meta = { name: 'a', description: `x ${1 + 1}` }", /šablonový řetězec s \$\{\}/],
      ["export const meta = { name: 'a', description: 'x' + 'y' }", /zřetězení/],
      ["export const meta = { name: 'a', description: 'd', [key]: 1 }", /počítané klíče/],
      ["export const meta = { name: 'a', description }", /zkrácený zápis/],
      ["export const meta = { name: 'a', description: 'd', phases: [ { title: T } ] }", /identifikátor „T“/],
      ["export const meta = makeMeta()", /objektový literál/],
      ["export const meta = { name: 'a', description: 'd' }.name", /čistý literál/],
      ["export const meta = { name: 'a', description: (() => 'd')() }", /nepovolený výraz/],
      ["export const meta = { name: 'a', description: 'd', run() {} }", /metoda „run\(\)“/],
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

  it('chybějící nebo neexportované meta je chyba', () => {
    assert.ok(hasError('return 1\n', /chybí `export const meta/))
    assert.ok(hasError("const meta = { name: 'a', description: 'd' }\nreturn 1\n", /musí být exportováno/))
    assert.ok(hasError('', /prázdný/))
    assert.ok(hasError('   \n\n', /prázdný/))
  })

  it('meta, které není prvním příkazem, je jen varování (a stále funguje)', () => {
    const src = "const X = 1\nexport const meta = { name: 'a', description: 'd' }\nreturn X\n"
    const r = parseScript(src, 'x.ts')
    assert.equal(r.ok, true)
    const w = r.diagnostics.find((d) => d.level === 'warning')
    assert.match(w?.message ?? '', /prvním příkazem/)
    assert.equal(w?.line, 2)
  })

  it('komentáře a prázdné řádky před meta nejsou varování', () => {
    const r = parseScript("\n\n// komentář\n/* blok */\nexport const meta = { name: 'a', description: 'd' }\n", 'x.ts')
    assert.deepEqual(r.diagnostics, [])
  })

  it('validuje name, description a phases (typy a čísla řádků)', () => {
    const e1 = parseScript("export const meta = { name: 'a b', description: 'd' }\n", 'x.ts')
    assert.match(e1.diagnostics[0]!.message, /meta\.name „a b“ není platné/)
    assert.equal(e1.diagnostics[0]!.line, 1)

    const e2 = parseScript("\n\nexport const meta = {\n  name: 'ok',\n  description: '   ',\n}\n", 'x.ts')
    assert.match(e2.diagnostics[0]!.message, /description nesmí být prázdné/)
    assert.equal(e2.diagnostics[0]!.line, 5)

    assert.ok(hasError("export const meta = { name: 5, description: 'd' }", /meta\.name musí být řetězec/))
    assert.ok(hasError("export const meta = { description: 'd' }", /meta\.name je povinné/))
    assert.ok(hasError("export const meta = { name: 'a' }", /meta\.description je povinné/))
    assert.ok(hasError("export const meta = { name: 'a', description: 'd', phases: 'x' }", /meta\.phases musí být pole/))
    assert.ok(hasError("export const meta = { name: 'a', description: 'd', phases: ['x'] }", /phases\[0\] musí být objekt/))
    assert.ok(hasError("export const meta = { name: 'a', description: 'd', phases: [{ detail: 'x' }] }", /phases\[0\]\.title je povinné/))
    assert.ok(hasError("export const meta = { name: 'a', description: 'd', phases: [{ title: 1 }] }", /title musí být neprázdný řetězec/))
    assert.ok(hasError("export const meta = { name: 'a', description: 'd', phases: [{ title: 'A', model: 1 }] }", /model musí být řetězec/))
    assert.ok(hasError("export const meta = { name: '', description: 'd' }", /není platné/))
    assert.ok(hasError("export const meta = { name: '-x', description: 'd' }", /není platné/))
  })

  it('neznámý klíč v meta a duplicitní klíč jsou varování', () => {
    const r = parseScript("export const meta = { name: 'a', description: 'd', color: 'red', name: 'b' }\n", 'x.ts')
    assert.equal(r.ok, true)
    assert.equal(r.meta?.name, 'b')
    const msgs = r.diagnostics.map((d) => d.message).join('\n')
    assert.match(msgs, /neznámý klíč „color“/)
    assert.match(msgs, /duplicitní klíč „name“/)
  })
})

describe('parseScript: zakázané konstrukty', () => {
  it('statický import (všechny tvary), import(), import.meta', () => {
    assert.ok(hasError(META + "import fs from 'node:fs'\n", /statický `import`/))
    assert.ok(hasError(META + "import { a, b } from './x.ts'\n", /statický `import`/))
    assert.ok(hasError(META + "import * as x from 'y'\n", /statický `import`/))
    assert.ok(hasError(META + "import 'side-effect'\n", /statický `import`/))
    assert.ok(hasError(META + "import type { T } from './types.ts'\n", /statický `import`/))
    assert.ok(hasError(META + "const m = await import('x')\n", /dynamický `import\(\)`/))
    assert.ok(hasError(META + 'const u = import.meta.url\n', /import\.meta/))
  })

  it('require() a export (default i pojmenovaný)', () => {
    assert.ok(hasError(META + "const fs = require('fs')\n", /`require\(\)`/))
    assert.ok(hasError(META + 'export default 1\n', /export default/))
    assert.ok(hasError(META + 'export const x = 1\n', /`export` není povolen/))
    assert.ok(hasError(META + 'export function f() {}\n', /`export` není povolen/))
  })

  it('správné číslo řádku u zakázaných konstruktů', () => {
    const r = parseScript(META + "\n\nconst a = 1\nconst fs = require('fs')\n", 'x.ts')
    const e = r.diagnostics.find((d) => /require/.test(d.message))
    assert.equal(e?.line, 5)
    assert.equal(r.ok, false)
    assert.equal(r.code, '')
  })

  it('text v řetězcích, komentářích, regexech a vlastnostech nevyvolá falešný poplach', () => {
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

  it('vlastní funkce/metoda pojmenovaná require nebo import není volání modulového systému', () => {
    const src = META + 'function require(x) { return x }\nconst r = require("a")\nconst o = { import(y) { return y } }\nreturn [r, o]\n'
    assert.deepEqual(errors(src), [])
  })

  it('regex literál s uvozovkami nesrazí skener; dělení se od regexu rozliší', () => {
    const src = META + `const re = /['"\`]/g
const q = 10 / 2 / 5
const t = "text"; const u = t.length / 2
import x from 'y'
`
    const r = parseScript(src, 'x.ts')
    const e = r.diagnostics.find((d) => /statický `import`/.test(d.message))
    assert.equal(e?.line, 5)
  })

  it('vnořené šablony s kódem v ${} se kontrolují jako kód', () => {
    const src = META + 'const s = `a ${ `b ${ Date.now() } c` } d`\nreturn s\n'
    const w = warnings(src)
    assert.equal(w.length, 1)
    assert.match(w[0]!.message, /Date\.now\(\)/)
    assert.equal(w[0]!.line, 2)
  })

  it('neukončený řetězec/komentář/šablona je chyba', () => {
    assert.ok(hasError(META + "const a = 'abc\nreturn a\n", /neukončený řetězec/))
    assert.ok(hasError(META + '/* nikdy neskončí\nreturn 1\n', /neukončený komentář/))
    assert.ok(hasError(META + 'const a = `abc\nreturn a\n', /neukončená šablona/))
  })
})

describe('parseScript: varování', () => {
  it('Date.now, Math.random a new Date() bez argumentu', () => {
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

  it('new Date(arg), Date.UTC a Date.parse varování nevyvolají; Date.now s mezerami ano', () => {
    assert.deepEqual(warnings(META + 'const a = new Date(0); const b = Date.UTC(2020, 1, 1); const c = Date.parse("2020-01-01")\n'), [])
    assert.equal(warnings(META + 'const a = Date . now ()\n').length, 1)
  })

  it('varování nezneplatní skript', () => {
    const r = parseScript(META + 'const t = Date.now()\nreturn t\n', 'x.ts')
    assert.equal(r.ok, true)
    assert.notEqual(r.code, '')
  })

  it('phase() mimo meta.phases a meta.phases bez phase()', () => {
    const src = `export const meta = { name: 'a', description: 'd', phases: [{ title: 'Scan' }, { title: 'Fix' }, { title: 'Review' }] }
phase('Scan')
phase('Neznámá')
const r = await agent('x', { phase: 'Fix' })
`
    const msgs = warnings(src).map((w) => w.message)
    assert.equal(msgs.length, 2, msgs.join('\n'))
    assert.ok(msgs.some((m) => /phase „Neznámá“ není uvedena v meta\.phases/.test(m)))
    assert.ok(msgs.some((m) => /meta\.phases obsahuje „Review“/.test(m)))
  })

  it('dynamický titul phase(x) potlačí varování „fáze bez volání“; bez meta.phases se nic nehlásí', () => {
    const dyn = `export const meta = { name: 'a', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] }
for (const t of ['A', 'B']) phase(t)
`
    assert.deepEqual(warnings(dyn), [])
    assert.deepEqual(warnings(META + "phase('cokoli')\n"), [])
  })

  it('phase s proměnnou (volba nebo volání) potlačí varování „fáze bez volání“', () => {
    const src = `export const meta = { name: 'a', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] }
const t = 'A'
await agent('x', { phase: t })
`
    assert.deepEqual(warnings(src), [])
  })

  it('varování ukazuje na řádek titulu v meta', () => {
    const src = `export const meta = {
  name: 'a',
  description: 'd',
  phases: [
    { title: 'A' },
    { title: 'Nepoužitá' },
  ],
}
phase('A')
`
    const w = warnings(src)
    assert.equal(w.length, 1)
    assert.equal(w[0]!.line, 6)
  })
})

describe('parseScript: TypeScript a převod na kód', () => {
  it('odstraní typy, interface, generika, as const; hodnoty zůstanou', async () => {
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

  it('zachová čísla řádků (tělo obalené na prvním řádku, žádné vložené řádky)', () => {
    const src = META + 'const a = 1\n\n\nconst b = 2\n'
    const r = parseScript(src, 'x.ts')
    const lines = r.code.split('\n')
    assert.equal(lines.length, src.split('\n').length + 1) // jen koncový `\n})`
    assert.match(lines[0]!, /^\(async function \(\) \{'use strict';/)
    assert.match(lines[0]!, /const meta/)
    assert.equal(lines[1]!.trim(), 'const a = 1')
    assert.equal(lines[4]!.trim(), 'const b = 2')
  })

  it('top-level return a await jsou v pořádku; BOM se ignoruje', async () => {
    const r = parseScript('﻿' + META + 'const v = await Promise.resolve(41)\nreturn v + 1\n', 'x.ts')
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics))
    const fn = new Script(r.code).runInThisContext() as () => Promise<number>
    assert.equal(await fn(), 42)
  })

  it('skript v režimu strict (neinicializovaná proměnná je chyba až za běhu)', async () => {
    const r = parseScript(META + 'undeclared = 1\n', 'x.ts')
    assert.equal(r.ok, true)
    const fn = new Script(r.code).runInThisContext() as () => Promise<unknown>
    await assert.rejects(fn(), ReferenceError)
  })

  it('enum, namespace a parameter property → chyba „nepodporovaná TS syntaxe“ s řádkem', () => {
    const e = errors(META + 'const a = 1\nenum Color { Red, Green }\nreturn Color.Red\n')
    assert.equal(e.length, 1)
    assert.match(e[0]!.message, /nepodporovaná TS syntaxe: enum/)
    assert.equal(e[0]!.line, 3)

    const n = errors(META + 'namespace N { export const a = 1 }\nreturn N.a\n')
    assert.match(n[0]!.message, /nepodporovaná TS syntaxe: namespace/)

    const p = errors(META + 'class A { constructor(private x: number) {} }\nreturn new A(1)\n')
    assert.match(p[0]!.message, /nepodporovaná TS syntaxe: parameter property/)
    assert.equal(p[0]!.line, 2)
  })

  it('syntaktická chyba má číslo řádku původního skriptu', () => {
    const e = errors(META + 'const a = 1\nconst b = = 2\nreturn a\n')
    assert.equal(e.length, 1)
    assert.match(e[0]!.message, /syntaktická chyba/)
    assert.equal(e[0]!.line, 3)
  })

  it('chyba zachycená až kompilací (duplicitní deklarace) má řádek', () => {
    const e = errors(META + 'let a = 1\nlet a = 2\n')
    assert.equal(e.length, 1)
    assert.match(e[0]!.message, /already been declared|syntaktická chyba/)
    assert.equal(e[0]!.line, 3)
  })

  it('formatDiagnostic', () => {
    assert.equal(formatDiagnostic({ level: 'error', message: 'x', line: 3 }, 'a.ts'), 'chyba: a.ts:3: x')
    assert.equal(formatDiagnostic({ level: 'warning', message: 'y' }, 'a.ts'), 'varování: a.ts: y')
  })

  it('nikdy nehází, ani na nesmyslném vstupu', () => {
    const garbage: unknown[] = [undefined, null, 42, {}, '\0\0\0', '`${', '/*', "'", '{{{{', 'export const meta = {', 'export const meta = { name: ', '  ']
    for (const g of garbage) {
      const r = parseScript(g as string, 'x.ts')
      assert.equal(r.ok, false)
      assert.ok(r.diagnostics.some((d) => d.level === 'error'))
    }
  })

  it('reálný skript z Claude Code (php8-upgrade) projde bez diagnostiky', () => {
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
  it('maska má stejnou délku a zachová konce řádků', () => {
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
