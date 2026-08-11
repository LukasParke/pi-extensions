---
name: sentinel
description: Monitor external completion criteria with sentinel_watch, sentinel_sleep, and sentinel_gate. Use when an agent must wait for CI, reviews, deployments, Kubernetes rollouts, Herdr agents, timers, or any other shell-queryable state without polling from model turns. A task with an open gate is never done until Sentinel reports ALL PASS.
---

# Sentinel

Sentinel monitors external state extension-side, without model tokens. Use it whenever finishing
the task depends on CI, reviews, deployments, another agent, or elapsed time.

## Cost rule

**Optimize for fewer model wakeups, not fewer extension-side polls.** A wakeup message is tiny,
but the provider must read the session context again. Cached context reads can cost materially,
and a wakeup after cache expiry can re-bill the entire context.

Sentinel coalesces events that arrive together, appends active sentinel status to every delivery,
and supports `next-turn` urgency for information that can wait. Do not manually poll or call
`sentinel_status` after a wakeup; the wakeup already includes the current active snapshot.

## Core rule

**Never claim the task is done while a gate is open. Done means the gate reports
`SENTINEL GATE: ALL PASS`.**

On each wakeup, address what flipped: fix CI, resolve review feedback, repair the deployment,
or update the probe if the requirement changed. Then go idle again.

## Prefer stream watches

Use `mode: "stream"` whenever a native blocking command exists. A stream watch spawns the command
once and wakes immediately when it exits: no repeated polling and no interval latency.

Good stream commands:

```bash
gh pr checks 123 --watch
herdr agent wait <name> --until idle
kubectl rollout status deployment/api --timeout=20m
sleep 300 && ./scripts/check-propagation.sh
```

Example:

```json
{
  "name": "pr-checks",
  "command": "gh pr checks 123 --watch",
  "mode": "stream",
  "timeout_s": 1800
}
```

Use poll mode only when the command is a quick state snapshot and has no blocking equivalent.
Stream commands receive no stdin, are killed on cancellation/session end, support `timeout_s`,
and are limited to four concurrent watches.

## PR babysitting

Use one blocking stream for checks:

```json
{
  "name": "pr-checks",
  "command": "gh pr checks 123 --watch",
  "mode": "stream",
  "timeout_s": 1800
}
```

GitHub has no blocking unresolved-thread command, so poll that state through GraphQL:

```bash
gh api graphql -f query='query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}' -F owner=OWNER -F repo=REPO -F number=123 --jq -e '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length == 0'
```

Register it as a poll watch, or use it as a gate criterion when review clearance is part of the
definition of done. Criterion flips default to `next-turn`, while gate `ALL PASS` wakes immediately.
Set `quiet_for_s: 600` when both CI and reviews must remain settled for ten minutes.

## Predicates

Commands pass on exit code `0` by default. Optional `done_when` / `pass_when` predicates are:

- `exit_code`
- `output_contains`
- `output_json` with a dot-separated path and exact value

Keep complex logic in the command itself, usually with `jq -e`.

## Urgency

Use `urgency: "wake"` for information requiring immediate work. Use `"next-turn"` for useful
state changes that can ride along with the next natural model turn without triggering one.

Defaults:

- watch completion, timeout, and sleep elapsed: `wake`;
- gate criterion flips while the gate remains open: `next-turn`;
- gate `ALL PASS`: `wake`.

If several events are pending, Sentinel delivers one coalesced message. Any `wake` event makes
the batch urgent; otherwise the batch waits for the next natural turn.

## Replaceable sleeps

Use `sentinel_sleep` for a required time-based check-in. Unnamed sleeps share the fixed `sleep`
slot, so calling `sentinel_sleep` again replaces the pending unnamed timer. Named sleeps replace
only the same name. Re-sleep loops are safe and never accumulate stale timers.

## Cancellation

Cancel a sentinel as soon as its condition is no longer relevant. Cancellation removes timers or
stream processes and drops queued undelivered events from that sentinel. A completed watch that
was not cancelled still delivers because completion is useful information.

Sentinels are in-memory and do not survive a Pi restart.
