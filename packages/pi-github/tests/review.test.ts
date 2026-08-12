import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import github from "../extensions/index.ts";

interface ToolResult {
	content: { type: "text"; text: string }[];
	details: { refused?: boolean; posted?: boolean; url?: string; state?: string };
}

interface ReviewTool {
	name: string;
	description: string;
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult>;
}

function harness() {
	const tools = new Map<string, ReviewTool>();
	const pi = {
		events: { emit: vi.fn() },
		registerTool: (tool: ReviewTool) => {
			tools.set(tool.name, tool);
		},
		registerCommand: vi.fn(),
	} as unknown as ExtensionAPI;
	github(pi);
	return {
		tool: tools.get("github_review")!,
		ctx: { cwd: process.cwd(), hasUI: false } as unknown as ExtensionContext,
	};
}

function execute(params: Record<string, unknown>) {
	const h = harness();
	return h.tool.execute("id", params, new AbortController().signal, undefined, h.ctx);
}

function textOf(result: ToolResult): string {
	return result.content.map((part) => part.text).join("");
}

let originalFetch: typeof globalThis.fetch;
let originalToken: string | undefined;
const hits: string[] = [];

beforeEach(() => {
	hits.length = 0;
	originalFetch = globalThis.fetch;
	originalToken = process.env.GITHUB_TOKEN;
	process.env.GITHUB_TOKEN = "test-token";
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		hits.push(`${(init?.method ?? "GET").toUpperCase()} ${url}`);
		return new Response(
			JSON.stringify({ html_url: "https://github.com/o/r/pull/7#pullrequestreview-1", state: "COMMENTED" }),
			{
				status: 200,
				headers: {
					"content-type": "application/json",
					"x-ratelimit-remaining": "4000",
					"x-ratelimit-limit": "5000",
				},
			},
		);
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
	else process.env.GITHUB_TOKEN = originalToken;
});

describe("github_review approve gate", () => {
	it("describes approve as Luke-only", () => {
		expect(harness().tool.description).toMatch(/lukeApproved: true/);
		expect(harness().tool.description).toMatch(/Default event is comment/);
	});

	it("refuses approve without lukeApproved and does not call GitHub", async () => {
		const result = await execute({ number: 7, event: "approve", repo: "o/r", yes: true });
		expect(result.details.refused).toBe(true);
		expect(textOf(result)).toMatch(/authenticated user \(LukasParke\)/);
		expect(hits).toEqual([]);
	});

	it("refuses approve with lukeApproved but without yes", async () => {
		const result = await execute({ number: 7, event: "approve", repo: "o/r", lukeApproved: true });
		expect(result.details.refused).toBe(true);
		expect(hits).toEqual([]);
	});

	it("still posts a comment review", async () => {
		const result = await execute({
			number: 7,
			event: "comment",
			body: "Agent: looks fine",
			repo: "o/r",
			yes: true,
		});
		expect(result.details.refused).toBeUndefined();
		expect(result.details.posted).toBe(true);
		expect(hits).toEqual(["POST https://api.github.com/repos/o/r/pulls/7/reviews"]);
	});

	it("reaches the client when approve is opted in", async () => {
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			hits.push(`${(init?.method ?? "GET").toUpperCase()} ${url}`);
			hits.push(String(init?.body));
			return new Response(
				JSON.stringify({ html_url: "https://github.com/o/r/pull/7#pullrequestreview-2", state: "APPROVED" }),
				{
					status: 200,
					headers: {
						"content-type": "application/json",
						"x-ratelimit-remaining": "4000",
						"x-ratelimit-limit": "5000",
					},
				},
			);
		}) as typeof fetch;

		const result = await execute({
			number: 7,
			event: "approve",
			repo: "o/r",
			lukeApproved: true,
			yes: true,
		});
		expect(result.details.posted).toBe(true);
		expect(result.details.state).toBe("APPROVED");
		expect(hits[0]).toBe("POST https://api.github.com/repos/o/r/pulls/7/reviews");
		expect(hits[1]).toContain('"event":"APPROVE"');
	});
});
