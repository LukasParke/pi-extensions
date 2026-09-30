import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PiAuthStore } from "@parke.dev/pi-integration-auth";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import notion from "../extensions/index.ts";
import { NOTION_AUTH_REF } from "../src/auth.ts";
import { pageSchema } from "../src/schemas.ts";

interface ContractTool {
	name: string;
	namespace: { name: string };
	annotations: {
		readOnlyHint: boolean;
		destructiveHint: boolean;
		idempotentHint: boolean;
		openWorldHint: boolean;
	};
	outputSchema: TSchema;
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<{
		content: { type: string; text: string }[];
		details: Record<string, unknown>;
		structuredContent: Record<string, unknown>;
		isError?: boolean;
	}>;
}
const page = {
	id: "page-id",
	url: "https://notion.so/page-id",
	last_edited_time: "2026-01-01T00:00:00Z",
	parent: { type: "workspace", workspace: true },
	properties: { title: { type: "title", title: [{ plain_text: "Test page" }] } },
};
const blocks = [
	{ id: "h", type: "heading_1", heading_1: { rich_text: [{ plain_text: "Title" }] } },
	{ id: "p", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Paragraph" }] } },
	{ id: "b", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "Bullet" }] } },
	{ id: "n", type: "numbered_list_item", numbered_list_item: { rich_text: [{ plain_text: "Number" }] } },
	{ id: "c", type: "code", code: { language: "typescript", rich_text: [{ plain_text: "const a = 1;" }] } },
	{ id: "q", type: "quote", quote: { rich_text: [{ plain_text: "Quote" }] } },
	{ id: "d", type: "divider" },
	{ id: "u", type: "child_page" },
];
const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
	[
		"notion_search",
		{ query: "Test" },
		{ segment: "pages", truncated: false, rows: [{ id: "page-id", title: "Test page" }] },
	],
	["notion_page", { page: "page-id" }, { segment: "page", page: { id: "page-id", truncated: false } }],
	[
		"notion_append",
		{ page: "page-id", text: "Agent: first\nsecond", yes: true },
		{ posted: true, paragraphs: 2, firstBlockId: "first-block" },
	],
	[
		"notion_status",
		{},
		{ connected: true, who: { name: "Test integration", type: "bot" }, source: "integration-auth" },
	],
	["notion_connect", { key: "fake-new-notion-key" }, { connected: true, who: "Test integration" }],
	["notion_disconnect", {}, { disconnected: true, hadStoredKey: true }],
];
let dir: string;
let tools: Map<string, ContractTool>;
let store: PiAuthStore;
let ctx: ExtensionContext;
let empty: boolean;
let status: number;
let calls: { method: string; path: string; body: unknown; authorization: string | null }[];

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "notion-contracts-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	vi.stubEnv("NOTION_TOKEN", undefined);
	vi.stubEnv("NOTION_API_KEY", undefined);
	store = new PiAuthStore();
	await store.set(NOTION_AUTH_REF, "fake-stored-notion-key");
	empty = false;
	status = 200;
	calls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL, init?: RequestInit) => {
			const path = new URL(String(input)).pathname;
			calls.push({
				method: init?.method ?? "GET",
				path,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
				authorization: new Headers(init?.headers).get("authorization"),
			});
			let data: unknown;
			if (status !== 200) data = { message: "Unauthorized", code: "unauthorized" };
			else if (path === "/v1/users/me") data = { name: "Test integration", type: "bot" };
			else if (path === "/v1/search") data = { results: empty ? [] : [page], has_more: false };
			else if (path === "/v1/pages/page-id") data = page;
			else if (path === "/v1/blocks/page-id/children")
				data =
					init?.method === "PATCH"
						? { results: empty ? [] : [{ id: "first-block" }] }
						: { results: empty ? [] : blocks, has_more: false };
			else throw new Error(`Unexpected mocked Notion path: ${path}`);
			return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
		}),
	);
	tools = new Map();
	notion({
		registerTool: (tool: ContractTool) => tools.set(tool.name, tool),
		registerCommand: vi.fn(),
		events: { emit: vi.fn() },
	} as unknown as ExtensionAPI);
	ctx = { cwd: dir, hasUI: true, ui: { confirm: vi.fn(async () => true) } } as unknown as ExtensionContext;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

async function execute(name: string, params: Record<string, unknown> = {}, context = ctx) {
	const tool = tools.get(name)!;
	const result = await tool.execute("id", params, new AbortController().signal, undefined, context);
	expect(Value.Check(tool.outputSchema, result.structuredContent)).toBe(true);
	const text = result.content.map((part) => part.text).join("");
	expect(result.structuredContent).toEqual(
		result.isError ? { ...result.details, error: text } : result.details,
	);
	expect(JSON.stringify(result)).not.toContain("fake-stored-notion-key");
	expect(JSON.stringify(result)).not.toContain("fake-new-notion-key");
	return result;
}

