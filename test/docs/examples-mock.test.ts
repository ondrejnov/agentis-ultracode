/**
 * Behaviour of the examples `examples/*.workflow.ts` verified against the REAL script host (`runScript` from
 * `src/script/host.ts`: worker, vm sandbox, real `parallel`/`pipeline`, determinism, schema validation)
 * with mock hooks instead of the engine and without `claude`.
 *
 * The test thus verifies what the types do not catch: handling of `null`, loop termination, disjoint file ownership,
 * filtering of invented IDs, call counts, validity of all `opts` and the schemas the examples send to the agents.
 * Until `src/script/host.ts` exists, the tests are skipped.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = join(import.meta.dirname, '..', '..')
const EXAMPLES_DIR = join(ROOT, 'examples')
const HOST_PATH = join(ROOT, 'src', 'script', 'host.ts')
const ERRORS_PATH = join(ROOT, 'src', 'errors.ts')

type RunScriptFn = (req: any) => Promise<{ meta: unknown; value: any }>

let runScript: RunScriptFn | null = null
let BudgetExceededError: new (message: string) => Error = Error
if (existsSync(HOST_PATH)) {
  runScript = ((await import(pathToFileURL(HOST_PATH).href)) as { runScript: RunScriptFn }).runScript
  BudgetExceededError = ((await import(pathToFileURL(ERRORS_PATH).href)) as { BudgetExceededError: typeof BudgetExceededError }).BudgetExceededError
}
const SKIP = runScript ? false : 'src/script/host.ts does not exist yet (SCRIPT module); the integrator will run this test'

// ───────── mock hooks ─────────

interface Call {
  prompt: string
  opts: any
  label: string
}

interface Outcome {
  value: any
  calls: Call[]
  phases: string[]
  logs: string[]
}

/** Third argument: shared budget buffer [spent, total, spentUsd, totalUsd] (the handler simulates spending with it). */
type Handler = (call: Call, index: number, budgetView?: Float64Array) => unknown

function minimal(schema: any): unknown {
  if (!schema || typeof schema !== 'object') return null
  switch (schema.type) {
    case 'string': return schema.enum ? schema.enum[0] : 'x'
    case 'number': return 1
    case 'boolean': return true
    case 'array': return []
    case 'object': {
      const o: Record<string, unknown> = {}
      for (const k of schema.required ?? []) o[k] = minimal(schema.properties?.[k])
      return o
    }
    default: return null
  }
}

function metaOf(name: string): { name: string; phases: Array<{ title: string }> } {
  const src = readFileSync(join(EXAMPLES_DIR, name + '.workflow.ts'), 'utf8')
  const start = src.indexOf('{', src.indexOf('export const meta ='))
  const end = src.indexOf('\n}', start) + 2
  return new Function('return (' + src.slice(start, end) + ')')()
}

interface BudgetInit {
  total?: number
  spent?: number
  totalUsd?: number
  spentUsd?: number
}

/** `handler` returns the agent result; `undefined` = minimal object per schema, `null` = agent failure. */
async function run(name: string, args: unknown, handler: Handler, budget: BudgetInit = {}): Promise<Outcome> {
  assert.ok(runScript)
  const calls: Call[] = []
  const phases: string[] = []
  const logs: string[] = []
  const declared = new Set(metaOf(name).phases.map((p) => p.title))

  const budgetBuffer = new SharedArrayBuffer(4 * 8)
  const view = new Float64Array(budgetBuffer)
  view[0] = budget.spent ?? 0
  view[1] = budget.total ?? -1
  view![2] =budget.spentUsd ?? 0
  view[3] = budget.totalUsd ?? -1

  const hooks = {
    async agent(prompt: string, opts: any) {
      const call: Call = { prompt, opts, label: String(opts.label ?? '') }
      calls.push(call)
      if (opts.phase !== undefined) assert.ok(declared.has(opts.phase), `opts.phase “${opts.phase}” is not in meta.phases`)
      const out = handler(call, calls.length - 1, view)
      if (out === undefined) return opts.schema ? minimal(opts.schema) : 'text'
      return out
    },
    phase(title: string) {
      assert.ok(declared.has(title), `phase “${title}” is not in meta.phases`)
      phases.push(title)
    },
    log(message: string) {
      logs.push(message)
    },
    async loadWorkflow() {
      throw new Error('loadWorkflow is not used in the examples')
    },
    workflowEnter() {},
    workflowExit() {},
  }

  const filename = join(EXAMPLES_DIR, name + '.workflow.ts')
  const res = await runScript!({
    source: readFileSync(filename, 'utf8'),
    filename,
    args,
    hooks,
    budgetBuffer,
  })
  return { value: res.value, calls, phases, logs }
}

