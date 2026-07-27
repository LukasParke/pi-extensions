/**
 * Steel browser integration — one-shot page tools.
 *
 * Steel runs a real Chromium, so unlike a plain HTTP fetch it executes
 * JavaScript — use it for SPAs, pages behind client-side rendering, and
 * anything that needs a screenshot or PDF.
 *
 * Endpoints are the ones a Steel instance actually serves, taken from its own
 * OpenAPI document (`GET /documentation/openapi.json`) and verified live:
 *
 *   POST /v1/scrape      { url, format[], screenshot?, pdf?, delay?, ... }
 *   POST /v1/screenshot  { url, fullPage?, delay?, ... }        -> image bytes
 *   POST /v1/pdf         { url, delay?, ... }                   -> pdf bytes
 *   POST /v1/search      { query }                              -> results[]
 *   GET  /v1/health, GET/POST /v1/sessions, POST /v1/sessions/release
 *
 * Configuration lives in ~/.pi/steel.json or STEEL_* env vars; see src/config.ts.
 * Defaults point at a local docker instance on port 3000.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { explain, imageMime, steelGet, steelPost, withRetry } from "../src/client.ts";
import { cdpBase, looksRemote, steelConfig } from "../src/config.ts";

/** Cap tool text the same way Pi's built-ins do, spilling the rest to a file. */
async function capped(text: string, label: string): Promise<string> {
	const result = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!result.truncated) return result.content;
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-steel-"));
	const file = path.join(dir, `${label}.txt`);
	await fs.writeFile(file, text, "utf8");
	return `${result.content}\n\n[truncated — full ${formatSize(Buffer.byteLength(text, "utf8"))} output: ${file}]`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "steel_scrape",
		label: "Steel Scrape",
		description:
			"Fetch a page with a real headless Chromium (self-hosted Steel) and return its content. Executes JavaScript, so it works on SPAs and client-rendered pages where a plain HTTP fetch returns an empty shell. Returns markdown by default plus page metadata and extracted links.",
		parameters: Type.Object(
			{
				url: Type.String({ description: "Absolute URL to load." }),
				format: Type.Optional(
					Type.Array(StringEnum(["markdown", "readability", "cleaned_html", "html"]), {
						description: "Content formats to return. Defaults to ['markdown'].",
					}),
				),
				delay: Type.Optional(
					Type.Number({
						minimum: 0,
						maximum: 30_000,
						description:
							"Milliseconds to wait after load before capturing — use for pages that hydrate late.",
					}),
				),
				includeLinks: Type.Optional(
					Type.Boolean({ description: "Append extracted links. Defaults to false." }),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params: any, signal) {
			const config = await steelConfig();
			let payload: any;
			try {
				payload = await withRetry(() =>
					steelPost(
						config,
						"/v1/scrape",
						{
							url: params.url,
							format: params.format?.length ? params.format : ["markdown"],
							removeBase64Images: true,
							...(params.delay !== undefined ? { delay: params.delay } : {}),
						},
						{ signal },
					),
				);
			} catch (error) {
				throw new Error(explain(error, config));
			}

			const meta = payload?.metadata ?? {};
			const sections: string[] = [];
			const head = [
				meta.title ? `# ${meta.title}` : undefined,
				`url: ${meta.urlSource ?? params.url}`,
				meta.statusCode ? `status: ${meta.statusCode}` : undefined,
				meta.description ? `description: ${meta.description}` : undefined,
				meta.wordCount ? `words: ${meta.wordCount}` : undefined,
			]
				.filter(Boolean)
				.join("\n");
			sections.push(head);

			const content = payload?.content ?? {};
			for (const [key, value] of Object.entries(content)) {
				if (typeof value === "string" && value.trim()) sections.push(`## ${key}\n${value}`);
			}
			if (params.includeLinks && Array.isArray(payload?.links) && payload.links.length) {
				const links = payload.links
					.slice(0, 200)
					.map((link: any) => `- ${link.text ? `${link.text} — ` : ""}${link.url}`)
					.join("\n");
				sections.push(`## links (${payload.links.length})\n${links}`);
			}

			return {
				content: [{ type: "text" as const, text: await capped(sections.join("\n\n"), "scrape") }],
				details: { url: params.url, metadata: meta, formats: Object.keys(content) },
			};
		},
	});

	pi.registerTool({
		name: "steel_screenshot",
		label: "Steel Screenshot",
		description:
			"Screenshot a URL with a real headless Chromium (self-hosted Steel) and return the image so you can see the rendered page. Use to verify layout, inspect visual bugs, or read content that only exists after rendering.",
		parameters: Type.Object(
			{
				url: Type.String({ description: "Absolute URL to capture." }),
				fullPage: Type.Optional(
					Type.Boolean({ description: "Capture the entire scrollable page instead of the viewport." }),
				),
				delay: Type.Optional(
					Type.Number({
						minimum: 0,
						maximum: 30_000,
						description: "Milliseconds to wait after load before capturing.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params: any, signal) {
			const config = await steelConfig();
			let bytes: Buffer;
			try {
				bytes = await steelPost(
					config,
					"/v1/screenshot",
					{
						url: params.url,
						...(params.fullPage !== undefined ? { fullPage: params.fullPage } : {}),
						...(params.delay !== undefined ? { delay: params.delay } : {}),
					},
					{ signal, raw: true, timeoutMs: config.screenshotTimeoutMs },
				);
			} catch (error) {
				throw new Error(explain(error, config));
			}

			const mimeType = imageMime(bytes);
			const size = formatSize(bytes.length);
			// Very large images bloat context badly; write those out instead.
			if (bytes.length > config.maxInlineImageBytes || mimeType === "application/octet-stream") {
				const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-steel-"));
				const ext = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
				const file = path.join(dir, `screenshot.${ext}`);
				await fs.writeFile(file, bytes);
				return {
					content: [
						{
							type: "text" as const,
							text: `Screenshot of ${params.url} saved to ${file} (${size}${mimeType === "application/octet-stream" ? ", unrecognized image type" : ", too large to inline"}).`,
						},
					],
					details: {
						url: params.url,
						bytes: bytes.length,
						mimeType,
						file,
						fullPage: params.fullPage === true,
					},
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Screenshot of ${params.url} (${size}, ${mimeType}${params.fullPage ? ", full page" : ""})`,
					},
					{ type: "image" as const, data: bytes.toString("base64"), mimeType },
				],
				details: {
					url: params.url,
					bytes: bytes.length,
					mimeType,
					file: undefined as string | undefined,
					fullPage: params.fullPage === true,
				},
			};
		},
	});

	pi.registerTool({
		name: "steel_pdf",
		label: "Steel PDF",
		description:
			"Render a URL to PDF with a real headless Chromium (self-hosted Steel) and save it to a file. Use when you need a paginated snapshot of a page to keep or attach.",
		parameters: Type.Object(
			{
				url: Type.String({ description: "Absolute URL to render." }),
				output: Type.Optional(
					Type.String({ description: "File path to write the PDF to. Defaults to a temp file." }),
				),
				delay: Type.Optional(
					Type.Number({
						minimum: 0,
						maximum: 30_000,
						description: "Milliseconds to wait after load before rendering.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params: any, signal) {
			const config = await steelConfig();
			let bytes: Buffer;
			try {
				bytes = await steelPost(
					config,
					"/v1/pdf",
					{ url: params.url, ...(params.delay !== undefined ? { delay: params.delay } : {}) },
					{ signal, raw: true, timeoutMs: config.screenshotTimeoutMs },
				);
			} catch (error) {
				throw new Error(explain(error, config));
			}
			let file = params.output;
			if (file) {
				await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
				file = path.resolve(file);
			} else {
				file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "pi-steel-")), "page.pdf");
			}
			await fs.writeFile(file, bytes);
			return {
				content: [
					{
						type: "text" as const,
						text: `PDF of ${params.url} written to ${file} (${formatSize(bytes.length)}).`,
					},
				],
				details: { url: params.url, bytes: bytes.length, file },
			};
		},
	});

	pi.registerTool({
		name: "steel_search",
		label: "Steel Search",
		description:
			"Search the web through the self-hosted Steel browser and return result titles, URLs and snippets. A privacy-preserving alternative to a search API: the query runs from the home cluster, not from a third-party key.",
		parameters: Type.Object(
			{
				query: Type.String({ description: "Search query." }),
				limit: Type.Optional(
					Type.Number({ minimum: 1, maximum: 50, description: "Maximum results to return. Defaults to 10." }),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params: any, signal) {
			const config = await steelConfig();
			let payload: any;
			try {
				payload = await withRetry(() => steelPost(config, "/v1/search", { query: params.query }, { signal }));
			} catch (error) {
				throw new Error(explain(error, config));
			}
			const results: any[] = Array.isArray(payload?.results)
				? payload.results.slice(0, params.limit ?? 10)
				: [];
			if (!results.length) {
				return {
					content: [{ type: "text" as const, text: `No results for "${params.query}".` }],
					details: { query: params.query, count: 0 },
				};
			}
			const text = results
				.map((result, index) => {
					const lines = [`${index + 1}. ${result.title ?? "(untitled)"}`, `   ${result.url}`];
					if (result.description) lines.push(`   ${result.description}`);
					return lines.join("\n");
				})
				.join("\n\n");
			return {
				content: [{ type: "text" as const, text: await capped(text, "search") }],
				details: { query: params.query, count: results.length },
			};
		},
	});

	pi.registerCommand("steel", {
		description: "Show Steel browser health, base URL, and live sessions",
		handler: async (_args, ctx) => {
			const config = await steelConfig();
			try {
				const [health, sessions] = await Promise.all([
					steelGet(config, "/v1/health"),
					steelGet(config, "/v1/sessions"),
				]);
				const list: any[] = Array.isArray(sessions?.sessions) ? sessions.sessions : [];
				const lines = [
					`Steel: ${config.baseUrl}`,
					`cdp:   ${cdpBase(config)}`,
					`health: ${health?.status ?? "unknown"}`,
					`auth: ${config.apiKey ? "api key set" : looksRemote(config) ? "no key set (remote host — may be required)" : "none needed"}`,
					`sessions: ${list.length}`,
					...list
						.slice(0, 10)
						.map(
							(session) =>
								`  ${String(session.id).slice(0, 8)} ${session.status} created ${session.createdAt}`,
						),
				];
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (error) {
				ctx.ui.notify(explain(error, config), "error");
			}
		},
	});
}
