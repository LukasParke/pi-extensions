# @parke.dev/pi-sentinel

Criteria-gated wakeups for the [Pi coding agent](https://pi.dev). Sentinel polls
shell probes without spending model tokens, wakes the agent only on meaningful
transitions, and prevents babysitting tasks from being declared complete before
their criteria pass.

| Tool              | What it does                                                         |
| ----------------- | -------------------------------------------------------------------- |
| `sentinel_watch`  | Poll a command until it passes, changes, or times out                |
| `sentinel_sleep`  | Wake after a duration or at an ISO-8601 time                         |
| `sentinel_gate`   | Require every session criterion to pass, optionally for a quiet time |
| `sentinel_status` | Show watches, sleeps, gate state, output snippets, and poll ETAs     |
| `sentinel_cancel` | Cancel one sentinel, the gate, or everything                         |

## Install

```bash
pi install npm:@parke.dev/pi-sentinel
```

No configuration is required.

## Predicates

A command passes by default when it exits `0`. `done_when` and `pass_when` can
instead use exactly one small predicate:

```json
{ "exit_code": 2 }
{ "output_contains": "ready" }
{ "output_json": { "path": "checks.pending", "equals": 0 } }
```

JSON paths are dot-separated object keys. Put arrays, comparisons, and other
complex logic in the command itself with tools such as `jq`, then use the
command's exit code as the predicate.

`sentinel_watch` polls every 60 seconds by default. Set `wake_on_change` to wake
when stdout changes, or `timeout_s` to expire and wake instead of silently
stopping. Each command invocation is killed after 30 seconds so a hung probe
cannot wedge the scheduler. Polls run only while the agent is idle and are
rechecked when it settles.

## Completion gates

A gate passes when every criterion passes and, if `quiet_for_s` is set, remains
passing for that whole window. The agent is woken for pass/fail flips and for a
clear `SENTINEL GATE: ALL PASS` transition. While a gate is open, its task is
not done.

See the bundled [`sentinel` skill](skills/sentinel/SKILL.md) for a PR
babysitting recipe covering CI, unresolved review threads, and a ten-minute
quiet window.

## Lifecycle

Sentinels are session-scoped and in-memory. They are removed on session
shutdown or reload and **do not survive a Pi restart**. Persistent restoration
may be added in a future version.

Probe output is capped before being sent to the model, retaining both the head
and tail. The footer status and editor widget show active watches, sleeps, and
gate progress.

## License

MIT
