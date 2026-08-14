/**
 * Deterministic generation of models.json model entries from the live
 * OpenRouter catalog. Whole-catalog ownership: every model the API serves
 * gets an entry, so output depends only on (catalog, rules) — never on the
 * installed pi version's built-in catalog.
 */

import { perMillion, SURFACE_API, surfaceBaseUrl, toCost, type ApiModel, type Surface } from "./catalog.ts";
import { overridesForModel, surfaceForModel } from "./rules.ts";

export interface GeneratedModel {
	id: string;
	name: string;
	api: string;
	baseUrl?: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
}

export function buildModelEntry(api: ApiModel, baseUrl: string, surface?: Surface): GeneratedModel {
	const reasoning = api.supported_parameters?.includes("reasoning") ?? false;
	surface ??= surfaceForModel(api.id);
	const overrides = overridesForModel(api.id, surface, reasoning);
	const inputSide = api.architecture?.modality?.split("->")[0] ?? "";

	return {
		id: api.id,
		name: api.name ?? api.id,
		api: SURFACE_API[surface],
		// messages posts to {base}/v1/messages, so its base drops the /v1 suffix
		...(surface === "messages" ? { baseUrl: surfaceBaseUrl("messages", baseUrl) } : {}),
		reasoning,
		input: inputSide.includes("image") ? ["text", "image"] : ["text"],
		cost: toCost(api.pricing),
		contextWindow: api.context_length ?? 128_000,
		maxTokens: api.top_provider?.max_completion_tokens ?? 32_768,
		...(overrides.thinkingLevelMap ? { thinkingLevelMap: overrides.thinkingLevelMap } : {}),
		...(overrides.compat ? { compat: overrides.compat } : {}),
	};
}

/** Sorted by id; identical (catalog, rules) inputs produce identical output. */
export function generateModels(apiModels: ApiModel[], baseUrl: string): GeneratedModel[] {
	return [...apiModels].sort((a, b) => a.id.localeCompare(b.id)).map((m) => buildModelEntry(m, baseUrl));
}

export { perMillion };
