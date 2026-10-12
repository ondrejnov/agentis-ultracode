# agentis-ultracode

Vlastní implementace **dynamických workflow** ve stylu Claude Code (`/workflows`): TypeScriptový skript
orchestruje desítky až stovky agentů a každý agent je samostatný proces `claude -p`. Skript je
deterministický řídicí kód (smyčky, fan-out, verifikace), agenti dělají nedeterministickou práci.

- **Skript bez importů** — `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow` jsou globály.
- **Generovatelný agentem** — součástí je skill `ultracode-workflow`, podle kterého Claude napíše,
  zvaliduje a spustí vlastní workflow.
- **Bezobslužný běh** — události a výsledky agentů na disku, `resume` po pádu bez opakování hotové práce,
  tvrdé limity tokenů/USD/agentů.
- **Nula runtime závislostí** — jen Node.js ≥ 22.18 a nainstalovaný `claude`.

## Instalace

Požadavky: Node.js ≥ 22.18 (vyvíjeno na 24) a [Claude Code](https://code.claude.com) (`claude`) na `PATH`,
přihlášený a schopný běžet v neinteraktivním režimu.

```bash
npm install
npm run build        # přeloží src/ do dist/
npm link             # zpřístupní příkaz `ultracode`
ultracode --version
```

Bez `npm run build` se CLI spustí přímo ze zdrojů (`src/cli/cli.ts`) přes Node type-stripping — hodí se
při vývoji.

## Rychlý start

```bash
cd /cesta/k/projektu
ultracode init                                   # .ultracode/workflows/hello.workflow.ts + typy
ultracode validate .ultracode/workflows/hello.workflow.ts
ultracode run hello --args '{"name":"světe"}'    # výsledek (JSON) na stdout, průběh na stderr
ultracode status                                 # stav posledního běhu
ultracode logs <runId> --follow                  # události živě
ultracode resume <runId>                         # po přerušení/selhání dodělá jen zbytek
```

Chceš, aby workflow psal Claude? Nainstaluj mu skill a popiš úlohu:

```bash
ultracode skill install            # do ~/.claude/skills/ (nebo --project do ./.claude/skills/)
```

> [!TIP]
> Skill vysvětluje, kdy workflow použít, jak psát prompty pro subagenty, jak se vyhnout překryvu zápisů
> a jak číst výsledek. Zdroj: [`skills/ultracode-workflow/`](skills/ultracode-workflow/SKILL.md).

## Ukázkový skript

`.ultracode/workflows/find-todos.workflow.ts` — najde TODO v adresářích, každý projde nezávisle
(pipeline), nálezy ověří druhý agent:

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

Další, plně vybavené skripty jsou v [`examples/`](examples/):

| Příklad | Co ukazuje |
| --- | --- |
| [`audit-routes`](examples/audit-routes.workflow.ts) | najdi soubory → `pipeline(audit → 3 skeptici s různými čočkami)` → syntéza s ID z kódu |
| [`fix-until-green`](examples/fix-until-green.workflow.ts) | smyčka běh → oprava (disjunktní soubory) → znovu; stop při 2 kolech bez pokroku, nezávislé potvrzení |
| [`deep-research`](examples/deep-research.workflow.ts) | multi-modal sweep → dedup → křížová verifikace claimů → kritik úplnosti → syntéza s citacemi |
| [`php8-upgrade`](examples/php8-upgrade.workflow.ts) | `Core` → `pipeline(Fix → Review)` po oddílech kódu, kontrola překryvu cest před startem |

Spuštění příkladu bez kopírování: `ultracode run ./examples/audit-routes.workflow.ts --args '{"root":"src"}'`.
Do vlastního projektu je zkopíruj do `.ultracode/workflows/` a změň řádek `/// <reference …>`
na `../workflow.d.ts` (vytvoří ho `ultracode init` nebo `ultracode types`).

## API stručně

Úplný popis je v [`references/api.md`](skills/ultracode-workflow/references/api.md), typy v
[`types/workflow.d.ts`](types/workflow.d.ts).

| Globál | Co dělá |
| --- | --- |
| `agent(prompt, opts?)` | spustí `claude -p`; bez `schema` vrací text, se `schema` ověřený objekt, při selhání **`null`** |
| `parallel(thunks)` | souběžně, **bariéra**; thunk s chybou → `null` |
| `pipeline(items, s1, s2, …)` | každá položka stagemi nezávisle, **bez bariéry**; výchozí volba |
| `phase(title)` / `log(msg)` | fáze a zprávy do průběhu a `events.jsonl` |
| `args` | vstup z `--args` / `--args-file` (skutečný JSON) |
| `budget` | `total`, `spent()`, `remaining()` (tokeny) a `totalUsd`, `spentUsd()`, `remainingUsd()` |
| `workflow(nameOrRef, args?)` | jiný workflow inline, vnoření o 1 úroveň |

Volby `agent()`: `label`, `phase`, `schema`, `model`, `effort`, `cwd`, `tools`, `disallowedTools`,
`systemPrompt`, `stallMs`, `timeoutMs`, `maxUsd`, `noCache`.

Pravidla: `meta` je čistý literál na začátku skriptu a jeho `phases` odpovídají `phase()`; `Date.now()`,
`Math.random()` a `new Date()` bez argumentu vyhazují (rozbily by resume); souběžnost `min(16, CPU−2)`,
max. 1000 agentů za běh a 4096 položek v jednom `parallel`/`pipeline`.

## CLI

| Příkaz | Účel |
| --- | --- |
| `ultracode run <jméno\|cesta> [--args <json>] [--args-file <cesta>]` | spustí workflow |
| `ultracode resume <runId>` | pokračuje v běhu (uložený skript, args i volby model/effort/limity) |
| `ultracode run <jméno> --resume <runId>` | pokračuje s aktuálním (upraveným) skriptem |
| `ultracode status [runId]` | stav, fáze, agenti, součty (`--json`) |
| `ultracode logs <runId> [--follow] [--agent <n>]` | události; prompt a výsledek agenta |
| `ultracode list` | běhy a dostupná workflow |
| `ultracode validate <cesta…>` | statická kontrola skriptů (exit 2 při chybě) |
| `ultracode meta <workflow\|cesta>` | vypíše `meta` workflow jako JSON |
| `ultracode types [--out <dir>]` | zapíše `workflow.d.ts` |
| `ultracode init` | založí `.ultracode/` s ukázkou |
| `ultracode skill install [--user\|--project] [--force]` | nainstaluje authoring skill |

Volby `run`/`resume`: `--cwd`, `--concurrency`, `--max-agents`, `--max-tokens`, `--max-usd`, `--model`,
`--effort`, `--run-id`, `--quiet`, `--verbose`, `--json`, `--no-color`.

**Výstup:** stdout je JSON návratové hodnoty skriptu (s `--json` celé shrnutí běhu, i u selhání),
stderr je průběh pro člověka. **Exit kódy:** `0` dokončeno, `1` běh selhal, `2` chybné použití / neplatný
skript / neznámé workflow, `130` přerušeno.

Workflow se hledá podle jména (`<jméno>.workflow.ts`, `.workflow.js`, `.ts`, `.js`) v
`<cwd>/.ultracode/workflows/` a ve stejných podadresářích rodičů, poté v `~/.ultracode/workflows` a v
`$ULTRACODE_WORKFLOWS_DIR`.

## Struktura run adresáře

Každý běh se zapisuje do `<cwd>/.ultracode/runs/<runId>/` (`runId` má tvar `wf_<8 hex>-<3 hex>`):

```text
run.json         shrnutí a stav běhu (průběžně aktualizované): status, totals, error, budgetExceeded
script.ts        kopie spuštěného skriptu
args.json        vstup
options.json     volby běhu (model, effort, limity) — `resume` je zdědí
events.jsonl     append-only události (run_start, phase, log, agent_start/_tool/_retry/_done, budget, run_end)
journal.jsonl    jeden řádek za DOKONČENÉHO agenta (klíč, výsledek, tokeny, cena) — zdroj cache pro resume
result.json      návratová hodnota skriptu (jen u dokončeného běhu)
.lock            jen za běhu: zámek proti souběžnému `resume` téhož běhu
agents/<n>/      prompt.txt, stream.jsonl, stderr.txt, result.json  (n = pořadí startu)
```

`ultracode init` přidá do `.ultracode/.gitignore` řádek `runs/`.

## Proměnné prostředí

| Proměnná | Význam | Default |
| --- | --- | --- |
| `ULTRACODE_CLAUDE_BIN` | spustitelný soubor `claude` (hodí se pro testy: `test/fixtures/fake-claude.mjs`) | `claude` z `PATH` |
| `ULTRACODE_MAX_CONCURRENCY` | max. souběžných agentů (`--concurrency` má přednost) | `min(16, CPU−2)` |
| `ULTRACODE_WORKFLOWS_DIR` | další adresáře s workflow (více cest odděl `:`) | — |
| `ULTRACODE_RETRY_BACKOFF_MS` | základ prodlevy mezi pokusy agenta (`× číslo pokusu`) | `2000` |
| `ULTRACODE_KILL_GRACE_MS` | čekání po SIGTERM než SIGKILL celé skupiny procesů agenta | `3000` |
| `ULTRACODE_RESULT_GRACE_MS` | jak dlouho po výsledku čekat, než se proces agenta ukončí | `5000` |
| `ULTRACODE_FORCE_SRC` | `1` = `bin/ultracode.mjs` spustí zdrojáky z `src/` i při existujícím (starším) `dist/` | — |
| `NO_COLOR` | vypne barvy | — |

Subagenti dostávají `CLAUDE_CODE_DISABLE_WORKFLOWS=1`, aby z nich nevznikala rekurzivní workflow.

## Bezpečnost

> [!WARNING]
> Každý agent běží s `--permission-mode bypassPermissions` — bez dotazů, souběžně a bez dozoru. Může číst
> a měnit libovolné soubory dostupné uživateli, spouštět příkazy a využít síť. Obsah zpracovávaných souborů
> je navíc potenciální **prompt injection**. **Spouštěj ultracode v kontejneru nebo VM** s omezeným
> přístupem k tajemstvím a síti.

- `disallowedTools` agentům skutečně zakáže nástroje (např. `Edit`, `Write`). `tools` je skutečný whitelist:
  agent se zadaným `tools` běží v `--permission-mode dontAsk` (`--allowedTools`), takže cokoli mimo seznam
  se odmítne. Bez `tools` platí `bypassPermissions`. `Bash` může psát i agentovi bez `Edit`/`Write` —
  „read-only“ je proto nejlépe `tools: ['Read','Grep','Glob']` nebo i věta v promptu.
- Agenti sdílejí jeden working tree: workflow, které zapisuje, musí rozdělit práci po disjunktních cestách.
- `--max-usd` a `--max-tokens` nastavuj u každého nového fan-outu.


## Srovnání s workflow v Claude Code

| | Claude Code | agentis-ultracode |
| --- | --- | --- |
| API skriptu | `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow` | **stejné**; skripty jsou použitelné skoro 1:1 |
| Jazyk skriptu | JavaScript | TypeScript (jen „erasable“ syntaxe) + `.d.ts`, `ultracode validate` |
| `null` z `agent()`, `parallel`/`pipeline` semantika | ano | **stejné** |
| Determinismus (`Date.now`, `Math.random`) | vyhazuje | **stejné** |
| Limity (souběžnost, 1000 agentů, 4096 položek, vnoření o 1) | ano | **stejné** |
| Spuštění | nástroj `Workflow` v session | samostatné CLI, každý agent je `claude -p`, výsledek JSON na stdout |
| Oprávnění agentů | podle session | vždy `bypassPermissions` (spouštět v kontejneru/VM) |
| Resume | nezměněný prefix volání | podle obsahu: klíč = prompt + schema + model + effort + cwd + nástroje; odolné vůči pořadí v `parallel` |
| Rozpočet | tokeny turnu (`+500k`) | `--max-tokens` i `--max-usd` |
| Volby `agent()` navíc | — | `cwd`, `tools`, `disallowedTools`, `systemPrompt`, `stallMs`, `timeoutMs`, `maxUsd`, `noCache` |
| Pozorování | integrované UI `/workflows` | `stderr`, `events.jsonl`, `status`, `logs --follow` |
| `isolation: 'worktree'` | ano | **ne** (volba je odmítnuta; partitions po cestách) |
| `agentType` | ano | **ne** |
| Zastavení/restart jednoho agenta, TUI | ano | **ne** (`Ctrl+C` zruší běh, `resume`) |

## Další kroky

Mimo rozsah verze 1, v pořadí, v jakém dávají smysl:

1. **Worktree izolace** (`isolation: 'worktree'`) — souběžné zápisy bez ručního dělení cest.
2. **`agentType`** — vlastní typy subagentů (system prompt, nástroje, model).
3. **TUI / web dashboard** — živý strom fází a agentů místo `status`/`logs`.
4. **Stagger prompt-cache** — rozložení startu agentů se sdíleným prefixem, ať se cache zahřeje jednou.
5. **Čekání na usage limit** — pauza běhu a automatické pokračování místo `null` u agentů.
6. **Pauza a restart jednotlivého agenta.**

Známá omezení verze 1:

- Při násilném ukončení hlavního procesu (`SIGKILL`, OOM) neběží úklid a rozběhnutí agenti (`claude -p`) mohou
  dokončit osiřele; běh se pozná jako `aborted` a `resume` ho dodělá z journalu. `SIGINT`/`SIGTERM` jsou ošetřeny.
- Cena agenta zabitého při stallu/přerušení je neznámá (počítá se 0), takže `costUsd` je spodní odhad.
- `stallMs` (default 10 min ticha) může zabít agenta, který dlouho vykonává jeden nástroj bez výstupu; u takových
  agentů ho zvyš.
