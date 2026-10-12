# Quality patterns for workflows (TypeScript)

Patterns compose freely. Each one is here as a standalone snippet; complete scripts are
in `examples/*.workflow.ts`. The snippets assume the runtime globals (`agent`, `parallel`, `pipeline`, `log`,
`budget`, `args`) and declare the inputs they use.

## Contents

0. Helper functions
1. Adversarial verify (skeptics try to refute)
2. Perspective-diverse verify (each a different lens)
3. Judge panel
4. Loop-until-dry
5. Multi-modal sweep (different ways of searching)
6. Completeness critic (what is missing?)
7. Pipeline vs. barrier + smell test
8. When a barrier is correct
9. Partitions without path overlap
10. Loop-until-green (fix until it passes)
11. Budget loops
12. Hybrid: scout inline, then fan-out
13. Synthesis with bounded input (map-reduce)
14. No silent cuts
15. IDs and citations assigned by code

---

## 0. Helper functions

A script has no imports, so define helper functions at the top. These are almost always useful:

```ts
/** Removes `null`/`undefined` from an array and keeps the type. `filter(Boolean)` does not narrow the type. */
const present = <T>(xs: Array<T | null | undefined>): T[] => xs.filter((x): x is T => x !== null && x !== undefined)

/** Splits an array into batches. */
const chunk = <T>(xs: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

/** Stable key for dedup (ignores case and punctuation differences). */
const normKey = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 160)

const demo = present([1, null, 2])
log(`present: ${demo.length}, chunks: ${chunk(demo, 1).length}, key: ${normKey('Hello, world!')}`)
```

## 1. Adversarial verify

**When:** a finding/claim must survive before you believe it. Prevention of "plausible but wrong" results.

**How:** N independent skeptics per finding; each must **refute**; the finding survives if most say "not refuted".
A skeptic gets no author justification, only the claim and the evidence. Skeptic failures must not silently confirm the finding.

```ts
interface Verdict {
  refuted: boolean
  reason: string
}

const VERDICT = {
  type: 'object',
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['refuted', 'reason'],
}

async function survives(claim: string, evidence: string, votes = 3): Promise<{ ok: boolean; cast: number; against: number }> {
  const results = await parallel(
    Array.from({ length: votes }, (_, i) => () =>
      agent<Verdict>(
        `You are skeptic #${i + 1}. Try to REFUTE this claim by checking the code yourself.\nClaim: ${claim}\nEvidence quoted by the author: ${evidence}\nDefault to refuted=true if you are uncertain. Return refuted=false ONLY if you verified the claim is real. Do not modify any files.`,
        { label: `skeptic:${i + 1}`, phase: 'Verify', schema: VERDICT, disallowedTools: ['Edit', 'Write'] },
      ),
    ),
  )
  const cast = results.filter((v): v is Verdict => v !== null)
  const against = cast.filter((v) => v.refuted).length
  // quorum: we need at least 2 valid votes (or all of them, if fewer votes were cast); a tie = refuted
  const quorum = Math.min(2, votes)
  return { ok: cast.length >= quorum && against * 2 < cast.length, cast: cast.length, against }
}

const verdict = await survives('The delete() function does not check the record owner', 'src/api/items.ts:42', 3)
log(`survived: ${verdict.ok} (${verdict.cast} votes, ${verdict.against} against)`)
```

**Warning:** without a quorum, `null` votes would look like "nobody refuted it" and the finding would pass. Return the counts too
(`cast`, `against`) so it is visible how strong the consensus was.

## 2. Perspective-diverse verify

**When:** a finding can fail in several ways. N identical skeptics share the same blind spot; different lenses do not.

```ts
const LENSES = [
  { id: 'reachability', ask: 'Can a real request reach this code with the flagged input? Trace callers and middleware.' },
  { id: 'impact', ask: 'Given framework defaults and surrounding checks, does it cause real harm?' },
  { id: 'reproduction', ask: 'Construct a concrete input and walk it through the code. If you cannot, refute.' },
]

const finding = { title: 'SQL injection in sorting', file: 'src/list.ts', line: 17 }

