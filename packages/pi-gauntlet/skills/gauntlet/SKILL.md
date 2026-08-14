---
name: gauntlet
description: Drive the goal/gauntlet loop with the gauntlet tool — named shell checks (tests, typecheck, lint) that must all exit 0. Use when the user asks you to keep working until checks pass, sets a goal with a gauntlet, or wants one-shot verification via the run action.
---

# Gauntlet

A goal + check loop. Named shell checks must all exit 0; while the loop is
active, every settled agent run re-runs the checks and injects failures back
into the conversation until they pass, max iterations are hit, or the loop is
stopped.

## When to use it

- The user says "keep going until tests/typecheck/lint pass" — add the checks,
  then `start` with the goal.
- The user asks for a one-off verification — `run` executes the checks once and
  returns structured results without starting the loop.

Do not start the loop without checks defined; `start` refuses. Prefer 1–3
meaningful checks (e.g. `npm test`, `tsc --noEmit`) over a long list.

## Actions

| Action         | Required fields   | Effect                                                      |
| -------------- | ----------------- | ----------------------------------------------------------- |
| `add_check`    | `name`, `command` | Add or replace a named check                                |
| `remove_check` | `name`            | Remove a check                                              |
| `start`        | `goal`            | Set the goal and start the loop                             |
| `stop`         | —                 | Stop the loop                                               |
| `status`       | —                 | Goal, iteration, per-check state                            |
| `run`          | —                 | Run all checks once, return per-check exit codes and output |

`run` reports `passed` plus per-check results in `details`; failing checks
include a tail of their output. Fix what it reports before starting a loop.

## Notes

- Checks run via `bash -lc` in the project cwd and can be slow — the default
  per-check timeout is 5 minutes.
- The loop caps iterations (default 10) and then stops on its own; if it
  exhausts, re-scope the goal instead of restarting blindly.
- Users can do the same from the TUI with `/gauntlet add …` and `/goal …`.
