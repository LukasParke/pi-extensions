import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSentinel } from "../extensions/sentinel.ts";
import { SentinelManager } from "../src/manager.ts";

function harness(manager = new SentinelManager()) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const sentMessages: Array<{ message: any; options?: any }> = [];
	let idle = true;
	const ctx = {
		cwd: "/tmp",
		hasUI: false,
		isIdle: () => idle,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: vi.fn(),
			setWidget: vi.fn(),
		},
	};
	const pi = {
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		sendMessage: (message: any, options?: any) => sentMessages.push({ message, options }),
	};
	registerSentinel(pi as any, manager);
	return {
		ctx,
		handlers,
		manager,
		sentMessages,
		setIdle(value: boolean) {
			idle = value;
		},
		execute(name: string, params: Record<string, unknown>) {
			return tools.get(name)!.execute("call", params, undefined, undefined, ctx);
		},
	};
}

describe("sentinel extension delivery", () => {
	afterEach(() => vi.useRealTimers());

	it("replaces unnamed sleeps in the fixed sleep slot", async () => {
		vi.useFakeTimers();
		const h = harness();
		await h.handlers.get("session_start")!({}, h.ctx);
		await h.execute("sentinel_sleep", { minutes: 1 });
		await h.execute("sentinel_sleep", { minutes: 2 });
		expect(h.manager.snapshot().items.map((item) => item.name)).toEqual(["sleep"]);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.sentMessages).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(62_000);
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0]!.message.content).toContain('sleep "sleep" elapsed');
	});

	it("replaces pending named sleeps with the same name", async () => {
		vi.useFakeTimers();
		const h = harness();
		await h.handlers.get("session_start")!({}, h.ctx);
		await h.execute("sentinel_sleep", { name: "review", minutes: 1 });
		await h.execute("sentinel_sleep", { name: "review", minutes: 3 });
		expect(h.manager.snapshot().items.map((item) => item.name)).toEqual(["review"]);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(h.sentMessages).toHaveLength(0);
	});

	it("drops a queued sleep event when the slot is replaced", async () => {
		vi.useFakeTimers();
		const h = harness();
		h.setIdle(false);
		await h.handlers.get("session_start")!({}, h.ctx);
		await h.execute("sentinel_sleep", { name: "review", minutes: 0.001 });
		await vi.advanceTimersByTimeAsync(100);
		await h.execute("sentinel_sleep", { name: "review", minutes: 10 });
		h.setIdle(true);
		await h.handlers.get("agent_settled")!({}, h.ctx);
		await vi.advanceTimersByTimeAsync(2_100);
		expect(h.sentMessages).toHaveLength(0);
	});

	it("drops queued events when their sentinel is cancelled", async () => {
		vi.useFakeTimers();
		const h = harness();
		h.setIdle(false);
		await h.handlers.get("session_start")!({}, h.ctx);
		await h.execute("sentinel_sleep", { name: "stale", minutes: 0.001 });
		await vi.advanceTimersByTimeAsync(100);
		await h.execute("sentinel_cancel", { name: "stale" });
		h.setIdle(true);
		await h.handlers.get("agent_settled")!({}, h.ctx);
		await vi.advanceTimersByTimeAsync(2_100);
		expect(h.sentMessages).toHaveLength(0);
	});

	it("coalesces pending events and appends the active snapshot", async () => {
		vi.useFakeTimers();
		const h = harness();
		await h.handlers.get("session_start")!({}, h.ctx);
		await h.execute("sentinel_sleep", { name: "one", minutes: 0.001 });
		await h.execute("sentinel_sleep", { name: "two", minutes: 0.002 });
		await h.execute("sentinel_sleep", { name: "later", minutes: 10 });
		await vi.advanceTimersByTimeAsync(2_200);
		expect(h.sentMessages).toHaveLength(1);
		const delivery = h.sentMessages[0]!;
		expect(delivery.message.content).toContain("Sentinel wakeup (2 events)");
		expect(delivery.message.content).toContain('sleep "one" elapsed');
		expect(delivery.message.content).toContain('sleep "two" elapsed');
		expect(delivery.message.content).toContain("later [sleep/waiting]");
		expect(delivery.message.details.events).toHaveLength(2);
	});

	it("drops queued gate events when the gate is replaced", async () => {
		vi.useFakeTimers();
		const results = [
			{ exitCode: 1, stdout: "red", stderr: "" },
			{ exitCode: 0, stdout: "green", stderr: "" },
		];
		const manager = new SentinelManager(async () => results.shift()!);
		const h = harness(manager);
		h.setIdle(false);
		await h.handlers.get("session_start")!({}, h.ctx);
		await h.execute("sentinel_gate", { criteria: [{ name: "old", command: "check" }] });
		h.setIdle(true);
		await h.handlers.get("agent_settled")!({}, h.ctx);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(results).toHaveLength(0);
		h.setIdle(false);
		await h.handlers.get("agent_start")!({}, h.ctx);
		await h.execute("sentinel_gate", { criteria: [{ name: "new", command: "wait" }] });
		await vi.advanceTimersByTimeAsync(2_100);
		expect(h.sentMessages).toHaveLength(0);
	});

	it("registers the native PR attachment tool", async () => {
		const h = harness();
		await expect(h.execute("sentinel_pr", { number: 1, repo: "invalid repo" })).rejects.toThrow();
	});

	it("queues next-turn events without triggering a turn", async () => {
		vi.useFakeTimers();
		const manager = new SentinelManager(async () => ({ exitCode: 0, stdout: "done", stderr: "" }));
		const h = harness(manager);
		await h.handlers.get("session_start")!({}, h.ctx);
		await h.execute("sentinel_watch", {
			name: "quiet",
			command: "check",
			urgency: "next-turn",
		});
		await vi.advanceTimersByTimeAsync(2_100);
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0]!.options).toEqual({ deliverAs: "followUp" });
	});
});