const votes = await parallel(
  LENSES.map((lens) => () =>
    agent<{ refuted: boolean; reason: string }>(
      `Skeptical review of: ${finding.title} (${finding.file}:${finding.line}).\nYour lens: ${lens.id}. ${lens.ask}\nDefault to refuted=true if uncertain. Do not modify files.`,
      {
        label: `verify:${lens.id}`,
        phase: 'Verify',
        schema: {
          type: 'object',
          properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
          required: ['refuted', 'reason'],
        },
      },
    ),
  ),
)
const refutedBy = LENSES.filter((_, i) => votes[i] && votes[i]!.refuted).map((l) => l.id)
log(`refuted by lenses: ${refutedBy.join(', ') || 'none'}`)
```

**Warning:** order the lenses by importance — when `votes < LENSES.length`, a prefix is used (`LENSES.slice(0, votes)`).

## 3. Judge panel

**When:** the solution space is wide (architecture design, plan, refactor). One attempt iterated over and over
converges to a local optimum; N independent attempts from different angles and a panel are better.

**How:** generate N attempts from **different** angles → judges score them anonymously → synthesis from the winner + the best
ideas from the others. All three steps depend on the whole set, so barriers are correct here.

```ts
const task = 'Propose how to split the monolithic billing module into services.'
const ANGLES = ['MVP-first: the smallest step that delivers value', 'risk-first: remove the biggest risk first', 'user-first: start from the impact on users']

const PLAN = {
  type: 'object',
  properties: { title: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } }, risks: { type: 'array', items: { type: 'string' } } },
  required: ['title', 'steps', 'risks'],
}

phase('Draft')
const drafts = present(
  await parallel(
    ANGLES.map((angle, i) => () =>
      agent<{ title: string; steps: string[]; risks: string[] }>(`${task}\nApproach: ${angle}. Propose a plan independently, regardless of other options.`, {
        label: `draft:${i + 1}`,
        phase: 'Draft',
        schema: PLAN,
      }),
    ),
  ),
)
if (drafts.length < 2) throw new Error('The panel needs at least two drafts.')

phase('Judge')
const SCORE = {
  type: 'object',
  properties: { scores: { type: 'array', items: { type: 'number' } }, bestIdx: { type: 'number' }, comment: { type: 'string' } },
  required: ['scores', 'bestIdx', 'comment'],
}
const judges = present(
  await parallel(
    ['correctness and completeness', 'feasibility and cost', 'risk and reversibility'].map((criterion, j) => () =>
      agent<{ scores: number[]; bestIdx: number; comment: string }>(
        `Score the drafts by the criterion "${criterion}" (0-10). Return the scores in the same order and the index of the best one.\n${drafts.map((d, i) => `# Draft ${i}\n${JSON.stringify(d)}`).join('\n\n')}`,
        { label: `judge:${j + 1}`, phase: 'Judge', schema: SCORE, effort: 'high' },
      ),
    ),
  ),
)

// the winner is computed in code, not by an agent
const totals = drafts.map((_, i) => judges.reduce((sum, j) => sum + (j.scores[i] ?? 0), 0))
const winner = totals.indexOf(Math.max(...totals))
log(`winner: draft ${winner} (${totals.join(' / ')})`)

phase('Synthesize')
const final = await agent(
  `Create the final plan: start from the winning draft and add the best ideas from the others (and explain where they come from).\nWinner:\n${JSON.stringify(drafts[winner])}\nOthers:\n${JSON.stringify(drafts.filter((_, i) => i !== winner))}\nJudge notes:\n${judges.map((j) => j.comment).join('\n')}`,
  { label: 'synthesize', phase: 'Synthesize' },
)
return { winner, totals, final }
```

**Warning:** the angles must really be different, otherwise it is just N copies. Judges must not know which draft is "winning".

## 4. Loop-until-dry

**When:** an unknown number of findings (bugs, cases, edge states). A plain `while (count < N)` mines the tail.

**How:** search in rounds until K consecutive rounds return nothing new. Dedup against **all seen** findings
(including rejected ones), otherwise rejected ones come back and the loop never converges.

```ts
interface Bug {
  file: string
  title: string
}

