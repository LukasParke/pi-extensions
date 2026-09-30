---
name: firecrawl
description: Use Firecrawl to read the web — firecrawl_map to enumerate a site's URLs, firecrawl_crawl to sweep many linked pages, firecrawl_scrape for a single page, firecrawl_search for web search. Use when a task needs a site inventory, multi-page scraping, page content, or search results; prefer map-then-scrape over a broad crawl.
---

# Firecrawl

Requires Pi 0.99.1+. Firecrawl renders JavaScript, so it handles pages a plain
HTTP fetch cannot.

## Native codemode

Tools are grouped under `firecrawl`; callable names stay unchanged:
`await tools.firecrawl_map({ url, limit })` returns `{ links }`. Scrape returns
`{ page }`, search `{ results }`, and crawl `{ jobId, status, completed, total, pages, partial }`.
These are typed business results, not text to parse; display text and details remain available.
Check `result.refused` before reading success fields. Refusals carry `error` and
set `isError: true`; failed crawls retain job data and pages. Empty search results
and partial crawl timeouts are successes. Scrape/search/map are remote reads;
crawl starts a potentially paid, non-idempotent job, so retry only deliberately.

| Tool               | Use for                              |
| ------------------ | ------------------------------------ |
| `firecrawl_map`    | discover all URLs on a site, fast    |
| `firecrawl_crawl`  | follow links and scrape many pages   |
| `firecrawl_scrape` | one page's readable content          |
| `firecrawl_search` | web search (title, URL, description) |

Terminal rows are display-only: expand for page bodies. A warning crawl row
means waiting or partial timeout, not completion; check `partial` and `status`
in typed results before treating a site inventory as complete.

## Where Firecrawl is strongest

**Anything site-wide.** `map` and `crawl` operate across a whole domain, which single-page
scrapers cannot do at all. If the question is "what pages exist" or "check every doc page
for X", this is the right tool and there is no substitute.

## Pick the narrowest tool that answers the question

Cost is not the issue against a self-hosted instance — **context is**. A broad crawl returns
far more text than you will read, and boilerplate crowds out the content you wanted.

1. **One known URL** → `firecrawl_scrape`.
2. **Need to find pages first** → `firecrawl_search`, then scrape the specific results
   worth reading.
3. **Need the shape of a site** → `firecrawl_map`. It returns URLs only, so it is cheap and
   often enough to then scrape the two or three pages that matter.
4. **Genuinely need text across many pages** → `firecrawl_crawl`, with `limit` set.

**Always set `limit` on a crawl.** The default is 10; raising it multiplies latency and
context. Prefer **`map` then targeted `scrape`** over a broad crawl — you get the same
answer with a fraction of the text.

## Scrape

```
firecrawl_scrape { url, formats?, onlyMainContent?, waitFor? }
```

- `formats` defaults to `["markdown"]`. Others: `html`, `rawHtml`, `links`, `screenshot`,
  `summary`. Only ask for what you will read — `rawHtml` in particular is enormous.
- `onlyMainContent` defaults to true, dropping nav and footers. **Leave it on.** With it
  off, pages with large navigation blocks (Wikipedia's navboxes, for example) can return
  several times more boilerplate than article text.
- `waitFor` (ms) for late-hydrating pages. If content comes back empty, add a wait before
  concluding the page is broken.

### Known weakness: code blocks

Firecrawl's markdown **flattens fenced code blocks and escapes JSX-like syntax** — you get
`onChange\={...}` and `\[dep\]` as prose rather than a fenced block. On a page like React's
`useEffect` reference this mangles every example.

So when the page you need is **code-bearing documentation, and you have another scraper
available, use that instead.** Firecrawl remains the right choice for prose pages, and the
only choice for `map` and `crawl`.

## Search

```
firecrawl_search { query, limit?, scrapeResults? }
```

`scrapeResults: true` scrapes every result in one call. Convenient, but it pulls full text
for results you may not read — leave it false and scrape what looks relevant.

## Map and crawl

```
firecrawl_map  { url, search?, limit? }
firecrawl_crawl { url, limit?, maxDepth?, pollTimeoutSeconds? }
```

`map`'s `search` term filters and ranks the discovered URLs, which is the fastest way to
find, say, every docs page about "authentication".

`crawl` is a job: it starts, then polls to completion, reporting progress. Bound it with
both `limit` and `maxDepth`. If it exceeds `pollTimeoutSeconds` you get the pages completed
so far rather than nothing.

## When it fails

Errors report the cause rather than a bare failure:

- **401 / 402 / 403** → missing or rejected API key. The hosted API needs
  `FIRECRAWL_API_KEY` or `apiKey` in `~/.pi/firecrawl.json`; a 402 means the account is out
  of credits, so stop retrying. A self-hosted instance usually needs no key at all.
- **Cannot connect** → check `baseUrl`, that the instance is running, and that you can
  reach it from this network (VPN if it is private).
- **Timeout** → try a single page instead of a crawl, or raise `crawlTimeoutMs`.

Run `/firecrawl` to check the configured base URL, auth state, and connectivity — that
distinguishes a config problem from a page problem in one step.
