# agentis-ultracode — návrh

Vlastní implementace dynamických workflow jako v Claude Code (`/workflows`, nástroj `Workflow`):
agent (Claude) vygeneruje **TypeScriptový skript**, ten se spustí příkazem `ultracode run` a na pozadí
orchestruje mnoho agentů, každého jako samostatný proces `claude -p`.

Inspirace: <https://code.claude.com/docs/en/workflows>, <https://github.com/ekil1100/pi-ultracode>,
ukázkový běh `php8-upgrade-wf_003aa2c5-8ce.js` (21 agentů, `agent → pipeline(fix → review)`).

## Rozhodnutí (potvrzená uživatelem)

| Téma | Rozhodnutí |
| --- | --- |
| Model skriptu | **Globály + `.d.ts`**: skript nemá importy; `agent/parallel/pipeline/phase/log/args/budget/workflow` jsou injektované. Skripty z Claude Code jsou použitelné skoro 1:1 (jen TS místo JS). |
| Oprávnění agentů | **Vždy `--permission-mode bypassPermissions`** (běží bez dozoru, paralelně). Ověřeno, že funguje i jako root. Doporučeno pouštět v kontejneru/VM. |
| Integrace | **Samostatný CLI `ultracode`**. Agentis adapter ho později zavolá z bash kroku (stdout = JSON výsledek, exit code, `.ultracode/runs/<id>/`). |
| Pozorování | **Plain log (stderr) + `events.jsonl` + `journal.jsonl`** na disku; `status`/`list`/`logs` čtou z disku. Žádné TUI/web. |
| Runtime | **Node ≥ 22.18 (cíl 24) + TypeScript**, `vm` + `worker_threads`. Za běhu **0 závislostí**. Skripty se překládají `module.stripTypeScriptTypes`. |
| Název | balíček `agentis-ultracode`, CLI `ultracode`, skripty `*.workflow.ts` ve `.ultracode/workflows/`. |
| Worktree | **Ne ve v1.** Kolize řeší skript rozdělením cest (partitions) jako v php8-upgrade. Pole `isolation` runtime odmítne s jasnou chybou. |
| Jazyk | **Vše česky**: README, DESIGN, authoring skill, CLI hlášky, výchozí system prompt agentů. Identifikátory v kódu anglicky. |

## Rozhodnutí, která jsem udělal sám (dá se změnit)

1. **Resume je content-addressed**, ne prefix-replay: klíč volání = `sha256(prompt + schema + model + effort + cwd + tools + systemPrompt)`
   + pořadové číslo stejného klíče. Shodné volání vrátí uložený výsledek, jinak běží znovu — odolné vůči
   nedeterministickému pořadí v `parallel()`. Změní-li se výstup upstream agenta, změní se prompt downstream
   agentů a ti se spustí znovu automaticky (stejný efekt jako v Claude Code).
2. **`agent()` vrací `null`** při terminálním selhání (po retry/stall restartech) i při přerušení, stejně jako v Claude Code;
   skript musí `null` ošetřit. Chyby skriptu (neplatné schema, překročený rozpočet) vyhazují.
3. **Rozpočet** = výstupní tokeny (`--max-tokens`) a/nebo USD (`--max-usd`), tvrdý strop: po dosažení další `agent()` vyhodí `BudgetExceededError`
   (v `parallel`/`pipeline` se promění v `null`, běh doběhne s částečným výsledkem a `budgetExceeded: true`).
4. **Subagenti mají zakázané workflow** (`CLAUDE_CODE_DISABLE_WORKFLOWS=1` + `--disallowedTools Workflow`), jinak by globální
   `ultracode` setting uživatele spouštěl rekurzivní workflow z dětí.
5. **Subagenti dědí CLAUDE.md, skills a MCP** z projektu (nepoužíváme `--bare`); `--no-session-persistence`, ať se nezaplní `/resume` picker.
   Vlastní záznam každého agenta je v `agents/<id>/`.
6. **Souběžnost** `min(16, CPU-2)` (min 1), přepis `--concurrency` / `ULTRACODE_MAX_CONCURRENCY`; 1000 agentů/běh; 4096 položek/`parallel`/`pipeline`.
7. **Procesní skupina**: každý `claude` startuje jako vedoucí vlastní skupiny a při abortu/stallu/ukončení se zabíjí celá skupina (žádní sirotci).
8. **Whitelist nástrojů** (oprava faktu po integraci): `--allowedTools` v `bypassPermissions` NIC neomezuje (ověřeno reálným claude).
   Agent se zadaným `tools` proto běží v `--permission-mode dontAsk` (vše mimo seznam se odmítne); bez `tools` zůstává `bypassPermissions`.
