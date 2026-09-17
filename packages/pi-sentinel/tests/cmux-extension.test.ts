import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resetDispatchForTests } from "@parke.dev/pi-dispatch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSentinel } from "../extensions/sentinel.ts";
import { createCmuxStatus } from "../src/cmux.ts";
import { SentinelManager, type ProbeRunner, type StreamRunner } from "../src/manager.ts";
import type { PrSnapshot } from "../src/pr.ts";

const { run } = vi.hoisted(() => ({ run: vi.fn<(binary: string, args: string[]) => Promise<void>>() }));
vi.mock("../src/cmux.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/cmux.ts")>();
	return { ...actual, createCmuxStatus: vi.fn((target) => actual.createCmuxStatus(target, run)) };
});

const disposals: Array<() => Promise<void>> = [];
function harness({
	enabled = true,
	mode = "tui",
	runner,
	streamRunner,
}: {
	enabled?: boolean;
	mode?: ExtensionContext["mode"];
	runner?: ProbeRunner;
	streamRunner?: StreamRunner;
} = {}) {
	const manager = new SentinelManager(runner, undefined, streamRunner);
	const handlers = new Map<string, Array<(event: {}, ctx: ExtensionContext) => unknown>>();
	const ui = {
		theme: { fg: (_: string, text: string) => `\x1b[33m${text}\x1b[0m` },
		setStatus: vi.fn(),
		setWidget: vi.fn(),
	};
	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd: "/tmp",
		isIdle: () => false,
		sessionManager: { getSessionId: () => "test-session" },
		ui,
	} as unknown as ExtensionContext;
	const sendMessage = vi.fn();
	registerSentinel(
		{
			on: (name: string, handler: (event: {}, ctx: ExtensionContext) => unknown) =>
				handlers.set(name, [...(handlers.get(name) ?? []), handler]),
			registerTool: vi.fn(),
			sendMessage,
		} as unknown as ExtensionAPI,
		manager,
		{ cmuxStatus: enabled },
	);
	const emit = async (event: string) => {
		for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
	};
	disposals.push(() => emit("session_shutdown"));
	return { manager, emit, ui, sendMessage };
}

