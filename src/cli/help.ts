/** CLI help texts. */

export const MAIN_HELP = `ultracode — dynamic workflows on top of \`agentiscode\` (claude -p)

Usage:
  ultracode <command> [options]

Commands:
  run <workflow|path>      runs a workflow (name from .ultracode/workflows/ or path to a script)
  resume <runId>           continues an interrupted/failed run (same script and args)
  status [runId]           run status (without id: the latest run)
  list                     lists runs and available workflows
  logs <runId>             run events; --follow watches, --agent <n> shows the agent's prompt and result
  validate <path...>       checks workflow scripts (exit 2 on error)
  meta <workflow|path>     prints the workflow's meta as JSON
  types                    writes types/workflow.d.ts for writing scripts
  skill install            installs the authoring skill for Claude into ~/.claude/skills/ or the project
  init                     creates .ultracode/workflows/ with a sample workflow and types
  help [command]           this help

Global options:
  --help, -h               help (also for a specific command)
  --version                version

Output of \`run\`: stdout = JSON result of the script (with --json a JSON Lines event stream), stderr = progress for humans.
Exit codes: 0 completed, 1 run failed, 2 incorrect usage / invalid script / unknown workflow, 130 interrupted.

Details for each command: ultracode <command> --help
`

const RUN_OPTIONS = `Options:
  --args <json>            workflow input (global \`args\`)
  --args-file <path>       workflow input from a JSON file
  --cwd <dir>              project directory (agents' cwd and root of .ultracode/); default current
  --concurrency <n>        max. concurrent agents (default min(16, CPU-2))
  --max-agents <n>         max. agents per run (default 1000)
  --max-tokens <n>         hard cap on output tokens
  --max-usd <x>            hard cap on spending in USD
  --model <m>              default model of agents
  --effort <level>         default effort of agents: low|medium|high|xhigh|max
  --run-id <id>            custom run id
  --quiet, -q              suppresses progress on stderr
  --verbose                also shows tool calls and prompt previews
  --json                   stream JSON Lines on stdout: run events + every agent's log (agent_event),
                           ending with {"t":"summary","summary":{…}} (for Agentis visualization)
  --no-color               disables colors (otherwise only on a TTY and without NO_COLOR)`

export const COMMAND_HELP: Record<string, string> = {
  run: `Usage: ultracode run <workflow|path> [options]

Runs a workflow. The argument is a path to a script (contains "/" or ends with .ts/.js)
or a name searched for in <cwd>/.ultracode/workflows/ (and parent directories),
~/.ultracode/workflows and $ULTRACODE_WORKFLOWS_DIR.

${RUN_OPTIONS}
  --resume <runId>         continues the run (without a given workflow the stored script and args are used)
`,
  resume: `Usage: ultracode resume <runId> [options]

Continues the run: completed agent calls with the same prompt return the stored result,
the rest is run again. Uses the script and args stored in the run (can be overridden with --args).

${RUN_OPTIONS}
`,
  status: `Usage: ultracode status [runId] [--json] [--cwd dir]

Shows run status, phases, agents and totals. Without a runId the latest run is used.
`,
  list: `Usage: ultracode list [--limit n] [--json] [--cwd dir]

List of runs (newest first) and available workflows.
`,
  logs: `Usage: ultracode logs <runId> [--follow] [--agent n] [--cwd dir]

Prints run events in a readable form. --follow follows the run until it ends.
--agent <n> prints the prompt and result of an agent (from agents/<n>/).
`,
  validate: `Usage: ultracode validate <path...> [--json]

Checks scripts (meta, syntax, forbidden constructs). Exit 2 if any script is invalid.
`,
  meta: `Usage: ultracode meta <workflow|path> [--cwd dir]

Prints the \`meta\` of a workflow (name, description, whenToUse, phases) as JSON on stdout.
The argument is a script path or a workflow name. Exit 2 if the script is invalid or cannot be found.
`,
  types: `Usage: ultracode types [--out dir] [--cwd dir]

Writes workflow.d.ts to <dir> (default <cwd>/.ultracode/) and prints the line
\`/// <reference path="…" />\` for scripts in .ultracode/workflows/.
`,
  skill: `Usage: ultracode skill install [--user|--project] [--force]

Copies the ultracode-workflow skill to ~/.claude/skills/ (--user, default; respects
CLAUDE_CONFIG_DIR) or to <cwd>/.claude/skills/ (--project). Without --force nothing is overwritten.
`,
  init: `Usage: ultracode init [--force] [--cwd dir]

Creates .ultracode/workflows/ with a sample hello.workflow.ts and generates types.
Existing files are not overwritten (without --force).
`,
}
