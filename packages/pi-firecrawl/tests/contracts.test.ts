import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import firecrawl from "../extensions/firecrawl.ts";

vi.mock("../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/config.ts")>()),
	firecrawlConfig: vi.fn(async () => ({
		baseUrl: "http://firecrawl.test",
		apiKey: "fixture-key",
		timeoutMs: 120000,
		crawlTimeoutMs: 120000,
	})),
}));

const page = {
	markdown: "Fixture page content",
	html: "<p>Fixture page content</p>",
	links: ["https://fixture.test/next"],
	metadata: { title: "Fixture", sourceURL: "https://fixture.test/page", statusCode: 200, language: "en" },
};
const replies: Response[] = [];
const requests: Request[] = [];
const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
	const request = new Request(input, init);
	requests.push(request);
	expect(request.url).toMatch(/^http:\/\/firecrawl\.test\/v1\//);
	expect(request.headers.get("authorization")).toBe("Bearer fixture-key");
	const response = replies.shift();
	if (!response) throw new Error(`Unexpected fixture request: ${request.url}`);
	return response;
});
let tools: Map<string, ToolDefinition>;

function tool(name: string) {
	const definition = tools.get(name);
	if (!definition) throw new Error(`Missing tool ${name}`);
	return definition;
}
function valid(name: string, result: Awaited<ReturnType<ToolDefinition["execute"]>>) {
	const definition = tool(name);
	expect(definition.outputSchema).toBeDefined();
	expect(Value.Check(definition.outputSchema!, result.structuredContent)).toBe(true);
	expect(result.content[0]).toMatchObject({ type: "text" });
	return result;
}
async function run(
	name: string,
	params: Record<string, unknown> = {},
	signal?: AbortSignal,
	onUpdate?: Parameters<ToolDefinition["execute"]>[3],
) {
	return valid(
		name,
		await tool(name).execute("fixture", params, signal, onUpdate, {} as ExtensionToolContext),
	);
}
function respond(...bodies: unknown[]) {
	replies.push(...bodies.map((body) => Response.json(body)));
}

