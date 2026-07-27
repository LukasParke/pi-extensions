# @parke.dev/pi-steel

[Steel browser](https://github.com/steel-dev/steel-browser) tools for the
[pi coding agent](https://pi.dev). Steel runs a real Chromium, so these tools
read JavaScript-rendered pages that a plain HTTP fetch cannot.

Nine tools in two tiers:

**One-shot** — stateless, one fresh page per call:

| Tool | What it does |
|---|---|
| `steel_scrape` | page content as markdown (or readability / cleaned HTML / raw HTML) |
| `steel_search` | web search, run from your Steel host rather than a third-party API |
| `steel_screenshot` | returns the rendered image |
| `steel_pdf` | renders to a PDF file |

**Persistent session** — one browser driven across turns, keeping cookies, so it
can get behind a login:

| Tool | What it does |
|---|---|
| `steel_session` | `start` / `status` / `end` |
| `steel_navigate` | go to a URL, return settled page text |
| `steel_act` | click / type / press / select / scroll / wait |
| `steel_read` | read the page as text, links, or **forms with selectors** |
| `steel_look` | screenshot the current page |

Ships with a [`steel-browser` skill](skills/steel-browser/SKILL.md) that teaches
the model when to use which tier and, critically, to discover selectors with
`steel_read { mode: "forms" }` before acting.

## Install

```bash
pi install npm:@parke.dev/pi-steel
```

You also need a Steel instance. The quickest is Steel's own single-container
image, which is what this package targets by default:

```bash
docker run -d -p 3000:3000 -p 9223:9223 ghcr.io/steel-dev/steel-browser:latest
```

With that running, the tools work with no configuration at all. Run `/steel` in
pi to confirm.

## Configuration

Everything is optional. Precedence is **defaults ← `~/.pi/steel.json` ← environment**.

```json
{
  "baseUrl": "http://localhost:3000",
  "cdpUrl": "http://localhost:9223",
  "apiKey": "…",
  "timeoutMs": 90000,
  "screenshotTimeoutMs": 120000,
  "sessionTimeoutMs": 1800000,
  "maxInlineImageBytes": 1500000
}
```

| Field | Env var | Default | Meaning |
|---|---|---|---|
| `baseUrl` | `STEEL_BASE_URL` | `http://localhost:3000` | REST API origin |
| `cdpUrl` | `STEEL_CDP_URL` | falls back to `baseUrl` | DevTools Protocol origin, used by the session tools |
| `apiKey` | `STEEL_API_KEY` | none | sent as both `x-api-key` and `Authorization: Bearer` |
| `timeoutMs` | `STEEL_TIMEOUT_MS` | 90000 | scrape / search timeout |
| `screenshotTimeoutMs` | `STEEL_SCREENSHOT_TIMEOUT_MS` | 120000 | screenshot / PDF timeout |
| `sessionTimeoutMs` | `STEEL_SESSION_TIMEOUT_MS` | 1800000 | session lifetime requested from Steel |
| `maxInlineImageBytes` | `STEEL_MAX_INLINE_IMAGE_BYTES` | 1500000 | above this, images go to a file instead of the transcript |

A malformed value is ignored in favour of the default rather than breaking
startup, so a typo in one field cannot take the extension down.

### Deployment shapes

**Single container** (the default above) serves REST and CDP on the same origin,
so `cdpUrl` can stay unset.

**docker-compose** exposes them separately. Set both:

```json
{ "baseUrl": "http://localhost:3000", "cdpUrl": "http://localhost:9223" }
```

**Steel cloud** needs a key:

```json
{ "baseUrl": "https://api.steel.dev", "apiKey": "…" }
```

**Behind a reverse proxy**, two things bite:

1. Chromium rejects DevTools HTTP requests whose `Host` header is neither an IP
   nor `localhost`. Your proxy must rewrite `Host` to `localhost` on the CDP
   route, or the session tools fail to attach.
2. With that rewrite in place, Steel advertises `ws://localhost/...` as its
   WebSocket URL. The client swaps the authority back to your real host
   automatically, so no extra config is needed.

## Security

**Do not expose the CDP port (9223) to the public internet.** It is effectively
unauthenticated remote code execution — Steel's own docs say the same. Keep it on
localhost or a private network. The REST API is the part that is safe to publish
behind an API key.

## Diagnostics

```
/steel            base URL, CDP URL, health, auth state, live sessions
/steel-session    show the live session, or `end` to release it
```

If the one-shot tools work but the session tools cannot attach, REST is reachable
and CDP is not — check `cdpUrl` and the `Host` rewrite above.

## License

MIT
