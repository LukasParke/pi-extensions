# @parke.dev/pi-dashboard

Optional TUI header/footer dashboard for the [Pi coding agent](https://pi.dev).

**Default is off.** Installing the package does not replace stock UI and starts
no pollers — enabling the dashboard is an explicit opt-in.

Inspired by [Ben Davis](https://github.com/davis7dotsh) /
[my-pi-setup](https://github.com/davis7dotsh/my-pi-setup) — this is an
independent implementation, not a fork.

## Install

```bash
pi install npm:@parke.dev/pi-dashboard
```

## Opt-in 1 — enable the dashboard

Write `~/.pi/dashboard.json`:

```json
{
  "enabled": true
}
```

Or set `PI_DASHBOARD_ENABLED=true` for a single shell.

### Settings

Resolves **defaults ← `~/.pi/dashboard.json` ← environment**.

| Field            | Env                    | Default | Notes                                              |
| ---------------- | ---------------------- | ------- | -------------------------------------------------- |
| `enabled`        | `PI_DASHBOARD_ENABLED` | `false` | Master switch. Off = stock UI, no timers.          |
| `header`         | `PI_DASHBOARD_HEADER`  | `true`  | Replace the TUI header when enabled.               |
| `footer`         | `PI_DASHBOARD_FOOTER`  | `true`  | Replace the TUI footer when enabled.               |
| `showPr`         | `PI_DASHBOARD_SHOW_PR` | `true`  | Look up an open PR via `gh` (cached, silent fail). |
| `pollIntervalMs` | `PI_DASHBOARD_POLL_MS` | `60000` | External Git/PR poll interval; lifecycle events refresh immediately. |
| `title`          | `PI_DASHBOARD_TITLE`   | —       | Optional header / window title override.           |

## What the footer shows

When enabled, two lines above the editor:

1. current working directory · provider/model · thinking level
2. compaction-aware context `%` / window · **full** session cost · live tok/s ·
   git branch · changed file count · optional open PR hyperlink

Full session cost folds assistant messages, tool-result usage (e.g. delivered
subagent runs), and compaction / branch-summary usage — the same sources Pi's
native footer uses.

Extension status rows from other packages (`ctx.ui.setStatus`) still render
below those two lines via `footerData`. With the companion packages installed,
this includes actionable counts for subagents, workflows, and background
terminals, plus the hostname of a live Steel browser session. Their richer
`/subagents`, `/workflows`, `/ps`, and `/steel-session` UIs remain available.

## Design notes

- Uses `@parke.dev/pi-ext-config` for config loading.
- Reuses `@parke.dev/pi-git` **library** helpers for git state only — does not
  load or register that package's tools.
- PR lookup shells out to `gh`, is cached per branch, and fails silently.
- Startup is non-blocking; polls coalesce; a generation counter drops stale
  work after reload / session switch.
- External strings are sanitized; widths are ANSI-aware.
- One extension, plain async. No tools, so no skill.

## License

MIT
