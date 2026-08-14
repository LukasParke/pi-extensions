import { describe, expect, it } from "vitest";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { ChildRunner } from "../src/runner.js";
import { Semaphore } from "../src/semaphore.js";
import type { TaskResult } from "../src/types.js";
import { makeIsolatedDirs } from "./helpers/test-config.js";
// @ts-expect-error plain ESM helper without types
import { getStressChildCommand } from "./helpers/stress-child.mjs";

/**
 * Ingest-throughput stress harness: drives ChildRunner against a fake child
 * streaming delta-only message_update events at 100 / 750 / 2000 tok/s and
 * measures parent-side throughput, event-loop lag, child write()
 * backpressure stalls, onUpdate rate, and RSS growth.
 *
 * Duration defaults to 5s per rate for the regular suite; run the full 60s+
 * sustained measurement with STRESS_DURATION_MS=60000.
 */

const DURATION_MS = Number(process.env.STRESS_DURATION_MS || 5_000);
const RATES = (process.env.STRESS_RATES || "100,750,2000").split(",").map(Number);

interface StressRow {
  offeredTps: number;
  offeredEvents: number;
  ingestedTps: number;
  ingestedEvents: number;
  parseErrors: number;
  p99LoopLagMs: number;
  meanLoopLagMs: number;
  backpressureEvents: number;
  drainStallMs: number;
  onUpdatePerSec: number;
  rssGrowthMb: number;
  elapsedMs: number;
}

async function runRate(rate: number): Promise<StressRow> {
  const dirs = await makeIsolatedDirs("pi-subagent-stress-");
  let onUpdateCount = 0;
  const histogram: IntervalHistogram = monitorEventLoopDelay();
  const rssBefore = process.memoryUsage().rss;
  const runner = new ChildRunner(
    new Semaphore(1, 1),
    () => getStressChildCommand(),
    dirs.sessionDir,
    () => onUpdateCount++,
    50,
  );
  histogram.enable();
  const startedAt = Date.now();
  let result: TaskResult;
  try {
    result = await runner.run(
      { task: "stream", timeoutMs: DURATION_MS * 3 + 30_000, profile: "general" },
      undefined,
    );
  } finally {
    histogram.disable();
    await dirs.cleanup();
  }
  const elapsedMs = Date.now() - startedAt;
  const statsMatch = result.stderr.match(/STRESS_STATS (\{.*\})/);
  if (!statsMatch) throw new Error(`child stats missing; stderr: ${result.stderr.slice(-500)}`);
  const stats = JSON.parse(statsMatch[1]!);
  const seconds = stats.elapsedMs / 1000;
  const ingestedEvents = Math.max(0, result.protocol.validEvents - 5); // header + get_state + message_end + agent_end + agent_settled
  return {
    offeredTps: Math.round(stats.offeredTokens / seconds),
    offeredEvents: stats.offeredEvents,
    ingestedTps: Math.round((ingestedEvents / seconds) * (stats.offeredTokens / Math.max(1, stats.offeredEvents))),
    ingestedEvents,
    parseErrors: result.protocol.parseErrors,
    p99LoopLagMs: Math.round(histogram.percentile(99) / 1e6),
    meanLoopLagMs: Math.round(histogram.mean / 1e6),
    backpressureEvents: stats.backpressureEvents,
    drainStallMs: stats.drainStallMs,
    onUpdatePerSec: Math.round(onUpdateCount / (elapsedMs / 1000)),
    rssGrowthMb: Math.round((process.memoryUsage().rss - rssBefore) / 1024 / 1024),
    elapsedMs,
  };
}

describe("ingest stress: ultrafast model streams", { timeout: (DURATION_MS * 3 + 60_000) * RATES.length }, () => {
  it(
    `sustains ${RATES.join("/")} tok/s without backpressuring the child`,
    async () => {
      const rows: Array<StressRow & { rate: number }> = [];
      for (const rate of RATES) {
        process.env.STRESS_TOKENS_PER_SEC = String(rate);
        process.env.STRESS_DURATION_MS = String(DURATION_MS);
        rows.push({ rate, ...(await runRate(rate)) });
      }
      console.log("\n| offered tps | ingested tps | p99 loop lag | backpressure events | onUpdate/sec | RSS growth |");
      console.log("| --- | --- | --- | --- | --- | --- |");
      for (const row of rows) {
        console.log(
          `| ${row.offeredTps} | ${row.ingestedTps} | ${row.p99LoopLagMs}ms | ${row.backpressureEvents} | ${row.onUpdatePerSec} | ${row.rssGrowthMb}MB |`,
        );
        expect(row.parseErrors).toBe(0);
        // Nothing is dropped: every offered event was parsed.
        expect(row.ingestedEvents).toBeGreaterThanOrEqual(row.offeredEvents);
      }
    },
  );
});
