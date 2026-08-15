# @parke.dev/pi-gauntlet

A goal / gauntlet loop for the [pi coding agent](https://pi.dev). Set a **goal**
plus a **gauntlet** — named shell checks that must all exit 0 (tests,
typecheck, lint, anything). After each agent run settles, the extension runs
the gauntlet; failures are injected back into the conversation and the agent
keeps iterating until the whole gauntlet passes, max iterations are hit, or
you stop it.

While the loop is active a widget shows the goal, the iteration count, and a
`✓ / ✗ / ·` state per check.

## Install

```bash
pi install npm:@parke.dev/pi-gauntlet
```

Ships a [`gauntlet` skill](skills/gauntlet/SKILL.md) teaching the model when
to `start` versus `run`, and not to start a loop without checks.

## Usage

Slash commands:

```
/gauntlet add tests npm test
/gauntlet add types npx tsc --noEmit
/gauntlet                      # list checks with last status
/gauntlet rm types

/goal make the refactor land cleanly   # set goal, start the loop
/goal                                  # same as status
/goal status                           # goal, iteration, per-check state
/goal stop                             # stop the loop
```

The same surface is available to the model through the `gauntlet` tool, so
"keep going until the tests pass" works in prose:

| Action         | Fields            | Effect                                                                        |
| -------------- | ----------------- | ----------------------------------------------------------------------------- |
| `add_check`    | `name`, `command` | Add or replace a named check                                                  |
| `remove_check` | `name`            | Remove a check                                                                |
| `start`        | `goal`            | Set the goal and start the loop (`goal` may be omitted if one is already set) |
| `stop`         | —                 | Stop the loop                                                                 |
| `status`       | —                 | Goal, iteration, per-check state                                              |
| `run`          | —                 | Run all checks once, return results, without the loop                         |

Checks run via `bash -lc` in the project cwd, sequentially, each with its own
timeout. State (goal, checks, iteration, last results) is stored in session
entries, so resuming or branching a session carries the loop with it.

### Project seed

A trusted project can seed initial checks with `.pi/gauntlet.json`:

```json
{
  "checks": {
    "tests": "npm test",
    "types": "npx tsc --noEmit"
  }
}
```

The seed only applies when the session has no gauntlet state of its own, and
only when `ctx.isProjectTrusted()` is true. Session state always wins.

## Configuration

Defaults ← `~/.pi/gauntlet.json` ← environment.

| Field            | Default  | Env                            | Notes                              |
| ---------------- | -------- | ------------------------------ | ---------------------------------- |
| `maxIterations`  | `10`     | `PI_GAUNTLET_MAX_ITERATIONS`   | Failures injected before giving up |
| `checkTimeoutMs` | `300000` | `PI_GAUNTLET_CHECK_TIMEOUT_MS` | Per-check timeout                  |

## Security note

**This extension runs arbitrary shell commands automatically, without asking,
on every settled agent run while the loop is active.** That is the point of a
gauntlet — but it means check commands should be treated like `postinstall`
scripts. Project seeds (`.pi/gauntlet.json`) are therefore only loaded in
trusted projects, and a malicious or careless check (e.g. one that hangs, or
mutates state) will run unattended up to `maxIterations` times. Keep checks
read-only-ish: build, test, lint, verify.

## Design decisions

- **Exit-0 shell checks, nothing fancier.** Every project already expresses
  "is this good?" as commands — tests, typecheck, lint, a curl against a dev
  server. Reusing that means no new DSL, no per-project plugin, and the same
  command the user runs by hand is the command the loop runs.
- **`followUp` injection.** Failure reports are sent with
  `deliverAs: "followUp"` + `triggerTurn`, so a report never interrupts a turn
  mid-tool-call: it lands exactly when the agent has no more work queued, and
  immediately starts the next iteration. The report itself is the goal
  reminder plus each failing check's name, exit code, and a ~2KB output tail —
  enough to act on, small enough to keep context healthy.
- **Session-scoped checks.** Checks live in session entries, not on disk, so
  branching or resuming a session carries the loop with it and nothing leaks
  between projects. The optional `.pi/gauntlet.json` seed exists for projects
  that want a standing gauntlet, gated behind project trust.
- **The loop pauses on abort.** If a check run is aborted (Esc), the loop does
  not immediately re-trigger. `/goal stop` is the explicit escape hatch.

## License

MIT
