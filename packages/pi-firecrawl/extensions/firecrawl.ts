import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { explain, type FirecrawlConfig, firecrawlConfig } from "../src/config.ts";

// Firecrawl integration for pi.
//
// Works against the hosted API (the default) or a self-hosted v1 instance.
// Configuration lives in ~/.pi/firecrawl.json or FIRECRAWL_* env vars; see
// src/config.ts.

function buildHeaders(config: FirecrawlConfig): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (config.apiKey) {
		headers["Authorization"] = `Bearer ${config.apiKey}`;
	}
	return headers;
}

async function firecrawlPost(
	config: FirecrawlConfig,
	path: string,
	body: unknown,
	signal: AbortSignal | undefined,
): Promise<any> {
	const url = `${config.baseUrl}${path}`;
	const response = await fetch(url, {
		method: "POST",
		headers: buildHeaders(config),
		body: JSON.stringify(body),
		signal,
	});

	const text = await response.text();
	let json: any;
	try {
		json = text ? JSON.parse(text) : {};
	} catch {
		throw new Error(
			`Firecrawl ${path} returned non-JSON response (HTTP ${response.status}): ${text.slice(0, 500)}`,
		);
	}

	if (!response.ok || json?.success === false) {
		const message = json?.error || json?.details || `HTTP ${response.status}`;
		throw new Error(`Firecrawl ${path} failed: ${message}`);
	}

	return json;
}

async function firecrawlGet(
	config: FirecrawlConfig,
	path: string,
	signal: AbortSignal | undefined,
): Promise<any> {
	const url = `${config.baseUrl}${path}`;
	const response = await fetch(url, {
		method: "GET",
		headers: buildHeaders(config),
		signal,
	});

	const text = await response.text();
	let json: any;
	try {
		json = text ? JSON.parse(text) : {};
	} catch {
		throw new Error(
			`Firecrawl ${path} returned non-JSON response (HTTP ${response.status}): ${text.slice(0, 500)}`,
		);
	}

	if (!response.ok || json?.success === false) {
		const message = json?.error || json?.details || `HTTP ${response.status}`;
		throw new Error(`Firecrawl ${path} failed: ${message}`);
	}

	return json;
}

function textResult(text: string, details: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details: details as Record<string, unknown>,
	};
}

