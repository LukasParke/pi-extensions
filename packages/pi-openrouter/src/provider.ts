/**
 * Assembles the three provider registrations. Kept separate from the
 * extension entry so both pi (registerProvider) and the benchmark script
 * (direct pi-ai streaming) consume the exact same configuration.
 */

import { attributionHeaders, type OpenRouterConfig } from "./config.ts";
import {
	buildModel,
	buildSurfaceModels,
	providerId,
	SURFACE_API,
	SURFACES,
	surfaceBaseUrl,
	type ApiModel,
	type Surface,
} from "./catalog.ts";
import { API_SURFACE, modelRoutingTable, resolveModelRoute } from "./routing.ts";

const SURFACE_NAME = {
	completions: "OpenRouter (Chat Completions)",
	responses: "OpenRouter (Responses)",
	messages: "OpenRouter (Messages)",
} as const;

export function buildProviderConfig(surface: Surface, config: OpenRouterConfig, apiModels: ApiModel[]) {
	return {
		id: providerId(surface),
		name: SURFACE_NAME[surface],
		baseUrl: surfaceBaseUrl(surface, config.baseUrl),
		apiKey: "$OPENROUTER_API_KEY",
		api: SURFACE_API[surface],
		headers: attributionHeaders(config),
		models: buildSurfaceModels(surface, apiModels, config.models),
	};
}

export function buildAllProviders(config: OpenRouterConfig, apiModels: ApiModel[]) {
	return SURFACES.map((surface) => buildProviderConfig(surface, config, apiModels));
}

export function buildRoutedProvider(config: OpenRouterConfig, apiModels: ApiModel[]) {
	const byId = new Map(apiModels.map((model) => [model.id, model]));
	const rules = modelRoutingTable(config.baseUrl);
	return {
		id: "openrouter",
		name: "OpenRouter",
		baseUrl: surfaceBaseUrl("completions", config.baseUrl),
		apiKey: "$OPENROUTER_API_KEY",
		api: SURFACE_API.completions,
		headers: attributionHeaders(config),
		models: config.models.flatMap((id) => {
			const apiModel = byId.get(id);
			if (!apiModel) return [];
			const route = resolveModelRoute(id, rules);
			return [{ ...buildModel(API_SURFACE[route.api], apiModel), ...route }];
		}),
	};
}