async function flush() {
	for (const result of vi.mocked(createCmuxStatus).mock.results) {
		if (result.type === "return") await result.value.flush();
	}
}
const lastArgs = () => run.mock.calls.at(-1)?.[1];
const label = () => (lastArgs()?.[0] === "set-status" ? lastArgs()?.[2] : undefined);

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	run.mockReset().mockResolvedValue(undefined);
	resetDispatchForTests();
	vi.stubEnv("CMUX_WORKSPACE_ID", "11111111-1111-1111-1111-111111111111");
	vi.stubEnv("CMUX_SURFACE_ID", "22222222-2222-2222-2222-222222222222");
	vi.stubEnv("CMUX_PI_HOOKS_DISABLED", "0");
	vi.stubEnv("CMUX_BUNDLED_CLI_PATH", "/test/bin/cmux");
});
afterEach(async () => {
	for (const dispose of disposals.splice(0)) await dispose();
	resetDispatchForTests();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("Sentinel authoritative cmux status", () => {
	it("tracks registrations, individual cancellation and cancel-all without model calls", async () => {
		const h = harness();
		await h.emit("session_start");
		await flush();
		expect(run).not.toHaveBeenCalled();
		h.manager.watch({ name: "private name", command: "secret command", cwd: "/tmp" });
		h.manager.sleep("private sleep", Date.now() + 60_000);
		h.manager.setGate({ cwd: "/tmp", criteria: [{ name: "private criterion", command: "secret" }] });
		await flush();
		expect(label()).toBe("Watching · 1 watch, 1 sleep, gate 0/1");
		expect(h.ui.setStatus).toHaveBeenLastCalledWith(
			"sentinel",
			"\x1b[33m◉ 1 watch, 1 sleep, gate 0/1\x1b[0m",
		);
		h.manager.cancel("private name");
		await flush();
		expect(label()).toBe("Watching · 1 sleep, gate 0/1");
		h.manager.cancel("gate");
		await flush();
		expect(label()).toBe("Watching · 1 sleep");
		h.manager.cancel(undefined, true);
		await flush();
		expect(lastArgs()?.[0]).toBe("clear-status");
		expect(h.sendMessage).not.toHaveBeenCalled();
		expect(JSON.stringify(run.mock.calls)).not.toMatch(/private|secret|test-session|\\u001b/);
		for (const [binary, args] of run.mock.calls) {
			expect(binary).toBe("/test/bin/cmux");
			expect(args[1]).toMatch(/^sentinel-/);
			expect(args[args.indexOf("--workspace") + 1]).toBe(process.env.CMUX_WORKSPACE_ID);
		}
	});

	it("keeps changed watches active, drops completed/timed-out watches and elapsed sleeps", async () => {
		let output = "one";
		let code = 1;
		const h = harness({ runner: async () => ({ exitCode: code, stdout: output, stderr: "" }) });
		await h.emit("session_start");
		h.manager.watch({
			name: "changing",
			command: "check",
			cwd: "/tmp",
			intervalMs: 1000,
			wakeOnChange: true,
		});
		h.manager.watch({ name: "timeout", command: "check", cwd: "/tmp", intervalMs: 1000, timeoutMs: 1500 });
		h.manager.sleep("timer", Date.now() + 2500);
		await flush();
		expect(label()).toBe("Watching · 2 watches, 1 sleep");
		await h.emit("agent_settled");
		await vi.advanceTimersByTimeAsync(0);
		output = "two";
		await vi.advanceTimersByTimeAsync(1000);
		await flush();
		expect(h.manager.snapshot().items[0]?.lastOutput).toBe("two");
		expect(label()).toBe("Watching · 2 watches, 1 sleep");
		expect(run).toHaveBeenCalledTimes(1); // changed output is not sidebar text
		await vi.advanceTimersByTimeAsync(500);
		await flush();
		expect(label()).toBe("Watching · 1 watch, 1 sleep");
		code = 0;
		await vi.advanceTimersByTimeAsync(500);
		await flush();
		expect(label()).toBe("Watching · 1 sleep");
		await vi.advanceTimersByTimeAsync(500);
		await flush();
		expect(lastArgs()?.[0]).toBe("clear-status");
	});

	it("tracks gate progress, quiet-window success, replacement and cancellation", async () => {
		let secondPasses = false;
		const h = harness({
			runner: async (command) => ({
				exitCode: command === "one" || secondPasses ? 0 : 1,
				stdout: "private output",
				stderr: "",
			}),
		});
		await h.emit("session_start");
		h.manager.setGate({
			cwd: "/tmp",
			intervalMs: 1000,
			quietForMs: 500,
			criteria: [
				{ name: "one", command: "one" },
				{ name: "two", command: "two" },
			],
		});
		await flush();
		expect(label()).toBe("Watching · gate 0/2");
		await h.emit("agent_settled");
		await vi.advanceTimersByTimeAsync(0);
		await flush();
		expect(label()).toBe("Watching · gate 1/2");
		secondPasses = true;
		await vi.advanceTimersByTimeAsync(1000);
		await flush();
		expect(label()).toBe("Watching · gate 2/2");
		await vi.advanceTimersByTimeAsync(500);
		await flush();
		expect(lastArgs()?.[0]).toBe("clear-status");
		h.manager.setGate({ cwd: "/tmp", criteria: [{ name: "new", command: "two" }] });
		await flush();
		expect(label()).toBe("Watching · gate 0/1");
		h.manager.cancel("gate");
		await flush();
		expect(lastArgs()?.[0]).toBe("clear-status");
	});

	it("drops failed stream watches and keeps only the latest replaced sleep", async () => {
		let finish!: Parameters<StreamRunner>[2];
		const h = harness({
			streamRunner: (_command, _cwd, onExit) => {
				finish = onExit;
				return { kill: vi.fn() };
			},
		});
		await h.emit("session_start");
		h.manager.watch({ name: "stream", command: "check", cwd: "/tmp", mode: "stream" });
		h.manager.sleep("sleep", Date.now() + 500);
		h.manager.sleep("sleep", Date.now() + 1000);
		await flush();
		expect(label()).toBe("Watching · 1 watch, 1 sleep");
		finish({ exitCode: 1, stdout: "private", stderr: "" });
		await flush();
		expect(label()).toBe("Watching · 1 sleep");
		await vi.advanceTimersByTimeAsync(500);
		await flush();
		expect(label()).toBe("Watching · 1 sleep");
		await vi.advanceTimersByTimeAsync(500);
		await flush();
		expect(lastArgs()?.[0]).toBe("clear-status");
	});

	it("includes active PRs and clears their badge on closure", async () => {
		const snapshot: PrSnapshot = {
			repo: "owner/repo",
			number: 1,
			title: "private title",
			url: "https://example.com/pr/1",
			viewer: "viewer",
			lifecycle: "open",
			headSha: "abc",
			merge: "clean",
			checks: "passing",
			failingChecks: [],
			reviewDecision: "none",
			unresolvedThreads: 0,
			activities: [],
		};
		const h = harness();
		await h.emit("session_start");
		h.manager.attachPr({
			name: "pr",
			repo: snapshot.repo,
			number: 1,
			initialSnapshot: snapshot,
			probe: async () => ({ ...snapshot, lifecycle: "closed" }),
			intervalMs: 1000,
		});
		await flush();
		expect(label()).toBe("Watching · 1 PR");
		await h.emit("agent_settled");
		await vi.advanceTimersByTimeAsync(1000);
		await flush();
		expect(lastArgs()?.[0]).toBe("clear-status");
	});

	it("keeps Sentinel working when sidebar writes fail", async () => {
		run.mockRejectedValue(new Error("offline"));
		const h = harness();
		await h.emit("session_start");
		h.manager.sleep("sleep", Date.now() + 1000);
		await flush();
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("sentinel", "\x1b[33m◉ 1 sleep\x1b[0m");
		await vi.advanceTimersByTimeAsync(1000);
		await flush();
		expect(h.manager.snapshot().items[0]?.state).toBe("complete");
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("sentinel", undefined);
	});

	it("awaits final cleanup and rejects late updates on shutdown", async () => {
		const h = harness();
		await h.emit("session_start");
		await flush();
		let release!: () => void;
		run.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		h.manager.sleep("sleep", Date.now() + 60_000);
		await Promise.resolve();
		const closing = h.emit("session_shutdown");
		await Promise.resolve();
		expect(run).toHaveBeenCalledTimes(1);
		release();
		await closing;
		expect(run.mock.calls.map((call) => call[1][0])).toEqual(["set-status", "clear-status"]);
		h.manager.cancel(undefined, true);
		await flush();
		expect(run).toHaveBeenCalledTimes(2);
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("sentinel", undefined);
		expect(h.ui.setWidget).toHaveBeenLastCalledWith("sentinel", undefined);
	});

	it("does not resurrect the badge when a probe returns after shutdown", async () => {
		let finish!: (result: Awaited<ReturnType<ProbeRunner>>) => void;
		const h = harness({
			runner: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		});
		await h.emit("session_start");
		h.manager.watch({ name: "pending", command: "check", cwd: "/tmp" });
		await flush();
		await h.emit("agent_settled");
		await vi.advanceTimersByTimeAsync(0);
		await h.emit("session_shutdown");
		const calls = run.mock.calls.length;
		finish({ exitCode: 0, stdout: "late", stderr: "" });
		await vi.advanceTimersByTimeAsync(0);
		await flush();
		expect(run).toHaveBeenCalledTimes(calls);
		expect(lastArgs()?.[0]).toBe("clear-status");
	});

	it.each(["rpc", "json", "print"] as const)("never invokes cmux in %s mode", async (mode) => {
		const h = harness({ mode });
		await h.emit("session_start");
		h.manager.sleep("sleep", Date.now() + 1000);
		await h.emit("session_shutdown");
		expect(createCmuxStatus).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});

	it.each(["opt-out", "outside-cmux", "missing-surface", "invalid-workspace", "disabled-child"])(
		"does nothing when %s",
		async (scenario) => {
			if (scenario === "outside-cmux") vi.stubEnv("CMUX_WORKSPACE_ID", undefined);
			if (scenario === "missing-surface") vi.stubEnv("CMUX_SURFACE_ID", undefined);
			if (scenario === "invalid-workspace") vi.stubEnv("CMUX_WORKSPACE_ID", "selected");
			if (scenario === "disabled-child") vi.stubEnv("CMUX_PI_HOOKS_DISABLED", "1");
			const h = harness({ enabled: scenario !== "opt-out" });
			await h.emit("session_start");
			h.manager.sleep("sleep", Date.now() + 1000);
			await h.emit("session_shutdown");
			expect(createCmuxStatus).not.toHaveBeenCalled();
			expect(run).not.toHaveBeenCalled();
		},
	);
});
