# @parke.dev/pi-workflows

Multi-phase multi-agent orchestration for the
[pi coding agent](https://pi.dev). You write a short JavaScript program; the
package runs it in a locked-down sandbox and fans each `agent()` call out to an
isolated child via
[`@parke.dev/pi-subagent`](https://www.npmjs.com/package/@parke.dev/pi-subagent).

One tool and one command:

|              | What it does                                                              |
| ------------ | ------------------------------------------------------------------------- |
| `workflow`   | run a user-authored orchestration script (`phase` / `agent` / `parallel`) |
| `/workflows` | list recent runs and where their artifacts landed                         |

Ships with a [`workflows` skill](skills/workflows/SKILL.md) that teaches the
model the sandbox API, the patterns this exists for, and — critically — when
**not** to use it.

## Install

```bash
pi install npm:@parke.dev/pi-workflows
pi install npm:@parke.dev/pi-subagent
```

`@parke.dev/pi-subagent` is a real dependency: every `agent()` call is executed
through its orchestrator, so children inherit worktree isolation, budgets,
profiles, and structured output. The package is resolved with
`createRequire` against its `package.json` (so a local `node_modules`, a
workspace symlink, or a global install all work). To point at a checkout that is
not installed as a dependency at all, set `PI_SUBAGENT_SRC` to that package's
root.

### Node permission mode required

The sandbox spawns the script under Node's `--permission` flag and **refuses to
run without it**. If the runtime does not advertise
`process.allowedNodeEnvironmentFlags.has("--permission")`, the tool rejects
with an error rather than executing untrusted code unprotected.

You need a Node that supports permission mode (the package engines field asks
for `>=22.19.0`). If your Node is too old, upgrade it — there is no fallback
path.

## When NOT to use this

If you already know the task list, use the `subagent` tool's `tasks` array
instead. It is simpler, cheaper, and easier to debug.

Reach for `workflow` only when **control flow depends on results you do not have
yet**:

- map-reduce over a set discovered at runtime
- escalate to a stronger model only after a cheap one fails
- review → fix → re-review loops
- consensus with a tie-break

A workflow whose script hardcodes a fixed list of independent tasks is the
wrong shape — stop and use `subagent` instead.

## Sandbox API

The `script` parameter is a **function body, not a module**. Top-level `await`
works. There are **no** `import`s, no `require`, no `fs`, no network — the script
orchestrates; the children do the real work.

```
phase(title)                        mark progress (shown in the live widget)
await agent(prompt, options?)       run one child agent
await parallel([() => agent(...)])  run thunks concurrently (capped)
args                                the JSON you passed as `args`
return value                        becomes the tool result (JSON-serializable)
```

**`agent()` never throws.** It always resolves a result object:

```ts
{ ok: boolean, output: string, structured?: unknown, error?: string }
```

Branch on `ok`. Do not wrap calls in `try/catch` expecting a failed child to
throw.

**Every `agent()` call must be awaited.** `parallel()` takes _thunks_
(`() => agent(...)`), not already-started promises.

`agent()` options: `{ label, phase, model, thinking, profile, schema }`. Pass
`schema` (a JSON Schema) to get validated `structured` output back. Profiles
`explore` and `review` are read-only; `general` can write, and each writer gets
its own git worktree so parallel writers cannot corrupt each other.

There is **no resume**. A failed workflow is re-run from the start, so keep runs
modest and return partial findings rather than blowing the call budget at step 31.

## Configuration

Everything is optional. Precedence is **defaults ← config file ← environment**.

| Field               | Env var                        | Default            | Meaning                                                                                                                                                      |
| ------------------- | ------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `defaultModel`      | `PI_WORKFLOW_MODEL`            | _unset_            | model for `agent()` calls that do not name one. Unset means **inherit the parent session model** — deliberate, so the package stays portable across installs |
| `defaultThinking`   | `PI_WORKFLOW_THINKING`         | `medium`           | thinking level when unset on the call (`off` / `minimal` / `low` / `medium` / `high` / `xhigh`)                                                              |
| `defaultProfile`    | `PI_WORKFLOW_PROFILE`          | `explore`          | profile when unset on the call (`explore` / `review` / `general`)                                                                                            |
| `agentMaxTurns`     | `PI_WORKFLOW_AGENT_MAX_TURNS`  | `20`               | turn ceiling per child                                                                                                                                       |
| `agentMaxCost`      | `PI_WORKFLOW_AGENT_MAX_COST`   | `0.5`              | dollar ceiling per child                                                                                                                                     |
| `agentTimeoutMs`    | `PI_WORKFLOW_AGENT_TIMEOUT_MS` | `600000` (10 min)  | wall-clock ceiling per child                                                                                                                                 |
| `workflowTimeoutMs` | `PI_WORKFLOW_TIMEOUT_MS`       | `2700000` (45 min) | wall-clock ceiling for the whole run                                                                                                                         |
| `maxAgentRequests`  | `PI_WORKFLOW_MAX_AGENTS`       | `32`               | hard cap on `agent()` calls per run (max 200)                                                                                                                |
| `maxConcurrency`    | `PI_WORKFLOW_MAX_CONCURRENCY`  | `4`                | hard cap inside `parallel()` (max 16)                                                                                                                        |

`defaultModel` being unset is the one to notice: a workflow that never names a
model uses whatever the parent session is already on, so the same script works
for users with different default models.

## Example: map-reduce over a discovered set

```js
phase("discover");
const found = await agent(
  "List every file under src/ that defines a React hook. Return one path per line, nothing else.",
  {
    label: "discover",
    thinking: "low",
    schema: {
      type: "object",
      required: ["paths"],
      properties: { paths: { type: "array", items: { type: "string" } } },
    },
  },
);
if (!found.ok) return { error: "discovery failed", detail: found.error };

// Cap the fanout so a large discovery cannot blow the 32-call budget.
const paths = (found.structured?.paths ?? []).slice(0, 20);

phase("audit");
const audits = await parallel(
  paths.map(
    (p) => () =>
      agent(`Audit ${p} for missing dependency-array entries. Cite line numbers.`, {
        label: `audit ${p}`,
        thinking: "medium",
      }),
  ),
);

phase("summarize");
const summary = await agent(
  "Merge these audits into one prioritized list:\n\n" +
    // Filter on ok — a failed child must not poison the fold.
    audits
      .filter((a) => a.ok)
      .map((a) => a.output)
      .join("\n---\n"),
  { label: "summarize", thinking: "high" },
);

return {
  audited: paths.length,
  failed: audits.filter((a) => !a.ok).length,
  summary: summary.output,
};
```

The two guards that keep this from becoming an unbounded spend: **cap the
fanout** after discovery, and **filter on `ok`** before folding outputs.

## Artifacts and inspection

Each run writes to `<agent dir>/workflows/<runId>/` (under the directory
returned by pi's `getAgentDir()`, so `PI_AGENT_DIR` and rebranded distributions
are respected). A typical run directory holds:

- `script.js` — the program that was executed
- `args.json` — the `args` payload, when one was passed
- `workflow.json` — run metadata, phases, per-agent records
- `result.json` — the script's return value, on success

`/workflows` lists the most recent runs with their labels, agent counts, and
failures. Artifacts survive the session, so a broken run is still inspectable —
but it is not resumable. Re-run it.

A writer's edits land on a worktree branch, not in the parent checkout. The tool
result records that branch; use the `subagent` tool's `diff` / `apply` actions
afterwards to inspect and land the work.

## License

MIT
