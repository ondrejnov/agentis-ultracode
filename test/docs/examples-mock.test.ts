/**
 * Chování příkladů `examples/*.workflow.ts` ověřené proti SKUTEČNÉMU script hostu (`runScript` ze
 * `src/script/host.ts`: worker, vm sandbox, skutečné `parallel`/`pipeline`, determinismus, validace schema)
 * s mock hooky místo enginu a bez `claude`.
 *
 * Test tak ověřuje to, co typy nezachytí: ošetření `null`, ukončení smyček, disjunktní vlastnictví souborů,
 * filtrování vymyšlených ID, počty volání, platnost všech `opts` a schema, která příklady posílají agentům.
 * Dokud `src/script/host.ts` neexistuje, testy se přeskočí.
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
const SKIP = runScript ? false : 'src/script/host.ts zatím neexistuje (modul SCRIPT); test spustí integrátor'

// ───────── mock hooky ─────────

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

/** Třetí argument: sdílený buffer rozpočtu [spent, total, spentUsd, totalUsd] (handler jím simuluje útratu). */
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

/** `handler` vrací výsledek agenta; `undefined` = minimální objekt podle schema, `null` = selhání agenta. */
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
      if (opts.phase !== undefined) assert.ok(declared.has(opts.phase), `opts.phase „${opts.phase}“ není v meta.phases`)
      const out = handler(call, calls.length - 1, view)
      if (out === undefined) return opts.schema ? minimal(opts.schema) : 'text'
      return out
    },
    phase(title: string) {
      assert.ok(declared.has(title), `phase „${title}“ není v meta.phases`)
      phases.push(title)
    },
    log(message: string) {
      logs.push(message)
    },
    async loadWorkflow() {
      throw new Error('loadWorkflow se v příkladech nepoužívá')
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

describe('audit-routes (skutečný host, mock agenti)', { skip: SKIP }, () => {
  const finding = (id: string, severity = 'high') => ({
    id, title: 'Problem ' + id, severity, line: 10, category: 'authz', description: 'popis', evidence: 'kód', fix: 'oprava',
  })

  const base: Handler = (c) => {
    if (c.label.startsWith('discover:')) {
      return { files: [{ path: 'b.php', kind: 'router' }, { path: 'a.php', kind: 'router' }, { path: 'a.php', kind: 'duplicate' }] }
    }
    if (c.label === 'audit:a.php') return { findings: [finding('A1', 'critical'), finding('A2', 'low')] }
    if (c.label.startsWith('audit:')) return { findings: [] }
    if (c.label.startsWith('verify:a.php#A1/')) return { refuted: false, reason: 'reálné' }
    if (c.label.startsWith('verify:a.php#A2/')) return { refuted: true, reason: 'neutralizováno' }
    if (c.label.startsWith('synthesize:')) {
      return {
        summary: 'souhrn',
        priorities: [
          { rank: 1, title: 'oprav authz', gids: ['F1', 'F99'], rationale: 'r' },
          { rank: 2, title: 'duch', gids: ['F77'], rationale: 'vymyšlené' },
        ],
        duplicateGroups: [['F1', 'F42']],
      }
    }
    return undefined
  }

  test('happy path: dedup souborů, 3 hlasy, potvrzení/vyvrácení, syntéza bez vymyšlených ID', async () => {
    const r = await run('audit-routes', { root: 'src' }, base)
    assert.deepEqual(r.value.stats, { files: 2, filesNotAudited: 0, confirmed: 1, rejected: 1, unverified: 0 })
    assert.equal(r.value.confirmed.length, 1)
    assert.equal(r.value.confirmed[0].gid, 'F1')
    assert.equal(r.value.confirmed[0].file, 'a.php')
    assert.equal(r.value.confirmed[0].votesTotal, 3)
    // vymyšlená ID syntéza zahazuje
    assert.deepEqual(r.value.report.priorities.map((p: any) => p.gids), [['F1']])
    assert.deepEqual(r.value.report.duplicateGroups, [])
    // 1 discover + 2 audit + 2 nálezy × 3 skeptici + 1 syntéza
    assert.equal(r.calls.length, 10)
    assert.equal(byLabel(r, 'verify:').length, 6)
    assert.deepEqual(r.phases, ['Discover', 'Synthesize'])
  })

  test('každý agent je read-only a skeptici mají každý jinou čočku', async () => {
    const r = await run('audit-routes', {}, base)
    for (const c of r.calls) {
      assert.ok(c.opts.disallowedTools.includes('Write') && c.opts.disallowedTools.includes('Edit'), c.label)
    }
    const lenses = byLabel(r, 'verify:a.php#A1/').map((c) => /Your lens: ([\w-]+)\./.exec(c.prompt)?.[1])
    assert.equal(new Set(lenses).size, 3)
    assert.ok(!lenses.includes(undefined))
  })

  test('prompty skeptiků jsou samostatné (soubor, tvrzení, důkaz) a vedou k vyvracení', async () => {
    const r = await run('audit-routes', {}, base)
    const p = byLabel(r, 'verify:a.php#A1/')[0].prompt
    assert.match(p, /a\.php/)
    assert.match(p, /Problem A1/)
    assert.match(p, /Default to refuted=true/)
  })

  test('selhání discoveru vyhodí srozumitelnou chybu', async () => {
    await assert.rejects(run('audit-routes', {}, (c) => (c.label.startsWith('discover:') ? null : undefined)), /selhal/)
  })

  test('null z auditu = soubor neauditován, ostatní soubory pokračují', async () => {
    const r = await run('audit-routes', {}, (c, i) => (c.label === 'audit:b.php' ? null : base(c, i)))
    assert.equal(r.value.stats.filesNotAudited, 1)
    assert.equal(r.value.stats.confirmed, 1)
  })

  test('verifikátoři bez kvóra (null) → nález je „neověřený“, ne potvrzený, a syntéza se přeskočí', async () => {
    const r = await run('audit-routes', {}, (c, i) => (c.label.startsWith('verify:a.php#A1/') ? null : base(c, i)))
    assert.equal(r.value.stats.unverified, 1)
    assert.equal(r.value.stats.confirmed, 0)
    assert.equal(r.value.report, null)
    assert.equal(byLabel(r, 'synthesize:').length, 0)
  })

  test('jediný hlas z tří je pod kvórem', async () => {
    const r = await run('audit-routes', {}, (c, i) => {
      if (c.label.startsWith('verify:a.php#A1/') && !c.label.endsWith('/reachability')) return null
      return base(c, i)
    })
    assert.equal(r.value.stats.unverified, 1)
    assert.equal(r.value.stats.confirmed, 0)
  })

  test('shoda hlasů 2:1 pro vyvrácení nález zamítne, 1:2 potvrdí', async () => {
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

  test('maxFiles ořízne seznam a zahozené soubory zaloguje', async () => {
    const r = await run('audit-routes', { maxFiles: 1 }, base)
    assert.equal(byLabel(r, 'audit:').length, 1)
    assert.ok(r.logs.some((l) => l.includes('b.php') && /Vynecháno/.test(l)), r.logs.join('\n'))
  })

  test('votes=1 → jeden skeptik na nález', async () => {
    const r = await run('audit-routes', { votes: 1 }, base)
    assert.equal(byLabel(r, 'verify:a.php#A1/').length, 1)
    assert.equal(r.value.stats.confirmed, 1)
  })

  test('vyčerpaný USD rozpočet před syntézou: potvrzené nálezy se vrátí (ne failed) s budgetExceeded', async () => {
    const r = await run(
      'audit-routes',
      { root: 'src' },
      (c, i, view) => {
        if (c.label.startsWith('synthesize:')) {
          view![2] =1
          throw new BudgetExceededError('Vyčerpán rozpočet v USD (1.0000 z 1).')
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
    assert.ok(r.logs.some((l) => /rozpočet/i.test(l)), r.logs.join('\n'))
  })

  test('jiná chyba syntézy než rozpočet se dál propaguje', async () => {
    await assert.rejects(
      run('audit-routes', {}, (c, i, v) => {
        if (c.label.startsWith('synthesize:')) throw new Error('něco jiného')
        return base(c, i, v)
      }),
      /něco jiného/,
    )
  })

  test('žádné route soubory → brzký návrat bez auditorů', async () => {
    const r = await run('audit-routes', {}, (c) => (c.label.startsWith('discover:') ? { files: [] } : undefined))
    assert.equal(r.value.files, 0)
    assert.equal(r.calls.length, 1)
  })
})

// ───────── fix-until-green ─────────

describe('fix-until-green (skutečný host, mock agenti)', { skip: SKIP }, () => {
  const roundOf = (c: Call): number => Number(/round-(\d+)/.exec(c.label)?.[1] ?? 0)
  const failure = (id: string, file: string) => ({ id, file, summary: 'selhává ' + id })
  const fixOk = { filesChanged: [], summary: 'opraveno', couldNotFix: [], needsOutside: [] }

  test('zelená po třetím kole + nezávislé potvrzení', async () => {
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
    assert.equal(byLabel(r, 'fix:').length, 4) // 3 skupiny v kole 1 + 1 v kole 2
    assert.equal(byLabel(r, 'confirm:').length, 1)
    assert.deepEqual(r.phases, ['Run', 'Fix', 'Run', 'Fix', 'Run', 'Confirm'])
    assert.deepEqual(r.value.remainingFailures, [])
  })

  test('dvě kola bez poklesu selhání → no-progress; po posledním měření se neopravuje', async () => {
    const r = await run('fix-until-green', { command: 'make' }, (c) => {
      if (c.label.startsWith('run:')) return { exitCode: 2, totalFailures: 3, failures: [failure('t1', 'a.ts'), failure('t2', 'a.ts'), failure('t3', 'a.ts')] }
      if (c.label.startsWith('fix:')) return fixOk
      return undefined
    })
    assert.equal(r.value.status, 'no-progress')
    assert.deepEqual(r.value.history.map((h: any) => h.noProgress), [0, 1, 2])
    assert.equal(byLabel(r, 'run:').length, 3)
    assert.equal(byLabel(r, 'fix:').length, 2) // jen v kolech 1 a 2, jedna skupina (jeden soubor)
    assert.equal(byLabel(r, 'confirm:').length, 0)
    assert.equal(r.value.remainingFailures.length, 3)
  })

  test('pokles počtu selhání resetuje počítadlo bez pokroku', async () => {
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

  test('runner, který stále vrací null, smyčku ukončí (žádné nekonečné opakování)', async () => {
    const r = await run('fix-until-green', { command: 'x', maxRounds: 50 }, (c) => (c.label.startsWith('run:') ? null : undefined))
    assert.equal(r.value.status, 'no-progress')
    assert.equal(byLabel(r, 'run:').length, 2)
    assert.equal(byLabel(r, 'fix:').length, 0)
  })

  test('maxRounds=1 a stále červeno → max-rounds bez neověřené opravy', async () => {
    const r = await run('fix-until-green', { command: 'x', maxRounds: 1 }, (c) =>
      c.label.startsWith('run:') ? { exitCode: 1, totalFailures: 1, failures: [failure('t', 'a.ts')] } : undefined)
    assert.equal(r.value.status, 'max-rounds')
    assert.equal(byLabel(r, 'fix:').length, 0)
  })

  test('vlastnictví souborů je disjunktní a každý opravář zná cizí soubory', async () => {
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

  test('selhání jednoho opraváře (null) smyčku nezastaví', async () => {
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

  test('nezávislé potvrzení s nenulovým exit kódem zelenou zruší', async () => {
    const r = await run('fix-until-green', { command: 'x' }, (c) => {
      if (c.label.startsWith('run:')) return { exitCode: 0, totalFailures: 0, failures: [] }
      if (c.label.startsWith('confirm:')) return { exitCode: 3, suspicious: ['skipped test'], summary: 'červené' }
      return undefined
    })
    assert.equal(r.value.status, 'error')
    assert.match(r.value.error, /potvrzení/i)
    assert.deepEqual(r.value.confirmation.suspicious, ['skipped test'])
  })

  test('chyba skriptu uvnitř smyčky (např. rozpočet) vrátí částečný výsledek, ne výjimku', async () => {
    const r = await run('fix-until-green', { command: 'x' }, (c) => {
      if (c.label.startsWith('run:')) return { exitCode: 1, totalFailures: 2, failures: [failure('a', 'a.ts')] }
      if (c.label.startsWith('fix:')) throw new BudgetExceededError('Vyčerpán rozpočet výstupních tokenů.')
      return undefined
    })
    // thunk v parallel() výjimku promění v null → smyčka pokračuje a skončí na no-progress
    assert.ok(['no-progress', 'budget'].includes(r.value.status), r.value.status)
    assert.ok(r.value.history.length >= 2)
  })

  test('jiná chyba skriptu než rozpočet skončí jako error s historií', async () => {
    const r = await run('fix-until-green', { command: 'x' }, (c) => {
      if (c.label.startsWith('run:')) throw new Error('něco se pokazilo')
      return undefined
    })
    assert.equal(r.value.status, 'error')
    assert.match(r.value.error, /pokazilo/)
  })

  test('chyba v runneru (mimo parallel) skončí jako budget/error s historií', async () => {
    const r = await run('fix-until-green', { command: 'x' }, (c) => {
      if (c.label.startsWith('run:')) throw new BudgetExceededError('Vyčerpán rozpočet výstupních tokenů (10 z 10).')
      return undefined
    })
    assert.equal(r.value.status, 'budget')
    assert.match(r.value.error, /rozpočet/)
  })

  test('rozpočet pod prahem ukončí smyčku před dalším kolem', async () => {
    const r = await run('fix-until-green', { command: 'x' }, (c) =>
      c.label.startsWith('run:') ? { exitCode: 1, totalFailures: 2, failures: [failure('a', 'a.ts')] } : undefined,
    { total: 1_000_000, spent: 990_000 })
    assert.equal(r.value.status, 'budget')
    assert.equal(byLabel(r, 'fix:').length, 0)
  })

  test('chybějící command', async () => {
    await assert.rejects(run('fix-until-green', {}, () => undefined), /args\.command/)
    await assert.rejects(run('fix-until-green', undefined, () => undefined), /args\.command/)
  })
})

// ───────── deep-research ─────────

describe('deep-research (skutečný host, mock agenti)', { skip: SKIP }, () => {
  const claim = (text: string, url: string) => ({ claim: text, sourceUrl: url, quote: 'citace', sourceTitle: 'T ' + url })

  const base: Handler = (c) => {
    if (c.label === 'sweep:r1:overview') {
      return { claims: [claim('X is slow.', 'https://a.example/1'), claim('Y is fast', 'ftp://bad.example/y')], gaps: ['něco chybí'] }
    }
    if (c.label === 'sweep:r1:primary') {
      return { claims: [claim('x is  SLOW', 'https://b.example/2'), claim('Z causes W.', 'https://c.example/3')] }
    }
    if (c.label.startsWith('sweep:')) return { claims: [] }
    if (c.label.startsWith('verify:src:')) return { supported: !c.prompt.includes('Z causes W'), note: 'poznámka' }
    if (c.label.startsWith('verify:corr:')) return { status: 'corroborated', otherUrls: ['https://d.example/4', 'notaurl'], note: 'ok' }
    if (c.label.startsWith('critic:')) return { complete: true, missing: [] }
    if (c.label.startsWith('synthesize:')) {
      return { answer: 'A [C1]. B [C1, C9]. C [C2].', caveats: ['c1'], openQuestions: [] }
    }
    return undefined
  }

  test('happy path: dedup claimů, neplatné URL pryč, druhý stupeň jen po prvním, citace z dat', async () => {
    const r = await run('deep-research', { question: 'Je X pomalé?' }, base)
    assert.equal(byLabel(r, 'sweep:r1:').length, 6)
    assert.equal(byLabel(r, 'verify:src:').length, 2) // X (sloučeno s duplicitou) a Z; ftp:// nikdy
    assert.equal(byLabel(r, 'verify:corr:').length, 1) // Z neprošel kontrolou zdroje → druhý agent se nespouští
    assert.match(byLabel(r, 'verify:corr:')[0].prompt, /b\.example\/2/, 'duplicitní zdroj má být vodítko pro korroboraci')
    assert.equal(r.value.answer, 'A [1]. B [1]. C .')
    assert.deepEqual(r.value.sources, [{ n: 1, url: 'https://a.example/1', title: 'T https://a.example/1' }])
    assert.equal(r.value.stats.dropped, 1)
    assert.equal(r.value.stats.verified, 1)
    assert.equal(r.value.stats.stoppedBecause, 'complete')
    assert.deepEqual(r.phases, ['Sweep', 'Critic', 'Synthesize'], 'Verify se přiřazuje jen přes opts.phase')
    // do syntézy jdou jen ID přidělená kódem
    assert.match(byLabel(r, 'synthesize:')[0].prompt, /"id": "C1"/)
  })

  test('critic s mezerami spustí 2. kolo s max. 4 cílenými průzkumy a známé claimy neopakuje', async () => {
    const r = await run('deep-research', { question: 'Q', rounds: 2 }, (c, i) => {
      if (c.label.startsWith('critic:')) {
        return { complete: false, missing: [1, 2, 3, 4, 5].map((n) => ({ aspect: 'a' + n, why: 'w', suggestedQuery: 'q' + n })) }
      }
      if (c.label === 'sweep:r2:targeted-1') return { claims: [claim('Nový claim.', 'https://e.example/5')] }
      return base(c, i)
    })
    assert.equal(byLabel(r, 'sweep:r2:').length, 4)
    assert.match(byLabel(r, 'sweep:r2:')[0].prompt, /Already known/)
    assert.match(byLabel(r, 'sweep:r2:')[0].prompt, /a1/)
    assert.equal(r.value.stats.rounds, 2)
    assert.equal(r.value.stats.claimsUsed, 2) // X + nový claim
    assert.equal(byLabel(r, 'critic:').length, 1, 'po posledním kole critic nemá smysl')
  })

  test('kolo bez nových claimů ukončí rešerši (dry)', async () => {
    const r = await run('deep-research', { question: 'Q', rounds: 3 }, (c, i) => {
      if (c.label.startsWith('critic:')) return { complete: false, missing: [{ aspect: 'a', why: 'w', suggestedQuery: 'q' }] }
      if (c.label.startsWith('sweep:r2:')) return { claims: [claim('X is slow.', 'https://a.example/1')] }
      return base(c, i)
    })
    assert.equal(r.value.stats.stoppedBecause, 'dry')
    assert.equal(r.value.stats.rounds, 2)
  })

  test('zamítnuté claimy se nevracejí do dalšího kola (dedup vůči všem viděným)', async () => {
    const r = await run('deep-research', { question: 'Q', rounds: 2 }, (c, i) => {
      if (c.label.startsWith('critic:')) return { complete: false, missing: [{ aspect: 'a', why: 'w', suggestedQuery: 'q' }] }
      if (c.label.startsWith('sweep:r2:')) return { claims: [claim('Z causes W.', 'https://c.example/3')] }
      return base(c, i)
    })
    assert.equal(byLabel(r, 'verify:src:').length, 2, 'Z se neověřuje podruhé')
  })

  test('contradicted → sporné claimy jsou vyděleny a syntéza je dostane označené', async () => {
    const r = await run('deep-research', { question: 'Q' }, (c, i) =>
      c.label.startsWith('verify:corr:') ? { status: 'contradicted', otherUrls: [], note: 'protiargument' } : base(c, i))
    assert.equal(r.value.stats.disputed, 1)
    assert.equal(r.value.disputed.length, 1)
    assert.match(byLabel(r, 'synthesize:')[0].prompt, /"status": "disputed"/)
  })

  test('selhání korroborace degraduje na single-source, ne na ztrátu claimu', async () => {
    const r = await run('deep-research', { question: 'Q' }, (c, i) => (c.label.startsWith('verify:corr:') ? null : base(c, i)))
    assert.equal(r.value.stats.singleSource, 1)
  })

  test('všechny průzkumy selhaly → answer null a důvod, bez syntézy', async () => {
    const r = await run('deep-research', { question: 'Q' }, (c) => (c.label.startsWith('sweep:') ? null : undefined))
    assert.equal(r.value.answer, null)
    assert.match(r.value.note, /žádný claim/)
    assert.equal(byLabel(r, 'synthesize:').length, 0)
  })

  test('selhání syntézy vrátí ověřené claimy', async () => {
    const r = await run('deep-research', { question: 'Q' }, (c, i) => (c.label.startsWith('synthesize:') ? null : base(c, i)))
    assert.equal(r.value.answer, null)
    assert.equal(r.value.claims.length, 1)
  })

  test('vyčerpaný rozpočet při syntéze: ověřené claimy se vrátí, stoppedBecause budget (ne výjimka)', async () => {
    const r = await run(
      'deep-research',
      { question: 'Q' },
      (c, i, view) => {
        if (c.label.startsWith('synthesize:')) {
          view![2] =1
          throw new BudgetExceededError('Vyčerpán rozpočet v USD (1.0000 z 1).')
        }
        return base(c, i, view)
      },
      { totalUsd: 1 },
    )
    assert.equal(r.value.answer, null)
    assert.equal(r.value.claims.length, 1)
    assert.equal(r.value.stats.stoppedBecause, 'budget')
    assert.match(r.value.note, /rozpočet/i)
  })

  test('USD rozpočet pod prahem ukončí rešerši před dalším kolem (stoppedBecause budget)', async () => {
    const r = await run(
      'deep-research',
      { question: 'Q', rounds: 3 },
      (c, i, view) => {
        if (c.label.startsWith('critic:')) {
          view![2] =9.5 // zbývá 0.5 USD z 10
          return { complete: false, missing: [{ aspect: 'a', why: 'w', suggestedQuery: 'q' }] }
        }
        return base(c, i, view)
      },
      { totalUsd: 10 },
    )
    assert.equal(byLabel(r, 'sweep:r2:').length, 0)
    assert.equal(r.value.stats.stoppedBecause, 'budget')
    assert.ok(r.value.answer, 'syntéza z ověřených claimů proběhne')
  })

  test('rozpočet vyčerpán už při průzkumech: answer null s důvodem budget, ne „dry“/„rounds“', async () => {
    const r = await run(
      'deep-research',
      { question: 'Q' },
      (c, i, view) => {
        if (c.label.startsWith('sweep:')) {
          view![2] =1
          throw new BudgetExceededError('Vyčerpán rozpočet v USD (1.0000 z 1).')
        }
        return base(c, i, view)
      },
      { totalUsd: 1 },
    )
    assert.equal(r.value.answer, null)
    assert.equal(r.value.stats.stoppedBecause, 'budget')
    assert.match(r.value.note, /rozpočet/i)
    assert.equal(byLabel(r, 'synthesize:').length, 0)
  })

  test('critic vyhodí chybu rozpočtu: skončí se na budget a syntéza proběhne z toho, co je', async () => {
    const r = await run('deep-research', { question: 'Q', rounds: 2 }, (c, i, v) => {
      if (c.label.startsWith('critic:')) throw new BudgetExceededError('Vyčerpán rozpočet výstupních tokenů (10 z 10).')
      return base(c, i, v)
    })
    assert.equal(r.value.stats.stoppedBecause, 'budget')
    assert.ok(r.value.answer)
  })

  test('modalities omezí průzkumy; neznámá modalita a chybějící otázka vyhodí chybu', async () => {
    const r = await run('deep-research', { question: 'Q', modalities: ['primary'] }, base)
    assert.equal(byLabel(r, 'sweep:r1:').length, 1)
    await assert.rejects(run('deep-research', { question: 'Q', modalities: ['nope'] }, base), /modalit/)
    await assert.rejects(run('deep-research', {}, base), /args\.question/)
  })

  test('maxClaims ořízne ověřování a zahozené claimy zaloguje', async () => {
    const r = await run('deep-research', { question: 'Q', maxClaims: 1 }, base)
    assert.equal(byLabel(r, 'verify:src:').length, 1)
    assert.ok(r.logs.some((l) => /neověřeno/.test(l)), r.logs.join('\n'))
  })
})

// ───────── php8-upgrade ─────────

describe('php8-upgrade (skutečný host, mock agenti)', { skip: SKIP }, () => {
  const partitions = [
    { key: 'app', paths: ['app', './src/'] },
    { key: 'lib', paths: ['include/lib'] },
    { key: 'pdf', paths: ['include/mpdf'], notes: 'bundled' },
  ]
  const fixed = (key: string) => ({ partition: key, filesChanged: ['x.php'], summary: 'souhrn ' + key, lintClean: true, residualRisks: [], outsidePartition: [] })
  const reviewed = (key: string) => ({ partition: key, verdict: 'ok', issuesFound: [], summary: 'review ' + key, outsidePartition: key === 'lib' ? ['app/a.php:3 změnit X'] : [] })

  const base: Handler = (c) => {
    if (c.label === 'core:cross-cutting') return { partition: 'core', filesChanged: ['b.php'], summary: 'CORE-SUMMARY', lintClean: true, residualRisks: [], outsidePartition: [] }
    if (c.label.startsWith('fix:')) return fixed(c.label.slice(4))
    if (c.label.startsWith('review:')) return reviewed(c.label.slice(7))
    return undefined
  }

  test('Core → pipeline(Fix → Review): počty volání, fáze a předání výsledků', async () => {
    const r = await run('php8-upgrade', { root: '/var/www/app/', partitions }, base)
    assert.equal(r.calls.length, 1 + 3 + 3)
    assert.deepEqual(r.phases, ['Core'])
    assert.equal(r.calls[0].label, 'core:cross-cutting')
    // fixeři dostanou shrnutí Core, revieweři shrnutí fixeru
    assert.match(byLabel(r, 'fix:app')[0].prompt, /CORE-SUMMARY/)
    assert.match(byLabel(r, 'review:app')[0].prompt, /souhrn app/)
    assert.match(byLabel(r, 'fix:app')[0].prompt, /\/var\/www\/app\/app, \/var\/www\/app\/src/)
    assert.equal(r.value.partitions.length, 3)
    assert.deepEqual(r.value.unreviewed, [])
    assert.deepEqual(r.value.outsidePartition, ['lib: app/a.php:3 změnit X'])
    // lomítko na konci rootu se normalizuje
    assert.ok(!byLabel(r, 'fix:app')[0].prompt.includes('/var/www/app//'))
  })

  test('selhání fixeru → reviewer dostane pokyn udělat celou práci sám', async () => {
    const r = await run('php8-upgrade', { root: '/r', partitions }, (c, i) => (c.label === 'fix:lib' ? null : base(c, i)))
    assert.match(byLabel(r, 'review:lib')[0].prompt, /FIXER FAILED/)
    assert.doesNotMatch(byLabel(r, 'review:app')[0].prompt, /FIXER FAILED/)
  })

  test('selhání Core agenta neshodí běh a je v promptech zmíněno', async () => {
    const r = await run('php8-upgrade', { root: '/r', partitions }, (c, i) => (c.label.startsWith('core:') ? null : base(c, i)))
    assert.equal(r.value.core, null)
    assert.match(byLabel(r, 'fix:app')[0].prompt, /core agent failed/)
    assert.ok(r.logs.some((l) => /Core agent selhal/.test(l)))
  })

  test('oddíl, jehož reviewer vrátil null, je v unreviewed; problems se hlásí', async () => {
    const r = await run('php8-upgrade', { root: '/r', partitions }, (c, i) => {
      if (c.label === 'review:pdf') return null
      if (c.label === 'review:app') return { ...reviewed('app'), verdict: 'problems' }
      return base(c, i)
    })
    assert.deepEqual(r.value.unreviewed, ['pdf'])
    assert.deepEqual(r.value.problems, ['app'])
  })

  test('překrývající se oddíly se odmítnou před spuštěním jakéhokoli agenta', async () => {
    const calls: string[] = []
    const bad = [{ key: 'a', paths: ['app'] }, { key: 'b', paths: ['app/models/'] }]
    await assert.rejects(
      run('php8-upgrade', { root: '/r', partitions: bad }, (c) => { calls.push(c.label); return undefined }),
      /překrývají/,
    )
    assert.equal(calls.length, 0)
    // stejný prefix jména, ale jiný adresář, překryv NENÍ
    const ok = await run('php8-upgrade', { root: '/r', partitions: [{ key: 'a', paths: ['app'] }, { key: 'b', paths: ['app2'] }] }, base)
    assert.equal(ok.value.partitions.length, 2)
  })

  test('překryv oddílů se pozná i v jiném zápisu téže cesty (., prázdná, absolutní, .., //, /./)', async () => {
    const cases: Array<[string, string[], string[]]> = [
      ['celý kořen "."', ['.'], ['app']],
      ['prázdná cesta', [''], ['app']],
      ['absolutní cesta pod root', ['/var/www/app/app'], ['app']],
      ['app/../app', ['app/../app'], ['app/x']],
      ['dvojité lomítko', ['app//lib'], ['app/lib/x']],
      ['tečka uvnitř', ['app/./lib'], ['app/lib/x']],
    ]
    for (const [name, a, b] of cases) {
      const calls: string[] = []
      await assert.rejects(
        run('php8-upgrade', { root: '/var/www/app', partitions: [{ key: 'a', paths: a }, { key: 'b', paths: b }] }, (c) => { calls.push(c.label); return undefined }),
        /překrývají/,
        name,
      )
      assert.equal(calls.length, 0, name)
    }
  })

  test('cesta oddílu mimo root (.. nad kořen, cizí absolutní cesta) se odmítne; stejný prefix jména není překryv', async () => {
    await assert.rejects(
      run('php8-upgrade', { root: '/var/www/app', partitions: [{ key: 'a', paths: ['../other'] }] }, base),
      /root|kořen/i,
    )
    await assert.rejects(
      run('php8-upgrade', { root: '/var/www/app', partitions: [{ key: 'a', paths: ['/etc/passwd'] }] }, base),
      /root|kořen/i,
    )
    const ok = await run(
      'php8-upgrade',
      { root: '/var/www/app', partitions: [{ key: 'a', paths: ['/var/www/app/app'] }, { key: 'b', paths: ['./app2/'] }] },
      base,
    )
    assert.equal(ok.value.partitions.length, 2)
  })

  test('chybné vstupy: root, partitions, duplicitní klíč', async () => {
    await assert.rejects(run('php8-upgrade', { partitions }, base), /args\.root/)
    await assert.rejects(run('php8-upgrade', { root: 'relativni', partitions }, base), /args\.root/)
    await assert.rejects(run('php8-upgrade', { root: '/r' }, base), /args\.partitions/)
    await assert.rejects(run('php8-upgrade', { root: '/r', partitions: [{ key: 'a', paths: ['x'] }, { key: 'a', paths: ['y'] }] }, base), /Duplicitní/)
    await assert.rejects(run('php8-upgrade', { root: '/r', partitions: [{ key: 'a', paths: [] }] }, base), /paths/)
  })

  test('goal, description a coreTasks se promítnou do promptů', async () => {
    const r = await run('php8-upgrade', {
      root: '/r', partitions: [partitions[0]], goal: 'cíl-GOAL-8.4', description: 'popis-DESC', coreTasks: ['jediný-úkol-TASK'],
    }, base)
    const core = r.calls[0].prompt
    assert.match(core, /cíl-GOAL-8\.4/)
    assert.match(core, /popis-DESC/)
    assert.match(core, /1\. jediný-úkol-TASK/)
    assert.doesNotMatch(core, /delegating old-name method/, 'výchozí úkoly se nahrazují, ne doplňují')
  })
})
