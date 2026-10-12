/** České nápovědy CLI. */

export const MAIN_HELP = `ultracode — dynamická workflow nad \`claude -p\`

Použití:
  ultracode <příkaz> [volby]

Příkazy:
  run <workflow|cesta>     spustí workflow (jméno z .ultracode/workflows/ nebo cesta ke skriptu)
  resume <runId>           pokračuje v přerušeném/selhaném běhu (stejný skript i args)
  status [runId]           stav běhu (bez id: poslední běh)
  list                     seznam běhů a dostupných workflow
  logs <runId>             události běhu; --follow sleduje, --agent <n> ukáže prompt a výsledek agenta
  validate <cesta...>      zkontroluje skripty workflow (exit 2 při chybě)
  types                    zapíše types/workflow.d.ts pro psaní skriptů
  skill install            nainstaluje authoring skill pro Claude do ~/.claude/skills/ nebo projektu
  init                     vytvoří .ultracode/workflows/ s ukázkovým workflow a typy
  help [příkaz]            tato nápověda

Globální volby:
  --help, -h               nápověda (i pro konkrétní příkaz)
  --version                verze

Výstup \`run\`: stdout = JSON výsledek skriptu (s --json celé shrnutí běhu), stderr = průběh pro člověka.
Exit kódy: 0 dokončeno, 1 běh selhal, 2 chybné použití / neplatný skript / neznámé workflow, 130 přerušeno.

Podrobnosti ke každému příkazu: ultracode <příkaz> --help
`

const RUN_OPTIONS = `Volby:
  --args <json>            vstup workflow (globál \`args\`)
  --args-file <cesta>      vstup workflow ze souboru s JSON
  --cwd <adresář>          projektový adresář (cwd agentů a kořen .ultracode/); default aktuální
  --concurrency <n>        max. souběžných agentů (default min(16, CPU-2))
  --max-agents <n>         max. agentů za běh (default 1000)
  --max-tokens <n>         tvrdý strop výstupních tokenů
  --max-usd <x>            tvrdý strop útrat v USD
  --model <m>              výchozí model agentů
  --effort <úroveň>        výchozí effort agentů: low|medium|high|xhigh|max
  --run-id <id>            vlastní id běhu
  --quiet, -q              potlačí průběh na stderr
  --verbose                zobrazí i volání nástrojů a náhled promptů
  --json                   na stdout celé shrnutí běhu místo samotného výsledku
  --no-color               vypne barvy (jinak jen na TTY a bez NO_COLOR)`

export const COMMAND_HELP: Record<string, string> = {
  run: `Použití: ultracode run <workflow|cesta> [volby]

Spustí workflow. Argument je cesta ke skriptu (obsahuje „/“ nebo končí .ts/.js)
nebo jméno hledané v <cwd>/.ultracode/workflows/ (a rodičovských adresářích),
~/.ultracode/workflows a $ULTRACODE_WORKFLOWS_DIR.

${RUN_OPTIONS}
  --resume <runId>         pokračuje v běhu (bez zadaného workflow se použije uložený skript a args)
`,
  resume: `Použití: ultracode resume <runId> [volby]

Pokračuje v běhu: dokončená volání agentů se stejným promptem vrátí uložený výsledek,
zbytek se spustí znovu. Používá skript a args uložené v běhu (lze přepsat --args).

${RUN_OPTIONS}
`,
  status: `Použití: ultracode status [runId] [--json] [--cwd dir]

Ukáže stav běhu, fáze, agenty a součty. Bez runId se použije nejnovější běh.
`,
  list: `Použití: ultracode list [--limit n] [--json] [--cwd dir]

Seznam běhů (nejnovější první) a dostupných workflow.
`,
  logs: `Použití: ultracode logs <runId> [--follow] [--agent n] [--cwd dir]

Vypíše události běhu čitelně. --follow sleduje běh do konce.
--agent <n> vypíše prompt a výsledek agenta (z agents/<n>/).
`,
  validate: `Použití: ultracode validate <cesta...> [--json]

Zkontroluje skripty (meta, syntaxe, zakázané konstrukce). Exit 2, pokud některý skript není platný.
`,
  types: `Použití: ultracode types [--out dir] [--cwd dir]

Zapíše workflow.d.ts do <dir> (default <cwd>/.ultracode/) a vypíše řádek
\`/// <reference path="…" />\` pro skripty v .ultracode/workflows/.
`,
  skill: `Použití: ultracode skill install [--user|--project] [--force]

Zkopíruje skill ultracode-workflow do ~/.claude/skills/ (--user, default; respektuje
CLAUDE_CONFIG_DIR) nebo do <cwd>/.claude/skills/ (--project). Bez --force nic nepřepisuje.
`,
  init: `Použití: ultracode init [--force] [--cwd dir]

Vytvoří .ultracode/workflows/ s ukázkovým hello.workflow.ts a vygeneruje typy.
Existující soubory nepřepisuje (bez --force).
`,
}