beforeEach(() => {
	fetchMock.mockClear();
	replies.length = 0;
	requests.length = 0;
	vi.stubGlobal("fetch", fetchMock);
	tools = new Map();
	firecrawl({
		registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition),
		registerCommand: vi.fn(),
	} as unknown as ExtensionAPI);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("native Firecrawl contracts", () => {
	it("registers four namespaced tools and identifies crawl as a paid job", () => {
		expect([...tools.keys()].sort()).toEqual([
			"firecrawl_crawl",
			"firecrawl_map",
			"firecrawl_scrape",
			"firecrawl_search",
		]);
		for (const definition of tools.values()) {
			expect(definition.namespace?.name).toBe("firecrawl");
			expect(definition.outputSchema).toBeDefined();
			expect(definition.annotations).toEqual({
				readOnlyHint: definition.name !== "firecrawl_crawl",
				destructiveHint: false,
				idempotentHint: definition.name !== "firecrawl_crawl",
				openWorldHint: true,
			});
			expect(Value.Check(definition.outputSchema!, { unrelated: true })).toBe(false);
		}
		expect(Value.Check(tool("firecrawl_search").outputSchema!, { results: [{ url: 42 }] })).toBe(false);
		expect(Value.Check(tool("firecrawl_map").outputSchema!, { links: [{}] })).toBe(false);
		expect(
			Value.Check(tool("firecrawl_crawl").outputSchema!, {
				refused: true,
				error: "failed",
				pages: [{ markdown: 42 }],
			}),
		).toBe(false);
		expect(Value.Check(tool("firecrawl_scrape").outputSchema!, { page: { markdown: 42 } })).toBe(false);
	});

	it("returns the full scraped page without changing text or details", async () => {
		respond({ success: true, data: page });
		const controller = new AbortController();
		const result = await run(
			"firecrawl_scrape",
			{
				url: "https://fixture.test/page",
				formats: ["markdown", "links"],
				onlyMainContent: false,
				waitFor: 50,
			},
			controller.signal,
		);
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({ page });
		expect(result.details).toEqual(page);
		expect(result.content[0]).toMatchObject({
			text: "# Fixture\nSource: https://fixture.test/page\n\nFixture page content\n\nLinks:\nhttps://fixture.test/next",
		});
		expect(await requests[0]!.json()).toEqual({
			url: "https://fixture.test/page",
			formats: ["markdown", "links"],
			onlyMainContent: false,
			waitFor: 50,
		});
		expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
	});

	it("returns an empty scraped page as success", async () => {
		respond({ success: true });
		const result = await run("firecrawl_scrape", { url: "https://fixture.test/empty" });
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({ page: {} });
		expect(result.content[0]).toMatchObject({ text: "(no content returned)" });
	});

	it("returns full search results while preserving the text snippet limit", async () => {
		const results = [
			{
				url: "https://fixture.test/page",
				title: "Fixture",
				description: "A fixture",
				markdown: "x".repeat(2100),
			},
		];
		const response = { success: true, data: results };
		respond(response);
		const result = await run("firecrawl_search", { query: "fixture", limit: 2, scrapeResults: true });
		expect(result.structuredContent).toEqual({ results });
		expect(result.details).toEqual(response);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("x".repeat(2000)) });
		expect(result.content[0]).not.toMatchObject({ text: expect.stringContaining("x".repeat(2100)) });
		expect(await requests[0]!.json()).toEqual({
			query: "fixture",
			limit: 2,
			scrapeOptions: { formats: ["markdown"] },
		});
	});

	it("returns no search matches as success", async () => {
		const response = { success: true, data: [] };
		respond(response);
		const result = await run("firecrawl_search", { query: "no match" });
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({ results: [] });
		expect(result.details).toEqual(response);
		expect(result.content[0]).toMatchObject({ text: "No results found." });
	});

	it.each([
		{ links: ["https://fixture.test/page"] },
		{ data: ["https://fixture.test/page", { url: "https://fixture.test/next" }] },
		{ links: [] },
	])("returns typed URLs for map response %j", async (response) => {
		respond(response);
		const result = await run("firecrawl_map", { url: "https://fixture.test", search: "fixture", limit: 2 });
		const links =
			"links" in response
				? response.links
				: response.data.map((link) => (typeof link === "string" ? link : link.url));
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({ links });
		expect(result.details).toEqual(response);
		expect(await requests[0]!.json()).toEqual({ url: "https://fixture.test", search: "fixture", limit: 2 });
	});

	it("returns completed pages and preserves progress", async () => {
		vi.useFakeTimers();
		const last = { status: "completed", completed: 1, total: 1, data: [page] };
		respond(
			{ success: true, id: "job-fixture" },
			{ status: "scraping", completed: 0, total: 1, data: [] },
			last,
		);
		const updates = vi.fn();
		const resultPromise = run(
			"firecrawl_crawl",
			{ url: "https://fixture.test", limit: 2, maxDepth: 1 },
			undefined,
			updates,
		);
		await vi.advanceTimersByTimeAsync(3000);
		const result = await resultPromise;
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({
			jobId: "job-fixture",
			status: "completed",
			completed: 1,
			total: 1,
			pages: [page],
			partial: false,
		});
		expect(result.details).toEqual(last);
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining("Crawled 1 page(s) (status: completed)."),
		});
		expect(updates).toHaveBeenCalledTimes(2);
		expect(updates.mock.calls[0]?.[0]).toMatchObject({
			content: [{ type: "text", text: "Crawl scraping: 0/1 pages" }],
			details: { status: "scraping", completed: 0, total: 1 },
		});
		for (const [update] of updates.mock.calls) valid("firecrawl_crawl", update);
		expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
			["POST", "/v1/crawl"],
			["GET", "/v1/crawl/job-fixture"],
			["GET", "/v1/crawl/job-fixture"],
		]);
		expect(await requests[0]!.json()).toEqual({
			url: "https://fixture.test",
			limit: 2,
			maxDepth: 1,
			scrapeOptions: { formats: ["markdown"] },
		});
	});

	it.each([{ pages: [] }, { pages: [page] }])(
		"returns failed crawl data as an error (pages=$pages)",
		async ({ pages }) => {
			const last = {
				status: "failed",
				completed: pages.length,
				total: 2,
				data: pages,
				error: "Fixture crawl failure",
			};
			respond({ success: true, id: "job-fixture" }, last);
			const result = await run("firecrawl_crawl", { url: "https://fixture.test" });
			expect(result.isError).toBe(true);
			expect(result.details).toEqual(last);
			expect(result.structuredContent).toEqual({
				jobId: "job-fixture",
				status: "failed",
				completed: pages.length,
				total: 2,
				pages,
				partial: true,
				refused: true,
				error: "Fixture crawl failure",
			});
		},
	);

	it("returns completed empty crawls as success", async () => {
		respond({ success: true, id: "job-fixture" }, { status: "completed", completed: 0, total: 0, data: [] });
		const result = await run("firecrawl_crawl", { url: "https://fixture.test" });
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({
			jobId: "job-fixture",
			status: "completed",
			completed: 0,
			total: 0,
			pages: [],
			partial: false,
		});
	});

	it("reports failed crawls even without a provider error message", async () => {
		respond({ success: true, id: "job-fixture" }, { status: "failed", data: [] });
		const result = await run("firecrawl_crawl", { url: "https://fixture.test" });
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ refused: true, error: "Crawl failed.", pages: [] });
	});

	it("returns partial pages after timeout without an error", async () => {
		vi.useFakeTimers();
		const last = { status: "scraping", completed: 1, total: 2, data: [page] };
		respond({ success: true, id: "job-fixture" }, last);
		const resultPromise = run("firecrawl_crawl", { url: "https://fixture.test", pollTimeoutSeconds: 1 });
		await vi.advanceTimersByTimeAsync(3000);
		const result = await resultPromise;
		expect(result.isError).not.toBe(true);
		expect(result.details).toEqual(last);
		expect(result.structuredContent).toEqual({
			jobId: "job-fixture",
			status: "scraping",
			completed: 1,
			total: 2,
			pages: [page],
			partial: true,
		});
	});

	it("returns an unpolled job with no pages as a partial success", async () => {
		respond({ success: true, id: "job-fixture" });
		const result = await run("firecrawl_crawl", { url: "https://fixture.test", pollTimeoutSeconds: 0 });
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({
			jobId: "job-fixture",
			status: "scraping",
			completed: 0,
			total: null,
			pages: [],
			partial: true,
		});
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Returning partial results.") });
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("returns a schema-valid refusal when crawl start has no id", async () => {
		respond({ success: true });
		const result = await run("firecrawl_crawl", { url: "https://fixture.test" });
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			refused: true,
			error: expect.stringContaining("did not return a job id"),
		});
	});

	it.each(["firecrawl_scrape", "firecrawl_search", "firecrawl_map", "firecrawl_crawl"])(
		"returns a schema-valid provider refusal for %s",
		async (name) => {
			respond({ success: false, error: "401 fixture rejected" });
			const result = await run(name, { url: "https://fixture.test", query: "fixture" });
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toMatchObject({
				refused: true,
				error: expect.stringContaining("fixture rejected"),
			});
		},
	);

	it("reports non-JSON HTTP failures through the same refusal contract", async () => {
		replies.push(new Response("fixture unavailable", { status: 503 }));
		const result = await run("firecrawl_scrape", { url: "https://fixture.test" });
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			refused: true,
			error: expect.stringContaining("non-JSON response (HTTP 503)"),
		});
	});

	it("preserves cooperative cancellation after crawl progress", async () => {
		vi.useFakeTimers();
		respond({ success: true, id: "job-fixture" }, { status: "scraping", completed: 0, total: 1, data: [] });
		const controller = new AbortController();
		const updates = vi.fn(() => controller.abort());
		const resultPromise = run("firecrawl_crawl", { url: "https://fixture.test" }, controller.signal, updates);
		const cancelled = expect(resultPromise).rejects.toThrow("Crawl aborted.");
		await vi.advanceTimersByTimeAsync(3000);
		await cancelled;
		expect(updates).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each(["firecrawl_scrape", "firecrawl_search", "firecrawl_map", "firecrawl_crawl"])(
		"preserves fetch cancellation for %s",
		async (name) => {
			const controller = new AbortController();
			controller.abort();
			fetchMock.mockRejectedValueOnce(new DOMException("Cancelled", "AbortError"));
			await expect(
				run(name, { url: "https://fixture.test", query: "fixture" }, controller.signal),
			).rejects.toMatchObject({ name: "AbortError" });
			expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
		},
	);
});
