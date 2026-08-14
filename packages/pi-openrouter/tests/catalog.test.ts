import { describe, expect, it } from "vitest";
import { fetchApiModels, perMillion, providerId, surfaceBaseUrl, toCost } from "../src/catalog.ts";
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
			return payload([{ id: "openai/gpt-5.2" }]);
		}) as typeof fetch);
		expect(url).toBe("https://openrouter.ai/api/v1/models");
		expect(models).toHaveLength(1);
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
