/**
 * Minimal lexical scanner for JavaScript/TypeScript for static analysis of workflow scripts.
 *
 * Uses no parser; it only knows what is “code” and what is a string, template, comment or regex literal.
 * The result is a “masked” copy of the source (same length, hence the same offsets and line numbers), in which the content
 * of strings/comments/regexes is replaced by spaces. Keywords can then be safely searched for with regexes
 * (`import`, `require(`, `Date.now`, …) without false alarms from text inside strings.
 *
 * Masking rules:
 *  - comments: entirely replaced by spaces (line ends kept),
 *  - strings '…' and "…": quotes stay, content → spaces,
 *  - templates `…`: backticks stay, text content → spaces, expressions inside `${ … }` stay as code,
 *  - regex literals: entirely → spaces (slashes stay unchanged only for division).
 */

export interface ScanProblem {
  message: string
  offset: number
}

export interface ScanResult {
  /** Text of the same length as the source; the content of strings, comments and regexes is replaced by spaces. */
  masked: string
  /** Offsets of `${` sequences in all template literals. */
  substitutions: number[]
  /** Unterminated string/comment/template etc. */
  problems: ScanProblem[]
}

/** Keywords after which a following `/` starts a regex (not division). */
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
])

type Prev =
  | { kind: 'start' }
  | { kind: 'punct'; value: string }
  | { kind: 'word'; value: string }
  | { kind: 'value' }

/** Line terminator per ECMAScript (LF, CR, U+2028, U+2029). */
const isLineBreak = (ch: string): boolean => {
  const code = ch.charCodeAt(0)
  return code === 10 || code === 13 || code === 0x2028 || code === 0x2029
}
/** Whitespace other than line terminators, or a line terminator (NBSP and BOM count as space). */
const isWhitespace = (ch: string): boolean => {
  const code = ch.charCodeAt(0)
  return code === 32 || code === 9 || code === 11 || code === 12 || code === 0xa0 || code === 0xfeff || isLineBreak(ch)
}
const isIdentStart = (ch: string): boolean => /[A-Za-z_$]/.test(ch) || ch.charCodeAt(0) >= 0x80
const isIdentPart = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) >= 0x80
const DIGIT = /[0-9]/