const byLabel = (o: Outcome, prefix: string) => o.calls.filter((c) => c.label.startsWith(prefix))

// ───────── audit-routes ─────────

describe('audit-routes (real host, mock agents)', { skip: SKIP }, () => {
  const finding = (id: string, severity = 'high') => ({
    id, title: 'Problem ' + id, severity, line: 10, category: 'authz', description: 'description', evidence: 'code', fix: 'fix',
  })

  const base: Handler = (c) => {
    if (c.label.startsWith('discover:')) {
      return { files: [{ path: 'b.php', kind: 'router' }, { path: 'a.php', kind: 'router' }, { path: 'a.php', kind: 'duplicate' }] }
    }
    if (c.label === 'audit:a.php') return { findings: [finding('A1', 'critical'), finding('A2', 'low')] }
    if (c.label.startsWith('audit:')) return { findings: [] }
    if (c.label.startsWith('verify:a.php#A1/')) return { refuted: false, reason: 'real' }
    if (c.label.startsWith('verify:a.php#A2/')) return { refuted: true, reason: 'neutralised' }
    if (c.label.startsWith('synthesize:')) {
      return {
        summary: 'summary',
        priorities: [
          { rank: 1, title: 'fix authz', gids: ['F1', 'F99'], rationale: 'r' },
          { rank: 2, title: 'ghost', gids: ['F77'], rationale: 'invented' },
        ],
        duplicateGroups: [['F1', 'F42']],
      }
    }
    return undefined
  }

  test('happy path: file dedup, 3 votes, confirmation/refutation, synthesis without invented IDs', async () => {
    const r = await run('audit-routes', { root: 'src' }, base)
    assert.deepEqual(r.value.stats, { files: 2, filesNotAudited: 0, confirmed: 1, rejected: 1, unverified: 0 })
    assert.equal(r.value.confirmed.length, 1)
    assert.equal(r.value.confirmed[0].gid, 'F1')
    assert.equal(r.value.confirmed[0].file, 'a.php')
    assert.equal(r.value.confirmed[0].votesTotal, 3)
    // synthesis drops invented IDs
    assert.deepEqual(r.value.report.priorities.map((p: any) => p.gids), [['F1']])
    assert.deepEqual(r.value.report.duplicateGroups, [])
    // 1 discover + 2 audit + 2 findings × 3 skeptics + 1 synthesis
    assert.equal(r.calls.length, 10)
    assert.equal(byLabel(r, 'verify:').length, 6)
    assert.deepEqual(r.phases, ['Discover', 'Synthesize'])
  })

  test('each agent is read-only and each skeptic has a different lens', async () => {
    const r = await run('audit-routes', {}, base)
    for (const c of r.calls) {
      assert.ok(c.opts.disallowedTools.includes('Write') && c.opts.disallowedTools.includes('Edit'), c.label)
    }
    const lenses = byLabel(r, 'verify:a.php#A1/').map((c) => /Your lens: ([\w-]+)\./.exec(c.prompt)?.[1])
    assert.equal(new Set(lenses).size, 3)
    assert.ok(!lenses.includes(undefined))
  })

  test('skeptic prompts are standalone (file, claim, evidence) and lead to refutation', async () => {
    const r = await run('audit-routes', {}, base)
    const p = byLabel(r, 'verify:a.php#A1/')[0].prompt
    assert.match(p, /a\.php/)
    assert.match(p, /Problem A1/)
    assert.match(p, /Default to refuted=true/)
  })

  test('discovery failure throws an understandable error', async () => {
    await assert.rejects(run('audit-routes', {}, (c) => (c.label.startsWith('discover:') ? null : undefined)), /failed/)
  })

  test('null from audit = file not audited, other files continue', async () => {
    const r = await run('audit-routes', {}, (c, i) => (c.label === 'audit:b.php' ? null : base(c, i)))
    assert.equal(r.value.stats.filesNotAudited, 1)
    assert.equal(r.value.stats.confirmed, 1)
  })

  test('verifiers without quorum (null) → finding is "unverified", not confirmed, and synthesis is skipped', async () => {
    const r = await run('audit-routes', {}, (c, i) => (c.label.startsWith('verify:a.php#A1/') ? null : base(c, i)))
    assert.equal(r.value.stats.unverified, 1)
    assert.equal(r.value.stats.confirmed, 0)
    assert.equal(r.value.report, null)
    assert.equal(byLabel(r, 'synthesize:').length, 0)
  })

  test('a single vote out of three is below quorum', async () => {
    const r = await run('audit-routes', {}, (c, i) => {
      if (c.label.startsWith('verify:a.php#A1/') && !c.label.endsWith('/reachability')) return null
      return base(c, i)
    })
    assert.equal(r.value.stats.unverified, 1)
    assert.equal(r.value.stats.confirmed, 0)
  })

  test('a 2:1 vote for refutation rejects the finding, 1:2 confirms it', async () => {
    const twoRefute = await run('audit-routes', {}, (c, i) => {
      if (c.label.startsWith('verify:a.php#A1/')) return { refuted: !c.label.endsWith('/impact'), reason: 'x' }
      return base(c, i)
    })
    assert.equal(twoRefute.value.stats.confirmed, 0)
    const oneRefute = await run('audit-routes', {}, (c, i) => {
      if (c.label.startsWith('verify:a.php#A1/')) return { refuted: c.label.endsWith('/impact'), reason: 'x' }
      return base(c, i)
    })
    assert.equal(oneRefute.value.stats.confirmed, 1)
    assert.equal(oneRefute.value.confirmed[0].votesAgainst, 1)
  })

  test('maxFiles truncates the list and logs skipped files', async () => {
    const r = await run('audit-routes', { maxFiles: 1 }, base)
    assert.equal(byLabel(r, 'audit:').length, 1)
    assert.ok(r.logs.some((l) => l.includes('b.php') && /Skipped/.test(l)), r.logs.join('\n'))
  })

  test('votes=1 → one skeptic per finding', async () => {
    const r = await run('audit-routes', { votes: 1 }, base)
    assert.equal(byLabel(r, 'verify:a.php#A1/').length, 1)
    assert.equal(r.value.stats.confirmed, 1)
  })

  test('USD budget exhausted before synthesis: confirmed findings are returned (not failed) with budgetExceeded', async () => {
    const r = await run(
      'audit-routes',
      { root: 'src' },
      (c, i, view) => {
        if (c.label.startsWith('synthesize:')) {
          view![2] =1
          throw new BudgetExceededError('USD budget exhausted (1.0000 of 1).')
        }
        return base(c, i, view)
      },
      { totalUsd: 1 },
    )
    assert.equal(r.value.report, null)
    assert.equal(r.value.confirmed.length, 1)
    assert.equal(r.value.confirmed[0].gid, 'F1')
    assert.equal(r.value.stats.confirmed, 1)
    assert.equal(r.value.stats.budgetExceeded, true)
    assert.ok(r.logs.some((l) => /budget/i.test(l)), r.logs.join('\n'))
  })

  test('a non-budget synthesis error keeps propagating', async () => {
    await assert.rejects(
      run('audit-routes', {}, (c, i, v) => {
        if (c.label.startsWith('synthesize:')) throw new Error('something else')
        return base(c, i, v)
      }),
      /something else/,
    )
  })

  test('no route files → early return without auditors', async () => {
    const r = await run('audit-routes', {}, (c) => (c.label.startsWith('discover:') ? { files: [] } : undefined))
    assert.equal(r.value.files, 0)
    assert.equal(r.calls.length, 1)
  })
})

