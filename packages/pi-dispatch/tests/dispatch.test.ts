import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchQueue, ensureDelivery, resetDispatchForTests } from "../src/index.ts";
import type { DispatchItem } from "../src/index.ts";

function harness() {
	const handlers = new Map<string, Function[]>();
	const sentMessages: Array<{ message: any; options?: any }> = [];
	let idle = true;
	const ctx = { isIdle: () => idle };
	const pi = {
		on: (name: string, handler: Function) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		sendMessage: vi.fn((message: any, options?: any) => sentMessages.push({ message, options })),
	};
	ensureDelivery(pi as any);
	return {
		ctx,
		handlers,
		pi,
		sentMessages,
		setIdle(value: boolean) {
			idle = value;
		},
		fire(name: string) {
			for (const handler of handlers.get(name) ?? []) handler({}, ctx);
		},
		start() {
			this.fire("session_start");
		},
		settle() {
			this.fire("agent_settled");
		},
	};
}

function item(partial: Partial<DispatchItem> & { id: string }) {
	return {
		source: `test:${partial.id}`,
		priority: "info" as const,
		urgency: "next-turn" as const,
		message: `message ${partial.id}`,
		...partial,
	};
}

describe("dispatch queue", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetDispatchForTests();
	});
	afterEach(() => vi.useRealTimers());

	it("accumulates while busy and drains as exactly one message on idle", async () => {
		const h = harness();
		h.start();
		h.setIdle(false);
		dispatchQueue().publish(item({ id: "a", urgency: "wake" }));
		dispatchQueue().publish(item({ id: "b" }));
		dispatchQueue().publish(item({ id: "c" }));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(h.sentMessages).toHaveLength(0);
		h.setIdle(true);
		h.settle();
		await vi.advanceTimersByTimeAsync(2_100);
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0]!.message.details.items.map((i: DispatchItem) => i.id)).toEqual(["a", "b", "c"]);
		expect(dispatchQueue().size()).toBe(0);
	});

	it("groups by priority in escalation → completion → info order with headers for non-empty groups", async () => {
		const h = harness();
		h.start();
		dispatchQueue().publish(item({ id: "i1", priority: "info" }));
		dispatchQueue().publish(item({ id: "e1", priority: "escalation" }));
		dispatchQueue().publish(item({ id: "c1", priority: "completion" }));
		await vi.advanceTimersByTimeAsync(2_100);
		expect(h.sentMessages).toHaveLength(1);
		const content: string = h.sentMessages[0]!.message.content;
		expect(content).toContain("## Escalations");
		expect(content).toContain("## Completions");
		expect(content).toContain("## Info");
		expect(content.indexOf("## Escalations")).toBeLessThan(content.indexOf("## Completions"));
		expect(content.indexOf("## Completions")).toBeLessThan(content.indexOf("## Info"));
		expect(content.indexOf("message e1")).toBeLessThan(content.indexOf("message c1"));
		expect(content.indexOf("message c1")).toBeLessThan(content.indexOf("message i1"));
	});

	it("omits headers for empty priority groups", async () => {
		const h = harness();
		h.start();
		dispatchQueue().publish(item({ id: "c1", priority: "completion" }));
		await vi.advanceTimersByTimeAsync(2_100);
		const content: string = h.sentMessages[0]!.message.content;
		expect(content).toContain("## Completions");
		expect(content).not.toContain("## Escalations");
		expect(content).not.toContain("## Info");
	});

	it("delivers with the dispatch custom type as a followUp", async () => {
		const h = harness();
		h.start();
		dispatchQueue().publish(item({ id: "a" }));
		await vi.advanceTimersByTimeAsync(2_100);
		expect(h.sentMessages[0]!.message.customType).toBe("dispatch");
		expect(h.sentMessages[0]!.options.deliverAs).toBe("followUp");
	});

	it("sets triggerTurn only when a wake-urgent item is in the batch", async () => {
		const h = harness();
		h.start();
		dispatchQueue().publish(item({ id: "quiet", urgency: "next-turn" }));
		await vi.advanceTimersByTimeAsync(2_100);
		expect(h.sentMessages[0]!.options).toEqual({ deliverAs: "followUp" });

		dispatchQueue().publish(item({ id: "loud", urgency: "wake" }));
		dispatchQueue().publish(item({ id: "quiet2", urgency: "next-turn" }));
		await vi.advanceTimersByTimeAsync(2_100);
		expect(h.sentMessages).toHaveLength(2);
		expect(h.sentMessages[1]!.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	});

	it("folds repeat publishes of the same id to the latest message with an (xN) suffix", async () => {
		const h = harness();
		h.start();
		dispatchQueue().publish(item({ id: "a", message: "first" }));
		dispatchQueue().publish(item({ id: "a", message: "second" }));
		dispatchQueue().publish(item({ id: "a", message: "third" }));
		expect(dispatchQueue().size()).toBe(1);
		const [queued] = dispatchQueue().peek();
		expect(queued!.message).toBe("third");
		expect(queued!.foldCount).toBe(3);
		await vi.advanceTimersByTimeAsync(2_100);
		expect(h.sentMessages).toHaveLength(1);
		const content: string = h.sentMessages[0]!.message.content;
		expect(content).toContain("third (x3)");
		expect(content).not.toContain("first");
	});

	it("suppresses queued items by source prefix", () => {
		harness().start();
		dispatchQueue().publish(item({ id: "a", source: "sentinel:pr-24" }));
		dispatchQueue().publish(item({ id: "b", source: "sentinel" }));
		dispatchQueue().publish(item({ id: "c", source: "sentinel-extra" }));
		dispatchQueue().publish(item({ id: "d", source: "subagent:run-1" }));
		expect(dispatchQueue().suppress("sentinel")).toBe(2);
		expect(
			dispatchQueue()
				.peek()
				.map((i) => i.source),
		).toEqual(["sentinel-extra", "subagent:run-1"]);
	});

	it("peeks and sizes without draining", async () => {
		const h = harness();
		h.start();
		dispatchQueue().publish(item({ id: "a", priority: "info" }));
		dispatchQueue().publish(item({ id: "b", priority: "escalation" }));
		expect(dispatchQueue().size()).toBe(2);
		expect(
			dispatchQueue()
				.peek()
				.map((i) => i.id),
		).toEqual(["b", "a"]);
		expect(dispatchQueue().size()).toBe(2);
		await vi.advanceTimersByTimeAsync(2_100);
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0]!.message.details.items).toHaveLength(2);
	});

	it("wires delivery hooks once across multiple ensureDelivery callers", async () => {
		const first = harness();
		const second = harness();
		first.start();
		second.fire("session_start"); // unwired: registering handlers never happened
		dispatchQueue().publish(item({ id: "a" }));
		await vi.advanceTimersByTimeAsync(2_100);
		expect(first.sentMessages).toHaveLength(1);
		expect(second.sentMessages).toHaveLength(0);
		expect(second.handlers.size).toBe(0);
	});

	it("keeps the batch queued when sending fails", async () => {
		const h = harness();
		h.start();
		dispatchQueue().publish(item({ id: "a", urgency: "wake" }));
		h.pi.sendMessage.mockImplementationOnce(() => {
			throw new Error("session gone");
		});
		await vi.advanceTimersByTimeAsync(2_100);
		expect(h.sentMessages).toHaveLength(0);
		expect(dispatchQueue().size()).toBe(1);
		h.settle();
		await vi.advanceTimersByTimeAsync(2_100);
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0]!.message.details.items.map((i: DispatchItem) => i.id)).toEqual(["a"]);
		expect(dispatchQueue().size()).toBe(0);
	});
});
