# @parke.dev/pi-slack

Slack channels, threads and messages, as a Pi extension.

```sh
pi install npm:@parke.dev/pi-slack      # once published
```

---

## What it does

Run `slack_status` first — it reports what is reachable, which credential is in use, and what this package deliberately will
not do.

## Credentials

Slack has an official hosted MCP server with OAuth, but generic clients cannot
just dynamically register: Slack requires a fixed registered app identity and
confidential OAuth credentials, plus workspace admin approval. Use that route
when you already have an approved Slack app/client ID. For a portable Pi
installation, this token-backed REST extension remains the simplest generic
fallback.

The cleanest REST setup is interactive and keeps the secret out of the model conversation:

```text
/slack-login
```

The command uses a masked prompt, validates the credential with the provider, then stores it with `0600` permissions.

`$SLACK_BOT_TOKEN` (or `$SLACK_TOKEN`), else `~/.pi/agent/integration-auth.json` — written by `/slack-login`, `0600`, beside Pi's own
`auth.json`.

`slack_search` needs a **user** token with `search:read`; a bot token surfaces as a permission error rather than an empty result
list, because "no matches" and "your token cannot search" are different answers.

## Slack returns HTTP 200 for errors

`{"ok": false, "error": "channel_not_found"}` with a 200 status, so HTTP success means nothing. Every call checks `ok` —
without it a permissions failure becomes an empty channel list.

## Writes ask first

Every write calls Pi's `ctx.ui.confirm` and shows you the full text before anything leaves your machine. While a
confirmation is open, the extension emits `herdr:blocked` on Pi's extension event bus so external supervisors can see that
the agent is waiting for a human. The signal is released when the dialog settles and is a no-op without a listener.

| Where you are                         | What happens                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| A Pi TUI session                      | a confirmation dialog                                                                  |
| A host app speaking Pi's RPC protocol | the request arrives as `extension_ui_request`; the app renders it however it likes     |
| `pi -p` (non-interactive)             | **refused**, because nobody can be asked. Pass `yes: true` if you have already decided |

That last row matters: in print mode `ctx.ui.confirm` returns `false` without prompting, so a naive implementation would report
"you declined" when nobody was ever asked. This one tells you which happened.

**`slack_connect` has no `yes` escape hatch**, deliberately. A flag that skips confirmation on a credential-storing tool is one
injected instruction away from an attacker's token being used for all your writes.

## What it deliberately will not do

Published in `describe().refuses`, and a test asserts each is genuinely absent from the source — so the list cannot become a
lie. Run `slack_status` to see it.

## Using it from your own code

`src/` has no Pi dependency, so a UI can render its view models without going through a tool call:

```ts
import { SLACK_DESCRIPTION } from "@parke.dev/pi-slack";
```

`SLACK_DESCRIPTION` declares every segment, every field on a row, and every refusal — so a UI can render a panel for
this provider with no provider-specific code, and a conformance test fails the build if it stops being true.

## Status words, never colour alone

Every status is a word a reader can read. Colour is decoration on top. A red dot says nothing to a screen reader, and nothing
to someone who cannot distinguish it from the green one.
