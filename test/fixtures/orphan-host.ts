/**
 * Helper "host" for the cleanup test: starts an agent that hangs, prints its pid and immediately
 * exits its own process (without abort). The runner must kill the child in the 'exit' hook.
 */
import { runClaude } from '../../src/runner/claude.ts'

void runClaude({
  prompt: 'hangs [[fake:stall]] [[fake:child]]',
  cwd: process.env['ORPHAN_CWD'] ?? process.cwd(),
  outDir: process.env['ORPHAN_OUT'] ?? '/tmp/orphan-out',
  stallMs: 60_000,
  onProgress: (e) => {
    if (e.kind === 'start') {
      process.stdout.write(`PID ${e.pid}\n`)
      setTimeout(() => process.exit(0), 300)
    }
  },
})