const FINDERS = ['look for bugs in error handling', 'look for bugs in concurrency', 'look for bugs in time and time zone handling']
const BUGS = {
  type: 'object',
  properties: {
    bugs: {
      type: 'array',
      items: { type: 'object', properties: { file: { type: 'string' }, title: { type: 'string' } }, required: ['file', 'title'] },
    },
  },
  required: ['bugs'],
}

const seen = new Set<string>()
const confirmed: Bug[] = []
let dry = 0
let round = 0

while (dry < 2 && round < 6) {
  // the round cap (round < 6) is a safety net; without it an agent that keeps "finding" something would keep the loop going
  round++
  const found = present(
    await parallel(
      FINDERS.map((prompt, i) => () =>
        agent<{ bugs: Bug[] }>(
          `${prompt} in the src/ directory. Round ${round}. Do not report already known ones:\n${[...seen].slice(-30).join('\n') || '(nothing)'}\nDo not modify anything.`,
          { label: `find:r${round}:${i + 1}`, phase: 'Find', schema: BUGS },
        ),
      ),
    ),
  ).flatMap((r) => r.bugs)

  const fresh = found.filter((b) => !seen.has(`${b.file}|${normKey(b.title)}`))
  if (fresh.length === 0) {
    dry++
    continue
  }
  dry = 0
  for (const b of fresh) seen.add(`${b.file}|${normKey(b.title)}`) // dedup against ALL seen findings
  confirmed.push(...fresh) // verification (pattern 1) belongs here — simplified here
  log(`round ${round}: ${fresh.length} new, ${confirmed.length} in total`)
}
return { rounds: round, bugs: confirmed }
```

**Warning:** when combined with verification, dedup against `seen`, not against `confirmed`. Always set a round cap.
`normKey` is from section 0.

## 5. Multi-modal sweep

**When:** no single search method finds everything (research, audit, finding API usages).

**How:** parallel agents, each searching **differently**: by container (directory), content (grep of patterns), entity
(symbol/name), time (history, changes). Each is blind to the others — that is intentional. Results are merged and deduplicated
only in code.

```ts
const target = 'function legacyCharge()'
const MODES = [
  { id: 'by-container', how: 'walk the directory structure and find which modules work with it' },
  { id: 'by-content', how: 'grep for direct calls, reflection, dynamic calls via strings, and configuration' },
  { id: 'by-entity', how: 'follow the symbol through re-exports, aliases, and types; also look at tests and documentation' },
  { id: 'by-time', how: 'walk the history (git log -S) and the TODO/FIXME comments related to it' },
]

const HITS = {
  type: 'object',
  properties: {
    hits: {
      type: 'array',
      items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, note: { type: 'string' } }, required: ['file', 'note'] },
    },
  },
  required: ['hits'],
}

const sweeps = await parallel(
  MODES.map((m) => () =>
    agent<{ hits: Array<{ file: string; line?: number; note: string }> }>(
      `Find all places that use or affect: ${target}.\nYour search method (this one only): ${m.how}.\nDo not modify anything. Return the file, the line, and a short note.`,
      { label: `sweep:${m.id}`, phase: 'Sweep', schema: HITS, disallowedTools: ['Edit', 'Write'] },
    ),
  ),
)

const byKey = new Map<string, { file: string; line?: number; note: string; foundBy: string[] }>()
sweeps.forEach((s, i) => {
  if (!s) return
  for (const h of s.hits) {
    const key = `${h.file}:${h.line ?? 0}`
    const entry = byKey.get(key)
    if (entry) entry.foundBy.push(MODES[i].id)
    else byKey.set(key, { ...h, foundBy: [MODES[i].id] })
  }
})
const failedModes = MODES.filter((_, i) => sweeps[i] === null).map((m) => m.id)
return { hits: [...byKey.values()], failedModes }
```

**Warning:** places found by only one method are valuable (they show what the others missed) — `foundBy` is the
completeness signal. Always return the failed methods.

## 6. Completeness critic

**When:** after gathering data, before synthesis. The last agent asks "what is missing?" — a modality we did not run, an
unverified claim, an unread source. What it finds becomes another round of work.

```ts
const question = 'Why does CI sometimes fail on the integration tests?'
const gathered = ['Test A uses a shared DB without isolation', 'Test B depends on the execution order']

