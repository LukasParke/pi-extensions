/**
 * OpenRouter provider configuration.
 *
 * The API key is intentionally NOT part of this config: providers reference it
 * as `$OPENROUTER_API_KEY` so pi resolves it per request and the value never
 * passes through extension code.
 */

import { httpUrl, load, nonEmptyString, stringArray, type Schema } from "@parke.dev/pi-ext-config";

export interface OpenRouterConfig {
	/** OpenRouter API base, `/v1` included (the messages surface derives its own base from it). */
	baseUrl: string;
	/** Curated model ids to register on every surface. */
	models: string[];
	/** App attribution: `HTTP-Referer` header. */
	referer: string;
	/** App attribution: `X-Title` / `X-OpenRouter-Title` header. */
	title: string;
}

export const defaultConfig: OpenRouterConfig = {
	baseUrl: "https://openrouter.ai/api/v1",
	models: ["openai/gpt-5.2", "anthropic/claude-sonnet-4.6", "moonshotai/kimi-k2-thinking"],
	referer: "https://github.com/LukasParke/pi-extensions",
	title: "pi-openrouter",
};

export const schema: Schema<OpenRouterConfig> = {
	baseUrl: { validate: httpUrl, env: "PI_OPENROUTER_BASE_URL" },
	models: { validate: stringArray },
	referer: { validate: nonEmptyString },
	title: { validate: nonEmptyString },
};

let cached: Promise<OpenRouterConfig> | undefined;

export function openrouterConfig(): Promise<OpenRouterConfig> {
	cached ??= load({ name: "openrouter", schema, defaults: defaultConfig }).then((r) => r.config);
	return cached;
}

export function resetConfigCache(): void {
	cached = undefined;
}

export function attributionHeaders(config: Pick<OpenRouterConfig, "referer" | "title">) {
	return {
		"HTTP-Referer": config.referer,
		"X-Title": config.title,
		"X-OpenRouter-Title": config.title,
	};
}
