/**
 * Hledání workflow podle jména.
 *
 * Pořadí adresářů: `<cwd>/.ultracode/workflows`, pak stejný podadresář v každém rodičovském adresáři až ke
 * kořeni, poté `~/.ultracode/workflows` a nakonec `$ULTRACODE_WORKFLOWS_DIR` (může obsahovat více cest
 * oddělených `path.delimiter`). V rámci adresáře se zkouší `<ref>.workflow.ts`, `<ref>.workflow.js`,
 * `<ref>.ts`, `<ref>.js`. První nález vyhrává (projekt přebíjí uživatele).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { WorkflowNotFoundError } from '../errors.ts'

const SUFFIXES = ['.workflow.ts', '.workflow.js', '.ts', '.js'] as const

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

interface DirEntry {
  dir: string
  scope: 'project' | 'user'
}

function searchEntries(cwd: string): DirEntry[] {
  // uživatelské adresáře (i když leží v řetězci rodičů) mají scope 'user'
  const userDirs = new Set<string>()
  try {
    const home = homedir()
    if (home) userDirs.add(join(home, '.ultracode', 'workflows'))
  } catch {
    // homedir nelze zjistit — přeskočíme
  }
  const envDirs: string[] = []
  const fromEnv = process.env.ULTRACODE_WORKFLOWS_DIR
  if (fromEnv) {
    for (const part of fromEnv.split(delimiter)) {
      if (part.trim()) envDirs.push(resolve(cwd, part.trim()))
    }
  }
  for (const d of envDirs) userDirs.add(d)

  const entries: DirEntry[] = []
  const seen = new Set<string>()
  const add = (dir: string) => {
    if (!dir || seen.has(dir)) return
    seen.add(dir)
    entries.push({ dir, scope: userDirs.has(dir) ? 'user' : 'project' })
  }
  let current = resolve(cwd)
  for (;;) {
    add(join(current, '.ultracode', 'workflows'))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const d of userDirs) {
    if (!envDirs.includes(d)) add(d)
  }
  for (const d of envDirs) add(d)
  return entries
}

/** Adresáře, ve kterých se hledá (v pořadí priority; nemusí existovat). */
export function workflowSearchDirs(cwd: string): string[] {
  return searchEntries(cwd).map((e) => e.dir)
}

/** Vypadá `ref` jako cesta k souboru (obsahuje oddělovač nebo má příponu skriptu)? */
export function looksLikePath(ref: string): boolean {
  return /[\\/]/.test(ref) || /\.(?:ts|js|mts|mjs|cts|cjs)$/.test(ref)
}

/**
 * Najde skript podle jména (nebo vezme existující cestu). Vrací absolutní cestu.
 * @throws WorkflowNotFoundError
 */
export function findWorkflow(ref: string, cwd: string): string {
  const name = ref.trim()
  if (!name) throw new WorkflowNotFoundError(ref, workflowSearchDirs(cwd))
  if (looksLikePath(name)) {
    const direct = resolve(cwd, name)
    if (isFile(direct)) return direct
  }
  const dirs = workflowSearchDirs(cwd)
  for (const dir of dirs) {
    for (const suffix of SUFFIXES) {
      const candidate = join(dir, name + suffix)
      if (isFile(candidate)) return candidate
    }
  }
  throw new WorkflowNotFoundError(name, dirs)
}

/** Z hlavičky skriptu vytáhne `description` z `export const meta = {...}` (bez plného parsování). */
function extractDescription(source: string): string | undefined {
  const at = source.indexOf('export const meta')
  if (at < 0) return undefined
  const slice = source.slice(at, at + 4000)
  const m = /\bdescription\s*:\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/.exec(slice)
  if (!m) return undefined
  const raw = m[1] ?? m[2] ?? m[3] ?? ''
  return raw.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, ' ')
}

function workflowNameOf(file: string): string | null {
  if (file.endsWith('.d.ts')) return null
  for (const suffix of SUFFIXES) {
    if (file.endsWith(suffix)) return file.slice(0, -suffix.length)
  }
  return null
}

export function listWorkflows(cwd: string): Array<{ name: string; path: string; description?: string; scope: 'project' | 'user' }> {
  const out: Array<{ name: string; path: string; description?: string; scope: 'project' | 'user' }> = []
  const seen = new Set<string>()
  for (const { dir, scope } of searchEntries(cwd)) {
    if (!isDir(dir)) continue
    let files: string[]
    try {
      files = readdirSync(dir).sort()
    } catch {
      continue
    }
    // `.workflow.ts` má přednost před `.ts` se stejným jménem (stejné pořadí jako ve findWorkflow)
    const rank = (f: string) => SUFFIXES.findIndex((s) => f.endsWith(s))
    files.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))
    const batch: Array<{ name: string; path: string; description?: string; scope: 'project' | 'user' }> = []
    for (const file of files) {
      const name = workflowNameOf(file)
      if (!name || seen.has(name)) continue
      const path = join(dir, file)
      if (!isFile(path)) continue
      seen.add(name)
      let description: string | undefined
      try {
        description = extractDescription(readFileSync(path, 'utf8'))
      } catch {
        description = undefined
      }
      batch.push(description === undefined ? { name, path, scope } : { name, path, description, scope })
    }
    batch.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    out.push(...batch)
  }
  return out
}

/** Pomocná: jméno souboru bez přípon, pro zobrazení. */
export function displayNameOf(path: string): string {
  return workflowNameOf(basename(path)) ?? basename(path)
}
