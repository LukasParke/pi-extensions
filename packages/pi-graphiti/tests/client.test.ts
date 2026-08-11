import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphitiClient } from "../src/client.ts";
import type { GraphitiConfig } from "../src/config.ts";

const config: GraphitiConfig = {
	baseUrl: "https://memory.test/mcp",
	apiKey: "test-key",
	groupId: "main",
	timeoutMs: 5_000,
	autoRecallFacts: 5,
	autoRecallMinPromptLength: 24,
};

function jsonResponse(body: unknown, init?: ResponseInit & { sessionId?: string }) {
	const headers = new Headers({ "content-type": "application/json", ...(init?.headers ?? {}) });
	if (init?.sessionId) headers.set("mcp-session-id", init.sessionId);
	return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers });
}

function sseResponse(result: unknown) {
	return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function toolText(payload: unknown) {
	return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

describe("GraphitiClient", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function queueInitialize() {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }, { sessionId: "sess-1" }))
			.mockResolvedValueOnce(new Response(null, { status: 202 }));
	}

	it("initializes once, keeps the session id, and parses SSE tool results", async () => {
		const client = new GraphitiClient(config);
		queueInitialize();
		fetchMock.mockResolvedValueOnce(sseResponse(toolText({ facts: [{ fact: "a" }] })));

		const facts = await client.searchFacts("query", 5);
		expect(facts).toEqual([{ fact: "a" }]);

		const toolCall = fetchMock.mock.calls[2];
		expect(toolCall[1].headers["mcp-session-id"]).toBe("sess-1");
		expect(toolCall[1].headers["Authorization"]).toBe("Bearer test-key");
		const body = JSON.parse(toolCall[1].body);
		expect(body.params.name).toBe("search_memory_facts");
		expect(body.params.arguments.group_ids).toEqual(["main"]);
	});

	it("parses plain JSON tool results", async () => {
		const client = new GraphitiClient(config);
		queueInitialize();
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ jsonrpc: "2.0", id: 2, result: toolText({ status: "ok" }) }),
		);
		await expect(client.status()).resolves.toEqual({ status: "ok" });
	});

	it("re-initializes when the server session expires", async () => {
		const client = new GraphitiClient(config);
		queueInitialize();
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ jsonrpc: "2.0", id: 2, result: toolText({ status: "ok" }) }),
		);
		await client.status();

		fetchMock.mockResolvedValueOnce(new Response("session not found", { status: 404 }));
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }, { sessionId: "sess-2" }))
			.mockResolvedValueOnce(new Response(null, { status: 202 }));
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ jsonrpc: "2.0", id: 3, result: toolText({ status: "ok" }) }),
		);

		await expect(client.status()).resolves.toEqual({ status: "ok" });
		const lastCall = fetchMock.mock.calls.at(-1)!;
		expect(lastCall[1].headers["mcp-session-id"]).toBe("sess-2");
	});

	it("surfaces JSON-RPC errors and tool-level errors", async () => {
		const client = new GraphitiClient(config);
		queueInitialize();
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "boom" } }),
		);
		await expect(client.status()).rejects.toThrow("boom");

		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				jsonrpc: "2.0",
				id: 3,
				result: { isError: true, content: [{ type: "text", text: "tool exploded" }] },
			}),
		);
		await expect(client.status()).rejects.toThrow("tool exploded");
	});

	it("fails clearly when baseUrl is missing", async () => {
		const client = new GraphitiClient({ ...config, baseUrl: undefined });
		await expect(client.status()).rejects.toThrow(/baseUrl is not configured/);
	});

	it("sends add_memory with group and source defaults", async () => {
		const client = new GraphitiClient(config);
		queueInitialize();
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "queued" }] } }),
		);
		await client.addMemory({ name: "t", episodeBody: "b" });
		const body = JSON.parse(fetchMock.mock.calls[2][1].body);
		expect(body.params.arguments).toMatchObject({
			name: "t",
			episode_body: "b",
			group_id: "main",
			source: "text",
		});
	});
});
