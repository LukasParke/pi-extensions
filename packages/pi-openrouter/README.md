# @parke.dev/pi-openrouter

OpenRouter serves the same models over three API surfaces. This package
registers all three as separate [pi](https://pi.dev) providers so you can pick
the wire protocol per task — and ships the benchmark harness that measures
what the choice actually costs you.

| Provider                 | Endpoint                   | pi-ai API            |
| ------------------------ | -------------------------- | -------------------- |
| `openrouter-completions` | `/api/v1/chat/completions` | `openai-completions` |
| `openrouter-responses`   | `/api/v1/responses`        | `openai-responses`   |
| `openrouter-messages`    | `/api/v1/messages`         | `anthropic-messages` |

All three are configured identically — same `$OPENROUTER_API_KEY`, same
curated models with live cost metadata from the models API, same attribution
headers — so the only variable is the protocol. `openrouter-completions`
matches pi's built-in `openrouter` provider and acts as the control.

## Install

```bash
pi install npm:@parke.dev/pi-openrouter
```

Set `OPENROUTER_API_KEY`. Models: `openai/gpt-5.2`,
`anthropic/claude-sonnet-4.6`, `moonshotai/kimi-k2-thinking` by default;
override the list in `~/.pi/openrouter.json`:

```json
{ "models": ["openai/gpt-5.2", "z-ai/glm-4.7"] }
```

Metadata (pricing, context window, reasoning support) is fetched from
`https://openrouter.ai/api/v1/models` at startup, with a pinned snapshot as
offline fallback.

## Why this exists: reasoning preservation across tool calls

Agent harnesses live and die on multi-turn tool loops. Reasoning models think
before calling a tool, and whether that thinking survives into the next
request depends on the API surface:

- **openai-responses** replays `reasoning` items (with `encrypted_content`)
  natively — pi requests `include: ["reasoning.encrypted_content"]` and echoes
  the items back.
- **anthropic-messages** replays signed `thinking` blocks.
- **chat completions** relies on OpenRouter's `reasoning_details` replay,
  which pi echoes back only for `reasoning.encrypted` details attached to
  tool calls.

## Which API should you use?

Measured with `scripts/benchmark.ts` (3 trials per surface, same
deterministic 5-turn tool loop, reasoning `low`, real requests — see
[docs/BENCHMARK.md](docs/BENCHMARK.md) for the full tables):

| `openai/gpt-5.2` | Cost     | Output tok | Wall  | Reasoning replayed |
| ---------------- | -------- | ---------- | ----- | ------------------ |
| completions      | $0.01184 | 656        | 14.2s | 0/3                |
| **responses**    | $0.00591 | 237        | 8.0s  | 3/3                |
| messages         | $0.01158 | 613        | 15.0s | 0/3                |

**For OpenAI reasoning models, use `openrouter-responses`.** It was the only
surface that replayed reasoning across turns, and that halved cost (−50%) and
wall time (−44%): without replayed reasoning the model re-reasons from scratch
on every turn of the loop, which is exactly the output-token bloat the other
two rows show. On the wire (verified, not inferred): streaming
`/chat/completions` returned no `reasoning_details` deltas for gpt-5.2 at all
(non-streaming does return `reasoning.encrypted`), so completions could not
replay even in principle; `/messages` returned gpt-5.2 thinking as
unsigned/absent blocks that cannot be echoed back.

**For Claude, use `openrouter-messages` or `openrouter-completions` — not
responses.** With `anthropic/claude-sonnet-4.6`, messages ($0.00979) and
completions ($0.00935) tied, while responses cost 1.9× ($0.01773): Anthropic
prompt caching does not flow through the responses surface, so every turn
re-billed the full prompt. Messages additionally replays signed thinking
blocks natively (3/3); completions did not replay (sonnet streams
`reasoning.text`, not `reasoning.encrypted`), which cost nothing on this
task but matters when thinking is heavier.

**For open reasoning models, avoid completions.** With
`moonshotai/kimi-k2-thinking`, messages ($0.00150) and responses ($0.00188)
both replayed reasoning and were 2.1–2.6× cheaper and ~2× faster than
completions ($0.00393), where the model re-thought every turn (1144 vs
215–348 reasoning tokens).

Run your own numbers before committing a harness to a surface (the
benchmark script requires [Bun](https://bun.sh); the extension itself does
not):

```bash
OPENROUTER_API_KEY=... bun run scripts/benchmark.ts anthropic/claude-sonnet-4.6 --trials 3
bun run scripts/benchmark.ts openai/gpt-5.2 --surfaces responses,completions
```

Writes `docs/BENCHMARK.md` plus raw per-trial JSONL. The scenario is a
synthetic bug hunt (read 3 files, run tests twice) with canned tool results,
so trials are comparable across surfaces and models. Reasoning preservation is
asserted on the wire via `onPayload` — the harness inspects each outgoing
request for replayed reasoning items, not just response metadata.

## Known limitations

- `/api/v1/responses` and `/api/v1/messages` are newer surfaces; not every
  OpenRouter model works on them. Errors are recorded per trial in the JSONL
  rather than crashing the run — a model rejecting a surface is itself a
  benchmark finding.
- The messages surface uses the Anthropic SDK, which posts to `{base}/v1/messages`;
  the provider therefore registers `https://openrouter.ai/api` as its base.
- Cache behavior depends on the model and surface: in the committed runs
  gpt-5.2 recorded no cache activity on any surface (the prompt is below
  OpenAI's minimum cacheable size), Claude hit `cache_control` caching on
  completions/messages but not responses, and Kimi's implicit cache fired
  everywhere. Inspect the cache columns for your model rather than
  generalizing; real agent sessions with large system prompts will differ.
- Model metadata (`compat`, thinking level maps) is curated for the three
  default models. Other models get sane generic metadata from the models API,
  which may miss provider quirks.

## Config

`~/.pi/openrouter.json`:

| Field     | Env                      | Default                                      |
| --------- | ------------------------ | -------------------------------------------- |
| `baseUrl` | `PI_OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1`               |
| `models`  | —                        | gpt-5.2, claude-sonnet-4.6, kimi-k2-thinking |
| `referer` | —                        | this repo                                    |
| `title`   | —                        | `pi-openrouter`                              |

The API key is never read by extension code; providers reference
`$OPENROUTER_API_KEY` and pi resolves it per request.