describe("native Notion contracts", () => {
	it("declares all six tools with accurate namespace and hints", () => {
		expect(tools.size).toBe(6);
		for (const [name, tool] of tools) {
			expect(tool.namespace.name).toBe("notion");
			expect(tool.annotations).toEqual({
				readOnlyHint: ["notion_search", "notion_page", "notion_status"].includes(name),
				destructiveHint: ["notion_connect", "notion_disconnect"].includes(name),
				idempotentHint: name !== "notion_append",
				openWorldHint: name !== "notion_disconnect",
			});
			expect(Value.Check(tool.outputSchema, {})).toBe(false);
			expect(Value.Check(tool.outputSchema, { refused: true })).toBe(false);
		}
	});

	it.each(cases)("validates %s success with business data", async (name, params, expected) => {
		const result = await execute(name, params);
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toMatchObject(expected);
		if (name === "notion_connect") expect(await store.get(NOTION_AUTH_REF)).toBe("fake-new-notion-key");
		if (name === "notion_disconnect") expect(await store.get(NOTION_AUTH_REF)).toBeNull();
		if (name === "notion_append")
			expect(calls.at(-1)?.body).toMatchObject({
				children: [
					{ paragraph: { rich_text: [{ text: { content: "Agent: first" } }] } },
					{ paragraph: { rich_text: [{ text: { content: "second" } }] } },
				],
			});
		if (calls.length && name !== "notion_connect")
			expect(calls[0]?.authorization).toBe("Bearer fake-stored-notion-key");
	});

	it.each(cases.filter(([name]) => !["notion_connect", "notion_disconnect"].includes(name)))(
		"validates %s missing-credential refusal",
		async (name, params) => {
			await store.delete(NOTION_AUTH_REF);
			const result = await execute(name, params);
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toMatchObject({
				refused: true,
				error: expect.stringContaining("No Notion credential"),
			});
			expect(calls).toEqual([]);
		},
	);

	it.each(cases.filter(([name]) => name !== "notion_disconnect"))(
		"validates %s HTTP refusal",
		async (name, params) => {
			status = 401;
			const result = await execute(name, params);
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toMatchObject({
				refused: true,
				error: expect.stringContaining("Unauthorized"),
			});
		},
	);

	it("validates no matching pages, empty blocks and a nullable append result", async () => {
		empty = true;
		expect((await execute("notion_search")).structuredContent.rows).toEqual([]);
		expect((await execute("notion_page", { page: "page-id" })).structuredContent.page).toMatchObject({
			blocks: [],
		});
		expect(
			(await execute("notion_append", { page: "page-id", text: "Agent: test", yes: true })).structuredContent
				.firstBlockId,
		).toBeNull();
	});

	it("validates an already-disconnected credential", async () => {
		await store.delete(NOTION_AUTH_REF);
		expect((await execute("notion_disconnect")).structuredContent).toEqual({
			disconnected: true,
			hadStoredKey: false,
		});
	});

	it("preserves empty-content, empty-key and headless confirmation refusals", async () => {
		const headless = { ...ctx, hasUI: false };
		for (const [name, params] of [
			["notion_append", { page: "page-id", text: "Agent: not posted" }],
			["notion_append", { page: "page-id", text: " ", yes: true }],
			["notion_connect", { key: "fake-new-notion-key" }],
			["notion_connect", { key: " " }],
		] as [string, Record<string, unknown>][]) {
			expect((await execute(name, params, headless)).isError).toBe(true);
		}
		expect(calls).toEqual([]);
		expect(await store.get(NOTION_AUTH_REF)).toBe("fake-stored-notion-key");
	});

	it("keeps declined UI writes unposted", async () => {
		ctx.ui.confirm = vi.fn(async () => false);
		expect((await execute("notion_append", { page: "page-id", text: "Agent: not posted" })).isError).toBe(
			true,
		);
		expect((await execute("notion_connect", { key: "fake-new-notion-key" })).isError).toBe(true);
		expect(calls).toEqual([]);
	});

	it("validates every documented block variant and rejects malformed blocks", () => {
		const detail = { ...page, title: "Test", lastEditedAt: 0, parent: "workspace", truncated: true };
		const data = {
			segment: "page",
			block: "page",
			rate: { remaining: null, limit: null, resetAt: null },
			page: {
				...detail,
				blocks: [
					{ type: "heading", level: 2, text: "Heading" },
					{ type: "heading", level: 3, text: "Heading" },
					{ type: "code", language: null, source: "code" },
					{ type: "table", headers: ["h"], rows: [["cell"]] },
				],
			},
		};
		expect(Value.Check(pageSchema, data)).toBe(true);
		expect(Value.Check(pageSchema, { ...data, page: { ...detail, blocks: [{ type: "paragraph" }] } })).toBe(
			false,
		);
		expect(
			Value.Check(pageSchema, {
				...data,
				page: { ...detail, blocks: [{ type: "heading", level: 4, text: "bad" }] },
			}),
		).toBe(false);
	});
});
