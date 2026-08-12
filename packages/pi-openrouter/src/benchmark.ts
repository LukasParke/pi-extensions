/**
 * Benchmark core: a deterministic multi-turn agentic scenario run through any
 * of the three OpenRouter surfaces, plus the aggregation math for the report.
 *
 * The scenario is a synthetic bug hunt: the model must read three files and
 * run the tests until they pass. Tool results are canned, so every trial sees
 * identical tool output and the only variables are the API surface and the
 * model's own behavior.
 */

import type { Api, AssistantMessage, Context, Message, Model, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = [
	"You are a coding agent fixing a bug in a tiny repository.",
	"Work strictly with tools: read files with read_file, run the suite with run_tests.",
	"Read math.py, test_math.py, and util.py (one read_file call at a time), then call run_tests.",
	"If tests fail, state the one-line cause, call run_tests once more, and after it passes reply DONE plus the cause.",
	"Keep every text reply under 25 words.",
].join(" ");

export const USER_PROMPT = "Find out why the test suite fails. Follow your instructions exactly.";

const FILES: Record<string, string> = {
	"math.py": "def add(a, b):\n    return a - b  # BUG: should be a + b\n",
	"test_math.py": "from math import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
	"util.py": "# helper stubs, not involved in the failure\nVERSION = '1.0.0'\n",
};

const TEST_RUNS = ["FAILED test_math.py::test_add - assert -1 == 5 (1 failed in 0.02s)", "1 passed in 0.01s"];

export const TOOLS = [
	{
		name: "read_file",
		description: "Read a file from the repository. Returns the full contents.",
		parameters: Type.Object({ path: Type.String({ description: "Repository-relative path" }) }),
	},
	{
		name: "run_tests",
		description: "Run the test suite and return the summary line.",
		parameters: Type.Object({}),
	},
];

/** Deterministic tool answers; `testRuns` advances so the second run passes. */
export function createToolHarness() {
	let testRuns = 0;
	return {
		answer(name: string, args: Record<string, unknown>) {
			if (name === "read_file") {
				const path = String(args.path ?? "");
				return FILES[path] ?? `ERROR: no such file: ${path}`;
			}
			if (name === "run_tests") {
				const result = TEST_RUNS[Math.min(testRuns, TEST_RUNS.length - 1)]!;
				testRuns += 1;
				return result;
			}
			return `ERROR: unknown tool ${name}`;
		},
	};
}

// ---------------------------------------------------------------------------
// Reasoning-preservation assertions (on the wire, via onPayload)
// ---------------------------------------------------------------------------

/**
 * Inspect an outgoing request payload for replayed reasoning from earlier
 * assistant turns. What "replayed reasoning" looks like differs per surface:
 * - completions: assistant messages carrying `reasoning_details`
 * - responses: input items of `type: "reasoning"` (with encrypted_content)
 * - messages: assistant content blocks of `type: "thinking"`
 */
export function payloadReplaysReasoning(api: Api, payload: unknown): boolean {
	if (typeof payload !== "object" || payload === null) return false;
	const p = payload as Record<string, unknown>;
	if (api === "openai-completions") {
		const messages = Array.isArray(p.messages) ? p.messages : [];
		return messages.some(
			(m) => m?.role === "assistant" && Array.isArray(m.reasoning_details) && m.reasoning_details.length > 0,
		);
	}
	if (api === "openai-responses") {
		const input = Array.isArray(p.input) ? p.input : [];
		return input.some((item) => item?.type === "reasoning");
	}
	if (api === "anthropic-messages") {
		const messages = Array.isArray(p.messages) ? p.messages : [];
		return messages.some(
			(m) =>
				m?.role === "assistant" &&
				Array.isArray(m.content) &&
				m.content.some((block: { type?: string }) => block?.type === "thinking"),
		);
	}
	return false;
}

// ---------------------------------------------------------------------------
// Trial runner
// ---------------------------------------------------------------------------

export interface TurnMetrics {
	turn: number;
	wallMs: number;
	ttftMs?: number;
	usage: Usage;
	toolCalls: string[];
	hadThinking: boolean;
	replayedReasoning: boolean;
	stopReason: string;
	error?: string;
}

export interface TrialResult {
	surface: string;
	api: Api;
	model: string;
	trial: number;
	turns: TurnMetrics[];
	totalCost: number;
	totalTokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
	totalWallMs: number;
	completed: boolean;
	reasoningPreserved: boolean;
	finalText?: string;
	error?: string;
}

export interface StreamFn {
	(
		model: Model<Api>,
		context: Context,
		options: Record<string, unknown>,
	): AsyncIterable<{
		type: string;
	}> & { result(): Promise<AssistantMessage> };
}

export interface RunTrialOptions {
	surface: string;
	model: Model<Api>;
	stream: StreamFn;
	trial: number;
	apiKey: string;
	headers?: Record<string, string>;
	maxTokens?: number;
	maxTurns?: number;
	reasoning?: "minimal" | "low" | "medium" | "high";
	now?: () => number;
}

export async function runTrial(options: RunTrialOptions): Promise<TrialResult> {
	const now = options.now ?? (() => performance.now());
	const harness = createToolHarness();
	const messages: Message[] = [{ role: "user", content: USER_PROMPT, timestamp: Date.now() }];
	const context: Context = { systemPrompt: SYSTEM_PROMPT, messages, tools: TOOLS };
	const maxTurns = options.maxTurns ?? 10;

	const result: TrialResult = {
		surface: options.surface,
		api: options.model.api,
		model: options.model.id,
		trial: options.trial,
		turns: [],
		totalCost: 0,
		totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
		totalWallMs: 0,
		completed: false,
		reasoningPreserved: false,
	};

	for (let turn = 1; turn <= maxTurns; turn++) {
		let replayedReasoning = false;
		let ttftMs: number | undefined;
		const start = now();
		const stream = options.stream(options.model, context, {
			apiKey: options.apiKey,
			headers: options.headers,
			maxTokens: options.maxTokens ?? 2048,
			reasoning: options.reasoning ?? "low",
			maxRetries: 1,
			onPayload: (payload: unknown) => {
				replayedReasoning = payloadReplaysReasoning(options.model.api, payload);
				return undefined;
			},
		});

		let assistant: AssistantMessage;
		try {
			for await (const event of stream) {
				if (
					ttftMs === undefined &&
					(event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_start")
				) {
					ttftMs = now() - start;
				}
			}
			assistant = await stream.result();
		} catch (error) {
			result.error = error instanceof Error ? error.message : String(error);
			break;
		}
		const wallMs = now() - start;

		const toolCalls = assistant.content.filter((block) => block.type === "toolCall");
		const turnMetrics: TurnMetrics = {
			turn,
			wallMs,
			ttftMs,
			usage: assistant.usage,
			toolCalls: toolCalls.map((call) => call.name),
			hadThinking: assistant.content.some((block) => block.type === "thinking"),
			replayedReasoning,
			stopReason: assistant.stopReason,
			...(assistant.errorMessage ? { error: assistant.errorMessage } : {}),
		};
		result.turns.push(turnMetrics);
		result.totalWallMs += wallMs;
		result.totalCost += assistant.usage.cost.total;
		result.totalTokens.input += assistant.usage.input;
		result.totalTokens.output += assistant.usage.output;
		result.totalTokens.cacheRead += assistant.usage.cacheRead;
		result.totalTokens.cacheWrite += assistant.usage.cacheWrite;
		result.totalTokens.reasoning += assistant.usage.reasoning ?? 0;
		if (replayedReasoning) result.reasoningPreserved = true;

		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			result.error = assistant.errorMessage ?? assistant.stopReason;
			break;
		}

		messages.push(assistant);

		if (toolCalls.length === 0) {
			result.finalText = assistant.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			result.completed = true;
			break;
		}

		for (const call of toolCalls) {
			messages.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: harness.answer(call.name, call.arguments) }],
				isError: false,
				timestamp: Date.now(),
			});
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface SurfaceSummary {
	surface: string;
	trials: number;
	completedTrials: number;
	erroredTrials: number;
	meanTurns: number;
	meanCost: number;
	meanInputTokens: number;
	meanOutputTokens: number;
	meanCacheReadTokens: number;
	meanCacheWriteTokens: number;
	meanReasoningTokens: number;
	meanWallMs: number;
	meanTtftMs: number;
	reasoningPreservedTrials: number;
}

