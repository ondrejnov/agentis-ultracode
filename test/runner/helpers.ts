/** Helper functions for runner tests (shared by claude.test.ts and real-format.test.ts). */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ClaudeProgress } from '../../src/types.ts'

export const FIXTURES = resolve(import.meta.dirname, '..', 'fixtures')
export const FAKE_CLAUDE = join(FIXTURES, 'fake-claude.mjs')
export const REPLAY_CLAUDE = join(FIXTURES, 'replay-claude.mjs')

export interface Sandbox {
  root: string
  cwd: string
  outDir: string
  logFile: string
  stateDir: string
  cleanup(): void
}

/** Creates an isolated directory and sets the env that fake-claude and the runner read. */
export function makeSandbox(bin: string = FAKE_CLAUDE): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'ultracode-runner-'))
  const cwd = join(root, 'work')
  const outDir = join(root, 'out', 'agent')
  const logFile = join(root, 'fake.log')
  const stateDir = join(root, 'state')
  mkdirSync(cwd, { recursive: true })
  process.env['ULTRACODE_CLAUDE_BIN'] = bin
  process.env['FAKE_CLAUDE_LOG'] = logFile
  process.env['FAKE_CLAUDE_STATE_DIR'] = stateDir
  process.env['ULTRACODE_RETRY_BACKOFF_MS'] = '5'
  process.env['ULTRACODE_KILL_GRACE_MS'] = '400'
  process.env['ULTRACODE_RESULT_GRACE_MS'] = '5000'
  return {
    root,
    cwd,
    outDir,
    logFile,
    stateDir,
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // ignore
      }
    },
  }
}

export interface FakeLogEntry {
  pid: number
  startedAt: string
  endedAt: string
  args: string[]
  cwd: string
  prompt: string
  env: { CLAUDE_CODE_DISABLE_WORKFLOWS: string | null; ULTRACODE_TEST_ENV?: string | null; AGENTISCODE_DIE_WITH_PARENT?: string | null }
  attempt: number
  childPid?: number
}

export function readLog(sb: Sandbox): FakeLogEntry[] {
  if (!existsSync(sb.logFile)) return []
  return readFileSync(sb.logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FakeLogEntry)
}

/** Finds the value of an option in argv (`--model` → next element). */
export function argOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

/** The part of the agentiscode argv that goes verbatim to `claude` (`--extra-args-json`). */
export function claudeArgsOf(args: string[]): string[] {
  const raw = argOf(args, '--extra-args-json')
  return raw === undefined ? [] : (JSON.parse(raw) as string[])
}

/** Is the process alive? A zombie (state Z) counts as dead. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
    if (state === 'Z' || state === 'X') return false
  } catch {
    // without /proc: rely on kill(0)
  }
  return true
}

/** Waits until the process dies (max `timeoutMs`). Returns true if it is dead. */
export async function waitDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (!isAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return !isAlive(pid)
}

export function collectProgress(): { events: ClaudeProgress[]; push: (e: ClaudeProgress) => void } {
  const events: ClaudeProgress[] = []
  return { events, push: (e) => events.push(e) }
}

/** child pid from the fake_child event in stream.jsonl. */
export function childPidFromStream(outDir: string): number | null {
  const file = join(outDir, 'stream.jsonl')
  if (!existsSync(file)) return null
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('fake_child')) continue
    try {
      const o = JSON.parse(line) as { type?: string; pid?: number }
      if (o.type === 'fake_child' && typeof o.pid === 'number') return o.pid
    } catch {
      // ignore
    }
  }
  return null
}

export function listDir(dir: string): string[] {
  return readdirSync(dir).sort()
}
