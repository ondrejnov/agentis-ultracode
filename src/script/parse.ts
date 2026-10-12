/**
 * Loading and static validation of a workflow script.
 *
 * `parseScript()` never throws: all errors and warnings are in `diagnostics`.
 *
 * Postup:
 *  1. lexical mask of the source (comments/strings/regexes → spaces), see scan.ts,
 *  2. finding and evaluating `export const meta = {…}` as a PLAIN literal (meta-literal.ts) + validation,
 *  3. checking forbidden constructs (import/require/export…) and warnings (Date.now, Math.random, phase vs. meta),
 *  4. conversion to executable code: `export` is removed, the body is wrapped in `(async function () {'use strict'; … \n})`
 *     on the SAME line as the first body line (line numbers are kept), and TS is removed via `module.stripTypeScriptTypes`.
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
  /** JS prepared for vm: an expression with an async function, TS removed. Empty string when `ok` is false. */
  code: string
}

const META_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const WRAP_PREFIX = "(async function () {'use strict';"
const WRAP_SUFFIX = '\n})'

/** One-line diagnostic format for the CLI / ScriptValidationError. */
export function formatDiagnostic(d: ScriptDiagnostic, filename: string): string {
  const where = d.line ? `${filename}:${d.line}` : filename
  return `${d.level === 'error' ? 'error' : 'warning'}: ${where}: ${d.message}`
}

/** `module.stripTypeScriptTypes` prints an ExperimentalWarning to stderr on first call – we suppress only that one. */
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

/** Extracts the line number from the error's `stack` (`<file>:LINE\n…`). */
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
    if (/enum/i.test(raw)) what = 'enum (use an object `as const`)'
    else if (/namespace/i.test(raw)) what = 'namespace (use plain objects/functions)'
    else if (/parameter property/i.test(raw)) what = 'parameter property in a constructor (declare the field explicitly)'
    else if (/import.*=|require/i.test(raw)) what = '`import x = require()`'
    return {
      message: `unsupported TS syntax: ${what}. Only “erasable” syntax is allowed (types, interface, as, satisfies).`,
      line,
      unsupported: true,
    }
  }
  return { message: `syntax error: ${raw}`, line, unsupported: false }
}

interface MetaStatement {
  /** Offset slova `export`. */
  exportStart: number
  /** Offset after the last character of the literal. */
  end: number
  node: LiteralNode | null
  firstStatement: boolean
}

/** Skips whitespace in the mask (comments are already spaces in it). */
function skipWs(masked: string, from: number): number {
  let i = from
  while (i < masked.length && /\s/.test(masked[i]!)) i++
  return i
}

