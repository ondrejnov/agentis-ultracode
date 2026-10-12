# API workflow skriptů — úplný popis

Platí pro `*.workflow.ts` (a `.js`) spouštěné přes `ultracode run`. Typy jsou v `types/workflow.d.ts`
(`ultracode types` je zapíše jako `.ultracode/workflow.d.ts`). Skript nemá importy; vše níže jsou globály.

## Obsah

1. Tvar skriptu
2. `meta`
3. `agent()` — volby, návratové hodnoty, selhání
4. `parallel()` a `pipeline()`
5. `phase()`, `log()`, `console`
6. `args`
7. `budget`
8. `workflow()`
9. Prostředí a determinismus
10. Limity
11. Chybové stavy a jejich zdroj
12. Konvence `null`
13. Cache a resume
14. Co není podporováno

---

## 1. Tvar skriptu

```ts
/// <reference path="../workflow.d.ts" />

export const meta = { name: 'x', description: 'Ukázka tvaru skriptu' }   // 1) meta (první příkaz)

phase('Scan')                                                            // 2) tělo: top-level await
const r = await agent<{ count: number }>('Spočítej soubory v src/ a vrať počet.', {
  schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
})
return { count: r ? r.count : null }                                     // 3) návratová hodnota = výsledek běhu (JSON)
```

- Tělo je `async` funkce: používej top-level `await` a `return`.
- Povolený je jen jeden `export`: `export const meta`. Jiné `export`, `import`, `import()`, `require()` jsou
  chyba při validaci.
- TypeScript pouze „erasable“: typy, `interface`, `type`, `as`, `satisfies`, generika. Ne `enum`,
  `namespace`, parameter properties, `import x = require()`.
- `return` je výsledek běhu; musí jít serializovat do JSON (`undefined` → `null`).

## 2. `meta`

```ts
export const meta = {
  name: 'find-flaky-tests',          // povinné: [A-Za-z0-9][A-Za-z0-9_.-]*
  description: 'Find flaky tests',   // povinné, neprázdné, jedna věta
  whenToUse: 'Kdy workflow použít',  // volitelné
  phases: [                          // volitelné
    { title: 'Scan', detail: '…' },  // title povinné; detail, model volitelné
    { title: 'Fix', detail: '…', model: 'sonnet' },
  ],
}

phase('Scan')
phase('Fix')
```

| Pravidlo | Důsledek při porušení |
| --- | --- |
| čistý literál (žádné proměnné, volání, spread, šablony s `${}`) | chyba validace |
| `name` a `description` jsou řetězce | chyba validace |
| za objektem smí následovat jen `as const`, `satisfies T`, `;` | chyba validace |
| první příkaz skriptu (před ním jen komentáře) | varování |
| neznámý klíč v `meta` / `meta.phases[i]` | varování, klíč se ignoruje |
| `phase('X')` nebo `phase: 'X'` s titulem, který není v `meta.phases` | varování |
| titul v `meta.phases`, který skript nikdy nepoužije | varování (nehlásí se, je-li někde dynamické `phase(proměnná)`) |
| duplicitní titul v `meta.phases` | varování |

`meta.phases[i].model` je informativní (zobrazuje se); skutečný model určuje `agent({ model })`.
Jméno workflow = `meta.name`; soubor se hledá podle jména souboru (`<jmeno>.workflow.ts`), proto je drž shodné.

## 3. `agent(prompt, opts?)`

```ts nocheck
declare function agent<T = any>(prompt: string, opts: AgentOptions & { schema: Schema }): Promise<T | null>
declare function agent(prompt: string, opts?: AgentOptions): Promise<string | null>
```

Spustí jednoho agenta (proces `claude -p`) a čeká na jeho dokončení.

- **Bez `schema`:** vrací finální text agenta (`string`).
- **Se `schema`:** agent je donucen vrátit strukturovaný výstup; vrací ověřený objekt.
- **`null`:** agent po všech pokusech selhal, nebo byl běh přerušen. Viz sekce 12.
- **Výjimka:** jen chyba skriptu — neplatný prompt/volba/schema, překročený rozpočet nebo limit agentů.

