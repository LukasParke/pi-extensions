/**
 * Builds pi model definitions for OpenRouter's three API surfaces from the
 * live OpenRouter models API (https://openrouter.ai/api/v1/models).
 *
 * The same upstream model is registered three times — once per surface — so
 * the surfaces can be compared with identical model metadata. Only `api`,
 * `baseUrl`, and surface-specific compat flags differ.
 */

import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { OpenRouterConfig } from "./config.ts";

export type Surface = "completions" | "responses" | "messages";

export const SURFACES: readonly Surface[] = ["completions", "responses", "messages"];

export const SURFACE_API = {
	completions: "openai-completions",
	responses: "openai-responses",
	messages: "anthropic-messages",
} as const;

export function providerId(surface: Surface) {
	return `openrouter-${surface}`;
}

/**
 * Where each surface's SDK-relative path lands:
 * - openai-completions posts `{base}/chat/completions`
 * - openai-responses posts `{base}/responses`
 * - anthropic-messages posts `{base}/v1/messages`
 * so completions/responses use the `/api/v1` base while messages needs `/api`.
 */
export function surfaceBaseUrl(surface: Surface, baseUrl: string) {
	const trimmed = baseUrl.replace(/\/+$/, "");
	if (surface !== "messages") return trimmed;
	return trimmed.replace(/\/v1$/, "");
}

/** Raw model entry from the OpenRouter models API. */
export interface ApiModel {
	id: string;
	name?: string;
	context_length?: number;
	architecture?: { modality?: string };
	pricing?: {
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
		input_cache_write?: string;
	};
	top_provider?: { max_completion_tokens?: number | null };
	supported_parameters?: string[];
}

/** OpenRouter prices are $/token strings; pi wants $/million. */
export function perMillion(raw: string | undefined) {
	const value = Number(raw);
	return Number.isFinite(value) ? value * 1_000_000 : 0;
}

export function toCost(pricing: ApiModel["pricing"]) {
	return {
		input: perMillion(pricing?.prompt),
		output: perMillion(pricing?.completion),
		cacheRead: perMillion(pricing?.input_cache_read),
		cacheWrite: perMillion(pricing?.input_cache_write),
	};
}

type Compat = Model<Api>["compat"];

interface SurfaceOverrides {
	compat?: Compat;
	thinkingLevelMap?: ThinkingLevelMap;
}

/**
 * Per-model, per-surface compat mirrored from pi's built-in catalogs
 * (openrouter for completions, openai for responses, anthropic for messages),
 * verified against the live endpoints:
 * - claude-sonnet-4.6 upstream requires adaptive thinking on /messages
 * - kimi-k2-thinking emits empty thinking signatures on /messages
 */
const OVERRIDES: Record<string, Partial<Record<Surface, SurfaceOverrides>>> = {
	"openai/gpt-5.2": {
		completions: { compat: { thinkingFormat: "openrouter" }, thinkingLevelMap: { xhigh: "xhigh" } },
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
	"anthropic/claude-sonnet-4.6": {
		completions: {
			compat: { thinkingFormat: "openrouter", cacheControlFormat: "anthropic" },
			thinkingLevelMap: { max: "max" },
		},
		messages: {
			compat: { forceAdaptiveThinking: true },
			thinkingLevelMap: { max: "max" },
		},
	},
	"moonshotai/kimi-k2-thinking": {
		completions: { compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" } },
		messages: { compat: { allowEmptySignature: true } },
	},
};

export interface CatalogModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: Compat;
}

export function buildModel(surface: Surface, api: ApiModel): CatalogModel {
	const overrides = OVERRIDES[api.id]?.[surface];
	return {
		id: api.id,
		name: api.name ?? api.id,
		reasoning: api.supported_parameters?.includes("reasoning") ?? false,
		input: api.architecture?.modality?.includes("image") ? ["text", "image"] : ["text"],
		cost: toCost(api.pricing),
		contextWindow: api.context_length ?? 128_000,
		maxTokens: api.top_provider?.max_completion_tokens ?? 32_768,
		...(overrides?.thinkingLevelMap ? { thinkingLevelMap: overrides.thinkingLevelMap } : {}),
		...(overrides?.compat ? { compat: overrides.compat } : {}),
	};
}

export function buildSurfaceModels(surface: Surface, apiModels: ApiModel[], curated: string[]) {
	const byId = new Map(apiModels.map((m) => [m.id, m]));
	return curated.flatMap((id) => {
		const api = byId.get(id);
		return api ? [buildModel(surface, api)] : [];
	});
}

/**
 * Snapshot of the curated models as of 2026-02, used when the live models API
 * is unreachable at startup so the providers still register.
 */
export const FALLBACK_MODELS: ApiModel[] = [
	{
		id: "openai/gpt-5.2",
		name: "OpenAI: GPT-5.2",
		context_length: 400_000,
		architecture: { modality: "text+image+file->text" },
		pricing: { prompt: "0.00000175", completion: "0.000014", input_cache_read: "0.000000175" },
		top_provider: { max_completion_tokens: 128_000 },
		supported_parameters: ["reasoning"],
	},
	{
		id: "anthropic/claude-sonnet-4.6",
		name: "Anthropic: Claude Sonnet 4.6",
		context_length: 1_000_000,
		architecture: { modality: "text+image+file->text" },
		pricing: {
			prompt: "0.000003",
			completion: "0.000015",
			input_cache_read: "0.0000003",
			input_cache_write: "0.00000375",
		},
		top_provider: { max_completion_tokens: 128_000 },
		supported_parameters: ["reasoning"],
	},
	{
		id: "moonshotai/kimi-k2-thinking",
		name: "MoonshotAI: Kimi K2 Thinking",
		context_length: 262_144,
		architecture: { modality: "text->text" },
		pricing: { prompt: "0.0000006", completion: "0.0000025", input_cache_read: "0.00000015" },
		top_provider: { max_completion_tokens: 100_352 },
		supported_parameters: ["reasoning"],
	},
];

export async function fetchApiModels(config: OpenRouterConfig, fetchImpl = fetch): Promise<ApiModel[]> {
	const response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/models`, {
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`OpenRouter models API returned ${response.status}`);
	const payload = (await response.json()) as { data?: ApiModel[] };
	if (!Array.isArray(payload.data)) throw new Error("OpenRouter models API returned no data array");
	return payload.data;
}
