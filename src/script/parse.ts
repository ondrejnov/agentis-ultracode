/**
 * Načtení a statická validace skriptu workflow.
 *
 * `parseScript()` nikdy nehází: všechny chyby a varování jsou v `diagnostics`.
 *
 * Postup:
 *  1. lexikální maska zdroje (komentáře/řetězce/regexy → mezery), viz scan.ts,
 *  2. nalezení a vyhodnocení `export const meta = {…}` jako ČISTÉHO literálu (meta-literal.ts) + validace,
 *  3. kontrola zakázaných konstruktů (import/require/export…) a varování (Date.now, Math.random, phase vs. meta),
 *  4. převod na spustitelný kód: `export` se odstraní, tělo se obalí do `(async function () {'use strict'; … \n})`
 *     na STEJNÉM řádku jako první řádek těla (čísla řádků zůstanou), a TS se odstraní `module.stripTypeScriptTypes`.
 */

import { stripTypeScriptTypes } from 'node:module'
import { Script } from 'node:vm'
import type { PhaseMeta, WorkflowMeta } from '../types.ts'
import { LiteralError, nodeToValue, parseLiteral } from './meta-literal.ts'
import type { LiteralNode } from './meta-literal.ts'
import { buildLineIndex, lineOfOffset, scanSource } from './scan.ts'

export interface ScriptDiagnostic {
  level: 'error' | 'warning'
  message: string
  line?: number
}

export interface ParsedScript {
  ok: boolean
  meta: WorkflowMeta | null
  diagnostics: ScriptDiagnostic[]
  /** JS připravený pro vm: výraz s async funkcí, TS odstraněno. Prázdný řetězec, když `ok` je false. */
  code: string
}

const META_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const WRAP_PREFIX = "(async function () {'use strict';"
const WRAP_SUFFIX = '\n})'

/** Jednořádkový zápis diagnostiky pro CLI / ScriptValidationError. */
export function formatDiagnostic(d: ScriptDiagnostic, filename: string): string {
  const where = d.line ? `${filename}:${d.line}` : filename
  return `${d.level === 'error' ? 'chyba' : 'varování'}: ${where}: ${d.message}`
}

/** `module.stripTypeScriptTypes` při prvním volání vypisuje ExperimentalWarning na stderr – potlačíme jen ten. */
function stripTypes(code: string): string {
  const original = process.emitWarning
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : (warning as { message?: string } | undefined)?.message ?? ''
    if (text.includes('stripTypeScriptTypes')) return
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest)
  }) as typeof process.emitWarning
  try {
    return stripTypeScriptTypes(code, { mode: 'strip' })
  } finally {
    process.emitWarning = original
  }
}

/** Z `stack` chyby (`<soubor>:ŘÁDEK\n…`) vytáhne číslo řádku. */
function lineFromStack(stack: unknown): number | undefined {
  if (typeof stack !== 'string') return undefined
  const m = /^[^\n]*?:(\d+)(?::\d+)?\n/.exec(stack)
  return m ? Number(m[1]) : undefined
}

function translateStripError(err: unknown): { message: string; line?: number; unsupported: boolean } {
  const e = err as { message?: string; code?: string; stack?: string }
  const raw = String(e?.message ?? err)
  const line = lineFromStack(e?.stack)
  if (e?.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
    let what = raw
    if (/enum/i.test(raw)) what = 'enum (použij objekt `as const`)'
    else if (/namespace/i.test(raw)) what = 'namespace (použij běžné objekty/funkce)'
    else if (/parameter property/i.test(raw)) what = 'parameter property v konstruktoru (deklaruj pole explicitně)'
    else if (/import.*=|require/i.test(raw)) what = '`import x = require()`'
    return {
      message: `nepodporovaná TS syntaxe: ${what}. Povolena je jen „erasable“ syntaxe (typy, interface, as, satisfies).`,
      line,
      unsupported: true,
    }
  }
  return { message: `syntaktická chyba: ${raw}`, line, unsupported: false }
}

interface MetaStatement {
  /** Offset slova `export`. */
  exportStart: number
  /** Offset za posledním znakem literálu. */
  end: number
  node: LiteralNode | null
  firstStatement: boolean
}

/** Přeskočí bílé znaky v masce (komentáře jsou v ní již mezery). */
function skipWs(masked: string, from: number): number {
  let i = from
  while (i < masked.length && /\s/.test(masked[i]!)) i++
  return i
}

