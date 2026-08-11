# @parke.dev/pi-herdr

Dispatch tasks to pi agents running in [herdr](https://github.com/LukasParke/herdr)-managed
git worktrees, from inside the [Pi coding agent](https://pi.dev).

```sh
pi install npm:@parke.dev/pi-herdr
```

## Prerequisite: the `herdr` CLI

**The `herdr` CLI must be installed and on PATH.** Every operation shells out to
it (`herdr worktree create`, `herdr agent start/prompt/wait/get/read`,
`herdr pane list`). Without it the tools fail with a clear error and the
`project_trust` hook stays inert.

## Tools

| Tool                | Purpose                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `herdr_task`        | Dispatch a self-contained task to a new pi agent in its own worktree, branch (`agent/<name>`), and pane           |
| `herdr_task_status` | Check a dispatched agent: lifecycle state (working/idle/done/blocked) and recent terminal output; `wait` to block |

Dispatch is fire-and-forget and resilient:

- An existing worktree/branch left behind by a failed earlier dispatch is
  found and reused instead of failing on "branch exists".
- A pi agent already running in the pane (e.g. auto-started by the shell) is
  adopted rather than colliding with `agent_pane_busy`.
- Pane-not-ready states (`agent_pane_busy`, "not an available shell",
  `agent_kind_mismatch`) are retried as transient while the checkout settles.
- The prompt is submitted with `--wait --until working` and verified: pi
  silently drops prompts sent during startup, so a stalled prompt is re-sent
  unless the agent is already working.

## Slash commands

- `/herdr-task [repo-name] <task...>` — dispatch from the prompt line. The
  leading token is treated as a repo short name if it matches a known repo;
  otherwise the repo comes from the current directory. A bare GitHub PR URL
  dispatches a review instead.
- `/review <github-pr-url>` — dispatch a `review-pr-<num>` agent that runs
  `/pr-review` on the PR from that repo's worktree.

## Worktree trust

A `project_trust` hook auto-trusts herdr worktrees so dispatched agents do not
stall on pi's trust prompt: a directory under a configured worktree root
(default `~/.herdr/worktrees` and `~/.worktrees`) is trusted iff its **base
repository** lives under a configured repo root (default `~/github` and
`~/Development`). Everything else stays undecided and gets pi's normal prompt.

## Configuration

Optional, via `~/.pi/herdr.json` or environment variables:

| Field           | Env                    | Default                              |
| --------------- | ---------------------- | ------------------------------------ |
| `repoRoots`     | `HERDR_REPO_ROOTS`     | `~/github`, `~/Development`          |
| `worktreeRoots` | `HERDR_WORKTREE_ROOTS` | `~/.herdr/worktrees`, `~/.worktrees` |

Env values are PATH-style separated lists; file values are JSON arrays. `~` is
expanded.

```json
{
  "repoRoots": ["~/code"],
  "worktreeRoots": ["~/.herdr/worktrees"]
}
```

## Skills

- `herdr` — teaches the model when to dispatch via `herdr_task` versus the
  `subagent` tool, and how to monitor dispatched agents.
- `herdr-pi-orchestration` — the operator runbook for long-running Pi
  orchestrators in herdr worktrees: brief-on-disk pattern, prompt-swallow
  guard, stacked-PR delegation, and monitoring pitfalls.
