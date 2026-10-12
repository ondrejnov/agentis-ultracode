# Vzory kvality pro workflow (TypeScript)

Vzory se skládají libovolně. Každý je zde jako samostatný úryvek; kompletní skripty jsou
v `examples/*.workflow.ts`. Úryvky předpokládají globály runtime (`agent`, `parallel`, `pipeline`, `log`,
`budget`, `args`) a deklarují si vstupy, které používají.

## Obsah

0. Pomocné funkce
1. Adversarial verify (skeptici vyvracejí)
2. Perspective-diverse verify (každý jiná čočka)
3. Judge panel (porota)
4. Loop-until-dry (smyčka do vyschnutí)
5. Multi-modal sweep (různé způsoby hledání)
6. Completeness critic (co chybí?)
7. Pipeline vs. bariéra + smell test
8. Kdy je bariéra správně
9. Partitions bez překryvu cest
10. Loop-until-green (opravuj, dokud neprojde)
11. Rozpočtové smyčky
12. Hybrid: scout inline, pak fan-out
13. Syntéza s omezeným vstupem (map-reduce)
14. Žádné tiché ořezy
15. ID a citace přidělené kódem

---

## 0. Pomocné funkce

Skript nemá importy, takže si pomocné funkce definuj na začátku. Tyhle se hodí skoro vždy:

```ts
/** Zbaví pole `null`/`undefined` a zachová typ. `filter(Boolean)` typ nezúží. */
const present = <T>(xs: Array<T | null | undefined>): T[] => xs.filter((x): x is T => x !== null && x !== undefined)

/** Rozdělí pole na dávky. */
const chunk = <T>(xs: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

/** Stabilní klíč pro dedup (bez rozdílů ve velikosti písmen a interpunkci). */
const normKey = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 160)

const demo = present([1, null, 2])
log(`present: ${demo.length}, chunks: ${chunk(demo, 1).length}, key: ${normKey('Ahoj, světe!')}`)
```

## 1. Adversarial verify

**Kdy:** nález/claim musí přežít, než mu uvěříš. Prevence „věrohodných, ale chybných“ výsledků.

**Jak:** N nezávislých skeptiků na nález; každý má **vyvrátit**; nález žije při většině „nevyvráceno“.
Skeptik nedostane autorovo zdůvodnění, jen tvrzení a důkaz. Selhání skeptiků nesmí nález tiše potvrdit.

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
  // kvórum: potřebujeme aspoň 2 platné hlasy (nebo všechny, je-li hlasů méně); remíza = vyvráceno
  const quorum = Math.min(2, votes)
  return { ok: cast.length >= quorum && against * 2 < cast.length, cast: cast.length, against }
}

const verdict = await survives('Funkce delete() nekontroluje vlastníka záznamu', 'src/api/items.ts:42', 3)
log(`přežilo: ${verdict.ok} (${verdict.cast} hlasů, ${verdict.against} proti)`)
```

**Pozor:** bez kvóra by `null` hlasy vypadaly jako „nikdo nevyvrátil“ a nález by prošel. Vracej i počty
(`cast`, `against`), ať je vidět, jak silný konsenzus byl.

## 2. Perspective-diverse verify

**Kdy:** nález může selhat vícero způsoby. N stejných skeptiků má stejnou slepou skvrnu; různé čočky ne.

```ts
const LENSES = [
  { id: 'reachability', ask: 'Can a real request reach this code with the flagged input? Trace callers and middleware.' },
  { id: 'impact', ask: 'Given framework defaults and surrounding checks, does it cause real harm?' },
  { id: 'reproduction', ask: 'Construct a concrete input and walk it through the code. If you cannot, refute.' },
]

const finding = { title: 'SQL injection v řazení', file: 'src/list.ts', line: 17 }

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
log(`vyvráceno čočkami: ${refutedBy.join(', ') || 'žádnou'}`)
```

**Pozor:** čočky řaď podle důležitosti — při `votes < LENSES.length` se použije prefix (`LENSES.slice(0, votes)`).

## 3. Judge panel

**Kdy:** prostor řešení je široký (návrh architektury, plán, refaktor). Jeden pokus iterovaný dokola
konverguje k lokálnímu optimu; N nezávislých pokusů z různých úhlů a porota jsou lepší.

**Jak:** generuj N pokusů z **různých** úhlů → porotci je anonymně hodnotí → syntéza z vítěze + nejlepší
nápady z ostatních. Všechny tři kroky jsou závislé na celé množině, takže bariéry jsou tu správně.

```ts
const task = 'Navrhni, jak rozdělit monolitický modul billing na služby.'
const ANGLES = ['MVP-first: nejmenší krok, který přinese hodnotu', 'risk-first: nejdřív odstraň největší riziko', 'user-first: začni od dopadu na uživatele']