export function scanSource(src: string): ScanResult {
  const n = src.length
  const chars = src.split('')
  const substitutions: number[] = []
  const problems: ScanProblem[] = []

  /** Replaces characters <from, to) with spaces, keeps line terminators. */
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      const ch = chars[k]!
      if (!isLineBreak(ch)) chars[k] = ' '
    }
  }

  /** String starting with a quote at `i`; returns the index after the closing quote. */
  const scanString = (i: number, quote: string): number => {
    let k = i + 1
    while (k < n) {
      const ch = src[k]!
      if (ch === '\\') {
        k += 2
        continue
      }
      if (ch === quote) {
        blank(i + 1, k)
        return k + 1
      }
      if (ch === '\n' || ch === '\r') {
        problems.push({ message: 'unterminated string', offset: i })
        blank(i + 1, k)
        return k
      }
      k++
    }
    problems.push({ message: 'unterminated string', offset: i })
    blank(i + 1, n)
    return n
  }

  /** Template literal starting with a backtick at `i`; returns the index after the closing backtick. */
  const scanTemplate = (i: number): number => {
    let k = i + 1
    let textStart = k
    while (k < n) {
      const ch = src[k]!
      if (ch === '\\') {
        k += 2
        continue
      }
      if (ch === '`') {
        blank(textStart, k)
        return k + 1
      }
      if (ch === '$' && src[k + 1] === '{') {
        blank(textStart, k)
        substitutions.push(k)
        k = scanCode(k + 2, true)
        textStart = k
        continue
      }
      k++
    }
    problems.push({ message: 'unterminated template', offset: i })
    blank(textStart, n)
    return n
  }

  /** Attempt at a regex literal at `i`. Returns the index after it, or -1 (then `/` is division). */
  const tryRegex = (i: number): number => {
    let k = i + 1
    let inClass = false
    while (k < n) {
      const ch = src[k]!
      if (isLineBreak(ch)) return -1
      if (ch === '\\') {
        k += 2
        continue
      }
      if (inClass) {
        if (ch === ']') inClass = false
      } else if (ch === '[') {
        inClass = true
      } else if (ch === '/') {
        k++
        while (k < n && isIdentPart(src[k]!)) k++
        return k
      }
      k++
    }
    return -1
  }

  /**
   * Scans code from `start`. In `inSubst` mode it ends at the closing `}` matching `${` and returns the index after it.
   */
  const scanCode = (start: number, inSubst: boolean): number => {
    let i = start
    let depth = 0
    let prev: Prev = inSubst ? { kind: 'punct', value: '{' } : { kind: 'start' }
    while (i < n) {
      const c = src[i]!
      if (isWhitespace(c)) {
        i++
        continue
      }
      if (c === '/' && src[i + 1] === '/') {
        let k = i + 2
        while (k < n && !isLineBreak(src[k]!)) k++
        blank(i, k)
        i = k
        continue
      }
      if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2)
        if (end < 0) {
          problems.push({ message: 'unterminated comment', offset: i })
          blank(i, n)
          return n
        }
        blank(i, end + 2)
        i = end + 2
        continue
      }
      if (c === '"' || c === "'") {
        i = scanString(i, c)
        prev = { kind: 'value' }
        continue
      }
      if (c === '`') {
        i = scanTemplate(i)
        prev = { kind: 'value' }
        continue
      }
      if (c === '/') {
        const regexAllowed =
          prev.kind === 'start' ||
          (prev.kind === 'punct' && prev.value !== ')' && prev.value !== ']') ||
          (prev.kind === 'word' && REGEX_AFTER_WORD.has(prev.value))
        if (regexAllowed) {
          const end = tryRegex(i)
          if (end > 0) {
            blank(i, end)
            i = end
            prev = { kind: 'value' }
            continue
          }
        }
        prev = { kind: 'punct', value: '/' }
        i++
        continue
      }
      if (c === '{') {
        depth++
        prev = { kind: 'punct', value: '{' }
        i++
        continue
      }
      if (c === '}') {
        if (inSubst && depth === 0) return i + 1
        depth--
        prev = { kind: 'punct', value: '}' }
        i++
        continue
      }
      if (isIdentStart(c)) {
        let k = i + 1
        while (k < n && isIdentPart(src[k]!)) k++
        const word = src.slice(i, k)
        // `a.in / 2` – a word after a dot is a property, not a keyword
        const afterDot: boolean = prev.kind === 'punct' && prev.value === '.'
        prev = afterDot ? { kind: 'value' } : { kind: 'word', value: word }
        i = k
        continue
      }
      if (DIGIT.test(c) || (c === '.' && DIGIT.test(src[i + 1] ?? ''))) {
        let k = i + 1
        while (k < n && /[0-9A-Za-z_.]/.test(src[k]!)) k++
        prev = { kind: 'value' }
        i = k
        continue
      }
      prev = { kind: 'punct', value: c }
      i++
    }
    if (inSubst) problems.push({ message: 'unterminated ${ } expression in template', offset: start })
    return n
  }

  scanCode(0, false)
  return { masked: chars.join(''), substitutions, problems }
}

/** Table of line starts for converting offset → line number (1-based). */
export function buildLineIndex(src: string): number[] {
  const starts = [0]
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (ch === '\n' || ch.charCodeAt(0) === 0x2028 || ch.charCodeAt(0) === 0x2029) starts.push(i + 1)
    else if (ch === '\r' && src[i + 1] !== '\n') starts.push(i + 1)
  }
  return starts
}

export function lineOfOffset(lineStarts: number[], offset: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}
