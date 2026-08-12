# OpenRouter API surface benchmark — volume run (870 trials)

Generated 2026-08-12 from the high-volume run (75-110 trials per surface per model, $13.07 total),
merging the pre-reload and resumed datasets (`benchmark-2026-08-12T02-*` onward). Same deterministic
tool-loop scenario as [BENCHMARK.md](BENCHMARK.md); these tables supersede the n=3 matrices in
[BENCHMARK-2.md](BENCHMARK-2.md) where they disagree. Cache-read detail lives in the per-run
summary tables the benchmark printed (committed raw JSONL carries per-trial totals).


## `anthropic/claude-opus-5`

| Surface | n | Cost/trial | Reasoning replayed | Wall p50 |
| --- | --- | --- | --- | --- |
| `completions` | 75 | $0.02431 | 0/75 | 11.4s |
| `responses` | 75 | $0.02422 | 9/75 | 11.3s |
| `messages` | 75 | $0.00966 | 19/75 | 10.9s |

## `openai/gpt-5.6-sol`

| Surface | n | Cost/trial | Reasoning replayed | Wall p50 |
| --- | --- | --- | --- | --- |
| `completions` | 105 | $0.01445 | 0/105 | 9.9s |
| `responses` | 105 | $0.01453 | 105/105 | 10.0s |
| `messages` | 105 | $0.01639 | 0/105 | 11.1s |

## `moonshotai/kimi-k3`

| Surface | n | Cost/trial | Reasoning replayed | Wall p50 |
| --- | --- | --- | --- | --- |
| `completions` | 110 | $0.01235 | 0/110 | 16.2s |
| `responses` | 110 | $0.01118 | 89/110 | 15.3s |
| `messages` | 110 | $0.01235 | 0/110 | 19.1s |

## Verdicts at volume

- **anthropic/claude-opus-5 → messages**: $0.00966 vs ~$0.0243 elsewhere (2.5x, zero variance; input 3912→8 via client cache_control; cache read 3547 mean). Thinking surfaced+replayed only 19/75 even natively (PLA-1077).
- **openai/gpt-5.6-sol → responses**: 105/105 reasoning replay vs 0/210 on the other surfaces; fastest wall/TTFT. Cost parity in this light-reasoning scenario; diverges with reasoning depth (gpt-5.2 in BENCHMARK.md: -50%).
- **moonshotai/kimi-k3 → responses**: cheapest ($0.01118), 89/110 replay, fastest p50 (15.3s); implicit caching engages on completions (1967 mean) and responses (1480) but not messages. Overturns BENCHMARK-2's n=3 completions verdict — routed as an explicit exception.
- Cross-cutting: completions replay was 0/290 across all three models (PLA-1076 / pi#7994); kimi on messages showed 7.5-55s wall variance for identical requests.
