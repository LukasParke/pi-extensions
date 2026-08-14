# @parke.dev/pi-openrouter

OpenRouter catalog sync for the [Pi coding agent](https://pi.dev): generates
`models.json` entries for the full OpenRouter catalog, routing each model to
the API surface that fits it best — `anthropic/*` over `/messages`,
`openai/*` over `/responses`, benchmark-proven exceptions on top — plus a
benchmark harness that keeps the routing rules honest.

This package is a **CLI, not a runtime extension**. Pi processes (TUI,
headless, subagents) all read `models.json` directly, so routing decisions
live in config where every process sees them identically — nothing is
registered at runtime.

```sh
pi-openrouter sync              # rewrite models.json if stale
pi-openrouter sync --check      # exit 1 if stale (CI / preflight)
pi-openrouter sync --stdout     # print the merged file
pi-openrouter sync --file PATH  # target a different models.json
```

## What sync does

1. Fetches the live catalog from `https://openrouter.ai/api/v1/models`.
2. Applies the routing rules in `src/rules.ts` to pick each model's surface
   and compat flags (`thinkingFormat`, `cacheControlFormat`,
   `thinkingLevelMap`, ...).
3. Rewrites `providers.openrouter.models` in `~/.pi/agent/models.json`.

Output is deterministic given the same (catalog, rules): models are sorted by
id, so every sync diff is a meaningful review artifact.

### Ownership contract

- `providers.openrouter.models` — **tool-owned**, replaced wholesale on every
  sync. Never hand-edit entries; sync will revert them.
- `providers.openrouter.modelOverrides` — **user-owned**. Pi applies these on
  top of every model (including generated ones), so per-model tweaks live
  here and survive syncs.
- Everything else — other providers, provider-level `compat` — is preserved.

If the catalog fetch fails, sync aborts and leaves `models.json` untouched.

## Routing rules

`src/rules.ts` is the policy, in three layers (later wins):

1. **Family rules** — `anthropic/*` → messages, `openai/*` → responses,
   `*` → completions.
2. **Surface rules** — e.g. reasoning models on completions get
   `thinkingFormat: "openrouter"` so `reasoning_details` parse.
3. **Exceptions** — benchmark-proven per-model pins. Each carries `since` and
   `revalidateAfter` dates; sync warns when one goes stale, so decisions made
   against transient platform bugs get re-benchmarked instead of calcifying.

## Benchmark harness

```sh
bun run benchmark [model] [--trials N] [--surfaces completions,responses,messages]
```

Runs a deterministic multi-turn tool-loop scenario through each surface using
pi-ai's real stream implementations, then writes a report and raw JSONL to
`docs/`. When a surface wins on fidelity (reasoning replay, cache_control
mapping) or cost, that's a rules change — see `docs/BENCHMARK-*.md` for
methodology and past results.

## Configuration

`~/.pi/openrouter.json` (via `@parke.dev/pi-ext-config`): `baseUrl`,
`referer`, `title` for attribution headers. The API key is never handled by
this package — generated config references `$OPENROUTER_API_KEY` and pi
resolves it per request.

## License

MIT
