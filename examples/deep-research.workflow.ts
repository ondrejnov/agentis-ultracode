/// <reference path="../types/workflow.d.ts" />

// Deep research: multi-modal sweep (different search methods) → dedup → cross-verification of claims
// (the source really says what is claimed; independent confirmation) → completeness critic → another round → synthesis with citations.
//
// Run:
//   ultracode run deep-research --args '{"question":"What are the drawbacks of Postgres LISTEN/NOTIFY for job queues?","rounds":2}'
//
// args:
//   question    (required) the question
//   rounds      max. number of sweep → verify → critic rounds (default 2)
//   modalities  subset of: overview, primary, academic, news, community, critique (default all)
//   maxClaims   max. number of new claims to verify per round (default 60; dropped ones are logged)
//   language    answer language (default: the language of the question)
//
// Citations are not created by the synthesizing agent but by code: the agent may reference only the IDs of verified claims ([C3]),
// URLs and source sequence numbers are filled in from data. An invented citation is thus hard to get through.

export const meta = {
  name: 'deep-research',
  description: 'Deep research: multi-modal source sweep, cross-verification of every claim, completeness critic, cited synthesis',
  whenToUse: 'Open-ended factual questions where sources must be checked against each other and the answer needs citations.',
  phases: [
    { title: 'Sweep', detail: 'one searcher per search modality' },
    { title: 'Verify', detail: 'check the quote at the source, then look for independent corroboration' },
    { title: 'Critic', detail: 'what is missing from the answer?' },
    { title: 'Synthesize', detail: 'write the answer with citations from verified claims only' },
  ],
}

interface RawClaim {
  claim: string
  sourceUrl: string
  sourceTitle?: string
  quote: string
  date?: string
  sourceType?: string
}

interface SweepResult {
  claims: RawClaim[]
  sourcesRead?: string[]
  gaps?: string[]
}

interface Candidate extends RawClaim {
  key: string
  modality: string
  alsoFrom: string[]
}

interface SourceCheck {
  supported: boolean
  note: string
  correctedClaim?: string
}

interface Corroboration {
  status: 'corroborated' | 'single-source' | 'contradicted'
  otherUrls: string[]
  note: string
}

interface Checked {
  candidate: Candidate
  status: 'verified' | 'single-source' | 'disputed'
  note: string
  otherUrls: string[]
}

interface Missing {
  aspect: string
  why: string
  suggestedQuery: string
}

const present = <T>(xs: Array<T | null>): T[] => xs.filter((x): x is T => x !== null && x !== undefined)

// ───────── input ─────────

const input = (args ?? {}) as {
  question?: string
  rounds?: number
  modalities?: string[]
  maxClaims?: number
  language?: string
}

if (typeof input.question !== 'string' || !input.question.trim()) {
  throw new Error('Missing args.question (the research question).')
}

const QUESTION = input.question.trim()
const ROUNDS = Math.max(1, Math.min(5, input.rounds ?? 2))
const MAX_CLAIMS = Math.max(1, input.maxClaims ?? 60)
const LANGUAGE = input.language ?? 'the language of the question'
const READONLY = ['Edit', 'Write', 'NotebookEdit']

const ALL_MODALITIES = [
  { id: 'overview', how: 'authoritative overviews and explainers: reference works, well-regarded tutorials, survey articles' },
  { id: 'primary', how: 'PRIMARY sources: official documentation, specifications, standards, legal or regulatory texts, vendor docs, original datasets and source code' },
  { id: 'academic', how: 'academic and technical literature: papers, preprints, theses, benchmarks, systematic reviews' },
  { id: 'news', how: 'recent developments: announcements, release notes, changelogs, news from roughly the last 12 months (always record dates)' },
  { id: 'community', how: 'practitioner experience: issue trackers, forums, Q&A sites, post-mortems, conference talks' },
  { id: 'critique', how: 'counter-evidence: criticism, known failure modes, retractions, disputes, results that contradict the mainstream answer' },
]
const wanted = input.modalities && input.modalities.length ? new Set(input.modalities) : null
const MODALITIES = ALL_MODALITIES.filter((m) => !wanted || wanted.has(m.id))
if (MODALITIES.length === 0) {
  throw new Error('args.modalities does not contain any known modality (' + ALL_MODALITIES.map((m) => m.id).join(', ') + ').')
}

