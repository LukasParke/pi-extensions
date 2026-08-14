import { describe, expect, it } from "vitest";
import { EXCEPTIONS, overridesForModel, staleExceptions, surfaceForModel } from "../src/rules.ts";

describe("surfaceForModel", () => {
	it("routes anthropic models to messages", () => {
		expect(surfaceForModel("anthropic/claude-opus-5")).toBe("messages");
	});

	it("routes openai models to responses", () => {
		expect(surfaceForModel("openai/gpt-5.2")).toBe("responses");
	});

	it("routes everything else to completions", () => {
		expect(surfaceForModel("deepseek/deepseek-v4-pro")).toBe("completions");
		expect(surfaceForModel("z-ai/glm-5.2")).toBe("completions");
	});

	it("lets benchmark-proven exceptions beat family rules", () => {
		expect(surfaceForModel("moonshotai/kimi-k3")).toBe("responses");
	});
});

describe("overridesForModel", () => {
	it("adds openrouter thinkingFormat for reasoning models on completions", () => {
		expect(overridesForModel("deepseek/deepseek-v4-pro", "completions", true).compat).toMatchObject({
			thinkingFormat: "openrouter",
		});
	});

	it("omits thinkingFormat for non-reasoning models", () => {
		expect(overridesForModel("deepseek/deepseek-v4-flash-0731", "completions", false).compat).toBeUndefined();
	});

	it("adds anthropic cache_control for anthropic models on completions", () => {
		expect(overridesForModel("anthropic/claude-opus-5", "completions", true).compat).toMatchObject({
			cacheControlFormat: "anthropic",
		});
	});

	it("applies per-model exception overrides on the matching surface only", () => {
		expect(overridesForModel("moonshotai/kimi-k2-thinking", "messages", true).compat).toMatchObject({
			allowEmptySignature: true,
		});
		expect(overridesForModel("moonshotai/kimi-k2-thinking", "responses", true).compat).toBeUndefined();
	});

	it("merges thinkingLevelMap from exceptions", () => {
		expect(overridesForModel("openai/gpt-5.2", "responses", true).thinkingLevelMap).toMatchObject({
			off: "none",
			minimal: null,
		});
	});
});

describe("staleExceptions", () => {
	it("flags exceptions past their revalidateAfter date", () => {
		const farFuture = new Date("2999-01-01");
		expect(staleExceptions(farFuture)).toHaveLength(EXCEPTIONS.length);
		expect(staleExceptions(new Date("2026-08-13"))).toHaveLength(0);
	});
});