const CRITIC = {
  type: 'object',
  properties: {
    complete: { type: 'boolean' },
    missing: {
      type: 'array',
      items: {
        type: 'object',
        properties: { aspect: { type: 'string' }, query: { type: 'string' } },
        required: ['aspect', 'query'],
      },
    },
  },
  required: ['complete', 'missing'],
}

for (let round = 1; round <= 2; round++) {
  const critic = await agent<{ complete: boolean; missing: Array<{ aspect: string; query: string }> }>(
    `You are a completeness critic. Question: "${question}"\nFound so far:\n${gathered.map((g) => '- ' + g).join('\n')}\nDetermine whether this is enough for a thorough and balanced answer. If not, list at most 4 concrete gaps (an aspect + the query that fills it). complete=true only if you would sign the answer. Do not modify anything.`,
    { label: `critic:r${round}`, phase: 'Critic', schema: CRITIC },
  )
  if (!critic || critic.complete || critic.missing.length === 0) break
  const more = await parallel(
    critic.missing.slice(0, 4).map((m, i) => () =>
      agent(`Fill this gap: ${m.aspect}. Query: ${m.query}. Return short, verifiable findings.`, { label: `gap:r${round}:${i + 1}`, phase: 'Fill' }),
    ),
  )
  gathered.push(...present(more))
}
return gathered
```

**Warning:** a critic that fails (`null`) must neither loop forever nor declare "complete" — in the example
the loop ends and the result is returned without a verdict (log it).

## 7. Pipeline vs. barrier + smell test

**Wrong** — a barrier that needs nothing:

```ts nocheck
const audits = await parallel(files.map((f) => () => agent(`audit ${f}`, { schema: AUDIT })))
const findings = audits.filter(Boolean).flatMap((a) => a.findings)        // just a transformation
const verdicts = await parallel(findings.map((f) => () => agent(`verify ${f.title}`, { schema: V })))
```

The slowest audit delays the verification of all the other files.

**Right** — pipeline; the transformation goes inside a stage, each file flows independently:

```ts
const files = ['src/a.ts', 'src/b.ts', 'src/c.ts']
const AUDIT = {
  type: 'object',
  properties: { findings: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } } },
  required: ['findings'],
}
const V = { type: 'object', properties: { real: { type: 'boolean' } }, required: ['real'] }

const results = await pipeline(
  files,
  (f: string) => agent<{ findings: Array<{ title: string }> }>(`audit ${f}`, { phase: 'Audit', schema: AUDIT }),
  async (audit, f: string) => {
    if (!audit) return { file: f, confirmed: [] as string[], failed: true }
    const checked = await parallel(
      audit.findings.map((fi) => () => agent<{ real: boolean }>(`verify ${fi.title} in ${f}`, { phase: 'Verify', schema: V })),
    )
    const confirmed = audit.findings.filter((_, i) => checked[i] && checked[i]!.real).map((fi) => fi.title)
    return { file: f, confirmed, failed: false }
  },
)
return present(results)
```

**Control question:** does stage N need to see the results of ALL items of stage N−1? No → pipeline.

## 8. When a barrier is correct

There are three legitimate reasons: **dedup across the whole set** before an expensive step, **early exit** when there are zero findings,
and **comparison** ("other findings" in the prompt).

```ts
const modes = ['A', 'B', 'C']
const FINDINGS = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, text: { type: 'string' } }, required: ['key', 'text'] } } },
  required: ['items'],
}

const all = await parallel(modes.map((m) => () => agent<{ items: Array<{ key: string; text: string }> }>(`search using method ${m}`, { phase: 'Find', schema: FINDINGS })))

// barrier: dedup needs all of them at once
const unique = new Map<string, string>()
for (const r of present(all)) for (const it of r.items) if (!unique.has(it.key)) unique.set(it.key, it.text)

if (unique.size === 0) return { findings: [], note: 'Nothing found, verification skipped.' } // early exit

