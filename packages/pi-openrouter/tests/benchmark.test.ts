import { describe, expect, it } from "vitest";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import {
	createToolHarness,
	mean,
	payloadReplaysReasoning,
	renderReport,
	runTrial,
	summarize,
	type StreamFn,
	type TrialResult,
} from "../src/benchmark.ts";

describe("tool harness", () => {
	it("answers reads deterministically", () => {
		const harness = createToolHarness();
		expect(harness.answer("read_file", { path: "math.py" })).toContain("a - b");
		expect(harness.answer("read_file", { path: "math.py" })).toContain("a - b");
		expect(harness.answer("read_file", { path: "nope.py" })).toMatch(/^ERROR/);
	});

	it("fails the first test run and passes the second", () => {
		const harness = createToolHarness();
		expect(harness.answer("run_tests", {})).toContain("FAILED");
		expect(harness.answer("run_tests", {})).toContain("passed");
		expect(harness.answer("run_tests", {})).toContain("passed");
	});
});

describe("payloadReplaysReasoning", () => {
	it("detects reasoning_details on completions assistant messages", () => {
		expect(
			payloadReplaysReasoning("openai-completions", {
				messages: [
					{ role: "user", content: "hi" },
					{ role: "assistant", content: "", reasoning_details: [{ type: "reasoning.encrypted" }] },
				],
			}),
		).toBe(true);
		expect(
			payloadReplaysReasoning("openai-completions", {
				messages: [{ role: "assistant", content: "x" }],
			}),
		).toBe(false);
	});

	it("detects reasoning items on responses input", () => {
		expect(
			payloadReplaysReasoning("openai-responses", {
				input: [{ type: "message" }, { type: "reasoning", encrypted_content: "…" }],
			}),
		).toBe(true);
		expect(payloadReplaysReasoning("openai-responses", { input: [{ type: "message" }] })).toBe(false);
	});

	it("detects thinking blocks on anthropic messages", () => {
		expect(
			payloadReplaysReasoning("anthropic-messages", {
				messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text" }] }],
			}),
		).toBe(true);
		expect(
			payloadReplaysReasoning("anthropic-messages", {
				messages: [{ role: "assistant", content: [{ type: "text" }] }],
			}),
		).toBe(false);
	});

	it("is false for junk payloads", () => {
		expect(payloadReplaysReasoning("openai-completions", null)).toBe(false);
		expect(payloadReplaysReasoning("google-generative-ai" as Api, { messages: [] })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// runTrial against a fully mocked stream
// ---------------------------------------------------------------------------

const model = {
	id: "test/model",
	name: "Test Model",
	api: "openai-completions",
	provider: "openrouter-completions",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8192,
} as Model<Api>;

function assistantMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0.0001, output: 0.00004, cacheRead: 0, cacheWrite: 0, total: 0.00014 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

/** A scripted stream: one tool-call turn, then a final text turn. */
function scriptedStream(script: AssistantMessage[], onCall?: (context: Context) => void): StreamFn {
	let call = 0;
	return (_model, context, options) => {
		onCall?.(context);
		(options.onPayload as (payload: unknown) => unknown)?.({
			messages: context.messages.map((m) =>
				m.role === "assistant"
					? { role: "assistant", reasoning_details: [{ type: "reasoning.encrypted" }] }
					: { role: m.role },
			),
		});
		const message = script[Math.min(call, script.length - 1)]!;
		call++;
		const iterable = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start" };
				yield { type: "text_delta" };
				yield { type: "done" };
			},
			result: () => Promise.resolve(message),
		};
		return iterable as ReturnType<StreamFn>;
	};
}

describe("runTrial", () => {
	it("loops tool calls to completion and accumulates metrics", async () => {
		const script = [
			assistantMessage({
				content: [{ type: "toolCall", id: "c1", name: "read_file", arguments: { path: "math.py" } }],
				stopReason: "toolUse",
			}),
			assistantMessage({
				content: [{ type: "toolCall", id: "c2", name: "run_tests", arguments: {} }],
				stopReason: "toolUse",
			}),
			assistantMessage({ content: [{ type: "text", text: "DONE — add subtracts." }] }),
		];
		const contexts: Context[] = [];
		const result = await runTrial({
			surface: "completions",
			model,
			stream: scriptedStream(script, (context) => contexts.push(structuredClone(context))),
			trial: 1,
			apiKey: "test-key",
			now: (() => {
				let t = 0;
				return () => (t += 100);
			})(),
		});

		expect(result.completed).toBe(true);
		expect(result.turns).toHaveLength(3);
		expect(result.turns.map((t) => t.toolCalls)).toEqual([["read_file"], ["run_tests"], []]);
		expect(result.totalCost).toBeCloseTo(0.00042);
		expect(result.totalTokens.input).toBe(300);
		expect(result.finalText).toContain("DONE");
		// Second request onwards contains an assistant message, which the scripted
		// stream annotates with reasoning_details — so preservation is detected.
		expect(result.reasoningPreserved).toBe(true);
		expect(result.turns[0]!.replayedReasoning).toBe(false);
		expect(result.turns[1]!.replayedReasoning).toBe(true);
		// The tool result fed back is the deterministic harness output.
		const secondContext = contexts[1]!;
		const toolResult = secondContext.messages.find((m) => m.role === "toolResult");
		expect(toolResult && "content" in toolResult && toolResult.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("a - b"),
		});
	});

	it("stops on provider errors and records them", async () => {
		const result = await runTrial({
			surface: "completions",
			model,
			stream: scriptedStream([
				assistantMessage({ stopReason: "error", errorMessage: "model not available on this surface" }),
			]),
			trial: 1,
			apiKey: "test-key",
		});
		expect(result.completed).toBe(false);
		expect(result.error).toContain("not available");
		expect(result.turns).toHaveLength(1);
	});

	it("gives up after maxTurns", async () => {
		const looping = assistantMessage({
			content: [{ type: "toolCall", id: "loop", name: "run_tests", arguments: {} }],
			stopReason: "toolUse",
		});
		const result = await runTrial({
			surface: "completions",
			model,
			stream: scriptedStream([looping]),
			trial: 1,
			apiKey: "test-key",
			maxTurns: 3,
		});
		expect(result.completed).toBe(false);
		expect(result.turns).toHaveLength(3);
	});
});

describe("aggregation", () => {
	const trial = (overrides: Partial<TrialResult>): TrialResult => ({
		surface: "completions",
		api: "openai-completions",
		model: "test/model",
		trial: 1,
		turns: [],
		totalCost: 0,
		totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
		totalWallMs: 0,
		completed: true,
		reasoningPreserved: false,
		...overrides,
	});

	it("mean handles empty input", () => {
		expect(mean([])).toBe(0);
		expect(mean([1, 2, 3])).toBe(2);
	});

	it("summarize averages across trials and counts flags", () => {
		const summary = summarize("completions", [
			trial({
				totalCost: 0.01,
				totalWallMs: 1000,
				reasoningPreserved: true,
				totalTokens: { input: 100, output: 10, cacheRead: 50, cacheWrite: 5, reasoning: 20 },
				turns: [
					{
						turn: 1,
						wallMs: 1000,
						ttftMs: 200,
						usage: {} as TrialResult["turns"][0]["usage"],
						toolCalls: [],
						hadThinking: true,
						replayedReasoning: false,
						stopReason: "stop",
					},
				],
			}),
			trial({
				totalCost: 0.03,
				totalWallMs: 3000,
				completed: false,
				error: "boom",
				totalTokens: { input: 300, output: 30, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
			}),
		]);
		expect(summary.meanCost).toBeCloseTo(0.02);
		expect(summary.meanWallMs).toBe(2000);
		expect(summary.meanInputTokens).toBe(200);
		expect(summary.meanCacheReadTokens).toBe(25);
		expect(summary.meanTtftMs).toBe(200);
		expect(summary.completedTrials).toBe(1);
		expect(summary.erroredTrials).toBe(1);
		expect(summary.reasoningPreservedTrials).toBe(1);
	});

	it("renderReport produces one row per surface", () => {
		const report = renderReport("test/model", [
			summarize("completions", [trial({ totalCost: 0.01 })]),
			summarize("responses", []),
		]);
		expect(report).toContain("`completions`");
		expect(report).toContain("`responses`");
		expect(report.match(/^\|/gm)!.length).toBe(4); // header + divider + 2 rows
	});
});
