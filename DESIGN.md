# agentis-ultracode — design

Own implementation of dynamic workflows as in Claude Code (`/workflows`, tool `Workflow`):
an agent (Claude) generates a **TypeScript script**; the script is started with the `ultracode run` command and orchestrates many agents in the background, each as a separate `agentiscode --adapter claude` process (a wrapper over `claude -p` with unified JSON output).

Inspiration: <https://code.claude.com/docs/en/workflows>, <https://github.com/ekil1100/pi-ultracode>,
example run `php8-upgrade-wf_003aa2c5-8ce.js` (21 agents, `agent → pipeline(fix → review)`).

## Decisions (confirmed by the user)

| Topic | Decision |
| --- | --- |
| Script model | **Globals + `.d.ts`**: the script has no imports; `agent/parallel/pipeline/phase/log/args/budget/workflow` are injected. Scripts from Claude Code are usable almost 1:1 (only TS instead of JS). |
| Agent permissions | **Always `--permission-mode bypassPermissions`** (runs unattended, in parallel). Verified to work as root too. Recommended to run in a container/VM. |
| Integration | **Standalone CLI `ultracode`**. The Agentis adapter will later call it from a bash step (stdout = JSON result, exit code, `.ultracode/runs/<id>/`). |
| Observation | **Plain log (stderr) + `events.jsonl` + `journal.jsonl`** on disk; `status`/`list`/`logs` read from disk. No TUI/web. |
| Runtime | **Node ≥ 22.18 (target 24) + TypeScript**, `vm` + `worker_threads`. At run time **0 dependencies**. Scripts are transpiled via `module.stripTypeScriptTypes`. |
| Name | package `agentis-ultracode`, CLI `ultracode`, scripts `*.workflow.ts` in `.ultracode/workflows/`. |
| Worktree | **Not in v1.** Collisions are handled by the script splitting work by paths (partitions), as in php8-upgrade. The `isolation` field is rejected by the runtime with a clear error. |
| Language | **Everything in Czech**: README, DESIGN, authoring skill, CLI messages, the default agent system prompt. Identifiers in code in English. |

## Decisions I made myself (can be changed)

1. **Resume is content-addressed**, not prefix-replay: the call key = `sha256(prompt + schema + model + effort + cwd + tools + systemPrompt)`
   + the sequence number of the same key. An identical call returns the stored result, otherwise it runs again — robust against the nondeterministic order in `parallel()`.
   If an upstream agent's output changes, the prompt of downstream agents changes and they run again automatically (same effect as in Claude Code).
2. **`agent()` returns `null`** on a terminal failure (after retry/stall restarts) and on abort, just like in Claude Code;
   the script must handle `null`. Script errors (invalid schema, exceeded budget) throw.
3. **Budget** = output tokens (`--max-tokens`) and/or USD (`--max-usd`), a hard cap: once reached, the next `agent()` throws `BudgetExceededError`
   (inside `parallel`/`pipeline` it turns into `null`, the run finishes with a partial result and `budgetExceeded: true`).
4. **Subagents have workflows disabled** (`CLAUDE_CODE_DISABLE_WORKFLOWS=1` + `--disallowedTools Workflow`), otherwise the user's global
   `ultracode` setting would run recursive workflows from the children.
5. **Subagents inherit CLAUDE.md, skills, and MCP** from the project (we do not use `--bare`); `--no-session-persistence`, so the `/resume` picker does not fill up.
   Each agent's own record is in `agents/<id>/`.
6. **Concurrency** `min(16, CPU-2)` (min 1), override with `--concurrency` / `ULTRACODE_MAX_CONCURRENCY`; 1000 agents per run; 4096 items per `parallel`/`pipeline`.
7. **Process group**: each `claude` starts as the leader of its own group, and on abort/stall/exit the whole group is killed (no orphans).
8. **Tool whitelist** (a fact correction after integration): `--allowedTools` does NOTHING to restrict in `bypassPermissions` (verified with a real claude).
   An agent with the `tools` option therefore runs in `--permission-mode dontAsk` (everything outside the list is rejected); without `tools` it stays on `bypassPermissions`.
9. **CLI stdout = JSON result of the script**, stderr = human log. Exit codes: 0 ok, 1 run failed, 2 incorrect usage/invalid script, 130 aborted.