const PLAN = {
  type: 'object',
  properties: { title: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } }, risks: { type: 'array', items: { type: 'string' } } },
  required: ['title', 'steps', 'risks'],
}

phase('Draft')
const drafts = present(
  await parallel(
    ANGLES.map((angle, i) => () =>
      agent<{ title: string; steps: string[]; risks: string[] }>(`${task}\nPřístup: ${angle}. Navrhni plán nezávisle, bez ohledu na jiné možnosti.`, {
        label: `draft:${i + 1}`,
        phase: 'Draft',
        schema: PLAN,
      }),
    ),
  ),
)
if (drafts.length < 2) throw new Error('Porota potřebuje aspoň dva návrhy.')

phase('Judge')
const SCORE = {
  type: 'object',
  properties: { scores: { type: 'array', items: { type: 'number' } }, bestIdx: { type: 'number' }, comment: { type: 'string' } },
  required: ['scores', 'bestIdx', 'comment'],
}
const judges = present(
  await parallel(
    ['správnost a úplnost', 'proveditelnost a náklady', 'riziko a vratnost'].map((criterion, j) => () =>
      agent<{ scores: number[]; bestIdx: number; comment: string }>(
        `Ohodnoť návrhy podle kritéria „${criterion}“ (0-10). Vrať skóre ve stejném pořadí a index nejlepšího.\n${drafts.map((d, i) => `# Návrh ${i}\n${JSON.stringify(d)}`).join('\n\n')}`,
        { label: `judge:${j + 1}`, phase: 'Judge', schema: SCORE, effort: 'high' },
      ),
    ),
  ),
)

// vítěz se počítá v kódu, ne agentem
const totals = drafts.map((_, i) => judges.reduce((sum, j) => sum + (j.scores[i] ?? 0), 0))
const winner = totals.indexOf(Math.max(...totals))
log(`vítěz: návrh ${winner} (${totals.join(' / ')})`)

phase('Synthesize')
const final = await agent(
  `Vytvoř finální plán: vyjdi z vítězného návrhu a přidej nejlepší nápady z ostatních (a vysvětli, odkud jsou).\nVítěz:\n${JSON.stringify(drafts[winner])}\nOstatní:\n${JSON.stringify(drafts.filter((_, i) => i !== winner))}\nPoznámky poroty:\n${judges.map((j) => j.comment).join('\n')}`,
  { label: 'synthesize', phase: 'Synthesize' },
)
return { winner, totals, final }
```

**Pozor:** úhly musí být opravdu různé, jinak je to jen N kopií. Porotci nesmí vědět, který návrh „vyhrává“.

## 4. Loop-until-dry

**Kdy:** neznámý počet nálezů (bugy, případy, okrajové stavy). Prosté `while (count < N)` mine ocas.

**Jak:** hledej v kolech, dokud K po sobě jdoucích kol nevrátí nic nového. Dedup vůči **všem viděným**
(včetně zamítnutých), jinak se zamítnuté vracejí a smyčka nikdy nekonverguje.

```ts
interface Bug {
  file: string
  title: string
}

