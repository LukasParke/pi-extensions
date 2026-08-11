# @parke.dev/pi-sentinel

Cost-aware external-state monitoring for the [Pi coding agent](https://pi.dev).
Sentinel polls or streams shell commands extension-side, wakes the model only for
meaningful transitions, and prevents babysitting tasks from being declared
complete before their criteria pass.

| Tool              | What it does                                                                 |
| ----------------- | ---------------------------------------------------------------------------- |
| `sentinel_watch`  | Poll a command, or stream one blocking process until it exits                |
| `sentinel_sleep`  | Schedule a replaceable wakeup after a duration or at an ISO-8601 time        |
| `sentinel_gate`   | Require every session criterion to pass, optionally for a quiet time         |
| `sentinel_status` | Show watches, sleeps, gate state, output snippets, and poll ETAs             |
| `sentinel_cancel` | Cancel one sentinel, the gate, or everything, including queued notifications |

## Install

```bash
pi install npm:@parke.dev/pi-sentinel
```

No configuration is required.

## Why wakeups are expensive

Polling and process monitoring happen extension-side without model tokens. The
expensive operation is waking the model: even a tiny wakeup message causes the
provider to read the session context again. A large cached context can cost far
more than the message itself, and may be fully re-billed after the cache TTL.

Sentinel therefore optimizes for fewer, better-timed turns:

- events firing together are coalesced into one message after a two-second debounce;
- every wakeup includes a compact snapshot of active sentinels, avoiding a follow-up status call;
- low-priority `next-turn` events wait for the next natural model turn;
- blocking commands can run once in stream mode, eliminating poll latency;
- replacing or cancelling a sentinel drops stale undelivered notifications.

## Watches

A command passes by default when it exits `0`. `done_when` can instead use one
predicate:

```json
{ "exit_code": 2 }
{ "output_contains": "ready" }
{ "output_json": { "path": "checks.pending", "equals": 0 } }
```

JSON paths are dot-separated object keys. Put arrays, comparisons, and other
complex logic in the command itself with tools such as `jq`.

### Stream mode

Prefer `mode: "stream"` when the underlying tool already blocks until completion:

```json
{
  "name": "pr-checks",
  "command": "gh pr checks 123 --watch",
  "mode": "stream",
  "timeout_s": 1800
}
```

Stream watches spawn the shell command once, capture its final output, evaluate
`done_when` when it exits, and wake immediately. Cancellation, timeout, and
session shutdown terminate the child process. At most four stream watches may
run concurrently.

Use poll mode for snapshot-style commands that return immediately. Polls run
only while the agent is idle, default to a 60-second interval, and each command
invocation is killed after 30 seconds. `wake_on_change` emits when stdout
changes.

## Urgency

`sentinel_watch` accepts `urgency: "wake" | "next-turn"`; the default is
`"wake"`. Wake events use a follow-up message that triggers a model turn.
Next-turn events use the same follow-up delivery without `triggerTurn`, so they
ride along with the next natural turn instead of paying for a context re-read.

Gate criterion flips default to `next-turn`. Gate `ALL PASS` defaults to `wake`.
Set criterion or gate `urgency` explicitly to override those defaults.

## Replaceable sleeps

An unnamed `sentinel_sleep` always occupies the fixed `"sleep"` slot. Calling
it again replaces the pending unnamed sleep instead of stacking another timer.
A named sleep occupies its own slot and a later sleep with the same name replaces
it. Re-sleep loops are safe: only the latest pending deadline for each name can
wake the model.

## Completion gates

A gate passes when every criterion passes and, if `quiet_for_s` is set, remains
passing for that whole window. Criterion flips are normally queued for the next
natural turn; a clear `SENTINEL GATE: ALL PASS` wakes immediately. While a gate
is open, its task is not done.

See the bundled [`sentinel` skill](skills/sentinel/SKILL.md) for blocking-command
PR babysitting recipes.

## Cancellation and delivery

`sentinel_cancel` removes the sentinel and any of its queued, undelivered events.
Replacing a sleep or gate does the same for the old registration. A watch that
completed and was not cancelled still delivers its result because completion is
information.

Sentinels are session-scoped and in-memory. Session shutdown cancels timers and
stream processes; sentinels do not survive a Pi restart.

Probe output is capped before being sent to the model, retaining both the head
and tail. The footer status and editor widget show active watches, sleeps, and
gate progress.

## License

MIT
