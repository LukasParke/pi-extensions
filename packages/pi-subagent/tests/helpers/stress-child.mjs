#!/usr/bin/env node
/**
 * Ultrafast fake pi RPC child for ingest-throughput stress runs.
 *
 * Speaks the pi RPC JSONL event stream on stdout: session header, then
 * delta-only `message_update` events at a configurable token rate, a final
 * `message_end`, `agent_end`, and `agent_settled`.
 *
 * Env:
 *   STRESS_TOKENS_PER_SEC  offered output rate (default 750)
 *   STRESS_DURATION_MS     sustained streaming window (default 5000)
 *   STRESS_MIN_TOKENS / STRESS_MAX_TOKENS  tokens per delta event (2..8)
 *
 * Instruments its own stdout backpressure: every write() that returns false
 * counts one event and the child waits for `drain`. Stats are emitted as a
 * single `STRESS_STATS {json}` stderr line at the end.
 */
import { fileURLToPath } from "node:url";

const filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] === filename || process.argv[1]?.endsWith("stress-child.mjs");

const WORDS =
  "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau".split(" ");

export function getStressChildCommand() {
  return { command: process.execPath, args: [filename] };
}

if (isMain) {
  const rate = Number(process.env.STRESS_TOKENS_PER_SEC || 750);
  const durationMs = Number(process.env.STRESS_DURATION_MS || 5_000);
  const minTokens = Number(process.env.STRESS_MIN_TOKENS || 2);
  const maxTokens = Number(process.env.STRESS_MAX_TOKENS || 8);

  let backpressureEvents = 0;
  let drainStallMs = 0;
  let offeredTokens = 0;
  let offeredEvents = 0;

  const emit = (value) =>
    new Promise((resolve) => {
      const ok = process.stdout.write(JSON.stringify(value) + "\n");
      if (ok) return resolve();
      backpressureEvents++;
      const waitStart = Date.now();
      process.stdout.once("drain", () => {
        drainStallMs += Date.now() - waitStart;
        resolve();
      });
    });

  const randomDelta = () => {
    const tokens = minTokens + Math.floor(Math.random() * (maxTokens - minTokens + 1));
    offeredTokens += tokens;
    offeredEvents++;
    let text = "";
    for (let i = 0; i < tokens; i++) text += (i ? " " : "") + WORDS[Math.floor(Math.random() * WORDS.length)];
    return text + " ";
  };

  const run = async () => {
    await emit({ type: "session", version: 3, id: "stress-session", timestamp: new Date().toISOString(), cwd: process.cwd() });
    const startedAt = Date.now();
    const deadline = startedAt + durationMs;
    // Token bucket: emit whatever the elapsed budget allows, then nap briefly.
    while (Date.now() < deadline) {
      const budget = ((Date.now() - startedAt) / 1000) * rate;
      while (offeredTokens < budget && Date.now() < deadline) {
        await emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: randomDelta() } });
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const elapsedMs = Date.now() - startedAt;
    await emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "stress done" }],
        api: "fake", provider: "fake", model: "fake/stress", stopReason: "stop", timestamp: Date.now(),
        usage: {
          input: 10, output: offeredTokens, cacheRead: 0, cacheWrite: 0, totalTokens: offeredTokens + 10,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    });
    await emit({ type: "agent_end", messages: [] });
    await emit({ type: "agent_settled" });
    process.stderr.write(
      "STRESS_STATS " +
        JSON.stringify({ offeredTokens, offeredEvents, elapsedMs, backpressureEvents, drainStallMs }) +
        "\n",
    );
    // Stay alive until stdin closes, like a real RPC child.
  };

  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let command;
      try { command = JSON.parse(line); } catch { continue; }
      if (command.type === "prompt") void run();
      if (command.type === "get_state") {
        process.stdout.write(JSON.stringify({ type: "response", command: "get_state", success: true, data: { sessionId: "stress-session", isStreaming: true } }) + "\n");
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
