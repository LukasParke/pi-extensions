import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_STREAM_WATCHES, SentinelManager } from "../src/manager.ts";
import type { ProbeResult } from "../src/index.ts";

interface FakeProcess {
	command: string;
	exit: (result: ProbeResult) => void;
	kill: ReturnType<typeof vi.fn>;
}

function streamHarness() {
	const processes: FakeProcess[] = [];
	const runner = vi.fn((command: string, _cwd: string, exit: (result: ProbeResult) => void) => {
		const process = { command, exit, kill: vi.fn() };
		processes.push(process);
		return { kill: process.kill };
	});
	const manager = new SentinelManager(undefined, () => Date.now(), runner);
	const events: string[] = [];
	manager.onEvent((event) => events.push(event.message));
	manager.startSession();
	return { events, manager, processes, runner };
}

describe("stream watches", () => {
	afterEach(() => vi.useRealTimers());

	it("spawns once and wakes immediately when the process exits", () => {
		const h = streamHarness();
		h.manager.watch({ name: "ci", command: "gh pr checks 7 --watch", cwd: "/tmp", mode: "stream" });
		expect(h.runner).toHaveBeenCalledTimes(1);
		h.processes[0]!.exit({ exitCode: 0, stdout: "all green", stderr: "" });
		expect(h.runner).toHaveBeenCalledTimes(1);
		expect(h.events[0]).toContain("completed");
		expect(h.manager.snapshot().items[0]?.state).toBe("complete");
	});

	it("kills the child when cancelled", () => {
		const h = streamHarness();
		h.manager.watch({ name: "deploy", command: "kubectl rollout status", cwd: "/tmp", mode: "stream" });
		expect(h.manager.cancel("deploy")).toEqual(["deploy"]);
		expect(h.processes[0]!.kill).toHaveBeenCalledOnce();
		h.processes[0]!.exit({ exitCode: 0, stdout: "late", stderr: "" });
		expect(h.events).toEqual([]);
	});

	it("kills and wakes on timeout", async () => {
		vi.useFakeTimers();
		const h = streamHarness();
		h.manager.watch({
			name: "agent",
			command: "herdr agent wait x --until idle",
			cwd: "/tmp",
			mode: "stream",
			timeoutMs: 1_000,
		});
		await vi.advanceTimersByTimeAsync(1_000);
		expect(h.processes[0]!.kill).toHaveBeenCalledOnce();
		expect(h.events[0]).toContain("timed out");
		expect(h.manager.snapshot().items[0]?.state).toBe("timeout");
	});

	it("kills live children on session disposal", () => {
		const h = streamHarness();
		h.manager.watch({ name: "deploy", command: "kubectl rollout status", cwd: "/tmp", mode: "stream" });
		h.manager.dispose();
		expect(h.processes[0]!.kill).toHaveBeenCalledOnce();
	});

	it("enforces the concurrent stream cap", () => {
		const h = streamHarness();
		for (let index = 0; index < MAX_STREAM_WATCHES; index++) {
			h.manager.watch({ name: `stream-${index}`, command: "wait", cwd: "/tmp", mode: "stream" });
		}
		expect(() => h.manager.watch({ name: "too-many", command: "wait", cwd: "/tmp", mode: "stream" })).toThrow(
			`Max ${MAX_STREAM_WATCHES} stream watches`,
		);
		expect(h.runner).toHaveBeenCalledTimes(MAX_STREAM_WATCHES);
	});
});
