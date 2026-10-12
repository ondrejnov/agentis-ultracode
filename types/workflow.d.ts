/**
 * Ambientní typy pro skripty workflow (`*.workflow.ts`) spouštěné přes `ultracode run`.
 *
 * Použití na začátku skriptu:
 *   /// <reference path="../../types/workflow.d.ts" />
 * (nebo `ultracode types --out .ultracode/` a odkaz na vygenerovaný soubor).
 *
 * Skript NEMÁ importy; všechno níže jsou globály injektované runtime. Tělo skriptu je
 * asynchronní kontext: používej top-level `await` a nakonec `return` výsledek (JSON).
 */

type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** JSON Schema; kořen MUSÍ být `{ type: 'object', properties: {...} }` a `required ⊆ properties`. */
interface WorkflowJsonSchema {
  type?: string | string[]
  properties?: Record<string, WorkflowJsonSchema>
  required?: string[]
  items?: WorkflowJsonSchema
  enum?: unknown[]
  additionalProperties?: boolean | WorkflowJsonSchema
  description?: string
  [key: string]: unknown
}

interface WorkflowPhaseMeta {
  /** Musí přesně odpovídat titulu v `phase('…')`. */
  title: string
  detail?: string
  model?: string
}

/** `export const meta` – čistý literál: žádné proměnné, volání funkcí, spread ani šablony s ${}. */
interface WorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: WorkflowPhaseMeta[]
}

interface AgentOptions {
  /** Popisek agenta v logu a eventech. */
  label?: string
  /** Explicitní fáze – použij uvnitř `pipeline()`/`parallel()` místo globálního `phase()`. */
  phase?: string
  /** Vynutí strukturovaný výstup; `agent()` pak vrací validovaný objekt. */
  schema?: WorkflowJsonSchema
  /** Alias modelu (`sonnet`, `opus`, `haiku`, …) nebo celé jméno. Default: dědí z běhu. Raději vynechej. */
  model?: string
  /** Úroveň uvažování. Default: dědí z běhu. `low` pro mechanické kroky. */
  effort?: EffortLevel
  /** Pracovní adresář agenta (default: cwd běhu). */
  cwd?: string
  /**
   * Whitelist nástrojů (`--allowedTools`), např. `['Read','Grep','Bash(git diff:*)']`. Agent se zadaným `tools`
   * běží v režimu `dontAsk`: cokoli mimo seznam se odmítne. Bez `tools` platí `bypassPermissions`.
   */
  tools?: string[]
  disallowedTools?: string[]
  /** Přidá se k výchozímu system promptu agenta. */
  systemPrompt?: string
  /** Ticho na výstupu v ms, po kterém se agent považuje za zaseknutý a restartuje (default 600000). */
  stallMs?: number
  /** Tvrdý limit jednoho POKUSU agenta v ms (stall-restart začíná nový pokus a limit se znovu uplatní). */
  timeoutMs?: number
  /** Strop útrat agenta v USD; kumulativně přes restarty (zbytek se předá dalšímu pokusu). Útrata zabitých pokusů bez výsledku se nepočítá (cena není známa). */
  maxUsd?: number
  /** Při resume nepoužít uložený výsledek tohoto volání. */
  noCache?: boolean
}

type AgentOptionsWithSchema = AgentOptions & { schema: WorkflowJsonSchema }

/**
 * Spustí jednoho agenta (`claude -p`). Bez `schema` vrací finální text, se `schema` validovaný objekt.
 * Vrací `null`, když agent terminálně selže (po retry/stall restartech) nebo je přerušen – VŽDY před
 * použitím filtruj `.filter(Boolean)` / ošetři `null`.
 * Vyhodí chybu jen při chybě skriptu (neplatné schema, překročený rozpočet, …).
 */
declare function agent<T = any>(prompt: string, opts: AgentOptionsWithSchema): Promise<T | null>
declare function agent<T = string>(prompt: string, opts?: AgentOptions): Promise<T | null>

/**
 * Spustí thunky souběžně a čeká na všechny (BARIÉRA). Thunk, který vyhodí chybu, dá `null`.
 * Funkce nikdy neodmítne. Max 4096 položek.
 */
declare function parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>

/**
 * Pošle každou položku nezávisle všemi stage (BEZ bariéry mezi stagemi) – výchozí volba pro vícekrokovou práci.
 * Každá stage dostane `(předchozíVýsledek, původníPoložka, index)`. Stage, která vyhodí chybu, dá položce
 * `null` a zbylé stage se pro ni přeskočí. Výsledek je pole ve stejném pořadí jako `items`.
 * Max 4096 položek.
 */
declare function pipeline<I, A>(items: I[], s1: (item: I, original: I, index: number) => Promise<A> | A): Promise<Array<A | null>>
declare function pipeline<I, A, B>(items: I[], s1: (item: I, original: I, index: number) => Promise<A> | A, s2: (prev: A, original: I, index: number) => Promise<B> | B): Promise<Array<B | null>>
declare function pipeline<I, A, B, C>(items: I[], s1: (item: I, original: I, index: number) => Promise<A> | A, s2: (prev: A, original: I, index: number) => Promise<B> | B, s3: (prev: B, original: I, index: number) => Promise<C> | C): Promise<Array<C | null>>
declare function pipeline<I, A, B, C, D>(items: I[], s1: (item: I, original: I, index: number) => Promise<A> | A, s2: (prev: A, original: I, index: number) => Promise<B> | B, s3: (prev: B, original: I, index: number) => Promise<C> | C, s4: (prev: C, original: I, index: number) => Promise<D> | D): Promise<Array<D | null>>
declare function pipeline(items: any[], ...stages: Array<(prev: any, original: any, index: number) => any>): Promise<any[]>

/** Začne novou fázi; následující `agent()` volání se seskupí pod titul. Titul musí být v `meta.phases`. */
declare function phase(title: string): void

/** Vypíše průběžnou zprávu uživateli (stderr + events.jsonl). */
declare function log(message: string): void

/** Vstup workflow (`--args '<json>'`); `undefined`, když nebyl zadán. Pole/objekty jsou skutečné JSON hodnoty. */
declare const args: any

/**
 * Rozpočet běhu (z `--max-tokens` / `--max-usd`). `total` je `null`, když limit není nastaven.
 * Limit je tvrdý strop: po jeho dosažení další `agent()` volání vyhodí chybu.
 */
declare const budget: {
  /** Strop výstupních tokenů nebo `null`. */
  total: number | null
  /** Strop v USD nebo `null`. */
  totalUsd: number | null
  /** Utracené výstupní tokeny (celý běh včetně vnořených workflow). */
  spent(): number
  /** `max(0, total - spent())`, bez limitu `Infinity`. */
  remaining(): number
  spentUsd(): number
  remainingUsd(): number
}

/**
 * Spustí jiný workflow inline a vrátí jeho návratovou hodnotu. Sdílí limity, počítadlo agentů a rozpočet.
 * Vnoření jen o jednu úroveň (workflow() uvnitř potomka vyhodí chybu).
 */
declare function workflow(nameOrRef: string | { scriptPath: string }, args?: any): Promise<any>
