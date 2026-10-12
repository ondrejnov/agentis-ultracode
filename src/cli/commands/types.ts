/** `ultracode types [--out dir]` + shared function `writeTypes` (also used by `init`). */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { parseCommandLine, str } from '../options.ts'
import type { CommandContext } from '../types.ts'
import { UsageError } from '../types.ts'
import { errorLine, errorMessage, resolveCwd } from './shared.ts'

export const TYPES_FILE_NAME = 'workflow.d.ts'

export interface WriteTypesResult {
  file: string
  /** The `/// <reference path="…" />` line for scripts in `<cwd>/.ultracode/workflows/`. */
  referenceLine: string
}

/** Copies `<packageRoot>/types/workflow.d.ts` to `outDir`. Throws an Error with a human-readable message. */
export function writeTypes(packageRoot: string, cwd: string, outDir: string): WriteTypesResult {
  const source = join(packageRoot, 'types', TYPES_FILE_NAME)
  if (!existsSync(source)) {
    throw new Error(`Package is missing ${source}.`)
  }
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, TYPES_FILE_NAME)
  copyFileSync(source, file)
  const workflowsDir = join(cwd, '.ultracode', 'workflows')
  const rel = relative(workflowsDir, file).split(sep).join('/')
  return { file, referenceLine: `/// <reference path="${rel}" />` }
}

export async function typesCommand(ctx: CommandContext, argv: string[]): Promise<number> {
  const parsed = parseCommandLine('types', argv)
  if (parsed.positionals.length > 0) throw new UsageError('The types command takes no arguments (use --out <dir>).')
  const cwd = resolveCwd(ctx, parsed.values)
  const out = str(parsed.values.out)
  if (out !== undefined && out.trim() === '') throw new UsageError('The --out option must not be empty.')
  const outDir = out !== undefined ? resolve(ctx.io.cwd, out) : join(cwd, '.ultracode')
  try {
    const res = writeTypes(ctx.packageRoot, cwd, outDir)
    ctx.io.stderr.write(`Types written: ${res.file}\n`)
    ctx.io.stdout.write(`${res.referenceLine}\n`)
    return 0
  } catch (e) {
    errorLine(ctx, `Writing types failed: ${errorMessage(e)}`)
    return 1
  }
}
