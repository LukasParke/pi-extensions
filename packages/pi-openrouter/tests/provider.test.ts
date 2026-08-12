import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerOpenRouterProviders } from "../extensions/openrouter.ts";
import { FALLBACK_MODELS } from "../src/catalog.ts";
import { defaultConfig } from "../src/config.ts";
import { buildAllProviders, buildProviderConfig, buildRoutedProvider } from "../src/provider.ts";

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

describe("routed provider", () => {
	it("assigns each model its family-optimal surface", () => {
		const provider = buildRoutedProvider(defaultConfig, FALLBACK_MODELS);
		expect(provider.id).toBe("openrouter");
		expect(provider.models).toEqual([
			expect.objectContaining({
				id: "openai/gpt-5.2",
				api: "openai-responses",
				baseUrl: "https://openrouter.ai/api/v1",
			}),
			expect.objectContaining({
				id: "anthropic/claude-sonnet-4.6",
				api: "anthropic-messages",
				baseUrl: "https://openrouter.ai/api",
			}),
			expect.objectContaining({
				id: "moonshotai/kimi-k2-thinking",
				api: "openai-completions",
				baseUrl: "https://openrouter.ai/api/v1",
			}),
		]);
	});

	it("registers the built-in override after the three explicit surfaces", () => {
		const registerProvider = vi.fn();
		registerOpenRouterProviders(
			{ registerProvider } as unknown as Pick<ExtensionAPI, "registerProvider">,
			defaultConfig,
			FALLBACK_MODELS,
		);
		expect(registerProvider.mock.calls.map(([id]) => id)).toEqual([
			"openrouter-completions",
			"openrouter-responses",
			"openrouter-messages",
			"openrouter",
		]);
		const routed = registerProvider.mock.calls[3]![1];
		expect(routed.models).toHaveLength(defaultConfig.models.length);
		expect(
			routed.models.every((model: { api?: string; baseUrl?: string }) => model.api && model.baseUrl),
		).toBe(true);
	});
});