/** Finds the offset of the first “statement” in the mask (first non-empty character). */
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
    err('meta must be an object', node.start)
    return null
  }

  const seen = new Set<string>()
  const byKey = new Map<string, { value: LiteralNode; keyStart: number }>()
  for (const p of node.props) {
    if (seen.has(p.key)) warn(`meta: duplicate key “${p.key}” (the last one applies)`, p.keyStart)
    seen.add(p.key)
    byKey.set(p.key, { value: p.value, keyStart: p.keyStart })
  }
  const known = new Set(['name', 'description', 'whenToUse', 'phases'])
  for (const p of node.props) {
    if (!known.has(p.key)) warn(`meta: unknown key “${p.key}” (ignored)`, p.keyStart)
  }

  const out: WorkflowMeta = { name: '', description: '' }

  const name = byKey.get('name')
  if (!name) err('meta.name is required', node.start)
  else if (name.value.kind !== 'string') err('meta.name must be a string', name.value.start)
  else if (!META_NAME_RE.test(name.value.value)) {
    err(`meta.name “${name.value.value}” is invalid (allowed: letters, digits, _ . -; must start with a letter/digit)`, name.value.start)
  } else out.name = name.value.value

  const description = byKey.get('description')
  if (!description) err('meta.description is required', node.start)
  else if (description.value.kind !== 'string') err('meta.description must be a string', description.value.start)
  else if (description.value.value.trim() === '') err('meta.description must not be empty', description.value.start)
  else out.description = description.value.value

  const whenToUse = byKey.get('whenToUse')
  if (whenToUse) {
    if (whenToUse.value.kind !== 'string') err('meta.whenToUse must be a string', whenToUse.value.start)
    else out.whenToUse = whenToUse.value.value
  }

  const phases = byKey.get('phases')
  if (phases) {
    if (phases.value.kind !== 'array') {
      err('meta.phases must be an array of objects { title, detail?, model? }', phases.value.start)
    } else {
      const list: PhaseMeta[] = []
      const titles = new Set<string>()
      phases.value.items.forEach((item, idx) => {
        if (item.kind !== 'object') {
          err(`meta.phases[${idx}] must be an object { title, detail?, model? }`, item.start)
          return
        }
        const phase: PhaseMeta = { title: '' }
        let titleOk = false
        for (const p of item.props) {
          if (p.key === 'title') {
            if (p.value.kind !== 'string' || p.value.value.trim() === '') {
              err(`meta.phases[${idx}].title must be a non-empty string`, p.value.start)
            } else {
              phase.title = p.value.value
              titleOk = true
            }
          } else if (p.key === 'detail' || p.key === 'model') {
            if (p.value.kind !== 'string') err(`meta.phases[${idx}].${p.key} must be a string`, p.value.start)
            else phase[p.key] = p.value.value
          } else {
            warn(`meta.phases[${idx}]: unknown key “${p.key}” (ignored)`, p.keyStart)
          }
        }
        if (!item.props.some((p) => p.key === 'title')) err(`meta.phases[${idx}].title is required`, item.start)
        if (titleOk) {
          if (titles.has(phase.title)) warn(`meta.phases: duplicate title “${phase.title}”`, item.start)
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

/** Finds the `export const meta = {…}`. statement. Never throws; writes errors to `diags`. */
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
        message: 'meta must be exported: `export const meta = { name, description, … }`',
        line: lineOf(plain.index),
      })
    } else {
      diags.push({
        level: 'error',
        message: 'missing `export const meta = { name, description, phases? }` (must be the first statement of the script)',
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
      message: '`export const meta` should be the first statement of the script (only comments may come before it)',
      line: lineOf(exportStart),
    })
  }

  // After `meta`: optional type annotation `: Type`, then `=`.
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
    diags.push({ level: 'error', message: 'meta must have the form `export const meta = { … }`', line: lineOf(m.index) })
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
      diags.push({ level: 'error', message: `meta could not be loaded: ${String((e as Error)?.message ?? e)}`, line: lineOf(i) })
    }
    return { exportStart, end, node: null, firstStatement }
  }

  // `as const` / `satisfies X` after the literal; nothing else (call, dot, operator) may follow.
  let j = skipWs(masked, end)
  const tail = /^(?:as\s+const\b|as\s+[\w$.]+(?:<[^>]*>)?(?:\[\])*|satisfies\s+[\w$.]+(?:<[^>]*>)?)/.exec(masked.slice(j, j + 200))
  if (tail) j = skipWs(masked, j + tail[0].length)
  const next = masked[j]
  if (next !== undefined && next !== ';' && /[.(\[+\-*/%?&|,<>=!^~]/.test(next)) {
    diags.push({
      level: 'error',
      message: 'meta must be a plain literal: an expression follows the object (call, property access or operator)',
      line: lineOf(j),
    })
    return { exportStart, end, node: null, firstStatement }
  }
  return { exportStart, end, node, firstStatement }
}

/** Offsets of occurrences of identifier `word`, not preceded by `.` (property) or an identifier character. */
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

/** Reads the string literal at the offset (in the source); returns its value, or undefined (dynamic expression). */
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
      // `'a' + b` or `'a'.x` is not a plain literal
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
  /** `function require(x) {…}` or metoda `{ require(x) { … } }` – its own definition, not a call to the module system. */
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
    if (nx === '(') error('dynamic `import()` is not allowed (the script has no access to modules)', at)
    else if (nx === '.') error('`import.meta` is not available in a workflow script', at)
    else error('static `import` is not allowed: the script has no imports, the API (agent, parallel, …) is global', at)
  }
  // A script that declares `require` itself (function/const/let/var) does not call the module system.
  const declaresRequire = /(?<![\w$.])(?:function\s*\*?\s*|const\s+|let\s+|var\s+)require(?![\w$])/.test(masked)
  for (const at of declaresRequire ? [] : findWord(masked, 'require')) {
    if (isDefinition(at, 7)) continue
    if (nextNonWs(at + 7) === '(') error('`require()` is not allowed (the script has no access to modules or the filesystem)', at)
  }
  for (const at of findWord(masked, 'export')) {
    if (at === metaExportStart) continue
    if (nextNonWs(at + 6) === ':') continue // vlastnost objektu
    if (/^\s*default\b/.test(masked.slice(at + 6, at + 40))) error('`export default` is not allowed (return the result via `return`)', at)
    else error('`export` is not allowed (the only exception is `export const meta`)', at)
  }

  for (const m of masked.matchAll(/(?<![\w$.])Date\s*\.\s*now(?![\w$])/g)) {
    warn('`Date.now()` throws at run time (it would break resume); pass the time via `args`', m.index)
  }
  for (const m of masked.matchAll(/(?<![\w$.])Math\s*\.\s*random(?![\w$])/g)) {
    warn('`Math.random()` throws at run time (it would break resume); handle randomness by varying with the index or via `args`', m.index)
  }
  for (const m of masked.matchAll(/(?<![\w$.])new\s+Date\s*(?:\(\s*\)|(?=\s*[;,)\]}]|\s*$))/gm)) {
    warn('`new Date()` without an argument throws at run time (it would break resume); pass the time via `args`', m.index)
  }

  // phase('X') / { phase: 'X' } versus meta.phases
  const used = new Map<string, number>()
  let dynamicPhase = false
  for (const at of findWord(masked, 'phase')) {
    const after = skipWs(masked, at + 5)
    const c = masked[after]
    if (c !== '(' && c !== ':') continue
    // `{ phase: x }` in an object and `phase: string` in a type; we only care about a string literal
    const argStart = skipWs(masked, after + 1)
    const value = readStringAt(src, argStart)
    if (value === undefined) {
      // dynamic title (variable, expression): we can't tell which phases will be used → suppresses the “phase without call” warning
      if (masked[argStart] !== ')') dynamicPhase = true
      continue
    }
    if (!used.has(value)) used.set(value, at)
  }
  const declared = meta?.phases
  if (declared && declared.length > 0) {
    const titles = new Set(declared.map((p) => p.title))
    for (const [title, at] of used) {
      if (!titles.has(title)) warn(`phase “${title}” is not listed in meta.phases`, at)
    }
    if (!dynamicPhase) {
      for (const p of declared) {
        if (!used.has(p.title)) warn(`meta.phases contains “${p.title}”, but the script never calls phase('${p.title}')`, titleOffsets.get(p.title) ?? 0)
      }
    }
  }
}

