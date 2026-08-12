---
name: herdr
description: Dispatch long-running tasks to pi agents in herdr-managed worktrees via herdr_task, monitor them with herdr_task_status, and safely remove finished worktrees with herdr_task_cleanup. Use when work should run in its own worktree and pane outside this session — a feature build, a PR review, a repo-wide chore — when checking on a dispatched agent, or when cleaning one up after its completion criteria pass.
---

# Herdr task dispatch

Use this skill when the system prompt identifies the current Pi session as
Herdr-managed. In a standalone session, use `subagent` or background terminals.

`herdr_task` hands a task to a fresh pi agent in its own git worktree, pane, and
branch, managed by the Herdr CLI. The dispatching session keeps working; the
child has **no context from this session**, so write the task prompt fully
self-contained.

## When to reach for it

- One main task in a repo: a PR stack or one substantial deliverable such as a
  package, migration, or long babysit.
- Work that must survive the dispatcher, land through PRs, and remain
  human-visitable in a focusable pane.
- Parallel missions across repos (`repo` is a short folder name under a
  configured repo root, e.g. `pi-extensions`, `home-ops`).

## When to use herdr vs subagents

Herdr owns the mission or PR stack. Inside that session, subagents execute its
PR-sized units, parallel legs, research fanouts, and clean-context reviews.
Scope may vary—even a single deliverable can merit herdr while subagents only
parallelize research—but ownership stays fixed: herdr owns the external
outcome; subagent results return inline to that owner.

| Decision    | Herdr                            | Subagent                                |
| ----------- | -------------------------------- | --------------------------------------- |
| Context     | Self-contained mission brief     | Calling session's task context          |
| Lifespan    | Survives the dispatcher          | Returns to the calling session          |
| Isolation   | Dedicated worktree, branch, pane | Process or temporary worktree           |
| Supervision | Human-visitable mission owner    | Intra-mission worker                    |
| Deliverable | PR stack or substantial outcome  | Inline result or work applied by caller |

Use a subagent when the parent needs the result inline. Use herdr when work must
own and land PRs independently. A subagent must not own PR-producing work that
could be lost if its parent dies; completed work must never be left behind.

## Dispatch

```
herdr_task { task: "<complete self-contained prompt>", repo: "pi-extensions", name: "fix-ci" }
```

- Omit `repo` to use the current directory's repo.
- `name` becomes the agent name and branch (`agent/<name>`). It must already be a
  Herdr name: lowercase start, `[a-z0-9_-]`, 1-32 characters. Omit it to generate a
  short subject name from the task via the active model, falling back to a 32-character
  slug if generation is unavailable or invalid. `/review` keeps `review-pr-<num>`.
- Returns immediately with the agent name, worktree path, and branch.
- Dispatch is resilient: an existing worktree/branch from a failed earlier
  dispatch is reused and an already-running pi in the pane is adopted.
- Newly started agents receive the task in pi's launch argv. Dispatch waits up
  to 30 seconds for `working`, then uses the verified prompt path only if the
  agent remains idle. Adopted agents always use the verified prompt path.

## Monitor

```
herdr_task_status { agent: "fix-ci" }                 — state + recent output
herdr_task_status { agent: "w7:p3" }                  — same, by pane id
herdr_task_status { agent: "fix-ci", wait: true }     — block until it settles
```

States: `working` (busy), `blocked` (asking a question — read the output, then
answer with `herdr agent prompt` via bash), `idle`/`done` (turn finished), and
`gone` (Herdr forgot the agent after its workspace closed). A gone status points
to the surviving orphan worktree when one exists; verify its branch/PR, then
clean it up. If no worktree is found under the configured roots, status says
so without claiming cleanup. If multiple worktrees match, resolve the ambiguity
before cleanup.

If Sentinel tools are available, register `sentinel_watch` against
`herdr agent get <name>` reaching `idle` or `done`. Go idle and let Sentinel
wake the session instead of spending model turns polling.

## Verify and clean up

An idle/done agent means its turn ended, not that the task's gate passed. Read
its output and verify the actual completion criteria: inspect the diff/result,
confirm the PR was opened or merged as required, and wait for required CI,
reviews, or deployments.

Then clean up:

```text
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

The session must be Herdr-managed and the `herdr` CLI must be installed on
`PATH`; every operation shells out to it. Repo roots, worktree roots, and the
invocation log path are configurable via `~/.pi/herdr.json`. Every Herdr invocation is logged as JSONL at
`~/.pi/herdr-task.log` by default: `ts`, `args`, `outcome`, optional `error`,
and elapsed `ms`. This preserves parameters and error details absent from
Herdr's server log.
