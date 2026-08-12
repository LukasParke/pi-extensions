# OpenRouter API surface benchmark — second matrix

Generated 2026-08-12 from three live OpenRouter runs: 3 trials per surface per model, the same deterministic tool loop, reasoning `low`, and `maxTokens` 2048. Means include completed trials only. All 27 trials completed and followed the scenario.

Raw data:

- `benchmark-2026-08-12T01-27-02-558Z.jsonl` — `anthropic/claude-opus-5`
- `benchmark-2026-08-12T01-28-54-494Z.jsonl` — `openai/gpt-5.6-sol`
- `benchmark-2026-08-12T01-30-48-459Z.jsonl` — `moonshotai/kimi-k3`

## `anthropic/claude-opus-5`

| Surface        | Completed | Scenario | Turns | Cost         | Input tok | Output tok | Cache read | Cache write | Reasoning tok | Wall  | TTFT   | Reasoning replayed |
| -------------- | --------- | -------- | ----- | ------------ | --------- | ---------- | ---------- | ----------- | ------------- | ----- | ------ | ------------------ |
| `completions`  | 3/3       | 3/3      | 4.7   | $0.02692     | 3912      | 294        | 0          | 0           | 0             | 12.9s | 2126ms | 0/3                |
| `responses`    | 3/3       | 3/3      | 4.0   | $0.02409     | 3498      | 264        | 0          | 0           | 0             | 12.0s | 2233ms | 1/3                |
| **`messages`** | 3/3       | 3/3      | 4.0   | **$0.01289** | **8**     | 289        | **2900**   | 668         | 0             | 12.4s | 2343ms | 1/3                |

Messages cost 2.1× less than completions. Explicit Anthropic caching engaged only on the native messages surface: mean billable input collapsed from 3912 to 8 tokens, with 2900 cache-read tokens. `/responses` currently lacks the Anthropic `cache_control` mapping needed to realize the same savings.

## `openai/gpt-5.6-sol`

| Surface         | Completed | Scenario | Turns | Cost     | Input tok | Output tok | Cache read | Cache write | Reasoning tok | Wall     | TTFT       | Reasoning replayed |
| --------------- | --------- | -------- | ----- | -------- | --------- | ---------- | ---------- | ----------- | ------------- | -------- | ---------- | ------------------ |
| `completions`   | 3/3       | 3/3      | 6.0   | $0.01451 | 1845      | 176        | 0          | 0           | 41            | 10.5s    | 1536ms     | 0/3                |
| **`responses`** | 3/3       | 3/3      | 6.0   | $0.01462 | 1889      | 173        | 0          | 0           | 33            | **9.5s** | **1347ms** | **3/3**            |
| `messages`      | 3/3       | 3/3      | 6.0   | $0.01735 | 2180      | 215        | 0          | 0           | 75            | 17.9s    | 2529ms     | 0/3                |

Responses was the only surface to replay reasoning in all trials, and it had the fastest wall time and TTFT. Streaming completions returned no replayable `reasoning_details` in these trials.

## `moonshotai/kimi-k3`

| Surface           | Completed | Scenario | Turns | Cost         | Input tok | Output tok | Cache read | Cache write | Reasoning tok | Wall  | TTFT   | Reasoning replayed |
| ----------------- | --------- | -------- | ----- | ------------ | --------- | ---------- | ---------- | ----------- | ------------- | ----- | ------ | ------------------ |
| **`completions`** | 3/3       | 3/3      | 6.0   | **$0.01105** | 2124      | 285        | **1368**   | 0           | 9             | 29.7s | 4237ms | 0/3                |
| `responses`       | 3/3       | 3/3      | 6.0   | $0.01773     | 3860      | 410        | 0          | 0           | 148           | 26.7s | 3134ms | 3/3                |
| `messages`        | 3/3       | 3/3      | 6.0   | $0.01540     | 3539      | 319        | 0          | 0           | 61            | 14.2s | 1619ms | 0/3                |

Completions was cheapest because Kimi's implicit cache engaged there (1368 cache-read tokens). Messages was faster, but cost 39% more; responses cost 60% more despite replaying reasoning.

## Routing conclusion

| Model family    | Default surface      |
| --------------- | -------------------- |
| `anthropic/*`   | `anthropic-messages` |
| `openai/*`      | `openai-responses`   |
| everything else | `openai-completions` |

The family defaults optimize the strongest repeatable signal in both benchmark matrices: native Anthropic caching, native OpenAI reasoning replay, and the broad compatibility and implicit caching of chat completions for other families. Per-model exceptions belong above family rules when platform behavior changes.

Caveats: one synthetic scenario, 3 trials per cell, and one day's platform routing. Replay on Anthropic non-native surfaces was flaky in this matrix (1/3 on responses, 1/3 on messages for Opus), so replay counts should not be generalized beyond these runs.
