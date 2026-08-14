import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GeneratedModel } from "../src/generate.ts";
import { mergeModelsJson, PROVIDER_DEFAULTS, syncModelsJson } from "../src/sync.ts";

const entry = (id: string): GeneratedModel => ({
	id,
	name: id,
	api: "openai-completions",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 32_768,
});

describe("mergeModelsJson", () => {
	it("creates the openrouter provider with defaults when absent", () => {
		const merged = mergeModelsJson({}, [entry("a/b")]);
		const openrouter = merged.providers!.openrouter!;
		expect(openrouter.baseUrl).toBe(PROVIDER_DEFAULTS.baseUrl);
		expect(openrouter.apiKey).toBe("$OPENROUTER_API_KEY");
		expect(openrouter.compat).toEqual(PROVIDER_DEFAULTS.compat);
		expect(openrouter.models).toHaveLength(1);
	});

	it("preserves user-set provider keys and other providers", () => {
		const existing = {
			providers: {
				openrouter: {
					baseUrl: "https://proxy.example.com/v1",
					compat: { openRouterRouting: { sort: { by: "latency" } } },
					modelOverrides: { "a/b": { contextWindow: 999 } },
				},
				ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions" },
			},
		};
		const merged = mergeModelsJson(existing, [entry("a/b")]);
		const openrouter = merged.providers!.openrouter!;
		expect(openrouter.baseUrl).toBe("https://proxy.example.com/v1");
		expect(openrouter.compat).toEqual({ openRouterRouting: { sort: { by: "latency" } } });
		expect(openrouter.modelOverrides).toEqual({ "a/b": { contextWindow: 999 } });
		expect(merged.providers!.ollama).toEqual(existing.providers.ollama);
	});

	it("replaces the models array wholesale", () => {
		const existing = { providers: { openrouter: { models: [entry("old/model")] } } };
		const merged = mergeModelsJson(existing, [entry("new/model")]);
		expect((merged.providers!.openrouter!.models as GeneratedModel[]).map((m) => m.id)).toEqual(["new/model"]);
	});
});

describe("syncModelsJson", () => {
	let dir: string;
	let modelsPath: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-openrouter-sync-"));
		modelsPath = join(dir, "models.json");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("writes a new file and reports changed", async () => {
		const result = await syncModelsJson({ modelsPath, models: [entry("a/b")], write: true });
		expect(result.changed).toBe(true);
		const written = JSON.parse(await readFile(modelsPath, "utf8"));
		expect(written.providers.openrouter.models).toHaveLength(1);
	});

	it("is idempotent: a second sync reports no change", async () => {
		await syncModelsJson({ modelsPath, models: [entry("a/b")], write: true });
		const second = await syncModelsJson({ modelsPath, models: [entry("a/b")], write: true });
		expect(second.changed).toBe(false);
	});

	it("check mode detects staleness without writing", async () => {
		await syncModelsJson({ modelsPath, models: [entry("a/b")], write: true });
		const stale = await syncModelsJson({ modelsPath, models: [entry("c/d")], write: false });
		expect(stale.changed).toBe(true);
		const onDisk = JSON.parse(await readFile(modelsPath, "utf8"));
		expect(onDisk.providers.openrouter.models[0].id).toBe("a/b");
	});

	it("preserves unrelated file content", async () => {
		await writeFile(
			modelsPath,
			JSON.stringify({ providers: { ollama: { baseUrl: "http://localhost:11434/v1" } } }),
		);
		await syncModelsJson({ modelsPath, models: [entry("a/b")], write: true });
		const written = JSON.parse(await readFile(modelsPath, "utf8"));
		expect(written.providers.ollama.baseUrl).toBe("http://localhost:11434/v1");
	});
});