/** Najde offset prvního „příkazu“ v masce (první neprázdný znak). */
function firstCodeOffset(masked: string): number {
  return skipWs(masked, masked.charCodeAt(0) === 0xfeff ? 1 : 0)
}

function validateMeta(
  node: LiteralNode,
  lineOf: (offset: number) => number,
  diags: ScriptDiagnostic[],
  titleOffsets: Map<string, number>,
): WorkflowMeta | null {
  const errors0 = diags.filter((d) => d.level === 'error').length
  const err = (message: string, offset: number): void => {
    diags.push({ level: 'error', message, line: lineOf(offset) })
  }
  const warn = (message: string, offset: number): void => {
    diags.push({ level: 'warning', message, line: lineOf(offset) })
  }

  if (node.kind !== 'object') {
    err('meta musí být objekt', node.start)
    return null
  }

  const seen = new Set<string>()
  const byKey = new Map<string, { value: LiteralNode; keyStart: number }>()
  for (const p of node.props) {
    if (seen.has(p.key)) warn(`meta: duplicitní klíč „${p.key}“ (platí poslední)`, p.keyStart)
    seen.add(p.key)
    byKey.set(p.key, { value: p.value, keyStart: p.keyStart })
  }
  const known = new Set(['name', 'description', 'whenToUse', 'phases'])
  for (const p of node.props) {
    if (!known.has(p.key)) warn(`meta: neznámý klíč „${p.key}“ (je ignorován)`, p.keyStart)
  }

  const out: WorkflowMeta = { name: '', description: '' }

  const name = byKey.get('name')
  if (!name) err('meta.name je povinné', node.start)
  else if (name.value.kind !== 'string') err('meta.name musí být řetězec', name.value.start)
  else if (!META_NAME_RE.test(name.value.value)) {
    err(`meta.name „${name.value.value}“ není platné (povoleno: písmena, číslice, _ . -; musí začínat písmenem/číslicí)`, name.value.start)
  } else out.name = name.value.value

  const description = byKey.get('description')
  if (!description) err('meta.description je povinné', node.start)
  else if (description.value.kind !== 'string') err('meta.description musí být řetězec', description.value.start)
  else if (description.value.value.trim() === '') err('meta.description nesmí být prázdné', description.value.start)
  else out.description = description.value.value

  const whenToUse = byKey.get('whenToUse')
  if (whenToUse) {
    if (whenToUse.value.kind !== 'string') err('meta.whenToUse musí být řetězec', whenToUse.value.start)
    else out.whenToUse = whenToUse.value.value
  }

  const phases = byKey.get('phases')
  if (phases) {
    if (phases.value.kind !== 'array') {
      err('meta.phases musí být pole objektů { title, detail?, model? }', phases.value.start)
    } else {
      const list: PhaseMeta[] = []
      const titles = new Set<string>()
      phases.value.items.forEach((item, idx) => {
        if (item.kind !== 'object') {
          err(`meta.phases[${idx}] musí být objekt { title, detail?, model? }`, item.start)
          return
        }
        const phase: PhaseMeta = { title: '' }
        let titleOk = false
        for (const p of item.props) {
          if (p.key === 'title') {
            if (p.value.kind !== 'string' || p.value.value.trim() === '') {
              err(`meta.phases[${idx}].title musí být neprázdný řetězec`, p.value.start)
            } else {
              phase.title = p.value.value
              titleOk = true
            }
          } else if (p.key === 'detail' || p.key === 'model') {
            if (p.value.kind !== 'string') err(`meta.phases[${idx}].${p.key} musí být řetězec`, p.value.start)
            else phase[p.key] = p.value.value
          } else {
            warn(`meta.phases[${idx}]: neznámý klíč „${p.key}“ (je ignorován)`, p.keyStart)
          }
        }
        if (!item.props.some((p) => p.key === 'title')) err(`meta.phases[${idx}].title je povinné`, item.start)
        if (titleOk) {
          if (titles.has(phase.title)) warn(`meta.phases: duplicitní titul „${phase.title}“`, item.start)
          titles.add(phase.title)
          if (!titleOffsets.has(phase.title)) titleOffsets.set(phase.title, item.start)
          list.push(phase)
        }
      })
      out.phases = list
    }
  }

  const errors1 = diags.filter((d) => d.level === 'error').length
  return errors1 > errors0 ? null : out
}

