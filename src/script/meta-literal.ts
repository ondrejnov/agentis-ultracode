/**
 * Parser for a “plain literal” in `export const meta = { … }`.
 *
 * Intentionally does not evaluate code: it accepts only a JSON-like subset of JavaScript (objects, arrays, strings, templates without `${}`,
 * numbers, true/false/null, comments, trailing commas, unquoted keys). Anything else (variable, call,
 * spread, concatenation, function…) is an error with an exact position – so a clear diagnostic can be reported
 * and meta is never executed.
 */

export type LiteralNode =
  | { kind: 'object'; start: number; props: Array<{ key: string; keyStart: number; value: LiteralNode }> }
  | { kind: 'array'; start: number; items: LiteralNode[] }
  | { kind: 'string'; start: number; value: string }
  | { kind: 'number'; start: number; value: number }
  | { kind: 'boolean'; start: number; value: boolean }
  | { kind: 'null'; start: number }

export class LiteralError extends Error {
  offset: number
  constructor(message: string, offset: number) {
    super(message)
    this.name = 'LiteralError'
    this.offset = offset
  }
}

const isIdentStart = (ch: string): boolean => /[A-Za-z_$]/.test(ch) || ch.charCodeAt(0) >= 0x80
const isIdentPart = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) >= 0x80
const NUMBER = /^[+-]?(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)/

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
}

/** Decodes string content (without quotes) per JS rules. Invalid escape sequences → LiteralError. */
function decodeEscapes(raw: string, offset: number): string {
  if (!raw.includes('\\')) return raw
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    if (c !== '\\') {
      out += c
      continue
    }
    const next = raw[++i]
    if (next === undefined) break
    if (next in SIMPLE_ESCAPES && !(next === '0' && /\d/.test(raw[i + 1] ?? ''))) {
      out += SIMPLE_ESCAPES[next]
    } else if (next === 'x') {
      const hex = raw.slice(i + 1, i + 3)
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new LiteralError('invalid escape sequence \\x in string', offset)
      out += String.fromCharCode(parseInt(hex, 16))
      i += 2
    } else if (next === 'u') {
      if (raw[i + 1] === '{') {
        const close = raw.indexOf('}', i + 2)
        const hex = close < 0 ? '' : raw.slice(i + 2, close)
        const cp = /^[0-9a-fA-F]+$/.test(hex) ? parseInt(hex, 16) : NaN
        if (!(cp <= 0x10ffff)) throw new LiteralError('invalid escape sequence \\u{…} in string', offset)
        out += String.fromCodePoint(cp)
        i = close
      } else {
        const hex = raw.slice(i + 1, i + 5)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new LiteralError('invalid escape sequence \\u in string', offset)
        out += String.fromCharCode(parseInt(hex, 16))
        i += 4
      }
    } else if (next === '\r') {
      if (raw[i + 1] === '\n') i++
    } else if (next === '\n' || next.charCodeAt(0) === 0x2028 || next.charCodeAt(0) === 0x2029) {
      // line continuation
    } else {
      out += next
    }
  }
  return out
}

/**
 * Parses the literal starting exactly at `start` (points to `{`). Returns the AST and the offset after the last character.
 */
