import { describe, expect, it, vi } from "vitest";
import type { FactResult } from "../src/client.ts";
import type { GraphitiConfig } from "../src/config.ts";
import { defaultConfig } from "../src/config.ts";
import {
	RecallPipeline,
	buildRecallQuery,
	extractRecallContext,
	formatRecallMessage,
	hashFact,
} from "../src/recall.ts";

function config(overrides: Partial<GraphitiConfig> = {}): GraphitiConfig {
	return { ...defaultConfig, baseUrl: "https://memory.test/mcp", ...overrides };
}

function fact(text: string, invalid_at?: string): FactResult {
	return { fact: text, invalid_at: invalid_at ?? null };
}

function harness(configOverrides: Partial<GraphitiConfig> = {}, now?: () => number) {
	const searchFacts = vi.fn<(query: string, maxFacts: number) => Promise<FactResult[]>>();
	const publish = vi.fn<(facts: FactResult[]) => void>();
	const pipeline = new RecallPipeline({
		searchFacts,
		publish,
		// Cache disabled by default so each trigger hits the injected mock;
		// the cache test opts back in explicitly.
		config: () => Promise.resolve(config({ recallCacheTtlMs: 0, ...configOverrides })),
		...(now ? { now } : {}),
	});
	return { pipeline, searchFacts, publish };
}

const LONG_PROMPT = "refactor the graphiti extension to be non-blocking";

describe("buildRecallQuery", () => {
	it("combines the user message, assistant tail, and tool names", () => {
		const query = buildRecallQuery(
			{
				userMessage: LONG_PROMPT,
				assistantTail: "working on the recall pipeline",
				toolNames: ["bash", "edit"],
			},
			24,
		);
		expect(query).toBe(`${LONG_PROMPT}\nworking on the recall pipeline\ntools: bash, edit`);
	});

	it("returns undefined when the user message is below the min length gate", () => {
		expect(buildRecallQuery({ userMessage: "ok" }, 24)).toBeUndefined();
		expect(buildRecallQuery({ userMessage: "   ok   " }, 24)).toBeUndefined();
	});

	it("keeps only the last 300 chars of the assistant tail and dedupes tools", () => {
		const tail = "x".repeat(400);
		const query = buildRecallQuery(
			{ userMessage: LONG_PROMPT, assistantTail: tail, toolNames: ["bash", "bash", "edit"] },
			24,
		)!;
		const lines = query.split("\n");
		expect(lines[1]).toHaveLength(300);
		expect(lines[2]).toBe("tools: bash, edit");
	});
});

describe("extractRecallContext", () => {
	it("takes the latest user message, assistant tail, and tool activity", () => {
		const context = extractRecallContext([
			{ type: "message", message: { role: "user", content: "first question here" } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "answer one" },
						{ type: "toolCall", name: "bash" },
					],
				},
			},
			{ type: "message", message: { role: "toolResult", toolName: "bash", content: [] } },
			{ type: "message", message: { role: "user", content: "second question here" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer two" }] } },
		]);
		expect(context.userMessage).toBe("second question here");
		expect(context.assistantTail).toBe("answer two");
		expect(context.toolNames).toEqual(["bash"]);
	});

	it("ignores non-message entries and string assistant content", () => {
		const context = extractRecallContext([
			{ type: "compaction" },
			{ type: "message", message: { role: "assistant", content: "plain text" } },
		]);
		expect(context.userMessage).toBe("");
		expect(context.assistantTail).toBe("plain text");
	});
});