/** Najde příkaz `export const meta = {…}`. Nikdy nehází; chyby zapisuje do `diags`. */
function locateMeta(
  src: string,
  masked: string,
  lineOf: (offset: number) => number,
  diags: ScriptDiagnostic[],
): MetaStatement | null {
  const re = /(?<![\w$.])export\s+(?:const|let|var)\s+meta(?![\w$])/g
  const m = re.exec(masked)
  if (!m) {
    const plain = /(?<![\w$.])(?:const|let|var)\s+meta(?![\w$])/.exec(masked)
    if (plain) {
      diags.push({
        level: 'error',
        message: 'meta musí být exportováno: `export const meta = { name, description, … }`',
        line: lineOf(plain.index),
      })
    } else {
      diags.push({
        level: 'error',
        message: 'chybí `export const meta = { name, description, phases? }` (musí být první příkaz skriptu)',
        line: 1,
      })
    }
    return null
  }
  const exportStart = m.index
  const firstStatement = exportStart === firstCodeOffset(masked)
  if (!firstStatement) {
    diags.push({
      level: 'warning',
      message: '`export const meta` by měl být prvním příkazem skriptu (před ním smí být jen komentáře)',
      line: lineOf(exportStart),
    })
  }

  // Za `meta`: volitelná anotace typu `: Typ`, pak `=`.
  let i = skipWs(masked, m.index + m[0].length)
  if (masked[i] === ':') {
    let depth = 0
    i++
    for (; i < masked.length; i++) {
      const ch = masked[i]!
      if (ch === '{' || ch === '[' || ch === '(' || ch === '<') depth++
      else if (ch === '}' || ch === ']' || ch === ')') depth--
      else if (ch === '>' && masked[i - 1] !== '=') depth--
      else if (ch === '=' && depth <= 0 && masked[i + 1] !== '>') break
    }
  }
  if (masked[i] !== '=') {
    diags.push({ level: 'error', message: 'meta musí mít tvar `export const meta = { … }`', line: lineOf(m.index) })
    return { exportStart, end: i, node: null, firstStatement }
  }
  i = skipWs(masked, i + 1)

  let node: LiteralNode | null = null
  let end = i
  try {
    const parsed = parseLiteral(src, i)
    node = parsed.node
    end = parsed.end
  } catch (e) {
    if (e instanceof LiteralError) {
      diags.push({ level: 'error', message: e.message, line: lineOf(e.offset) })
    } else {
      diags.push({ level: 'error', message: `meta se nepodařilo načíst: ${String((e as Error)?.message ?? e)}`, line: lineOf(i) })
    }
    return { exportStart, end, node: null, firstStatement }
  }

  // `as const` / `satisfies X` za literálem; nic dalšího (volání, tečka, operátor) být nesmí.
  let j = skipWs(masked, end)
  const tail = /^(?:as\s+const\b|as\s+[\w$.]+(?:<[^>]*>)?(?:\[\])*|satisfies\s+[\w$.]+(?:<[^>]*>)?)/.exec(masked.slice(j, j + 200))
  if (tail) j = skipWs(masked, j + tail[0].length)
  const next = masked[j]
  if (next !== undefined && next !== ';' && /[.(\[+\-*/%?&|,<>=!^~]/.test(next)) {
    diags.push({
      level: 'error',
      message: 'meta musí být čistý literál: za objektem následuje výraz (volání, přístup k vlastnosti nebo operátor)',
      line: lineOf(j),
    })
    return { exportStart, end, node: null, firstStatement }
  }
  return { exportStart, end, node, firstStatement }
}

/** Offsety výskytů identifikátoru `word`, kterým nepředchází `.` (vlastnost) ani znak identifikátoru. */
function findWord(masked: string, word: string): number[] {
  const re = new RegExp(`(?<![\\w$])${word}(?![\\w$])`, 'g')
  const out: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(masked))) {
    let k = m.index - 1
    while (k >= 0 && /\s/.test(masked[k]!)) k--
    if (k >= 0 && masked[k] === '.') continue
    out.push(m.index)
  }
  return out
}

