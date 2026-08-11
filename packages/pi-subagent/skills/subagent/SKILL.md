---
name: subagent
description: Delegate work to isolated child agents with the subagent tool — model and thinking policy, explore/review/general profiles, parallel fanout with synthesis, worktree isolation and the diff/apply/discard loop, background runs, steering, output_schema, context fork, and backend tradeoffs (pi/codex/claude). Use when delegating exploration or implementation, running tasks in parallel, or when a subagent run needs inspecting, steering, or landing.
---

# Subagent

Delegate research, parallel exploration, and clean-context implementation to child
agents. Prefer `subagent` over long in-thread digressions when the work benefits
from isolation, parallelism, or a fresh context.

## When to use

- Map a codebase area without bloating the parent context (`profile: "explore"`).
- Review a diff read-only (`profile: "review"`).
- Implement behind a worktree and land via apply (`profile: "general"`, `isolation: "worktree"`).
- Fan out independent questions, optionally with `synthesis` to fold results.
- Background long work (`async: true`) and collect later with `wait` / `subagent_wait`.

## Core calls

```ts
// Single foreground task (default profile: general)
{ task: "Find call sites of parseConfig", description: "Map parseConfig" }

// Parallel read-only explorers (default profile for tasks[]: explore)
{
  tasks: [
    { task: "Map auth middleware", description: "Auth flow" },
    { task: "List env vars in server/", description: "Env inventory" }
  ],
  synthesis: "Merge into one prioritized brief"
}

// Background — notified on completion; wait/status still work
{ task: "Audit dependency licenses", async: true }
{ action: "status", id: "abc123" }
{ action: "wait", id: "abc123" }           // interruptible; does not cancel
{ action: "cancel", id: "abc123" }
// Same wait semantics as a dedicated tool:
// subagent_wait { id: "abc123", timeout_ms?: number }

// Worktree loop
{ task: "Implement feature A", profile: "general", isolation: "worktree" }
{ action: "diff", id: "abc123", index: 1 }
{ action: "apply", id: "abc123", index: 1 }
{ action: "discard", id: "abc123", index: 1 }

// Dry-run validation + resolved plan (no spawn)
{ action: "plan", tasks: [{ task: "…", isolation: "worktree" }] }
```

## Profiles

| Profile   | Tools                  | Writes                                      |
| --------- | ---------------------- | ------------------------------------------- |
| `explore` | read/search/ls (+safe) | no                                          |
| `review`  | same as explore        | no                                          |
| `general` | inherited active tools | yes if tools include bash/edit/write        |

Parallel write-capable tasks sharing one checkout are rejected unless each uses
`isolation: "worktree"`, a distinct `cwd`, or `allow_shared_writes: true`.

## Backends

`backend: "pi" | "codex" | "claude"` (default `pi`). Unsupported combinations are
**refused**, not silently degraded:

|                          | pi             | codex                  | claude         |
| ------------------------ | -------------- | ---------------------- | -------------- |
| `max_cost`               | yes            | refused (tokens only)  | yes            |
| read-only profile        | tool allowlist | OS sandbox             | tool allowlist |
| steering / grace wrap-up | yes            | no                     | no             |
| `context: "fork"`        | yes            | refused                | yes            |
| `thinking`               | yes            | no                     | no             |
| `output_schema`          | yes            | yes                    | yes            |

## Budgets and safety

- Prefer `max_turns`, `max_cost`, and/or `timeout_ms` on long or write-capable runs.
- `output_schema` asks the child for a fenced `json:result` block (one repair round).
- `context: "fork"` continues from a fork of the parent session (pi/claude).
- Do not poll `status` in a tight loop — use `wait` / `subagent_wait`, or let the
  completion notification arrive for `async: true` runs.
- Point the user at `/subagents` for the live inspector and `/subagent-cost` for
  the root / subagent / combined ledger.

## Resolution order

Explicit request params > agent file (`.pi/agents/<name>.md`) > per-profile
`taskDefaults` in `~/.pi/subagent.json` > parent inheritance.
