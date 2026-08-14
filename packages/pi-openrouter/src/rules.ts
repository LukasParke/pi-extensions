/**
 * Surface routing policy, as data.
 *
 * Decides which OpenRouter API surface each model is served over and any
 * per-model compat fixes, in three layers (later layers win):
 *
 *   1. family rules  — author-prefix defaults (`anthropic/*` → messages, ...)
 *   2. surface rules — e.g. reasoning models on completions need
 *      `thinkingFormat: "openrouter"` to parse reasoning_details
 *   3. exceptions    — benchmark-proven per-model pins, each with a
 *      `revalidateAfter` date; sync warns when one goes stale so decisions
 *      pinned against transient platform bugs get revisited.
 */

import { SURFACE_API, type Surface } from "./catalog.ts";

export type RoutedApi = (typeof SURFACE_API)[Surface];

export interface ModelOverride {
	compat?: Record<string, unknown>;
	thinkingLevelMap?: Record<string, string | null>;
}

export interface SurfaceException {
	/** Exact model id or `prefix*`. */
	pattern: string;
	/** Pin to a non-default surface. Omit to keep the family default. */
	surface?: Surface;
	overrides?: Partial<Record<Surface, ModelOverride>>;
	reason: string;
	/** ISO date the pin was established. */
	since: string;
	/** ISO date after which the pin must be re-benchmarked. */
	revalidateAfter: string;
	/** External tracker reference, e.g. an OpenRouter ticket. */
	ticket?: string;
}

const FAMILY_RULES: ReadonlyArray<readonly [pattern: string, surface: Surface]> = [
	["anthropic/*", "messages"],
	["openai/*", "responses"],
	["*", "completions"],
];

export const EXCEPTIONS: readonly SurfaceException[] = [
	{
		pattern: "moonshotai/kimi-k3",
		surface: "responses",
		reason:
			"responses beat completions on every axis at n=110/surface: $0.01118 vs $0.01235, 81% reasoning replay vs 0%, 15.3s vs 16.2s p50 (docs/BENCHMARK-2.md)",
		since: "2026-08-12",
		revalidateAfter: "2026-11-12",
		ticket: "PLA-1076, PLA-1078",
	},
	{
		pattern: "openai/gpt-5.2",
		overrides: {
			responses: {
				thinkingLevelMap: {
					off: "none",
					minimal: null,
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: null,
				},
			},
		},
		reason: "gpt-5.2 on /responses accepts none/low/medium/high/xhigh but not minimal/max",
		since: "2026-08-12",
		revalidateAfter: "2026-11-12",
	},
	{
		pattern: "anthropic/claude-sonnet-4.6",
		overrides: {
			messages: { compat: { forceAdaptiveThinking: true }, thinkingLevelMap: { max: "max" } },
			completions: { thinkingLevelMap: { max: "max" } },
		},
		reason: "claude-sonnet-4.6 upstream requires adaptive thinking on /messages",
		since: "2026-08-12",
		revalidateAfter: "2026-11-12",
	},
	{
		pattern: "moonshotai/kimi-k2-thinking",
		overrides: {
			completions: { compat: { supportsDeveloperRole: false } },
			messages: { compat: { allowEmptySignature: true } },
		},
		reason: "kimi-k2-thinking emits empty thinking signatures on /messages",
		since: "2026-08-12",
		revalidateAfter: "2026-11-12",
	},
];

function matches(pattern: string, modelId: string): boolean {
	return (
		pattern === "*" ||
		(pattern.endsWith("*") ? modelId.startsWith(pattern.slice(0, -1)) : modelId === pattern)
	);
}

/** First family rule wins; an exception with an explicit surface beats families. */
export function surfaceForModel(modelId: string): Surface {
	const pinned = EXCEPTIONS.find((e) => e.surface && matches(e.pattern, modelId));
	if (pinned?.surface) return pinned.surface;
	const rule = FAMILY_RULES.find(([pattern]) => matches(pattern, modelId));
	if (!rule) throw new Error(`No surface rule matches ${modelId}`);
	return rule[1];
}

/** Compat + thinkingLevelMap for one model on one surface. */
export function overridesForModel(modelId: string, surface: Surface, reasoning: boolean): ModelOverride {
	const compat: Record<string, unknown> = {};
	let thinkingLevelMap: Record<string, string | null> | undefined;

	if (surface === "completions" && reasoning) compat.thinkingFormat = "openrouter";
	if (surface === "completions" && modelId.startsWith("anthropic/")) {
		compat.cacheControlFormat = "anthropic";
	}

	for (const exception of EXCEPTIONS) {
		if (!matches(exception.pattern, modelId)) continue;
		const override = exception.overrides?.[surface];
		if (!override) continue;
		Object.assign(compat, override.compat);
		if (override.thinkingLevelMap) {
			thinkingLevelMap = { ...thinkingLevelMap, ...override.thinkingLevelMap };
		}
	}

	return {
		...(Object.keys(compat).length > 0 ? { compat } : {}),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
	};
}

/** Exceptions whose revalidation date has passed. */
export function staleExceptions(now: Date = new Date()): SurfaceException[] {
	const today = now.toISOString().slice(0, 10);
	return EXCEPTIONS.filter((e) => e.revalidateAfter < today);
}
