/**
 * Identita procesů pro zámky běhů. Samotné PID nestačí: po restartu systému nebo u dlouhého běhu se PID
 * může přepoužít jiným procesem, který by pak navždy blokoval `resume`. Proto zámek ukládá i start time procesu.
 */
import { readFileSync } from 'node:fs'

/** Je proces s tímto PID živý? (EPERM = existuje, jen nemáme právo ho signalizovat.) */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Start time procesu z /proc (Linux); na jiných systémech `null`. */
export function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // za jménem v závorkách začíná pole 3 (stav); starttime je pole 22 → index 19
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[19] ?? null
  } catch {
    return null
  }
}

/** Identita držitele zámku: PID a (pokud je známý) start time procesu. */
export interface LockHolder {
  pid: number
  start?: string
}

/** Drží zámek živý proces? Přepoužité PID (jiný start time) se nepočítá jako držitel. */
export function lockHolderAlive(holder: LockHolder): boolean {
  if (!isPidAlive(holder.pid)) return false
  if (!holder.start) return true
  const now = processStartTime(holder.pid)
  return now === null || now === holder.start
}

/** Identita aktuálního procesu pro zápis do zámku. */
export function currentLockHolder(): LockHolder {
  const start = processStartTime(process.pid)
  return start ? { pid: process.pid, start } : { pid: process.pid }
}