// ───────── schemas ─────────

const SWEEP_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          sourceUrl: { type: 'string' },
          sourceTitle: { type: 'string' },
          quote: { type: 'string' },
          date: { type: 'string' },
          sourceType: { type: 'string' },
        },
        required: ['claim', 'sourceUrl', 'quote'],
      },
    },
    sourcesRead: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['claims'],
}

const SOURCE_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    supported: { type: 'boolean' },
    note: { type: 'string' },
    correctedClaim: { type: 'string' },
  },
  required: ['supported', 'note'],
}

const CORROBORATION_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['corroborated', 'single-source', 'contradicted'] },
    otherUrls: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
  },
  required: ['status', 'otherUrls', 'note'],
}

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    complete: { type: 'boolean' },
    missing: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          aspect: { type: 'string' },
          why: { type: 'string' },
          suggestedQuery: { type: 'string' },
        },
        required: ['aspect', 'why', 'suggestedQuery'],
      },
    },
  },
  required: ['complete', 'missing'],
}

const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    caveats: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['answer', 'caveats', 'openQuestions'],
}

// ───────── helpers ─────────

const normalizeKey = (s: string): string =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ').slice(0, 160)

// Budget (tokens and USD): parallel/pipeline turn the budget error into null, so exhaustion is visible only here.
const budgetGone = (): boolean => (budget.total !== null && budget.remaining() <= 0) || (budget.totalUsd !== null && budget.remainingUsd() <= 0)
const budgetLow = (): boolean => (budget.total !== null && budget.remaining() < 150_000) || (budget.totalUsd !== null && budget.remainingUsd() < 1)
const isBudgetError = (e: unknown): boolean => e !== null && typeof e === 'object' && (e as { code?: unknown }).code === 'BUDGET_EXCEEDED'

const isHttpUrl = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\/\S+$/i.test(u)

// `seen` contains ALL seen claims (including rejected ones), otherwise rejected ones would come back every round.
const seen = new Map<string, Candidate>()

function admit(modality: string, claims: RawClaim[]): Candidate[] {
  const fresh: Candidate[] = []
  for (const c of claims) {
    if (!c || typeof c.claim !== 'string' || !c.claim.trim() || !isHttpUrl(c.sourceUrl) || !c.quote) continue
    const key = normalizeKey(c.claim)
    const known = seen.get(key)
    if (known) {
      // the same claim from another source is a free hint for corroboration
      if (c.sourceUrl !== known.sourceUrl && !known.alsoFrom.includes(c.sourceUrl)) known.alsoFrom.push(c.sourceUrl)
      continue
    }
    const cand: Candidate = { ...c, key, modality, alsoFrom: [] }
    seen.set(key, cand)
    fresh.push(cand)
  }
  return fresh
}

