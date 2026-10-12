/**
 * Journal of completed agents (`journal.jsonl`) and cache keys for resume.
 *
 * The call key is content-addressed: sha256 of the agent's canonical JSON inputs. A sequence number of the
 * same key within the run (the n-th call with the same key) is appended to it, so repeated calls with the same prompt
 * each get their own stored result.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { JsonSchema, TokenUsage } from '../types.ts'

export interface CallKeyInput {
  prompt: string
  schema?: JsonSchema | null
  /** Effective model (after applying the run defaults); `undefined` = default claude. */
  model?: string
  effort?: string
  /** Absolute cwd of the agent. */
  cwd: string
  tools?: string[]
  disallowedTools?: string[]
  systemPrompt?: string
}

/** JSON with lexicographically sorted object keys; `undefined` properties are omitted (as in JSON.stringify). */
export function canonicalJson(value: unknown): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v)).join(',') + ']'
  const obj = value as Record<string, unknown>
  const parts: string[] = []
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k]
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue
    parts.push(JSON.stringify(k) + ':' + canonicalJson(v))
  }
  return '{' + parts.join(',') + '}'
}

function sortedOrNull(list: string[] | undefined): string[] | null {
  return Array.isArray(list) ? [...list].sort() : null
}

/** Cache key of one `agent()` call. Tool lists are sets, so they are sorted. */
export function computeCallKey(input: CallKeyInput): string {
  const canonical = canonicalJson({
    prompt: input.prompt,
    schema: input.schema ?? null,
    model: input.model ?? null,
    effort: input.effort ?? null,
    cwd: input.cwd,
    tools: sortedOrNull(input.tools),
    disallowedTools: sortedOrNull(input.disallowedTools),
    systemPrompt: input.systemPrompt ?? null,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/** One line of `journal.jsonl`. Only successful results (`ok: true`) are written. */
export interface JournalEntry {
  key: string
  /** Sequence number of the same key within the run (from 0). */
  seq: number
  ok: boolean
  label: string
  /** Value returned to the script: an object (schema) or text. */
  result: unknown
  usage: TokenUsage
  costUsd: number
  sessionId?: string
  ts: string
  /** Agent number (directory agents/<id>/). */
  id?: number
  durationMs?: number
  toolCalls?: number
}

function entryId(key: string, seq: number): string {
  return `${key}#${seq}`
}

/** Parses the contents of journal.jsonl; corrupt/truncated lines (e.g. after a killed process) are silently skipped. */
export function parseJournal(text: string): JournalEntry[] {
  const out: JournalEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const e = JSON.parse(line) as Partial<JournalEntry> | null
      if (e && typeof e === 'object' && typeof e.key === 'string' && Number.isInteger(e.seq) && e.ok === true && 'result' in e) {
        out.push(e as JournalEntry)
      }
    } catch {
      // ignore a corrupt line
    }
  }
  return out
}

/** Loaded journal of the original run, for lookup on resume. A later entry with the same key+seq overwrites an earlier one. */
export class JournalCache {
  private readonly entries = new Map<string, JournalEntry>()

  constructor(entries: JournalEntry[] = []) {
    for (const e of entries) this.entries.set(entryId(e.key, e.seq), e)
  }

  static async load(path: string): Promise<JournalCache> {
    try {
      return new JournalCache(parseJournal(await readFile(path, 'utf8')))
    } catch {
      return new JournalCache()
    }
  }

  lookup(key: string, seq: number): JournalEntry | undefined {
    return this.entries.get(entryId(key, seq))
  }

  get size(): number {
    return this.entries.size
  }
}
