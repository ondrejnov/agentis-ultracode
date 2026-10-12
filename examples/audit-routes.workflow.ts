/// <reference path="../types/workflow.d.ts" />

// Audit HTTP route handlers: find files → pipeline(audit of a file → adversarial verification of findings)
// → synthesis. Each file goes through audit → verify INDEPENDENTLY (no barrier); the barrier comes only before synthesis,
// because that one really needs all confirmed findings at once.
//
// Run:
//   ultracode run audit-routes --args '{"root":"src/api","focus":["authz","injection"],"votes":3}'
//
// args (all optional):
//   root      directory to audit, relative to the run cwd (default ".")
//   scope     extra sentence for the file search (e.g. "only v2 API versions")
//   focus     list of audit areas (default see FOCUS)
//   maxFiles  cap on the number of audited files (default 40; skipped ones are logged)
//   votes     number of skeptics per finding, 1–5 (default 3)
//   language  report language (default "English")

export const meta = {
  name: 'audit-routes',
  description: 'Audit route handlers: one auditor per file, adversarial verification by independent skeptics, synthesized report',
  whenToUse: 'Security and correctness audit of HTTP routes, controllers or API handlers when false positives must be filtered out.',
  phases: [
    { title: 'Discover', detail: 'find route and handler files' },
    { title: 'Audit', detail: 'one auditor per file' },
    { title: 'Verify', detail: 'independent skeptics try to refute every finding' },
    { title: 'Synthesize', detail: 'deduplicate, rank and write the report' },
  ],
}

interface RouteFile {
  path: string
  kind: string
  summary?: string
}

interface Finding {
  id: string
  title: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  line?: number
  category: string
  description: string
  evidence: string
  fix: string
}

interface AuditResult {
  findings: Finding[]
  notes?: string
}

interface Verdict {
  refuted: boolean
  reason: string
}

interface ConfirmedFinding extends Finding {
  gid: string
  file: string
  votesAgainst: number
  votesTotal: number
}

interface FileOutcome {
  file: string
  audited: boolean
  confirmed: ConfirmedFinding[]
  rejected: number
  unverified: number
}

// ───────── input ─────────

const input = (args ?? {}) as {
  root?: string
  scope?: string
  focus?: string[]
  maxFiles?: number
  votes?: number
  language?: string
}

const ROOT = input.root ?? '.'
const LANGUAGE = input.language ?? 'English'
const MAX_FILES = Math.max(1, input.maxFiles ?? 40)
const VOTES = Math.max(1, Math.min(5, input.votes ?? 3))
const FOCUS = input.focus && input.focus.length
  ? input.focus
  : [
      'authentication and authorization (missing or bypassable checks, IDOR)',
      'input validation and injection (SQL, command, path traversal, XSS, SSRF)',
      'error handling and information leakage',
      'race conditions, missing idempotency, unsafe state changes',
    ]

// Auditors and skeptics must not change anything. Without `tools` the agent runs in bypassPermissions, where only disallowedTools restricts it.
const READONLY = ['Edit', 'Write', 'NotebookEdit']

// Each skeptic looks through a different lens (diverse verify), not N times the same question.
const LENSES = [
  { id: 'reachability', ask: 'Trace callers, routing and middleware: can a real request actually reach the flagged code with the flagged input?' },
  { id: 'impact', ask: 'Considering framework defaults, escaping, ORM parameterisation and surrounding checks: does this cause real harm, or is it neutralised elsewhere?' },
  { id: 'reproduction', ask: 'Construct a concrete request or input that would trigger it and walk it through the code line by line. If you cannot construct one, it is refuted.' },
  { id: 'duplicate-or-intended', ask: 'Is this documented, intended behaviour, a test-only path, or the same root cause as something already covered by framework protection?' },
  { id: 'fix-sanity', ask: 'Would the proposed fix actually remove the problem, and is the problem there to begin with? Check the exact line referenced.' },
]

// ───────── helpers ─────────

const present = <T>(xs: Array<T | null>): T[] => xs.filter((x): x is T => x !== null && x !== undefined)

// ───────── schemas ─────────

const FILES_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          kind: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['path', 'kind'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['files'],
}

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          line: { type: 'number' },
          category: { type: 'string' },
          description: { type: 'string' },
          evidence: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['id', 'title', 'severity', 'category', 'description', 'evidence', 'fix'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['refuted', 'reason'],
}

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    priorities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rank: { type: 'number' },
          title: { type: 'string' },
          gids: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
        },
        required: ['rank', 'title', 'gids', 'rationale'],
      },
    },
    duplicateGroups: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
  },
  required: ['summary', 'priorities'],
}

