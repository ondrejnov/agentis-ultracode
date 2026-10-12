/**
 * Vstupní bod CLI `ultracode`. `main()` nikdy nevolá `process.exit` – vrací exit kód.
 * Veškeré I/O jde přes `io` a závislosti přes `deps`, takže se dá celé testovat bez procesu.
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { COMMAND_HELP, MAIN_HELP } from './help.ts'
import { initCommand } from './commands/init.ts'
import { listCommand } from './commands/list.ts'
import { logsCommand } from './commands/logs.ts'
import { runCommand } from './commands/run.ts'
import { skillCommand } from './commands/skill.ts'
import { statusCommand } from './commands/status.ts'
import { typesCommand } from './commands/types.ts'
import { validateCommand } from './commands/validate.ts'
import { COMMAND_OPTIONS, parseCommandLine } from './options.ts'
import { defaultPackageRoot, readPackageVersion } from './paths.ts'
import type { CliDeps, CliIO, CommandContext } from './types.ts'
import { UsageError } from './types.ts'

export type { CliDeps, CliIO } from './types.ts'

const COMMANDS: Record<string, (ctx: CommandContext, argv: string[]) => Promise<number>> = {
  run: (ctx, argv) => runCommand(ctx, argv, 'run'),
  resume: (ctx, argv) => runCommand(ctx, argv, 'resume'),
  status: statusCommand,
  list: listCommand,
  logs: logsCommand,
  validate: validateCommand,
  types: typesCommand,
  skill: skillCommand,
  init: initCommand,
}

function commandHelp(name: string): string | null {
  return COMMAND_HELP[name] ?? null
}

export async function main(argv: string[], io: CliIO, deps: CliDeps = {}): Promise<number> {
  const packageRoot = deps.packageRoot ?? defaultPackageRoot()
  const ctx: CommandContext = { io, deps, packageRoot }
  try {
    const [first, ...rest] = argv

    if (first === undefined) {
      io.stderr.write(MAIN_HELP)
      return 2
    }
    if (first === '--version' || first === '-v' || first === 'version') {
      io.stdout.write(`ultracode ${readPackageVersion(packageRoot)}\n`)
      return 0
    }
    if (first === '--help' || first === '-h') {
      io.stdout.write(MAIN_HELP)
      return 0
    }
    if (first === 'help') {
      const topic = rest[0]
      if (topic === undefined) {
        io.stdout.write(MAIN_HELP)
        return 0
      }
      const text = commandHelp(topic)
      if (!text) {
        io.stderr.write(`ultracode: neznámý příkaz „${topic}“.\n\n${MAIN_HELP}`)
        return 2
      }
      io.stdout.write(text)
      return 0
    }
    if (first.startsWith('-')) {
      io.stderr.write(`ultracode: příkaz musí být první argument (dostal jsem „${first}“).\n\n${MAIN_HELP}`)
      return 2
    }

    const handler = COMMANDS[first]
    if (!handler || !(first in COMMAND_OPTIONS)) {
      io.stderr.write(`ultracode: neznámý příkaz „${first}“.\n\n${MAIN_HELP}`)
      return 2
    }

    // `--help` u příkazu: vyřeš dřív, než se začne něco validovat/spouštět.
    if (parseCommandLine(first, rest).values.help === true) {
      io.stdout.write(commandHelp(first) ?? MAIN_HELP)
      return 0
    }

    return await handler(ctx, rest)
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr.write(`ultracode: ${e.message}\n`)
      return 2
    }
    const code = e && typeof e === 'object' && 'code' in e ? (e as { code: unknown }).code : undefined
    const msg = e instanceof Error ? e.message : String(e)
    if (code === 'SCRIPT_INVALID' || code === 'WORKFLOW_NOT_FOUND') {
      io.stderr.write(`ultracode: ${msg}\n`)
      return 2
    }
    if (code === 'ABORTED') {
      io.stderr.write(`ultracode: ${msg}\n`)
      return 130
    }
    io.stderr.write(`ultracode: neočekávaná chyba: ${msg}\n`)
    return 1
  }
}

// ───────────────────────── přímé spuštění (`node dist/cli/cli.js …`) ─────────────────────────

/** Je tento soubor vstupním bodem procesu (a ne jen importovaný z `bin/ultracode.mjs` nebo z testů)? */
function isDirectEntry(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isDirectEntry()) {
  // Zavřená rourou (`| head`) nesmí shodit běh ani změnit exit kód: EPIPE/EIO se ignoruje.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (e: NodeJS.ErrnoException) => {
      if (e && (e.code === 'EPIPE' || e.code === 'EIO' || e.code === 'ECONNRESET')) return
      throw e
    })
  }
  const controller = new AbortController()
  let interrupts = 0
  process.on('SIGINT', () => {
    interrupts++
    if (interrupts >= 2) process.exit(130)
    process.stderr.write('\nultracode: přerušuji běh (dalším Ctrl+C skončím okamžitě)…\n')
    controller.abort()
  })
  process.on('SIGTERM', () => controller.abort())
  // SIGHUP (zavření terminálu, pád SSH): bez handleru by proces skončil bez úklidu a agenti by běželi osiřele.
  process.on('SIGHUP', () => controller.abort())
  main(
    process.argv.slice(2),
    {
      stdout: process.stdout,
      stderr: process.stderr,
      isTTY: Boolean(process.stderr.isTTY),
      stdoutIsTTY: Boolean(process.stdout.isTTY),
      env: process.env,
      cwd: process.cwd(),
    },
    { signal: controller.signal },
  ).then(
    (code) => {
      process.exitCode = code
      // pojistka proti visícímu potomkovi, ale až po vyprázdnění stdout/stderr (pomalý odběratel rourou)
      setTimeout(() => {
        const exit = () => process.exit(code)
        if (process.stdout.writableLength === 0 && process.stderr.writableLength === 0) exit()
        else process.stdout.write('', () => process.stderr.write('', exit))
      }, 3000).unref()
    },
    (e) => {
      process.stderr.write(`ultracode: neočekávaná chyba: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
      process.exit(1)
    },
  )
}
