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

| Tool                 | Purpose                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `herdr_task`         | Dispatch a self-contained task to a new pi agent in its own worktree, branch (`agent/<name>`), and pane           |
| `herdr_task_status`  | Check a dispatched agent: lifecycle state (working/idle/done/blocked) and recent terminal output; `wait` to block |
| `herdr_task_cleanup` | Safely close a finished agent's workspace and remove its dispatched-task worktree                                 |

Dispatch is fire-and-forget and resilient:

- An existing worktree/branch left behind by a failed earlier dispatch is
  found and reused instead of failing on "branch exists".
- A pi agent already running in the pane (e.g. auto-started by the shell) is
  adopted rather than colliding with `agent_pane_busy`.
- Pane-not-ready states (`agent_pane_busy`, "not an available shell",
  `agent_kind_mismatch`) are retried as transient while the checkout settles.
- Newly started agents receive the task in `pi`'s launch argv, eliminating the
  startup prompt-swallow race. Dispatch waits up to 30 seconds for `working`
  and falls back to a verified prompt only if the agent remains idle. Adopted
  agents are already running, so they always use the verified prompt path.

## Lifecycle

Dispatch → verify → cleanup:

1. Dispatch with `herdr_task`.
2. Monitor with `herdr_task_status`. If
   [`@parke.dev/pi-sentinel`](../pi-sentinel) is installed, use
   `sentinel_watch` on `herdr agent get <name>` so the session wakes when the
   agent reaches `done` or `idle` instead of polling model turns.
3. Verify the task's real completion gate: review the result, confirm the PR
   exists, and wait for required CI/reviews/deployments.
4. Call `herdr_task_cleanup` only after those criteria pass.

Herdr forgets an agent after its workspace closes. Status reports that agent as
`gone`: if its checkout still exists under a configured worktree root, the
response points to it for branch/PR verification and cleanup; otherwise it
reports that the task was fully cleaned up.

Cleanup refuses non-Herdr worktrees. Without `force`, it also refuses agents
that are still working/blocked, dirty checkouts, and unpushed commits. A refusal
lists every problem to resolve. `force` bypasses those safety checks for
deliberately abandoned work. Cleanup asks Herdr to remove the worktree and its
workspace together. If the workspace or agent is already gone, it resolves the
base repo with `git rev-parse --path-format=absolute --git-common-dir`, removes the orphaned checkout
with `git worktree remove`, and prunes stale worktree metadata. The pushed
branch remains on the remote.

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
| `logPath`       | `HERDR_LOG_PATH`       | `~/.pi/herdr-task.log`               |

Root env values are PATH-style separated lists; root file values are JSON
arrays. `logPath` is a single path. `~` is expanded.

Every Herdr CLI invocation appends one JSONL object to `logPath` with `ts`,
`args`, `outcome` (`ok` or `error`), optional `error`, and elapsed `ms`. Logging
failures never fail the tool. This supplements Herdr's server log, which records
request outcomes but not the parameters or structured error codes needed for
failed-dispatch post-mortems.

```json
{
  "repoRoots": ["~/code"],
  "worktreeRoots": ["~/.herdr/worktrees"],
  "logPath": "~/.pi/herdr-task.log"
}
```

## Skills

- `herdr` — teaches the model when to dispatch via `herdr_task` versus the
  `subagent` tool, and how to monitor, verify, and clean up dispatched agents.
- `herdr-pi-orchestration` — the operator runbook for long-running Pi
  orchestrators in herdr worktrees: brief-on-disk pattern, prompt-swallow
  guard, stacked-PR delegation, and monitoring pitfalls.
