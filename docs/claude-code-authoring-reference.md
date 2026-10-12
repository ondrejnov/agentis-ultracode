# Reference rules for writing workflows (excerpt from Claude Code `workflow-authoring` + docs)

Source of truth for the semantics that our runtime imitates. Claude Code scripts are JS; ours are TS, otherwise 1:1.

## Script shape

```js
export const meta = {            // PURE LITERAL: no variables, calls, spread, templates with ${}
  name: 'find-flaky-tests',      // required
  description: 'Find flaky tests and propose fixes',   // required, one sentence
  whenToUse: '…',                // optional
  phases: [                      // optional; title strings MUST exactly match phase('…')
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test', model: 'sonnet' },
  ],
}
phase('Scan')
const flaky = await agent('grep CI logs for retry markers', { schema: FLAKY_SCHEMA })
return flaky          // return value = run result (JSON)
```

The body is an async context: top-level `await` and `return` both work. No `import`/`import()`/`require`, no filesystem/shell
in the script (agents do that), and `Date.now()`/`Math.random()`/`new Date()` without an argument **throw** (they would break resume).
Pass the timestamp or randomness via `args`; for agents' randomness, vary the prompt/label by index.

## API

- `agent(prompt, opts?)` → string | object (with `schema`) | `null` (failure/abort). Opts: `label, phase, schema, model, effort, …`.
  Without a schema it returns the final text. With a schema the agent is forced to return a validated object.
- `pipeline(items, stage1, stage2, …)` → array of results; each item passes through the stages independently, **without a barrier**.
  A stage receives `(prevResult, originalItem, index)`. A stage that throws → the item is `null` and the remaining stages are skipped.
  A `null` is also passed to the next stage (if the previous stage RETURNED it) → handle it (`fixed ? … : 'FIXER FAILED'`).
- `parallel(thunks)` → BARRIER; a thunk that throws → `null`; the function never rejects. Always `.filter(Boolean)`.
- `phase(title)`, `log(message)`, `args`, `budget {total, spent(), remaining()}`, `workflow(nameOrRef, args)` (1 level of nesting).
- Limits: concurrency min(16, CPU-2); 1000 agents per run; 4096 items in one `parallel`/`pipeline`;
  schema: root `{type:'object', properties}`, `required ⊆ properties`; a contradictory schema throws an error before the agent starts.

## Default is pipeline(), barrier only when needed

A barrier (`await parallel(...)` between phases) is correct ONLY when stage N needs cross-context from all results of stage N-1:
dedup across the whole set before an expensive step, early exit when there are zero findings, a prompt that refers to "the other findings".
It is NOT a reason: "I need to flatten/filter it" (do it inside the stage), "the phases are conceptually separate", "cleaner code".

Smell test: `const a = await parallel(…); const b = transform(a); const c = await parallel(b.map(…))` — the middle
transformation does not need a barrier → rewrite as `pipeline(items, stageA, r => transform([r]).flat(), stageB)`.

## Quality patterns

- **Adversarial verify**: N independent skeptics per finding, each must refute it; it survives if at least a majority say "not refuted".
  `Default to refuted=true if uncertain.`
- **Perspective-diverse verify**: different lenses (correctness, security, perf, reproduction) instead of N identical ones.
- **Judge panel**: N independent attempts from different angles → parallel judges → synthesis from the winner + the best ideas from the others.
- **Loop-until-dry**: until K consecutive rounds return nothing new; dedup against ALL seen findings (not just the confirmed ones).
- **Multi-modal sweep**: parallel agents searching in different ways (by container, content, entity, time).
- **Completeness critic**: last agent: "what is missing — an unrun modality, an unverified claim, an unread source?"
- **No silent cuts**: when a workflow limits coverage (top-N, sampling), `log()` what it discarded.
- **Loop-until-budget**: `while (budget.total && budget.remaining() > 50_000) {…}` — always guard `budget.total`, otherwise `remaining()` is `Infinity`.
- Scale to the ask: "find bugs" → a couple of finders + 1 verification; "thorough audit" → more finders, 3–5 votes, synthesis.

## Resume

A run can be resumed: completed `agent()` calls with the same prompt/options immediately return the stored result,
the first changed/new one and everything after it run again. The same script + the same `args` → 100% cache hit.

## Practical prompt guidelines for subagents

A subagent is told that its final text IS the return value (not a message to a human) → it returns raw data.
For structure use `schema`, not text parsing. Put everything the agent needs into the prompt (agents do not share context),
the scope of the work (which files/area), what to return, and what NOT to do. In a fan-out, use partitions with no path overlap,
because the agents write to the same working tree.