export function mean(values: number[]) {
	return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

export function summarize(surface: string, trials: TrialResult[]): SurfaceSummary {
	const ttfts = trials.flatMap((t) =>
		t.turns.map((turn) => turn.ttftMs).filter((v): v is number => v !== undefined),
	);
	return {
		surface,
		trials: trials.length,
		completedTrials: trials.filter((t) => t.completed).length,
		erroredTrials: trials.filter((t) => t.error).length,
		meanTurns: mean(trials.map((t) => t.turns.length)),
		meanCost: mean(trials.map((t) => t.totalCost)),
		meanInputTokens: mean(trials.map((t) => t.totalTokens.input)),
		meanOutputTokens: mean(trials.map((t) => t.totalTokens.output)),
		meanCacheReadTokens: mean(trials.map((t) => t.totalTokens.cacheRead)),
		meanCacheWriteTokens: mean(trials.map((t) => t.totalTokens.cacheWrite)),
		meanReasoningTokens: mean(trials.map((t) => t.totalTokens.reasoning)),
		meanWallMs: mean(trials.map((t) => t.totalWallMs)),
		meanTtftMs: mean(ttfts),
		reasoningPreservedTrials: trials.filter((t) => t.reasoningPreserved).length,
	};
}

export function renderReport(model: string, summaries: SurfaceSummary[], generatedAt = new Date()) {
	const fmt = (value: number, digits = 0) => value.toFixed(digits);
	const rows = summaries.map((s) =>
		[
			`\`${s.surface}\``,
			`${s.completedTrials}/${s.trials}`,
			fmt(s.meanTurns, 1),
			`$${s.meanCost.toFixed(5)}`,
			fmt(s.meanInputTokens),
			fmt(s.meanOutputTokens),
			fmt(s.meanCacheReadTokens),
			fmt(s.meanCacheWriteTokens),
			fmt(s.meanReasoningTokens),
			`${fmt(s.meanWallMs / 1000, 1)}s`,
			`${fmt(s.meanTtftMs)}ms`,
			`${s.reasoningPreservedTrials}/${s.trials}`,
		].join(" | "),
	);
	return [
		`# OpenRouter API surface benchmark — \`${model}\``,
		"",
		`Generated ${generatedAt.toISOString()} by \`scripts/benchmark.ts\`. Means over completed trials of the deterministic tool-loop scenario.`,
		"",
		"| Surface | Completed | Turns | Cost | Input tok | Output tok | Cache read | Cache write | Reasoning tok | Wall | TTFT | Reasoning replayed |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		...rows.map((row) => `| ${row} |`),
		"",
	].join("\n");
}
