import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { makeStyle } from '../format.ts'
import type { Style } from '../format.ts'
import type { CommandContext, CliWritable } from '../types.ts'
import { UsageError } from '../types.ts'

export type OptValues = Record<string, string | boolean | undefined>

/** Absolute cwd from `--cwd` (relative to the process cwd); must exist as a directory. */
export function resolveCwd(ctx: CommandContext, values: OptValues): string {
  const raw = typeof values.cwd === 'string' ? values.cwd : undefined
  const abs = resolve(ctx.io.cwd, raw ?? '.')
  if (raw !== undefined) {
    let ok = false
    try {
      ok = statSync(abs).isDirectory()
    } catch {
      ok = false
    }
    if (!ok) throw new UsageError(`Directory --cwd "${raw}" does not exist (${abs}).`)
  }
  return abs
}

/** Colors only on a TTY, without NO_COLOR, without TERM=dumb and without --no-color. */
export function styleFor(ctx: CommandContext, values: OptValues): Style {
  const env = ctx.io.env
  const enabled =
    ctx.io.isTTY === true &&
    values['no-color'] !== true &&
    !(env.NO_COLOR !== undefined && env.NO_COLOR !== '') &&
    env.TERM !== 'dumb'
  return makeStyle(enabled)
}

/** Same rules as the store: no `/`, `..`, or whitespace. */
export function assertSafeRunId(runId: string, what = 'runId'): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new UsageError(`Invalid ${what} "${runId}" (allowed: letters, digits, _ . -; max. 128 characters).`)
  }
}

/** JSON indentation on stdout: only when stdout is a terminal. */
export function jsonIndent(io: { isTTY?: boolean; stdoutIsTTY?: boolean }): number | undefined {
  return (io.stdoutIsTTY ?? io.isTTY) ? 2 : undefined
}

export function writeLines(w: CliWritable, lines: string[]): void {
  if (lines.length === 0) return
  w.write(`${lines.join('\n')}\n`)
}

export function errorLine(ctx: CommandContext, message: string): void {
  ctx.io.stderr.write(`ultracode: ${message}\n`)
}

/** A workflow reference looks like a path (not like a name to search for). */
export function looksLikePath(ref: string): boolean {
  return ref.includes('/') || ref.includes('\\') || /\.(m?[jt]s|cjs|cts)$/.test(ref)
}

export function errorCode(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'code' in e) {
    const c = (e as { code: unknown }).code
    return typeof c === 'string' ? c : undefined
  }
  return undefined
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function nowMs(ctx: CommandContext): number {
  return ctx.deps.now ? ctx.deps.now() : Date.now()
}

export function sleepMs(ctx: CommandContext, ms: number): Promise<void> {
  const signal = ctx.deps.signal
  if (ctx.deps.sleep) return ctx.deps.sleep(ms, signal)
  return new Promise((resolveP) => {
    if (signal?.aborted) return resolveP()
    const onAbort = () => {
      clearTimeout(timer)
      resolveP()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolveP()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
