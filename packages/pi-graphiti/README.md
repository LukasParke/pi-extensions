# @parke.dev/pi-graphiti

Shared [Graphiti](https://github.com/getzep/graphiti) memory for the [Pi coding agent](https://pi.dev):
automatic recall on every prompt, explicit `memory_remember` / `memory_recall` /
`memory_status` tools, and a direct MCP-over-HTTP connection — no gateway in
the middle.

```sh
pi install npm:@parke.dev/pi-graphiti
```

## What it does

- **Auto-recall** — each substantive user prompt is searched against the
  graph (`search_memory_facts`); the top facts are injected as a visible
  context message before the agent starts. Best-effort: a slow or down graph
  never blocks the turn.
- **Explicit tools** — `memory_recall` (facts / nodes / episodes),
  `memory_remember` (one episode per fact), `memory_status` (health).
- **Store policy** — a short system-prompt block instructs the model to store
  durable outcomes before finishing and to never store secret values.
- **Health signal** — the footer shows `memory unavailable: ...` when the
  server is unreachable at session start.

## Configuration

`~/.pi/graphiti.json` or environment (`defaults ← file ← env`):

| Field                       | Env                               | Default | Notes                                                             |
| --------------------------- | --------------------------------- | ------- | ----------------------------------------------------------------- |
| `baseUrl`                   | `GRAPHITI_BASE_URL`               | —       | **Required.** MCP endpoint, e.g. `https://memory.example.com/mcp` |
| `apiKey`                    | `GRAPHITI_API_KEY`                | —       | Sent as `Authorization: Bearer`                                   |
| `groupId`                   | `GRAPHITI_GROUP_ID`               | `main`  | Graph group for all reads/writes                                  |
| `timeoutMs`                 | `GRAPHITI_TIMEOUT_MS`             | `15000` | Per-request timeout                                               |
| `autoRecallFacts`           | `GRAPHITI_AUTO_RECALL_FACTS`      | `5`     | Facts injected per prompt; `0` disables auto-recall               |
| `autoRecallMinPromptLength` | `GRAPHITI_AUTO_RECALL_MIN_PROMPT` | `24`    | Prompts shorter than this skip auto-recall                        |

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

- Uses `@parke.dev/pi-ext-config` for config loading.
- One session-scoped MCP session; closed on `session_shutdown`.
- Auto-recall failures are silent by design — memory assists, it never gates.
- Ships a skill teaching when to recall explicitly and what to store.

## License

MIT