// ───────── Discover phase ─────────

phase('Discover')

const discovered = await agent<{ files: RouteFile[]; notes?: string }>(
  `You are scoping a security and correctness audit.
Project directory: the current working directory. Audit root: ${ROOT}
${input.scope ? `Additional scope: ${input.scope}\n` : ''}
TASK: list every file under the audit root that DEFINES or DISPATCHES HTTP routes, controllers, API handlers, webhooks or RPC endpoints (not tests, not generated code, not vendored third-party code).
Return paths relative to the current working directory, with a short "kind" (e.g. "express router", "django view", "php presenter") and a one-line summary of what the file exposes.
DO NOT read files in depth and DO NOT modify anything.`,
  { label: 'discover:routes', phase: 'Discover', schema: FILES_SCHEMA, effort: 'low', disallowedTools: READONLY },
)

if (!discovered) {
  throw new Error('The file discovery agent failed; there is nothing to audit.')
}

const uniqueByPath = new Map<string, RouteFile>()
for (const f of discovered.files) {
  if (f && typeof f.path === 'string' && f.path && !uniqueByPath.has(f.path)) uniqueByPath.set(f.path, f)
}
const allFiles = [...uniqueByPath.values()].sort((a, b) => a.path.localeCompare(b.path))
const files = allFiles.slice(0, MAX_FILES)

if (allFiles.length > files.length) {
  // no silent cuts: the user must see what was not audited
  log(`Found ${allFiles.length} files, audited ${files.length}. Skipped: ${allFiles.slice(MAX_FILES).map((f) => f.path).join(', ')}`)
} else {
  log(`Found ${files.length} files to audit.`)
}

if (files.length === 0) {
  return { files: 0, confirmed: [], note: 'No route files found.' }
}

// ───────── Audit + Verify phase (pipeline, no barrier) ─────────

