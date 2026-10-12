/** Pure formatting helpers for CLI output (no I/O, deterministic). */

export interface Style {
  enabled: boolean
  bold(s: string): string
  dim(s: string): string
  red(s: string): string
  green(s: string): string
  yellow(s: string): string
  cyan(s: string): string
}

function wrap(enabled: boolean, open: number, close: number): (s: string) => string {
  return (s) => (enabled && s.length > 0 ? `\u001b[${open}m${s}\u001b[${close}m` : s)
}

/** Creates a styler; with `enabled=false` it returns strings unchanged. */
export function makeStyle(enabled: boolean): Style {
  return {
    enabled,
    bold: wrap(enabled, 1, 22),
    dim: wrap(enabled, 2, 22),
    red: wrap(enabled, 31, 39),
    green: wrap(enabled, 32, 39),
    yellow: wrap(enabled, 33, 39),
    cyan: wrap(enabled, 36, 39),
  }
}

const ANSI_RE = /\u001b\[[0-9;]*m/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/** 123 ms | 12.3 s | 2m05s | 1h02m */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 3600) {
    const m = Math.floor(totalSec / 60)
    const s = totalSec % 60
    return `${m}m${String(s).padStart(2, '0')}s`
  }
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  return `${h}h${String(m).padStart(2, '0')}m`
}

/** Compact token count: 950 | 1.2k | 3.4M */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const v = Math.round(n)
  if (v < 1000) return String(v)
  if (v < 1_000_000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00'
  if (n === 0) return '$0.00'
  if (Math.abs(n) < 1) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

/** Relative age: "5 s ago", "3 min ago", "2 h ago", "4 days ago". */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ago`
  const d = Math.floor(h / 24)
  return `${d} ${plural(d, 'day', 'days', 'days')} ago`
}

/** Picks the form for n: 1 → one, 2–4 → few, otherwise many (e.g. 1 agent, 2–4 agents, 5+ agents). */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one
  if (n >= 2 && n <= 4) return few
  return many
}

export function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

/** Aligns rows into columns (width is computed without ANSI). The last column is not padded. */
export function formatTable(rows: string[][], indent = ''): string[] {
  if (rows.length === 0) return []
  const cols = Math.max(...rows.map((r) => r.length))
  const widths: number[] = []
  for (let c = 0; c < cols; c++) {
    widths[c] = Math.max(...rows.map((r) => stripAnsi(r[c] ?? '').length))
  }
  return rows.map((r) => {
    const cells = r.map((cell, c) => {
      if (c === r.length - 1) return cell
      return cell + ' '.repeat(Math.max(0, widths[c] - stripAnsi(cell).length))
    })
    return indent + cells.join('  ').trimEnd()
  })
}

/** Time HH:MM:SS (UTC) from an ISO string; invalid input → ''. */
export function formatClock(iso: string): string {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(iso)
  return m ? m[1] : ''
}

/** Safe JSON.stringify (cyclic/non-stringifiable values don't throw). */
export function safeJson(value: unknown, indent?: number): string {
  try {
    const s = JSON.stringify(value, null, indent)
    return s === undefined ? 'null' : s
  } catch {
    return JSON.stringify(String(value))
  }
}