/** Přečte řetězcový literál na offsetu (ve zdroji); vrací jeho hodnotu, nebo undefined (dynamický výraz). */
function readStringAt(src: string, offset: number): string | undefined {
  const q = src[offset]
  if (q !== '"' && q !== "'" && q !== '`') return undefined
  let k = offset + 1
  let out = ''
  while (k < src.length) {
    const ch = src[k]!
    if (ch === '\\') {
      out += src[k + 1] ?? ''
      k += 2
      continue
    }
    if (ch === q) {
      // `'a' + b` nebo `'a'.x` není prostý literál
      const after = skipWs(src, k + 1)
      if (src[after] !== undefined && /[+.([]/.test(src[after]!)) return undefined
      return out
    }
    if (q === '`' && ch === '$' && src[k + 1] === '{') return undefined
    if (ch === '\n' && q !== '`') return undefined
    out += ch
    k++
  }
  return undefined
}

function staticChecks(
  src: string,
  masked: string,
  meta: WorkflowMeta | null,
  metaExportStart: number | null,
  titleOffsets: Map<string, number>,
  lineOf: (offset: number) => number,
  diags: ScriptDiagnostic[],
): void {
  const error = (message: string, offset: number): void => {
    diags.push({ level: 'error', message, line: lineOf(offset) })
  }
  const warn = (message: string, offset: number): void => {
    diags.push({ level: 'warning', message, line: lineOf(offset) })
  }
  const nextNonWs = (offset: number): string | undefined => masked[skipWs(masked, offset)]
  /** `function require(x) {…}` nebo metoda `{ require(x) { … } }` – vlastní definice, ne volání modulového systému. */
  const isDefinition = (at: number, wordLength: number): boolean => {
    if (/(?:^|[^\w$])function\s*\*?\s*$/.test(masked.slice(Math.max(0, at - 24), at))) return true
    const open = skipWs(masked, at + wordLength)
    if (masked[open] !== '(') return false
    let depth = 0
    for (let k = open; k < masked.length; k++) {
      if (masked[k] === '(') depth++
      else if (masked[k] === ')' && --depth === 0) return masked[skipWs(masked, k + 1)] === '{'
    }
    return false
  }

  for (const at of findWord(masked, 'import')) {
    const nx = nextNonWs(at + 6)
    if (nx === ':') continue // vlastnost objektu
    if (isDefinition(at, 6)) continue
    if (nx === '(') error('dynamický `import()` není povolen (skript nemá přístup k modulům)', at)
    else if (nx === '.') error('`import.meta` není ve skriptu workflow dostupné', at)
    else error('statický `import` není povolen: skript nemá importy, API (agent, parallel, …) jsou globály', at)
  }
  // Skript, který si `require` sám deklaruje (function/const/let/var), modulový systém nevolá.
  const declaresRequire = /(?<![\w$.])(?:function\s*\*?\s*|const\s+|let\s+|var\s+)require(?![\w$])/.test(masked)
  for (const at of declaresRequire ? [] : findWord(masked, 'require')) {
    if (isDefinition(at, 7)) continue
    if (nextNonWs(at + 7) === '(') error('`require()` není povolen (skript nemá přístup k modulům ani k souborovému systému)', at)
  }
  for (const at of findWord(masked, 'export')) {
    if (at === metaExportStart) continue
    if (nextNonWs(at + 6) === ':') continue // vlastnost objektu
    if (/^\s*default\b/.test(masked.slice(at + 6, at + 40))) error('`export default` není povolen (výsledek vrať přes `return`)', at)
    else error('`export` není povolen (výjimkou je jen `export const meta`)', at)
  }

  for (const m of masked.matchAll(/(?<![\w$.])Date\s*\.\s*now(?![\w$])/g)) {
    warn('`Date.now()` za běhu vyhodí chybu (rozbilo by resume); předej čas přes `args`', m.index)
  }
  for (const m of masked.matchAll(/(?<![\w$.])Math\s*\.\s*random(?![\w$])/g)) {
    warn('`Math.random()` za běhu vyhodí chybu (rozbilo by resume); náhodu řeš variací podle indexu nebo přes `args`', m.index)
  }
  for (const m of masked.matchAll(/(?<![\w$.])new\s+Date\s*(?:\(\s*\)|(?=\s*[;,)\]}]|\s*$))/gm)) {
    warn('`new Date()` bez argumentu za běhu vyhodí chybu (rozbilo by resume); předej čas přes `args`', m.index)
  }

  // phase('X') / { phase: 'X' } versus meta.phases
  const used = new Map<string, number>()
  let dynamicPhase = false
  for (const at of findWord(masked, 'phase')) {
    const after = skipWs(masked, at + 5)
    const c = masked[after]
    if (c !== '(' && c !== ':') continue
    // `{ phase: x }` v objektu i `phase: string` v typu; zajímá nás jen literál řetězce
    const argStart = skipWs(masked, after + 1)
    const value = readStringAt(src, argStart)
    if (value === undefined) {
      // dynamický titul (proměnná, výraz): nelze říct, které fáze se použijí → potlačí varování „fáze bez volání“
      if (masked[argStart] !== ')') dynamicPhase = true
      continue
    }
    if (!used.has(value)) used.set(value, at)
  }
  const declared = meta?.phases
  if (declared && declared.length > 0) {
    const titles = new Set(declared.map((p) => p.title))
    for (const [title, at] of used) {
      if (!titles.has(title)) warn(`phase „${title}“ není uvedena v meta.phases`, at)
    }
    if (!dynamicPhase) {
      for (const p of declared) {
        if (!used.has(p.title)) warn(`meta.phases obsahuje „${p.title}“, ale skript nikdy nevolá phase('${p.title}')`, titleOffsets.get(p.title) ?? 0)
      }
    }
  }
}

