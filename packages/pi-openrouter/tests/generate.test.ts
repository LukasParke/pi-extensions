import { describe, expect, it } from "vitest";
import type { ApiModel } from "../src/catalog.ts";
import { buildModelEntry, generateModels } from "../src/generate.ts";

const BASE = "https://openrouter.ai/api/v1";

const sonnet: ApiModel = {
	id: "anthropic/claude-sonnet-4.6",
	name: "Anthropic: Claude Sonnet 4.6",
	context_length: 1_000_000,
	architecture: { modality: "text+image+file->text" },
	pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" },
	top_provider: { max_completion_tokens: 128_000 },
	supported_parameters: ["reasoning"],
};

const gpt: ApiModel = {
	id: "openai/gpt-5.2",
	name: "OpenAI: GPT-5.2",
	context_length: 400_000,
	architecture: { modality: "text+image+file->text" },
	pricing: { prompt: "0.00000175", completion: "0.000014", input_cache_read: "0.000000175" },
	top_provider: { max_completion_tokens: 128_000 },
	supported_parameters: ["reasoning"],
};

const kimi: ApiModel = {
	id: "moonshotai/kimi-k2-thinking",
	name: "MoonshotAI: Kimi K2 Thinking",
	context_length: 262_144,
	architecture: { modality: "text->text" },
	pricing: { prompt: "0.0000006", completion: "0.0000025", input_cache_read: "0.00000015" },
	top_provider: { max_completion_tokens: 100_352 },
	supported_parameters: ["reasoning"],
};

describe("buildModelEntry", () => {
	it("derives reasoning, modality, and metadata from the API entry", () => {
		const model = buildModelEntry(gpt, BASE);
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(400_000);
		expect(model.maxTokens).toBe(128_000);
		expect(model.cost.input).toBeCloseTo(1.75);
	});

	it("routes anthropic models to messages with a /v1-less baseUrl", () => {
		const model = buildModelEntry(sonnet, BASE);
		expect(model.api).toBe("anthropic-messages");
		expect(model.baseUrl).toBe("https://openrouter.ai/api");
	});

	it("routes openai models to responses without a per-model baseUrl", () => {
		const model = buildModelEntry(gpt, BASE);
		expect(model.api).toBe("openai-responses");
		expect(model.baseUrl).toBeUndefined();
	});

	it("routes long-tail models to completions with openrouter thinking", () => {
		const model = buildModelEntry(kimi, BASE);
		expect(model.api).toBe("openai-completions");
		expect(model.compat).toMatchObject({ thinkingFormat: "openrouter" });
	});

	it("applies exception overrides", () => {
		expect(buildModelEntry(gpt, BASE).thinkingLevelMap).toMatchObject({ off: "none", minimal: null });
		expect(buildModelEntry(sonnet, BASE).compat).toMatchObject({ forceAdaptiveThinking: true });
	});

	it("honors an explicit surface for benchmarking", () => {
		const model = buildModelEntry(kimi, BASE, "messages");
		expect(model.api).toBe("anthropic-messages");
		expect(model.compat).toMatchObject({ allowEmptySignature: true });
	});

	it("falls back to defaults when the API omits metadata", () => {
		const model = buildModelEntry({ id: "acme/thing" }, BASE);
		expect(model.contextWindow).toBe(128_000);
		expect(model.maxTokens).toBe(32_768);
		expect(model.reasoning).toBe(false);
		expect(model.input).toEqual(["text"]);
	});
});

describe("generateModels", () => {
	it("sorts by id and is deterministic", () => {
		const input = [kimi, sonnet, gpt];
		const first = generateModels(input, BASE);
		const second = generateModels([...input].reverse(), BASE);
		expect(first.map((m) => m.id)).toEqual([sonnet.id, kimi.id, gpt.id].sort());
		expect(first).toEqual(second);
	});
});