function sweepPrompt(modeLabel: string, how: string, round: number, knownClaims: string[], focus?: string): string {
  return `You are one searcher in a multi-angle research sweep. Research question:
"${QUESTION}"
${focus ? `\nThis round's special focus (a gap found by a critic): ${focus}\n` : ''}
YOUR ANGLE (${modeLabel}): ${how}
Other searchers cover the other angles, so stay on yours.

Use WebSearch and WebFetch (or any other search / browsing tool available to you) to find sources, and OPEN the pages you cite.
TASK: return concrete, self-contained factual claims that bear on the question, each with:
- "claim": one declarative sentence that makes sense without context;
- "sourceUrl": the exact page where YOU read it;
- "quote": a verbatim passage (max 300 characters) from that page that supports the claim;
- "date": publication/update date if visible; "sourceType": e.g. documentation, paper, blog, forum, news.
Rules: never report a claim you did not read on a page you opened; no claims from memory; prefer fewer, solid claims over many weak ones (aim for 5-12). In "gaps" say which aspects of the question you could not cover.
${round > 1 && knownClaims.length ? `\nAlready known — do NOT repeat these:\n${knownClaims.map((k) => '- ' + k).join('\n')}\n` : ''}
Do not modify any files.`
}

async function sweep(tasks: Array<{ modality: string; how: string; focus?: string }>, round: number): Promise<{ fresh: Candidate[]; gaps: string[]; failed: number }> {
  const known = [...seen.values()].slice(-40).map((c) => c.claim.slice(0, 140))
  const results = await parallel(
    tasks.map((t) => async () => {
      const r = await agent<SweepResult>(sweepPrompt(t.modality, t.how, round, known, t.focus), {
        label: `sweep:r${round}:${t.modality}`,
        phase: 'Sweep',
        schema: SWEEP_SCHEMA,
        disallowedTools: READONLY,
      })
      return r ? { modality: t.modality, r } : null
    }),
  )
  const ok = present(results)
  const fresh: Candidate[] = []
  const gaps: string[] = []
  for (const { modality, r } of ok) {
    fresh.push(...admit(modality, r.claims))
    gaps.push(...(r.gaps ?? []))
  }
  return { fresh, gaps, failed: tasks.length - ok.length }
}

// ───────── main run ─────────

const verified: Checked[] = []
const dropped: Array<{ claim: string; url: string; reason: string }> = []
const allGaps: string[] = []
let missing: Missing[] = []
let sweepFailures = 0
let roundsDone = 0
let stoppedBecause = 'rounds'

for (let round = 1; round <= ROUNDS; round++) {
  roundsDone = round
  if (budgetLow()) {
    stoppedBecause = 'budget'
    log('Remaining budget is too low (tokens or USD); the next round is not started.')
    break
  }

  // 1) sweep: each agent searches differently; the barrier is justified here because dedup needs all of them at once
  phase('Sweep')
  const tasks =
    round === 1
      ? MODALITIES.map((m) => ({ modality: m.id, how: m.how }))
      : missing.slice(0, 4).map((m, i) => ({
          modality: 'targeted-' + (i + 1),
          how: 'any source type, but only for the specific gap below',
          focus: `${m.aspect} — ${m.why}. Suggested query: ${m.suggestedQuery}`,
        }))
  const swept = await sweep(tasks, round)
  sweepFailures += swept.failed
  allGaps.push(...swept.gaps)

  // no silent cuts: what does not fit the limit is logged
  const ranked = [...swept.fresh].sort((a, b) => b.alsoFrom.length - a.alsoFrom.length)
  const toVerify = ranked.slice(0, MAX_CLAIMS)
  if (ranked.length > toVerify.length) {
    log(`Round ${round}: ${ranked.length} new claims, verifying ${toVerify.length}; not verified: ${ranked.slice(MAX_CLAIMS).map((c) => c.claim.slice(0, 60)).join(' | ')}`)
  }
  log(`Round ${round}: ${swept.fresh.length} new claims from ${tasks.length - swept.failed}/${tasks.length} sweeps.`)

  if (toVerify.length === 0) {
    stoppedBecause = budgetGone() ? 'budget' : 'dry'
    break
  }

  // 2) verification: pipeline — the second (more expensive) stage runs only for claims that passed the source check
  const checked = await pipeline(
    toVerify,

    // stage 1: does the source really say what is claimed?
    (c: Candidate) =>
      agent<SourceCheck>(
        `You are a fact-checker. Open this page yourself: ${c.sourceUrl}
A researcher claims:
"${c.claim}"
and quotes: "${c.quote}"
TASK: (1) find the quote (or a faithful equivalent) on the page; (2) judge whether the page really supports the claim as worded, including numbers, dates, scope and qualifiers (not merely mentions the topic).
supported=true only if the page itself supports the claim. If the claim overstates the source but a narrower version is supported, set supported=true and give the accurate wording in "correctedClaim".
If the page cannot be opened or the quote is absent, supported=false. Do not use outside knowledge. Do not modify any files.`,
        { label: `verify:src:${c.key.slice(0, 40)}`, phase: 'Verify', schema: SOURCE_CHECK_SCHEMA, effort: 'low', disallowedTools: READONLY },
      ),

    // stage 2: independent confirmation (or refutation) from another source
    async (check: SourceCheck | null, c: Candidate): Promise<Checked | null> => {
      if (!check) return null
      if (!check.supported) {
        dropped.push({ claim: c.claim, url: c.sourceUrl, reason: 'source does not support the claim: ' + check.note })
        return null
      }
      const wording = check.correctedClaim && check.correctedClaim.trim() ? check.correctedClaim.trim() : c.claim
      const corr = await agent<Corroboration>(
        `You are an independent verifier. Claim to examine:
"${wording}"
It was found at ${c.sourceUrl}.${c.alsoFrom.length ? ' Other researchers also saw it at: ' + c.alsoFrom.join(', ') + ' (check that they are not mere copies).' : ''}
TASK: search for at least one source INDEPENDENT of that page (different publisher, not a mirror or a rewrite of the same text) that supports the claim, AND look for credible evidence against it.
status: "corroborated" = independent support found; "single-source" = only the original source says it, nothing contradicts; "contradicted" = credible evidence against it.
List the URLs you relied on in "otherUrls". Open the pages you cite. Do not modify any files.`,
        { label: `verify:corr:${c.key.slice(0, 40)}`, phase: 'Verify', schema: CORROBORATION_SCHEMA, disallowedTools: READONLY },
      )
      if (!corr) {
        // verification failed: we do not want to claim more than we know → single-source
        return { candidate: { ...c, claim: wording }, status: 'single-source', note: 'independent verification failed', otherUrls: [] }
      }
      const status = corr.status === 'corroborated' ? 'verified' : corr.status === 'contradicted' ? 'disputed' : 'single-source'
      return { candidate: { ...c, claim: wording }, status, note: corr.note, otherUrls: corr.otherUrls.filter(isHttpUrl) }
    },
  )

  const good = present(checked)
  verified.push(...good)
  log(`Round ${round}: verified ${good.filter((g) => g.status === 'verified').length}, single source ${good.filter((g) => g.status === 'single-source').length}, disputed ${good.filter((g) => g.status === 'disputed').length}, rejected ${toVerify.length - good.length}.`)

  if (budgetGone()) {
    stoppedBecause = 'budget'
    log('Budget exhausted; the next round is not started.')
    break
  }
  if (round === ROUNDS) break

  // 3) completeness critic: what is missing? This becomes the work for the next round.
  phase('Critic')
  const summary = verified.slice(0, 80).map((v) => `- (${v.status}) ${v.candidate.claim}`).join('\n')
  let critic: { complete: boolean; missing: Missing[] } | null = null
  try {
    critic = await agent<{ complete: boolean; missing: Missing[] }>(
    `You are a completeness critic for a research effort.
Question: "${QUESTION}"
Claims gathered and checked so far:
${summary || '(none)'}
Gaps reported by searchers:
${allGaps.slice(-20).map((g) => '- ' + g).join('\n') || '(none)'}
TASK: decide whether these claims suffice for a thorough, balanced answer. If not, list up to 4 concrete missing aspects (a sub-question, a missing viewpoint, an unverified assumption, a source type not consulted), each with a search query that would close the gap. complete=true only if you would sign off on the answer.
Do not modify any files.`,
    { label: `critic:r${round}`, phase: 'Critic', schema: CRITIC_SCHEMA, effort: 'medium', disallowedTools: READONLY },
    )
  } catch (e) {
    if (!isBudgetError(e)) throw e
    stoppedBecause = 'budget'
    log('Budget exhausted during completeness assessment; continuing with synthesis from verified claims.')
    break
  }
  if (!critic) {
    log('Critic failed; continuing without another round.')
    stoppedBecause = 'critic-failed'
    break
  }
  missing = critic.missing
  if (critic.complete || missing.length === 0) {
    stoppedBecause = 'complete'
    break
  }
}

// ───────── synthesis ─────────

// disputed claims go into synthesis on purpose (as disputed); rejected ones are no longer in `verified`
const usable = verified
if (usable.length === 0) {
  const outOfBudget = stoppedBecause === 'budget' || budgetGone()
  return {
    question: QUESTION,
    answer: null,
    note: outOfBudget ? 'Budget exhausted before any claim could be verified.' : 'No claim could be verified.',
    stats: { rounds: roundsDone, stoppedBecause: outOfBudget ? 'budget' : stoppedBecause, sweepFailures, dropped: dropped.length },
    dropped,
  }
}

// Claim IDs are assigned in code; the synthesizing agent may use only these IDs
const claims = usable.map((v, i) => ({ id: 'C' + (i + 1), ...v }))
const byId = new Map(claims.map((c) => [c.id, c]))

phase('Synthesize')
let synth: { answer: string; caveats: string[]; openQuestions: string[] } | null = null
let synthBudgetHit = false
try {
  synth = await agent<{ answer: string; caveats: string[]; openQuestions: string[] }>(
  `Write the final answer to this research question, in ${LANGUAGE}:
"${QUESTION}"

You may use ONLY the verified claims below. Cite each statement by its id in square brackets, e.g. "... is slower [C3]" or "[C2, C7]". Rules:
- Claims with status "verified" can be stated plainly. "single-source" must be flagged as resting on one source. "disputed" claims must be presented as contested, never as fact.
- If claims conflict, say so and explain which is better supported.
- Do not add facts that are not in the claims. If the claims do not answer part of the question, say so under openQuestions.
- Structure: short direct answer first, then the detail (Markdown). No source list — the citations are rendered from the ids.

CLAIMS (JSON):
${JSON.stringify(claims.map((c) => ({ id: c.id, status: c.status, claim: c.candidate.claim, source: c.candidate.sourceUrl, sourceType: c.candidate.sourceType, date: c.candidate.date, corroboration: c.otherUrls, note: c.note })), null, 1)}
${allGaps.length ? `\nGaps reported by searchers: ${allGaps.slice(-10).join('; ')}` : ''}
Do not modify any files.`,
    { label: 'synthesize:answer', phase: 'Synthesize', schema: SYNTH_SCHEMA, effort: 'high', disallowedTools: READONLY },
  )
} catch (e) {
  if (!isBudgetError(e)) throw e
  synthBudgetHit = true
  stoppedBecause = 'budget'
  log('Budget exhausted before synthesis; returning verified claims.')
}

if (!synth) {
  return {
    question: QUESTION,
    answer: null,
    note: synthBudgetHit ? 'Budget exhausted before synthesis; returning verified claims.' : 'Synthesis failed; returning verified claims.',
    claims: claims.map((c) => ({ id: c.id, status: c.status, claim: c.candidate.claim, source: c.candidate.sourceUrl })),
    stats: { rounds: roundsDone, stoppedBecause, sweepFailures, dropped: dropped.length },
  }
}

// citations [C3, C7] → [1, 2]; we number by URL in order of first appearance, unknown IDs are dropped
const urlNo = new Map<string, number>()
const rendered = synth.answer.replace(/\[\s*(C\d+(?:\s*,\s*C\d+)*)\s*\]/g, (_m: string, ids: string) => {
  const nums: number[] = []
  for (const id of ids.split(/\s*,\s*/)) {
    const c = byId.get(id)
    if (!c) continue
    const url = c.candidate.sourceUrl
    if (!urlNo.has(url)) urlNo.set(url, urlNo.size + 1)
    const n = urlNo.get(url) as number
    if (!nums.includes(n)) nums.push(n)
  }
  return nums.length ? '[' + nums.sort((a, b) => a - b).join(', ') + ']' : ''
})

const sources = [...urlNo.entries()].map(([url, n]) => {
  const c = claims.find((x) => x.candidate.sourceUrl === url)
  return { n, url, title: c ? c.candidate.sourceTitle ?? null : null }
})

return {
  question: QUESTION,
  answer: rendered,
  sources,
  caveats: synth.caveats,
  openQuestions: synth.openQuestions,
  disputed: claims.filter((c) => c.status === 'disputed').map((c) => ({ claim: c.candidate.claim, source: c.candidate.sourceUrl, note: c.note })),
  stats: {
    rounds: roundsDone,
    stoppedBecause,
    claimsUsed: claims.length,
    verified: claims.filter((c) => c.status === 'verified').length,
    singleSource: claims.filter((c) => c.status === 'single-source').length,
    disputed: claims.filter((c) => c.status === 'disputed').length,
    dropped: dropped.length,
    sweepFailures,
  },
  dropped,
}
