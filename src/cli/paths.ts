import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Package root. The file lives in both `src/cli/` and `dist/cli/` – same depth, so always `../../`.
 */
export function defaultPackageRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url))
}

export function readPackageVersion(packageRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}
