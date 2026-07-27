/**
 * Firecrawl configuration.
 *
 * Defaults to Firecrawl's hosted API, which is what most users have. A
 * self-hosted instance only needs `baseUrl` pointed at it; the hosted API also
 * needs `apiKey`.
 */

import { httpUrl, load, nonEmptyString, number, type Schema } from "@parke.dev/pi-ext-config";

export interface FirecrawlConfig {
	baseUrl: string;
	/** Sent as `Authorization: Bearer`. Required by the hosted API. */
	apiKey?: string;
	/** Request timeout for scrape/search/map, ms. */
	timeoutMs: number;
	/** How long to poll a crawl job before giving up, ms. */
	crawlTimeoutMs: number;
}

export const defaultConfig: FirecrawlConfig = {
	baseUrl: "https://api.firecrawl.dev",
	timeoutMs: 120_000,
	crawlTimeoutMs: 120_000,
};

export const schema: Schema<FirecrawlConfig> = {
	baseUrl: { validate: httpUrl, env: "FIRECRAWL_BASE_URL" },
	apiKey: { validate: nonEmptyString, env: "FIRECRAWL_API_KEY" },
	timeoutMs: { validate: number(1_000), env: "FIRECRAWL_TIMEOUT_MS" },
	crawlTimeoutMs: { validate: number(1_000), env: "FIRECRAWL_CRAWL_TIMEOUT_MS" },
};

let cached: Promise<FirecrawlConfig> | undefined;

export function firecrawlConfig(): Promise<FirecrawlConfig> {
	cached ??= load({ name: "firecrawl", schema, defaults: defaultConfig }).then((r) => r.config);
	return cached;
}

export function resetConfigCache(): void {
	cached = undefined;
}

/** The hosted API rejects unauthenticated calls; a local instance usually does not. */
export function isHosted(config: FirecrawlConfig): boolean {
	return /(^|\.)firecrawl\.dev$/.test(new URL(config.baseUrl).hostname);
}

/** Turn transport failures into something actionable. */
export function explain(error: unknown, config: FirecrawlConfig): string {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof Error && error.name === "AbortError") {
		return "Firecrawl request timed out. Try a single page instead of a crawl, or raise crawlTimeoutMs.";
	}
	if (/\b(401|402|403)\b/.test(message)) {
		return `Firecrawl rejected the request (${message}). ${
			config.apiKey
				? "The API key was not accepted — check it, and check you have credits remaining."
				: `${config.baseUrl} requires an API key: set FIRECRAWL_API_KEY or "apiKey" in ~/.pi/firecrawl.json.`
		}`;
	}
	if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|certificate|fetch failed/i.test(message)) {
		return `Cannot reach Firecrawl at ${config.baseUrl} (${message}). ${
			isHosted(config)
				? "Check your network connection."
				: "Check the host is correct and your self-hosted instance is running."
		}`;
	}
	return `Firecrawl request failed: ${message}`;
}
