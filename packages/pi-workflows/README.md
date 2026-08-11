# @parke.dev/pi-workflows

Multi-phase multi-agent orchestration for the
[pi coding agent](https://pi.dev). You write a short JavaScript program; the
package runs it in a locked-down sandbox and fans each `agent()` call out to an
isolated child via
[`@parke.dev/pi-subagent`](https://www.npmjs.com/package/@parke.dev/pi-subagent)
(`@parke.dev/pi-subagent/sdk`).

|              | What it does                                                                |
| ------------ | --------------------------------------------------------------------------- |
| `workflow`   | start/status/wait/cancel/resume/rerun/list orchestration runs               |
| `/workflows` | overlay of live runs; `save` / `saved` / `cancel` subcommands               |
| `/workflow`  | run a saved workflow by name                                                |
| `/ultracode` | session policy: `on` / `off` / `status` (+ interactive `ultracode` keyword) |

Ships with a [`workflows` skill](skills/workflows/SKILL.md). Active and ready
run counts are also exposed through Pi's extension-status API for custom
footers such as `@parke.dev/pi-dashboard`; `/workflows` remains the detailed
inspector.

## Install

```bash
pi install npm:@parke.dev/pi-workflows
pi install npm:@parke.dev/pi-subagent
```

Requires a Node build that supports permission mode (`>=22.19.0`). The sandbox
**refuses to run** without `--permission`.

## When NOT to use this

If you already know the task list, use the `subagent` tool's `tasks` array.
Reach for `workflow` only when **control flow depends on results you do not have
yet** (map-reduce, escalate-on-failure, review→fix→re-review, consensus).

## Sandbox API

The `script` parameter is a **function body, not a module**. Top-level `await`
works. No `import`s, no `require`, no `fs`, no network.

```
phase(title)
await agent(prompt, options?)
await parallel([() => agent(...)])
await pipeline(items, item => agent(...))   // map a discovered collection
args                                         // structured invocation data
return value                                 // JSON-serializable tool result
```

**`agent()` never throws** — branch on `ok`. Every call must be awaited.
`parallel()` / `pipeline()` share the concurrency cap.

### Agent options

```ts
{
  label?, phase?, model?, thinking?, profile?, schema?,
  isolation?: "workflow" | "worktree",  // default workflow = shared lane
  maxTurns?, maxCost?, timeoutMs?, fallbackModels?
}
```

Per-call budgets are clamped to trusted config ceilings.

## Shared worktree lane

Iterative writer / reviewer / test agents share one **workflow-owned worktree**.
Writes on that lane are serialized; readers wait while a writer is active so
re-review sees the fix. Pass `isolation: "worktree"` for a genuinely independent
writer branch (orchestrator-managed).

## Background runs, journal, resume

Launches are **background by default** (`workflow.backgroundByDefault`, overridable
with `async: false`). The tool returns a run id immediately; completion is
delivered as a follow-up message. Actions: `status`, `wait`, `cancel`, `resume`,
`rerun`, `list`.

Each run writes an append-only journal under
`<agentDir>/workflows/runs/<runId>/`. Resume restarts the script and replays the
**contiguous completed prefix** of `agent()` calls (matched by request id +
hash of prompt/options). Source, args, and cwd must still match.

Session custom entries (`workflow-run-v1`) hold lightweight summaries; full
outputs stay in the artifact directory.

## Approval

There is **no** model-controlled `approved` flag. Interactive TUI confirms
launches; without UI the gate **fails closed** unless:

- `workflow.approval` is `"never"` in trusted config, or
- a saved workflow sets `defaults.preApproved: true`.

## Saved workflows

Name-based resolution only (never arbitrary paths):

```text
~/.pi/agent/workflows/definitions/<name>.workflow.json
.pi/workflows/<name>.workflow.json          # project, requires trust
```

```json
{
  "version": 1,
  "name": "audit-routes",
  "description": "Audit route handlers",
  "script": "phase(\"discover\");\n...",
  "defaults": { "size": "medium", "preApproved": false }
}
```

Invoke with `{ "name": "audit-routes", "args": { ... } }` or `/workflow audit-routes`.

## Ultracode

Thin policy layer — not a new model:

- Interactive keyword: prefix a prompt with `ultracode` (interactive source only).
- `/ultracode on|off|status` and `/ultracode size <small|medium|large|unrestricted>`.
- Session on → thinking `xhigh` (restored on off); `before_agent_start` injects
  orchestration guidance and size guidelines.
- Large-run warnings when the script appears to exceed `largeRunWarnAgents`.

## Configuration

Precedence: **defaults ← config file ← environment**.

| Field                 | Env                            | Default     | Meaning                      |
| --------------------- | ------------------------------ | ----------- | ---------------------------- |
| `defaultModel`        | `PI_WORKFLOW_MODEL`            | _unset_     | inherit parent session model |
| `defaultThinking`     | `PI_WORKFLOW_THINKING`         | `medium`    |                              |
| `defaultProfile`      | `PI_WORKFLOW_PROFILE`          | `explore`   |                              |
| `agentMaxTurns`       | `PI_WORKFLOW_AGENT_MAX_TURNS`  | `20`        |                              |
| `agentMaxCost`        | `PI_WORKFLOW_AGENT_MAX_COST`   | `0.5`       |                              |
| `agentTimeoutMs`      | `PI_WORKFLOW_AGENT_TIMEOUT_MS` | `600000`    |                              |
| `workflowTimeoutMs`   | `PI_WORKFLOW_TIMEOUT_MS`       | `2700000`   |                              |
| `maxAgentRequests`    | `PI_WORKFLOW_MAX_AGENTS`       | `32` (≤200) | hard cap                     |
| `maxConcurrency`      | `PI_WORKFLOW_MAX_CONCURRENCY`  | `4` (≤16)   | hard cap                     |
| `approval`            | `PI_WORKFLOW_APPROVAL`         | `auto`      | `auto` / `always` / `never`  |
| `backgroundByDefault` | `PI_WORKFLOW_BACKGROUND`       | `true`      |                              |
| `defaultSize`         | `PI_WORKFLOW_SIZE`             | `medium`    | ultracode guideline          |
| `largeRunWarnAgents`  | `PI_WORKFLOW_LARGE_WARN`       | `15`        | advisory warning threshold   |

## Example

```js
phase("discover");
const found = await agent("List hook files under src/", {
  label: "discover",
  schema: {
    type: "object",
    required: ["paths"],
    properties: { paths: { type: "array", items: { type: "string" } } },
  },
});
if (!found.ok) return { error: found.error };

const paths = (found.structured?.paths ?? []).slice(0, 20);
phase("audit");
const audits = await pipeline(paths, (p) => agent(`Audit ${p}`, { label: `audit ${p}`, profile: "review" }));

return {
  audited: paths.length,
  failed: audits.filter((a) => !a.ok).length,
  summary: audits.filter((a) => a.ok).map((a) => a.output),
};
```

## License

MIT
