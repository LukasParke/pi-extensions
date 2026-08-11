import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  digestPathFor,
  digestSessionFile,
  distillSessionFile,
  sweepSessionsLifecycle,
} from "../src/distill.js";

const SESSION_ID = "019f0000-aaaa-bbbb-cccc-000000000001";
const FILE_NAME = `2026-08-07T00-00-00-000Z_${SESSION_ID}.jsonl`;

function transcriptLines(): string {
  const t0 = "2026-08-07T00:00:00.000Z";
  const t1 = "2026-08-07T00:05:00.000Z";
  return [
    JSON.stringify({ type: "session", timestamp: t0 }),
    JSON.stringify({ type: "model_change", timestamp: t0, modelId: "x-ai/grok-4.5" }),
    JSON.stringify({ type: "thinking_level_change", timestamp: t0, thinkingLevel: "medium" }),
    JSON.stringify({
      type: "message",
      timestamp: t0,
      message: { role: "user", content: [{ type: "text", text: "Map the auth middleware and list entry points" }] },
    }),
    JSON.stringify({
      type: "message",
      timestamp: t1,
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "text", text: "Scanning..." }, { type: "toolCall", name: "bash" }],
        usage: { input: 1000, output: 200, cost: 0.01 },
      },
    }),
    JSON.stringify({
      type: "message",
      timestamp: t1,
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Auth flows through middleware/auth.ts; 3 entry points found." }],
        usage: { input: 1500, output: 400, cost: 0.02 },
      },
    }),
  ].join("\n") + "\n";
}

async function makeSessionDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-distill-"));
}

describe("digestSessionFile", () => {
  it("captures task, outcome, model, usage, and counts", async () => {
    const dir = await makeSessionDir();
    try {
      const file = path.join(dir, FILE_NAME);
      await fs.writeFile(file, transcriptLines());
      const digest = await digestSessionFile(file);
      expect(digest.sessionId).toBe(SESSION_ID);
      expect(digest.task).toContain("Map the auth middleware");
      expect(digest.finalOutput).toContain("3 entry points found");
      expect(digest.model).toBe("x-ai/grok-4.5");
      expect(digest.thinking).toBe("medium");
      expect(digest.assistantTurns).toBe(2);
      expect(digest.toolCalls).toBe(1);
      expect(digest.errors).toBe(0);
      expect(digest.usage).toEqual({ input: 2500, output: 600, cost: expect.closeTo(0.03) });
      expect(digest.durationMs).toBe(5 * 60_000);
      expect(digest.originalBytes).toBeGreaterThan(0);
      expect(digest.parseFailed).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("marks unparseable transcripts instead of failing", async () => {
    const dir = await makeSessionDir();
    try {
      const file = path.join(dir, "garbage.jsonl");
      await fs.writeFile(file, "not json at all\n{{{\n");
      const digest = await digestSessionFile(file);
      expect(digest.parseFailed).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("distillSessionFile", () => {
  it("writes the digest and removes the transcript", async () => {
    const dir = await makeSessionDir();
    try {
      const file = path.join(dir, FILE_NAME);
      await fs.writeFile(file, transcriptLines());
      await distillSessionFile(file);
      await expect(fs.stat(file)).rejects.toThrow();
      const digest = JSON.parse(await fs.readFile(digestPathFor(file), "utf8"));
      expect(digest.finalOutput).toContain("3 entry points found");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sweepSessionsLifecycle", () => {
  it("distills only sessions that are over: unreferenced, not busy, past the race guard", async () => {
    const dir = await makeSessionDir();
    try {
      const over = path.join(dir, FILE_NAME);
      const referenced = path.join(dir, "2026-08-07T00-00-00-000Z_keep-me.jsonl");
      const busy = path.join(dir, "2026-08-07T00-00-00-000Z_busy-one.jsonl");
      const fresh = path.join(dir, "2026-08-07T00-00-00-000Z_fresh-one.jsonl");
      for (const file of [over, referenced, busy, fresh]) await fs.writeFile(file, transcriptLines());
      const past = new Date(Date.now() - 2 * 60 * 60_000);
      for (const file of [over, referenced, busy]) await fs.utimes(file, past, past);

      const report = await sweepSessionsLifecycle(dir, {
        keep: new Set(["keep-me"]),
        busy: new Set(["busy-one"]),
      });
      expect(report.distilled).toEqual([over]);
      expect(report.kept).toBe(3);
      await expect(fs.stat(over)).rejects.toThrow();
      await fs.stat(digestPathFor(over));
      await fs.stat(referenced);
      await fs.stat(busy);
      await fs.stat(fresh); // younger than the race guard
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("tolerates a missing directory", async () => {
    const report = await sweepSessionsLifecycle("/nonexistent/pi-subagent-nowhere", {
      keep: new Set(),
      busy: new Set(),
    });
    expect(report).toEqual({ distilled: [], kept: 0, failed: [] });
  });
});
