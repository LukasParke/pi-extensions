import { describe, expect, it } from "vitest";
import {
	buildModel,
	buildSurfaceModels,
	FALLBACK_MODELS,
	fetchApiModels,
	perMillion,
	providerId,
	surfaceBaseUrl,
	toCost,
	type ApiModel,
} from "../src/catalog.ts";
import { defaultConfig } from "../src/config.ts";

describe("surfaceBaseUrl", () => {
	// pi-ai SDK-relative paths: completions posts {base}/chat/completions,
	// responses posts {base}/responses, anthropic-messages posts {base}/v1/messages.
	it("keeps /api/v1 for completions and responses", () => {
		expect(surfaceBaseUrl("completions", "https://openrouter.ai/api/v1")).toBe(
			"https://openrouter.ai/api/v1",
		);
		expect(surfaceBaseUrl("responses", "https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1");
	});

	it("strips /v1 for messages so the Anthropic SDK's /v1/messages lands on /api/v1/messages", () => {
		expect(surfaceBaseUrl("messages", "https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api");
	});

	it("tolerates trailing slashes", () => {
		expect(surfaceBaseUrl("messages", "https://openrouter.ai/api/v1/")).toBe("https://openrouter.ai/api");
		expect(surfaceBaseUrl("completions", "https://openrouter.ai/api/v1///")).toBe(
			"https://openrouter.ai/api/v1",
		);
	});
});

describe("pricing conversion", () => {
	it("converts $/token strings to $/million", () => {
		expect(perMillion("0.00000175")).toBeCloseTo(1.75);
		expect(perMillion("0.000015")).toBeCloseTo(15);
	});

	it("treats missing or malformed prices as 0", () => {
		expect(perMillion(undefined)).toBe(0);
		expect(perMillion("free")).toBe(0);
	});

	it("maps the OpenRouter pricing object onto pi cost fields", () => {
		expect(
			toCost({
				prompt: "0.000003",
				completion: "0.000015",
				input_cache_read: "0.0000003",
				input_cache_write: "0.00000375",
			}),
		).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
	});
});

describe("buildModel", () => {
	const sonnet = FALLBACK_MODELS.find((m) => m.id === "anthropic/claude-sonnet-4.6")!;
	const gpt = FALLBACK_MODELS.find((m) => m.id === "openai/gpt-5.2")!;
	const kimi = FALLBACK_MODELS.find((m) => m.id === "moonshotai/kimi-k2-thinking")!;

	it("derives reasoning and modality from the API entry", () => {
		const model = buildModel("completions", gpt);
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(400_000);
		expect(model.maxTokens).toBe(128_000);
		expect(model.cost.input).toBeCloseTo(1.75);
	});

	it("applies openrouter thinkingFormat + anthropic cache_control on completions for Claude", () => {
		const model = buildModel("completions", sonnet);
		expect(model.compat).toMatchObject({
			thinkingFormat: "openrouter",
			cacheControlFormat: "anthropic",
		});
		expect(model.thinkingLevelMap).toEqual({ max: "max" });
	});

	it("forces adaptive thinking for Claude 4.6 on the messages surface", () => {
		const model = buildModel("messages", sonnet);
		expect(model.compat).toMatchObject({ forceAdaptiveThinking: true });
	});

	it("allows empty thinking signatures for Kimi on the messages surface", () => {
		const model = buildModel("messages", kimi);
		expect(model.compat).toMatchObject({ allowEmptySignature: true });
	});

	it("maps GPT-5.2 thinking levels on the responses surface", () => {
		const model = buildModel("responses", gpt);
		expect(model.thinkingLevelMap).toMatchObject({ off: "none", xhigh: "xhigh", minimal: null });
	});

	it("defaults text-only models without extra compat", () => {
		const model = buildModel("responses", kimi);
		expect(model.input).toEqual(["text"]);
		expect(model.compat).toBeUndefined();
	});
});

describe("buildSurfaceModels", () => {
	it("keeps curated order and drops ids missing from the API", () => {
		const models = buildSurfaceModels("completions", FALLBACK_MODELS, [
			"moonshotai/kimi-k2-thinking",
			"not/areal-model",
			"openai/gpt-5.2",
		]);
		expect(models.map((m) => m.id)).toEqual(["moonshotai/kimi-k2-thinking", "openai/gpt-5.2"]);
	});
});

describe("providerId", () => {
	it("names surfaces predictably", () => {
		expect(providerId("completions")).toBe("openrouter-completions");
		expect(providerId("responses")).toBe("openrouter-responses");
		expect(providerId("messages")).toBe("openrouter-messages");
	});
});

describe("fetchApiModels", () => {
	const payload = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }));

	it("fetches {base}/models", async () => {
		let url = "";
		const models = await fetchApiModels(defaultConfig, ((input: string) => {
			url = String(input);
			return payload(FALLBACK_MODELS);
		}) as typeof fetch);
		expect(url).toBe("https://openrouter.ai/api/v1/models");
		expect(models).toHaveLength(FALLBACK_MODELS.length);
	});

	it("rejects on HTTP errors", async () => {
		await expect(
			fetchApiModels(defaultConfig, (() =>
				Promise.resolve(new Response("nope", { status: 500 }))) as typeof fetch),
		).rejects.toThrow(/500/);
	});

	it("rejects when the payload has no data array", async () => {
		await expect(
			fetchApiModels(defaultConfig, (() => payload(undefined)) as unknown as typeof fetch),
		).rejects.toThrow(/no data array/);
	});
});

describe("fallback snapshot", () => {
	it("covers every default curated model", () => {
		const ids = new Set(FALLBACK_MODELS.map((m: ApiModel) => m.id));
		for (const id of defaultConfig.models) expect(ids.has(id)).toBe(true);
	});
});
