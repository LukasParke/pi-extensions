# @parke.dev/pi-notion

Notion pages and databases: read, search and append, as a Pi extension.

```sh
pi install npm:@parke.dev/pi-notion
```

Ships a [`notion` skill](skills/notion/SKILL.md) teaching the model when to
use the search, page, and append tools and how auth works.

---

## What it does

Six tools:

| Tool                | Purpose                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `notion_search`     | Search/list pages the integration can see, most recently edited first. Params: `query?`, `limit?` (default 25, cap 50). Reports truncation. |
| `notion_page`       | One page as structured blocks; unsupported types are labeled, never dropped. Param: `page` (UUID, with or without dashes).                  |
| `notion_append`     | Append plain-text paragraphs, one per non-empty line — **not** a markdown converter. Confirms first. Params: `page`, `text`, `yes?`.        |
| `notion_status`     | Reachability, credential source, capabilities/refuses. No params.                                                                           |
| `notion_connect`    | Store an internal integration token (interactive confirm only; **no `yes`**). Params: `key`, `label?`.                                      |
| `notion_disconnect` | Remove the stored key; environment variables are untouched. No params.                                                                      |

Run `notion_status` first — it reports what is reachable, which credential is in use, and what this package deliberately will
not do.

`/notion-login` is the masked interactive setup command: it validates the
token against Notion's `me` endpoint and stores it under `notion.default`.

## Credentials

For most interactive coding-agent users, the simplest setup is Notion's
official hosted MCP server at `https://mcp.notion.com/mcp`: it supports browser
OAuth and needs no copied integration token. Use that through
`pi-mcp-adapter` instead of this extension when OAuth is the priority; loading
both creates duplicate tool surfaces.

This REST extension remains useful for its smaller curated tool surface and
explicit write confirmations. Its cleanest setup is interactive and keeps the
secret out of the model conversation:

```text
/notion-login
```

The command uses a masked prompt, validates the credential with the provider, then stores it with `0600` permissions.

`$NOTION_TOKEN` (or `$NOTION_API_KEY`), else `~/.pi/agent/integration-auth.json` — written by `/notion-login`, `0600`, beside Pi's own
`auth.json`.

An integration only sees pages that have been **shared with it**. A page you can see in the browser and the tool cannot is
almost always this, not a bug.

## Blocks are reduced, and say when they are

Notion has around thirty block types. This renders a small set — `heading`
(1–3), `paragraph`, `list` (bulleted/numbered), `quote`, `divider`, and
`code` — and labels the rest `unsupported` with their Notion type rather than
dropping them, because a page that silently omits blocks looks complete when
it is not.

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

**`notion_connect` has no `yes` escape hatch**, deliberately. A flag that skips confirmation on a credential-storing tool is one
injected instruction away from an attacker's token being used for all your writes.

## What it deliberately will not do

Published in `describe().refuses`, and a test asserts each is genuinely absent from the source — so the list cannot become a
lie. Run `notion_status` to see it.

| Not available       | Why                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **delete_page**     | Deleting a page destroys its history and every backlink; that belongs to a human in Notion's own UI.                              |
| **create_database** | A database is a shared schema other people's views and automations depend on.                                                     |
| **modify_schema**   | Renaming a property or changing its type quietly breaks every filter, rollup and integration keyed on the old one.                |
| **admin**           | Workspace membership, permissions and billing are not page content; this package holds a content token and does not broker admin. |

## Using it from your own code

`src/` has no Pi dependency, so a UI can render its view models without going through a tool call:

```ts
import { NOTION_DESCRIPTION } from "@parke.dev/pi-notion";
```

`NOTION_DESCRIPTION` declares every segment, every field on a row, and every refusal — so a UI can render a panel for
this provider with no provider-specific code, and a conformance test fails the build if it stops being true.

## Status words, never colour alone

Every status is a word a reader can read. Colour is decoration on top. A red dot says nothing to a screen reader, and nothing
to someone who cannot distinguish it from the green one.
