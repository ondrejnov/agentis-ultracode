#!/usr/bin/env node
/**
 * „Přehrávač“ uložených reálných streamů: místo claude vypíše řádky ze souboru $REPLAY_FILE
 * (test/fixtures/sample-stream-*.jsonl) a skončí s kódem $REPLAY_EXIT (default 0).
 * Prompt ze stdin se jen zahodí. Slouží k ověření, že runner rozumí REÁLNÉMU formátu.
 */
import { readFileSync } from 'node:fs'

try {
  readFileSync(0)
} catch {
  // stdin může být zavřený
}
const file = process.env.REPLAY_FILE
if (!file) {
  process.stderr.write('replay-claude: chybí REPLAY_FILE\n')
  process.exit(2)
}
process.stdout.write(readFileSync(file, 'utf8'))
if (process.env.REPLAY_STDERR) process.stderr.write(process.env.REPLAY_STDERR + '\n')
process.exitCode = Number(process.env.REPLAY_EXIT ?? 0)
