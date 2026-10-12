import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Kořen balíčku. Soubor leží v `src/cli/` i `dist/cli/` – stejná hloubka, takže vždy `../../`.
 */
export function defaultPackageRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url))
}

export function readPackageVersion(packageRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : 'neznámá'
  } catch {
    return 'neznámá'
  }
}