// ───────── fix-until-green ─────────

describe('fix-until-green (real host, mock agents)', { skip: SKIP }, () => {
  const roundOf = (c: Call): number => Number(/round-(\d+)/.exec(c.label)?.[1] ?? 0)
  const failure = (id: string, file: string) => ({ id, file, summary: 'failing ' + id })
  const fixOk = { filesChanged: [], summary: 'fixed', couldNotFix: [], needsOutside: [] }

  test('green after the third round + independent confirmation', async () => {
    const r = await run('fix-until-green', { command: 'npm test' }, (c) => {
      if (c.label.startsWith('run:')) {
        const n = roundOf(c)
        if (n === 1) return { exitCode: 1, totalFailures: 3, failures: [failure('t1', 'a.ts'), failure('t2', 'b.ts'), failure('t3', 'c.ts')] }
        if (n === 2) return { exitCode: 1, totalFailures: 1, failures: [failure('t4', 'd.ts')] }
        return { exitCode: 0, totalFailures: 0, failures: [] }
      }
      if (c.label.startsWith('fix:')) return fixOk
      if (c.label.startsWith('confirm:')) return { exitCode: 0, suspicious: [], summary: 'ok' }
      return undefined
    })
    assert.equal(r.value.status, 'green')
    assert.equal(r.value.rounds, 3)
    assert.equal(byLabel(r, 'fix:').length, 4) // 3 groups in round 1 + 1 in round 2
    assert.equal(byLabel(r, 'confirm:').length, 1)
    assert.deepEqual(r.phases, ['Run', 'Fix', 'Run', 'Fix', 'Run', 'Confirm'])
    assert.deepEqual(r.value.remainingFailures, [])
  })

  test('two rounds without a drop in failures → no-progress; no fixing after the last measurement', async () => {
    const r = await run('fix-until-green', { command: 'make' }, (c) => {
      if (c.label.startsWith('run:')) return { exitCode: 2, totalFailures: 3, failures: [failure('t1', 'a.ts'), failure('t2', 'a.ts'), failure('t3', 'a.ts')] }
      if (c.label.startsWith('fix:')) return fixOk
      return undefined
    })
    assert.equal(r.value.status, 'no-progress')
    assert.deepEqual(r.value.history.map((h: any) => h.noProgress), [0, 1, 2])
    assert.equal(byLabel(r, 'run:').length, 3)
    assert.equal(byLabel(r, 'fix:').length, 2) // only in rounds 1 and 2, one group (one file)
    assert.equal(byLabel(r, 'confirm:').length, 0)
    assert.equal(r.value.remainingFailures.length, 3)
  })

  test('a drop in the failure count resets the no-progress counter', async () => {
    const counts = [5, 5, 4, 4, 4]
    const r = await run('fix-until-green', { command: 'x', maxRounds: 10 }, (c) => {
      if (c.label.startsWith('run:')) {
        const n = counts[roundOf(c) - 1]
        return { exitCode: 1, totalFailures: n, failures: [failure('t', 'a.ts')] }
      }
      return fixOk
    })
    assert.deepEqual(r.value.history.map((h: any) => h.noProgress), [0, 1, 0, 1, 2])
    assert.equal(r.value.status, 'no-progress')
  })

  test('a runner that keeps returning null ends the loop (no infinite retry)', async () => {
    const r = await run('fix-until-green', { command: 'x', maxRounds: 50 }, (c) => (c.label.startsWith('run:') ? null : undefined))
    assert.equal(r.value.status, 'no-progress')
    assert.equal(byLabel(r, 'run:').length, 2)
    assert.equal(byLabel(r, 'fix:').length, 0)
  })

  test('maxRounds=1 and still red → max-rounds without an unverified fix', async () => {
    const r = await run('fix-until-green', { command: 'x', maxRounds: 1 }, (c) =>
      c.label.startsWith('run:') ? { exitCode: 1, totalFailures: 1, failures: [failure('t', 'a.ts')] } : undefined)
    assert.equal(r.value.status, 'max-rounds')
    assert.equal(byLabel(r, 'fix:').length, 0)
  })

  test('file ownership is disjoint and each fixer knows the foreign files', async () => {
    const files = ['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts']
    const r = await run('fix-until-green', { command: 'x', maxGroups: 2, maxRounds: 2 }, (c) => {
      if (c.label.startsWith('run:')) {
        return { exitCode: 1, totalFailures: 5, failures: files.map((f, i) => failure('t' + i, f)) }
      }
      return fixOk
    })
    const fixers = byLabel(r, 'fix:r1:')
    assert.equal(fixers.length, 2)
    const owned = fixers.map((c) => /own these files \(and only these\): ([^\n]+)/.exec(c.prompt)![1].split(', '))
    const foreign = fixers.map((c) => /do NOT edit them: ([^\n]+)/.exec(c.prompt)![1].split(', '))
    assert.deepEqual([...owned[0], ...owned[1]].sort(), files)
    assert.equal(owned[0].filter((f) => owned[1].includes(f)).length, 0)
    assert.deepEqual([...foreign[0]].sort(), [...owned[1]].sort())
    assert.deepEqual([...foreign[1]].sort(), [...owned[0]].sort())
  })

  test('failure of one fixer (null) does not stop the loop', async () => {
    let round = 0
    const r = await run('fix-until-green', { command: 'x', maxRounds: 3 }, (c) => {
      if (c.label.startsWith('run:')) {
        round = roundOf(c)
        if (round >= 3) return { exitCode: 0, totalFailures: 0, failures: [] }
        return { exitCode: 1, totalFailures: 3 - round, failures: [failure('a', 'a.ts'), failure('b', 'b.ts')] }
      }
      if (c.label.startsWith('fix:') && c.label.endsWith(':g1')) return null
      if (c.label.startsWith('confirm:')) return { exitCode: 0, suspicious: [], summary: '' }
      return fixOk
    })
    assert.equal(r.value.status, 'green')
  })

  test('independent confirmation with non-zero exit cancels green', async () => {
    const r = await run('fix-until-green', { command: 'x' }, (c) => {
      if (c.label.startsWith('run:')) return { exitCode: 0, totalFailures: 0, failures: [] }
      if (c.label.startsWith('confirm:')) return { exitCode: 3, suspicious: ['skipped test'], summary: 'red' }
      return undefined
    })
    assert.equal(r.value.status, 'error')
    assert.match(r.value.error, /confirmation failed/i)
    assert.deepEqual(r.value.confirmation.suspicious, ['skipped test'])
  })

  test('a script error inside the loop (e.g. budget) returns a partial result, not an exception', async () => {
    const r = await run('fix-until-green', { command: 'x' }, (c) => {
      if (c.label.startsWith('run:')) return { exitCode: 1, totalFailures: 2, failures: [failure('a', 'a.ts')] }
      if (c.label.startsWith('fix:')) throw new BudgetExceededError('Output token budget exhausted.')
      return undefined
    })
    // a thunk in parallel() turns the exception into null → the loop continues and ends on no-progress
    assert.ok(['no-progress', 'budget'].includes(r.value.status), r.value.status)
    assert.ok(r.value.history.length >= 2)
  })

  test('a script error other than budget ends as error with history', async () => {
    const r = await run('fix-until-green', { command: 'x' }, (c) => {
      if (c.label.startsWith('run:')) throw new Error('something went wrong')
      return undefined
    })
    assert.equal(r.value.status, 'error')
    assert.match(r.value.error, /went wrong/)
  })

  test('error in the runner (outside parallel) ends as budget/error with history', async () => {
    const r = await run('fix-until-green', { command: 'x' }, (c) => {
      if (c.label.startsWith('run:')) throw new BudgetExceededError('Output token budget exhausted (10 of 10).')
      return undefined
    })
    assert.equal(r.value.status, 'budget')
    assert.match(r.value.error, /budget/)
  })

  test('budget below threshold ends the loop before another round', async () => {
    const r = await run('fix-until-green', { command: 'x' }, (c) =>
      c.label.startsWith('run:') ? { exitCode: 1, totalFailures: 2, failures: [failure('a', 'a.ts')] } : undefined,
    { total: 1_000_000, spent: 990_000 })
    assert.equal(r.value.status, 'budget')
    assert.equal(byLabel(r, 'fix:').length, 0)
  })

  test('missing command', async () => {
    await assert.rejects(run('fix-until-green', {}, () => undefined), /args\.command/)
    await assert.rejects(run('fix-until-green', undefined, () => undefined), /args\.command/)
  })
})