describe("RecallPipeline", () => {
	it("publishes fresh facts and drops already-seen ones on the next trigger", async () => {
		const { pipeline, searchFacts, publish } = harness();
		searchFacts.mockResolvedValue([fact("alpha"), fact("beta")]);
		await pipeline.trigger({ userMessage: LONG_PROMPT });
		expect(publish).toHaveBeenCalledTimes(1);
		expect(publish.mock.calls[0]![0].map((f) => f.fact)).toEqual(["alpha", "beta"]);

		searchFacts.mockResolvedValue([fact("alpha"), fact("gamma")]);
		await pipeline.trigger({ userMessage: LONG_PROMPT });
		expect(publish).toHaveBeenCalledTimes(2);
		expect(publish.mock.calls[1]![0].map((f) => f.fact)).toEqual(["gamma"]);
	});

	it("publishes nothing when results are empty or fully seen", async () => {
		const { pipeline, searchFacts, publish } = harness();
		searchFacts.mockResolvedValue([]);
		await pipeline.trigger({ userMessage: LONG_PROMPT });
		searchFacts.mockResolvedValue([fact("alpha")]);
		await pipeline.trigger({ userMessage: LONG_PROMPT });
		await pipeline.trigger({ userMessage: LONG_PROMPT });
		expect(publish).toHaveBeenCalledTimes(1);
	});

	it("does not search at all below the min prompt length or when disabled", async () => {
		const { pipeline, searchFacts, publish } = harness();
		await pipeline.trigger({ userMessage: "hi" });
		expect(searchFacts).not.toHaveBeenCalled();

		const disabled = harness({ autoRecallFacts: 0 });
		await disabled.pipeline.trigger({ userMessage: LONG_PROMPT });
		expect(disabled.searchFacts).not.toHaveBeenCalled();
		expect(publish).not.toHaveBeenCalled();
	});

	it("replaces the pending query (latest wins) instead of queueing a backlog", async () => {
		const { pipeline, searchFacts, publish } = harness();
		let release!: () => void;
		searchFacts.mockImplementationOnce(
			() =>
				new Promise<FactResult[]>((resolve) => {
					release = () => resolve([fact("slow")]);
				}),
		);
		searchFacts.mockResolvedValue([fact("fast")]);

		const first = pipeline.trigger({ userMessage: "first long enough prompt" });
		void pipeline.trigger({ userMessage: "second long enough prompt" });
		void pipeline.trigger({ userMessage: "third long enough prompt" });
		await vi.waitFor(() => expect(searchFacts).toHaveBeenCalledTimes(1));
		release();
		await first;
		// Allow the pending run to finish.
		await vi.waitFor(() => expect(searchFacts).toHaveBeenCalledTimes(2));

		const queries = searchFacts.mock.calls.map((call) => call[0]);
		expect(queries[0]).toContain("first long enough prompt");
		expect(queries[1]).toContain("third long enough prompt");
		expect(queries.some((q) => q.includes("second long enough prompt"))).toBe(false);
		expect(publish).toHaveBeenCalledTimes(2);
	});

	it("serves repeat queries from the TTL cache and expires them", async () => {
		let now = 1_000_000;
		const { pipeline, searchFacts } = harness({ recallCacheTtlMs: 120_000 }, () => now);
		searchFacts.mockResolvedValue([fact("alpha")]);

		await pipeline.trigger({ userMessage: LONG_PROMPT });
		await pipeline.trigger({ userMessage: LONG_PROMPT });
		expect(searchFacts).toHaveBeenCalledTimes(1);

		now += 120_001;
		await pipeline.trigger({ userMessage: LONG_PROMPT });
		expect(searchFacts).toHaveBeenCalledTimes(2);
	});

	it("swallows client failures without rejecting", async () => {
		const { pipeline, searchFacts, publish } = harness();
		searchFacts.mockRejectedValue(new Error("server exploded"));
		await expect(pipeline.trigger({ userMessage: LONG_PROMPT })).resolves.toBeUndefined();
		expect(publish).not.toHaveBeenCalled();
	});

	it("markSeen prevents auto-recall from re-surfacing manual recall results", async () => {
		const { pipeline, searchFacts, publish } = harness();
		pipeline.markSeen([fact("manual")]);
		searchFacts.mockResolvedValue([fact("manual"), fact("new")]);
		await pipeline.trigger({ userMessage: LONG_PROMPT });
		expect(publish.mock.calls[0]![0].map((f) => f.fact)).toEqual(["new"]);
	});
});

describe("formatRecallMessage", () => {
	it("formats the recall block with superseded markers", () => {
		const message = formatRecallMessage([fact("alpha"), fact("old", "2026-01-01")]);
		expect(message).toBe(
			"Recalled from memory (verify against current state before relying on):\n- alpha\n- old (superseded)",
		);
	});
});

describe("hashFact", () => {
	it("is stable and content-sensitive", () => {
		expect(hashFact("alpha")).toBe(hashFact("alpha"));
		expect(hashFact("alpha")).not.toBe(hashFact("beta"));
	});
});
