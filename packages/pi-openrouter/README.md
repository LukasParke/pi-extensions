# @parke.dev/pi-openrouter

OpenRouter serves the same models over three API surfaces. This package overrides
pi's built-in `openrouter` provider and routes each model family to its most
efficient surface automatically. It also keeps three explicit providers for
benchmarking or manual selection.

| Provider                 | Routing / endpoint         | pi-ai API            |
| ------------------------ | -------------------------- | -------------------- |
| `openrouter`             | per-model family routing   | per-model            |
| `openrouter-completions` | `/api/v1/chat/completions` | `openai-completions` |
| `openrouter-responses`   | `/api/v1/responses`        | `openai-responses`   |
| `openrouter-messages`    | `/api/v1/messages`         | `anthropic-messages` |

All four use the same `$OPENROUTER_API_KEY`, curated models, live cost metadata,
and attribution headers. Overriding `openrouter` is intentional: optimal routing
works with existing model selections and requires no user config.

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

## Automatic routing

The exported routing table is ordered, so exact model exceptions can be added
above family rules:

| Model pattern | API                  | Why                                                                                                                                           |
| ------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic/*` | `anthropic-messages` | Native `cache_control`; Opus 5 was 2.1× cheaper and reduced billable input from 3912 to 8 tokens with 2900 cache-read tokens                  |
| `openai/*`    | `openai-responses`   | Native reasoning replay; GPT-5.2 cut cost 50% and wall time 44%, while GPT-5.6 Sol replayed reasoning 3/3 with the fastest wall time and TTFT |
| `*`           | `openai-completions` | Compatibility fallback; Kimi K3 was cheapest here through implicit caching                                                                    |

The policy comes from 54 live trials across two matrices. See
[the first matrix](docs/BENCHMARK.md) and
[the Opus 5 / GPT-5.6 Sol / Kimi K3 matrix](docs/BENCHMARK-2.md); the
870-trial volume run is [docs/BENCHMARK-3.md](docs/BENCHMARK-3.md).

### Override one model

Pi applies `~/.pi/agent/models.json` above extension providers. Set `api` and
`baseUrl` on a model with the same id to pin it to another surface:

```json
{
  "providers": {
    "openrouter": {
      "models": [
        {
          "id": "openai/gpt-5.6-sol",
          "api": "openai-completions",
          "baseUrl": "https://openrouter.ai/api/v1"
        }
      ]
    }
  }
}
```

For `anthropic-messages`, use `https://openrouter.ai/api` because pi's
Anthropic client appends `/v1/messages`.

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

Measured with `scripts/benchmark.ts` (3 trials per surface, the same
deterministic tool loop, reasoning `low`, real requests — see
[docs/BENCHMARK.md](docs/BENCHMARK.md) and
[docs/BENCHMARK-2.md](docs/BENCHMARK-2.md) for the full tables):

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

**Open model behavior varies by model — measure before pinning.**
`moonshotai/kimi-k2-thinking` was 2.1–2.6× cheaper on messages/responses than
completions (reasoning replay). For `moonshotai/kimi-k3`, an n=3 run favored
completions, but the 110-trial volume run
([BENCHMARK-3.md](docs/BENCHMARK-3.md)) overturned that: responses won on
cost ($0.01118 vs $0.01235), replay (81% vs 0%), and p50 wall — so kimi-k3 is
pinned to responses in the exceptions table. The automatic fallback remains
completions; pin exceptions only on repeatable volume evidence.

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
- Cache behavior depends on the model and surface: in the committed runs,
  gpt-5.2 recorded no cache activity, Claude hit `cache_control` on completions
  and messages but not responses, Kimi K2 Thinking recorded cache reads on all
  three surfaces, and Kimi K3 recorded them on completions only. Inspect the
  generated cache columns rather than generalizing; real agent sessions with
  larger prompts may behave differently.
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
