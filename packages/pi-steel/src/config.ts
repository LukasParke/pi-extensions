/**
 * Steel configuration.
 *
 * Defaults target a stock self-hosted Steel from the official docker image
 * (`docker run -p 3000:3000 -p 9223:9223 ghcr.io/steel-dev/steel-browser`), so
 * the extension works out of the box for anyone following Steel's own
 * quickstart. Point it at Steel cloud or a remote instance via
 * `~/.pi/steel.json` or environment variables.
 */

import { httpUrl, load, nonEmptyString, number, type Schema } from "@parke.dev/pi-ext-config";

export interface SteelConfig {
	/** REST API base, e.g. http://localhost:3000 or https://api.steel.dev */
	baseUrl: string;
	/**
	 * Chrome DevTools Protocol base, used by the interactive session tools.
	 * Falls back to `baseUrl`: the single-container image serves CDP on the same
	 * origin. Split docker-compose deployments expose it separately (port 9223).
	 */
	cdpUrl?: string;
	/** Sent as both `x-api-key` and `Authorization: Bearer`. Required by Steel cloud. */
	apiKey?: string;
	/** Default request timeout for scrape/search, ms. */
	timeoutMs: number;
	/** Screenshot and PDF rendering timeout, ms. Browser work is slower. */
	screenshotTimeoutMs: number;
	/** Interactive session lifetime requested from Steel, ms. */
	sessionTimeoutMs: number;
	/** Above this, a screenshot is written to a file instead of inlined. */
	maxInlineImageBytes: number;
}

export const defaultConfig: SteelConfig = {
	baseUrl: "http://localhost:3000",
	timeoutMs: 90_000,
	screenshotTimeoutMs: 120_000,
	sessionTimeoutMs: 30 * 60_000,
	maxInlineImageBytes: 1_500_000,
};

export const schema: Schema<SteelConfig> = {
	baseUrl: { validate: httpUrl, env: "STEEL_BASE_URL" },
	cdpUrl: { validate: httpUrl, env: "STEEL_CDP_URL" },
	apiKey: { validate: nonEmptyString, env: "STEEL_API_KEY" },
	timeoutMs: { validate: number(1_000), env: "STEEL_TIMEOUT_MS" },
	screenshotTimeoutMs: { validate: number(1_000), env: "STEEL_SCREENSHOT_TIMEOUT_MS" },
	sessionTimeoutMs: { validate: number(60_000), env: "STEEL_SESSION_TIMEOUT_MS" },
	maxInlineImageBytes: { validate: number(1_024), env: "STEEL_MAX_INLINE_IMAGE_BYTES" },
};

/**
 * Resolved config, loaded once per process.
 *
 * Extensions are constructed at startup and tools run later, so a single lazy
 * read is enough; there is no reload path worth the complexity here. Callers
 * await this rather than holding a snapshot so the first tool call pays the cost.
 */
let cached: Promise<SteelConfig> | undefined;

export function steelConfig(): Promise<SteelConfig> {
	cached ??= load({ name: "steel", schema, defaults: defaultConfig }).then((r) => r.config);
	return cached;
}

/** Test seam: drop the memoized config. */
export function resetConfigCache(): void {
	cached = undefined;
}

/** CDP falls back to the REST origin, matching the single-container image. */
export function cdpBase(config: SteelConfig): string {
	return config.cdpUrl ?? config.baseUrl;
}

/**
 * Whether this deployment is expected to need an API key. Steel cloud does; a
 * localhost instance does not. Used only to phrase errors helpfully.
 */
export function looksRemote(config: SteelConfig): boolean {
	try {
		const { hostname } = new URL(config.baseUrl);
		return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1";
	} catch {
		return true;
	}
}
