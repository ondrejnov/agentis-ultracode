# agentis-ultracode

`ultracode` spouští **workflow**: krátký skript v TypeScriptu, který rozdělí velkou úlohu mezi desítky až
stovky AI agentů, nechá je pracovat souběžně a jejich výsledky složí do jednoho JSON výstupu.

Dělba práce je jednoduchá:

- **Skript řídí.** Obsahuje běžný kód: smyčky, podmínky, rozdělení práce, sčítání výsledků. Sám nečte
  soubory ani nespouští příkazy.
- **Agenti pracují.** Každé volání `agent('…')` spustí samostatný proces Claude Code
  (`agentiscode --adapter claude`, wrapper nad `claude -p`), který čte kód, opravuje, spouští testy a vrátí
  výsledek zpět skriptu.

```text
ultracode run audit
      │
      ▼
 skript (TypeScript)            agent() ──►  proces agentiscode → claude -p   (audit souboru A)
 smyčky, větvení, fan-out  ──►  agent() ──►  proces agentiscode → claude -p   (audit souboru B)
      ▲                         agent() ──►  proces agentiscode → claude -p   (ověření nálezu)
      │                                            │
      └──────────── výsledky (text nebo JSON podle schématu) ◄──┘
      │
      ▼
 stdout: JSON návratové hodnoty skriptu        .ultracode/runs/<runId>/: záznam celého běhu
```

