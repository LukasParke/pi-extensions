import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PiAuthStore } from "@parke.dev/pi-integration-auth";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import github from "../extensions/index.ts";
import { GITHUB_AUTH_REF } from "../src/auth.ts";

vi.mock("node:child_process", () => ({
	execFile: vi.fn((_file, _args, _options, callback) => {
		callback(null, "");
		return { on: vi.fn() };
	}),
}));

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

const pull = {
	number: 7,
	title: "Fix contracts",
	state: "open",
	body: "Agent: test PR",
	updated_at: "2026-01-01T00:00:00Z",
	html_url: "https://github.com/o/r/pull/7",
	user: { login: "author" },
	head: { ref: "feature", sha: "abc" },
	base: { ref: "main" },
	changed_files: 1,
};
const issue = { ...pull, labels: [{ name: "bug" }], assignees: [{ login: "owner" }], comments: 2 };
const check = { name: "test", status: "completed", conclusion: "success", output: { title: "passed" } };
const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
	["github_prs", { repo: "o/r" }, { segment: "prs", truncated: false }],
	["github_prs", { repo: "o/r", search: "author:me" }, { segment: "prs" }],
	["github_pr", { repo: "o/r", number: 7 }, { segment: "pr", pr: { number: 7, filesTruncated: false } }],
	["github_issues", { repo: "o/r" }, { segment: "issues" }],
	["github_issues", { repo: "o/r", search: "bug" }, { segment: "issues" }],
	["github_checks", { repo: "o/r", ref: "main" }, { segment: "checks", rollup: "passing" }],
	[
		"github_comment",
		{ repo: "o/r", number: 7, body: "Agent: test comment", yes: true },
		{ posted: true, url: pull.html_url },
	],
	[
		"github_review",
		{ repo: "o/r", number: 7, body: "Agent: test review", yes: true },
		{ posted: true, state: "COMMENTED" },
	],
	["github_status", {}, { connected: true, login: "tester", source: "integration-auth" }],
	["github_connect", { token: "fake-new-github-token" }, { connected: true, login: "tester" }],
	["github_disconnect", {}, { disconnected: true, hadStoredToken: true }],
];
let dir: string;
let tools: Map<string, ContractTool>;
let store: PiAuthStore;
let ctx: ExtensionContext;
let empty: boolean;
let status: number;
let calls: { method: string; path: string; body: unknown; authorization: string | null }[];

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "github-contracts-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	vi.stubEnv("GITHUB_TOKEN", undefined);
	vi.stubEnv("GH_TOKEN", undefined);
	store = new PiAuthStore();
	await store.set(GITHUB_AUTH_REF, "fake-stored-github-token");
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
			if (status !== 200) data = { message: "Bad credentials" };
			else if (path === "/user") data = { login: "tester", name: null };
			else if (path === "/search/issues") data = { items: empty ? [] : [issue] };
			else if (path.endsWith("/check-runs")) data = { check_runs: empty ? [] : [check] };
			else if (path.endsWith("/comments")) data = { html_url: pull.html_url };
			else if (path.endsWith("/reviews"))
				data =
					init?.method === "POST"
						? { html_url: pull.html_url, state: "COMMENTED" }
						: [{ state: "COMMENTED", body: "Agent: feedback", user: { login: "reviewer" } }];
			else if (path.endsWith("/files"))
				data = [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "+fixed" }];
			else if (path.endsWith("/pulls/7")) data = pull;
			else if (path.endsWith("/pulls")) data = empty ? [] : [pull];
			else if (path.endsWith("/issues")) data = empty ? [] : [issue];
			else throw new Error(`Unexpected mocked GitHub path: ${path}`);
			return new Response(JSON.stringify(data), {
				status,
				headers: {
					"content-type": "application/json",
					"x-ratelimit-remaining": "4000",
					"x-ratelimit-limit": "5000",
				},
			});
		}),
	);
	tools = new Map();
	github({
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
	expect(JSON.stringify(result)).not.toContain("fake-stored-github-token");
	expect(JSON.stringify(result)).not.toContain("fake-new-github-token");
	return result;
}

describe("native GitHub contracts", () => {
	it("declares all nine tools with accurate namespace and hints", () => {
		expect(tools.size).toBe(9);
		for (const [name, tool] of tools) {
			expect(tool.namespace.name).toBe("github");
			const read = ["github_prs", "github_pr", "github_issues", "github_checks", "github_status"].includes(
				name,
			);
			expect(tool.annotations).toEqual({
				readOnlyHint: read,
				destructiveHint: ["github_review", "github_connect", "github_disconnect"].includes(name),
				idempotentHint: !["github_comment", "github_review"].includes(name),
				openWorldHint: name !== "github_disconnect",
			});
			expect(Value.Check(tool.outputSchema, {})).toBe(false);
			expect(Value.Check(tool.outputSchema, { refused: true })).toBe(false);
		}
	});

	it.each(cases)("validates %s success with business data", async (name, params, expected) => {
		const result = await execute(name, params);
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toMatchObject(expected);
		if (name === "github_connect") expect(await store.get(GITHUB_AUTH_REF)).toBe("fake-new-github-token");
		if (name === "github_disconnect") expect(await store.get(GITHUB_AUTH_REF)).toBeNull();
		if (name === "github_comment" || name === "github_review")
			expect(calls.at(-1)?.body).toMatchObject({ body: params.body });
		if (calls.length && name !== "github_connect")
			expect(calls[0]?.authorization).toBe("Bearer fake-stored-github-token");
	});

	it.each(cases.filter(([name]) => !["github_connect", "github_disconnect"].includes(name)))(
		"validates %s missing-credential refusal",
		async (name, params) => {
			await store.delete(GITHUB_AUTH_REF);
			const result = await execute(name, params);
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toMatchObject({
				refused: true,
				error: expect.stringContaining("No GitHub credential"),
			});
			expect(calls).toEqual([]);
		},
	);

	it.each(cases.filter(([name]) => name !== "github_disconnect"))(
		"validates %s HTTP refusal",
		async (name, params) => {
			status = 401;
			const result = await execute(name, params);
			expect(result.isError).toBe(true);
			expect(result.structuredContent.refused).toBe(true);
			expect(result.structuredContent.error).toEqual(expect.stringContaining("Bad credentials"));
		},
	);

	it.each(["github_prs", "github_issues", "github_checks"])("validates %s empty rows", async (name) => {
		empty = true;
		const result = await execute(name, { repo: "o/r", ref: "main" });
		expect(result.structuredContent.rows).toEqual([]);
		expect(result.isError).not.toBe(true);
	});

	it("validates empty PR search rows and already-disconnected credentials", async () => {
		empty = true;
		expect((await execute("github_prs", { repo: "o/r", search: "none" })).structuredContent.rows).toEqual([]);
		await store.delete(GITHUB_AUTH_REF);
		expect((await execute("github_disconnect")).structuredContent).toEqual({
			disconnected: true,
			hadStoredToken: false,
		});
	});

	it("preserves confirmation, empty credential and approval refusals without HTTP", async () => {
		const headless = { ...ctx, hasUI: false };
		for (const [name, params] of [
			["github_comment", { repo: "o/r", number: 7, body: "Agent: not posted" }],
			["github_review", { repo: "o/r", number: 7, body: "Agent: not posted" }],
			["github_review", { repo: "o/r", number: 7, event: "approve", yes: true }],
			["github_review", { repo: "o/r", number: 7, event: "approve", lukeApproved: true }],
			["github_connect", { token: "fake-new-github-token" }],
			["github_connect", { token: " " }],
		] as [string, Record<string, unknown>][]) {
			expect((await execute(name, params, headless)).isError).toBe(true);
		}
		expect(calls).toEqual([]);
		expect(await store.get(GITHUB_AUTH_REF)).toBe("fake-stored-github-token");
	});

	it("keeps declined UI writes unposted", async () => {
		ctx.ui.confirm = vi.fn(async () => false);
		expect(
			(await execute("github_comment", { repo: "o/r", number: 7, body: "Agent: not posted" })).isError,
		).toBe(true);
		expect((await execute("github_connect", { token: "fake-new-github-token" })).isError).toBe(true);
		expect(calls).toEqual([]);
	});
});
