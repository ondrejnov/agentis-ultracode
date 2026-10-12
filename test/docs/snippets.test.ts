/**
 * Úryvky kódu v dokumentaci (```ts bloky v README.md a skills/**.md) musí být platné:
 *  - každý blok projde typovou kontrolou proti types/workflow.d.ts (úplné skripty s `export const meta`
 *    jako moduly, ostatní jako tělo async funkce s pomocnými funkcemi z patterns.md),
 *  - úplné skripty navíc projdou parseScript (pokud src/script/parse.ts existuje) bez chyb a varování.
 *
 * Blok, který je záměrně nekompilovatelný (anti-vzor), se označí `ts nocheck`.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const ROOT = join(import.meta.dirname, '..', '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.md')) out.push(p)
  }
  return out
}

const docFiles = [
  ...(existsSync(join(ROOT, 'README.md')) ? [join(ROOT, 'README.md')] : []),
  ...(existsSync(join(ROOT, 'skills')) ? walk(join(ROOT, 'skills')) : []),
]

interface Block {
  file: string
  line: number
  code: string
  full: boolean
  id: string
}

function extractBlocks(file: string): Block[] {
  const text = readFileSync(file, 'utf8')
  const out: Block[] = []
  const re = /^```(?:ts|typescript)([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (/\bnocheck\b/.test(m[1])) continue
    const line = text.slice(0, m.index).split('\n').length + 1
    const code = m[2].replace(/^\/\/\/ <reference [^\n]*\n/gm, '')
    out.push({
      file,
      line,
      code,
      full: /^export const meta\b/m.test(code),
      id: `${relative(ROOT, file)}:${line}`,
    })
  }
  return out
}

const blocks = docFiles.flatMap(extractBlocks)

const PRELUDE = `const present = <T>(xs: Array<T | null | undefined>): T[] => xs.filter((x): x is T => x !== null && x !== undefined)
const chunk = <T>(xs: T[], size: number): T[][] => { const o: T[][] = []; for (let i = 0; i < xs.length; i += size) o.push(xs.slice(i, i + size)); return o }
const normKey = (s: string): string => s.toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, ' ').trim().slice(0, 160)
`

function virtualSource(b: Block): { text: string; offset: number } {
  if (b.full) return { text: b.code, offset: 0 }
  const needsPrelude = !/\bconst present\b/.test(b.code)
  const head = (needsPrelude ? PRELUDE : '') + 'export {}\nasync function __snippet() {\n'
  return { text: head + b.code + '\n}\n', offset: head.split('\n').length - 1 }
}

describe('dokumentace: ts úryvky', () => {
  test('nalezeny alespoň nějaké úryvky', () => {
    assert.ok(blocks.length > 0, 'v README.md / skills/** nejsou žádné ```ts bloky')
  })

  test('všechny úryvky projdou typovou kontrolou', () => {
    const cfg = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile)
    const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT)
    const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, noUnusedLocals: false }

    const virtual = new Map<string, { text: string; offset: number; block: Block }>()
    blocks.forEach((b, i) => virtual.set(join(ROOT, `.docsnippet-${i}.ts`), { ...virtualSource(b), block: b }))

    const host = ts.createCompilerHost(options)
    const origGet = host.getSourceFile.bind(host)
    host.getSourceFile = (name, lang, onErr, shouldCreate) => {
      const v = virtual.get(name)
      if (v) return ts.createSourceFile(name, v.text, lang, true)
      return origGet(name, lang, onErr, shouldCreate)
    }
    const origExists = host.fileExists.bind(host)
    host.fileExists = (name) => virtual.has(name) || origExists(name)
    const origRead = host.readFile.bind(host)
    host.readFile = (name) => virtual.get(name)?.text ?? origRead(name)

    const program = ts.createProgram([join(ROOT, 'types', 'workflow.d.ts'), ...virtual.keys()], options, host)
    const problems: string[] = []
    for (const [name, v] of virtual) {
      const sf = program.getSourceFile(name)
      assert.ok(sf, 'chybí zdroj ' + name)
      const diags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]
      for (const d of diags) {
        // top-level `return` v úplném skriptu je v pořádku (tělo skriptu je async funkce)
        if (v.block.full && d.code === 1108) continue
        const pos = d.start !== undefined ? sf.getLineAndCharacterOfPosition(d.start).line : 0
        const mdLine = v.block.line + Math.max(0, pos - v.offset)
        problems.push(`${relative(ROOT, v.block.file)}:${mdLine} TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
      }
    }
    assert.deepEqual(problems, [])
  })

  const parsePath = join(ROOT, 'src', 'script', 'parse.ts')
  test('úplné skripty v dokumentaci projdou parseScript', { skip: existsSync(parsePath) ? false : 'src/script/parse.ts zatím neexistuje' }, async () => {
    const mod = (await import(pathToFileURL(parsePath).href)) as {
      parseScript: (s: string, f: string) => { ok: boolean; diagnostics: Array<{ level: string; message: string }> }
    }
    const full = blocks.filter((b) => b.full)
    assert.ok(full.length > 0, 'dokumentace neobsahuje žádný úplný skript')
    for (const b of full) {
      const r = mod.parseScript(b.code, b.id)
      assert.equal(r.ok, true, `${b.id}: ${JSON.stringify(r.diagnostics)}`)
      assert.deepEqual(r.diagnostics.filter((d) => d.level === 'warning'), [], `${b.id}: varování`)
    }
  })
})
