---
name: workflows
description: Write JavaScript orchestration programs for the `workflow` tool — the sandbox API (phase/agent/parallel/args), profiles, budgets and limits, and the patterns it exists for (map-reduce over runtime-discovered sets, escalate-on-failure, review-fix-re-review loops, consensus with tie-break). Use when a multi-agent job's shape depends on results not yet available; use the `subagent` tool with `tasks` for a fixed set instead.
---

# Workflows

`workflow` runs a multi-phase orchestration program **you write in JavaScript**. Each
`agent()` call executes through the subagent runner, so children inherit worktree
isolation, budgets, profiles and structured output.

## Use it only when the shape is dynamic

This is the decision that matters. If you know the task list up front, `subagent` with
`tasks` is simpler, cheaper, and easier to debug. Reach for `workflow` only when control
flow depends on results you do not have yet:

- **map-reduce over a runtime-discovered set** — one agent finds the modules, then you fan
  out over however many it found
- **escalate on failure** — cheap model first, stronger model only if it fails
- **review → fix → re-review loops** — iterate until a reviewer is satisfied
- **consensus with a tie-break** — N opinions, then a decider when they disagree

If you catch yourself writing a workflow with a hardcoded list of independent tasks, stop
and use `subagent` instead.

## Sandbox API

The `script` is a **function body, not a module**. Top-level `await` works. No imports, no
`require`, no `fs`, no network — the script orchestrates, the children do the real work.

```
phase(title)                        mark progress (shows in the live widget)
await agent(prompt, options?)       run one child; resolves {ok, output, structured?, error?}
await parallel([() => agent(...)])  run thunks concurrently, max 4
args                                the JSON you passed as `args` (a JSON *string* param)
return value                        becomes the tool result; must be JSON-serializable
```

**`agent()` never throws.** It resolves `{ ok: false, error }` on failure, so branch on
`ok` — do not wrap calls in try/catch and expect to catch a failed child.

**Every `agent()` call must be awaited.** `parallel()` takes _thunks_ (`() => agent(...)`),
not already-started promises.

`agent()` options: `{ label, phase, model, thinking, profile, schema }`. Pass `schema` (a
JSON Schema) to get validated `structured` output back instead of parsing prose.

## Defaults and limits

Defaults per agent call: model `openrouter/moonshotai/kimi-k2.6`, thinking `medium`,
profile `explore`. Set `model` and `thinking` deliberately — use
`openrouter/x-ai/grok-4.5` for implementation, hard debugging, synthesis, or consequential
review.

| Limit                  | Value  |
| ---------------------- | ------ |
| agent calls per run    | 32     |
| concurrency            | 4      |
| turns per agent        | 20     |
| cost per agent         | $0.50  |
| timeout per agent      | 10 min |
| whole workflow timeout | 45 min |

Exceeding the call budget fails the run. **There is no resume** — a failed workflow is
re-run from the start, so keep runs modest and return partial findings rather than losing
everything at call 31.

Valid `thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
Valid `profile`: `explore`, `review`, `general`.

## Profiles and writers

`explore` and `review` are read-only (`read`/`grep`/`find`/`ls`). `general` can write, and
**each writer automatically gets its own git worktree** — parallel writers cannot corrupt
each other.

A writer's edits therefore land on a branch, not in the working directory. The result
records the branch; use `subagent` `action: "diff"` / `"apply"` afterwards to inspect and
land the work. A workflow that writes does not leave changes in your checkout.

## Pattern: map-reduce over a discovered set

```js
phase("discover");
const found = await agent(
  "List every file under src/ that defines a React hook. Return one path per line, nothing else.",
  {
    label: "discover",
    model: "openrouter/moonshotai/kimi-k2.6",
    thinking: "low",
    schema: {
      type: "object",
      required: ["paths"],
      properties: { paths: { type: "array", items: { type: "string" } } },
    },
  },
);
if (!found.ok) return { error: "discovery failed", detail: found.error };

const paths = (found.structured?.paths ?? []).slice(0, 20);

phase("audit");
const audits = await parallel(
  paths.map(
    (p) => () =>
      agent(`Audit ${p} for missing dependency-array entries. Cite line numbers.`, {
        label: `audit ${p}`,
        model: "openrouter/moonshotai/kimi-k2.6",
        thinking: "medium",
      }),
  ),
);

phase("summarize");
const summary = await agent(
  "Merge these audits into one prioritized list:\n\n" +
    audits
      .filter((a) => a.ok)
      .map((a) => a.output)
      .join("\n---\n"),
  { label: "summarize", model: "openrouter/x-ai/grok-4.5", thinking: "high" },
);

return { audited: paths.length, failed: audits.filter((a) => !a.ok).length, summary: summary.output };
```

Note the guards: cap the fanout so a large discovery cannot blow the 32-call budget, and
filter `ok` before folding outputs.

## Pattern: escalate on failure

```js
phase("cheap attempt");
let result = await agent(prompt, {
  label: "cheap",
  model: "openrouter/moonshotai/kimi-k2.6",
  thinking: "medium",
});

if (!result.ok) {
  phase("escalate");
  result = await agent(prompt, { label: "strong", model: "openrouter/x-ai/grok-4.5", thinking: "high" });
}
return { ok: result.ok, output: result.output };
```

## Pattern: review → fix → re-review

```js
let verdict = null;
for (let round = 1; round <= 3; round++) {
  phase(`round ${round}`);
  const review = await agent(
    `Review ${args.path} for correctness. End with VERDICT: PASS or VERDICT: FAIL.`,
    { label: `review ${round}`, profile: "review", model: "openrouter/x-ai/grok-4.5", thinking: "high" },
  );
  if (!review.ok) return { error: review.error, round };
  if (review.output.includes("VERDICT: PASS")) {
    verdict = "pass";
    break;
  }

  const fix = await agent(`Address this review of ${args.path}:\n\n${review.output}`, {
    label: `fix ${round}`,
    profile: "general",
    model: "openrouter/x-ai/grok-4.5",
    thinking: "high",
  });
  if (!fix.ok) return { error: fix.error, round };
}
return { verdict: verdict ?? "unresolved after 3 rounds" };
```

Always bound the loop. An unbounded review cycle will hit the 32-call budget and fail the
whole run.

## Passing input

`args` is a **JSON string** parameter, exposed to the script as the parsed value. Use it
instead of interpolating data into the script text.

## After the run

Artifacts land in `~/.pi/agent/workflows/<runId>/` and survive the session. `/workflows`
lists recent runs with their agent counts and failures. The tool result includes the
returned value plus a per-agent record — model, phase, ok, output size, and any worktree
branch.

Because children are headless and cannot ask the user, resolve ambiguity **before**
starting a workflow, not inside it.
