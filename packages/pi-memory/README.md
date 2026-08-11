# @parke.dev/pi-memory

The canonical local-memory engine and Pi extension.

```sh
pi install npm:@parke.dev/pi-memory
```

## Pi tools

- `memory_remember` stores one durable fact.
- `memory_recall` combines semantic and exact-token retrieval.
- `memory_forget` tombstones one entry by ID.
- `memory_stats` reports store and embedding health.

Pi data follows `PI_CODING_AGENT_DIR` and defaults to `~/.pi/agent/circle-memory.db`. The legacy filename is retained so upgrading does not discard existing memories.

## Engine

The package is also the sole reusable memory implementation used by Circle. It owns:

- SQLite schema, FTS5, and vector storage
- local MiniLM and degraded hash embedders
- hybrid recall and near-duplicate folding
- append-only CRDT operation log and merge primitives
- extraction parser and versioned prompt
- safe recalled-context formatting

Circle now supplies only product-specific policy and orchestration: canonical redaction, automatic turn-end extraction, automatic recalled-context injection, scope authorization, event audit, mesh transport, CLI, and desktop UI.

## Privacy and limits

Embedding and recall are local. Memory text is stored unencrypted in a user-readable SQLite file, so OS account permissions remain the security boundary. Facts are limited to 280 characters. The extension redacts common credential formats before persistence, but callers should never intentionally store secrets.

## Development

```sh
node scripts/fetch-memory-model.mjs
npm run --workspace @parke.dev/pi-memory build
npx vitest run packages/pi-memory/tests
```
