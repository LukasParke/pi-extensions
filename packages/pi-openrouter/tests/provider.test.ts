import { describe, expect, it } from "vitest";
import { FALLBACK_MODELS } from "../src/catalog.ts";
import { defaultConfig } from "../src/config.ts";
import { buildAllProviders, buildProviderConfig } from "../src/provider.ts";

describe("buildProviderConfig", () => {
	it("assembles the completions control identically to pi's built-in openrouter setup", () => {
		const provider = buildProviderConfig("completions", defaultConfig, FALLBACK_MODELS);
		expect(provider.id).toBe("openrouter-completions");
		expect(provider.baseUrl).toBe("https://openrouter.ai/api/v1");
		expect(provider.api).toBe("openai-completions");
		expect(provider.apiKey).toBe("$OPENROUTER_API_KEY");
		expect(provider.models.map((m) => m.id)).toEqual(defaultConfig.models);
	});

	it("targets /api for the messages surface", () => {
		const provider = buildProviderConfig("messages", defaultConfig, FALLBACK_MODELS);
		expect(provider.baseUrl).toBe("https://openrouter.ai/api");
		expect(provider.api).toBe("anthropic-messages");
	});

	it("keeps /api/v1 for the responses surface", () => {
		const provider = buildProviderConfig("responses", defaultConfig, FALLBACK_MODELS);
		expect(provider.baseUrl).toBe("https://openrouter.ai/api/v1");
		expect(provider.api).toBe("openai-responses");
	});

	it("carries app attribution headers", () => {
		const provider = buildProviderConfig("responses", defaultConfig, FALLBACK_MODELS);
		expect(provider.headers).toMatchObject({
			"HTTP-Referer": defaultConfig.referer,
			"X-OpenRouter-Title": "pi-openrouter",
			"X-Title": "pi-openrouter",
		});
	});

	it("never embeds a literal key", () => {
		for (const provider of buildAllProviders(defaultConfig, FALLBACK_MODELS)) {
			expect(provider.apiKey).toBe("$OPENROUTER_API_KEY");
			expect(JSON.stringify(provider)).not.toMatch(/sk-or-/);
		}
	});
});

describe("buildAllProviders", () => {
	it("registers all three surfaces with the same models", () => {
		const providers = buildAllProviders(defaultConfig, FALLBACK_MODELS);
		expect(providers.map((p) => p.id)).toEqual([
			"openrouter-completions",
			"openrouter-responses",
			"openrouter-messages",
		]);
		const [a, b, c] = providers.map((p) => p.models.map((m) => m.id).join(","));
		expect(a).toBe(b);
		expect(b).toBe(c);
	});
});
