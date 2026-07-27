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

| Field            | Env var                      | Default                     | Meaning                                                     |
| ---------------- | ---------------------------- | --------------------------- | ----------------------------------------------------------- |
| `baseUrl`        | `FIRECRAWL_BASE_URL`         | `https://api.firecrawl.dev` | Firecrawl API origin                                        |
| `apiKey`         | `FIRECRAWL_API_KEY`          | none                        | sent as `Authorization: Bearer`; required by the hosted API |
| `timeoutMs`      | `FIRECRAWL_TIMEOUT_MS`       | 120000                      | request timeout for scrape / search / map                   |
| `crawlTimeoutMs` | `FIRECRAWL_CRAWL_TIMEOUT_MS` | 120000                      | how long to poll a crawl job before giving up               |

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
