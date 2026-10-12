#!/usr/bin/env node
/**
 * "Replayer" of saved real streams: instead of agentiscode it prints the lines from the file $REPLAY_FILE
 * (test/fixtures/sample-stream-*.jsonl) and ends with code $REPLAY_EXIT (default 0).
 * The prompt from stdin is simply discarded. Used to verify that the runner understands the REAL format.
 */
import { readFileSync } from 'node:fs'

try {
  readFileSync(0)
} catch {
  // stdin may be closed
}
const file = process.env.REPLAY_FILE
if (!file) {
  process.stderr.write('replay-claude: missing REPLAY_FILE\n')
  process.exit(2)
}
process.stdout.write(readFileSync(file, 'utf8'))
if (process.env.REPLAY_STDERR) process.stderr.write(process.env.REPLAY_STDERR + '\n')
process.exitCode = Number(process.env.REPLAY_EXIT ?? 0)
