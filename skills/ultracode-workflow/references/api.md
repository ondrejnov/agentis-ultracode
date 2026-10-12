# Workflow script API — full description

Applies to `*.workflow.ts` (and `.js`) run via `ultracode run`. Types are in `types/workflow.d.ts`
(`ultracode types` writes them as `.ultracode/workflow.d.ts`). The script has no imports; everything below is a global.

## Contents

1. Script shape
2. `meta`
3. `agent()` — options, return values, failures
4. `parallel()` and `pipeline()`
5. `phase()`, `log()`, `console`
6. `args`
7. `budget`
8. `workflow()`
9. Environment and determinism
10. Limits
11. Error states and their source
12. The `null` convention
13. Cache and resume
14. What is not supported

---

## 1. Script shape

```ts
/// <reference path="../workflow.d.ts" />

export const meta = { name: 'x', description: 'Example of the script shape' }   // 1) meta (first statement)

phase('Scan')                                                            // 2) body: top-level await
const r = await agent<{ count: number }>('Count the files in src/ and return the count.', {
  schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
})
return { count: r ? r.count : null }                                     // 3) return value = run result (JSON)
```

- The body is an `async` function: use top-level `await` and `return`.
- Only one `export` is allowed: `export const meta`. Any other `export`, `import`, `import()`, `require()` is an
  error during validation.
- TypeScript must be only "erasable": types, `interface`, `type`, `as`, `satisfies`, generics. Not `enum`,
  `namespace`, parameter properties, `import x = require()`.
- `return` is the run result; it must be serializable to JSON (`undefined` → `null`).

## 2. `meta`

```ts
export const meta = {
  name: 'find-flaky-tests',          // required: [A-Za-z0-9][A-Za-z0-9_.-]*
  description: 'Find flaky tests',   // required, non-empty, one sentence
  whenToUse: 'When to use the workflow',  // optional
  phases: [                          // optional
    { title: 'Scan', detail: '…' },  // title required; detail, model optional
    { title: 'Fix', detail: '…', model: 'sonnet' },
  ],
}

phase('Scan')
phase('Fix')
```

| Rule | Consequence when violated |
| --- | --- |
| pure literal (no variables, calls, spread, templates with `${}`) | validation error |
| `name` and `description` are strings | validation error |
| after the object only `as const`, `satisfies T`, `;` may follow | validation error |
| first statement of the script (only comments before it) | warning |
| unknown key in `meta` / `meta.phases[i]` | warning, the key is ignored |
| `phase('X')` or `phase: 'X'` with a title that is not in `meta.phases` | warning |
| a title in `meta.phases` that the script never uses | warning (not reported if a dynamic `phase(variable)` exists somewhere) |
| duplicate title in `meta.phases` | warning |

`meta.phases[i].model` is informational (it is displayed); the actual model is set by `agent({ model })`.
The workflow name = `meta.name`; the file is looked up by file name (`<name>.workflow.ts`), so keep them identical.

## 3. `agent(prompt, opts?)`

```ts nocheck
declare function agent<T = any>(prompt: string, opts: AgentOptions & { schema: Schema }): Promise<T | null>
declare function agent(prompt: string, opts?: AgentOptions): Promise<string | null>
```

Starts one agent (a `claude -p` process) and waits for it to finish.

- **Without `schema`:** returns the agent's final text (`string`).
- **With `schema`:** the agent is forced to return structured output; returns a validated object.
- **`null`:** the agent failed after all attempts, or the run was aborted. See section 12.
- **Exception:** only a script error — invalid prompt/option/schema, exceeded budget or agent limit.

### Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `label` | string | first line of the prompt (60 characters) | label in the log, `status`, events; not part of the cache key |
| `phase` | string | current `phase()` | explicit phase; **inside `pipeline`/`parallel` always use `phase:`**, the global `phase()` is overwritten between concurrent tasks |
| `schema` | JSON Schema | — | structured output; see below |
| `model` | string | from `--model`, otherwise the claude model | alias (`sonnet`, `opus`, `haiku`) or full name; preferably do not set it |
| `effort` | `'low'\|'medium'\|'high'\|'xhigh'\|'max'` | from `--effort`, otherwise default | reasoning level |
| `cwd` | string | run cwd (`--cwd`) | agent's working directory; relative to the run cwd; must exist |
| `tools` | string[] | — | **a real whitelist** (`--allowedTools`, e.g. `['Read','Grep','Bash(git diff:*)']`): an agent with `tools` runs in `--permission-mode dontAsk`, so anything not on the list is rejected (including MCP tools and `Skill`; list them if they should be available). Read tools inside cwd are always allowed |
| `disallowedTools` | string[] | — | `--disallowedTools`; **really disables** tools (e.g. `['Edit','Write','NotebookEdit']`). `Workflow` is always disabled |
| `systemPrompt` | string | — | added AFTER the default subagent system prompt (`--append-system-prompt`) |
| `stallMs` | number > 0 | 600 000 | silence in the output after which the agent is killed and retried |
| `timeoutMs` | number > 0 | none | hard limit on the length of one attempt; after it, failure without retry |
| `maxUsd` | number > 0 | — | spending cap for one agent (`--max-budget-usd`); with `--max-usd` it is limited to the remaining budget |
| `noCache` | boolean | `false` | on resume, do not take the stored result of this call |

**Unsupported** options (`isolation`, `agentType`) are rejected by `agent()` with a `TypeError`. Unknown options are
ignored with a warning in the log.

### Default agent behavior

- It runs as `agentiscode --adapter claude --json --permission-mode bypassPermissions --disallowed-tools Workflow,…`
  which starts `claude -p --no-session-persistence …` (with the `tools` option instead `--permission-mode dontAsk`
  and `--allowedTools …`), the prompt goes to stdin, and the environment has `CLAUDE_CODE_DISABLE_WORKFLOWS=1`.
- It inherits the project's `CLAUDE.md`, skills, and MCP from `cwd` (`--bare` is not used).
- Default system prompt: the final message is returned to the script, not to a human; return only data and ask nothing; stay within the given scope.
- Attempts: up to 3 on a stall (`stallMs`), a transient API error (408/409/425/429/5xx, network errors, overload), or exit without a result (not when the usage limit is exhausted, the login is invalid, or the prompt is too long); the delay is `ULTRACODE_RETRY_BACKOFF_MS × attempt` (default 2 s). If the schema is not met, one retry.
  No retry: exceeded `timeoutMs`, exceeded `maxUsd`, exhausted turns, abort.

### Schema

- Root `{ type: 'object', properties: {…} }`.
- `required` ⊆ `properties` at every level; `required` keys are not repeated.
- `type` only from `string|number|integer|boolean|object|array|null`; `enum` non-empty.
- `additionalProperties: false` must not conflict with `required`.
- Recommendation (not enforced): flat structure, `enum` for verdicts, short `description` on unclear fields,
  no `$ref`/`oneOf`, `required` only for what the agent surely knows.
- A violation = `TypeError` from `agent()` **before** the agent starts (nothing is billed).
- An agent that does not return structured output even on the second attempt gives `null`.

## 4. `parallel()` and `pipeline()`

### `parallel(thunks)` — BARRIER

```ts
const items = ['a.ts', 'b.ts']
const S = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }

const results = await parallel(items.map((it) => () => agent<{ ok: boolean }>(`Check ${it}`, { schema: S })))
const ok = results.filter((r): r is { ok: boolean } => r !== null)
log(`${ok.length}/${items.length} done`)
```

- Runs all thunks concurrently and waits for all of them. The result has the order of the input.
- A thunk that throws (or whose `agent()` throws) gives `null`; the error is logged (the first 10).
- It never rejects because of a thunk error; it rejects only for incorrect use (`TypeError` when it is not an array,
  `RangeError` above the item limit).
- An already-resolved `Promise` instead of a thunk is tolerantly awaited, but the thunk is the correct form (it controls the moment of start).
- The number of concurrently running agents is limited globally (see limits), not by the number of thunks.

### `pipeline(items, stage1, stage2, …)` — the default choice

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

- Each item passes through the stages **independently**; item A may be in stage 3 while B is in stage 1.
  Time = the slowest single chain, not the sum of the slowest stages.
