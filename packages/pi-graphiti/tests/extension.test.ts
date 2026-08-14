import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchQueue, resetDispatchForTests } from "@parke.dev/pi-dispatch";
import type { FactResult } from "../src/client.ts";
import { resetConfigCache } from "../src/config.ts";

// Keep tests hermetic: without this, config load() reads the real ~/.pi/graphiti.json.
const ISOLATED_AGENT_DIR = path.join(os.tmpdir(), "pi-graphiti-test-nonexistent", "agent");

const { MockGraphitiClient } = vi.hoisted(() => {
	class MockGraphitiClient {
		static status = vi.fn<() => Promise<{ status: string }>>(() => Promise.resolve({ status: "ok" }));
		static searchFacts = vi.fn<(query: string, maxFacts: number) => Promise<FactResult[]>>(() =>
			Promise.resolve([]),
		);
		static addMemory = vi.fn<(input: unknown) => Promise<string>>(() => Promise.resolve("stored"));
		status() {
			return MockGraphitiClient.status();
		}
		searchFacts(query: string, maxFacts: number) {
			return MockGraphitiClient.searchFacts(query, maxFacts);
		}
		addMemory(input: unknown) {
			return MockGraphitiClient.addMemory(input);
		}
		close() {}
	}
	return { MockGraphitiClient };
});

vi.mock("../src/client.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/client.ts")>();
	return { ...original, GraphitiClient: MockGraphitiClient };
});

const { default: graphitiExtension } = await import("../extensions/graphiti.ts");

const LONG_PROMPT = "refactor the graphiti extension to be non-blocking and conversation aware";

function harness() {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const pi = {
		on: (name: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
			tools.set(tool.name, tool);
		},
	};
	graphitiExtension(pi as never);
	const ctx = {
		hasUI: false,
		isIdle: () => true,
		cwd: os.tmpdir(),
		sessionManager: { getBranch: () => [] },
		ui: { setStatus: vi.fn() },
	};
	return {
		tools,
		ctx,
		fire(name: string, event: Record<string, unknown> = {}) {
			const results: unknown[] = [];
			for (const handler of handlers.get(name) ?? []) results.push(handler(event, ctx));
			return results;
		},
	};
}

async function flushMicrotasks(rounds = 20): Promise<void> {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
}

