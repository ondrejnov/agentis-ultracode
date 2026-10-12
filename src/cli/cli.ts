/**
 * Entry point of the `ultracode` CLI. `main()` never calls `process.exit` – it returns an exit code.
 * All I/O goes through `io` and dependencies through `deps`, so the whole thing can be tested without a process.
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { COMMAND_HELP, MAIN_HELP } from './help.ts'
import { initCommand } from './commands/init.ts'
import { listCommand } from './commands/list.ts'
import { logsCommand } from './commands/logs.ts'
import { metaCommand } from './commands/meta.ts'
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
  meta: metaCommand,
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
        io.stderr.write(`ultracode: unknown command "${topic}".\n\n${MAIN_HELP}`)
        return 2
      }
      io.stdout.write(text)
      return 0
    }
    if (first.startsWith('-')) {
      io.stderr.write(`ultracode: the command must be the first argument (got "${first}").\n\n${MAIN_HELP}`)
      return 2
    }

    const handler = COMMANDS[first]
    if (!handler || !(first in COMMAND_OPTIONS)) {
      io.stderr.write(`ultracode: unknown command "${first}".\n\n${MAIN_HELP}`)
      return 2
    }

    // `--help` for a command: handle it before anything gets validated or run.
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
    io.stderr.write(`ultracode: unexpected error: ${msg}\n`)
    return 1
  }
}

// ───────────────────────── direct run (`node dist/cli/cli.js …`) ─────────────────────────

/** Is this file the process entry point (and not just imported from `bin/ultracode.mjs` or from tests)? */
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
  // A pipe closed early (`| head`) must not crash the run or change the exit code: EPIPE/EIO is ignored.
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
    process.stderr.write('\nultracode: interrupting run (press Ctrl+C again to exit immediately)…\n')
    controller.abort()
  })
  process.on('SIGTERM', () => controller.abort())
  // SIGHUP (terminal closed, SSH drop): without a handler the process would exit without cleanup and agents would keep running orphaned.
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
      // safeguard against a hanging child, but only after stdout/stderr are flushed (a slow pipe reader)
      setTimeout(() => {
        const exit = () => process.exit(code)
        if (process.stdout.writableLength === 0 && process.stderr.writableLength === 0) exit()
        else process.stdout.write('', () => process.stderr.write('', exit))
      }, 3000).unref()
    },
    (e) => {
      process.stderr.write(`ultracode: unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
      process.exit(1)
    },
  )
}
