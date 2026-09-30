import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
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
		static searchNodes = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([{ name: "Luke" }]));
		static recentEpisodes = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([{ name: "Decision" }]));
		status() {
			return MockGraphitiClient.status();
		}
		searchFacts(query: string, maxFacts: number) {
			return MockGraphitiClient.searchFacts(query, maxFacts);
		}
		addMemory(input: unknown) {
			return MockGraphitiClient.addMemory(input);
		}
		searchNodes() {
			return MockGraphitiClient.searchNodes();
		}
		recentEpisodes() {
			return MockGraphitiClient.recentEpisodes();
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
	const tools = new Map<
		string,
		{ execute: (...args: unknown[]) => Promise<unknown>; outputSchema?: TSchema }
	>();
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
			if (name === "before_agent_start") event.systemPromptOptions ??= { sections: {} };
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

	it("adds the native memory prompt section synchronously without replacing instructions", async () => {
		const h = harness();
		h.fire("session_start");
		const event = {
			prompt: LONG_PROMPT,
			systemPrompt: "base",
			systemPromptOptions: { sections: { existing: "Keep me" } },
		};
		const [result] = h.fire("before_agent_start", event);
		expect(result).toBeUndefined();
		expect(event.systemPrompt).toBe("base");
		expect(event.systemPromptOptions.sections).toMatchObject({
			existing: "Keep me",
			graphiti_memory: expect.stringContaining("## Graphiti memory"),
		});
		// Let the background recall settle so it cannot leak into later tests.
		await vi.waitFor(() => expect(MockGraphitiClient.searchFacts).toHaveBeenCalled());
	});

	it.each(["facts", "nodes", "episodes"])("returns schema-valid structured %s results", async (mode) => {
		const h = harness();
		const tool = h.tools.get("memory_recall")!;
		const result = (await tool.execute("id", { query: "q", mode }, undefined)) as {
			content: { text: string }[];
			structuredContent: { mode: string; results: unknown[] };
		};
		expect(Value.Check(tool.outputSchema!, result.structuredContent)).toBe(true);
		expect(result.structuredContent.mode).toBe(mode);
		expect(result.structuredContent.results).toEqual(JSON.parse(result.content[0]!.text));
	});

	it("returns schema-valid memory writes and health data", async () => {
		const h = harness();
		for (const [name, params] of [
			["memory_remember", { name: "n", body: "b" }],
			["memory_status", {}],
		] as const) {
			const tool = h.tools.get(name)!;
			const result = (await tool.execute("id", params, undefined)) as { structuredContent: unknown };
			expect(Value.Check(tool.outputSchema!, result.structuredContent)).toBe(true);
		}
	});

	it("does not publish a recall that finishes after session shutdown", async () => {
		let finish!: (facts: FactResult[]) => void;
		MockGraphitiClient.searchFacts.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const h = harness();
		h.fire("session_start");
		h.fire("before_agent_start", { prompt: LONG_PROMPT });
		await vi.waitFor(() => expect(MockGraphitiClient.searchFacts).toHaveBeenCalled());
		h.fire("session_shutdown");
		finish([{ fact: "Stale session fact" }]);
		await flushMicrotasks();
		expect(dispatchQueue().size()).toBe(0);
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