export function parseLiteral(src: string, start: number): { node: LiteralNode; end: number } {
  let pos = start

  const skipTrivia = (): void => {
    for (;;) {
      const c = src[pos]
      if (c === undefined) return
      if (/\s/.test(c) || c.charCodeAt(0) === 0xfeff) {
        pos++
      } else if (c === '/' && src[pos + 1] === '/') {
        while (pos < src.length && src[pos] !== '\n' && src[pos] !== '\r') pos++
      } else if (c === '/' && src[pos + 1] === '*') {
        const end = src.indexOf('*/', pos + 2)
        if (end < 0) throw new LiteralError('unterminated comment in meta', pos)
        pos = end + 2
      } else {
        return
      }
    }
  }

  const readIdent = (): string => {
    const s = pos
    pos++
    while (pos < src.length && isIdentPart(src[pos]!)) pos++
    return src.slice(s, pos)
  }

  const readQuoted = (quote: string): string => {
    const s = pos
    pos++
    const contentStart = pos
    while (pos < src.length) {
      const c = src[pos]!
      if (c === '\\') {
        pos += 2
        continue
      }
      if (c === quote) {
        const raw = src.slice(contentStart, pos)
        pos++
        return decodeEscapes(raw, s)
      }
      if (c === '\n' || c === '\r') break
      pos++
    }
    throw new LiteralError('unterminated string in meta', s)
  }

  const readTemplate = (): string => {
    const s = pos
    pos++
    const contentStart = pos
    while (pos < src.length) {
      const c = src[pos]!
      if (c === '\\') {
        pos += 2
        continue
      }
      if (c === '$' && src[pos + 1] === '{') {
        throw new LiteralError('meta must be a plain literal: template string with ${} is not allowed (use a regular string)', pos)
      }
      if (c === '`') {
        const raw = src.slice(contentStart, pos)
        pos++
        return decodeEscapes(raw, s)
      }
      pos++
    }
    throw new LiteralError('unterminated template in meta', s)
  }

  const afterValueCheck = (): void => {
    skipTrivia()
    const c = src[pos]
    if (c === '+') {
      throw new LiteralError('meta must be a plain literal: concatenation (+) is not allowed, write the value as a single string', pos)
    }
  }

  const parseValue = (): LiteralNode => {
    skipTrivia()
    const s = pos
    const c = src[pos]
    if (c === undefined) throw new LiteralError('meta ends in the middle of a literal', pos)
    if (c === '{') return parseObject()
    if (c === '[') return parseArray()
    if (c === '"' || c === "'") {
      const value = readQuoted(c)
      afterValueCheck()
      return { kind: 'string', start: s, value }
    }
    if (c === '`') {
      const value = readTemplate()
      afterValueCheck()
      return { kind: 'string', start: s, value }
    }
    if (c === '.' && src.startsWith('...', pos)) {
      throw new LiteralError('meta must be a plain literal: spread (...) is not allowed', pos)
    }
    if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) {
      const m = NUMBER.exec(src.slice(pos, pos + 64))
      if (m) {
        pos += m[0].length
        const value = Number(m[0].replace(/_/g, ''))
        if (Number.isNaN(value)) throw new LiteralError(`invalid number “${m[0]}” in meta`, s)
        afterValueCheck()
        return { kind: 'number', start: s, value }
      }
      throw new LiteralError(`meta must be a plain literal: disallowed expression starting with “${c}”`, s)
    }
    if (isIdentStart(c)) {
      const word = readIdent()
      if (word === 'true' || word === 'false') {
        afterValueCheck()
        return { kind: 'boolean', start: s, value: word === 'true' }
      }
      if (word === 'null') {
        afterValueCheck()
        return { kind: 'null', start: s }
      }
      skipTrivia()
      if (src[pos] === '(' || src[pos] === '.') {
        throw new LiteralError(`meta must be a plain literal: calling or accessing “${word}” is not allowed`, s)
      }
      throw new LiteralError(`meta must be a plain literal: identifier “${word}” (variables are not allowed)`, s)
    }
    throw new LiteralError(`meta must be a plain literal: disallowed expression starting with “${c}”`, s)
  }

  const parseArray = (): LiteralNode => {
    const s = pos
    pos++ // [
    const items: LiteralNode[] = []
    for (;;) {
      skipTrivia()
      if (src[pos] === ']') {
        pos++
        break
      }
      if (src[pos] === ',') throw new LiteralError('meta must be a plain literal: empty elements in an array are not allowed', pos)
      items.push(parseValue())
      skipTrivia()
      if (src[pos] === ',') {
        pos++
        continue
      }
      if (src[pos] === ']') {
        pos++
        break
      }
      throw new LiteralError('an array in meta expects “,” or “]”', pos)
    }
    return { kind: 'array', start: s, items }
  }

  const parseObject = (): LiteralNode => {
    const s = pos
    pos++ // {
    const props: Array<{ key: string; keyStart: number; value: LiteralNode }> = []
    for (;;) {
      skipTrivia()
      const c = src[pos]
      if (c === undefined) throw new LiteralError('object in meta is not terminated', s)
      if (c === '}') {
        pos++
        break
      }
      const keyStart = pos
      let key: string
      if (c === '.' && src.startsWith('...', pos)) {
        throw new LiteralError('meta must be a plain literal: spread (...) is not allowed', pos)
      } else if (c === '[') {
        throw new LiteralError('meta must be a plain literal: computed keys [..] are not allowed', pos)
      } else if (c === '"' || c === "'") {
        key = readQuoted(c)
      } else if (c >= '0' && c <= '9') {
        const m = NUMBER.exec(src.slice(pos, pos + 64))
        if (!m) throw new LiteralError('invalid key in meta', pos)
        pos += m[0].length
        key = String(Number(m[0].replace(/_/g, '')))
      } else if (isIdentStart(c)) {
        key = readIdent()
      } else {
        throw new LiteralError(`meta expects a property key, found “${c}”`, pos)
      }
      skipTrivia()
      const sep = src[pos]
      if (sep === ',' || sep === '}') {
        throw new LiteralError(`meta must be a plain literal: shorthand “${key}” refers to a variable (write “${key}: value”)`, keyStart)
      }
      if (sep === '(') {
        throw new LiteralError(`meta must be a plain literal: method “${key}()” is not allowed`, keyStart)
      }
      if (sep !== ':') throw new LiteralError(`after key “${key}” in meta, “:” is expected`, pos)
      pos++
      const value = parseValue()
      props.push({ key, keyStart, value })
      skipTrivia()
      if (src[pos] === ',') {
        pos++
        continue
      }
      if (src[pos] === '}') {
        pos++
        break
      }
      throw new LiteralError('an object in meta expects “,” or “}”', pos)
    }
    return { kind: 'object', start: s, props }
  }

  if (src[pos] !== '{') throw new LiteralError('meta must be an object literal { … }', pos)
  const node = parseObject()
  return { node, end: pos }
}

/** Converts the AST to a plain value (the last duplicate key wins, as in JS). */
export function nodeToValue(node: LiteralNode): unknown {
  switch (node.kind) {
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const p of node.props) {
        // defineProperty because of the key “__proto__” (a plain assignment would change the prototype)
        Object.defineProperty(out, p.key, { value: nodeToValue(p.value), enumerable: true, writable: true, configurable: true })
      }
      return out
    }
    case 'array':
      return node.items.map(nodeToValue)
    case 'null':
      return null
    default:
      return node.value
  }
}