export function parseScript(source: string, filename: string): ParsedScript {
  const diagnostics: ScriptDiagnostic[] = []
  const fail = (): ParsedScript => ({ ok: false, meta: null, diagnostics, code: '' })

  if (typeof source !== 'string') {
    diagnostics.push({ level: 'error', message: 'script source must be a string' })
    return fail()
  }
  if (source.trim() === '') {
    diagnostics.push({ level: 'error', message: 'script is empty', line: 1 })
    return fail()
  }

  const src = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  const lineStarts = buildLineIndex(src)
  const lineOf = (offset: number): number => lineOfOffset(lineStarts, Math.max(0, offset))

  const scan = scanSource(src)
  for (const p of scan.problems) {
    diagnostics.push({ level: 'error', message: `${p.message} (lexical error)`, line: lineOf(p.offset) })
  }
  const masked = scan.masked

  // 1) meta
  const stmt = locateMeta(src, masked, lineOf, diagnostics)
  let meta: WorkflowMeta | null = null
  const titleOffsets = new Map<string, number>()
  if (stmt?.node) meta = validateMeta(stmt.node, lineOf, diagnostics, titleOffsets)

  // 2) forbidden constructs and warnings
  staticChecks(src, masked, meta, stmt ? stmt.exportStart : null, titleOffsets, lineOf, diagnostics)

  // 3) conversion to executable code
  let body = src
  if (stmt) body = src.slice(0, stmt.exportStart) + ' '.repeat(6) + src.slice(stmt.exportStart + 6)
  const wrapped = WRAP_PREFIX + body + WRAP_SUFFIX

  let code = ''
  try {
    code = stripTypes(wrapped)
  } catch (e) {
    const t = translateStripError(e)
    if (t.unsupported) {
      // `namespace N { export … }` otherwise the static check would report it as “export is not allowed” – the TS message is more precise.
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
    // compilation only (catches early errors such as duplicate declarations); nothing is run
    new Script(code, { filename })
  } catch (e) {
    const err = e as { message?: string; stack?: string }
    const line = lineFromStack(err?.stack)
    const dup = diagnostics.some((d) => d.level === 'error' && d.line !== undefined && d.line === line)
    if (!dup) diagnostics.push({ level: 'error', message: `syntax error: ${err?.message ?? String(e)}`, line })
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
