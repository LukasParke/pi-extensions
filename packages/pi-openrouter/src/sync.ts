/**
 * Writes the generated catalog into models.json.
 *
 * Ownership contract: `providers.openrouter.models` is wholly tool-owned —
 * sync replaces it on every run. Everything else (other providers,
 * `modelOverrides`, provider-level compat, unrelated keys) is preserved.
 * Per-model tweaks belong in `modelOverrides`, never in hand-edited entries.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { GeneratedModel } from "./generate.ts";

export interface ProviderDefaults {
	baseUrl: string;
	apiKey: string;
	compat: Record<string, unknown>;
}

export const PROVIDER_DEFAULTS: ProviderDefaults = {
	baseUrl: "https://openrouter.ai/api/v1",
	apiKey: "$OPENROUTER_API_KEY",
	compat: {
		openRouterRouting: {
			sort: { by: "throughput" },
			allow_fallbacks: true,
		},
	},
};

interface ModelsJson {
	providers?: Record<string, Record<string, unknown> | undefined>;
	[key: string]: unknown;
}

export function mergeModelsJson(
	existing: ModelsJson,
	models: GeneratedModel[],
	defaults: ProviderDefaults = PROVIDER_DEFAULTS,
): ModelsJson {
	const providers = { ...existing.providers };
	const openrouter = { ...(providers.openrouter ?? {}) };

	openrouter.baseUrl ??= defaults.baseUrl;
	openrouter.apiKey ??= defaults.apiKey;
	openrouter.compat ??= defaults.compat;
	openrouter.models = models;

	providers.openrouter = openrouter;
	return { ...existing, providers };
}

export async function readModelsJson(path: string): Promise<ModelsJson> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as ModelsJson;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

export function renderModelsJson(config: ModelsJson): string {
	return `${JSON.stringify(config, null, 2)}\n`;
}

export interface SyncResult {
	changed: boolean;
	modelCount: number;
	output: string;
}

export async function syncModelsJson(options: {
	modelsPath: string;
	models: GeneratedModel[];
	write: boolean;
}): Promise<SyncResult> {
	const existing = await readModelsJson(options.modelsPath);
	const merged = mergeModelsJson(existing, options.models);
	const output = renderModelsJson(merged);

	let current: string | undefined;
	try {
		current = await readFile(options.modelsPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const changed = current !== output;
	if (changed && options.write) {
		await mkdir(dirname(options.modelsPath), { recursive: true });
		await writeFile(options.modelsPath, output);
	}
	return { changed, modelCount: options.models.length, output };
}
