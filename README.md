# agentis-ultracode

Runtime pro **dynamické workflow** inspirované `/workflows` v Claude Code. Skript v TypeScriptu řídí desítky
až stovky agentů; každý agent je samostatný proces `agentiscode --adapter claude` (wrapper nad `claude -p`
s jednotným JSON výstupem).

Skript tvoří deterministická řídicí logika (smyčky, fan-out, verifikace), nedeterministickou práci
dělají agenti.

- **Skripty bez importů.** `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget` a `workflow`
  jsou globály.
- **Psané agentem.** Součástí je skill `ultracode-workflow`, podle kterého Claude workflow napíše,
  zvaliduje a spustí.
- **Běh bez dozoru.** Výsledky agentů se ukládají na disk, `resume` dokončí přerušený běh bez opakování
  hotové práce, limity tokenů, USD a počtu agentů jsou tvrdé.
- **Bez runtime závislostí.** Potřeba je Node.js ≥ 22.18, nainstalované `agentiscode` a `claude`.
- **JSON stream pro Agentis.** `ultracode run --json` posílá události běhu i kompletní log každého agenta
  jako JSON Lines.

## Instalace

Požadavky: Node.js ≥ 22.18 (vyvíjeno na 24) a [Claude Code](https://code.claude.com) (`claude`) na `PATH`,
přihlášený a schopný neinteraktivního režimu.

```bash
npm install
npm run build        # přeloží src/ do dist/
npm link             # zpřístupní příkaz `ultracode`
ultracode --version
```

Bez `npm run build` se CLI spustí přímo ze zdrojů (`src/cli/cli.ts`) přes type-stripping Node.js,
což se hodí při vývoji.

## Rychlý start

```bash
cd /cesta/k/projektu
ultracode init                                   # .ultracode/workflows/hello.workflow.ts + typy
ultracode validate .ultracode/workflows/hello.workflow.ts
ultracode run hello --args '{"name":"světe"}'    # výsledek (JSON) na stdout, průběh na stderr
ultracode status                                 # stav posledního běhu
ultracode logs <runId> --follow                  # události živě
ultracode resume <runId>                         # po přerušení dokončí zbytek
```

Workflow může napsat Claude. Nainstaluj mu skill a popiš úlohu:

```bash
ultracode skill install            # do ~/.claude/skills/ (nebo --project do ./.claude/skills/)
```

> [!TIP]
> Skill popisuje, kdy workflow použít, jak psát prompty pro subagenty, jak se vyhnout souběžným zápisům
> a jak číst výsledek. Zdroj: [`skills/ultracode-workflow/`](skills/ultracode-workflow/SKILL.md).

## Ukázkový skript

`.ultracode/workflows/find-todos.workflow.ts` najde TODO komentáře v adresářích. Každý adresář se zpracuje
nezávisle (`pipeline`) a nálezy ověří druhý agent:

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

Plné příklady jsou v adresáři [`examples/`](examples/):

| Příklad | Co ukazuje |
| --- | --- |
| [`audit-routes`](examples/audit-routes.workflow.ts) | najde soubory, pak `pipeline(audit → 3 skeptici s různými čočkami)` a syntézu s ID z kódu |
| [`fix-until-green`](examples/fix-until-green.workflow.ts) | smyčka běh → oprava na disjunktních souborech → znovu; zastaví po 2 kolech bez pokroku |
| [`deep-research`](examples/deep-research.workflow.ts) | sken z více směrů, deduplikace, křížová verifikace tvrzení, syntéza s citacemi |
| [`php8-upgrade`](examples/php8-upgrade.workflow.ts) | `Core` a potom `pipeline(Fix → Review)` po oddílech kódu s kontrolou překryvu cest |

Příklad spustíš bez kopírování: `ultracode run ./examples/audit-routes.workflow.ts --args '{"root":"src"}'`.
Do vlastního projektu ho zkopíruj do `.ultracode/workflows/` a změň řádek `/// <reference …>` na
`../workflow.d.ts` (soubor vytvoří `ultracode init` nebo `ultracode types`).

## API

Úplný popis je v [`references/api.md`](skills/ultracode-workflow/references/api.md), typy v
[`types/workflow.d.ts`](types/workflow.d.ts).

| Globál | Účel |
| --- | --- |
| `agent(prompt, opts?)` | spustí agenta. Bez `schema` vrací text, se `schema` ověřený objekt, při selhání **`null`** |
| `parallel(thunks)` | souběžně s **bariérou**; thunk s chybou vrací `null` |
| `pipeline(items, s1, s2, …)` | každou položku projde stage nezávisle, **bez bariéry**; výchozí volba |
| `phase(title)`, `log(msg)` | fáze a zprávy do průběhu i do `events.jsonl` |
| `args` | vstup z `--args` nebo `--args-file` jako skutečný JSON |
| `budget` | `total`, `spent()`, `remaining()` (tokeny) a `totalUsd`, `spentUsd()`, `remainingUsd()` |
| `workflow(nameOrRef, args?)` | spustí jiný workflow inline (vnoření o jednu úroveň) |

Volby `agent()`: `label`, `phase`, `schema`, `model`, `effort`, `cwd`, `tools`, `disallowedTools`,
`systemPrompt`, `stallMs`, `timeoutMs`, `maxUsd`, `noCache`.

Pravidla skriptů:

- `meta` je čistý literál na začátku souboru a jeho `phases` odpovídají volání `phase()`.
- `Date.now()`, `Math.random()` a `new Date()` bez argumentu vyhazují chybu, protože by rozbily `resume`.
- Limity: souběžnost `min(16, CPU−2)`, nejvýš 1000 agentů za běh a 4096 položek v jednom `parallel` nebo `pipeline`.

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
| `ultracode skill install [--user\|--project] [--force]` | nainstaluje authoring skill |

Volby `run` a `resume`: `--cwd`, `--concurrency`, `--max-agents`, `--max-tokens`, `--max-usd`, `--model`,
`--effort`, `--run-id`, `--quiet`, `--verbose`, `--json`, `--no-color`.

**Výstup.** Stdout je JSON návratové hodnoty skriptu, stderr je průběh pro člověka. S `--json` je stdout
proud JSON Lines.

**Exit kódy.** `0` dokončeno, `1` běh selhal, `2` chybné použití, neplatný skript nebo neznámé workflow,
`130` přerušeno.

### `run --json`: stream pro Agentis

Každý řádek je JSON objekt s polem `t`:

- události běhu shodné s `events.jsonl`: `run_start`, `phase`, `log`, `workflow_enter` / `workflow_exit`,
  `agent_start`, `agent_tool`, `agent_retry`, `agent_done`, `budget`, `run_end`;
- `agent_event` (`{t, ts, id, label, attempt, event}`) je jedna událost z logu subagenta ve formátu
  `agentiscode --json`. Pole `id` odpovídá `agent_start.id`. Tyto události se nezapisují do `events.jsonl`,
  na disku jsou v `agents/<id>/stream.jsonl`;
- poslední řádek `{"t":"summary", …}` obsahuje `RunSummary`, i u neúspěšného běhu.

```bash
ultracode run audit --json --quiet | agentis-ingest     # stdout obsahuje jen JSON Lines
```

### Živý průběh subagentů v Agentis tasku

Pokud `ultracode` běží uvnitř Agentis runu (v prostředí jsou `AGENTIS_TASK_ID`, `AGENTIS_RUN_ID`
a `AGENTIS_ENDPOINT`), každý subagent se spustí s `agentiscode --task-id … --run-id … --primary-session false`.
V aktuálním runu tasku se pak zobrazí jako vedlejší session s živým přepisem (text, reasoning, nástroje,
tokeny), s titulkem `[Fáze] label #id` a rodičovskou session orchestrátoru. Vypnutí:
`ULTRACODE_AGENTIS_TELEMETRY=0`. Vyžaduje `agentiscode` s volbami `--session-title` a `--parent-session-id`.

Workflow se hledá podle jména (`<jméno>.workflow.ts`, `.workflow.js`, `.ts`, `.js`) v
`<cwd>/.ultracode/workflows/` a ve stejných podadresářích rodičů, potom v `~/.ultracode/workflows` a v
adresářích z `$ULTRACODE_WORKFLOWS_DIR`.

## Struktura běhu

Každý běh se zapisuje do `<cwd>/.ultracode/runs/<runId>/` (`runId` má tvar `wf_<8 hex>-<3 hex>`):

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

`ultracode init` přidá do `.ultracode/.gitignore` řádek `runs/`.

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
> Každý agent běží s `--dangerously-skip-permissions` a `IS_SANDBOX=1`. Běží bez dotazů, souběžně a bez dozoru, může
> číst a měnit libovolné soubory dostupné uživateli, spouštět příkazy a používat síť. Obsah zpracovávaných
> souborů navíc může obsahovat **prompt injection**. **Spouštěj ultracode v kontejneru nebo VM** s omezeným
> přístupem k tajemstvím a síti.

- `disallowedTools` nástroje agentovi skutečně zakáže (např. `Edit`, `Write`).
- `tools` je skutečný whitelist. Agent s `tools` běží v `--permission-mode dontAsk`, takže vše mimo seznam
  se odmítne. Bez `tools` platí `bypassPermissions`.
- `Bash` může zapisovat i agentovi bez `Edit` a `Write`. Pro režim jen pro čtení použij
  `tools: ['Read', 'Grep', 'Glob']`, případně to řekni v promptu.
- Agenti sdílejí jeden pracovní strom. Workflow, které zapisuje, musí rozdělit práci na disjunktní cesty.
- Při každém novém fan-outu nastav `--max-usd` a `--max-tokens`.

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
