/**
 * Process identity for run locks. A PID alone is not enough: after a system restart or in a long run a PID
 * may be reused by another process, which would then block `resume` forever. So the lock also stores the process start time.
 */
import { readFileSync } from 'node:fs'

/** Is the process with this PID alive? (EPERM = it exists, we just lack the permission to signal it.) */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Process start time from /proc (Linux); `null` on other systems. */
export function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // field 3 (state) starts after the name in parentheses; starttime is field 22 → index 19
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[19] ?? null
  } catch {
    return null
  }
}

/** Identity of the lock holder: PID and (if known) the process start time. */
export interface LockHolder {
  pid: number
  start?: string
}

/** Is the lock holder process alive? A reused PID (different start time) does not count as the holder. */
export function lockHolderAlive(holder: LockHolder): boolean {
  if (!isPidAlive(holder.pid)) return false
  if (!holder.start) return true
  const now = processStartTime(holder.pid)
  return now === null || now === holder.start
}

/** Identity of the current process, for writing to the lock. */
export function currentLockHolder(): LockHolder {
  const start = processStartTime(process.pid)
  return start ? { pid: process.pid, start } : { pid: process.pid }
}