export function parseScript(source: string, filename: string): ParsedScript {
  const diagnostics: ScriptDiagnostic[] = []
  const fail = (): ParsedScript => ({ ok: false, meta: null, diagnostics, code: '' })

  if (typeof source !== 'string') {
    diagnostics.push({ level: 'error', message: 'zdroj skriptu musí být řetězec' })
    return fail()
  }
  if (source.trim() === '') {
    diagnostics.push({ level: 'error', message: 'skript je prázdný', line: 1 })
    return fail()
  }

  const src = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  const lineStarts = buildLineIndex(src)
  const lineOf = (offset: number): number => lineOfOffset(lineStarts, Math.max(0, offset))

  const scan = scanSource(src)
  for (const p of scan.problems) {
    diagnostics.push({ level: 'error', message: `${p.message} (lexikální chyba)`, line: lineOf(p.offset) })
  }
  const masked = scan.masked

  // 1) meta
  const stmt = locateMeta(src, masked, lineOf, diagnostics)
  let meta: WorkflowMeta | null = null
  const titleOffsets = new Map<string, number>()
  if (stmt?.node) meta = validateMeta(stmt.node, lineOf, diagnostics, titleOffsets)

  // 2) zakázané konstrukty a varování
  staticChecks(src, masked, meta, stmt ? stmt.exportStart : null, titleOffsets, lineOf, diagnostics)

  // 3) převod na spustitelný kód
  let body = src
  if (stmt) body = src.slice(0, stmt.exportStart) + ' '.repeat(6) + src.slice(stmt.exportStart + 6)
  const wrapped = WRAP_PREFIX + body + WRAP_SUFFIX

  let code = ''
  try {
    code = stripTypes(wrapped)
  } catch (e) {
    const t = translateStripError(e)
    if (t.unsupported) {
      // `namespace N { export … }` jinak nahlásí statická kontrola jako „export není povolen“ – přesnější je zpráva o TS.
      for (let k = diagnostics.length - 1; k >= 0; k--) {
        const d = diagnostics[k]!
        if (d.level === 'error' && d.line === t.line && d.message.startsWith('`export`')) diagnostics.splice(k, 1)
      }
    }
    const dup = diagnostics.some((d) => d.level === 'error' && d.line !== undefined && d.line === t.line)
    if (!dup) diagnostics.push({ level: 'error', message: t.message, line: t.line })
    return finish(null)
  }
  try {
    // jen kompilace (zachytí early errors typu duplicitní deklarace); nic se nespouští
    new Script(code, { filename })
  } catch (e) {
    const err = e as { message?: string; stack?: string }
    const line = lineFromStack(err?.stack)
    const dup = diagnostics.some((d) => d.level === 'error' && d.line !== undefined && d.line === line)
    if (!dup) diagnostics.push({ level: 'error', message: `syntaktická chyba: ${err?.message ?? String(e)}`, line })
    return finish(null)
  }
  return finish(code)

  function finish(result: string | null): ParsedScript {
    const hasError = diagnostics.some((d) => d.level === 'error')
    if (hasError || result === null || meta === null) {
      return { ok: false, meta: hasError ? null : meta, diagnostics, code: '' }
    }
    return { ok: true, meta, diagnostics, code: result }
  }
}
