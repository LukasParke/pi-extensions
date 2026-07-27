# @parke.dev/pi-background-terminals

Long-running shell commands for the [pi coding agent](https://pi.dev): dev
servers, watchers and builds that keep running while the agent works.

Four tools plus a `/ps` command:

| Tool        | What it does                                                       |
| ----------- | ------------------------------------------------------------------ |
| `bg_start`  | start a command in the background and return immediately           |
| `bg_status` | status plus a truncated tail of recent output                      |
| `bg_list`   | all terminals with status, age and output sizes                    |
| `bg_kill`   | stop one or more terminals (SIGTERM → SIGKILL, whole process tree) |

At most **8** terminals run at once. Starting a ninth fails until something is
killed. Terminals are session-scoped: everything is stopped on shutdown or
reload, so a dev server cannot outlive the session that started it.

Commands get **no stdin** (`stdio` stdin is ignored). Anything that prompts for
input sees EOF immediately rather than hanging — pass credentials via env or
flags instead.

When a terminal exits, its result is delivered automatically as a follow-up
message, so the agent does not need to poll. Calling `bg_status` or `bg_kill` on
an already-finished terminal **consumes** that result and suppresses the
automatic message, so the same outcome is never delivered twice.

Output is retained in memory (bounded per stream); status and completion
messages show a truncated tail of what matters.

Ships with a [`background-terminals` skill](skills/background-terminals/SKILL.md)
that teaches the model when to reach for these tools instead of `bash`.

## Install

```bash
pi install npm:@parke.dev/pi-background-terminals
```

No configuration. The tools work as soon as the package is installed.

## Why not just bash

`bash` blocks the turn until the command finishes. That is correct for
`git status`, a single test file, or a build you intend to wait on.

It is wrong for anything that does not naturally end, or ends much later:

- dev servers (`vite dev`, `next dev`, an API server)
- watchers (`tsc --watch`, `vitest --watch`)
- log tails (`kubectl logs -f`)
- long streaming builds and full test suites

`bg_start` returns immediately with an id. Keep working. You will get a message
when it exits; only call `bg_status` when you need output _now_ (server up
before a request, how far a build has got). Check `bg_list` before starting a
second copy of something that may already be running.

## Diagnostics

```
/ps                 list background terminals (status, age, output sizes)
/ps kill <id>       stop one terminal
```

## License

MIT