// ───────── deep-research ─────────

describe('deep-research (real host, mock agents)', { skip: SKIP }, () => {
  const claim = (text: string, url: string) => ({ claim: text, sourceUrl: url, quote: 'quote', sourceTitle: 'T ' + url })

  const base: Handler = (c) => {
    if (c.label === 'sweep:r1:overview') {
      return { claims: [claim('X is slow.', 'https://a.example/1'), claim('Y is fast', 'ftp://bad.example/y')], gaps: ['something is missing'] }
    }
    if (c.label === 'sweep:r1:primary') {
      return { claims: [claim('x is  SLOW', 'https://b.example/2'), claim('Z causes W.', 'https://c.example/3')] }
    }
    if (c.label.startsWith('sweep:')) return { claims: [] }
    if (c.label.startsWith('verify:src:')) return { supported: !c.prompt.includes('Z causes W'), note: 'note' }
    if (c.label.startsWith('verify:corr:')) return { status: 'corroborated', otherUrls: ['https://d.example/4', 'notaurl'], note: 'ok' }
    if (c.label.startsWith('critic:')) return { complete: true, missing: [] }
    if (c.label.startsWith('synthesize:')) {
      return { answer: 'A [C1]. B [C1, C9]. C [C2].', caveats: ['c1'], openQuestions: [] }
    }
    return undefined
  }

  test('happy path: claim dedup, invalid URLs dropped, second stage only after the first, citations from data', async () => {
    const r = await run('deep-research', { question: 'Is X slow?' }, base)
    assert.equal(byLabel(r, 'sweep:r1:').length, 6)
    assert.equal(byLabel(r, 'verify:src:').length, 2) // X (merged with the duplicate) and Z; ftp:// never
    assert.equal(byLabel(r, 'verify:corr:').length, 1) // Z failed the source check → the second agent does not run
    assert.match(byLabel(r, 'verify:corr:')[0].prompt, /b\.example\/2/, 'the duplicate source should be a hint for corroboration')
    assert.equal(r.value.answer, 'A [1]. B [1]. C .')
    assert.deepEqual(r.value.sources, [{ n: 1, url: 'https://a.example/1', title: 'T https://a.example/1' }])
    assert.equal(r.value.stats.dropped, 1)
    assert.equal(r.value.stats.verified, 1)
    assert.equal(r.value.stats.stoppedBecause, 'complete')
    assert.deepEqual(r.phases, ['Sweep', 'Critic', 'Synthesize'], 'Verify is assigned only via opts.phase')
    // only IDs assigned by the code go into the synthesis
    assert.match(byLabel(r, 'synthesize:')[0].prompt, /"id": "C1"/)
  })

  test('critic with gaps starts round 2 with at most 4 targeted sweeps and does not repeat known claims', async () => {
    const r = await run('deep-research', { question: 'Q', rounds: 2 }, (c, i) => {
      if (c.label.startsWith('critic:')) {
        return { complete: false, missing: [1, 2, 3, 4, 5].map((n) => ({ aspect: 'a' + n, why: 'w', suggestedQuery: 'q' + n })) }
      }
      if (c.label === 'sweep:r2:targeted-1') return { claims: [claim('New claim.', 'https://e.example/5')] }
      return base(c, i)
    })
    assert.equal(byLabel(r, 'sweep:r2:').length, 4)
    assert.match(byLabel(r, 'sweep:r2:')[0].prompt, /Already known/)
    assert.match(byLabel(r, 'sweep:r2:')[0].prompt, /a1/)
    assert.equal(r.value.stats.rounds, 2)
    assert.equal(r.value.stats.claimsUsed, 2) // X + new claim
    assert.equal(byLabel(r, 'critic:').length, 1, 'after the last round the critic makes no sense')
  })

  test('round without new claims ends the research (dry)', async () => {
    const r = await run('deep-research', { question: 'Q', rounds: 3 }, (c, i) => {
      if (c.label.startsWith('critic:')) return { complete: false, missing: [{ aspect: 'a', why: 'w', suggestedQuery: 'q' }] }
      if (c.label.startsWith('sweep:r2:')) return { claims: [claim('X is slow.', 'https://a.example/1')] }
      return base(c, i)
    })
    assert.equal(r.value.stats.stoppedBecause, 'dry')
    assert.equal(r.value.stats.rounds, 2)
  })

  test('rejected claims do not come back in the next round (dedup against all seen)', async () => {
    const r = await run('deep-research', { question: 'Q', rounds: 2 }, (c, i) => {
      if (c.label.startsWith('critic:')) return { complete: false, missing: [{ aspect: 'a', why: 'w', suggestedQuery: 'q' }] }
      if (c.label.startsWith('sweep:r2:')) return { claims: [claim('Z causes W.', 'https://c.example/3')] }
      return base(c, i)
    })
    assert.equal(byLabel(r, 'verify:src:').length, 2, 'Z is not verified a second time')
  })

  test('contradicted → disputed claims are separated and synthesis gets them marked', async () => {
    const r = await run('deep-research', { question: 'Q' }, (c, i) =>
      c.label.startsWith('verify:corr:') ? { status: 'contradicted', otherUrls: [], note: 'counter-argument' } : base(c, i))
    assert.equal(r.value.stats.disputed, 1)
    assert.equal(r.value.disputed.length, 1)
    assert.match(byLabel(r, 'synthesize:')[0].prompt, /"status": "disputed"/)
  })

  test('corroboration failure degrades to single-source, not claim loss', async () => {
    const r = await run('deep-research', { question: 'Q' }, (c, i) => (c.label.startsWith('verify:corr:') ? null : base(c, i)))
    assert.equal(r.value.stats.singleSource, 1)
  })

  test('all sweeps failed → answer null and reason, no synthesis', async () => {
    const r = await run('deep-research', { question: 'Q' }, (c) => (c.label.startsWith('sweep:') ? null : undefined))
    assert.equal(r.value.answer, null)
    assert.match(r.value.note, /No claim could be verified/)
    assert.equal(byLabel(r, 'synthesize:').length, 0)
  })

  test('synthesis failure returns verified claims', async () => {
    const r = await run('deep-research', { question: 'Q' }, (c, i) => (c.label.startsWith('synthesize:') ? null : base(c, i)))
    assert.equal(r.value.answer, null)
    assert.equal(r.value.claims.length, 1)
  })

  test('budget exhausted during synthesis: verified claims returned, stoppedBecause budget (not exception)', async () => {
    const r = await run(
      'deep-research',
      { question: 'Q' },
      (c, i, view) => {
        if (c.label.startsWith('synthesize:')) {
          view![2] =1
          throw new BudgetExceededError('USD budget exhausted (1.0000 of 1).')
        }
        return base(c, i, view)
      },
      { totalUsd: 1 },
    )
    assert.equal(r.value.answer, null)
    assert.equal(r.value.claims.length, 1)
    assert.equal(r.value.stats.stoppedBecause, 'budget')
    assert.match(r.value.note, /budget/i)
  })

  test('USD budget below threshold ends research before another round (stoppedBecause budget)', async () => {
    const r = await run(
      'deep-research',
      { question: 'Q', rounds: 3 },
      (c, i, view) => {
        if (c.label.startsWith('critic:')) {
          view![2] =9.5 // 0.5 USD left of 10
          return { complete: false, missing: [{ aspect: 'a', why: 'w', suggestedQuery: 'q' }] }
        }
        return base(c, i, view)
      },
      { totalUsd: 10 },
    )
    assert.equal(byLabel(r, 'sweep:r2:').length, 0)
    assert.equal(r.value.stats.stoppedBecause, 'budget')
    assert.ok(r.value.answer, 'synthesis from verified claims runs')
  })

  test('budget exhausted already during sweeps: answer null with reason budget, not "dry"/"rounds"', async () => {
    const r = await run(
      'deep-research',
      { question: 'Q' },
      (c, i, view) => {
        if (c.label.startsWith('sweep:')) {
          view![2] =1
          throw new BudgetExceededError('USD budget exhausted (1.0000 of 1).')
        }
        return base(c, i, view)
      },
      { totalUsd: 1 },
    )
    assert.equal(r.value.answer, null)
    assert.equal(r.value.stats.stoppedBecause, 'budget')
    assert.match(r.value.note, /budget/i)
    assert.equal(byLabel(r, 'synthesize:').length, 0)
  })

  test('critic throws a budget error: ends with budget and synthesis runs from what is there', async () => {
    const r = await run('deep-research', { question: 'Q', rounds: 2 }, (c, i, v) => {
      if (c.label.startsWith('critic:')) throw new BudgetExceededError('Output token budget exhausted (10 of 10).')
      return base(c, i, v)
    })
    assert.equal(r.value.stats.stoppedBecause, 'budget')
    assert.ok(r.value.answer)
  })

  test('modalities limit sweeps; unknown modality and missing question throw an error', async () => {
    const r = await run('deep-research', { question: 'Q', modalities: ['primary'] }, base)
    assert.equal(byLabel(r, 'sweep:r1:').length, 1)
    await assert.rejects(run('deep-research', { question: 'Q', modalities: ['nope'] }, base), /known modality/)
    await assert.rejects(run('deep-research', {}, base), /args\.question/)
  })

  test('maxClaims truncates verification and logs dropped claims', async () => {
    const r = await run('deep-research', { question: 'Q', maxClaims: 1 }, base)
    assert.equal(byLabel(r, 'verify:src:').length, 1)
    assert.ok(r.logs.some((l) => /not verified/.test(l)), r.logs.join('\n'))
  })
})

