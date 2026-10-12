/**
 * Validace argumentů `agent(prompt, opts)` – běží ve workeru PŘED voláním hooku, aby chybné volání
 * (neplatné nebo protimluvné schema, nepodporovaná volba) shodilo skript hned a srozumitelně,
 * ne až uvnitř `claude`.
 */

import type { AgentOptions, EffortLevel, JsonSchema } from '../types.ts'

const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']
const SCHEMA_TYPES: readonly string[] = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']

/** Volby, které existují v Claude Code, ale tady nejsou podporované (hlasitě odmítnout, ne tiše ignorovat). */
const UNSUPPORTED: Record<string, string> = {
  isolation:
    'Izolace přes git worktree („isolation“) není ve verzi 1 podporována. Rozděl práci mezi agenty na disjunktní cesty (partitions), aby si nepřepisovali soubory.',
  agentType: 'Volba „agentType“ (vlastní subagenti) není ve verzi 1 podporována.',
}

const KNOWN = new Set([
  'label',
  'phase',
  'schema',
  'model',
  'effort',
  'cwd',
  'tools',
  'disallowedTools',
  'systemPrompt',
  'stallMs',
  'timeoutMs',
  'maxUsd',
  'noCache',
])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function fail(message: string): never {
  throw new TypeError(message)
}

export interface ValidatedAgentCall {
  prompt: string
  opts: AgentOptions
  /** Nekritická upozornění (např. neznámá volba) – host je pošle do logu. */
  warnings: string[]
}

export function validateAgentCall(prompt: unknown, rawOpts: unknown): ValidatedAgentCall {
  if (typeof prompt !== 'string') fail(`agent(): prompt musí být řetězec (dostal jsem ${describeType(prompt)}).`)
  if (prompt.trim() === '') fail('agent(): prompt nesmí být prázdný.')
  if (rawOpts === undefined || rawOpts === null) return { prompt, opts: {}, warnings: [] }
  if (!isPlainObject(rawOpts)) fail(`agent(): druhý argument (opts) musí být objekt (dostal jsem ${describeType(rawOpts)}).`)

  const warnings: string[] = []
  const opts: AgentOptions = {}
  const o = rawOpts

  for (const key of Object.keys(o)) {
    if (key in UNSUPPORTED) fail(`agent(): ${UNSUPPORTED[key]}`)
    if (!KNOWN.has(key)) warnings.push(`agent(): neznámá volba „${key}“ je ignorována.`)
  }

  const str = (key: string): string | undefined => {
    const v = o[key]
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'string') fail(`agent(): volba „${key}“ musí být řetězec.`)
    return v
  }
  const posNum = (key: string): number | undefined => {
    const v = o[key]
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) fail(`agent(): volba „${key}“ musí být kladné číslo.`)
    return v
  }
  const strList = (key: string): string[] | undefined => {
    const v = o[key]
    if (v === undefined || v === null) return undefined
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x === '')) {
      fail(`agent(): volba „${key}“ musí být pole neprázdných řetězců.`)
    }
    return v as string[]
  }

  const label = str('label')
  if (label !== undefined) opts.label = label
  const phase = str('phase')
  if (phase !== undefined) opts.phase = phase
  const model = str('model')
  if (model !== undefined) opts.model = model
  const cwd = str('cwd')
  if (cwd !== undefined) opts.cwd = cwd
  const systemPrompt = str('systemPrompt')
  if (systemPrompt !== undefined) opts.systemPrompt = systemPrompt

  if (o.effort !== undefined && o.effort !== null) {
    if (typeof o.effort !== 'string' || !EFFORTS.includes(o.effort)) {
      fail(`agent(): volba „effort“ musí být jedna z: ${EFFORTS.join(', ')}.`)
    }
    opts.effort = o.effort as EffortLevel
  }

  const tools = strList('tools')
  if (tools) opts.tools = tools
  const disallowedTools = strList('disallowedTools')
  if (disallowedTools) opts.disallowedTools = disallowedTools

  const stallMs = posNum('stallMs')
  if (stallMs !== undefined) opts.stallMs = stallMs
  const timeoutMs = posNum('timeoutMs')
  if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs
  const maxUsd = posNum('maxUsd')
  if (maxUsd !== undefined) opts.maxUsd = maxUsd

  if (o.noCache !== undefined && o.noCache !== null) {
    if (typeof o.noCache !== 'boolean') fail('agent(): volba „noCache“ musí být boolean.')
    opts.noCache = o.noCache
  }

  if (o.schema !== undefined && o.schema !== null) {
    validateSchema(o.schema)
    opts.schema = o.schema as JsonSchema
  }

  return { prompt, opts, warnings }
}