### Volby

| Volba | Typ | Default | Význam |
| --- | --- | --- | --- |
| `label` | string | první řádek promptu (60 znaků) | popisek v logu, `status`, eventech; nepatří do klíče cache |
| `phase` | string | aktuální `phase()` | explicitní fáze; **uvnitř `pipeline`/`parallel` vždy používej `phase:`**, globální `phase()` se mezi souběžnými úlohami přepisuje |
| `schema` | JSON Schema | — | strukturovaný výstup; viz níže |
| `model` | string | z `--model`, jinak model claude | alias (`sonnet`, `opus`, `haiku`) nebo plné jméno; raději nenastavuj |
| `effort` | `'low'\|'medium'\|'high'\|'xhigh'\|'max'` | z `--effort`, jinak výchozí | úroveň uvažování |
| `cwd` | string | cwd běhu (`--cwd`) | pracovní adresář agenta; relativně k cwd běhu; musí existovat |
| `tools` | string[] | — | **skutečný whitelist** (`--allowedTools`, např. `['Read','Grep','Bash(git diff:*)']`): agent se zadaným `tools` běží v `--permission-mode dontAsk`, takže cokoli mimo seznam se odmítne (včetně MCP nástrojů a `Skill`, vyjmenuj je, mají-li být dostupné). Čtecí nástroje v cwd jsou povoleny vždy |
| `disallowedTools` | string[] | — | `--disallowedTools`; **skutečně zakáže** nástroje (např. `['Edit','Write','NotebookEdit']`). `Workflow` je zakázán vždy |
| `systemPrompt` | string | — | přidá se ZA výchozí system prompt subagenta (`--append-system-prompt`) |
| `stallMs` | number > 0 | 600 000 | ticho na výstupu, po kterém se agent zabije a zkusí znovu |
| `timeoutMs` | number > 0 | žádný | tvrdý limit délky jednoho pokusu; po něm selhání bez opakování |
| `maxUsd` | number > 0 | — | strop útrat jednoho agenta (`--max-budget-usd`); při `--max-usd` se omezí na zbytek rozpočtu |
| `noCache` | boolean | `false` | při resume neber uložený výsledek tohoto volání |

Volby **nepodporované** (`isolation`, `agentType`) `agent()` odmítne `TypeError`em. Neznámé volby se
ignorují s varováním v logu.

### Výchozí chování agenta

- Spouští se jako `claude -p --output-format stream-json --verbose --no-session-persistence
  --permission-mode bypassPermissions --disallowedTools Workflow,…` (s volbou `tools` místo toho
  `--permission-mode dontAsk --allowedTools …`), prompt jde na stdin, v prostředí je
  `CLAUDE_CODE_DISABLE_WORKFLOWS=1`.
- Dědí `CLAUDE.md`, skills a MCP projektu z `cwd` (nepoužívá se `--bare`).
- Výchozí system prompt: finální zpráva se vrací skriptu, vrať jen data, nic se neptej, drž se zadaného rozsahu.
- Pokusy: až 3 při zaseknutí (`stallMs`), přechodné chybě API (408/409/425/429/5xx, síťové chyby, přetížení)
  nebo ukončení bez výsledku (nikoli při vyčerpání usage limitu, neplatném přihlášení či příliš dlouhém promptu);
  prodleva `ULTRACODE_RETRY_BACKOFF_MS × pokus` (default 2 s). Při nesplněném schema jedno opakování.
  Bez opakování: překročení `timeoutMs`, překročení `maxUsd`, vyčerpání kol, přerušení.

### Schema

- Kořen `{ type: 'object', properties: {…} }`.
- `required` ⊆ `properties` na každé úrovni; klíče `required` se neopakují.
- `type` jen z `string|number|integer|boolean|object|array|null`; `enum` neprázdný.
- `additionalProperties: false` nesmí odporovat `required`.
- Doporučení (není vynuceno): plochá struktura, `enum` pro verdikty, krátké `description` u nejasných polí,
  žádné `$ref`/`oneOf`, `required` jen u toho, co agent určitě ví.
