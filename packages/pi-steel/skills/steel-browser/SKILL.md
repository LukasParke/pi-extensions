---
name: steel-browser
description: Drive a Steel browser — steel_scrape/steel_search/steel_screenshot/steel_pdf for one-shot page reads, and the persistent session (steel_session/steel_navigate/steel_act/steel_read/steel_look) for logins, forms, and multi-step flows. Use for reading JavaScript-rendered pages, searching the web, capturing screenshots or PDFs, or interacting with a site that needs authentication.
---

# Steel Browser

Steel runs a real Chromium, so it executes JavaScript — use it for SPAs and
client-rendered pages where a plain HTTP fetch returns an empty shell.

There are two tiers. Pick deliberately: the one-shot tools are cheap and
stateless, the session is expensive and stateful.

## One-shot tools

Each call gets a fresh page. Nothing persists, so **anything behind a login is
unreachable** with these.

- `steel_scrape { url, format?, delay?, includeLinks? }` — page content.
  `format` defaults to `["markdown"]`; `readability`, `cleaned_html`, and `html`
  are also available. Returns metadata (title, status, word count) plus content.
- `steel_search { query, limit? }` — titles, URLs, snippets. The query runs from
  wherever Steel is hosted, so it does not require a third-party search API key.
- `steel_screenshot { url, fullPage?, delay? }` — returns the image so you can
  actually look at the rendered page. Large images are written to a file instead
  of inlined, to protect the context window.
- `steel_pdf { url, output?, delay? }` — paginated snapshot written to a file.

Use `delay` (ms, max 30000) for pages that hydrate late. **If a scrape comes back
suspiciously empty, add a delay before concluding the page is broken** — that is
the single most common false alarm.

## Persistent session

Use this when the task needs a login, a form filled, a click, or several steps of
accumulated state. Cookies and storage persist across calls.

**Exactly one session is live at a time**, and a browser is expensive. Lifecycle:

```
steel_session { action: "start" }     # no-op if one is already live
steel_navigate { url, waitMs? }       # returns the settled page's visible text
steel_read { mode: "forms" }          # DISCOVER SELECTORS before acting
steel_act { action: "type", selector: "#user", text: "…" }
steel_act { action: "click", selector: "button[type=submit]" }
steel_look                            # screenshot to confirm the new state
steel_session { action: "end" }       # release the browser when finished
```

### Read the forms before you act

This is the ordering rule that matters most: **call `steel_read` with
`mode:'forms'` before `steel_act`.** Do not invent CSS selectors. `forms` mode
returns the actual input and button selectors present on the page. Guessing
produces either a hard "requires a selector" error or — worse — a silent click on
the wrong element that you then have to debug.

### steel_act

| action   | needs                             | notes                                        |
| -------- | --------------------------------- | -------------------------------------------- |
| `click`  | `selector`                        |                                              |
| `type`   | `selector`, `text`                | clears the field first unless `clear: false` |
| `select` | `selector`, `text` (option value) |                                              |
| `press`  | `text` (key, e.g. `Enter`)        | sends a real key event                       |
| `scroll` | —                                 |                                              |
| `wait`   | —                                 | just settles                                 |

`waitMs` settles after the action, defaulting to 1000.

### steel_read

Modes: `text` (default, visible text), `links` (anchors), `forms` (actionable
elements plus their selectors), `all`. Pass `selector` to scope extraction and
save context. Output is structured text, never raw DOM — raw HTML burns context
for no benefit.

### Verify state changed

After a login or a submit, use `steel_look` or `steel_read` to confirm the page
actually changed. Do not assume a click landed. A failed login that looks like a
success is the most expensive mistake in a multi-step flow.

### Cleanup

Sessions time out on their own (30 minutes by default) and are released when the
pi session shuts down, so a crash cannot leak a live browser. Still call
`action: "end"` when finished — it frees the browser immediately.

`action: "status"` reports whether a session is live and its current URL. The
start and status output include a viewer URL you can hand to the user to watch
the browser live, which is genuinely useful when a flow is misbehaving.

## When Steel is unreachable

The tools report the cause rather than a bare `fetch failed`:

- **Cannot connect, local config** → no instance is running. Start one:
  `docker run -p 3000:3000 -p 9223:9223 ghcr.io/steel-dev/steel-browser:latest`
- **Cannot connect, remote config** → check the host, that the instance is up,
  and that you can reach it from this network (VPN if it is private).
- **401 / 403** → the instance wants an API key. Set `STEEL_API_KEY` or `apiKey`
  in `~/.pi/steel.json`. If a key is already set, it was rejected — check it
  matches the instance.

Run `/steel` to see the configured base URL, CDP URL, health, auth state, and
live sessions. That is the fastest way to tell a config problem from a page
problem.

Interactive actions go over the Chrome DevTools Protocol. If the session tools
cannot attach but the one-shot tools work, the REST API is reachable and CDP is
not — check `cdpUrl` (split docker-compose deployments serve CDP on port 9223,
and a reverse proxy must rewrite the `Host` header to `localhost`).