const verified = await parallel(
  [...unique.entries()].map(([key, text]) => () => agent<{ real: boolean }>(`verify: ${text}`, { phase: 'Verify', schema: { type: 'object', properties: { real: { type: 'boolean' } }, required: ['real'] } }).then((v) => ({ key, text, real: !!v && v.real }))),
)
return present(verified).filter((v) => v.real)
```

## 9. Partitions without path overlap

**When:** agents **write** to the same working tree (migrations, bulk fixes). The runtime has no worktree
isolation, so two agents on the same file would silently overwrite each other's work.

**How:** a partition = a set of paths; ownership is disjoint; overlap is checked **in code before the first agent**;
foreign files must not be changed, only reported. Cross-cutting changes run before the partitions in a separate phase.

```ts
interface Partition {
  key: string
  paths: string[]
}

const PARTITIONS: Partition[] = [
  { key: 'api', paths: ['src/api', 'src/routes'] },
  { key: 'ui', paths: ['src/ui'] },
  { key: 'lib', paths: ['src/lib'] },
]

// deterministic overlap check (same path or one inside the other); paths are first canonicalized
// (no '', '.', '//', '..'), otherwise 'app/../app' or '.' would get past the check. An empty path = the whole root.
const norm = (p: string): string => {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) throw new Error('Path escapes the root: ' + p)
      out.pop()
    } else out.push(seg)
  }
  return out.join('/')
}
const clash = (a: string, b: string) => a === b || a === '' || b === '' || a.startsWith(b + '/') || b.startsWith(a + '/')
const owners: Array<{ path: string; key: string }> = []
for (const p of PARTITIONS) {
  for (const raw of p.paths) {
    const path = norm(raw)
    const hit = owners.find((o) => clash(o.path, path))
    if (hit) throw new Error(`Partitions overlap: ${p.key} (${raw}) vs. ${hit.key} (${hit.path || '.'})`)
    owners.push({ path, key: p.key })
  }
}

const RESULT = {
  type: 'object',
  properties: {
    filesChanged: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    outsidePartition: { type: 'array', items: { type: 'string' } },
  },
  required: ['filesChanged', 'summary', 'outsidePartition'],
}

const results = await pipeline(
  PARTITIONS,
  (p: Partition) =>
    agent<{ filesChanged: string[]; summary: string; outsidePartition: string[] }>(
      `Fix deprecated calls in partition "${p.key}". You may change ONLY files under: ${p.paths.join(', ')}.\nOther partitions are being edited by other agents at the same time: ${PARTITIONS.filter((x) => x.key !== p.key).flatMap((x) => x.paths).join(', ')}.\nDo not make changes outside your partition; describe them (file, line, exact change) in "outsidePartition".`,
      { label: `fix:${p.key}`, phase: 'Fix', schema: RESULT },
    ),
)

const failed = PARTITIONS.filter((_, i) => results[i] === null).map((p) => p.key)
return { results: present(results), failed, outside: present(results).flatMap((r) => r.outsidePartition) }
```

**Warning:** express "everything except X" as an enumeration of subdirectories, not as a negation, so the overlap can be checked.
Process the collected `outsidePartition` in another round (or hand it to the user).

## 10. Loop-until-green

**When:** "fix until the command passes" (tests, build, lint, typecheck).

**How:** round = *measurement* (an agent runs the command and returns the exit code + failures) → *fix* (agents with disjoint
files) → measure again. Stop: exit 0, **2 consecutive rounds without a drop in failures**, round cap, budget. Once green, an independent
confirmation by another agent (and a check that nobody made it "green" by removing tests).

```ts
const COMMAND = 'npm test'
const MAX_ROUNDS = 6
const STALL_LIMIT = 2

interface Report {
  exitCode: number
  totalFailures: number
  failures: Array<{ id: string; file?: string; summary: string }>
}

const RUN = {
  type: 'object',
  properties: {
    exitCode: { type: 'number' },
    totalFailures: { type: 'number' },
    failures: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, file: { type: 'string' }, summary: { type: 'string' } }, required: ['id', 'summary'] },
    },
  },
  required: ['exitCode', 'totalFailures', 'failures'],
}

