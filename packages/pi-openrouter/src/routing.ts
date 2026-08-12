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
		// completions streaming currently omits reasoning_details (PLA-1076); /responses does not map
		// Anthropic cache_control (PLA-1078); Anthropic reasoning replay is flaky on non-native
		// surfaces (PLA-1077).
		//
		// kimi-k3: responses beat completions on every axis at n=110/surface — $0.01118 vs $0.01235,
		// 81% reasoning replay vs 0%, 15.3s vs 16.2s p50 — and implicit caching engages on both
		// (docs/BENCHMARK-2.md). The n=3 run had favored completions; volume overturned it.
		["moonshotai/kimi-k3", "openai-responses", surfaceBaseUrl("responses", baseUrl)],
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
