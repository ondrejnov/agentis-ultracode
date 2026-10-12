# Referenční pravidla psaní workflow (výtah z Claude Code `workflow-authoring` + docs)

Zdroj pravdy pro sémantiku, kterou naše runtime napodobuje. Skripty z Claude Code jsou JS; u nás TS, jinak 1:1.

## Tvar skriptu

```js
export const meta = {            // PURE LITERAL: žádné proměnné, volání, spread, šablony s ${}
  name: 'find-flaky-tests',      // povinné
  description: 'Find flaky tests and propose fixes',   // povinné, jedna věta
  whenToUse: '…',                // volitelné
  phases: [                      // volitelné; titulní řetězce MUSÍ přesně odpovídat phase('…')
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test', model: 'sonnet' },
  ],
}
phase('Scan')
const flaky = await agent('grep CI logs for retry markers', { schema: FLAKY_SCHEMA })
return flaky          // návratová hodnota = výsledek běhu (JSON)
```

Tělo je async kontext: top-level `await` i `return`. Žádné `import`/`import()`/`require`, žádný filesystem/shell
ve skriptu (to dělají agenti), `Date.now()`/`Math.random()`/`new Date()` bez argumentu **vyhazují** (rozbily by resume).
Časové razítko ani náhodu dej přes `args`; náhodu pro agenty řeš variací promptu/labelu podle indexu.

## API

- `agent(prompt, opts?)` → string | objekt (se `schema`) | `null` (selhání/přerušení). Opts: `label, phase, schema, model, effort, …`.
  Bez schema vrací finální text. Se schema je agent donucen vrátit validovaný objekt.
- `pipeline(items, stage1, stage2, …)` → pole výsledků; každá položka prochází stagemi nezávisle, **bez bariéry**.
  Stage dostane `(prevResult, originalItem, index)`. Stage, která vyhodí chybu → položka `null`, zbylé stage se přeskočí.
  Do další stage se předává i `null` (pokud ho předchozí stage VRÁTILA) → ošetři (`fixed ? … : 'FIXER FAILED'`).
- `parallel(thunks)` → BARIÉRA; thunk co vyhodí → `null`; funkce nikdy neodmítne. Vždy `.filter(Boolean)`.
- `phase(title)`, `log(message)`, `args`, `budget {total, spent(), remaining()}`, `workflow(nameOrRef, args)` (1 úroveň vnoření).
- Limity: souběžnost min(16, CPU-2); 1000 agentů/běh; 4096 položek v jednom `parallel`/`pipeline`;
  schema: kořen `{type:'object', properties}`, `required ⊆ properties`; protimluvné schema vyhodí chybu ještě před startem agenta.

## Výchozí je pipeline(), bariéra jen když je nutná

Bariéra (`await parallel(...)` mezi fázemi) je správně JEN když stage N potřebuje křížový kontext ze všech výsledků N-1:
dedup přes celou množinu před drahým krokem, early-exit při nule nálezů, prompt odkazuje na „ostatní nálezy“.
NENÍ důvod: „potřebuju to zploštit/filtrovat“ (udělej uvnitř stage), „fáze jsou koncepčně oddělené“, „čistší kód“.

Smell test: `const a = await parallel(…); const b = transform(a); const c = await parallel(b.map(…))` — prostřední
transformace bariéru nepotřebuje → přepiš na `pipeline(items, stageA, r => transform([r]).flat(), stageB)`.

## Vzory kvality

- **Adversarial verify**: N nezávislých skeptiků na nález, každý má vyvrátit; přežije při ≥ většině „nevyvráceno“.
  `Default to refuted=true if uncertain.`
- **Perspective-diverse verify**: různé čočky (correctness, security, perf, reprodukce) místo N stejných.
- **Judge panel**: N nezávislých pokusů z různých úhlů → paralelní porotci → syntéza z vítěze + nejlepší nápady z ostatních.
- **Loop-until-dry**: dokud K po sobě jdoucích kol nevrátí nic nového; dedup proti VŠEM dosud viděným (ne jen potvrzeným).
- **Multi-modal sweep**: paralelní agenti hledající různými způsoby (po kontejneru, obsahu, entitě, času).
- **Completeness critic**: poslední agent: „co chybí – nespuštěná modalita, neověřené tvrzení, nepřečtený zdroj?“
- **Žádné tiché ořezy**: když workflow omezuje pokrytí (top-N, sampling), `log()` co zahodil.
- **Loop-until-budget**: `while (budget.total && budget.remaining() > 50_000) {…}` — vždy hlídej `budget.total`, jinak je `remaining()` `Infinity`.
- Scale to the ask: „najdi chyby“ → pár hledačů + 1 verifikace; „důkladný audit“ → víc hledačů, 3–5 hlasů, syntéza.

## Resume

Běh lze obnovit: dokončená volání `agent()` se stejným promptem/volbami vrátí uložený výsledek okamžitě,
první změněné/nové a vše po něm běží znovu. Stejný skript + stejné `args` → 100 % cache hit.

## Praktické zásady promptů pro subagenty

Subagent je řekl, že jeho finální text JE návratová hodnota (ne zpráva člověku) → vrací surová data.
Pro strukturu použij `schema`, ne parsování textu. Do promptu dej vše potřebné (agenti nesdílejí kontext),
vymezení práce (které soubory/oblast), co vrátit, a co NEdělat. Ve fan-outu dělej partitions bez překryvu cest,
protože agenti zapisují do stejného working tree.
