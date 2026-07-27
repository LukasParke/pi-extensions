/**
 * Steel REST transport: retries, timeouts, and actionable error messages.
 *
 * Endpoints are the ones a Steel instance actually serves, taken from its own
 * OpenAPI document (`GET /documentation/openapi.json`) and verified live:
 *
 *   POST /v1/scrape      { url, format[], screenshot?, pdf?, delay?, ... }
 *   POST /v1/screenshot  { url, fullPage?, delay?, ... }        -> image bytes
 *   POST /v1/pdf         { url, delay?, ... }                   -> pdf bytes
 *   POST /v1/search      { query }                              -> results[]
 *   GET  /v1/health, GET/POST /v1/sessions, POST /v1/sessions/release
 */

import { looksRemote, type SteelConfig } from "./config.ts";

export function headers(config: SteelConfig): Record<string, string> {
	const head: Record<string, string> = { "content-type": "application/json" };
	if (config.apiKey) {
		// Steel cloud uses x-api-key; reverse proxies commonly extract a bearer
		// token instead. Sending both works against either without a config knob.
		head["x-api-key"] = config.apiKey;
		head.authorization = `Bearer ${config.apiKey}`;
	}
	return head;
}

/**
 * Steel occasionally loses a page mid-navigation and returns a 500 with one of
 * these messages — observed on /v1/search at roughly 1 in 4 calls. It is a race
 * inside the browser, not a bad request, so one retry almost always wins.
 */
const TRANSIENT_PATTERNS = [
	/Execution context was destroyed/i,
	/Navigation timeout/i,
	/Target closed/i,
	/Session closed/i,
	/detached Frame/i,
];

export function isTransient(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return TRANSIENT_PATTERNS.some((pattern) => pattern.test(message));
}

/** Retry only browser-race failures; never retry a genuine 4xx or a timeout. */
export async function withRetry<T>(operation: () => Promise<T>, attempts = 2): Promise<T> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await operation();
		} catch (error) {
			lastError = error;
			if (attempt === attempts || !isTransient(error)) throw error;
			await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
		}
	}
	throw lastError;
}

/** Turn transport-level failures into something the model can act on. */
export function explain(error: unknown, config: SteelConfig): string {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof Error && error.name === "AbortError") {
		return "Steel request timed out. The page may be slow or blocking automation; try a longer delay or a different URL.";
	}
	if (/\b(401|403)\b|Client authentication failed/i.test(message)) {
		return `Steel rejected the request as unauthenticated (${message}). ${
			config.apiKey
				? "An API key is set but was not accepted — check it matches the instance."
				: `${config.baseUrl} requires an API key: set STEEL_API_KEY or "apiKey" in ~/.pi/steel.json.`
		}`;
	}
	if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|certificate|fetch failed/i.test(message)) {
		return `Cannot reach Steel at ${config.baseUrl} (${message}). ${
			looksRemote(config)
				? "Check the host is correct, the instance is running, and you can reach it from this network (VPN if it is private)."
				: "Start a local instance with: docker run -p 3000:3000 -p 9223:9223 ghcr.io/steel-dev/steel-browser:latest — or set STEEL_BASE_URL to a remote instance."
		}`;
	}
	return `Steel request failed: ${message}`;
}

export interface RequestOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	raw?: boolean;
}

async function request(
	config: SteelConfig,
	route: string,
	init: RequestInit,
	options: RequestOptions,
	defaultTimeout: number,
): Promise<any> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? defaultTimeout);
	timeout.unref?.();
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await fetch(`${config.baseUrl}${route}`, {
			...init,
			headers: headers(config),
			signal: controller.signal,
		});
		if (!response.ok) {
			// Steel reports page-level problems as JSON {message}. Surface it.
			const text = await response.text().catch(() => "");
			let detail = text.slice(0, 600);
			try {
				const parsed = JSON.parse(text);
				if (parsed?.message) detail = String(parsed.message);
			} catch {
				/* keep raw text */
			}
			throw new Error(`Steel ${route} returned ${response.status}: ${detail || response.statusText}`);
		}
		if (options.raw) return Buffer.from(await response.arrayBuffer());
		return await response.json();
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

export function steelPost(
	config: SteelConfig,
	route: string,
	body: unknown,
	options: RequestOptions = {},
): Promise<any> {
	return request(config, route, { method: "POST", body: JSON.stringify(body) }, options, config.timeoutMs);
}

export function steelGet(config: SteelConfig, route: string, options: RequestOptions = {}): Promise<any> {
	return request(config, route, {}, options, 15_000);
}

/** Sniff the real image type; Steel serves application/octet-stream. */
export function imageMime(bytes: Buffer): string {
	if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
	if (bytes.length > 12 && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	return "application/octet-stream";
}