Návrh vychází z `/workflows` v Claude Code a API skriptu je téměř shodné (viz
[srovnání](#srovnání-s-workflow-v-claude-code)).

## Kdy se workflow hodí

| Hodí se | Nehodí se |
| --- | --- |
| Práce jde rozdělit na **mnoho nezávislých kusů** (soubory, moduly, nálezy), které by se nevešly do jednoho kontextu. | Malá nebo lineární úloha (pár souborů, jedna oprava). Tu udělá jeden agent rychleji. |
| Chceš **jistotu ve výsledku**: nález ověří nezávislý skeptik, opravu zreviduje jiný agent. | Uprostřed běhu je potřeba rozhodnutí člověka. Běh žádný vstup nepřijímá. |
| Potřebuješ **smyčku do splnění podmínky** (testy zelené, žádné nové nálezy). | Zadání ještě není jasné. Workflow chybu v zadání znásobí, nejdřív ho ujasni. |

Typické tvary z praxe:

- **Audit jen pro čtení.** Kód se rozdělí na oddíly, každý oddíl projde jeden agent se zakázaným zápisem
  a závažné nálezy se pokusí vyvrátit skeptik. Například kontrola kompatibility s PHP 8: 8 oddílů,
  kontrola závislostí a ověření, celkem kolem 10 agentů.
- **Review diffu.** Jeden revizor na změněný soubor, potom jeden skeptik na každý nález. Výsledek obsahuje
  jen potvrzené nálezy a počty vyvrácených, neověřených a selhaných.
- **Implementace po částech.** Několik agentů souběžně implementuje části specifikace, každý smí měnit jen
  své soubory a změny potřebné jinde jen nahlásí. Reálný běh tohoto tvaru: 5 agentů, 34 minut, 108 volání
  nástrojů.
- **Oprava do zelena.** Jeden agent spustí testy, další opravují selhání na oddělených souborech a kolo se
  opakuje, dokud testy neprojdou nebo se dvě kola po sobě nic nezlepší.
- **Dva běhy s lidským schválením mezi nimi.** První běh (`--args '{"stage":"prepare"}'`) připraví
  a zkontroluje změny, člověk je schválí a druhý běh (`"stage":"deploy"`) je nasadí.

## Instalace

Požadavky:

- Node.js ≥ 22.18 (vyvíjeno na 24),
- `agentiscode` na `PATH`,
- [Claude Code](https://code.claude.com) (`claude`) na `PATH`, přihlášený a schopný neinteraktivního režimu.

Jiné runtime závislosti projekt nemá.

```bash
npm install
npm run build        # přeloží src/ do dist/
npm link             # zpřístupní příkaz `ultracode`
ultracode --version
```

Bez `npm run build` se CLI spustí přímo ze zdrojů (`src/cli/cli.ts`) přes type-stripping Node.js,
což se hodí při vývoji.

## První běh

```bash
cd /cesta/k/projektu
ultracode init                                   # vytvoří .ultracode/workflows/hello.workflow.ts a typy
ultracode validate .ultracode/workflows/hello.workflow.ts
ultracode run hello --args '{"name":"světe"}'
```

`run` vypíše na stderr průběh (fáze, agenti, zprávy z `log()`) a po dokončení na stdout JSON, který skript
vrátil, tady `{"ok":true,"greeting":"…"}`. Celý běh je zaznamenán v `.ultracode/runs/<runId>/`.

Další příkazy, které budeš potřebovat:

```bash
ultracode status                   # stav posledního běhu: fáze, agenti, tokeny
ultracode logs <runId> --follow    # události živě
ultracode logs <runId> --agent 3   # prompt a výsledek jednoho agenta
ultracode resume <runId>           # po přerušení nebo selhání dokončí zbytek
```

## Workflow píše Claude

Skripty obvykle nepíše člověk. Nainstaluj Claudovi skill a popiš mu úlohu („zkontroluj celý projekt po
upgradu na PHP 8“, „zreviduj diff, každý nález ověř“):

```bash
ultracode skill install            # do ~/.claude/skills/ (nebo --project do ./.claude/skills/)
```

Claude pak podle skillu [`ultracode-workflow`](skills/ultracode-workflow/SKILL.md) postupuje takto:

1. **Zjistí rozsah** (`ls`, `grep`, `git diff --stat`) a odhadne počet agentů.
2. **Napíše skript** `.ultracode/workflows/<jméno>.workflow.ts`.
3. **Zvaliduje ho:** `ultracode validate …`.
4. **Spustí ho na popředí a počká na konec**, s pevným ID běhu:
   `ultracode run <jméno> --run-id audit-1 --args '{…}'`.
5. **Přečte výsledek** a zkontroluje, kolik agentů selhalo a co zůstalo neověřené.
6. Po přerušení nebo selhání **pokračuje** přes `ultracode resume audit-1`, nezačíná znovu.

> [!IMPORTANT]
> Běh trvá minuty až hodiny a musí běžet na popředí. Agent, který workflow spustil na pozadí a ukončil svůj
> tah, už výsledek nikdy nepřečte. Běh také neukončuj kvůli „pokračování přes resume“: do journalu se
> ukládají jen dokončení agenti a práce rozpracovaných se ztratí.

## Jak vypadá skript

`.ultracode/workflows/find-todos.workflow.ts` najde TODO komentáře v adresářích. Každý adresář projde dvěma
kroky: jeden agent hledá, druhý nálezy ověří.

```ts
/// <reference path="../workflow.d.ts" />

export const meta = {
  name: 'find-todos',
  description: 'Najde TODO komentáře po adresářích a nezávisle ověří, že jsou skutečné',
  phases: [
    { title: 'Scan', detail: 'jeden agent na adresář' },
    { title: 'Verify', detail: 'druhý agent ověří každý adresář' },
  ],
}

interface Todos {
  items: Array<{ file: string; line: number; text: string }>
}

const dirs: string[] = (args && args.dirs) || ['src']

const TODOS = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, line: { type: 'number' }, text: { type: 'string' } },
        required: ['file', 'line', 'text'],
      },
    },
  },
  required: ['items'],
}

const results = await pipeline(
  dirs,
  (dir: string) =>
    agent<Todos>(`Najdi TODO/FIXME komentáře v adresáři ${dir}. Nic neupravuj. Vrať soubor, řádek a text.`, {
      label: `scan:${dir}`,
      phase: 'Scan',
      schema: TODOS,
      effort: 'low',
      disallowedTools: ['Edit', 'Write'],
    }),
  async (found: Todos | null, dir: string) => {
    if (!found) return null // agent selhal; null se propaguje do výsledku
    const checked = await agent<Todos>(
      `Ověř, že tyto TODO v ${dir} opravdu existují na uvedených řádcích; vrať jen ty skutečné.\n${JSON.stringify(found.items)}`,
      { label: `verify:${dir}`, phase: 'Verify', schema: TODOS, effort: 'low', disallowedTools: ['Edit', 'Write'] },
    )
    return checked ? { dir, items: checked.items } : null
  },
)

const ok = results.filter((r) => r !== null)
if (ok.length < dirs.length) log(`Selhalo ${dirs.length - ok.length} z ${dirs.length} adresářů.`)
return { dirs: ok, failed: dirs.length - ok.length }
```

Co si z ukázky odnést:

- **`meta`** popisuje workflow a jeho fáze. Je to čistý literál na začátku souboru; `phases` musí odpovídat
  fázím použitým ve skriptu.
- **Žádné importy.** `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget` a `workflow` jsou
  globály. Typy dodá řádek `/// <reference …>`.
- **`args`** je vstup z příkazové řádky: `ultracode run find-todos --args '{"dirs":["src","test"]}'`.
- **`schema`** (JSON Schema) říká, v jakém tvaru má agent odpovědět. Skript dostane ověřený objekt
  a nemusí nic parsovat z textu. Bez `schema` vrací `agent()` text.
- **`pipeline`** pošle každý adresář přes oba kroky nezávisle na ostatních. Adresáře běží souběžně
  a ověření jednoho nečeká na dohledání ostatních.
- **`null` znamená selhání.** `agent()` nevyhazuje výjimku; když agent selže i po opakovaných pokusech,
  vrátí `null`. Skript to musí ošetřit a selhání započítat do výsledku, aby výsledek nepředstíral úplnost.
- **`return`** je výsledek běhu. Vypíše se jako JSON na stdout a uloží do `result.json`.

Hotové příklady jsou v adresáři [`examples/`](examples/):

| Příklad | Co ukazuje |
| --- | --- |
| [`audit-routes`](examples/audit-routes.workflow.ts) | najde soubory, každý zaudituje, nálezy posoudí 3 skeptici z různých úhlů a nakonec vznikne souhrn |
| [`fix-until-green`](examples/fix-until-green.workflow.ts) | smyčka testy → oprava na oddělených souborech → znovu; zastaví po 2 kolech bez pokroku |
| [`deep-research`](examples/deep-research.workflow.ts) | hledání z více směrů, deduplikace, křížové ověření tvrzení, souhrn s citacemi |
| [`php8-upgrade`](examples/php8-upgrade.workflow.ts) | nejdřív společné změny (`Core`), pak oprava a review po oddílech kódu s kontrolou překryvu cest |

Příklad spustíš bez kopírování: `ultracode run ./examples/audit-routes.workflow.ts --args '{"root":"src"}'`.
Do vlastního projektu ho zkopíruj do `.ultracode/workflows/` a změň řádek `/// <reference …>` na
`../workflow.d.ts` (soubor vytvoří `ultracode init` nebo `ultracode types`).

## Co je dobré vědět předem

**Agent nemá paměť.** Každý agent je nový proces. Nevidí skript, ostatní agenty ani předchozí konverzaci,
jen svůj prompt a projektové `CLAUDE.md` a skilly. Prompt proto musí obsahovat cíl, kontext, rozsah práce
a popis toho, co vrátit.

**Agenti sdílejí jeden pracovní strom.** Dva agenti, kteří upraví stejný soubor, si práci tiše přepíšou.
Workflow, které zapisuje, musí práci rozdělit na cesty bez překryvu a každému agentovi říct, co je jeho.

**`pipeline` nebo `parallel`.** `pipeline(items, krok1, krok2)` vede každou položku všemi kroky samostatně
a je výchozí volbou. `parallel([...])` počká na všechny výsledky najednou (bariéra); použij ho jen tehdy,
když další krok opravdu potřebuje všechny výsledky pohromadě, například kvůli deduplikaci. Obyčejné
`for (…) await agent()` běží sériově.

**Resume pracuje podle obsahu.** Výsledek každého dokončeného agenta se zapíše do `journal.jsonl`. Při
`resume` se agent se stejným promptem, schématem, modelem, effortem, `cwd` a nástroji nespustí znovu a vrátí
uložený výsledek. Selhaní agenti se neukládají, takže se zopakují. Skript lze mezi běhy i upravit:
`ultracode run <jméno> --resume <runId>` použije nový kód a staré výsledky.

**Skript musí být deterministický.** Kvůli resume vyhazují `Date.now()`, `Math.random()` a `new Date()` bez
argumentu chybu. Čas nebo náhodu předej přes `args`.

**Limity jsou tvrdé.** `--max-agents` a `--max-tokens` běh po překročení ukončí. Hotovou práci neztratíš:
zvyš limit a pokračuj přes `resume`.

## API skriptu

Úplný popis je v [`references/api.md`](skills/ultracode-workflow/references/api.md), typy v
[`types/workflow.d.ts`](types/workflow.d.ts), osvědčené vzory v
[`references/patterns.md`](skills/ultracode-workflow/references/patterns.md).

| Globál | Účel |
| --- | --- |
| `agent(prompt, opts?)` | spustí agenta. Bez `schema` vrací text, se `schema` ověřený objekt, při selhání **`null`** |
| `pipeline(items, s1, s2, …)` | každá položka projde všemi kroky nezávisle, **bez bariéry**; výchozí volba |
| `parallel(thunks)` | spustí funkce souběžně a počká na všechny (**bariéra**); funkce s chybou vrací `null` |
| `phase(title)`, `log(msg)` | fáze a zprávy do průběhu i do `events.jsonl` |
| `args` | vstup z `--args` nebo `--args-file` jako skutečný JSON |
| `budget` | `total`, `spent()`, `remaining()` (tokeny) a `totalUsd`, `spentUsd()`, `remainingUsd()` |
| `workflow(nameOrRef, args?)` | spustí jiný workflow uvnitř tohoto (vnoření jen o jednu úroveň) |

Volby `agent()`:

| Volba | Účel |
| --- | --- |
| `label`, `phase` | název agenta a fáze v průběhu a v logu |
| `schema` | JSON Schema odpovědi; kořen je `object` |
| `model`, `effort` | model a úsilí; výchozí hodnoty jdou z `--model` a `--effort` |
| `cwd` | pracovní adresář agenta |
| `tools` | seznam povolených nástrojů; vše ostatní se odmítne |
| `disallowedTools` | zakázané nástroje, např. `['Edit', 'Write']` |
| `systemPrompt` | vlastní systémový prompt |
| `stallMs`, `timeoutMs` | limit ticha (výchozích 10 minut) a celkové doby agenta |
| `maxUsd` | strop útraty jednoho agenta |
| `noCache` | při resume nepoužije uložený výsledek |

Pravidla skriptů:

- `meta` je čistý literál na začátku souboru a jeho `phases` odpovídají volání `phase()`.
- Povolená je jen TypeScript syntaxe, kterou lze vymazat (typy, `interface`, `as`); `enum` a `namespace` ne.
- Skript běží v sandboxu bez `process`, `require`, `fetch`, `setTimeout` a souborového systému.
- `Date.now()`, `Math.random()` a `new Date()` bez argumentu vyhazují chybu.
- Limity: souběžnost `min(16, CPU−2)`, nejvýš 1000 agentů za běh a 4096 položek v jednom `parallel` nebo
  `pipeline`.

## CLI

| Příkaz | Účel |
| --- | --- |
| `ultracode run <jméno\|cesta> [--args <json>] [--args-file <cesta>]` | spustí workflow |
| `ultracode resume <runId>` | pokračuje v běhu se stejným skriptem, argumenty a volbami |
| `ultracode status [runId]` | stav, fáze, agenti a součty (`--json`) |
| `ultracode logs <runId> [--follow] [--agent <n>]` | události, prompt a výsledek agenta |
| `ultracode list` | běhy a dostupná workflow |
| `ultracode validate <cesta…>` | statická kontrola skriptů (exit 2 při chybě) |
| `ultracode meta <workflow\|cesta>` | vypíše `meta` workflow jako JSON |
| `ultracode types [--out <dir>]` | zapíše `workflow.d.ts` |
| `ultracode init` | vytvoří `.ultracode/` s ukázkovým workflow |
| `ultracode skill install [--user\|--project] [--force]` | nainstaluje skill pro psaní workflow |

Volby `run` a `resume`:

| Volba | Účel |
| --- | --- |
| `--args <json>`, `--args-file <cesta>` | vstup workflow (globál `args`) |
| `--run-id <id>` | vlastní ID běhu; jinak `wf_<8 hex>-<3 hex>` |
| `--max-usd <x>`, `--max-tokens <n>`, `--max-agents <n>` | tvrdé limity útraty, výstupních tokenů a počtu agentů |
| `--concurrency <n>` | nejvyšší počet souběžných agentů |
| `--model <m>`, `--effort <úroveň>` | výchozí model a úsilí agentů (`low`, `medium`, `high`, `xhigh`, `max`) |
| `--cwd <dir>` | adresář projektu: `cwd` agentů a kořen `.ultracode/` |
| `--quiet`, `--verbose` | potlačí průběh na stderr, nebo přidá volání nástrojů |
| `--json` | stdout jako proud JSON Lines (viz níže) |
| `--no-color` | vypne barvy |

**Kde se workflow hledá.** Argument s `/` nebo příponou `.ts`/`.js` je cesta. Jinak je to jméno
(`<jméno>.workflow.ts`, `.workflow.js`, `.ts`, `.js`) hledané v `<cwd>/.ultracode/workflows/` a ve stejném
podadresáři rodičovských adresářů, potom v `~/.ultracode/workflows` a v adresářích
z `$ULTRACODE_WORKFLOWS_DIR`.

**Výstup.** Stdout je JSON návratové hodnoty skriptu, a to jen u dokončeného běhu. Stderr je průběh pro
člověka. Neúspěšný běh má stdout prázdný; shrnutí a chybu ukáže `ultracode status <runId> --json`.

**Exit kódy.** `0` dokončeno, `1` běh selhal, `2` chybné použití, neplatný skript nebo neznámé workflow,
`130` přerušeno.

### `run --json`: proud událostí pro Agentis

S `--json` je stdout proud JSON Lines. Každý řádek je objekt s polem `t`:

- události běhu shodné s `events.jsonl`: `run_start`, `phase`, `log`, `workflow_enter` / `workflow_exit`,
  `agent_start`, `agent_tool`, `agent_retry`, `agent_done`, `budget`, `run_end`;
- `agent_event` (`{t, ts, id, label, attempt, event}`) je jedna událost z logu agenta ve formátu
  `agentiscode --json`. Pole `id` odpovídá `agent_start.id`. Tyto události se nezapisují do `events.jsonl`,
  na disku jsou v `agents/<id>/stream.jsonl`;
- poslední řádek `{"t":"summary", …}` obsahuje `RunSummary`, i u neúspěšného běhu.

```bash
ultracode run audit --json --quiet | agentis-ingest     # stdout obsahuje jen JSON Lines
```

### Živý průběh agentů v Agentis tasku

Pokud `ultracode` běží uvnitř Agentis runu (v prostředí jsou `AGENTIS_TASK_ID`, `AGENTIS_RUN_ID`
a `AGENTIS_ENDPOINT`), každý agent se spustí s `agentiscode --task-id … --run-id … --primary-session false`.
V aktuálním runu tasku se pak zobrazí jako vedlejší session s živým přepisem (text, reasoning, nástroje,
tokeny), s titulkem `[Fáze] label #id` a rodičovskou session orchestrátoru. Vyplatí se proto dávat agentům
srozumitelné `label`. Vypnutí: `ULTRACODE_AGENTIS_TELEMETRY=0`. Vyžaduje `agentiscode` s volbami
`--session-title` a `--parent-session-id`.

## Záznam běhu

Každý běh se zapisuje do `<cwd>/.ultracode/runs/<runId>/`:

```text
run.json         shrnutí a stav běhu (průběžně aktualizovaný): status, totals, error, budgetExceeded
script.ts        kopie spuštěného skriptu
args.json        vstup
options.json     volby běhu (model, effort, limity), které zdědí `resume`
events.jsonl     události běhu (append-only)
journal.jsonl    jeden řádek za dokončeného agenta: klíč, výsledek, tokeny, cena; zdroj cache pro resume
result.json      návratová hodnota skriptu (jen u dokončeného běhu)
.lock            zámek proti souběžnému `resume` (jen za běhu)
agents/<n>/      prompt.txt, stream.jsonl, stderr.txt, result.json (n = pořadí startu)
```

Když výsledek nevypadá podle očekávání, začni u `ultracode status <runId>` (kolik agentů selhalo) a potom
se podívej na konkrétního agenta přes `ultracode logs <runId> --agent <n>`.

`ultracode init` přidá do `.ultracode/.gitignore` řádek `runs/`, takže se záznamy běhů necommitují.

## Proměnné prostředí

| Proměnná | Význam | Výchozí |
| --- | --- | --- |
| `ULTRACODE_AGENT_BIN` | spustitelný soubor agenta; starší alias `ULTRACODE_CLAUDE_BIN` | `agentiscode` z `PATH` |
| `ULTRACODE_AGENT_ADAPTER` | hodnota `agentiscode --adapter` (`claude`, `claude-p`) | `claude` |
| `ULTRACODE_AGENTIS_TELEMETRY` | `0`, `false`, `no` nebo `off` vypne živý přepis subagentů v Agentisu | zapnuto |
| `ULTRACODE_MAX_CONCURRENCY` | maximální počet souběžných agentů (přebíjí `--concurrency`) | `min(16, CPU−2)` |
| `ULTRACODE_WORKFLOWS_DIR` | další adresáře s workflow (oddělené `:`) | — |
| `ULTRACODE_RETRY_BACKOFF_MS` | základ prodlevy mezi pokusy (× číslo pokusu) | `2000` |
| `ULTRACODE_KILL_GRACE_MS` | čekání po SIGTERM před SIGKILL skupiny procesů agenta | `3000` |
| `ULTRACODE_RESULT_GRACE_MS` | čekání po výsledku, než se proces agenta ukončí | `5000` |
| `ULTRACODE_EXIT_DRAIN_MS` | čekání na vyprázdnění výstupu při ukončení agenta | viz `src/runner/claude.ts` |
| `ULTRACODE_FORCE_SRC` | `1` spustí zdrojáky z `src/` i při existujícím `dist/` (vývoj, testy) | — |
| `NO_COLOR` | vypne barvy | — |

Subagenti dostávají `CLAUDE_CODE_DISABLE_WORKFLOWS=1`, aby nevznikala rekurzivní workflow.

## Bezpečnost

> [!WARNING]
> Každý agent běží s `--dangerously-skip-permissions` a `IS_SANDBOX=1`. Běží bez dotazů, souběžně a bez
> dozoru, může číst a měnit libovolné soubory dostupné uživateli, spouštět příkazy a používat síť. Obsah
> zpracovávaných souborů navíc může obsahovat **prompt injection**. **Spouštěj ultracode v kontejneru nebo
> VM** s omezeným přístupem k tajemstvím a síti.

- `disallowedTools` nástroje agentovi skutečně zakáže (např. `Edit`, `Write`).
- `tools` je skutečný whitelist. Agent s `tools` běží v `--permission-mode dontAsk`, takže vše mimo seznam
  se odmítne. Bez `tools` platí `bypassPermissions`.
- `Bash` může zapisovat i agentovi bez `Edit` a `Write`. Pro režim jen pro čtení použij
  `tools: ['Read', 'Grep', 'Glob']`, případně zákaz zápisu zopakuj v promptu.
- Agenti sdílejí jeden pracovní strom. Workflow, které zapisuje, musí rozdělit práci na cesty bez překryvu.
- U nového workflow s velkým počtem agentů nastav `--max-agents`.

## Srovnání s workflow v Claude Code

| | Claude Code | agentis-ultracode |
| --- | --- | --- |
| API skriptu | `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow` | **stejné**, skripty jsou použitelné téměř 1:1 |
| Jazyk skriptu | JavaScript | TypeScript (jen erasable syntaxe), `.d.ts`, `ultracode validate` |
| Sémantika `null`, `parallel` a `pipeline` | ano | **stejná** |
| Determinismus (`Date.now`, `Math.random`) | vyhazuje | **stejné** |
| Limity (souběžnost, 1000 agentů, 4096 položek, vnoření o 1) | ano | **stejné** |
| Spuštění | nástroj `Workflow` v session | samostatné CLI; každý agent je `agentiscode` → `claude -p` |
| Oprávnění agentů | podle session | vždy `--dangerously-skip-permissions` (spouštěj v kontejneru nebo VM) |
| Resume | nezměněný prefix volání | podle obsahu: klíč = prompt, schema, model, effort, cwd a nástroje |
| Rozpočet | tokeny turnu | `--max-tokens` i `--max-usd` |
| Volby `agent()` navíc | — | `cwd`, `tools`, `disallowedTools`, `systemPrompt`, `stallMs`, `timeoutMs`, `maxUsd`, `noCache` |
| Pozorování | UI `/workflows` | `stderr`, `events.jsonl`, `status`, `logs --follow`, `run --json` |
| `isolation: 'worktree'` | ano | **ne** (volba je odmítnuta; používej rozdělení podle cest) |
| `agentType` | ano | **ne** |
| Zastavení nebo restart jednoho agenta, TUI | ano | **ne** (`Ctrl+C` zruší běh, `resume` ho dokončí) |

## Plánované rozšíření

V pořadí, v jakém dávají smysl:

1. **Izolace přes worktree** (`isolation: 'worktree'`): souběžné zápisy bez ručního dělení cest.
2. **`agentType`**: vlastní typy subagentů (system prompt, nástroje, model).
3. **TUI nebo web dashboard**: živý strom fází a agentů místo `status` a `logs`.
4. **Stagger prompt-cache**: rozložení startu agentů se sdíleným prefixem, aby se cache zahřála jednou.
5. **Čekání na usage limit**: pauza běhu a automatické pokračování místo `null` u agentů.
6. **Pauza a restart jednotlivého agenta.**

## Známá omezení

- Při násilném ukončení hlavního procesu (`SIGKILL`, OOM) neproběhne úklid a běžící agenti mohou dokončit
  osiřele. Samotný `claude` dostane díky `PR_SET_PDEATHSIG` SIGKILL, jakmile umře jeho `agentiscode`.
  Běh se pozná jako `aborted` a `resume` ho dokončí z journalu. `SIGINT` a `SIGTERM` jsou ošetřeny.
- Cena agenta ukončeného kvůli stallu nebo přerušení je neznámá (počítá se 0), takže `costUsd` je spodní odhad.
- `stallMs` (výchozích 10 minut ticha) může ukončit agenta, který dlouho běží jedním nástrojem bez výstupu.
  U takových agentů hodnotu zvyš.