- Porušení = `TypeError` z `agent()` **před** spuštěním agenta (nic se neúčtuje).
- Agent, který strukturovaný výstup nevrátí ani na druhý pokus, dá `null`.

## 4. `parallel()` a `pipeline()`

### `parallel(thunks)` — BARIÉRA

```ts
const items = ['a.ts', 'b.ts']
const S = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }

const results = await parallel(items.map((it) => () => agent<{ ok: boolean }>(`Zkontroluj ${it}`, { schema: S })))
const ok = results.filter((r): r is { ok: boolean } => r !== null)
log(`${ok.length}/${items.length} hotovo`)
```

- Spustí všechny thunky souběžně a čeká na všechny. Výsledek má pořadí vstupu.
- Thunk, který vyhodí chybu (nebo jehož `agent()` vyhodí), dá `null`; chyba se zaloguje (prvních 10).
- Nikdy neodmítne kvůli chybě thunku; odmítne jen pro špatné použití (`TypeError` když není pole,
  `RangeError` nad limit položek).
- Hotový `Promise` místo thunku se tolerantně awaituje, ale thunk je správný tvar (řídí okamžik startu).
- Počet souběžně běžících agentů je omezen globálně (viz limity), ne počtem thunků.

### `pipeline(items, stage1, stage2, …)` — výchozí volba

```ts
const files = ['a.ts', 'b.ts']
const A = { type: 'object', properties: { issues: { type: 'array', items: { type: 'string' } } }, required: ['issues'] }
const V = { type: 'object', properties: { confirmed: { type: 'boolean' } }, required: ['confirmed'] }

const out = await pipeline(
  files,
  (file: string) => agent<{ issues: string[] }>(`audit ${file}`, { phase: 'Audit', schema: A }),
  async (audit: { issues: string[] } | null, file: string) =>
    audit ? agent<{ confirmed: boolean }>(`verify ${file}: ${JSON.stringify(audit)}`, { phase: 'Verify', schema: V }) : null,
)
```

- Každá položka prochází stagemi **nezávisle**; položka A může být ve stage 3, zatímco B je ve stage 1.
  Čas = nejpomalejší jednotlivý řetězec, ne součet nejpomalejších stagí.
- Stage dostane `(předchozíVýsledek, původníPoložka, index)`; první stage dostane `(položka, položka, index)`.
- **Stage, která vyhodí chybu:** položka je `null` ve výsledku a zbylé stage se pro ni přeskočí.
- **Stage, která `null` vrátí** (typicky selhaný `agent()`): `null` se předá další stage jako `prev` →
  ošetři (`prev ? … : null`).
- Výsledek je pole ve stejném pořadí jako `items`; `null` na pozici = položka selhala.
- Stage může být `async` a uvnitř volat `parallel()` (např. N skeptiků pro jeden nález).

### Kdy bariéra, kdy pipeline

Bariéra (`await parallel` mezi fázemi) je správně jen když stage N potřebuje křížový kontext ze **všech**
výsledků stage N−1: dedup přes celou množinu před drahým krokem, early-exit při nule nálezů, prompt
odkazující na „ostatní nálezy“. Není důvod: „potřebuju zploštit/filtrovat“ (udělej uvnitř stage), „fáze
jsou koncepčně oddělené“, „čistší kód“. Smell test: `a = await parallel(...); b = transform(a);
c = await parallel(b.map(...))` — prostřední transformace bariéru nepotřebuje.

## 5. `phase()`, `log()`, `console`

- `phase(title)` — začne fázi; následující `agent()` volání bez `opts.phase` se zařadí pod ni. Titul je
  neprázdný řetězec a má být v `meta.phases`. Fáze je per (vnořené) workflow; potomek dědí fázi rodiče, dokud sám nezavolá `phase()`.
- `log(message)` — zpráva uživateli (stderr + `events.jsonl`). Ne-řetězce se serializují (JSON).
- `console.log/info/debug` = `log`; `console.warn/error` přidají prefix `[warn]`/`[error]`.

