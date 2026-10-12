/**
 * Parsování argumentů příkazové řádky (node:util parseArgs) a validace hodnot voleb.
 * Chyby se překládají do češtiny a vyhazují jako UsageError (→ exit 2).
 */
import { parseArgs } from 'node:util'
import type { EffortLevel } from '../types.ts'
import { UsageError } from './types.ts'

interface OptDef {
  type: 'string' | 'boolean'
  short?: string
}

const COMMON: Record<string, OptDef> = {
  help: { type: 'boolean', short: 'h' },
  cwd: { type: 'string' },
  'no-color': { type: 'boolean' },
}

const RUN_OPTS: Record<string, OptDef> = {
  ...COMMON,
  args: { type: 'string' },
  'args-file': { type: 'string' },
  concurrency: { type: 'string' },
  'max-agents': { type: 'string' },
  'max-tokens': { type: 'string' },
  'max-usd': { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  'run-id': { type: 'string' },
  resume: { type: 'string' },
  quiet: { type: 'boolean', short: 'q' },
  json: { type: 'boolean' },
  verbose: { type: 'boolean' },
}

export const COMMAND_OPTIONS: Record<string, Record<string, OptDef>> = {
  run: RUN_OPTS,
  resume: RUN_OPTS,
  status: { ...COMMON, json: { type: 'boolean' } },
  list: { ...COMMON, json: { type: 'boolean' }, limit: { type: 'string' } },
  logs: { ...COMMON, follow: { type: 'boolean', short: 'f' }, agent: { type: 'string' }, json: { type: 'boolean' } },
  validate: { ...COMMON, json: { type: 'boolean' } },
  types: { ...COMMON, out: { type: 'string' } },
  skill: { ...COMMON, user: { type: 'boolean' }, project: { type: 'boolean' }, force: { type: 'boolean' } },
  init: { ...COMMON, force: { type: 'boolean' } },
}

export interface ParsedCommandLine {
  values: Record<string, string | boolean | undefined>
  positionals: string[]
}

function optionFromMessage(message: string): string {
  const m = /'(-{1,2}[^'\s<]+)/.exec(message)
  return m ? m[1] : 'neznámá'
}

/** Rozparsuje argumenty konkrétního příkazu; neznámé volby jsou chyba. */
export function parseCommandLine(command: string, args: string[]): ParsedCommandLine {
  const spec = COMMAND_OPTIONS[command]
  if (!spec) throw new UsageError(`Neznámý příkaz „${command}“.`)
  try {
    const { values, positionals } = parseArgs({
      args,
      options: spec,
      allowPositionals: true,
      strict: true,
    })
    return { values: values as ParsedCommandLine['values'], positionals }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    const msg = err.message ?? String(e)
    switch (err.code) {
      case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
        throw new UsageError(`Neznámá volba ${optionFromMessage(msg)} pro příkaz „${command}“. Nápověda: ultracode ${command} --help`)
      case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE': {
        const opt = optionFromMessage(msg)
        if (/ambiguous/i.test(msg)) {
          throw new UsageError(
            `Hodnota volby ${opt} začíná pomlčkou a je nejednoznačná. Zapiš ji jako ${opt}=<hodnota>.`,
          )
        }
        throw new UsageError(`Volba ${opt} vyžaduje hodnotu.`)
      }
      default:
        throw new UsageError(`Neplatné argumenty: ${msg}`)
    }
  }
}

export function parsePositiveInt(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw.trim())) throw new UsageError(`Volba --${name} musí být kladné celé číslo (dostal jsem „${raw}“).`)
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 1) throw new UsageError(`Volba --${name} musí být kladné celé číslo (dostal jsem „${raw}“).`)
  return n
}

export function parsePositiveNumber(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  const n = Number(trimmed)
  if (trimmed === '' || !Number.isFinite(n) || n <= 0) {
    throw new UsageError(`Volba --${name} musí být kladné číslo (dostal jsem „${raw}“).`)
  }
  return n
}

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

export function parseEffort(raw: string | undefined): EffortLevel | undefined {
  if (raw === undefined) return undefined
  if (!(EFFORT_LEVELS as readonly string[]).includes(raw)) {
    throw new UsageError(`Volba --effort musí být jedna z: ${EFFORT_LEVELS.join(', ')} (dostal jsem „${raw}“).`)
  }
  return raw as EffortLevel
}

export function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export function bool(v: string | boolean | undefined): boolean {
  return v === true
}