const outcomes = await pipeline(
  files,

  // stage 1: audit of one file
  (f: RouteFile) =>
    agent<AuditResult>(
      `You are a meticulous application-security and correctness auditor.
Audit exactly ONE file: ${f.path}  (${f.kind}${f.summary ? ': ' + f.summary : ''}).
Focus areas:
${FOCUS.map((x) => '- ' + x).join('\n')}

Rules:
- Read the file and follow what it calls (middleware, services, models) as far as needed to judge a flaw. Do NOT report issues that live only in other files.
- Report only concrete flaws with a specific line and evidence (quote the code). No generic advice, no style comments.
- Give each finding a short unique id inside this file (e.g. "A1").
- If the file is clean, return an empty findings array.
- Do NOT modify any file.`,
      { label: `audit:${f.path}`, phase: 'Audit', schema: AUDIT_SCHEMA, effort: 'high', disallowedTools: READONLY },
    ),

  // stage 2: independent skeptics verify each finding; runs as soon as the audit of THIS file is done
  async (audit: AuditResult | null, f: RouteFile): Promise<FileOutcome> => {
    if (!audit) return { file: f.path, audited: false, confirmed: [], rejected: 0, unverified: 0 }

    const confirmed: ConfirmedFinding[] = []
    let rejected = 0
    let unverified = 0

    const judged = await parallel(
      audit.findings.map((finding) => async () => {
        const votes = present(
          await parallel(
            LENSES.slice(0, VOTES).map((lens, i) => () =>
              agent<Verdict>(
                `You are a skeptical reviewer. Another auditor claims a flaw in ${f.path}. Your job is to REFUTE it.
Claim: [${finding.severity}] ${finding.title}${finding.line ? ' (line ' + finding.line + ')' : ''}
Description: ${finding.description}
Evidence quoted by the auditor: ${finding.evidence}
Proposed fix: ${finding.fix}

Your lens: ${lens.id}. ${lens.ask}
Open the file and the code it calls yourself; do not trust the quote. Default to refuted=true if you are uncertain or cannot confirm the flaw from the code.
Return refuted=false ONLY if you verified the flaw is real. Do NOT modify any file.`,
                { label: `verify:${f.path}#${finding.id}/${lens.id}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'medium', disallowedTools: READONLY },
              ),
            ),
          ),
        )
        return { finding, votes }
      }),
    )

    for (const j of present(judged)) {
      const against = j.votes.filter((v) => v.refuted).length
      // without a quorum (fewer than 2 votes, or 1 when votes=1) the finding is not considered confirmed
      const needed = Math.min(2, VOTES)
      if (j.votes.length < needed) {
        unverified++
      } else if (against * 2 >= j.votes.length) {
        rejected++
      } else {
        confirmed.push({ ...j.finding, gid: '', file: f.path, votesAgainst: against, votesTotal: j.votes.length })
      }
    }
    return { file: f.path, audited: true, confirmed, rejected, unverified }
  },
)

const outcomeList = present(outcomes)
const failedFiles = files.length - outcomeList.length + outcomeList.filter((o) => !o.audited).length
const unverified = outcomeList.reduce((n, o) => n + o.unverified, 0)
const rejected = outcomeList.reduce((n, o) => n + o.rejected, 0)

// global IDs are assigned deterministically in code (file, order), not by the agent
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
const confirmed: ConfirmedFinding[] = outcomeList
  .flatMap((o) => o.confirmed)
  .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0))
  .map((f, i) => ({ ...f, gid: 'F' + (i + 1) }))

log(`Confirmed ${confirmed.length}, refuted ${rejected}, unverified ${unverified}, files failed ${failedFiles}.`)

// budget (tokens/USD) exhausted: parallel/pipeline turn the budget error into null, so otherwise it would go unnoticed
const budgetGone = (): boolean => (budget.total !== null && budget.remaining() <= 0) || (budget.totalUsd !== null && budget.remainingUsd() <= 0)

const stats = { files: files.length, filesNotAudited: failedFiles, confirmed: confirmed.length, rejected, unverified }

if (confirmed.length === 0) {
  return { stats: { ...stats, ...(budgetGone() ? { budgetExceeded: true } : {}) }, confirmed: [], report: null }
}

// ───────── Synthesize phase (the barrier is justified: it needs all findings at once) ─────────

phase('Synthesize')

let report: {
  summary: string
  priorities: Array<{ rank: number; title: string; gids: string[]; rationale: string }>
  duplicateGroups?: string[][]
} | null = null
let synthBudgetHit = false
try {
  report = await agent<{
    summary: string
    priorities: Array<{ rank: number; title: string; gids: string[]; rationale: string }>
    duplicateGroups?: string[][]
  }>(
    `You are writing the final report of a route audit. Write it in ${LANGUAGE}.
Below are the CONFIRMED findings (each survived adversarial verification). Their ids are final ("F1"...).
TASK:
1. Merge findings that share one root cause into "duplicateGroups" (arrays of ids).
2. Produce "priorities": a ranked list of remediation work items; every item references existing ids in "gids" and explains the rationale (impact x effort).
3. "summary": 3-6 sentences on the overall state of the audited code.
Use ONLY ids that appear below. Do not invent findings. Do not modify any file.

FINDINGS (JSON):
${JSON.stringify(confirmed.map((f) => ({ gid: f.gid, file: f.file, line: f.line, severity: f.severity, category: f.category, title: f.title, description: f.description, fix: f.fix })), null, 1)}`,
    { label: 'synthesize:report', phase: 'Synthesize', schema: REPORT_SCHEMA, effort: 'high', disallowedTools: READONLY },
  )
} catch (e) {
  // budget exhausted (code BUDGET_EXCEEDED): confirmed findings must not be lost because of a missing summary
  if (e === null || typeof e !== 'object' || (e as { code?: unknown }).code !== 'BUDGET_EXCEEDED') throw e
  synthBudgetHit = true
  log('Budget exhausted before synthesis; returning confirmed findings without a summary.')
}

// Drop references to non-existent IDs (the LLM must not make them up).
const known = new Set(confirmed.map((f) => f.gid))
const cleanedReport = report
  ? {
      summary: report.summary,
      priorities: report.priorities
        .map((p) => ({ ...p, gids: p.gids.filter((g) => known.has(g)) }))
        .filter((p) => p.gids.length > 0),
      duplicateGroups: (report.duplicateGroups ?? []).map((g) => g.filter((x) => known.has(x))).filter((g) => g.length > 1),
    }
  : null

if (!cleanedReport && !synthBudgetHit) log('Synthesis failed; returning confirmed findings without a summary.')

return { stats: { ...stats, ...(synthBudgetHit || budgetGone() ? { budgetExceeded: true } : {}) }, confirmed, report: cleanedReport }