describe("graphiti extension", () => {
	beforeEach(() => {
		process.env.PI_CODING_AGENT_DIR = ISOLATED_AGENT_DIR;
		process.env.GRAPHITI_BASE_URL = "https://memory.test/mcp";
		resetConfigCache();
		resetDispatchForTests();
		MockGraphitiClient.status.mockClear().mockResolvedValue({ status: "ok" });
		MockGraphitiClient.searchFacts.mockClear().mockResolvedValue([]);
		MockGraphitiClient.addMemory.mockClear().mockResolvedValue("stored");
	});

	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.GRAPHITI_BASE_URL;
		resetConfigCache();
		resetDispatchForTests();
	});

	it("before_agent_start returns synchronously with only the system prompt append", async () => {
		const h = harness();
		h.fire("session_start");
		const [result] = h.fire("before_agent_start", { prompt: LONG_PROMPT, systemPrompt: "base" }) as [
			{ systemPrompt: string; message?: unknown },
		];
		expect(result).not.toBeInstanceOf(Promise);
		expect(result.systemPrompt).toContain("base");
		expect(result.systemPrompt).toContain("## Graphiti memory");
		expect(result.message).toBeUndefined();
		// Let the background recall settle so it cannot leak into later tests.
		await vi.waitFor(() => expect(MockGraphitiClient.searchFacts).toHaveBeenCalled());
	});

	it("never rejects when the client explodes during background recall", async () => {
		MockGraphitiClient.searchFacts.mockRejectedValue(new Error("server exploded"));
		const h = harness();
		h.fire("session_start");
		h.fire("before_agent_start", { prompt: LONG_PROMPT, systemPrompt: "base" });
		await vi.waitFor(() => expect(MockGraphitiClient.searchFacts).toHaveBeenCalled());
		await flushMicrotasks();
		expect(dispatchQueue().peek()).toHaveLength(0);
	});

	it("publishes background recall as one folded dispatch item", async () => {
		MockGraphitiClient.searchFacts.mockResolvedValue([{ fact: "alpha", invalid_at: null }]);
		const h = harness();
		h.fire("session_start");
		h.fire("before_agent_start", { prompt: LONG_PROMPT, systemPrompt: "base" });
		await vi.waitFor(() => expect(dispatchQueue().size()).toBe(1));
		const [item] = dispatchQueue().peek();
		expect(item!.id).toBe("graphiti:recall");
		expect(item!.source).toBe("graphiti");
		expect(item!.priority).toBe("info");
		expect(item!.urgency).toBe("next-turn");
		expect(item!.message).toContain("Recalled from memory");
		expect(item!.message).toContain("- alpha");
		expect(item!.details?.facts).toHaveLength(1);

		// Same facts again: the delta filter drops them, nothing new is queued.
		MockGraphitiClient.searchFacts.mockClear();
		h.fire("before_agent_start", { prompt: LONG_PROMPT, systemPrompt: "base" });
		await flushMicrotasks();
		expect(dispatchQueue().size()).toBe(1);
		expect(dispatchQueue().peek()[0]!.foldCount).toBe(1);
	});

	it("fires the store reminder once at 10 settled turns, only without a prior remember", async () => {
		const h = harness();
		h.fire("session_start");
		for (let i = 0; i < 9; i++) h.fire("agent_settled");
		expect(
			dispatchQueue()
				.peek()
				.find((item) => item.id === "graphiti:store-reminder"),
		).toBeUndefined();
		h.fire("agent_settled");
		expect(
			dispatchQueue()
				.peek()
				.find((item) => item.id === "graphiti:store-reminder"),
		).toBeDefined();
		for (let i = 0; i < 5; i++) h.fire("agent_settled");
		expect(
			dispatchQueue()
				.peek()
				.filter((item) => item.id === "graphiti:store-reminder"),
		).toHaveLength(1);
	});

	it("never fires the store reminder after a memory_remember", async () => {
		const h = harness();
		h.fire("session_start");
		const remember = h.tools.get("memory_remember")!;
		await remember.execute("id", { name: "n", body: "b" }, undefined);
		for (let i = 0; i < 12; i++) h.fire("agent_settled");
		expect(
			dispatchQueue()
				.peek()
				.find((item) => item.id === "graphiti:store-reminder"),
		).toBeUndefined();
	});

	it("suppresses a queued store reminder when memory_remember lands", async () => {
		const h = harness();
		h.fire("session_start");
		for (let i = 0; i < 10; i++) h.fire("agent_settled");
		expect(
			dispatchQueue()
				.peek()
				.find((item) => item.id === "graphiti:store-reminder"),
		).toBeDefined();
		const remember = h.tools.get("memory_remember")!;
		await remember.execute("id", { name: "n", body: "b" }, undefined);
		expect(
			dispatchQueue()
				.peek()
				.find((item) => item.id === "graphiti:store-reminder"),
		).toBeUndefined();
	});

	it("feeds manual memory_recall results into the delta filter", async () => {
		const h = harness();
		h.fire("session_start");
		MockGraphitiClient.searchFacts.mockResolvedValue([{ fact: "manual", invalid_at: null }]);
		const recall = h.tools.get("memory_recall")!;
		await recall.execute("id", { query: "q" }, undefined);
		// Auto-recall returning the same fact must not publish it again.
		MockGraphitiClient.searchFacts.mockClear();
		h.fire("before_agent_start", { prompt: LONG_PROMPT, systemPrompt: "base" });
		await vi.waitFor(() => expect(MockGraphitiClient.searchFacts).toHaveBeenCalled());
		await flushMicrotasks();
		expect(
			dispatchQueue()
				.peek()
				.find((item) => item.id === "graphiti:recall"),
		).toBeUndefined();
	});
});
