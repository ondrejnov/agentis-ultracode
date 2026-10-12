/** `ultracode init`. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bool, parseCommandLine } from '../options.ts'
import { HELLO_WORKFLOW, ULTRACODE_GITIGNORE } from '../templates.ts'
import type { CommandContext } from '../types.ts'
import { UsageError } from '../types.ts'
import { errorLine, errorMessage, resolveCwd } from './shared.ts'
import { writeTypes } from './types.ts'

export async function initCommand(ctx: CommandContext, argv: string[]): Promise<number> {
  const { io } = ctx
  const parsed = parseCommandLine('init', argv)
  if (parsed.positionals.length > 0) throw new UsageError('The init command takes no arguments.')
  const force = bool(parsed.values.force)
  const cwd = resolveCwd(ctx, parsed.values)
  const root = join(cwd, '.ultracode')
  const workflowsDir = join(root, 'workflows')

  try {
    mkdirSync(workflowsDir, { recursive: true })
    const lines: string[] = []

    const hello = join(workflowsDir, 'hello.workflow.ts')
    if (existsSync(hello) && !force) {
      lines.push(`Kept (already exists): ${hello}`)
    } else {
      writeFileSync(hello, HELLO_WORKFLOW, 'utf8')
      lines.push(`Created: ${hello}`)
    }

    const ignore = join(root, '.gitignore')
    if (!existsSync(ignore)) {
      writeFileSync(ignore, ULTRACODE_GITIGNORE, 'utf8')
      lines.push(`Created: ${ignore}`)
    }

    const types = writeTypes(ctx.packageRoot, cwd, root)
    lines.push(`Types written: ${types.file}`)

    io.stdout.write(`${lines.join('\n')}\n\nTry it:\n  ultracode validate .ultracode/workflows/hello.workflow.ts\n  ultracode run hello --args '{"name":"world"}'\n`)
    return 0
  } catch (e) {
    errorLine(ctx, `Initialization failed: ${errorMessage(e)}`)
    return 1
  }
}