let best = Infinity
let stalled = 0
let status = 'max-rounds'

for (let round = 1; round <= MAX_ROUNDS; round++) {
  const run = await agent<Report>(
    `Round ${round}. Run exactly: ${COMMAND}. Do not fix anything. Return the exit code, the actual number of failures, and the list of failures (id, file, summary).`,
    { label: `run:round-${round}`, phase: 'Run', schema: RUN, effort: 'low', disallowedTools: ['Edit', 'Write'] },
  )
  if (!run) {
    // the measuring agent failed, not the command: count it as a round without progress so the loop cannot spin forever
    stalled++
    if (stalled >= STALL_LIMIT) { status = 'no-progress'; break }
    continue
  }
  if (run.exitCode === 0) { status = 'green'; break }

  const n = Math.max(run.totalFailures, run.failures.length)
  if (n < best) { best = n; stalled = 0 } else { stalled++ }
  if (stalled >= STALL_LIMIT) { status = 'no-progress'; break }
  if (round === MAX_ROUNDS) break // after the last measurement, do not fix anymore (an unverified fix)

  const byFile = new Map<string, string[]>()
  for (const f of run.failures) byFile.set(f.file ?? '(unknown)', [...(byFile.get(f.file ?? '(unknown)') ?? []), `${f.id}: ${f.summary}`])
  await parallel(
    [...byFile.entries()].map(([file, items]) => () =>
      agent(`Fix the failures in file ${file} (and only in it). Failures:\n${items.join('\n')}\nDo not weaken the tests or the command.`, { label: `fix:r${round}:${file}`, phase: 'Fix' }),
    ),
  )
}
return { status, best: best === Infinity ? null : best }
```

**Warning:** the measurement must be done by a different agent than the fix; "I fixed it" from the fixer means nothing. The full
version (file groups, confirmation, budget) is in `examples/fix-until-green.workflow.ts`.

## 11. Budget loops

Two ways to scale work according to `--max-tokens` / `--max-usd`.

**Dynamically** — run rounds as long as there is budget:

```ts
const notes: string[] = []
// guard on budget.total: without a limit remaining() is Infinity and the loop would run up to 1000 agents
while (budget.total !== null && budget.remaining() > 50_000 && notes.length < 40) {
  const r = await agent(`Find another interesting problem in src/. Already known:\n${notes.slice(-20).join('\n')}`, { label: `probe:${notes.length + 1}` })
  if (!r) break
  notes.push(r)
  log(`${notes.length} findings, ${Math.round(budget.remaining() / 1000)}k tokens left`)
}
```

**Statically** — fleet size from the budget:

```ts
const FLEET = budget.total !== null ? Math.max(1, Math.min(20, Math.floor(budget.total / 100_000))) : 5
log(`fleet: ${FLEET} agents`)
const outs = await parallel(
  Array.from({ length: FLEET }, (_, i) => () => agent(`Explore area no. ${i + 1} of ${FLEET}.`, { label: `fleet:${i + 1}` })),
)
log(`done: ${outs.filter(Boolean).length}/${FLEET}`)
```

**Warning:** always have a hard cap on the count (`< 40`, `Math.min(20, …)`), independent of the budget; the budget counts only
output tokens. With `--max-usd` use `budget.totalUsd` / `budget.remainingUsd()`.

## 12. Hybrid: scout inline, then fan-out

The best workflows start with *you* determining the scope using ordinary tools and passing it to the script:

```bash
# 1) determine the scope yourself
git diff --name-only origin/main...HEAD -- 'src/**/*.ts' > /tmp/changed.txt
# 2) pass as args
ultracode run review-changes --args "$(jq -Rn '{files: [inputs]}' < /tmp/changed.txt)"
```

In the script, the input is validated, duplicate work is dropped, and cuts are logged:

```ts
const input = (args ?? {}) as { files?: string[]; maxFiles?: number }
if (!Array.isArray(input.files) || input.files.length === 0) {
  throw new Error('Missing args.files (non-empty array of paths).')
}
const unique = [...new Set(input.files)].sort()
const cap = input.maxFiles ?? 50
const files = unique.slice(0, cap)
if (unique.length > files.length) log(`Cut: ${unique.length} → ${files.length}; omitted: ${unique.slice(cap).join(', ')}`)

