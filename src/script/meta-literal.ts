/**
 * Parser „čistého literálu“ pro `export const meta = { … }`.
 *
 * Záměrně neevaluuje kód: přijme jen JSON-like podmnožinu JavaScriptu (objekty, pole, řetězce, šablony bez `${}`,
 * čísla, true/false/null, komentáře, koncové čárky, neuvozované klíče). Cokoli jiného (proměnná, volání,
 * spread, zřetězení, funkce…) je chyba s přesnou pozicí – díky tomu jde hlásit rozumná česká diagnostika
 * a meta se nikdy nevykoná.
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

/** Dekóduje obsah řetězce (bez uvozovek) podle pravidel JS. Neplatné escape sekvence → LiteralError. */
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
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new LiteralError('neplatná escape sekvence \\x v řetězci', offset)
      out += String.fromCharCode(parseInt(hex, 16))
      i += 2
    } else if (next === 'u') {
      if (raw[i + 1] === '{') {
        const close = raw.indexOf('}', i + 2)
        const hex = close < 0 ? '' : raw.slice(i + 2, close)
        const cp = /^[0-9a-fA-F]+$/.test(hex) ? parseInt(hex, 16) : NaN
        if (!(cp <= 0x10ffff)) throw new LiteralError('neplatná escape sekvence \\u{…} v řetězci', offset)
        out += String.fromCodePoint(cp)
        i = close
      } else {
        const hex = raw.slice(i + 1, i + 5)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new LiteralError('neplatná escape sekvence \\u v řetězci', offset)
        out += String.fromCharCode(parseInt(hex, 16))
        i += 4
      }
    } else if (next === '\r') {
      if (raw[i + 1] === '\n') i++
    } else if (next === '\n' || next.charCodeAt(0) === 0x2028 || next.charCodeAt(0) === 0x2029) {
      // pokračování řádku
    } else {
      out += next
    }
  }
  return out
}

/**
 * Naparsuje literál začínající přesně na `start` (ukazuje na `{`). Vrací AST a offset za posledním znakem.
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
        if (end < 0) throw new LiteralError('neukončený komentář v meta', pos)
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
    throw new LiteralError('neukončený řetězec v meta', s)
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
        throw new LiteralError('meta musí být čistý literál: šablonový řetězec s ${} není povolen (použij běžný řetězec)', pos)
      }
      if (c === '`') {
        const raw = src.slice(contentStart, pos)
        pos++
        return decodeEscapes(raw, s)
      }
      pos++
    }
    throw new LiteralError('neukončená šablona v meta', s)
  }

  const afterValueCheck = (): void => {
    skipTrivia()
    const c = src[pos]
    if (c === '+') {
      throw new LiteralError('meta musí být čistý literál: zřetězení (+) není povoleno, zapiš hodnotu jedním řetězcem', pos)
    }
  }

  const parseValue = (): LiteralNode => {
    skipTrivia()
    const s = pos
    const c = src[pos]
    if (c === undefined) throw new LiteralError('meta končí uprostřed literálu', pos)
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
      throw new LiteralError('meta musí být čistý literál: spread (...) není povolen', pos)
    }
    if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) {
      const m = NUMBER.exec(src.slice(pos, pos + 64))
      if (m) {
        pos += m[0].length
        const value = Number(m[0].replace(/_/g, ''))
        if (Number.isNaN(value)) throw new LiteralError(`neplatné číslo „${m[0]}“ v meta`, s)
        afterValueCheck()
        return { kind: 'number', start: s, value }
      }
      throw new LiteralError(`meta musí být čistý literál: nepovolený výraz začínající „${c}“`, s)
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
        throw new LiteralError(`meta musí být čistý literál: volání nebo přístup k „${word}“ není povolen`, s)
      }
      throw new LiteralError(`meta musí být čistý literál: identifikátor „${word}“ (proměnné nejsou povoleny)`, s)
    }
    throw new LiteralError(`meta musí být čistý literál: nepovolený výraz začínající „${c}“`, s)
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
      if (src[pos] === ',') throw new LiteralError('meta musí být čistý literál: prázdné prvky v poli nejsou povoleny', pos)
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
      throw new LiteralError('v poli v meta se očekává „,“ nebo „]“', pos)
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
      if (c === undefined) throw new LiteralError('objekt v meta není ukončen', s)
      if (c === '}') {
        pos++
        break
      }
      const keyStart = pos
      let key: string
      if (c === '.' && src.startsWith('...', pos)) {
        throw new LiteralError('meta musí být čistý literál: spread (...) není povolen', pos)
      } else if (c === '[') {
        throw new LiteralError('meta musí být čistý literál: počítané klíče [..] nejsou povoleny', pos)
      } else if (c === '"' || c === "'") {
        key = readQuoted(c)
      } else if (c >= '0' && c <= '9') {
        const m = NUMBER.exec(src.slice(pos, pos + 64))
        if (!m) throw new LiteralError('neplatný klíč v meta', pos)
        pos += m[0].length
        key = String(Number(m[0].replace(/_/g, '')))
      } else if (isIdentStart(c)) {
        key = readIdent()
      } else {
        throw new LiteralError(`v meta se očekává klíč vlastnosti, nalezeno „${c}“`, pos)
      }
      skipTrivia()
      const sep = src[pos]
      if (sep === ',' || sep === '}') {
        throw new LiteralError(`meta musí být čistý literál: zkrácený zápis „${key}“ odkazuje na proměnnou (zapiš „${key}: hodnota“)`, keyStart)
      }
      if (sep === '(') {
        throw new LiteralError(`meta musí být čistý literál: metoda „${key}()“ není povolena`, keyStart)
      }
      if (sep !== ':') throw new LiteralError(`za klíčem „${key}“ v meta se očekává „:“`, pos)
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
      throw new LiteralError('v objektu v meta se očekává „,“ nebo „}“', pos)
    }
    return { kind: 'object', start: s, props }
  }

  if (src[pos] !== '{') throw new LiteralError('meta musí být objektový literál { … }', pos)
  const node = parseObject()
  return { node, end: pos }
}

/** Převede AST na obyčejnou hodnotu (poslední duplicitní klíč vyhrává, jako v JS). */
export function nodeToValue(node: LiteralNode): unknown {
  switch (node.kind) {
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const p of node.props) {
        // defineProperty kvůli klíči „__proto__“ (obyčejné přiřazení by změnilo prototyp)
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
