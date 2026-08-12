# OpenRouter API surface benchmark

Generated 2026-08-12 by `scripts/benchmark.ts` against the live OpenRouter
API. 3 trials per surface per model, deterministic 4–6 turn tool loop
(read 3 files, run tests twice), reasoning `low`, `maxTokens` 2048. Values
are means over trials. "Reasoning replayed" is asserted on the wire: the
harness inspects every outgoing request payload for replayed reasoning
items (`reasoning_details` on completions, `type:"reasoning"` input items on
responses, `thinking` blocks on messages).

Raw per-trial data: `benchmark-*.jsonl` in this directory
(`00-24` = gpt-5.2, `00-26` = claude-sonnet-4.6, `00-28` = kimi-k2-thinking).

## `openai/gpt-5.2`

| Surface       | Completed | Turns | Cost     | Input tok | Output tok | Cache read | Cache write | Reasoning tok | Wall  | TTFT   | Reasoning replayed |
| ------------- | --------- | ----- | -------- | --------- | ---------- | ---------- | ----------- | ------------- | ----- | ------ | ------------------ |
| `completions` | 3/3       | 5.3   | $0.01184 | 1522      | 656        | 0          | 0           | 537           | 14.2s | 2021ms | 0/3                |
| `responses`   | 3/3       | 5.0   | $0.00591 | 1485      | 237        | 0          | 0           | 123           | 8.0s  | 1258ms | 3/3                |
| `messages`    | 3/3       | 5.3   | $0.01158 | 1719      | 613        | 0          | 0           | 489           | 15.0s | 2082ms | 0/3                |

Responses is the only surface that preserved gpt-5.2's reasoning across
turns, and it cost **50% less** and ran **44% faster**: without replay the
model re-reasons from scratch on every turn (537 and 489 mean reasoning
tokens vs 123). Verified on the wire: streaming `/chat/completions` returned
no `reasoning_details` deltas for gpt-5.2 at all (the non-streaming endpoint
does return `reasoning.encrypted`), so completions could not replay even in
principle; `/messages` returned gpt-5.2 thinking without signatures pi could
echo back.

## `anthropic/claude-sonnet-4.6`

| Surface       | Completed | Turns | Cost     | Input tok | Output tok | Cache read | Cache write | Reasoning tok | Wall | TTFT   | Reasoning replayed |
| ------------- | --------- | ----- | -------- | --------- | ---------- | ---------- | ----------- | ------------- | ---- | ------ | ------------------ |
| `completions` | 3/3       | 4.0   | $0.00935 | 735       | 309        | 2924       | 436         | 10            | 8.8s | 1269ms | 0/3                |
| `responses`   | 3/3       | 4.0   | $0.01773 | 4190      | 344        | 0          | 0           | 11            | 9.2s | 1234ms | 3/3                |
| `messages`    | 3/3       | 4.0   | $0.00979 | 739       | 320        | 2938       | 504         | 10            | 8.6s | 1194ms | 3/3                |

For Claude the dominant factor is **prompt caching, not reasoning replay**
(adaptive thinking barely engaged on this task: ~10 reasoning tokens
regardless of surface). Completions and messages both applied Anthropic
`cache_control` markers and hit cache on every turn after the first;
responses has no cache path for Anthropic models through OpenRouter, so it
re-billed the full prompt every turn — **1.9× the cost** for the same work.
Completions did not replay reasoning (sonnet emits `reasoning.text`, not
`reasoning.encrypted`, and pi only echoes encrypted details), but with signed
thinking absent from the loop it made no measurable difference here.
Messages replayed signed thinking natively at essentially the same cost.

## `moonshotai/kimi-k2-thinking`

| Surface       | Completed | Turns | Cost     | Input tok | Output tok | Cache read | Cache write | Reasoning tok | Wall  | TTFT  | Reasoning replayed |
| ------------- | --------- | ----- | -------- | --------- | ---------- | ---------- | ----------- | ------------- | ----- | ----- | ------------------ |
| `completions` | 3/3       | 6.0   | $0.00393 | 1204      | 1157       | 2069       | 0           | 1144          | 10.4s | 774ms | 0/3                |
| `responses`   | 3/3       | 6.0   | $0.00188 | 812       | 432        | 2048       | 0           | 348           | 5.5s  | 560ms | 3/3                |
| `messages`    | 3/3       | 5.7   | $0.00150 | 729       | 312        | 1856       | 0           | 215           | 4.9s  | 587ms | 3/3                |

Same story as gpt-5.2, amplified: responses and messages both replayed
Kimi's thinking (as reasoning items / unsigned thinking blocks with
`allowEmptySignature`) and were **2.1–2.6× cheaper and ~2× faster** than
completions, where the model re-thought every turn (1144 vs 215–348
reasoning tokens). All three surfaces hit Kimi's implicit prompt cache.

## Conclusions

1. **Reasoning replay is the dominant cost lever for reasoning models in
   tool loops.** Where a surface replays reasoning (responses for gpt-5.2
   and kimi; messages for kimi and claude), cost and latency drop roughly
   2×, because re-reasoning after every tool call is pure waste.
2. **No single surface wins for every model.** Responses wins for OpenAI
   models; messages (or completions, via cache shims) wins for Claude
   because Anthropic prompt caching does not flow through the responses
   surface; for open models like Kimi, messages and responses tie and both
   beat completions.
3. **Chat completions replay only worked where OpenRouter streams
   `reasoning.encrypted` details** — and in these runs it streamed none for
   gpt-5.2 and only unencrypted `reasoning.text` for claude/kimi, so the
   control surface never replayed. If your harness relies on
   `reasoning_details` replay over streaming completions, verify it
   actually receives encrypted details for your model.
4. All 27 trials completed on all three surfaces for these models — no
   endpoint rejected any of the curated models outright.

Caveats: single scenario, short prompts (cache columns understate what a
real agent session with a large system prompt would show), 3 trials per
cell, one day's routing. Re-run with your model and workload:
`bun run scripts/benchmark.ts <model> --trials 3`.
