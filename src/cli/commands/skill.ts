/** `ultracode skill install [--user|--project] [--force]`. */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseCommandLine, bool } from '../options.ts'
import type { CommandContext } from '../types.ts'
import { UsageError } from '../types.ts'
import { errorLine, errorMessage, resolveCwd } from './shared.ts'

export const SKILL_NAME = 'ultracode-workflow'

/** Relative paths of all files under `dir` (recursive, sorted). */
function listFiles(dir: string, base = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(dir, base), { withFileTypes: true })) {
    const rel = base === '' ? entry.name : join(base, entry.name)
    const full = join(dir, rel)
    let isDir = entry.isDirectory()
    let isFile = entry.isFile()
    if (entry.isSymbolicLink()) {
      try {
        const st = statSync(full)
        isDir = st.isDirectory()
        isFile = st.isFile()
      } catch {
        continue
      }
    }
    if (isDir) out.push(...listFiles(dir, rel))
    else if (isFile) out.push(rel)
  }
  return out.sort()
}

function sameContent(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}

export async function skillCommand(ctx: CommandContext, argv: string[]): Promise<number> {
  const { io } = ctx
  const [sub, ...rest] = argv
  if (sub === undefined || sub.startsWith('-')) {
    // `ultracode skill --help` is handled by cli.ts; here the subcommand is missing
    throw new UsageError('Missing subcommand. Usage: ultracode skill install [--user|--project] [--force]')
  }
  if (sub !== 'install') throw new UsageError(`Unknown subcommand "skill ${sub}". Supported: skill install`)

  const parsed = parseCommandLine('skill', rest)
  if (parsed.positionals.length > 0) throw new UsageError('The skill install command takes no arguments.')
  const wantUser = bool(parsed.values.user)
  const wantProject = bool(parsed.values.project)
  if (wantUser && wantProject) throw new UsageError('The --user and --project options cannot be used together.')
  const force = bool(parsed.values.force)

  // target: ~/.claude/skills (respects CLAUDE_CONFIG_DIR) or <cwd>/.claude/skills
  let skillsBase: string
  if (wantProject) {
    skillsBase = join(resolveCwd(ctx, parsed.values), '.claude', 'skills')
  } else {
    const cfg = io.env.CLAUDE_CONFIG_DIR
    const claudeDir = cfg && cfg !== '' ? resolve(io.cwd, cfg) : join(io.env.HOME && io.env.HOME !== '' ? io.env.HOME : homedir(), '.claude')
    skillsBase = join(claudeDir, 'skills')
  }
  const dest = join(skillsBase, SKILL_NAME)

  const source = join(ctx.packageRoot, 'skills', SKILL_NAME)
  if (!existsSync(join(source, 'SKILL.md'))) {
    errorLine(ctx, `Skill is missing from the package (${join(source, 'SKILL.md')}).`)
    return 1
  }

  try {
    const files = listFiles(source)
    const existing = files.filter((f) => existsSync(join(dest, f)))
    if (existing.length > 0 && !force) {
      const identical = existing.length === files.length && files.every((f) => sameContent(join(source, f), join(dest, f)))
      if (identical) {
        io.stdout.write(`Skill is already installed and up to date: ${dest}\n`)
        return 0
      }
      errorLine(
        ctx,
        `Skill already exists and differs: ${dest}\n  Nothing was overwritten. Use --force to overwrite.`,
      )
      return 2
    }
    for (const f of files) {
      const target = join(dest, f)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(source, f), target)
    }
    io.stdout.write(`Skill ${SKILL_NAME} installed (${files.length} files): ${dest}\n`)
    return 0
  } catch (e) {
    errorLine(ctx, `Skill installation failed: ${errorMessage(e)}`)
    return 1
  }
}