const FINDERS = ['hledej chyby v ošetření chyb', 'hledej chyby v souběžnosti', 'hledej chyby v práci s časem a časovými zónami']
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
  // strop kol (round < 6) je pojistka; bez něj by agent, který pořád něco "najde", držel smyčku
  round++
  const found = present(
    await parallel(
      FINDERS.map((prompt, i) => () =>
        agent<{ bugs: Bug[] }>(
          `${prompt} v adresáři src/. Kolo ${round}. Už známé nehlásej:\n${[...seen].slice(-30).join('\n') || '(nic)'}\nNic neupravuj.`,
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
  for (const b of fresh) seen.add(`${b.file}|${normKey(b.title)}`) // dedup vůči VŠEM viděným
  confirmed.push(...fresh) // sem patří verifikace (vzor 1) — zde zjednodušeno
  log(`kolo ${round}: ${fresh.length} nových, celkem ${confirmed.length}`)
}
return { rounds: round, bugs: confirmed }
```

**Pozor:** v kombinaci s verifikací dedupuj vůči `seen`, ne vůči `confirmed`. Vždy dej strop kol.
`normKey` je z oddílu 0.

## 5. Multi-modal sweep

**Kdy:** žádný jediný způsob hledání nenajde všechno (rešerše, audit, hledání použití API).

**Jak:** paralelní agenti, každý hledá **jinak**: podle kontejneru (adresář), obsahu (grep vzorů), entity
(symbol/jméno), času (historie, změny). Každý je slepý k ostatním — to je záměr. Výsledky se slučují a dedupují
až v kódu.

```ts
const target = 'funkce legacyCharge()'
const MODES = [
  { id: 'by-container', how: 'projdi adresářovou strukturu a zjisti, které moduly s tím pracují' },
  { id: 'by-content', how: 'grepuj přímá volání, reflexi, dynamická volání přes řetězec a konfiguraci' },
  { id: 'by-entity', how: 'sleduj symbol přes re-exporty, aliasy a typy; hledej i testy a dokumentaci' },
  { id: 'by-time', how: 'projdi historii (git log -S) a TODO/FIXME, které se k tomu vztahují' },
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
      `Najdi všechna místa, která používají nebo ovlivňují: ${target}.\nTvůj způsob hledání (jen ten): ${m.how}.\nNic neupravuj. Vrať soubor, řádek a krátkou poznámku.`,
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

**Pozor:** místa nalezená jen jedním způsobem jsou cenná (ukazují, co by ostatní minuly) — `foundBy` je
signál úplnosti. Selhané způsoby vždy vrať.

## 6. Completeness critic

**Kdy:** po sběru dat, před syntézou. Poslední agent se ptá „co chybí?“ — modalita, kterou jsme nespustili,
claim bez ověření, nepřečtený zdroj. Co najde, se stane dalším kolem práce.

```ts
const question = 'Proč CI občas selhává na testech integrace?'
const gathered = ['Test A používá sdílenou DB bez izolace', 'Test B závisí na pořadí spuštění']

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
    `Jsi kritik úplnosti. Otázka: "${question}"\nDosud zjištěno:\n${gathered.map((g) => '- ' + g).join('\n')}\nUrči, zda to stačí na důkladnou a vyváženou odpověď. Pokud ne, vyjmenuj nejvýš 4 konkrétní mezery (aspekt + dotaz, který ji zaplní). complete=true jen když bys odpověď podepsal. Nic neupravuj.`,
    { label: `critic:r${round}`, phase: 'Critic', schema: CRITIC },
  )
  if (!critic || critic.complete || critic.missing.length === 0) break
  const more = await parallel(
    critic.missing.slice(0, 4).map((m, i) => () =>
      agent(`Zaplň tuto mezeru: ${m.aspect}. Dotaz: ${m.query}. Vrať krátká, ověřitelná zjištění.`, { label: `gap:r${round}:${i + 1}`, phase: 'Fill' }),
    ),
  )
  gathered.push(...present(more))
}
return gathered
```

**Pozor:** kritik, který selže (`null`), nesmí smyčku zacyklit ani prohlásit „kompletní“ — v ukázce
smyčku ukončí a výsledek se vrací bez verdiktu (zaloguj to).

## 7. Pipeline vs. bariéra + smell test

**Špatně** — bariéra, která nic nepotřebuje:

```ts nocheck
const audits = await parallel(files.map((f) => () => agent(`audit ${f}`, { schema: AUDIT })))
const findings = audits.filter(Boolean).flatMap((a) => a.findings)        // jen transformace
const verdicts = await parallel(findings.map((f) => () => agent(`verify ${f.title}`, { schema: V })))
```

Nejpomalejší audit zdržuje verifikaci všech ostatních souborů.

**Správně** — pipeline; transformace uvnitř stage, každý soubor teče nezávisle:

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

**Kontrolní otázka:** potřebuje stage N vidět výsledky VŠECH položek stage N−1? Ne → pipeline.

## 8. Kdy je bariéra správně

Tři oprávněné důvody: **dedup přes celou množinu** před drahým krokem, **early-exit** při nule nálezů,
**srovnání** („ostatní nálezy“ v promptu).

```ts
const modes = ['A', 'B', 'C']
const FINDINGS = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, text: { type: 'string' } }, required: ['key', 'text'] } } },
  required: ['items'],
}

const all = await parallel(modes.map((m) => () => agent<{ items: Array<{ key: string; text: string }> }>(`hledej způsobem ${m}`, { phase: 'Find', schema: FINDINGS })))

// bariéra: dedup potřebuje všechny najednou
const unique = new Map<string, string>()
for (const r of present(all)) for (const it of r.items) if (!unique.has(it.key)) unique.set(it.key, it.text)

if (unique.size === 0) return { findings: [], note: 'Nic nenalezeno, verifikace přeskočena.' } // early-exit

const verified = await parallel(
  [...unique.entries()].map(([key, text]) => () => agent<{ real: boolean }>(`ověř: ${text}`, { phase: 'Verify', schema: { type: 'object', properties: { real: { type: 'boolean' } }, required: ['real'] } }).then((v) => ({ key, text, real: !!v && v.real }))),
)
return present(verified).filter((v) => v.real)
```

## 9. Partitions bez překryvu cest

**Kdy:** agenti **zapisují** do stejného working tree (migrace, hromadné opravy). Runtime nemá worktree
izolaci, takže dva agenti na stejném souboru si tiše přepíší práci.

**Jak:** oddíl = sada cest; vlastnictví je disjunktní; překryv se kontroluje **v kódu před prvním agentem**;
cizí soubory se nesmí měnit, jen hlásit. Průřezové změny proběhnou před oddíly v samostatné fázi.

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

// deterministická kontrola překryvu (stejná cesta nebo jedna uvnitř druhé); cesty se nejdřív kanonizují
// (bez '', '.', '//', '..'), jinak by 'app/../app' nebo '.' kontrolu obešly. Prázdná cesta = celý kořen.
const norm = (p: string): string => {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) throw new Error('Cesta vede nad kořen: ' + p)
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
    if (hit) throw new Error(`Oddíly se překrývají: ${p.key} (${raw}) vs. ${hit.key} (${hit.path || '.'})`)
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
      `Oprav deprecated volání v oddílu "${p.key}". Smíš měnit JEN soubory pod: ${p.paths.join(', ')}.\nOstatní oddíly upravují jiní agenti současně: ${PARTITIONS.filter((x) => x.key !== p.key).flatMap((x) => x.paths).join(', ')}.\nZměnu mimo svůj oddíl neprováděj; popiš ji (soubor, řádek, přesná změna) v "outsidePartition".`,
      { label: `fix:${p.key}`, phase: 'Fix', schema: RESULT },
    ),
)

const failed = PARTITIONS.filter((_, i) => results[i] === null).map((p) => p.key)
return { results: present(results), failed, outside: present(results).flatMap((r) => r.outsidePartition) }
```

**Pozor:** „vše kromě X“ vyjádři výčtem podadresářů, ne negací, ať jde překryv zkontrolovat.
Shromážděné `outsidePartition` zpracuj dalším kolem (nebo ho předej uživateli).

## 10. Loop-until-green

**Kdy:** „opravuj, dokud příkaz neprojde“ (testy, build, lint, typecheck).

**Jak:** kolo = *měření* (agent spustí příkaz a vrátí exit kód + selhání) → *oprava* (agenti s disjunktními
soubory) → znovu měření. Stop: exit 0, **2 kola po sobě bez poklesu selhání**, strop kol, rozpočet. Po
dosažení zelené nezávislé potvrzení jiným agentem (a kontrola, že nikdo netestoval „zeleně“ odstraněním testů).

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
    `Kolo ${round}. Spusť přesně: ${COMMAND}. Nic neopravuj. Vrať exit kód, skutečný počet selhání a seznam selhání (id, soubor, shrnutí).`,
    { label: `run:round-${round}`, phase: 'Run', schema: RUN, effort: 'low', disallowedTools: ['Edit', 'Write'] },
  )
  if (!run) {
    // selhal měřicí agent, ne příkaz: počítej jako kolo bez pokroku, ať se smyčka nezacyklí
    stalled++
    if (stalled >= STALL_LIMIT) { status = 'no-progress'; break }
    continue
  }
  if (run.exitCode === 0) { status = 'green'; break }

  const n = Math.max(run.totalFailures, run.failures.length)
  if (n < best) { best = n; stalled = 0 } else { stalled++ }
  if (stalled >= STALL_LIMIT) { status = 'no-progress'; break }
  if (round === MAX_ROUNDS) break // po posledním měření už neopravuj (neověřená oprava)

  const byFile = new Map<string, string[]>()
  for (const f of run.failures) byFile.set(f.file ?? '(unknown)', [...(byFile.get(f.file ?? '(unknown)') ?? []), `${f.id}: ${f.summary}`])
  await parallel(
    [...byFile.entries()].map(([file, items]) => () =>
      agent(`Oprav selhání v souboru ${file} (a jen v něm). Selhání:\n${items.join('\n')}\nNeoslabuj testy ani příkaz.`, { label: `fix:r${round}:${file}`, phase: 'Fix' }),
    ),
  )
}
return { status, best: best === Infinity ? null : best }
```

**Pozor:** měření musí dělat jiný agent než oprava; „opravil jsem to“ od opraváře nic neznamená. Plnou
verzi (skupiny souborů, potvrzení, rozpočet) má `examples/fix-until-green.workflow.ts`.

## 11. Rozpočtové smyčky

Dva způsoby, jak škálovat práci podle `--max-tokens` / `--max-usd`.

**Dynamicky** — dělej kola, dokud je rozpočet:

```ts
const notes: string[] = []
// guard na budget.total: bez limitu je remaining() Infinity a smyčka by běžela do 1000 agentů
while (budget.total !== null && budget.remaining() > 50_000 && notes.length < 40) {
  const r = await agent(`Najdi další zajímavý problém v src/. Už známé:\n${notes.slice(-20).join('\n')}`, { label: `probe:${notes.length + 1}` })
  if (!r) break
  notes.push(r)
  log(`${notes.length} nálezů, zbývá ${Math.round(budget.remaining() / 1000)}k tokenů`)
}
```

**Staticky** — velikost flotily z rozpočtu:

```ts
const FLEET = budget.total !== null ? Math.max(1, Math.min(20, Math.floor(budget.total / 100_000))) : 5
log(`flotila: ${FLEET} agentů`)
const outs = await parallel(
  Array.from({ length: FLEET }, (_, i) => () => agent(`Prozkoumej oblast č. ${i + 1} z ${FLEET}.`, { label: `fleet:${i + 1}` })),
)
log(`hotovo: ${outs.filter(Boolean).length}/${FLEET}`)
```

**Pozor:** vždy i tvrdý strop počtu (`< 40`, `Math.min(20, …)`), nezávislý na rozpočtu; rozpočet počítá jen
výstupní tokeny. Při `--max-usd` použij `budget.totalUsd` / `budget.remainingUsd()`.

## 12. Hybrid: scout inline, pak fan-out

Nejlepší workflow začínají tím, že *ty* zjistíš rozsah běžnými nástroji a předáš ho skriptu:

```bash
# 1) rozsah zjisti sám
git diff --name-only origin/main...HEAD -- 'src/**/*.ts' > /tmp/changed.txt
# 2) předej jako args
ultracode run review-changes --args "$(jq -Rn '{files: [inputs]}' < /tmp/changed.txt)"
```

Ve skriptu se vstup validuje, zahazuje se duplicitní práce a ořezy se logují:

```ts
const input = (args ?? {}) as { files?: string[]; maxFiles?: number }
if (!Array.isArray(input.files) || input.files.length === 0) {
  throw new Error('Chybí args.files (neprázdné pole cest).')
}
const unique = [...new Set(input.files)].sort()
const cap = input.maxFiles ?? 50
const files = unique.slice(0, cap)
if (unique.length > files.length) log(`Ořez: ${unique.length} → ${files.length}; vynecháno: ${unique.slice(cap).join(', ')}`)

const reviews = await pipeline(files, (f: string) => agent(`Zrecenzuj změny v ${f}.`, { label: `review:${f}`, phase: 'Review' }))
return { reviewed: present(reviews).length, requested: unique.length, failed: files.length - present(reviews).length }
```

Když rozsah nejde zjistit předem, udělej první fázi s jedním agentem a schema (`{ files: [...] }`) — jako
`Discover` v `examples/audit-routes.workflow.ts`.

## 13. Syntéza s omezeným vstupem (map-reduce)

Syntetizující agent s tisíci nálezy v promptu zahltí kontext a mělce se rozhodne. Řazení a ořez dělej
v kódu; je-li dat hodně, redukuj ve vrstvách.

```ts
interface Item {
  id: string
  text: string
}

const items: Item[] = Array.from({ length: 120 }, (_, i) => ({ id: `F${i + 1}`, text: `nález ${i + 1}` }))
const BATCH = 30

// map: dávky → mezisouhrny (každá dávka nezávisle)
const partials = present(
  await parallel(
    chunk(items, BATCH).map((batch, i) => () =>
      agent(`Shrň tyto nálezy do max. 10 bodů a zachovej id v hranatých závorkách:\n${batch.map((b) => `[${b.id}] ${b.text}`).join('\n')}`, {
        label: `reduce:batch-${i + 1}`,
        phase: 'Synthesize',
      }),
    ),
  ),
)

// reduce: jeden agent nad mezisouhrny
const report = await agent(`Z těchto mezisouhrnů napiš závěrečný report; zachovej odkazy na id:\n${partials.join('\n---\n')}`, {
  label: 'reduce:final',
  phase: 'Synthesize',
})
return { batches: partials.length, expected: Math.ceil(items.length / BATCH), report }
```

**Pozor:** `chunk` je z oddílu 0. Porovnej `batches` s `expected`, ať je vidět, že dávka vypadla.

## 14. Žádné tiché ořezy

Každé omezení pokrytí (top-N, sampling, `slice`, strop kol, „jen první stránka“) musí být **vidět**.

```ts
const candidates = Array.from({ length: 130 }, (_, i) => `soubor-${i}.ts`)
const LIMIT = 100
const selected = candidates.slice(0, LIMIT)
const dropped = candidates.slice(LIMIT)

if (dropped.length > 0) {
  log(`Nezpracováno ${dropped.length} z ${candidates.length} (limit ${LIMIT}): ${dropped.slice(0, 10).join(', ')}${dropped.length > 10 ? ', …' : ''}`)
}
return { processed: selected.length, dropped }
```

Totéž platí pro selhání: `ok.length < total` se zaloguje a vrátí, nikdy jen `.filter(Boolean)`.

## 15. ID a citace přidělené kódem

LLM si vymýšlí odkazy, čísla řádků i identifikátory. Aby výsledek nelhal:

1. **ID přiděluj v kódu** (`F1…Fn`) a agentovi dej jen ta.
2. Agent vrací **ID**, ne texty: „seřaď F3, F1, F7“, „cituj [C2]“.
3. Po návratu **zahoď neznámá ID** a texty/URL doplň z dat.

```ts
const sources = [
  { url: 'https://example.com/a', claim: 'A je pomalé' },
  { url: 'https://example.com/b', claim: 'B je rychlé' },
]
const claims = sources.map((s, i) => ({ id: `C${i + 1}`, ...s }))
const known = new Map(claims.map((c) => [c.id, c]))

const answer = await agent(
  `Odpověz jedním odstavcem. Cituj jen přes id v hranatých závorkách, např. [C1]. Nic jiného nepřidávej.\n${claims.map((c) => `[${c.id}] ${c.claim}`).join('\n')}`,
  { label: 'answer', phase: 'Synthesize' },
)

const order: string[] = []
const rendered = (answer ?? '').replace(/\[(C\d+)\]/g, (_m: string, id: string) => {
  if (!known.has(id)) return '' // vymyšlené ID zmizí
  if (!order.includes(id)) order.push(id)
  return `[${order.indexOf(id) + 1}]`
})
return { text: rendered, sources: order.map((id, i) => ({ n: i + 1, url: known.get(id)!.url })) }
```

Plná verze s víceidovými citacemi `[C1, C3]` je v `examples/deep-research.workflow.ts`.
