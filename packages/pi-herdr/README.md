# @parke.dev/pi-herdr

Dispatch tasks to pi agents running in [herdr](https://github.com/LukasParke/herdr)-managed
git worktrees, from inside the [Pi coding agent](https://pi.dev).

```sh
pi install npm:@parke.dev/pi-herdr
```

## Runtime context

The extension treats Pi as Herdr-managed only when `HERDR_ENV=1` and Herdr
provides non-empty socket and pane identifiers. Managed sessions keep the Herdr
tools and commands available, and Pi's prompt includes safe workspace, tab, and
pane identity when present.

Standalone sessions remove the Herdr tools from Pi's active tool set and direct
the model to `subagent` or background terminals instead. Commands and manually
re-enabled tools also stop with a clear availability error. The independent
`project_trust` hook remains active in both modes and preserves the trust rules
below.

Managed sessions require the `herdr` CLI on `PATH`; execution errors report when
the server becomes unavailable after startup.

A Herdr session owns one repo-level mission: a PR stack or substantial
deliverable that must survive its dispatcher and remain human-visitable. Use
subagents inside that session for inline research, parallel legs, clean-context
reviews, and PR-sized units. See the bundled `herdr` skill for the full split.

## Tools

| Tool                 | Purpose                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `herdr_task`         | Dispatch a self-contained task to a new pi agent in its own worktree, branch (`agent/<name>`), and pane. Omit `name` to generate a short subject label (32-char slug fallback) |
| `herdr_task_status`  | Check a dispatched agent: lifecycle state (working/idle/done/blocked) and recent terminal output; `wait` to block                                                              |
| `herdr_task_cleanup` | Safely close a finished agent's workspace and remove its dispatched-task worktree                                                                                              |

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
- Tasks that cannot be encoded as argv — multi-line prompts, or prompts over
  2000 characters — are written to `.pi-herdr-brief.md` in the worktree and
  the agent is started with a short pointer prompt referencing that file
  (the brief-on-disk pattern). The brief is dispatch metadata: at write time
  it is appended to the worktree's `.git/info/exclude`, so it can never be
  committed into a PR and never trips cleanup's dirty check. If herdr still
  rejects an argv that looked safe (`invalid_agent_argument`), dispatch
  retries once with a brief file.

Status degrades instead of failing on transient conditions: if `herdr agent
read` rejects a busy agent (`agent_not_idle`), the tool returns the lifecycle
state with a `transcript: unavailable (agent busy)` note rather than an
error; a `wait=true` timeout (`timed out waiting for agent status`, which
only `agent wait` emits) is not an error either — the tool falls through and
reports the agent's current status; and if status polling itself times out,
the tool returns `state: unknown` with the underlying message and skips the
transcript read.

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
reports that no matching worktree was found under the configured roots. If
multiple worktrees match, status refuses to choose one.

Cleanup refuses non-Herdr worktrees. Without `force`, it also refuses agents
that are still working/blocked, dirty checkouts, and unpushed commits. A refusal
lists every problem to resolve. `force` bypasses those safety checks for
deliberately abandoned work. Cleanup asks Herdr to remove the worktree and its
workspace together. If the workspace or agent is already gone, it resolves the
base repo with `git rev-parse --path-format=absolute --git-common-dir`, removes the orphaned checkout
with `git worktree remove`, and prunes stale worktree metadata. A checkout that
is already deleted — or vanishes between the check and the removal — is treated
as a successful cleanup with a note instead of an error; if its herdr workspace
is still alive, cleanup removes it (still refusing a working/blocked agent
without `force`) so no zombie pane is left behind. The pushed
branch remains on the remote.

## Slash commands

- `/herdr-task [repo-name] <task...>` — dispatch from the prompt line. The
  leading token is treated as a repo short name if it matches a known repo;
  otherwise the repo comes from the current directory. A bare GitHub PR URL
  dispatches a review instead. Omitted names are model-generated subject labels
  with a deterministic 32-character slug fallback.
- `/review <github-pr-url>` — dispatch a `review-pr-<num>` agent that runs
  `/pr-review` on the PR from that repo's worktree.

## Worktree trust

A `project_trust` hook auto-trusts Herdr worktrees in managed and standalone
Pi sessions so dispatched agents do not stall on Pi's trust prompt: a directory
under a configured worktree root
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
