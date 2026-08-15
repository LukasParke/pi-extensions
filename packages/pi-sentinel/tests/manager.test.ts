import { afterEach, describe, expect, it, vi } from "vitest";
import { SentinelManager } from "../src/manager.ts";
import type { ProbeResult } from "../src/index.ts";
import type { PrSnapshot } from "../src/pr.ts";

const flush = async () => {
	await vi.runAllTimersAsync();
};

describe("SentinelManager", () => {
	afterEach(() => vi.useRealTimers());

	it("polls only while idle, wakes on stdout changes, and completes once", async () => {
		vi.useFakeTimers();
		const outputs: ProbeResult[] = [
			{ exitCode: 1, stdout: "pending", stderr: "" },
			{ exitCode: 1, stdout: "running", stderr: "" },
			{ exitCode: 0, stdout: "done", stderr: "" },
		];
		const runner = vi.fn(async () => outputs.shift()!);
		const events: string[] = [];
		const manager = new SentinelManager(runner);
		manager.onEvent((event) => events.push(event.message));
		manager.watch({ name: "ci", command: "check", cwd: "/tmp", intervalMs: 1_000, wakeOnChange: true });
		manager.startSession();
		manager.setIdle(false);

		await vi.advanceTimersByTimeAsync(5_000);
		expect(runner).not.toHaveBeenCalled();

		manager.setIdle(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(runner).toHaveBeenCalledTimes(1);
		expect(events).toEqual([]);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(events[0]).toContain("output changed");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(events[1]).toContain("completed");
		expect(manager.snapshot().items[0]?.state).toBe("complete");
	});

	it("expires watches and wakes with timeout status", async () => {
		vi.useFakeTimers();
		const runner = vi.fn(async () => ({ exitCode: 1, stdout: "pending", stderr: "" }));
		const events: string[] = [];
		const manager = new SentinelManager(runner);
		manager.onEvent((event) => events.push(event.message));
		manager.watch({ name: "deploy", command: "check", cwd: "/tmp", intervalMs: 10_000, timeoutMs: 2_000 });
		manager.startSession();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(events.at(-1)).toContain("timed out");
		expect(manager.snapshot().items[0]?.state).toBe("timeout");
	});

	it("attaches a PR, baselines silently, and wakes on actionable updates", async () => {
		vi.useFakeTimers();
		const snapshot = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
			repo: "o/r",
			number: 7,
			title: "PR",
			url: "https://github.com/o/r/pull/7",
			viewer: "agent",
			lifecycle: "open",
			headSha: "abc",
			merge: "clean",
			checks: "passing",
			failingChecks: [],
			reviewDecision: "approved",
			unresolvedThreads: 0,
			activities: [],
			...over,
		});
		const values = [
			snapshot(),
			snapshot({ checks: "failing", failingChecks: ["test"] }),
			snapshot({ lifecycle: "merged" }),
		];
		const events: string[] = [];
		const manager = new SentinelManager();
		manager.onEvent((event) => events.push(event.message));
		manager.attachPr({
			name: "pr-7",
			repo: "o/r",
			number: 7,
			probe: async () => values.shift()!,
			intervalMs: 1_000,
		});
		manager.startSession();
		await vi.advanceTimersByTimeAsync(0);
		expect(events).toEqual([]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(events[0]).toContain("broken CI");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(events[1]).toContain("was merged");
		expect(manager.snapshot().items[0]?.state).toBe("complete");
	});

	it("backs off after a failed PR probe and recovers", async () => {
		vi.useFakeTimers();
		const snapshot: PrSnapshot = {
			repo: "o/r",
			number: 7,
			title: "PR",
			url: "https://github.com/o/r/pull/7",
			viewer: "agent",
			lifecycle: "open",
			headSha: "abc",
			merge: "clean",
			checks: "passing",
			failingChecks: [],
			reviewDecision: "approved",
			unresolvedThreads: 0,
			activities: [],
		};
		const probe = vi.fn().mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValue(snapshot);
		const manager = new SentinelManager();
		manager.attachPr({ name: "pr-7", repo: "o/r", number: 7, probe, intervalMs: 1_000 });
		manager.startSession();
		await vi.advanceTimersByTimeAsync(0);
		expect(manager.snapshot().items[0]).toMatchObject({ state: "failing", lastOutput: "temporary failure" });
		await vi.advanceTimersByTimeAsync(1_999);
		expect(probe).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(probe).toHaveBeenCalledTimes(2);
		expect(manager.snapshot().items[0]?.state).toBe("passing");
	});

	it("resumes PR polling when a poll is skipped while busy", async () => {
		vi.useFakeTimers();
		const snapshot: PrSnapshot = {
			repo: "o/r",
			number: 7,
			title: "PR",
			url: "https://github.com/o/r/pull/7",
			viewer: "agent",
			lifecycle: "open",
			headSha: "abc",
			merge: "clean",
			checks: "passing",
			failingChecks: [],
			reviewDecision: "approved",
			unresolvedThreads: 0,
			activities: [],
		};
		const probe = vi.fn(async () => snapshot);
		const manager = new SentinelManager();
		manager.attachPr({
			name: "pr-7",
			repo: "o/r",
			number: 7,
			probe,
			initialSnapshot: snapshot,
			intervalMs: 1_000,
		});
		manager.startSession();
		manager.setIdle(false);
		// The scheduled poll fires mid-turn and is skipped.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(probe).not.toHaveBeenCalled();
		// Settling must resume polling, not leave the sentinel dead.
		manager.setIdle(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(probe).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it("implements sleep without shell probes", async () => {
		vi.useFakeTimers();
		const runner = vi.fn();
		const events: string[] = [];
		const manager = new SentinelManager(runner);
		manager.onEvent((event) => events.push(event.message));
		manager.sleep("sleep-1", Date.now() + 60_000);
		manager.startSession();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(runner).not.toHaveBeenCalled();
		expect(events).toEqual(['Sentinel sleep "sleep-1" elapsed.']);
	});

	it("reports gate flips then ALL PASS after the quiet window", async () => {
		vi.useFakeTimers();
		const values: Record<string, ProbeResult[]> = {
			ci: [
				{ exitCode: 1, stdout: "red", stderr: "" },
				{ exitCode: 0, stdout: "green", stderr: "" },
				{ exitCode: 0, stdout: "green", stderr: "" },
				{ exitCode: 0, stdout: "green", stderr: "" },
			],
			reviews: [
				{ exitCode: 0, stdout: "clear", stderr: "" },
				{ exitCode: 0, stdout: "clear", stderr: "" },
				{ exitCode: 0, stdout: "clear", stderr: "" },
				{ exitCode: 0, stdout: "clear", stderr: "" },
			],
		};
		const runner = vi.fn(async (command: string) => values[command]!.shift()!);
		const events: string[] = [];
		const manager = new SentinelManager(runner);
		manager.onEvent((event) => events.push(event.message));
		manager.setGate({
			cwd: "/tmp",
			intervalMs: 1_000,
			quietForMs: 2_000,
			criteria: [
				{ name: "CI", command: "ci" },
				{ name: "Reviews", command: "reviews" },
			],
		});
		manager.startSession();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(events[0]).toContain("CI: FAIL → PASS");
		expect(manager.snapshot().gate?.complete).toBe(false);
		await vi.advanceTimersByTimeAsync(2_001);
		expect(events.at(-1)).toContain("ALL PASS");
		expect(manager.snapshot().gate?.complete).toBe(true);
	});

	describe("idempotent creation", () => {
		it("returns the existing watch on a same-spec re-create", () => {
			const manager = new SentinelManager();
			const first = manager.watch({ name: "ci", command: "check", cwd: "/tmp", intervalMs: 5_000 });
			const second = manager.watch({
				name: "ci",
				command: "check",
				cwd: "/tmp",
				intervalMs: 5_000,
			});
			expect(first.created).toBe(true);
			expect(second.created).toBe(false);
			expect(second.sentinel).toEqual(first.sentinel);
			expect(manager.snapshot().items).toHaveLength(1);
		});

		it("returns the existing PR sentinel on a same-spec re-attach", () => {
			const manager = new SentinelManager();
			const probe = async () => ({}) as never;
			const options = { name: "pr-7", repo: "o/r", number: 7, probe };
			expect(manager.attachPr(options).created).toBe(true);
			expect(manager.attachPr(options).created).toBe(false);
			expect(manager.snapshot().items).toHaveLength(1);
		});

		it("fails on a different spec, showing both, and suggests replace: true", () => {
			const manager = new SentinelManager();
			manager.watch({ name: "ci", command: "check", cwd: "/tmp" });
			expect(() => manager.watch({ name: "ci", command: "check --fix", cwd: "/tmp" })).toThrow(
				/different spec.*Existing:.*check.*Requested:.*check --fix.*replace: true/s,
			);
			expect(manager.snapshot().items[0]?.command).toBe("check");
		});

		it("replaces a same-name watch with a different spec when replace is true", () => {
			const manager = new SentinelManager();
			manager.watch({ name: "ci", command: "check", cwd: "/tmp" });
			const replaced = manager.watch({ name: "ci", command: "check --fix", cwd: "/tmp", replace: true });
			expect(replaced.created).toBe(true);
			expect(replaced.sentinel.command).toBe("check --fix");
			expect(manager.snapshot().items).toHaveLength(1);
			expect(manager.watch({ name: "ci", command: "check --fix", cwd: "/tmp" }).created).toBe(false);
		});
	});

	it("cancels named and all sentinels", async () => {
		vi.useFakeTimers();
		const manager = new SentinelManager(async () => ({ exitCode: 1, stdout: "", stderr: "" }));
		manager.watch({ name: "one", command: "false", cwd: "/tmp" });
		manager.sleep("two", Date.now() + 60_000);
		manager.setGate({ cwd: "/tmp", criteria: [{ name: "gate item", command: "false" }] });
		expect(manager.cancel("one")).toEqual(["one"]);
		expect(manager.cancel(undefined, true).sort()).toEqual(["gate", "two"]);
		expect(manager.snapshot()).toEqual({ items: [], gate: undefined });
		await flush();
	});
});