export default function (pi: ExtensionAPI) {
	// ---- Scrape a single URL ----
	pi.registerTool({
		name: "firecrawl_scrape",
		label: "Firecrawl Scrape",
		description:
			"Scrape a single URL with Firecrawl and return its content as clean markdown (and optionally other formats). Use for fetching the readable content of a specific web page.",
		promptSnippet: "Scrape a single web page into clean markdown via Firecrawl",
		promptGuidelines: ["Use firecrawl_scrape to fetch the readable content of a specific URL as markdown."],
		parameters: Type.Object({
			url: Type.String({ description: "The URL to scrape" }),
			formats: Type.Optional(
				Type.Array(StringEnum(["markdown", "html", "rawHtml", "links", "screenshot", "summary"] as const), {
					description: "Output formats to return. Defaults to ['markdown'].",
				}),
			),
			onlyMainContent: Type.Optional(
				Type.Boolean({
					description:
						"Return only the main content of the page, excluding nav/footer/etc. Defaults to true.",
				}),
			),
			waitFor: Type.Optional(
				Type.Number({
					description: "Milliseconds to wait for the page to load before scraping.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const config = await firecrawlConfig();
			const body: Record<string, unknown> = {
				url: params.url,
				formats: params.formats ?? ["markdown"],
			};
			if (params.onlyMainContent !== undefined) body.onlyMainContent = params.onlyMainContent;
			if (params.waitFor !== undefined) body.waitFor = params.waitFor;

			const json = await firecrawlPost(config, "/v1/scrape", body, signal);
			const data = json.data ?? {};
			const parts: string[] = [];

			if (data.metadata?.title) parts.push(`# ${data.metadata.title}`);
			if (data.metadata?.sourceURL || data.metadata?.url)
				parts.push(`Source: ${data.metadata.sourceURL ?? data.metadata.url}`);
			if (data.markdown) parts.push("\n" + data.markdown);
			if (data.summary) parts.push("\nSummary:\n" + data.summary);
			if (data.html && !data.markdown) parts.push("\n" + data.html);
			if (data.rawHtml && !data.markdown && !data.html) parts.push("\n" + data.rawHtml);
			if (Array.isArray(data.links) && data.links.length) parts.push("\nLinks:\n" + data.links.join("\n"));

			const text = parts.join("\n").trim() || "(no content returned)";
			return textResult(text, data);
		},
	});

	// ---- Search the web ----
	pi.registerTool({
		name: "firecrawl_search",
		label: "Firecrawl Search",
		description:
			"Search the web with Firecrawl and return a list of results (title, URL, description). Optionally scrape the result pages into markdown.",
		promptSnippet: "Search the web via Firecrawl",
		promptGuidelines: ["Use firecrawl_search to find web pages relevant to a query."],
		parameters: Type.Object({
			query: Type.String({ description: "The search query" }),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of results to return. Defaults to 5.",
				}),
			),
			scrapeResults: Type.Optional(
				Type.Boolean({
					description: "If true, also scrape each result page and return its markdown. Defaults to false.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const config = await firecrawlConfig();
			const body: Record<string, unknown> = {
				query: params.query,
				limit: params.limit ?? 5,
			};
			if (params.scrapeResults) {
				body.scrapeOptions = { formats: ["markdown"] };
			}

			const json = await firecrawlPost(config, "/v1/search", body, signal);
			const results: any[] = Array.isArray(json.data) ? json.data : [];

			if (results.length === 0) {
				return textResult("No results found.", json);
			}

			const parts = results.map((r, i) => {
				const lines = [`${i + 1}. ${r.title ?? "(untitled)"}`, `   ${r.url}`];
				if (r.description) lines.push(`   ${r.description}`);
				if (r.markdown) {
					const snippet = String(r.markdown).slice(0, 2000);
					lines.push(`\n   --- content ---\n${snippet}`);
				}
				return lines.join("\n");
			});

			return textResult(parts.join("\n\n"), json);
		},
	});

	// ---- Map a site's URLs ----
	pi.registerTool({
		name: "firecrawl_map",
		label: "Firecrawl Map",
		description:
			"Map a website with Firecrawl to quickly discover all of its URLs. Use to enumerate the links/pages available on a site.",
		promptSnippet: "Discover all URLs on a website via Firecrawl",
		promptGuidelines: ["Use firecrawl_map to enumerate the URLs available on a website."],
		parameters: Type.Object({
			url: Type.String({ description: "The base URL of the site to map" }),
			search: Type.Optional(
				Type.String({
					description: "Optional term to filter/rank the discovered URLs.",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of URLs to return.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const config = await firecrawlConfig();
			const body: Record<string, unknown> = { url: params.url };
			if (params.search !== undefined) body.search = params.search;
			if (params.limit !== undefined) body.limit = params.limit;

			const json = await firecrawlPost(config, "/v1/map", body, signal);
			const links: string[] = Array.isArray(json.links)
				? json.links
				: Array.isArray(json.data)
					? json.data.map((l: any) => (typeof l === "string" ? l : l.url))
					: [];

			const text =
				links.length === 0 ? "No URLs found." : `Found ${links.length} URL(s):\n\n${links.join("\n")}`;
			return textResult(text, json);
		},
	});

	// ---- Crawl a site (async job) ----
	pi.registerTool({
		name: "firecrawl_crawl",
		label: "Firecrawl Crawl",
		description:
			"Crawl a website with Firecrawl, following links and scraping multiple pages into markdown. This starts a crawl job and waits for it to finish (up to a timeout). Use for gathering content across many pages of a site.",
		promptSnippet: "Crawl multiple pages of a website into markdown via Firecrawl",
		promptGuidelines: [
			"Use firecrawl_crawl to scrape multiple linked pages of a website at once. Prefer firecrawl_scrape for a single page.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "The base URL to start crawling from" }),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of pages to crawl. Defaults to 10.",
				}),
			),
			maxDepth: Type.Optional(
				Type.Number({
					description: "Maximum link depth to follow from the base URL.",
				}),
			),
			pollTimeoutSeconds: Type.Optional(
				Type.Number({
					description: "Maximum seconds to wait for the crawl job to complete. Defaults to 120.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const config = await firecrawlConfig();
			const body: Record<string, unknown> = {
				url: params.url,
				limit: params.limit ?? 10,
				scrapeOptions: { formats: ["markdown"] },
			};
			if (params.maxDepth !== undefined) body.maxDepth = params.maxDepth;

			const start = await firecrawlPost(config, "/v1/crawl", body, signal);
			const jobId: string | undefined = start.id;
			if (!jobId) {
				throw new Error("Firecrawl crawl did not return a job id.");
			}

			const timeoutMs = (params.pollTimeoutSeconds ?? 120) * 1000;
			const deadline = Date.now() + timeoutMs;
			let status = "scraping";
			let last: any = start;

			while (Date.now() < deadline) {
				if (signal?.aborted) throw new Error("Crawl aborted.");
				last = await firecrawlGet(config, `/v1/crawl/${jobId}`, signal);
				status = last.status;
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Crawl ${status}: ${last.completed ?? 0}/${last.total ?? "?"} pages`,
						},
					],
					details: { status, completed: last.completed ?? 0, total: last.total ?? null },
				} as never);
				if (status === "completed" || status === "failed") break;
				await new Promise((resolve) => setTimeout(resolve, 3000));
			}

			const pages: any[] = Array.isArray(last.data) ? last.data : [];
			if (status !== "completed") {
				const note =
					status === "failed"
						? "Crawl failed."
						: `Crawl still ${status} after timeout (${last.completed ?? 0}/${last.total ?? "?"}). Returning partial results.`;
				if (pages.length === 0) {
					return textResult(note, last);
				}
			}

			const parts = pages.map((p, i) => {
				const title = p.metadata?.title ?? "(untitled)";
				const src = p.metadata?.sourceURL ?? p.metadata?.url ?? "";
				const md = p.markdown ? String(p.markdown).slice(0, 4000) : "";
				return `### ${i + 1}. ${title}\n${src}\n\n${md}`;
			});

			const header = `Crawled ${pages.length} page(s) (status: ${status}).\n\n`;
			return textResult(header + parts.join("\n\n---\n\n"), last);
		},
	});

	// ---- Command to check connectivity ----
	pi.registerCommand("firecrawl", {
		description: "Show Firecrawl configuration and test connectivity",
		handler: async (_args, ctx) => {
			const config = await firecrawlConfig();
			const baseUrl = config.baseUrl;
			const hasKey = Boolean(config.apiKey);
			try {
				const json = await firecrawlPost(
					config,
					"/v1/scrape",
					{ url: "https://example.com", formats: ["markdown"] },
					ctx.signal,
				);
				const ok = json?.success !== false;
				ctx.ui.notify(
					`Firecrawl OK at ${baseUrl} (auth: ${hasKey ? "bearer" : "none"})`,
					ok ? "info" : "error",
				);
			} catch (err) {
				ctx.ui.notify(explain(err, config), "error");
			}
		},
	});
}