// ───────── php8-upgrade ─────────

describe('php8-upgrade (real host, mock agents)', { skip: SKIP }, () => {
  const partitions = [
    { key: 'app', paths: ['app', './src/'] },
    { key: 'lib', paths: ['include/lib'] },
    { key: 'pdf', paths: ['include/mpdf'], notes: 'bundled' },
  ]
  const fixed = (key: string) => ({ partition: key, filesChanged: ['x.php'], summary: 'summary ' + key, lintClean: true, residualRisks: [], outsidePartition: [] })
  const reviewed = (key: string) => ({ partition: key, verdict: 'ok', issuesFound: [], summary: 'review ' + key, outsidePartition: key === 'lib' ? ['app/a.php:3 change X'] : [] })

  const base: Handler = (c) => {
    if (c.label === 'core:cross-cutting') return { partition: 'core', filesChanged: ['b.php'], summary: 'CORE-SUMMARY', lintClean: true, residualRisks: [], outsidePartition: [] }
    if (c.label.startsWith('fix:')) return fixed(c.label.slice(4))
    if (c.label.startsWith('review:')) return reviewed(c.label.slice(7))
    return undefined
  }

  test('Core → pipeline(Fix → Review): call counts, phases and result passing', async () => {
    const r = await run('php8-upgrade', { root: '/var/www/app/', partitions }, base)
    assert.equal(r.calls.length, 1 + 3 + 3)
    assert.deepEqual(r.phases, ['Core'])
    assert.equal(r.calls[0].label, 'core:cross-cutting')
    // fixers get the Core summary, reviewers the fixer's summary
    assert.match(byLabel(r, 'fix:app')[0].prompt, /CORE-SUMMARY/)
    assert.match(byLabel(r, 'review:app')[0].prompt, /summary app/)
    assert.match(byLabel(r, 'fix:app')[0].prompt, /\/var\/www\/app\/app, \/var\/www\/app\/src/)
    assert.equal(r.value.partitions.length, 3)
    assert.deepEqual(r.value.unreviewed, [])
    assert.deepEqual(r.value.outsidePartition, ['lib: app/a.php:3 change X'])
    // the trailing slash of the root is normalized
    assert.ok(!byLabel(r, 'fix:app')[0].prompt.includes('/var/www/app//'))
  })

  test('fixer failure → reviewer is told to do the whole job itself', async () => {
    const r = await run('php8-upgrade', { root: '/r', partitions }, (c, i) => (c.label === 'fix:lib' ? null : base(c, i)))
    assert.match(byLabel(r, 'review:lib')[0].prompt, /FIXER FAILED/)
    assert.doesNotMatch(byLabel(r, 'review:app')[0].prompt, /FIXER FAILED/)
  })

  test('Core agent failure does not break the run and is mentioned in prompts', async () => {
    const r = await run('php8-upgrade', { root: '/r', partitions }, (c, i) => (c.label.startsWith('core:') ? null : base(c, i)))
    assert.equal(r.value.core, null)
    assert.match(byLabel(r, 'fix:app')[0].prompt, /core agent failed/)
    assert.ok(r.logs.some((l) => /Core agent failed/.test(l)))
  })

  test('partition whose reviewer returned null is in unreviewed; problems are reported', async () => {
    const r = await run('php8-upgrade', { root: '/r', partitions }, (c, i) => {
      if (c.label === 'review:pdf') return null
      if (c.label === 'review:app') return { ...reviewed('app'), verdict: 'problems' }
      return base(c, i)
    })
    assert.deepEqual(r.value.unreviewed, ['pdf'])
    assert.deepEqual(r.value.problems, ['app'])
  })

  test('overlapping partitions are rejected before any agent starts', async () => {
    const calls: string[] = []
    const bad = [{ key: 'a', paths: ['app'] }, { key: 'b', paths: ['app/models/'] }]
    await assert.rejects(
      run('php8-upgrade', { root: '/r', partitions: bad }, (c) => { calls.push(c.label); return undefined }),
      /overlap/,
    )
    assert.equal(calls.length, 0)
    // same name prefix but different directory is NOT an overlap
    const ok = await run('php8-upgrade', { root: '/r', partitions: [{ key: 'a', paths: ['app'] }, { key: 'b', paths: ['app2'] }] }, base)
    assert.equal(ok.value.partitions.length, 2)
  })

  test('overlap is detected even in a different notation of the same path (., empty, absolute, .., //, /./)', async () => {
    const cases: Array<[string, string[], string[]]> = [
      ['whole root "."', ['.'], ['app']],
      ['empty path', [''], ['app']],
      ['absolute path under root', ['/var/www/app/app'], ['app']],
      ['app/../app', ['app/../app'], ['app/x']],
      ['double slash', ['app//lib'], ['app/lib/x']],
      ['dot inside', ['app/./lib'], ['app/lib/x']],
    ]
    for (const [name, a, b] of cases) {
      const calls: string[] = []
      await assert.rejects(
        run('php8-upgrade', { root: '/var/www/app', partitions: [{ key: 'a', paths: a }, { key: 'b', paths: b }] }, (c) => { calls.push(c.label); return undefined }),
        /overlap/,
        name,
      )
      assert.equal(calls.length, 0, name)
    }
  })

  test('partition path outside root (.. above root, foreign absolute path) is rejected; same name prefix is not overlap', async () => {
    await assert.rejects(
      run('php8-upgrade', { root: '/var/www/app', partitions: [{ key: 'a', paths: ['../other'] }] }, base),
      /root/i,
    )
    await assert.rejects(
      run('php8-upgrade', { root: '/var/www/app', partitions: [{ key: 'a', paths: ['/etc/passwd'] }] }, base),
      /root/i,
    )
    const ok = await run(
      'php8-upgrade',
      { root: '/var/www/app', partitions: [{ key: 'a', paths: ['/var/www/app/app'] }, { key: 'b', paths: ['./app2/'] }] },
      base,
    )
    assert.equal(ok.value.partitions.length, 2)
  })

  test('invalid inputs: root, partitions, duplicate key', async () => {
    await assert.rejects(run('php8-upgrade', { partitions }, base), /args\.root/)
    await assert.rejects(run('php8-upgrade', { root: 'relative', partitions }, base), /args\.root/)
    await assert.rejects(run('php8-upgrade', { root: '/r' }, base), /args\.partitions/)
    await assert.rejects(run('php8-upgrade', { root: '/r', partitions: [{ key: 'a', paths: ['x'] }, { key: 'a', paths: ['y'] }] }, base), /Duplicate/)
    await assert.rejects(run('php8-upgrade', { root: '/r', partitions: [{ key: 'a', paths: [] }] }, base), /paths/)
  })

  test('goal, description and coreTasks propagate into prompts', async () => {
    const r = await run('php8-upgrade', {
      root: '/r', partitions: [partitions[0]], goal: 'goal-GOAL-8.4', description: 'description-DESC', coreTasks: ['single-task-TASK'],
    }, base)
    const core = r.calls[0].prompt
    assert.match(core, /goal-GOAL-8\.4/)
    assert.match(core, /description-DESC/)
    assert.match(core, /1\. single-task-TASK/)
    assert.doesNotMatch(core, /delegating old-name method/, 'default tasks are replaced, not appended')
  })
})
