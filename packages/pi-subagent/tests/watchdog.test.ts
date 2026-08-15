import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ChildRunner, type WatchdogEvent } from "../src/runner.js";
import { Semaphore } from "../src/semaphore.js";
// @ts-expect-error test helper is plain ESM without types
import { getFakePiCommand } from "./helpers/fake-pi.mjs";
import type { TaskResult, TaskSpec } from "../src/types.js";

/**
 * Doom-loop watchdog: deterministic, runner-level detection. Wakeups without
 * progress and repeated tool-call sequences pause the run (session preserved,
 * resumable); soft budget warnings fire once each.
 */
describe("ChildRunner doom-loop watchdog", () => {
  let semaphore: Semaphore;
  let checkpointCalls: Array<Partial<TaskResult>>;
  let watchdogEvents: WatchdogEvent[];
  let previousEnv: Record<string, string | undefined>;

  const ENV_KEYS = ["FAKE_PI_MODE", "FAKE_PI_TICK_MS"];

  beforeEach(() => {
    previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    semaphore = new Semaphore(2, 10);
    checkpointCalls = [];
    watchdogEvents = [];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  const defaultSpec: TaskSpec = {
    task: "Test the runner",
    timeoutMs: 15_000,
    profile: "general",
  };

  const makeRunner = (watchdog: { wakeupsWithoutProgress: number; repeatedActionRuns: number }) =>
    new ChildRunner(
      semaphore,
      // Forward the invocation argv (real getPiCommand does) so the fake can
      // assert on flags like --session.
      (args) => {
        const fake = getFakePiCommand();
        return { command: fake.command, args: [...fake.args, ...args] };
      },
      "/tmp/test-sessions-pi-subagent",
      (partial) => checkpointCalls.push(partial),
      50,
      undefined,
      undefined,
      undefined,
      undefined,
      { watchdog, onWatchdogEvent: (event) => watchdogEvents.push(event) },
    );

  it("pauses after 3 consecutive wakeups without progress and emits an escalation with evidence", async () => {
    process.env.FAKE_PI_MODE = "doom-loop";
    process.env.FAKE_PI_TICK_MS = "50";
    const result = await makeRunner({ wakeupsWithoutProgress: 3, repeatedActionRuns: 100 }).run(defaultSpec);
    expect(result.state).toBe("paused");
    expect(result.stopReason).toBe("watchdog");
    expect(result.errorMessage).toMatch(/wakeups without progress/);
    // Evidence: counters + usage in the escalation, output snippet in the reason.
    const escalation = watchdogEvents.find((event) => event.kind === "pause");
    expect(escalation).toBeDefined();
    if (escalation?.kind !== "pause") throw new Error("unreachable");
    expect(escalation.counters.wakeupsWithoutProgress).toBe(3);
    expect(escalation.usage.turns).toBeGreaterThan(0);
    expect(escalation.reason).toContain("checking…");
    // The run was keep-alive (waiting between turns) before the pause.
    expect(checkpointCalls.map((call) => call.state)).toContain("waiting");
  });

  it("resets the no-progress counter when any progress signal changes", async () => {
    process.env.FAKE_PI_MODE = "progress-reset";
    process.env.FAKE_PI_TICK_MS = "50";
    const result = await makeRunner({ wakeupsWithoutProgress: 3, repeatedActionRuns: 100 }).run(defaultSpec);
    expect(result.state).toBe("completed");
    expect(watchdogEvents.find((event) => event.kind === "pause")).toBeUndefined();
    // Counter went 1 (alpha==alpha) → 0 (beta!=alpha) → 1 → 2, never 3.
    const counters = checkpointCalls
      .map((call) => call.watchdog?.wakeupsWithoutProgress)
      .filter((value): value is number => value !== undefined);
    expect(counters).toContain(1);
    expect(counters).toContain(0);
    expect(counters).toContain(2);
    expect(counters).not.toContain(3);
    expect(result.watchdog?.wakeupsWithoutProgress).toBe(2);
  });

  it("pauses on an identical tool-call sequence repeated N turns running", async () => {
    process.env.FAKE_PI_MODE = "repeated-actions";
    process.env.FAKE_PI_TICK_MS = "50";
    const result = await makeRunner({ wakeupsWithoutProgress: 100, repeatedActionRuns: 3 }).run(defaultSpec);
    expect(result.state).toBe("paused");
    expect(result.stopReason).toBe("watchdog");
    expect(result.errorMessage).toMatch(/identical tool-call sequence repeated 3 turns/);
    const escalation = watchdogEvents.find((event) => event.kind === "pause");
    if (escalation?.kind !== "pause") throw new Error("expected a pause escalation");
    expect(escalation.counters.repeatedActions).toBe(3);
  });

  it("fires soft budget warnings once each at 50% and 80% of max_cost", async () => {
    process.env.FAKE_PI_MODE = "three-turns";
    // Costs 0.001/turn: 50% at turn 2, 80% at turn 3, never breached.
    const result = await makeRunner({ wakeupsWithoutProgress: 100, repeatedActionRuns: 100 }).run({
      ...defaultSpec,
      maxCost: 0.0035,
    });
    expect(result.state).toBe("completed");
    const warnings = watchdogEvents.filter((event) => event.kind === "budget-warning");
    expect(warnings.map((event) => (event.kind === "budget-warning" ? event.message : ""))).toEqual([
      expect.stringMatching(/50% of max_cost/),
      expect.stringMatching(/80% of max_cost/),
    ]);
    expect(result.watchdog?.warnings).toHaveLength(2);
  });

  it("fires soft budget warnings for max_turns too, once each", async () => {
    process.env.FAKE_PI_MODE = "three-turns";
    // 50% of 3 = 1.5 → turn 2; 80% of 3 = 2.4 → turn 3. Budget never breached.
    const result = await makeRunner({ wakeupsWithoutProgress: 100, repeatedActionRuns: 100 }).run({
      ...defaultSpec,
      maxTurns: 3,
    });
    expect(result.state).toBe("completed");
    const warnings = watchdogEvents.filter((event) => event.kind === "budget-warning");
    expect(warnings.map((event) => (event.kind === "budget-warning" ? event.message : ""))).toEqual([
      expect.stringMatching(/50% of max_turns/),
      expect.stringMatching(/80% of max_turns/),
    ]);
  });

  it("a paused run keeps its session id and resumes via the existing resume flow", async () => {
    process.env.FAKE_PI_MODE = "doom-loop";
    process.env.FAKE_PI_TICK_MS = "50";
    const runner = makeRunner({ wakeupsWithoutProgress: 3, repeatedActionRuns: 100 });
    const paused = await runner.run(defaultSpec);
    expect(paused.state).toBe("paused");
    expect(paused.sessionId).toBe("test-session-123");

    // A paused child persists its session file; mirror that so resume resolves.
    fs.mkdirSync("/tmp/test-sessions-pi-subagent", { recursive: true });
    fs.writeFileSync(path.join("/tmp/test-sessions-pi-subagent", "test-session-123.jsonl"), '{"type":"session"}\n');
    // Resume the preserved session: the child must be invoked with --session.
    process.env.FAKE_PI_MODE = "require-session-arg";
    const resumed = await makeRunner({ wakeupsWithoutProgress: 3, repeatedActionRuns: 100 }).run({
      ...defaultSpec,
      resume: paused.sessionId,
    });
    expect(resumed.state).toBe("completed");
  });
});