const reviews = await pipeline(files, (f: string) => agent(`Review the changes in ${f}.`, { label: `review:${f}`, phase: 'Review' }))
return { reviewed: present(reviews).length, requested: unique.length, failed: files.length - present(reviews).length }
```

When the scope cannot be determined in advance, do a first phase with one agent and a schema (`{ files: [...] }`) — like
`Discover` in `examples/audit-routes.workflow.ts`.

## 13. Synthesis with bounded input (map-reduce)

A synthesizing agent with thousands of findings in the prompt gets its context flooded and decides superficially. Do sorting and cutting
in code; if there is a lot of data, reduce in layers.

```ts
interface Item {
  id: string
  text: string
}

const items: Item[] = Array.from({ length: 120 }, (_, i) => ({ id: `F${i + 1}`, text: `finding ${i + 1}` }))
const BATCH = 30

// map: batches → partial summaries (each batch independently)
const partials = present(
  await parallel(
    chunk(items, BATCH).map((batch, i) => () =>
      agent(`Summarize these findings into at most 10 points and keep the ids in square brackets:\n${batch.map((b) => `[${b.id}] ${b.text}`).join('\n')}`, {
        label: `reduce:batch-${i + 1}`,
        phase: 'Synthesize',
      }),
    ),
  ),
)

// reduce: one agent over the partial summaries
const report = await agent(`Write the final report from these partial summaries; keep the id references:\n${partials.join('\n---\n')}`, {
  label: 'reduce:final',
  phase: 'Synthesize',
})
return { batches: partials.length, expected: Math.ceil(items.length / BATCH), report }
```

**Warning:** `chunk` is from section 0. Compare `batches` with `expected` so that a dropped batch is visible.

## 14. No silent cuts

Every coverage limit (top-N, sampling, `slice`, round cap, "only the first page") must be **visible**.

```ts
const candidates = Array.from({ length: 130 }, (_, i) => `file-${i}.ts`)
const LIMIT = 100
const selected = candidates.slice(0, LIMIT)
const dropped = candidates.slice(LIMIT)

if (dropped.length > 0) {
  log(`Not processed ${dropped.length} of ${candidates.length} (limit ${LIMIT}): ${dropped.slice(0, 10).join(', ')}${dropped.length > 10 ? ', …' : ''}`)
}
return { processed: selected.length, dropped }
```

The same applies to failures: `ok.length < total` is logged and returned, never just `.filter(Boolean)`.

## 15. IDs and citations assigned by code

LLMs invent references, line numbers, and identifiers. To keep the result from lying:

1. **Assign IDs in code** (`F1…Fn`) and give the agent only those.
2. The agent returns **IDs**, not texts: "sort F3, F1, F7", "cite [C2]".
3. After it returns, **discard unknown IDs** and fill in texts/URLs from the data.

```ts
const sources = [
  { url: 'https://example.com/a', claim: 'A is slow' },
  { url: 'https://example.com/b', claim: 'B is fast' },
]
const claims = sources.map((s, i) => ({ id: `C${i + 1}`, ...s }))
const known = new Map(claims.map((c) => [c.id, c]))

const answer = await agent(
  `Answer in one paragraph. Cite only via ids in square brackets, e.g. [C1]. Do not add anything else.\n${claims.map((c) => `[${c.id}] ${c.claim}`).join('\n')}`,
  { label: 'answer', phase: 'Synthesize' },
)

const order: string[] = []
const rendered = (answer ?? '').replace(/\[(C\d+)\]/g, (_m: string, id: string) => {
  if (!known.has(id)) return '' // invented ID disappears
  if (!order.includes(id)) order.push(id)
  return `[${order.indexOf(id) + 1}]`
})
return { text: rendered, sources: order.map((id, i) => ({ n: i + 1, url: known.get(id)!.url })) }
```

The full version with multi-ID citations `[C1, C3]` is in `examples/deep-research.workflow.ts`.
