# @parke.dev/pi-firecrawl

[Firecrawl](https://www.firecrawl.dev/) tools for the
[pi coding agent](https://pi.dev). Turn web pages into clean markdown, search
the web, map a site's URLs, or crawl many pages in one job — against Firecrawl's
hosted API or a self-hosted v1 instance.

Four tools:

| Tool               | What it does                                                      |
| ------------------ | ----------------------------------------------------------------- |
| `firecrawl_scrape` | scrape one URL into markdown (and optional other formats)         |
| `firecrawl_search` | web search; optionally scrape each result page                    |
| `firecrawl_map`    | discover the URLs on a site                                       |
| `firecrawl_crawl`  | crawl linked pages into markdown (async job, polls to completion) |

Requires Pi **0.99.1 or newer**. Ships a [`firecrawl` skill](skills/firecrawl/SKILL.md)
teaching the model when to map-then-scrape versus crawl, and how to bound jobs with `limit`.

## Native codemode

Tools are grouped in the `firecrawl` namespace; callable names stay unchanged.
Native `codemode` receives structured results while normal calls retain text and details:

```js
const result = await tools.firecrawl_map({ url: "https://example.com", limit: 10 });
if (result.refused) return result.error;
return result.links;
```

Scrape returns `{ page }`, search `{ results }`, map `{ links }`, and crawl
`{ jobId, status, completed, total, pages, partial }`. Page content is not shortened
in structured results, even where display text uses snippets. Provider failures
return `isError: true` with `{ refused: true, error }`. A failed crawl also retains
its job status and pages; a timeout returns partial data without an error. Empty
search results are successful. Scrape/search/map are annotated as remote reads;
crawl starts a potentially paid job and is neither read-only nor idempotent.

## Terminal presentation

Native themed rows show URL/query, counts, and completion state. Crawl progress
uses a stable status + completed/total row; waiting, partial timeouts, refusals,
and failures remain distinct from completion. Expand for readable page bodies
(up to 40 display rows plus overflow). This display cap does not change tool text
or structured results.

## Parameters

- `firecrawl_scrape` — `url` (required); `formats?` (`markdown` \| `html` \|
  `rawHtml` \| `links` \| `screenshot` \| `summary`, default `["markdown"]`);
  `onlyMainContent?`; `waitFor?` (ms to wait for the page to load).
- `firecrawl_search` — `query`; `limit?` (default 5); `scrapeResults?` (also
  scrape each result page into markdown).
- `firecrawl_map` — `url`; `search?` (filter/rank discovered URLs); `limit?`.
- `firecrawl_crawl` — `url`; `limit?` (default 10); `maxDepth?`;
  `pollTimeoutSeconds?` (default 120). The job is polled every 3 seconds; on
  timeout the partial pages gathered so far are returned.

## Install

```bash
pi install npm:@parke.dev/pi-firecrawl
```

By default the tools talk to the hosted API at `https://api.firecrawl.dev`,
which needs an API key and consumes credits. Point `baseUrl` at a self-hosted
instance instead and no key is required on a typical local setup. Run
`/firecrawl` in pi to confirm connectivity.

## Configuration

Everything is optional. Precedence is **defaults ← `~/.pi/firecrawl.json` ← environment**.

```json
{
  "baseUrl": "https://api.firecrawl.dev",
  "apiKey": "…",
  "timeoutMs": 120000,
  "crawlTimeoutMs": 120000
}
```

| Field            | Env var                      | Default                     | Meaning                                                                             |
| ---------------- | ---------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| `baseUrl`        | `FIRECRAWL_BASE_URL`         | `https://api.firecrawl.dev` | Firecrawl API origin                                                                |
| `apiKey`         | `FIRECRAWL_API_KEY`          | none                        | sent as `Authorization: Bearer`; required by the hosted API                         |
| `timeoutMs`      | `FIRECRAWL_TIMEOUT_MS`       | 120000                      | reserved — not currently applied to requests                                        |
| `crawlTimeoutMs` | `FIRECRAWL_CRAWL_TIMEOUT_MS` | 120000                      | reserved — crawl wait is controlled per call by `pollTimeoutSeconds` (default 120s) |

### Deployment shapes

**Hosted API** (the default) needs a key and burns credits:

```json
{ "apiKey": "fc-…" }
```

Or `export FIRECRAWL_API_KEY=fc-…`.

**Self-hosted** only needs the origin:

```json
{ "baseUrl": "http://localhost:3002" }
```

## Diagnostics

```
/firecrawl    show config and test connectivity with a scrape of example.com
```

## License

MIT
