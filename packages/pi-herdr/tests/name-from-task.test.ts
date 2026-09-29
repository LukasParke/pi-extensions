import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { generateNameFromContext, generateNameIfOmitted, type NameContext } from "../src/name-from-task.ts";

const model: Model<"openai-completions"> = {
	id: "fixture",
	name: "Fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://fixture.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const response = (stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
	role: "assistant",
	provider: model.provider,
	api: model.api,
	model: model.id,
	timestamp: 1,
	stopReason,
	content: [{ type: "text", text: "clickable-file-paths" }],
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});
type StreamSimple = NonNullable<NameContext["modelRegistry"]>["streamSimple"];
const context = (streamSimple: StreamSimple, signal?: AbortSignal): NameContext => ({
	model,
	modelRegistry: { streamSimple },
	signal,
});

function successfulStream(): StreamSimple {
	return () => {
		const stream = createAssistantMessageEventStream();
		stream.end(response());
		return stream;
	};
}

describe("generateNameFromContext", () => {
	it("falls back without a model, runtime, or successful provider call", async () => {
		await expect(generateNameFromContext("task", {})).resolves.toBeUndefined();
		await expect(generateNameFromContext("task", { model })).resolves.toBeUndefined();
		await expect(
			generateNameFromContext(
				"task",
				context(() => {
					throw new Error("auth unavailable");
				}),
			),
		).resolves.toBeUndefined();
	});

	it("uses the configured native provider runtime without manually forwarding credentials", async () => {
		const streamSimple = vi.fn<StreamSimple>((requestedModel, request, options) => {
			expect(requestedModel).toBe(model);
			expect(request.systemPrompt).toContain("SUBJECT");
			expect(request.messages).toEqual([
				{
					role: "user",
					content: [{ type: "text", text: "Add clickable transcript file paths" }],
					timestamp: 42,
				},
			]);
			expect(options).toMatchObject({ maxTokens: 24, reasoning: "minimal" });
			expect(options).not.toHaveProperty("apiKey");
			expect(options).not.toHaveProperty("headers");
			return successfulStream()(requestedModel, request, options);
		});
		await expect(
			generateNameFromContext("Add clickable transcript file paths", context(streamSimple), {
				now: () => 42,
			}),
		).resolves.toBe("clickable-file-paths");
		expect(streamSimple).toHaveBeenCalledOnce();
	});

	it("skips generation for explicit names", () => {
		const ctx = context(successfulStream());
		expect(generateNameIfOmitted("fix-thing", ctx)).toBeUndefined();
		expect(generateNameIfOmitted(undefined, ctx)).toEqual(expect.any(Function));
	});

	it.each(["error", "aborted"] as const)("falls back on provider %s", async (stopReason) => {
		await expect(
			generateNameFromContext(
				"task",
				context(() => {
					const stream = createAssistantMessageEventStream();
					stream.end(response(stopReason));
					return stream;
				}),
			),
		).resolves.toBeUndefined();
	});

	it("bounds generation and cancels through the native signal", async () => {
		const streamSimple: StreamSimple = (_model, _request, options) => {
			const stream = createAssistantMessageEventStream();
			options!.signal!.addEventListener("abort", () => stream.end(response("aborted")), { once: true });
			return stream;
		};
		await expect(
			generateNameFromContext("task", context(streamSimple), { timeoutMs: 1 }),
		).resolves.toBeUndefined();
		const controller = new AbortController();
		const pending = generateNameFromContext("task", context(streamSimple), { signal: controller.signal });
		controller.abort();
		await expect(pending).resolves.toBeUndefined();
	});

	it("reports paid model usage even when name generation fails", async () => {
		const onUsage = vi.fn();
		const message = response("error");
		message.usage = {
			...message.usage,
			input: 1,
			output: 2,
			totalTokens: 3,
			cost: { ...message.usage.cost, total: 0.25 },
		};
		await expect(
			generateNameFromContext(
				"task",
				context(() => {
					const stream = createAssistantMessageEventStream();
					stream.end(message);
					return stream;
				}),
				{ onUsage },
			),
		).resolves.toBeUndefined();
		expect(onUsage).toHaveBeenCalledWith(message.usage);
	});

	it("does not call the provider when the turn is already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		const streamSimple = vi.fn<StreamSimple>(successfulStream());
		await expect(
			generateNameFromContext("task", context(streamSimple, controller.signal)),
		).resolves.toBeUndefined();
		expect(streamSimple).not.toHaveBeenCalled();
	});
});