## 6. `args`

Hodnota z `--args '<json>'` / `--args-file`, jako skutečný JSON (pole je pole, ne řetězec). `undefined`,
pokud nebyla zadána. U `resume` se použijí uložené `args`, ledaže zadáš nové. Validuj je na začátku skriptu a
vyhoď srozumitelnou chybu (`throw new Error('Chybí args.question')`) — běh pak selže hned a levně.

## 7. `budget`

```ts
budget.total          // number | null   strop výstupních tokenů (--max-tokens), null = bez limitu
budget.totalUsd       // number | null   strop v USD (--max-usd)
budget.spent()        // výstupní tokeny utracené v běhu (včetně vnořených workflow)
budget.remaining()    // max(0, total - spent()), bez limitu Infinity
budget.spentUsd()
budget.remainingUsd() // bez limitu Infinity
```

- Počítají se **výstupní** tokeny a `total_cost_usd` hlášené agenty. Hodnoty se aktualizují po dokončení agenta.
- Strop je tvrdý: po jeho dosažení každé další `agent()` vyhodí chybu s `code === 'BUDGET_EXCEEDED'` a běh
  je označen `budgetExceeded`. Už běžící agenti doběhnou (jejich `--max-budget-usd` je omezen zbytkem USD).
- Smyčky vždy hlídej `budget.total` — bez limitu je `remaining()` `Infinity` a smyčka by běžela k limitu
  1000 agentů: `while (budget.total && budget.remaining() > 50_000) { … }`.

## 8. `workflow(nameOrRef, args?)`

```ts
const sub = await workflow('review-changes', { base: 'main' })          // podle jména
const sub2 = await workflow({ scriptPath: '/abs/cesta/x.workflow.ts' })  // podle cesty
```

- Spustí jiný skript inline a vrátí jeho návratovou hodnotu. Sdílí souběžnost, počítadlo agentů,
  rozpočet i zrušení běhu.
- `args` se stanou globálem `args` potomka. Potomek se validuje stejně jako kořen (neplatný → chyba).
- **Vnoření jen o jednu úroveň**: `workflow()` uvnitř potomka vyhodí chybu.
- Neznámé jméno / nečitelná cesta / syntaktická chyba potomka vyhodí chybu — zachyť `try/catch`, chceš-li běžet dál.
- V logu a `status` jsou agenti potomka pod skupinou jeho jména.

## 9. Prostředí a determinismus

Dostupné: standardní JS (`JSON`, `Math` kromě `random`, `Array`, `Object`, `Map`, `Set`, `Promise`, `RegExp`,
`Intl`, …), `console`, globály runtime. Nedostupné: `process`, `require`, `fetch`, `setTimeout`, FS, `eval`,
`new Function`.

| Zakázáno | Chování |
| --- | --- |
| `Date.now()` | vyhodí `DeterminismError` (varování už při validaci) |
| `Math.random()` | vyhodí `DeterminismError` |
| `new Date()` bez argumentu, `Date()` | vyhodí `DeterminismError` |
| `new Date(x)`, `Date.parse`, `Date.UTC` | povoleno |

Důvod: resume musí při stejném skriptu a vstupu dospět ke stejným voláním. Čas předej přes `args`
(`args.today`), „náhodu“ vyrob z indexu (`variants[i % variants.length]`).

## 10. Limity

| Limit | Hodnota | Přepsání |
| --- | --- | --- |
| souběžní agenti | `min(16, max(1, CPU − 2))` | `--concurrency`, `ULTRACODE_MAX_CONCURRENCY` |
| agentů za běh | 1000 | `--max-agents` |
| položek v jednom `parallel`/`pipeline` | 4096 | — (rozděl na dávky) |
| hloubka `workflow()` | 1 | — |
| tokeny / USD | bez limitu | `--max-tokens`, `--max-usd` |
| pokusů na agenta | 3 (schema +1) | — |
| `stallMs` | 600 000 ms | `agent({ stallMs })` |

Agenti nad souběžnost čekají ve frontě; dávka 100 položek tedy doběhne, jen ne naráz.