- A stage receives `(previousResult, originalItem, index)`; the first stage receives `(item, item, index)`.
- **A stage that throws:** the item is `null` in the result and the remaining stages are skipped for it.
- **A stage that returns `null`** (typically a failed `agent()`): `null` is passed to the next stage as `prev` →
  handle it (`prev ? … : null`).
- The result is an array in the same order as `items`; `null` at a position = the item failed.
- A stage may be `async` and call `parallel()` inside (e.g. N skeptics for one finding).

### When a barrier, when a pipeline

A barrier (`await parallel` between phases) is correct only when stage N needs cross-context from **all**
results of stage N−1: dedup across the whole set before an expensive step, early exit when there are zero findings, a prompt
referring to "the other findings". It is not a reason: "I need to flatten/filter" (do it inside the stage), "the phases are conceptually
separate", "cleaner code". Smell test: `a = await parallel(...); b = transform(a);
c = await parallel(b.map(...))` — the middle transformation does not need a barrier.

## 5. `phase()`, `log()`, `console`

- `phase(title)` — starts a phase; the following `agent()` calls without `opts.phase` are filed under it. The title is
  a non-empty string and should be in `meta.phases`. The phase is per (nested) workflow; a child inherits the parent's phase until it calls `phase()` itself.
- `log(message)` — a message for the user (stderr + `events.jsonl`). Non-strings are serialized (JSON).
- `console.log/info/debug` = `log`; `console.warn/error` add the prefix `[warn]`/`[error]`.

## 6. `args`

The value from `--args '<json>'` / `--args-file`, as real JSON (an array is an array, not a string). `undefined`
if none was given. For `resume`, the stored `args` are used unless you provide new ones. Validate them at the start of the script and
throw a clear error (`throw new Error('Missing args.question')`) — the run then fails immediately and cheaply.

## 7. `budget`

```ts
budget.total          // number | null   output token cap (--max-tokens), null = no limit
budget.totalUsd       // number | null   USD cap (--max-usd)
budget.spent()        // output tokens spent in the run (including nested workflows)
budget.remaining()    // max(0, total - spent()), Infinity without a limit
budget.spentUsd()
budget.remainingUsd() // Infinity without a limit
```

- **Output** tokens and `total_cost_usd` reported by agents are counted. Values are updated when an agent finishes.
- The cap is hard: once reached, every further `agent()` throws an error with `code === 'BUDGET_EXCEEDED'` and the run
  is marked `budgetExceeded`. Agents already running finish (their `--max-budget-usd` is limited by the remaining USD).
- Always guard loops with `budget.total` — without a limit `remaining()` is `Infinity` and the loop would run up to the
  1000-agent limit: `while (budget.total && budget.remaining() > 50_000) { … }`.

## 8. `workflow(nameOrRef, args?)`

```ts
const sub = await workflow('review-changes', { base: 'main' })          // by name
const sub2 = await workflow({ scriptPath: '/abs/path/x.workflow.ts' })  // by path
```

- Runs another script inline and returns its return value. It shares concurrency, the agent counter,
  the budget, and run cancellation.
- `args` become the child's `args` global. The child is validated the same way as the root (invalid → error).
- **Nesting only one level deep**: `workflow()` inside a child throws an error.
- An unknown name / unreadable path / syntax error in the child throws — catch with `try/catch` if you want to continue.
- In the log and `status`, the child's agents are grouped under its name.

## 9. Environment and determinism

Available: standard JS (`JSON`, `Math` except `random`, `Array`, `Object`, `Map`, `Set`, `Promise`, `RegExp`,
`Intl`, …), `console`, the runtime globals. Not available: `process`, `require`, `fetch`, `setTimeout`, FS, `eval`,
`new Function`.

| Forbidden | Behavior |
| --- | --- |
| `Date.now()` | throws `DeterminismError` (a warning already during validation) |
| `Math.random()` | throws `DeterminismError` |
| `new Date()` without an argument, `Date()` | throws `DeterminismError` |
| `new Date(x)`, `Date.parse`, `Date.UTC` | allowed |

Reason: resume must reach the same calls for the same script and input. Pass the time via `args`
(`args.today`); make "randomness" from the index (`variants[i % variants.length]`).

## 10. Limits

| Limit | Value | Override |
| --- | --- | --- |
| concurrent agents | `min(16, max(1, CPU − 2))` | `--concurrency`, `ULTRACODE_MAX_CONCURRENCY` |
| agents per run | 1000 | `--max-agents` |
| items in one `parallel`/`pipeline` | 4096 | — (split into batches) |
| `workflow()` depth | 1 | — |
| tokens / USD | no limit | `--max-tokens`, `--max-usd` |
| attempts per agent | 3 (schema +1) | — |
| `stallMs` | 600 000 ms | `agent({ stallMs })` |

Agents above the concurrency limit wait in a queue; a batch of 100 items therefore completes, just not all at once.

## 11. Error states and their source

| Situation | How it shows up |
| --- | --- |
| invalid script (meta, syntax, import…) | `ultracode validate` exit 2; `run` exit 2, the run does not start |
| unknown workflow | exit 2 (`WORKFLOW_NOT_FOUND`) |
| invalid schema / option / prompt | `agent()` throws `TypeError`; the script crashes unless caught |
| agent failed after all attempts | `agent()` returns `null`; `totals.failedAgents`++; event `agent_done` with `error` |
| abort (Ctrl+C, SIGTERM) | agents are killed including their children; the run is `aborted`, exit 130; `agent()` returns `null` |
| exhausted budget / agent limit | `agent()` throws error `BUDGET_EXCEEDED`; in `parallel`/`pipeline` it becomes `null` |
| exception in the script | run `failed`, exit 1, `error` in `run.json`; completed agents are in the journal for resume |
| `DeterminismError` | same as an exception in the script |
| script waits on a Promise that is never resolved | error "Script stalled" |
| return value cannot be serialized to JSON | `TypeError`, run `failed` |

## 12. The `null` convention

`null` from `agent()` means "I have no result", **not** "nothing found". An empty result is an empty array
in the schema. Consequences:

1. Always test before accessing a property (`if (!r)`), and use `.filter(Boolean)` before using an array.
2. `parallel` and `pipeline` may return `null` at any position; likewise a stage receives `null` as `prev`.
3. A silent `.filter(Boolean)` loses information: compute `failed = total - ok.length`, log it, and return it.
4. Decisions that depend on completeness (a quorum of votes, "no findings") must be able to distinguish
   "nobody found anything" from "half of the agents failed". See the quorum in `examples/audit-routes.workflow.ts`.
5. A failure is different from a script error; do not confuse `null` with an exception, nor handle it with `try/catch` around `agent()`
   (an exception means a script error, not an agent failure).

## 13. Cache and resume

- Call key = `sha256(prompt, schema, model, effort, cwd, tools, disallowedTools, systemPrompt)` + the sequence number of
  the same key within the run. `label`, `phase`, `stallMs`, `timeoutMs`, `maxUsd` are not part of the key; model and effort
  are the effective values (including `--model`/`--effort`).
- Only **successful agents** are written to the journal. Failed ones are run again on resume.
- Resume: an identical call → stored result (event `agent_done` with `cached: true`); otherwise it runs live.
  It is robust against a different completion order in `parallel`. If an upstream agent's result changes, the
  prompts of downstream agents change and they are run again.
- `ultracode resume <runId>` uses the copy of the script and `args` stored in the run; `ultracode run <name> --resume <runId>`
  uses the current script (code edited) and the stored `args`, unless you provide new ones.
- To recompute the result of a specific call, give it `noCache: true`.
- A prompt that always contains different text (time, random ID, unsorted listing) invalidates the cache.
  Sort input lists (`.sort()`) before putting them into the prompt.

## 14. What is not supported

`isolation: 'worktree'`, `agentType`, input during the run (an agent cannot ask), pausing/restarting a single
agent, TUI/web dashboard, waiting for the usage limit (the agent fails → `null`), staggering of the prompt cache, nesting
`workflow()` deeper than 1, access to files and the shell from the script. For solutions see section 10 of `SKILL.md`.
