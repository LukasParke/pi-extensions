# @parke.dev/pi-subagent

Production-grade isolated subagents for [Pi](https://github.com/badlogic/pi-mono).

Delegate research, parallel exploration, and clean-context review to child Pi
processes. Named agent personas, cancellable background runs with completion
notifications and a live widget, mid-run steering, graceful budget wrap-ups,
automatic retry with model fallback, a stall watchdog, session resume and
context forking, worktree isolation with a diff/apply/discard loop, capability
profiles, a root/subagent/combined cost ledger, and a TUI inspector.

Subagents are intra-mission workers whose results return to the calling session. Use herdr instead when one agent must own a repo-level mission or PR stack, survive its dispatcher, and land external deliverables; use subagents within that herdr session for parallel legs, research, reviews, and bounded implementation. See the bundled [`subagent` skill](skills/subagent/SKILL.md) for the full split.

> **Breaking change:** every spawned task must now set `profile` explicitly (`explore`, `review`, or `general`) unless its named agent persona declares one. Existing prompts that omit it fail validation with selection guidance.

## Install

Pi packages install from **npm**, **git**, or a **local path**:

```bash
# npm (scoped; surfaces on the pi.dev gallery via the pi-package keyword)
# Note: unscoped "pi-subagent" is rejected by npm as too similar to "pi-sub-agent".
pi install npm:@parke.dev/pi-subagent

# pin a specific version
pi install npm:@parke.dev/pi-subagent@0.10.0

# npm is the supported package install path from the monorepo.
# For local development, install this workspace directly:
pi install /absolute/path/to/pi-extensions/packages/pi-subagent

# local checkout
pi install /absolute/path/to/pi-subagent
```

Then start Pi normally. The package registers:

- tools: `subagent`, `subagent_wait`
- command: `/subagents` (run inspector overlay)
- command: `/subagent-cost` (parent / subagent / combined usage on demand)
- command: `/btw` (side question, model-hidden)

Publishing is automated from package-scoped `pi-subagent-v*` tags — see
[docs/RELEASING.md](./docs/RELEASING.md).

## Quick usage

```ts
// Single foreground task
{ task: "Find all call sites of parseConfig and summarize patterns.", profile: "explore", description: "Map parseConfig usage" }

// Named agent — persona prompt + defaults from .pi/agents/reviewer.md.
// Explicit params still override any agent field.
{ task: "Review this diff for security issues", agent: "reviewer" }

// Parallel read-only explorers
{
  tasks: [
    { task: "Map auth middleware flow", profile: "explore", description: "Auth flow map" },
    { task: "List all env vars used in server/", profile: "explore", description: "Env var inventory" }
  ]
}

// Parallel research with automatic fan-in: one read-only child folds all
// outputs into a single brief, delivered first.
{
  tasks: [
    { task: "Audit backend error handling", profile: "review", description: "Backend audit" },
    { task: "Audit frontend error handling", profile: "review", description: "Frontend audit" }
  ],
  synthesis: "Merge both audits into one prioritized findings list"
}

// Background run — you are notified on completion (batched followUp message),
// a live widget tracks progress above the editor, and wait/status still work.
{ task: "Audit dependency licenses", profile: "review", async: true }
// later
{ action: "status", id: "abc123" }
{ action: "wait", id: "abc123" }      // interruptible; does not cancel
{ action: "cancel", id: "abc123" }

// Collecting a background run also has its own tool, for reflexive mid-flow
// use. Identical semantics to action:"wait" (same handler underneath).
// A timeout returns a still-running notice WITHOUT cancelling or consuming
// the run, so it stays collectable.
subagent_wait { id: "abc123" }
subagent_wait { id: "abc123", timeout_ms: 30000 }

// Dry-run a spawn request: full validation + preflights (git repo, fork
// session, output paths), returns the resolved per-task plan (model, tools,
// budgets, isolation) without spawning anything.
{ action: "plan", tasks: [{ task: "Implement feature A", profile: "general", isolation: "worktree" }] }

// Structured output: the child must end with a fenced json:result block
// matching the schema. Invalid output gets one automatic repair round;
// delivery is the clean JSON and details carry the parsed object.
{
  task: "Audit the auth module",
  profile: "review",
  output_schema: {
    type: "object",
    required: ["findings", "risk"],
    properties: {
      findings: { type: "array", items: { type: "string" } },
      risk: { type: "string", enum: ["low", "medium", "high"] }
    }
  }
}

// Fork the parent conversation into the child (needs a persisted session).
// The child starts from a branched copy of everything discussed so far.
{ task: "Implement the plan we agreed on", context: "fork", profile: "general" }

// Budgets with graceful wrap-up: at the limit the child is steered to produce
// a final answer and given grace turns before any hard stop.
{ task: "Audit deps", profile: "review", max_turns: 15, grace_turns: 2 }

// Automatic retry with model fallback on transient failures
// (provider errors, stalls, queue timeouts — never task-quality failures).
{ task: "Research X", profile: "explore", model: "openrouter/model-a", fallback_models: ["openrouter/model-b"], max_retries: 1 }

// Steer a running child mid-run instead of cancel + retry. The message is
// delivered after the current assistant turn, before the next LLM call.
{ action: "steer", id: "abc123", message: "Skip the tests directory; focus on src/" }
// Parallel runs: pass index to pick one live task.
{ action: "steer", id: "abc123", index: 1, message: "Wrap up now" }

// Resume a child session
{ task: "Continue from your findings and propose a fix plan", profile: "general", resume: "<session-id>" }

// Isolated writers
{
  tasks: [
    { task: "Implement feature A", profile: "general", isolation: "worktree" },
    { task: "Implement feature B", profile: "general", isolation: "worktree" }
  ]
}

// Close the worktree loop after the run finishes:
{ action: "diff", id: "abc123", index: 0 }     // inspect the patch
{ action: "apply", id: "abc123", index: 0 }    // land as uncommitted changes in your checkout
{ action: "discard", id: "abc123", index: 1 }  // drop worktree + branch
```

The `/subagents` overlay mirrors the worktree loop interactively: `s` steer,
`a` apply, `x` discard on the selected run.

## Side questions (`/btw`)

```
/btw does this repo have a rate limiter?
/btw                      # prompts for the question
```

`/btw` runs a one-off read-only subagent for _you_, not for the model. It uses
the same policy, budget, semaphore and process-lock machinery as any run, but
delivers its answer as a custom session entry, which does not participate in
LLM context. The main agent keeps working and never sees the question or the
answer — useful for checking something mid-task without derailing the
conversation or polluting the context window.

## Backends

Children can run on a different agent CLI. Everything else — worktrees, process
locks, depth limits, budgets, orphan reclaim — is backend-agnostic and applies
unchanged.

```ts
{ task: "Summarize this module", backend: "codex", profile: "explore" }
{ task: "Review this diff",      backend: "claude", profile: "review", max_cost: 0.50 }
```

Requires the corresponding CLI on PATH (`codex`, `claude`). Capabilities differ,
and **unsupported combinations are refused with an explanation rather than
silently ignored** — a dropped `max_cost` or unenforced read-only profile would
be a safety regression, not a minor degradation.

|                                 | `pi` (default) | `codex`                               | `claude`               |
| ------------------------------- | -------------- | ------------------------------------- | ---------------------- |
| `max_cost`                      | yes            | **refused** (reports tokens, no cost) | yes (`total_cost_usd`) |
| read-only profile               | tool allowlist | `--sandbox read-only` (OS-level)      | `--allowedTools`       |
| steering / graceful wrap-up     | yes            | **no** (no stdin channel)             | **no** (one-shot)      |
| `resume`                        | yes            | yes                                   | yes                    |
| `context:'fork'`, `fork_resume` | yes            | **refused**                           | yes                    |
| `thinking`                      | yes            | no                                    | no                     |
| `output_schema`                 | yes            | yes                                   | yes                    |

A budget breach on a backend without steering hard-stops instead of asking the
child to wrap up. Codex's read-only sandbox is enforced by the OS, which is
stronger than a tool allowlist.

Set a persona's backend in agent frontmatter with `backend: codex`.

## Profiles

Every task must choose a profile unless its named agent persona declares one. Pick for the task's strengths rather than habitually mirroring the parent.

| Profile | Best for | Capability |
| --- | --- | --- |
| `explore` | Fast recon/research on a cheap, quick model | Strictly read-only |
| `review` | Careful code review on a strong reading model | Strictly read-only |
| `general` | Implementation on a model suited to writing files/running commands | Inherits active tools; may write |

Parallel write-capable tasks sharing one checkout are rejected unless each uses
`isolation: "worktree"`, distinct `cwd`, or explicit `allow_shared_writes: true`.

## Configuration

Defaults can be overridden in `~/.pi/subagent.json` and per-field via env vars
(env wins over file):

| Setting                 | Env var                               | Default                               |
| ----------------------- | ------------------------------------- | ------------------------------------- |
| `maxTasksPerRun`        | `PI_SUBAGENT_MAX_TASKS`               | 8                                     |
| `maxActiveProcesses`    | `PI_SUBAGENT_MAX_ACTIVE`              | 4                                     |
| `maxQueuedTasks`        | `PI_SUBAGENT_MAX_QUEUED`              | 32                                    |
| `maxGlobalActive`       | `PI_SUBAGENT_MAX_GLOBAL_ACTIVE`       | 16                                    |
| `defaultTimeoutMs`      | `PI_SUBAGENT_TIMEOUT_MS`              | 900000                                |
| `maxDepth`              | `PI_SUBAGENT_MAX_DEPTH`               | 2                                     |
| `killGraceMs`           | `PI_SUBAGENT_KILL_GRACE_MS`           | 3000                                  |
| `sessionDir`            | `PI_SUBAGENT_SESSION_DIR`             | `~/.pi/subagent-sessions`             |
| `worktreeDir`           | `PI_SUBAGENT_WORKTREE_DIR`            | `~/.pi/subagent-worktrees`            |
| `lockDir`               | `PI_SUBAGENT_LOCK_DIR`                | `~/.pi/subagent-locks`                |
| `worktreeRetentionDays` | `PI_SUBAGENT_WORKTREE_RETENTION_DAYS` | 7 (accepted for compat; GC is lifecycle-based, not day-based) |
| `sessionRetentionDays`  | `PI_SUBAGENT_SESSION_RETENTION_DAYS`  | unset (accepted for compat; GC is lifecycle-based, not day-based) |
| `lockRetentionDays`     | `PI_SUBAGENT_LOCK_RETENTION_DAYS`     | 7                                     |
| `taskDefaults`          | —                                     | none                                  |
| `graceTurns`            | `PI_SUBAGENT_GRACE_TURNS`             | 2                                     |
| `stallAfterMs`          | `PI_SUBAGENT_STALL_AFTER_MS`          | 90000                                 |
| `stallKillAfterMs`      | `PI_SUBAGENT_STALL_KILL_AFTER_MS`     | 90000                                 |
| `maxRetries`            | `PI_SUBAGENT_MAX_RETRIES`             | 1                                     |
| `watchdog`              | `PI_SUBAGENT_WATCHDOG_WAKEUPS_WITHOUT_PROGRESS`, `PI_SUBAGENT_WATCHDOG_REPEATED_ACTION_RUNS` | `{ wakeupsWithoutProgress: 3, repeatedActionRuns: 3 }` |
| `widget`                | `PI_SUBAGENT_WIDGET`                  | `background` (`off` disables)         |
| `notifications`         | `PI_SUBAGENT_NOTIFICATIONS`           | `batched` (`off` disables)            |
| `progressThrottleMs`    | `PI_SUBAGENT_PROGRESS_THROTTLE_MS`    | 100 (min interval for streamed live-text progress; `0` disables) |
| `maxResultBytes`        | —                                     | 51200 (tool-result cap; file config only) |
| `maxResultLines`        | —                                     | 2000 (tool-result cap; file config only)  |
| `maxDetailsTextBytes`   | —                                     | 10240 (file config only)                  |
| `maxCompletedInMemory`  | —                                     | 20 (file config only)                     |
| (bin)                   | `PI_SUBAGENT_BIN`                     | auto (`process.execPath` + CLI entry) |

### Named agent files

Define reusable subagent personas as markdown files, discovered from the same
conventional roots skills use (higher root wins name conflicts):

| Priority | Location                                                                | Scope                       |
| -------- | ----------------------------------------------------------------------- | --------------------------- |
| 1        | `.pi/agents/<name>.md`                                                  | project (authoritative)     |
| 2        | `.agents/agents/<name>.md`                                              | shared cross-tool workspace |
| 3        | `$PI_CODING_AGENT_DIR/agents/<name>.md` (default `~/.pi/agent/agents/`) | global                      |

The markdown body becomes the child's appended system prompt; frontmatter
supplies defaults using the same snake_case names as the tool parameters:

```md
---
description: Security-focused code reviewer
model: openrouter/x-ai/grok-4.5
thinking: high
profile: review
max_turns: 20
fallback_models: [openrouter/backup-model]
spawns: false # or "*", "scout", "[reviewer, scout]"
---

You are a security auditor. Review code for injection flaws, auth issues,
and sensitive data exposure. Report findings with file:line evidence and
severity ratings.

@include shared/review-checklist.md
```

Agent files may also pin a structured contract with
`output_schema: {"type": "object", …}` (single-line inline JSON) or
`output_schema: @contract.json` (path relative to the agent file).

`spawns:` controls which agents a child of this persona may spawn:
`false` disables further nesting (no tool registered in that child),
`"*"` (or omit) is unrestricted, and a comma/bracket list is an allowlist
(agentless tasks are rejected under an allowlist). The policy is passed to
the child via `PI_SUBAGENT_SPAWNS` and enforced on each subsequent spawn.

Body lines that consist solely of `@include relative/path.md` expand that
file one level deep (relative to the agent file, same 64KB/symlink guards
as `@contract.json`). Missing or rejected includes leave the line verbatim;
includes do not recurse.

Invoke with `{ task: "…", agent: "reviewer" }`. Precedence per field:
**explicit request params > agent file > per-profile `taskDefaults` > parent
inheritance**. An explicit `system_prompt` appends after the persona body.
Profiles still enforce capability: an agent declaring `profile: review` with
write tools fails closed. The agent catalog is advertised in the tool's
system-prompt guidelines (session start) and in bare `status` output (live),
and file changes are picked up within seconds — no restart needed.

### Per-profile task defaults

`taskDefaults` in `~/.pi/subagent.json` supplies model/thinking/budget defaults
per capability profile. Explicit request values always win; profile defaults
beat parent-session inheritance. This is how you route all exploration to a
cheap model without naming agents:

```json
{
  "taskDefaults": {
    "explore": {
      "model": "openrouter/moonshotai/kimi-k2.6",
      "thinking": "medium",
      "maxTurns": 15,
      "maxCost": 0.25
    },
    "review": {
      "model": "openrouter/moonshotai/kimi-k2.6",
      "thinking": "medium"
    },
    "general": { "model": "openrouter/x-ai/grok-4.5", "thinking": "medium" }
  }
}
```

Each profile accepts `model`, `thinking`, `maxTurns`, `maxCost`, `timeoutMs`,
`fallbackModels`, and `maxRetries`. Invalid fields are dropped field-by-field.

Notes on behavior:

- `timeout_ms` covers queue time plus runtime, but timed-out tasks report
  `state: "timeout"` with `timeoutPhase: "queued"|"starting"|"running"` so
  agents can retry capacity issues without confusing them for task failures.
- Budget stops (`max_turns`, `max_cost`) trigger a **graceful wrap-up**: the
  child is steered to produce its final answer NOW and allowed `graceTurns`
  more turns before SIGTERM. Results end as `partial` with `wrappedUp: true`
  when the child concluded in time. `graceTurns: 0` restores immediate stops.
- A **stall watchdog** flags children with no protocol activity for
  `stallAfterMs` (a liveness probe distinguishes quiet-but-thinking from dead),
  then kills after `stallKillAfterMs` more silence — feeding automatic retry
  instead of burning the whole timeout.
- **Transient failures retry automatically** (queue timeouts, stalls, spawn
  errors, provider errors) up to `maxRetries` extra attempts, escalating
  through `fallback_models` when provided. Usage accumulates across attempts;
  results record `attempts` and `attemptedModels`. Task-quality failures
  (nonzero exit with complete protocol, cancellations, budget stops, running
  timeouts) never retry.
- **Keep-alive lifecycle**: a child extension (e.g. pi-sentinel) can signal
  live wakeup triggers with custom `keep-alive` messages on the RPC stream.
  A settle with triggers active parks the run in `waiting` (stdin stays open)
  instead of ending it; the child's next self-triggered turn flips it back to
  `running`. Runs complete when triggers exhaust and the child settles, when
  a sentinel gate reports ALL PASS, or via the usual budget/timeout/cancel
  paths. `steer` while waiting sends a `prompt` (fresh turn); mid-turn it
  sends a `steer`. One-shot children emit no keep-alive events and behave
  exactly as before.
- A **doom-loop watchdog** guards long-lived runs deterministically: a turn
  starting from `waiting` that changes no progress signal (tool-call sequence
  hash, output hash, worktree artifact hash) increments
  `wakeupsWithoutProgress`; an identical tool-call sequence
  `repeatedActionRuns` turns running trips the repeated-action detector. At
  either threshold the run is terminated and marked `paused`
  (`stopReason: "watchdog"`) with its session preserved — resume it with
  `resume: "<session id>"`. Soft warnings fire once at 50% and 80% of
  `max_cost` / `max_turns`. When `@parke.dev/pi-dispatch` is installed,
  warnings and pauses publish as info/escalation dispatch items; otherwise
  they fall back to nextTurn messages and the existing completion
  notification. Thresholds are set via the `watchdog` config object; `0`
  disables a detector.
- `context: "fork"` starts a single child from a real branched copy of the
  parent conversation (`--fork` on the parent's session file). It requires a
  persisted parent session, cannot combine with `resume`, and is rejected for
  parallel fanout (context duplication × N is a cost bug, not a feature).
- **Structured output** (`output_schema`): the contract is appended to the
  child's system prompt; the final message must end with a fenced
  `json:result` block. Validation runs parent-side against a dependency-free
  JSON-Schema subset (type/properties/required/items/enum/const — unknown
  keywords are ignored, never rejected). Invalid output triggers **one
  steer-based repair round**; still-invalid results end `partial` with
  `structuredError` set and the raw text delivered — paid work is never
  discarded. Validated parallel results feed the `synthesis` child as clean
  JSON instead of prose.
- **Arg repair**: double-encoded task text (literal `\n` / `\"` escapes from
  LLM re-encoding) is conservatively de-mangled once at validation time.
  Identifier fields and paths are never touched.
  Protocol streams truncated after useful assistant output also end as `partial`.
- Aborting a `wait` returns immediately without cancelling the background run.
- Child processes are launched via the same Node runtime + CLI entry as the
  parent when possible (`PI_SUBAGENT_BIN` overrides). Bare `pi` on PATH is only
  a logged last resort.
- Direct resume is exclusive **across processes** via durable locks under
  `lockDir`. Lost runs block resume until startup orphan reconciliation kills
  (or confirms dead) the recorded child process group.
- `maxGlobalActive` bounds concurrent children across every Pi parent process
  on the machine (in addition to the per-session semaphore).
- Nested children at the depth ceiling do not re-register the subagent tool;
  only top-level parents run maintenance/orphan reclaim/worktree GC.
- Preserved worktrees live under `worktreeDir` (durable, not `/tmp`) and are
  garbage-collected on startup by **lifecycle**, not wall-clock retention: once
  a run is over (not live, past a 1h concurrency race guard), the worktree's
  unique work is archived as one applyable patch under
  `<repo-container>/_patches/` and the directory is reclaimed immediately.
  Branches holding commits that exist on no other ref are never deleted.
  `diff`/`apply`/`discard` transparently fall back to the archived patch when
  the directory is already gone. Live runs are never swept: the current
  session's live worktrees plus any worktree recorded on a running run record
  (concurrent Pi processes) are shielded machine-wide.
- Startup GC sweeps **every** repo container under `worktreeDir`, not just the
  current checkout's, so repos you stop visiting are still reclaimed. A
  container whose base repo no longer exists is kept and reported, never
  deleted — its worktrees' object stores lived inside the deleted repo, so
  unique work cannot be distinguished from a pristine checkout, let alone
  archived. Empty containers (no worktrees, no archived patches) are removed.
- Child session transcripts are likewise distilled on lifecycle: when a run is
  over and nothing on the parent branch references its session, the transcript
  is reduced to a small `.digest.json` (task, final output, model, usage,
  turn/tool/error counts) and the raw `.jsonl` is deleted. Resume needs the
  transcript, so anything referenced or busy machine-wide is kept.
- `keep_background: true` on a task keeps processes the child intentionally
  backgrounded (e.g. dev servers) alive after a clean exit.
- `include_wip: true` (with `isolation: "worktree"`) seeds the worktree with the
  parent checkout's uncommitted changes so the child sees your dirty baseline.
  `diff`/`apply` subtract that baseline when clean, else report the combined
  delta with an explicit `[includes parent WIP]` warning.

## Using the runner as a library

Import the stable public SDK from the package root or the explicit `/sdk`
subpath — do not reach into `src/*` internals (those paths are not part of the
supported contract):

```ts
import {
  runTasks,
  runSubagent,
  ChildRunner,
  WorktreeManager,
  Semaphore,
  ProcessLockManager,
  addUsage,
  normalizeUsage,
  emptyUsage,
  type TaskSpec,
  type TaskResult,
  type RunState,
  type UsageStats,
} from "@parke.dev/pi-subagent/sdk";
```

The package root is an alias for the same SDK:
`import { runTasks } from "@parke.dev/pi-subagent"`.

A minimal `TaskSpec` includes `task`, `profile`, and `timeoutMs`:

```ts
const task: TaskSpec = {
  task: "Audit src/ for unsafe parsing",
  profile: "explore",
  timeoutMs: 10 * 60_000,
};
```

Prefer `runTasks()` for multi-task / worktree orchestration (same path the
extension and pi-workflows use). `runSubagent()` runs a single child process
directly without the extension host, but durable coordination is **opt-in**.
Pass both `locks` (a `ProcessLockManager`) and a stable `runId` if you want
global concurrency slots and orphan reclaim to see the child. Without those
options no durable run record is written, so a parent restart cannot reclassify
the process and nested children vanish from reconcile. There is intentionally
no implicit default lock manager — embedding code that needs durability must
construct and share one.

The Pi extension entry is unchanged: package `pi.extensions` still points at
`./extensions/subagent.ts`.

## Design invariants

1. A run belongs to one parent session and cannot update another session.
2. Per-session + machine-wide process caps and nesting depth limits prevent process storms.
3. Cancellation prevents queued tasks from spawning.
4. Direct resume of a child session is exclusive **across processes** via durable locks.
5. Tool responses are capped to ~50KB/2000 lines; full output lives in
   artifacts and `~/.pi/subagent-sessions`.
6. Status is compact; wait is the one-shot deliverable.
7. On parent session shutdown, live children are aborted and awaited briefly.
8. On parent (re)start, orphan process groups recorded under `lockDir` are reaped
   before any resume is allowed for the matching child session.
9. Provider-reported usage is counted once per root message and terminal child run.
10. Protocol completion prefers `agent_settled` (falls back to non-retrying `agent_end`).

## Layout

```
src/
  index.ts         # stable public SDK entry (@parke.dev/pi-subagent)
  extension.ts     # Pi wiring only
  schema.ts        # request schemas (subagent + subagent_wait)
  btw.ts           # /btw side questions (model-hidden entries)
  backend.ts       # backend adapter seam + capability gate
  backends/        # pi | codex | claude adapters (invocation + parser)
  policy.ts        # profiles, normalization, write guards, agent resolution
  agents.ts        # named agent files (.pi/agents/, .agents/agents/, global)
  launch.ts        # resolve child pi via execPath / PI_SUBAGENT_BIN
  process-lock.ts  # durable session locks, global slots, orphan records
  worktree.ts      # git worktree isolation + diff/apply/discard
  orchestrator.ts  # multi-task execution, transient retry + model fallback
  runner.ts        # child process lifecycle, RPC channel, steering,
                   # graceful budget wrap-up, stall watchdog
  protocol.ts      # Pi RPC/JSON event parser (agent_settled-aware)
  semaphore.ts     # per-session concurrency limit
  registry.ts      # session-scoped run state + durable resume locks
  persistence.ts   # parent-session event folding
  structured.ts    # output_schema contract + repair round
  distill.ts       # transcript → .digest.json reduction
  dispatch.ts      # optional pi-dispatch integration
  transcript.ts    # child session transcript handling
  maintenance.ts   # startup GC, orphan reclaim, worktree sweep
  usage.ts         # root/subagent/combined usage ledger
  output.ts        # exact global output caps
  notifications.ts # batched background-run completion notifications
  format.ts / ui.ts# renderers, ambient widget, /subagents overlay
```

## Develop

```bash
npm install
npm run typecheck
npm test
npm run pack:check
```

Tests use a deterministic `fake-pi` child. No live model calls are required.

## Cost accounting

`status`, `/subagent-cost`, and the `/subagents` overlay header show separate
**root**, **subagent**, and **combined** totals based on provider-reported
usage. On Pi builds after v0.80.10, delivered runs also report their total
usage natively on the tool result
([pi#6671](https://github.com/earendil-works/pi/pull/6671)), so Pi's own
footer, `/session`, and RPC totals include subagent spend — exactly once per
run; older Pi hosts ignore the field. Nested usage reported by a child's tool
results (e.g. grandchild subagents) folds into the run's totals and budgets.
The extension footer stays terse (running/ready counts only). Delivery and
replay do not double count runs. See
[docs/COST-ACCOUNTING.md](./docs/COST-ACCOUNTING.md).

## Roadmap

Remaining planned work lives in [docs/ROADMAP.md](./docs/ROADMAP.md) (rationale
and design sketches) and [docs/PLAN.md](./docs/PLAN.md) (execution contract:
work breakdown, acceptance criteria, test plans, and release gates per phase).
Shipped milestones — named agents, spawn policies, dry-run validation, keep-alive,
backends, structured output — are recorded in [CHANGELOG.md](./CHANGELOG.md).

## Security

See [docs/SECURITY.md](./docs/SECURITY.md). Pi packages run with full system
access—review source before installing third-party packages.

## Status

Current version: **0.10.0** — see [CHANGELOG.md](./CHANGELOG.md). The lifecycle
engine described above is shipped, including named agent catalogs, spawn
policies, dry-run validation, keep-alive `waiting` runs, the doom-loop
watchdog, codex/claude backends, and structured output.
