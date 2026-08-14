import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChildRunner } from "../src/runner.js";
import { Semaphore } from "../src/semaphore.js";
// @ts-expect-error test helper is plain ESM without types
import { getFakePiCommand } from "./helpers/fake-pi.mjs";
import type { TaskResult, TaskSpec } from "../src/types.js";

/**
 * Keep-alive lifecycle: a child with live wakeup triggers (signaled via
 * custom "keep-alive" messages on the RPC stream) parks in "waiting" at
 * settle instead of ending the run. Children without triggers behave
 * byte-identically to before.
 */
describe("ChildRunner keep-alive lifecycle", () => {
  let semaphore: Semaphore;
  let checkpointCalls: Array<Partial<TaskResult>>;
  let onCheckpoint: (result: Partial<TaskResult>) => void;
  let previousEnv: Record<string, string | undefined>;

  const ENV_KEYS = ["FAKE_PI_MODE", "FAKE_PI_WAKEUP_MS", "FAKE_PI_LOG_COMMANDS", "FAKE_PI_TICK_MS"];

  beforeEach(() => {
    previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    semaphore = new Semaphore(2, 10);
    checkpointCalls = [];
    onCheckpoint = (partial) => checkpointCalls.push(partial);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  const defaultSpec: TaskSpec = {
    task: "Test the runner",
    timeoutMs: 10_000,
    profile: "general",
  };

  const makeRunner = () =>
    new ChildRunner(semaphore, () => getFakePiCommand(), "/tmp/test-sessions-pi-subagent", onCheckpoint, 50);

  const states = () => checkpointCalls.map((call) => call.state).filter(Boolean);
  const commandCounts = (stderr: string) => ({
    prompt: stderr.split("\n").filter((line) => line === "cmd:prompt").length,
    steer: stderr.split("\n").filter((line) => line === "cmd:steer").length,
  });

  it("one-shot run with no keep-alive events closes stdin on first settle (regression guard)", async () => {
    process.env.FAKE_PI_MODE = "success";
    const result = await makeRunner().run(defaultSpec);
    expect(result.state).toBe("completed");
    expect(states()).not.toContain("waiting");
    expect(result.keepAlive).toBeUndefined();
  });

  it("keep-alive active at settle parks the run in waiting; inactive + settle completes", async () => {
    process.env.FAKE_PI_MODE = "keep-alive";
    process.env.FAKE_PI_LOG_COMMANDS = "1";
    const runner = makeRunner();
    const promise = runner.run(defaultSpec);
    // Wait for the waiting state, then steer: a waiting (idle) child needs a
    // prompt to start a turn, and turn 2 exhausts triggers → completes.
    await vi.waitFor(() => {
      expect(states()).toContain("waiting");
    }, { timeout: 3_000 });
    expect(runner.steer("address the review feedback")).toBe(true);
    const result = await promise;
    expect(result.state).toBe("completed");
    expect(result.liveText).toContain("wakeup turn: address the review feedback");
    // The waiting steer used the prompt verb (a steer would queue forever in
    // an idle child): one prompt for the task, one for the waiting steer.
    expect(commandCounts(result.stderr)).toEqual({ prompt: 2, steer: 0 });
    expect(result.keepAlive).toEqual({ active: false, reasons: [] });
  });

  it("wakeup turn cycle: waiting → running → waiting → running → completed", async () => {
    process.env.FAKE_PI_MODE = "keep-alive-wakeup";
    process.env.FAKE_PI_WAKEUP_MS = "80";
    const result = await makeRunner().run(defaultSpec);
    expect(result.state).toBe("completed");
    expect(result.liveText).toContain("turn 3 (final)");
    const seen = states();
    const firstWaiting = seen.indexOf("waiting");
    expect(firstWaiting).toBeGreaterThan(-1);
    // Each wakeup turn flips the run back to running before settling again.
    expect(seen.slice(firstWaiting)).toEqual(
      expect.arrayContaining(["waiting", "running", "waiting", "running"]),
    );
  });

  it("gate ALL PASS wakeup while waiting auto-completes the run", async () => {
    process.env.FAKE_PI_MODE = "gate-all-pass";
    process.env.FAKE_PI_WAKEUP_MS = "80";
    const started = Date.now();
    const result = await makeRunner().run(defaultSpec);
    expect(result.state).toBe("completed");
    // Completed via the gate signal, not the 10s spec timeout.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("cancel while waiting terminates cleanly", async () => {
    process.env.FAKE_PI_MODE = "keep-alive";
    const controller = new AbortController();
    const promise = makeRunner().run(defaultSpec, controller.signal);
    await vi.waitFor(() => {
      expect(states()).toContain("waiting");
    }, { timeout: 3_000 });
    controller.abort();
    const result = await promise;
    expect(result.state).toBe("cancelled");
    expect(result.stopReason).toBe("cancelled");
  });

  it("steer while running uses steerCommand (not prompt)", async () => {
    process.env.FAKE_PI_MODE = "steer-echo";
    process.env.FAKE_PI_LOG_COMMANDS = "1";
    const runner = makeRunner();
    const promise = runner.run({ ...defaultSpec, timeoutMs: 5_000 });
    await vi.waitFor(() => {
      expect(runner.steer("focus on the tests")).toBe(true);
    }, { timeout: 3_000 });
    const result = await promise;
    expect(result.state).toBe("completed");
    expect(result.liveText).toContain("steered: focus on the tests");
    // Mid-turn steering used the steer verb; the only prompt is the task itself.
    expect(commandCounts(result.stderr)).toEqual({ prompt: 1, steer: 1 });
  });
});