## 11. Chybové stavy a jejich zdroj

| Situace | Jak se projeví |
| --- | --- |
| neplatný skript (meta, syntaxe, import…) | `ultracode validate` exit 2; `run` exit 2, běh se nezačne |
| neznámé workflow | exit 2 (`WORKFLOW_NOT_FOUND`) |
| neplatné schema / volba / prompt | `agent()` vyhodí `TypeError`; skript spadne, nechytne-li ho |
| agent selhal po všech pokusech | `agent()` vrací `null`; `totals.failedAgents`++; událost `agent_done` s `error` |
| přerušení (Ctrl+C, SIGTERM) | agenti se zabijí včetně potomků; běh `aborted`, exit 130; `agent()` vrací `null` |
| vyčerpaný rozpočet / limit agentů | `agent()` vyhodí chybu `BUDGET_EXCEEDED`; v `parallel`/`pipeline` je z toho `null` |
| výjimka ve skriptu | běh `failed`, exit 1, `error` v `run.json`; dokončené agenty má journal pro resume |
| `DeterminismError` | stejné jako výjimka ve skriptu |
| skript čeká na nikdy nevyřešený Promise | chyba „Skript uvázl“ |
| návratová hodnota nejde do JSON | `TypeError`, běh `failed` |

## 12. Konvence `null`

`null` z `agent()` znamená „nemám výsledek“, **ne** „nic nenalezeno“. Prázdný výsledek je prázdné pole
ve schema. Důsledky:

1. Před přístupem k vlastnosti vždy test (`if (!r)`), před použitím pole `.filter(Boolean)`.
2. `parallel` a `pipeline` mohou `null` vrátit na kterékoli pozici; stejně tak stage dostane `null` jako `prev`.
3. Tichý `.filter(Boolean)` je ztráta informace: spočítej `failed = total - ok.length`, zaloguj a vrať.
4. Rozhodnutí, která závisí na úplnosti (kvórum hlasů, „žádné nálezy“), musí umět rozlišit
   „nikdo nic nenašel“ od „polovina agentů selhala“. Viz kvórum v `examples/audit-routes.workflow.ts`.
5. Selhání je jiné než chyba skriptu; neplést `null` s výjimkou ani je neřešit `try/catch` kolem `agent()`
   (výjimka znamená chybu skriptu, ne selhání agenta).

## 13. Cache a resume

- Klíč volání = `sha256(prompt, schema, model, effort, cwd, tools, disallowedTools, systemPrompt)` + pořadí
  stejného klíče v běhu. `label`, `phase`, `stallMs`, `timeoutMs`, `maxUsd` do klíče nepatří; model a effort
  jsou efektivní hodnoty (včetně `--model`/`--effort`).
- Do journalu se zapisují **jen úspěšní agenti**. Selhaní se při resume spustí znovu.
- Resume: shodné volání → uložený výsledek (událost `agent_done` s `cached: true`); jinak běží živě.
  Je odolné vůči jinému pořadí dokončení v `parallel`. Změní-li se výsledek upstream agenta, změní se
  prompty navazujících a ti se spustí znovu.
- `ultracode resume <runId>` použije kopii skriptu a `args` uložené v běhu; `ultracode run <jmeno> --resume <runId>`
  použije aktuální skript (úprava kódu) a uložené `args`, ledaže zadáš nové.
- Chceš-li výsledek konkrétního volání znovu spočítat, dej mu `noCache: true`.
- Prompt, který obsahuje vždy jiný text (čas, náhodné ID, nesetříděný výčet), cache znehodnotí.
  Setřiď vstupní seznamy (`.sort()`) před vložením do promptu.

## 14. Co není podporováno

`isolation: 'worktree'`, `agentType`, vstup za běhu (agent se nemůže zeptat), pauza/restart jednoho
agenta, TUI/web dashboard, čekání na usage limit (agent selže → `null`), stagger prompt-cache, vnoření
`workflow()` hlouběji než o 1, přístup k souborům a shellu ze skriptu. Řešení viz `SKILL.md` sekce 10.
