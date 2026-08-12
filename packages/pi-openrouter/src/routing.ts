import { surfaceBaseUrl, SURFACE_API, type Surface } from "./catalog.ts";

export type RoutedApi = (typeof SURFACE_API)[Surface];
export type RoutingRule = readonly [pattern: string, api: RoutedApi, baseUrl: string];

export const API_SURFACE: Record<RoutedApi, Surface> = {
	"openai-completions": "completions",
	"openai-responses": "responses",
	"anthropic-messages": "messages",
};

export function modelRoutingTable(baseUrl: string): readonly RoutingRule[] {
	return [
		// Per-model exceptions go above family rules. Pin models here as platform bugs are fixed:
		// completions streaming currently omits reasoning_details; /responses does not map Anthropic
		// cache_control; Anthropic reasoning replay is flaky on non-native surfaces.
		["anthropic/*", "anthropic-messages", surfaceBaseUrl("messages", baseUrl)],
		["openai/*", "openai-responses", surfaceBaseUrl("responses", baseUrl)],
		["*", "openai-completions", surfaceBaseUrl("completions", baseUrl)],
	];
}

function matches(pattern: string, modelId: string) {
	return (
		pattern === "*" ||
		(pattern.endsWith("*") ? modelId.startsWith(pattern.slice(0, -1)) : modelId === pattern)
	);
}

export function resolveModelRoute(modelId: string, rules: readonly RoutingRule[]) {
	const rule = rules.find(([pattern]) => matches(pattern, modelId));
	if (!rule) throw new Error(`No OpenRouter route matches ${modelId}`);
	const [, api, baseUrl] = rule;
	return { api, baseUrl };
}
