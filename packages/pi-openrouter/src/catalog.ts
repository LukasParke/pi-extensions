/**
 * Shared vocabulary for OpenRouter's three API surfaces and the live models
 * API (https://openrouter.ai/api/v1/models). Model entry construction lives
 * in generate.ts; routing policy lives in rules.ts.
 */

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

export async function fetchApiModels(
	config: { baseUrl: string },
	fetchImpl = fetch,
): Promise<ApiModel[]> {
	const response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/models`, {
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`OpenRouter models API returned ${response.status}`);
	const payload = (await response.json()) as { data?: ApiModel[] };
	if (!Array.isArray(payload.data)) throw new Error("OpenRouter models API returned no data array");
	return payload.data;
}
