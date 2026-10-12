/**
 * Validation of `agent(prompt, opts)` – runs in the worker BEFORE the hook call, so that an invalid call
 * (invalid or contradictory schema, unsupported option) fails the script immediately and clearly,
 * not only inside `claude`.
 */

import type { AgentOptions, EffortLevel, JsonSchema } from '../types.ts'

const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']
const SCHEMA_TYPES: readonly string[] = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']

/** Options that exist in Claude Code but are not supported here (reject loudly, don't silently ignore). */
const UNSUPPORTED: Record<string, string> = {
  isolation:
    'Isolation via git worktree (“isolation”) is not supported in version 1. Split the work between agents into disjoint paths (partitions) so they do not overwrite each other’s files.',
  agentType: 'The “agentType” option (custom subagents) is not supported in version 1.',
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
  /** Non-critical warnings (e.g. unknown option) – the host sends them to the log. */
  warnings: string[]
}

export function validateAgentCall(prompt: unknown, rawOpts: unknown): ValidatedAgentCall {
  if (typeof prompt !== 'string') fail(`agent(): prompt must be a string (got ${describeType(prompt)}).`)
  if (prompt.trim() === '') fail('agent(): prompt must not be empty.')
  if (rawOpts === undefined || rawOpts === null) return { prompt, opts: {}, warnings: [] }
  if (!isPlainObject(rawOpts)) fail(`agent(): the second argument (opts) must be an object (got ${describeType(rawOpts)}).`)

  const warnings: string[] = []
  const opts: AgentOptions = {}
  const o = rawOpts

  for (const key of Object.keys(o)) {
    if (key in UNSUPPORTED) fail(`agent(): ${UNSUPPORTED[key]}`)
    if (!KNOWN.has(key)) warnings.push(`agent(): unknown option “${key}” is ignored.`)
  }

  const str = (key: string): string | undefined => {
    const v = o[key]
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'string') fail(`agent(): option “${key}” must be a string.`)
    return v
  }
  const posNum = (key: string): number | undefined => {
    const v = o[key]
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) fail(`agent(): option “${key}” must be a positive number.`)
    return v
  }
  const strList = (key: string): string[] | undefined => {
    const v = o[key]
    if (v === undefined || v === null) return undefined
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x === '')) {
      fail(`agent(): option “${key}” must be an array of non-empty strings.`)
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
      fail(`agent(): option “effort” must be one of: ${EFFORTS.join(', ')}.`)
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
    if (typeof o.noCache !== 'boolean') fail('agent(): option “noCache” must be a boolean.')
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
 * Validates the JSON Schema for `--json-schema`: root `type: 'object'`, `required ⊆ properties` (also in nested
 * objects), known types, non-contradictory `additionalProperties: false`. Throws a TypeError with the path to the problem.
 */
export function validateSchema(schema: unknown): void {
  if (!isPlainObject(schema)) fail('agent(): schema must be a JSON Schema object.')
  if (schema.type !== 'object') {
    fail(
      `agent(): the schema root must have type: 'object' (got ${JSON.stringify(schema.type) ?? 'nothing'}). ` +
        'Arrays or primitives cannot be returned directly – wrap them in an object, e.g. { type: "object", properties: { items: { type: "array", … } } }.',
    )
  }
  checkNode(schema, 'schema', 0)
}

const MAX_DEPTH = 64

function checkNode(node: unknown, path: string, depth: number): void {
  if (typeof node === 'boolean') return
  if (!isPlainObject(node)) fail(`agent(): invalid schema at ${path}: subschema must be an object (or boolean).`)
  if (depth > MAX_DEPTH) fail(`agent(): schema is nested too deeply (${path}).`)

  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type]
    for (const t of types) {
      if (typeof t !== 'string' || !SCHEMA_TYPES.includes(t)) {
        fail(`agent(): invalid schema at ${path}.type: “${String(t)}” is not a JSON Schema type (${SCHEMA_TYPES.join(', ')}).`)
      }
    }
  }
  if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) {
    fail(`agent(): invalid schema at ${path}.enum: must be a non-empty array.`)
  }

  let properties: Record<string, unknown> | undefined
  if (node.properties !== undefined) {
    if (!isPlainObject(node.properties)) fail(`agent(): invalid schema at ${path}.properties: must be an object.`)
    properties = node.properties
  }

  if (node.required !== undefined) {
    if (!Array.isArray(node.required) || node.required.some((k) => typeof k !== 'string')) {
      fail(`agent(): invalid schema at ${path}.required: must be an array of strings.`)
    }
    const required = node.required as string[]
    const dup = required.find((k, i) => required.indexOf(k) !== i)
    if (dup !== undefined) fail(`agent(): invalid schema at ${path}.required: key “${dup}” is listed more than once.`)
    const types = Array.isArray(node.type) ? node.type : [node.type]
    const isObjectLike = properties !== undefined || types.includes('object')
    if (isObjectLike) {
      for (const key of required) {
        if (properties && Object.prototype.hasOwnProperty.call(properties, key)) continue
        if (node.additionalProperties === false) {
          fail(
            `agent(): contradictory schema at ${path}: key “${key}” is in required, but additionalProperties: false ` +
              'forbids everything not in properties – add it to properties.',
          )
        }
        fail(`agent(): invalid schema at ${path}.required: key “${key}” is not in properties.`)
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
    if (!Array.isArray(v)) fail(`agent(): invalid schema at ${path}.${kw}: must be an array.`)
    v.forEach((s, i) => checkNode(s, `${path}.${kw}[${i}]`, depth + 1))
  }
  if (node.not !== undefined) checkNode(node.not, `${path}.not`, depth + 1)
  for (const kw of ['$defs', 'definitions', 'patternProperties']) {
    const v = node[kw]
    if (v === undefined) continue
    if (!isPlainObject(v)) fail(`agent(): invalid schema at ${path}.${kw}: must be an object.`)
    for (const [k, sub] of Object.entries(v)) checkNode(sub, `${path}.${kw}.${k}`, depth + 1)
  }
}
