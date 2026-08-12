import { describe, expect, it } from "vitest";
import { modelRoutingTable, resolveModelRoute, type RoutingRule } from "../src/routing.ts";

describe("resolveModelRoute", () => {
	const rules = modelRoutingTable("https://openrouter.ai/api/v1");

	it.each([
		["anthropic/claude-opus-5", "anthropic-messages", "https://openrouter.ai/api"],
		["openai/gpt-5.6-sol", "openai-responses", "https://openrouter.ai/api/v1"],
		["moonshotai/kimi-k3", "openai-responses", "https://openrouter.ai/api/v1"],
		["moonshotai/kimi-k2-thinking", "openai-completions", "https://openrouter.ai/api/v1"],
		["qwen/qwen3-coder", "openai-completions", "https://openrouter.ai/api/v1"],
	])("routes %s", (model, api, baseUrl) => {
		expect(resolveModelRoute(model, rules)).toEqual({ api, baseUrl });
	});

	it("gives exact model exceptions precedence over family rules", () => {
		const withException: readonly RoutingRule[] = [
			["openai/gpt-platform-bug", "openai-completions", "https://openrouter.ai/api/v1"],
			...rules,
		];
		expect(resolveModelRoute("openai/gpt-platform-bug", withException).api).toBe("openai-completions");
	});

	it("uses the first matching prefix glob", () => {
		const overlapping: readonly RoutingRule[] = [
			["openai/gpt-*", "openai-completions", "https://openrouter.ai/api/v1"],
			...rules,
		];
		expect(resolveModelRoute("openai/gpt-5.6-sol", overlapping).api).toBe("openai-completions");
	});
});
