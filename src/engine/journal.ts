/**
 * Journal dokončených agentů (`journal.jsonl`) a klíče cache pro resume.
 *
 * Klíč volání je content-addressed: sha256 kanonického JSON vstupů agenta. K němu se přidává pořadové číslo
 * stejného klíče v rámci běhu (n-té volání se stejným klíčem), takže opakovaná volání se stejným promptem
 * dostanou každé vlastní uložený výsledek.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { JsonSchema, TokenUsage } from '../types.ts'

export interface CallKeyInput {
  prompt: string
  schema?: JsonSchema | null
  /** Efektivní model (po dosazení výchozích hodnot běhu); `undefined` = default claude. */
  model?: string
  effort?: string
  /** Absolutní cwd agenta. */
  cwd: string
  tools?: string[]
  disallowedTools?: string[]
  systemPrompt?: string
}

/** JSON s lexikograficky seřazenými klíči objektů; `undefined` vlastnosti se vynechávají (jako v JSON.stringify). */
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

/** Klíč cache jednoho volání `agent()`. Seznamy nástrojů jsou množiny, proto se řadí. */
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

/** Jeden řádek `journal.jsonl`. Zapisují se jen úspěšné výsledky (`ok: true`). */
export interface JournalEntry {
  key: string
  /** Pořadí stejného klíče v rámci běhu (od 0). */
  seq: number
  ok: boolean
  label: string
  /** Hodnota vrácená skriptu: objekt (schema) nebo text. */
  result: unknown
  usage: TokenUsage
  costUsd: number
  sessionId?: string
  ts: string
  /** Číslo agenta (adresář agents/<id>/). */
  id?: number
  durationMs?: number
  toolCalls?: number
}

function entryId(key: string, seq: number): string {
  return `${key}#${seq}`
}

/** Zpracuje obsah journal.jsonl; poškozené/useknuté řádky (např. po zabití procesu) tiše přeskočí. */
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
      // poškozený řádek ignorujeme
    }
  }
  return out
}

/** Načtený journal původního běhu pro lookup při resume. Pozdější záznam stejného klíče+seq přepisuje dřívější. */
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
