---
name: herdr
description: Dispatch long-running tasks to pi agents in herdr-managed worktrees via herdr_task, monitor them with herdr_task_status, and safely remove finished worktrees with herdr_task_cleanup. Use when work should run in its own worktree and pane outside this session — a feature build, a PR review, a repo-wide chore — when checking on a dispatched agent, or when cleaning one up after its completion criteria pass.
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
  dispatch is reused and an already-running pi in the pane is adopted.
- Newly started agents receive the task in pi's launch argv. Dispatch waits up
  to 30 seconds for `working`, then uses the verified prompt path only if the
  agent remains idle. Adopted agents always use the verified prompt path.

## Monitor

```
herdr_task_status { agent: "fix-ci" }                 — state + recent output
herdr_task_status { agent: "fix-ci", wait: true }     — block until it settles
```

States: `working` (busy), `blocked` (asking a question — read the output, then
answer with `herdr agent prompt` via bash), `idle`/`done` (turn finished), and
`gone` (Herdr forgot the agent after its workspace closed). A gone status points
to the surviving orphan worktree when one exists; verify its branch/PR, then
clean it up. If no worktree remains, the task was already fully cleaned up.

If Sentinel tools are available, register `sentinel_watch` against
`herdr agent get <name>` reaching `idle` or `done`. Go idle and let Sentinel
wake the session instead of spending model turns polling.

## Verify and clean up

An idle/done agent means its turn ended, not that the task's gate passed. Read
its output and verify the actual completion criteria: inspect the diff/result,
confirm the PR was opened or merged as required, and wait for required CI,
reviews, or deployments.

Then clean up:

```
herdr_task_cleanup { agent: "fix-ci" }
```

Cleanup only removes configured Herdr worktrees. It refuses with a list of
problems if the agent is working/blocked, the checkout is dirty, or commits are
not present on a remote. Resolve those problems and retry.
Use `force: true` only to discard deliberately abandoned work. Cleanup removes
the Herdr worktree and workspace together. If the workspace or agent is already
gone, it finds the orphan by agent name and falls back to Git removal and
pruning from the base repo. If neither agent nor orphan exists, there is nothing
to clean up. The pushed branch remains on the remote.

Lifecycle: **dispatch → monitor/wake → verify the gate → cleanup**.

## Slash commands

- `/herdr-task [repo-name] <task...>` — dispatch from the prompt line.
- `/review <github-pr-url>` — dispatch a `review-pr-<num>` agent that runs
  `/pr-review` on the PR in that repo's worktree. A bare PR URL given to
  `/herdr-task` does the same.

## Prerequisite

The `herdr` CLI must be installed and on PATH; every operation shells out to
it. Repo roots, worktree roots, and the invocation log path are configurable
via `~/.pi/herdr.json`. Every Herdr invocation is logged as JSONL at
`~/.pi/herdr-task.log` by default: `ts`, `args`, `outcome`, optional `error`,
and elapsed `ms`. This preserves parameters and error details absent from
Herdr's server log.
