---
name: sentinel
description: Monitor external completion criteria with sentinel_watch, sentinel_sleep, and sentinel_gate. Use when an agent must wait for CI, reviews, deployments, Kubernetes rollouts, Herdr agents, timers, or any other shell-queryable state without polling from model turns. A task with an open gate is never done until Sentinel reports ALL PASS.
---

# Sentinel

Sentinel polls shell probes extension-side, without model tokens, and wakes you only when
something meaningful changes. Use it whenever finishing the task depends on external state.

## Core rule

**Never claim the task is done while a gate is open. Done means the gate reports
`SENTINEL GATE: ALL PASS`.**

On each wakeup, address what flipped: fix CI, resolve or respond to review feedback, repair
the deployment, or update the probe if the requirement changed. Then go idle again. Sentinel
keeps watching and wakes you on the next transition.

## PR babysitting

Create shell commands that emit simple JSON and let Sentinel test one value. For example,
watch GitHub checks with a command shaped like:

```bash
gh pr checks 123 --json state --jq '{passing: (all(.[]; .state == "SUCCESS" or .state == "SKIPPED"))}'
```

Use this pass predicate:

```json
{ "output_json": { "path": "passing", "equals": true } }
```

Query unresolved review threads through GraphQL and emit a count:

```bash
gh api graphql -f query='query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}' -F owner=OWNER -F repo=REPO -F number=123 --jq '{unresolved: [.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length}'
```

Give `sentinel_gate` two criteria:

1. `CI`, using the `gh pr checks` command and `passing == true`.
2. `Review threads`, using the GraphQL command and `unresolved == 0`.

Set `quiet_for_s: 600`. The gate must remain green for ten minutes before the task is done.
If CI or reviews flip during that window, handle the wakeup and let the quiet window restart.

## Watches

Use `sentinel_watch` for one external condition that is useful but is not the session's full
definition of done. A command passes on exit code `0` by default. The optional predicates are:

- `exit_code`
- `output_contains`
- `output_json` with a dot-separated path and exact value

Keep complex logic in the command itself, usually with `jq`. Use `wake_on_change: true` when
stdout transitions matter before completion. Add `timeout_s` so a stalled external operation
wakes you rather than disappearing.

Examples include deployment status, `kubectl rollout status`, and Herdr agents queried with
`herdr agent get`. Do not manually poll after registering the watch; go idle and wait for a
wakeup.

## Time-based check-ins

Use `sentinel_sleep` with `minutes` or an ISO-8601 `until` time for late reviewers, propagation
delays, or any required check-back. This is preferable to promising to remember later.

Sentinels are in-memory and do not survive a Pi restart. Use `sentinel_status` to inspect them
and `sentinel_cancel` when a condition is no longer relevant.
