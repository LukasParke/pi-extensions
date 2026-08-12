---
name: herdr-pi-orchestration
description: Runbook for launching a long-running Pi orchestrator in a Herdr worktree workspace — worktree/workspace creation, brief-on-disk pattern, agent start/prompt pitfalls (startup prompt swallowing, unsigned commits), subagent delegation for stacked PRs, and monitoring. Use when tasking a Pi instance on a named worktree via Herdr, or when a herdr agent prompt seems to have been ignored.
---

# Launching a Pi orchestrator in Herdr (worktree + stacked-PR pattern)

Distilled from the MCP Platform launch (2026-08). Follow this order; the
pitfalls at the bottom are each things that actually went wrong.

## 0. Preconditions

The Pi system prompt must identify the session as Herdr-managed. Herdr provides
`HERDR_ENV=1` plus non-empty `HERDR_SOCKET_PATH` and `HERDR_PANE_ID`; the
packaged extension keeps control tools unavailable otherwise.

```bash
herdr --skill # authoritative CLI usage; re-read if unsure
```

Keep Herdr control inside a managed session. Never run `herdr server stop`.

## 1. Create the worktree + workspace in one step

`herdr worktree create` makes the git worktree AND a dedicated workspace
with a root pane cd'd into it — do not `git worktree add` + `herdr
workspace create` separately.

```bash
herdr worktree create --workspace w1 \
  --branch <stack-prefix>/01-<layer> \
  --base <plan-branch-or-main> \
  --label <short-name> --no-focus
```

- `--workspace` = any workspace of the SOURCE repo (find via
  `herdr worktree list --workspace $HERDR_WORKSPACE_ID`).
- `--base` should be the plan/docs branch when stacking on committed docs,
  so the docs PR is the stack base (PR 0).
- `--no-focus` keeps the user's focus where it is.
- Parse `workspace_id` and `root_pane.pane_id` from the JSON response —
  never guess IDs.

Worktree lands at `~/.herdr/worktrees/<repo>/<branch-slug>`.

## 2. Put the mission on disk BEFORE starting the agent

Write an `IMPLEMENTATION-BRIEF.md` (or similar) into the worktree and
commit it. The launch prompt should then be short: "read the brief and
follow it." Reasons:

- Long prompts through `herdr agent prompt` are one-shot and unrecoverable;
  a file survives restarts, context compaction, and subagent handoff.
- The brief becomes part of the PR stack — reviewers see the contract.

Brief contents that matter: pointers to plan docs + relevant repo skills,
the exact branch names and PR stack order, subagent parallelization
guidance (which layers are independent), hard constraints (verify before
push, frozen services, migration lock analysis), and where to write
progress (`PROGRESS.md`).

## 3. Start the Pi agent

```bash
herdr agent start <name> --kind pi --pane <root-pane-id>
```

- Name must match `[a-z][a-z0-9_-]{0,31}` and be unique among live agents.
- `agent start` returns when Pi is interactively ready — but see pitfall
  P1 before prompting.

## 4. Prompt — with the swallow guard (P1)

**Pitfall P1: pi swallows prompts sent during startup.** `agent start`
returns when the TUI renders, but pi may still be loading MCP servers /
skills; a prompt sent in that window is silently dropped. The tell: agent
status returns `idle` with `$0.00` cost after your prompt.

Guard:

```bash
herdr agent prompt <name> "<short launch prompt>" --wait --timeout 60000
# then VERIFY it took:
herdr agent read <name> --source visible --lines 10   # cost > $0.00 / "Working..."
```

If cost is still $0.00 and status is idle → the prompt was swallowed;
re-send it. `--wait` on the prompt returns `agent_prompt_stalled` if no
lifecycle change happens within 5s — treat that as swallowed too.

## 5. Monitor without interfering

```bash
herdr agent get <name>                                        # lifecycle state
herdr agent read <name> --source recent-unwrapped --lines 60  # transcript
```

- `working` = busy; `blocked` = it's asking a question — `agent read`
  first, then answer via `agent prompt` or `agent send-keys`.
- `idle`/`done` at meaningful cost = turn finished; read output.
- Steer a running orchestrator with a new `agent prompt` — do not kill and
  restart for course corrections.
- CLI reads don't mark tabs seen; focus the tab in the UI if you want the
  done-state cleared.

## 6. Delegation shape (orchestrator ↔ subagents)

The pattern that works: **one Pi orchestrator in the Herdr pane, pi
`subagent` tool for the layers.**

- Orchestrator owns: decomposition, stack management (branch per PR, each
  based on the previous, `gh pr create --base <prev>` or `gt`), reviewing
  every subagent diff, integration, PROGRESS.md.
- Subagents own: one layer each. Independent layers run parallel with
  `isolation: 'worktree'`; dependent layers run sequential in the shared
  checkout.
- Don't start multiple Herdr-level agents for one stack — sibling Herdr
  agents don't share the orchestrator's context; pi subagents do (via
  briefs + diffs).

## Pitfalls index

- **P1 — startup prompt swallow**: verify cost > $0.00 after prompting;
  re-send if idle at $0.00. (§4)
- **P2 — commit signing via 1Password**: commits are signed through the
  1Password SSH agent, which prompts Luke for authorization. **Never
  disable signing** (`commit.gpgsign=false` is forbidden). If a commit
  fails with `error: 1Password: Could not connect to socket`, tell Luke
  and retry — he will authorize the prompt in 1Password. Expect commits
  to block briefly on human authorization; that is normal, not an error
  to work around.
- **P3 — don't pre-create branches the orchestrator owns**: create only
  the first stack branch via `worktree create`; let the orchestrator make
  branches 2..N so it owns the stack topology.
- **P4 — IDs from JSON only**: workspace/tab/pane IDs come from command
  responses, never from sidebar order or assumptions.
- **P5 — long output reads**: if `--lines N` doesn't reveal more of a
  finished response, the agent is on the alternate screen; ask it to write
  the answer to a temp file and read that (fallback only).
