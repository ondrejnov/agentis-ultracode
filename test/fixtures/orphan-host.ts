/**
 * Pomocný „hostitel“ pro test úklidu: spustí agenta, který visí, vypíše jeho pid a okamžitě
 * ukončí vlastní proces (bez abortu). Runner musí potomka zabít v 'exit' hooku.
 */
import { runClaude } from '../../src/runner/claude.ts'

void runClaude({
  prompt: 'visí [[fake:stall]] [[fake:child]]',
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