9. **Stdout CLI = JSON výsledek skriptu**, stderr = lidský log. Exit kódy: 0 ok, 1 běh selhal, 2 chybné použití/neplatný skript, 130 přerušeno.

## Architektura

```
bin/ultracode.mjs            tenký shim → dist/cli/cli.js (fallback na src/cli/cli.ts přes type-stripping, vynutitelný ULTRACODE_FORCE_SRC=1)
src/
  types.ts, errors.ts        KONTRAKTY (sdílené)
  runner/claude.ts           [modul 1] spuštění jednoho agenta: spawn claude -p, stream-json, retry, stall, abort
  script/                    [modul 2] načtení a běh skriptu
    parse.ts                   extrakce meta (čistý literál), validace, TS strip, obalení do async funkce
    worker.ts                  vm kontext s globály (agent/parallel/pipeline…), determinism guardy
    host.ts                    runScript(): worker ↔ hlavní vlákno (RPC), abort, SAB budget
  engine/                    [modul 3] orchestrace běhu
    engine.ts                  runWorkflow(): semafor, journal, resume, rozpočet, eventy, run dir
    journal.ts, store.ts       zápis/čtení runs/<id>/*, klíče cache
    discovery.ts               hledání workflow podle jména
  cli/                       [modul 4] CLI
    cli.ts, render.ts, commands/*  run | resume | status | list | logs | validate | types | skill install | init
skills/ultracode-workflow/   [modul 5] authoring skill pro Claude (SKILL.md + references)
examples/*.workflow.ts       [modul 5] reálné příklady
types/workflow.d.ts          veřejný kontrakt API pro skripty
test/                        node:test; fake `claude` v test/fixtures/fake-claude.mjs
```

### Tok jednoho běhu

1. CLI → `runWorkflow(opts)`; engine najde skript, `parseScript()` (meta + diagnostika), založí `runs/<runId>/`.
2. `runScript()` spustí worker; ve vm kontextu poběží tělo skriptu se globály. `agent()` ve workeru → RPC `ScriptHooks.agent` na hlavním vlákně.
3. Engine: cache lookup (resume) → semafor → `runClaude()` → journal + events → výsledek zpět do workeru.
4. `parallel`/`pipeline`/`phase`/`log`/`workflow` žijí ve workeru (čistý JS nad `agent()`), `budget` čte SAB.
5. Konec: `result.json`, `run.json`, `run_end` event; CLI vypíše JSON na stdout.

### Adresář běhu `<cwd>/.ultracode/runs/<runId>/`

```
run.json            metadata + stav + totals (aktualizuje se průběžně, atomický zápis)
script.ts           kopie spuštěného skriptu
args.json           vstup
options.json        volby běhu (model, effort, limity…) — `resume` je zdědí, protože model/effort jsou v klíči cache
events.jsonl        append-only RunEvent (viz types.ts)
journal.jsonl       jeden řádek za DOKONČENÉHO agenta: {key, seq, ok, label, result, usage, costUsd, sessionId, ts}
result.json         návratová hodnota skriptu
.lock               jen za běhu: {pid, ts}; zámek proti souběžnému `resume` (zámek mrtvého pid se přepíše)
agents/<id>/        prompt.txt, stream.jsonl, stderr.txt, result.json   (id = pořadí startu, 1..N)
```

`runId` = `wf_<8 hex>-<3 hex>` (jako v Claude Code).

### `claude -p` volání (jeden agent)

```
claude -p --output-format stream-json --verbose --no-session-persistence
       --permission-mode bypassPermissions --disallowedTools Workflow[,…]
       [--model M] [--effort E] [--json-schema '<schema>'] [--allowedTools …]
       [--append-system-prompt '<výchozí+vlastní>'] [--max-budget-usd X]
prompt na stdin;  env: CLAUDE_CODE_DISABLE_WORKFLOWS=1
```
Výsledek = poslední event `type:"result"` (`result`, `structured_output`, `usage`, `total_cost_usd`, `session_id`, `num_turns`, `is_error`, `subtype`).

## Rozsah v1 / mimo rozsah

V1: vše výše. **Mimo v1** (v dokumentu `README.md` sekce „Další kroky“): worktree izolace, pauza/restart jednotlivého agenta,
TUI/web dashboard, stagger prompt-cache, čekání na usage limit, Agentis YAML integrace, `agentType` (vlastní subagenti).