## Architecture

```
bin/ultracode.mjs            thin shim → dist/cli/cli.js (fallback to src/cli/cli.ts via type-stripping, forceable with ULTRACODE_FORCE_SRC=1)
src/
  types.ts, errors.ts        CONTRACTS (shared)
  runner/claude.ts           [module 1] running one agent: spawn agentiscode (→ claude -p), unified JSON events, retry, stall, abort
  script/                    [module 2] loading and running a script
    parse.ts                   extract meta (pure literal), validation, TS strip, wrapping into an async function
    worker.ts                  vm context with the globals (agent/parallel/pipeline…), determinism guards
    host.ts                    runScript(): worker ↔ main thread (RPC), abort, SAB budget
  engine/                    [module 3] run orchestration
    engine.ts                  runWorkflow(): semaphore, journal, resume, budget, events, run dir
    journal.ts, store.ts       writing/reading runs/<id>/*, cache keys
    discovery.ts               finding a workflow by name
  cli/                       [module 4] CLI
    cli.ts, render.ts, commands/*  run | resume | status | list | logs | validate | types | skill install | init
skills/ultracode-workflow/   [module 5] authoring skill for Claude (SKILL.md + references)
examples/*.workflow.ts       [module 5] real examples
types/workflow.d.ts          public API contract for scripts
test/                        node:test; fake `claude` in test/fixtures/fake-claude.mjs
```

### Flow of one run

1. CLI → `runWorkflow(opts)`; the engine finds the script, `parseScript()` (meta + diagnostics), creates `runs/<runId>/`.
2. `runScript()` starts the worker; in the vm context the script body runs with the globals. `agent()` in the worker → RPC `ScriptHooks.agent` on the main thread.
3. Engine: cache lookup (resume) → semaphore → `runClaude()` → journal + events → result back to the worker.
4. `parallel`/`pipeline`/`phase`/`log`/`workflow` live in the worker (plain JS on top of `agent()`), `budget` reads the SAB.
5. End: `result.json`, `run.json`, `run_end` event; the CLI prints JSON to stdout.

### Run directory `<cwd>/.ultracode/runs/<runId>/`

```
run.json            metadata + state + totals (updated continuously, atomic write)
script.ts           copy of the executed script
args.json           input
options.json        run options (model, effort, limits…) — `resume` inherits them, because model/effort are in the cache key
events.jsonl        append-only RunEvent (see types.ts)
journal.jsonl       one line per COMPLETED agent: {key, seq, ok, label, result, usage, costUsd, sessionId, ts}
result.json         return value of the script
.lock               only while running: {pid, ts}; a lock against a concurrent `resume` (the lock of a dead pid is overwritten)
agents/<id>/        prompt.txt, stream.jsonl, stderr.txt, result.json   (id = start order, 1..N)
```

`runId` = `wf_<8 hex>-<3 hex>` (as in Claude Code).

### Agent call (one agent)

```
agentiscode --adapter claude --json
       --permission-mode bypassPermissions --disallowed-tools Workflow[,…]
       [--model M] [--effort E]
       --extra-args-json '["--no-session-persistence", "--append-system-prompt", "<default+custom>",
                          ["--json-schema", "<schema>"], ["--allowedTools", "…"], ["--max-budget-usd", "X"]]'
prompt on stdin;  env: CLAUDE_CODE_DISABLE_WORKFLOWS=1
```
agentiscode runs `claude -p --output-format stream-json --verbose …` and prints unified JSON Lines events
(`session`, `text`, `reasoning`, `tool`, `step`, `api_retry`, `stderr`, `error`, `result`). The result = the `result` event
(`result`, `structured_output`, `usage`, `cost_usd`, `session_id`, `num_turns`, `is_error`, `subtype`, `api_error_status`);
`synthetic: true` marks a result computed by agentiscode when claude produced none. Every agent event is also streamed live
as `agent_event` by `ultracode run --json`.

## Scope of v1 / out of scope

V1: everything above. **Out of v1** (in the "Next steps" section of `README.md`): worktree isolation, pause/restart of an individual agent,
TUI/web dashboard, prompt-cache staggering, waiting for the usage limit, Agentis YAML integration, `agentType` (custom subagents).
