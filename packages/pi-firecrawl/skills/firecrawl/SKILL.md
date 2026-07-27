---
name: firecrawl
description: Use Firecrawl to read the web — firecrawl_scrape for one page as clean markdown, firecrawl_search for web search, firecrawl_map to enumerate a site's URLs, and firecrawl_crawl to scrape many linked pages at once. Use when a task needs page content, a site inventory, or multi-page scraping; note that crawls consume the most API credits.
---

# Firecrawl

Four tools for reading the web. Firecrawl renders JavaScript and strips
boilerplate, so it handles pages a plain HTTP fetch cannot.

| Tool               | Use for                              |
| ------------------ | ------------------------------------ |
| `firecrawl_scrape` | one page's readable content          |
| `firecrawl_search` | web search (title, URL, description) |
| `firecrawl_map`    | discover all URLs on a site, fast    |
| `firecrawl_crawl`  | follow links and scrape many pages   |

## Pick the cheapest tool that answers the question

Against the hosted API every call costs credits, and they are not equal. Work
down this list:

1. **One known URL** → `firecrawl_scrape`. One page, one credit.
2. **Need to find pages first** → `firecrawl_search`, then scrape the specific
   results worth reading. Do not crawl to find one page.
3. **Need the shape of a site** → `firecrawl_map`. It returns URLs only, so it is
   far cheaper than crawling, and often enough to then scrape 2-3 pages.
4. **Genuinely need many pages' content** → `firecrawl_crawl`, with `limit` set.

**Always set `limit` on a crawl.** The default is 10; raising it multiplies both
cost and latency. A crawl that returns 200 pages you do not read is pure waste.
Prefer `map` + targeted `scrape` unless you truly need full text across a site.

## Scrape

```
firecrawl_scrape { url, formats?, onlyMainContent?, waitFor? }
```

- `formats` defaults to `["markdown"]`. Others: `html`, `rawHtml`, `links`,
  `screenshot`, `summary`. Only ask for what you will read — extra formats cost
  context, and `rawHtml` in particular is enormous.
- `onlyMainContent` defaults to true, dropping nav and footers. Set it false only
  when you specifically need chrome, e.g. reading a sidebar's navigation.
- `waitFor` (ms) for late-hydrating pages. If content comes back empty, add a
  wait before concluding the page is broken.

## Search

```
firecrawl_search { query, limit?, scrapeResults? }
```

`scrapeResults: true` scrapes every result in one call. Convenient, but it costs
a scrape per result — leave it false and scrape only what looks relevant unless
you know you need all of them.

## Map and crawl

```
firecrawl_map  { url, search?, limit? }
firecrawl_crawl { url, limit?, maxDepth?, pollTimeoutSeconds? }
```

`map`'s `search` term filters and ranks the discovered URLs, which is the fastest
way to find, say, every docs page mentioning "authentication".

`crawl` is a job: it starts, then polls to completion, reporting progress. Bound
it with both `limit` and `maxDepth`. If it exceeds `pollTimeoutSeconds` you get
the pages completed so far rather than nothing.

## When it fails

Errors are reported with the cause rather than a bare failure:

- **401 / 402 / 403** → missing key, rejected key, or **out of credits**. The
  hosted API needs `FIRECRAWL_API_KEY` or `apiKey` in `~/.pi/firecrawl.json`.
  A 402 specifically means the account is out of credits: stop retrying.
- **Cannot connect** → check the network for the hosted API, or that a
  self-hosted instance is running and `baseUrl` points at it.
- **Timeout** → try a single page instead of a crawl, or raise `crawlTimeoutMs`.

Run `/firecrawl` to check the configured base URL, auth state, and connectivity.
That distinguishes a config problem from a page problem in one step.
