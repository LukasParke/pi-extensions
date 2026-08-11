---
name: herdr
description: Dispatch long-running tasks to pi agents in herdr-managed worktrees via herdr_task, and monitor them with herdr_task_status. Use when work should run in its own worktree and pane outside this session — a feature build, a PR review, a repo-wide chore — and when checking on an agent dispatched earlier.
---

# Herdr task dispatch

`herdr_task` hands a task to a fresh pi agent in its own git worktree, pane, and
branch, managed by the herdr CLI. The dispatching session keeps working; the
child has **no context from this session**, so write the task prompt fully
self-contained.

## When to reach for it

- Work that deserves its own branch and checkout (features, fixes, reviews).
- Long tasks that should survive this session ending.
- Parallel work across different repos (`repo` is a short folder name under a
  configured repo root, e.g. `pi-extensions`, `home-ops`).

Prefer the `subagent` tool instead when the child needs shared context with
this session or the work is quick and read-only.

## Dispatch

```
herdr_task { task: "<complete self-contained prompt>", repo: "pi-extensions", name: "fix-ci" }
```

- Omit `repo` to use the current directory's repo.
- `name` becomes the agent name and branch (`agent/<name>`); derived from the
  task when omitted.
- Returns immediately with the agent name, worktree path, and branch.
- Dispatch is resilient: an existing worktree/branch from a failed earlier
  dispatch is reused, an already-running pi in the pane is adopted, and the
  prompt is verified against pi's startup prompt-swallow (re-sent if dropped).

## Monitor

```
herdr_task_status { agent: "fix-ci" }                 — state + recent output
herdr_task_status { agent: "fix-ci", wait: true }     — block until it settles
```

States: `working` (busy), `blocked` (asking a question — read the output, then
answer with `herdr agent prompt` via bash), `idle`/`done` (turn finished).

## Slash commands

- `/herdr-task [repo-name] <task...>` — dispatch from the prompt line.
- `/review <github-pr-url>` — dispatch a `review-pr-<num>` agent that runs
  `/pr-review` on the PR in that repo's worktree. A bare PR URL given to
  `/herdr-task` does the same.

## Prerequisite

The `herdr` CLI must be installed and on PATH; every operation shells out to
it. Repo and worktree roots are configurable via `~/.pi/herdr.json`.