function describeType(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'pole'
  return typeof v
}

/**
 * Validuje JSON Schema pro `--json-schema`: kořen `type: 'object'`, `required ⊆ properties` (i ve vnořených
 * objektech), známé typy, neprotimluvné `additionalProperties: false`. Hází TypeError s cestou k problému.
 */
export function validateSchema(schema: unknown): void {
  if (!isPlainObject(schema)) fail('agent(): schema musí být objekt JSON Schema.')
  if (schema.type !== 'object') {
    fail(
      `agent(): kořen schématu musí mít type: 'object' (dostal jsem ${JSON.stringify(schema.type) ?? 'nic'}). ` +
        'Pole ani primitiva nelze vracet přímo – zabal je do objektu, např. { type: "object", properties: { items: { type: "array", … } } }.',
    )
  }
  checkNode(schema, 'schema', 0)
}

const MAX_DEPTH = 64

function checkNode(node: unknown, path: string, depth: number): void {
  if (typeof node === 'boolean') return
  if (!isPlainObject(node)) fail(`agent(): neplatné schema na ${path}: podschéma musí být objekt (nebo boolean).`)
  if (depth > MAX_DEPTH) fail(`agent(): schema je vnořené příliš hluboko (${path}).`)

  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type]
    for (const t of types) {
      if (typeof t !== 'string' || !SCHEMA_TYPES.includes(t)) {
        fail(`agent(): neplatné schema na ${path}.type: „${String(t)}“ není typ JSON Schema (${SCHEMA_TYPES.join(', ')}).`)
      }
    }
  }
  if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) {
    fail(`agent(): neplatné schema na ${path}.enum: musí být neprázdné pole.`)
  }

  let properties: Record<string, unknown> | undefined
  if (node.properties !== undefined) {
    if (!isPlainObject(node.properties)) fail(`agent(): neplatné schema na ${path}.properties: musí být objekt.`)
    properties = node.properties
  }

  if (node.required !== undefined) {
    if (!Array.isArray(node.required) || node.required.some((k) => typeof k !== 'string')) {
      fail(`agent(): neplatné schema na ${path}.required: musí být pole řetězců.`)
    }
    const required = node.required as string[]
    const dup = required.find((k, i) => required.indexOf(k) !== i)
    if (dup !== undefined) fail(`agent(): neplatné schema na ${path}.required: klíč „${dup}“ je uveden víckrát.`)
    const types = Array.isArray(node.type) ? node.type : [node.type]
    const isObjectLike = properties !== undefined || types.includes('object')
    if (isObjectLike) {
      for (const key of required) {
        if (properties && Object.prototype.hasOwnProperty.call(properties, key)) continue
        if (node.additionalProperties === false) {
          fail(
            `agent(): protimluvné schema na ${path}: klíč „${key}“ je v required, ale additionalProperties: false ` +
              'zakazuje vše, co není v properties – přidej ho do properties.',
          )
        }
        fail(`agent(): neplatné schema na ${path}.required: klíč „${key}“ není v properties.`)
      }
    }
  }

  if (properties) {
    for (const [key, sub] of Object.entries(properties)) checkNode(sub, `${path}.properties.${key}`, depth + 1)
  }
  if (node.items !== undefined) {
    if (Array.isArray(node.items)) node.items.forEach((s, i) => checkNode(s, `${path}.items[${i}]`, depth + 1))
    else checkNode(node.items, `${path}.items`, depth + 1)
  }
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
    checkNode(node.additionalProperties, `${path}.additionalProperties`, depth + 1)
  }
  for (const kw of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    const v = node[kw]
    if (v === undefined) continue
    if (!Array.isArray(v)) fail(`agent(): neplatné schema na ${path}.${kw}: musí být pole.`)
    v.forEach((s, i) => checkNode(s, `${path}.${kw}[${i}]`, depth + 1))
  }
  if (node.not !== undefined) checkNode(node.not, `${path}.not`, depth + 1)
  for (const kw of ['$defs', 'definitions', 'patternProperties']) {
    const v = node[kw]
    if (v === undefined) continue
    if (!isPlainObject(v)) fail(`agent(): neplatné schema na ${path}.${kw}: musí být objekt.`)
    for (const [k, sub] of Object.entries(v)) checkNode(sub, `${path}.${kw}.${k}`, depth + 1)
  }
}
