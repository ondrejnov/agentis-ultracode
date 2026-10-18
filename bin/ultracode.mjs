#!/usr/bin/env node
// Thin shim: loads the compiled CLI from dist/, otherwise (development) runs the TypeScript directly via Node type-stripping.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const major = Number(process.versions.node.split('.')[0])
if (major < 22) {
  process.stderr.write(`ultracode: requires Node.js >= 22.18 (you have ${process.versions.node}).\n`)
  process.exit(1)
}

// A pipe closed early (`| head`, `| true`) must not crash the run or change the exit code: EPIPE/EIO on stdout/stderr
// is ignored (progress just stops being visible), other write errors are rethrown as before.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e) => {
    if (e && (e.code === 'EPIPE' || e.code === 'EIO' || e.code === 'ECONNRESET')) return
    throw e
  })
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distEntry = join(root, 'dist', 'cli', 'cli.js')
const srcEntry = join(root, 'src', 'cli', 'cli.ts')
// ULTRACODE_FORCE_SRC=1 forces running from sources (development/tests), even if an older dist/ exists.
const forceSrc = process.env.ULTRACODE_FORCE_SRC === '1' && existsSync(srcEntry)
const entry = !forceSrc && existsSync(distEntry) ? distEntry : srcEntry

let main
try {
  ;({ main } = await import(pathToFileURL(entry).href))
} catch (e) {
  const detail = e instanceof Error ? e.message : String(e)
  const hint = entry === srcEntry ? ' (dist/ is missing, run "npm run build")' : ''
  process.stderr.write(`ultracode: cannot load ${entry}${hint}: ${detail}\n`)
  process.exit(1)
}

// SIGINT/SIGTERM/SIGHUP → AbortController; a second SIGINT = immediate exit.
const controller = new AbortController()
let interrupts = 0
process.on('SIGINT', () => {
  interrupts++
  if (interrupts >= 2) process.exit(130)
  process.stderr.write('\nultracode: interrupting run (press Ctrl+C again to exit immediately)…\n')
  controller.abort()
})
process.on('SIGTERM', () => {
  controller.abort()
})
// SIGHUP (terminal closed, SSH drop): without a handler the process would exit without cleanup and detached agents
// would keep running orphaned. We write nothing to stderr – the terminal is already gone.
process.on('SIGHUP', () => {
  controller.abort()
})
// Parent death without a signal (e.g. Claude Code killed with SIGKILL while we ran in its Bash tool, in our own session):
// we would be reparented and keep running with all agents. A changed ppid = the parent is gone → abort like SIGTERM.
const parentPid = process.ppid
const parentWatch = setInterval(() => {
  if (process.ppid === parentPid) return
  clearInterval(parentWatch)
  controller.abort()
}, 1000).unref()

let code = 1
try {
  code = await main(
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
  )
} catch (e) {
  process.stderr.write(`ultracode: unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
  code = 1
}

process.exitCode = code
// safeguard: if something holds the event loop (a forgotten child), don't let the process hang. But only after
// stdout/stderr are flushed: writes to a pipe are asynchronous and a slow reader would otherwise get truncated output.
setTimeout(() => {
  const exit = () => process.exit(code)
  if (process.stdout.writableLength === 0 && process.stderr.writableLength === 0) exit()
  else process.stdout.write('', () => process.stderr.write('', exit))
}, 3000).unref()
