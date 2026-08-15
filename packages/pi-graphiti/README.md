# @parke.dev/pi-graphiti

Shared [Graphiti](https://github.com/getzep/graphiti) memory for the [Pi coding agent](https://pi.dev):
non-blocking, conversation-aware recall delivered through the dispatch queue, explicit
`memory_remember` / `memory_recall` / `memory_status` tools, and a direct MCP-over-HTTP
connection — no gateway in the middle.

```sh
pi install npm:@parke.dev/pi-graphiti
```

## What it does

- **Background recall** — recall never blocks a turn. `before_agent_start`
  only appends the store policy to the system prompt; the actual graph search
  runs off the turn path on `before_agent_start` and `agent_settled`, and new
  facts arrive as one folded dispatch item (`graphiti:recall`) at the next
  turn boundary via `@parke.dev/pi-dispatch`.
- **Conversation-aware queries** — the recall query is built from the latest
  user message plus the tail of the last assistant reply and recent tool
  activity, not the raw prompt alone.
- **Delta filter + TTL cache** — facts already surfaced this session (including
  manual `memory_recall` results) are never re-injected, and identical queries
  are served from an in-memory cache (`recallCacheTtlMs`) instead of hitting
  the server again.
- **Explicit tools** — `memory_recall` (facts / nodes / episodes),
  `memory_remember` (one episode per fact), `memory_status` (health).

  | Tool              | Parameters                                                                                                              |
  | ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
  | `memory_recall`   | `query` (ignored in `episodes` mode); `mode?` `facts` \| `nodes` \| `episodes` (default `facts`); `limit?` (default 10) |
  | `memory_remember` | `name`, `body`, `source_description?`                                                                                   |
  | `memory_status`   | none — JSON health payload                                                                                              |

  Manual `memory_recall` results are marked seen, so they are not re-injected
  by auto-recall. `memory_remember` also suppresses the pending store reminder.

- **Store policy + reminder** — a short system-prompt block instructs the model
  to store durable outcomes before finishing; if a session settles 10+ turns
  without a single `memory_remember`, a one-shot dispatch reminder
  (`graphiti:store-reminder`) nudges the agent. It fires at most once per
  session and is suppressed as soon as something is remembered.
- **Health signal** — the footer shows `memory unavailable: ...` when the
  server is unreachable; the session-start check is fire-and-forget and never
  delays the session.

## Configuration

`~/.pi/graphiti.json` or environment (`defaults ← file ← env`):

| Field                       | Env                               | Default  | Notes                                                                |
| --------------------------- | --------------------------------- | -------- | -------------------------------------------------------------------- |
| `baseUrl`                   | `GRAPHITI_BASE_URL`               | —        | **Required.** MCP endpoint, e.g. `https://memory.example.com/mcp`    |
| `apiKey`                    | `GRAPHITI_API_KEY`                | —        | Sent as `Authorization: Bearer`                                      |
| `groupId`                   | `GRAPHITI_GROUP_ID`               | `main`   | Graph group for all reads/writes                                     |
| `timeoutMs`                 | `GRAPHITI_TIMEOUT_MS`             | `15000`  | Per-request timeout                                                  |
| `autoRecallFacts`           | `GRAPHITI_AUTO_RECALL_FACTS`      | `5`      | Facts surfaced per recall; `0` disables auto-recall                  |
| `autoRecallMinPromptLength` | `GRAPHITI_AUTO_RECALL_MIN_PROMPT` | `24`     | User messages shorter than this skip auto-recall                     |
| `recallCacheTtlMs`          | `GRAPHITI_RECALL_CACHE_TTL_MS`    | `120000` | In-memory TTL for identical recall queries; skips repeat server hits |

```json
{
  "baseUrl": "https://memory.parke.dev/mcp",
  "apiKey": "…"
}
```

## Server

Works against the standard [graphiti MCP server](https://github.com/getzep/graphiti/tree/main/mcp_server)
speaking streamable HTTP. The client handles both plain-JSON and SSE-framed
responses and transparently re-initializes when the server session expires.

## Design notes

- Uses `@parke.dev/pi-ext-config` for config loading and
  `@parke.dev/pi-dispatch` for delivery of recalled facts and reminders.
- One session-scoped MCP session; closed on `session_shutdown`.
- Recall is fully off the turn path: hooks return synchronously, at most one
  search is in flight (a new trigger replaces the pending query, latest wins),
  and failures are silent by design — memory assists, it never gates.
- Ships a [`graphiti-memory` skill](skills/graphiti-memory/SKILL.md) teaching
  when to recall explicitly and what to store.

## License

MIT
