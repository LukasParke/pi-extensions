import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { PiAuthStore } from "@parke.dev/pi-integration-auth";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerLinear from "../extensions/index.ts";
import { LINEAR_AUTH_REF } from "../src/auth.ts";
import { LINEAR_DESCRIPTION } from "../src/describe.ts";

const apiIssue = {
	id: "issue-id",
	identifier: "DEV-1",
	title: "Contract fixture",
	description: "Full description",
	url: "https://linear.app/fixture/issue/DEV-1",
	priority: 2,
	updatedAt: "2026-04-01T00:00:00Z",
	state: { name: "In Progress", type: "started" },
	assignee: { name: "Tester", isMe: true },
	team: { key: "DEV" },
	comments: {
		nodes: [
			{ id: "comment-id", body: "Agent: existing comment", createdAt: "2026-04-02T00:00:00Z", user: null },
		],
	},
};
const states = [{ id: "done-id", name: "Done", type: "completed" }];
let directory: string;
let authPath: string;
let tools: Map<string, ToolDefinition>;
let payload: Record<string, unknown> | undefined;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let confirm: ReturnType<typeof vi.fn<ExtensionToolContext["ui"]["confirm"]>>;
let emit: ReturnType<typeof vi.fn>;
let requests: { query: string; variables: Record<string, unknown> }[];

async function call(name: string, params: Record<string, unknown> = {}, hasUI = false) {
	const tool = tools.get(name)!;
	const ui = {} as ExtensionToolContext["ui"];
	ui.confirm = confirm;
	const ctx = { cwd: directory, hasUI, ui } as ExtensionToolContext;
	const result = await tool.execute("contract", params, undefined, undefined, ctx);
	expect(tool.outputSchema).toBeDefined();
	expect(Value.Check(tool.outputSchema!, result.structuredContent)).toBe(true);
	expect(result.structuredContent).toEqual({
		...JSON.parse(JSON.stringify(result.details)),
		...(result.isError ? { error: result.content[0]?.type === "text" ? result.content[0].text : "" } : {}),
	});
	expect(result.content).toEqual([expect.objectContaining({ type: "text", text: expect.any(String) })]);
	return result;
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-linear-contract-"));
	authPath = join(directory, "integration-auth.json");
	// Every store, including the credential command's store, resolves to this disposable path.
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	vi.stubEnv("LINEAR_API_KEY", "contract-only-key");
	vi.stubEnv("LINEAR_TOKEN", "");
	payload = undefined;
	requests = [];
	fetchMock = vi.fn<typeof fetch>(async (url, init) => {
		expect(String(url)).toBe("https://api.linear.app/graphql");
		expect(init?.method).toBe("POST");
		const request = JSON.parse(String(init?.body));
		requests.push(request);
		let data: Record<string, unknown>;
		if (request.query.includes("query Issues(")) data = { issues: { nodes: [apiIssue] } };
		else if (request.query.includes("query Issue(")) data = { issue: apiIssue };
		else if (request.query.includes("query States(")) data = { workflowStates: { nodes: states } };
		else if (request.query.includes("mutation Comment("))
			data = { commentCreate: { success: true, comment: { id: "new-comment", url: null } } };
		else if (request.query.includes("mutation Move(")) data = { issueUpdate: { success: true } };
		else if (request.query.includes("viewer {")) data = { viewer: { name: "Tester", email: null } };
		else throw new Error(`Unexpected mock query: ${request.query}`);
		return Response.json(payload ?? { data }, {
			headers: { "x-ratelimit-remaining": "19", "x-ratelimit-limit": "20" },
		});
	});
	vi.stubGlobal("fetch", fetchMock);
	confirm = vi.fn<ExtensionToolContext["ui"]["confirm"]>().mockResolvedValue(true);
	emit = vi.fn();
	const registerTool = vi.fn<ExtensionAPI["registerTool"]>();
	const pi = {} as ExtensionAPI;
	Object.assign(pi, { registerTool, registerCommand: vi.fn(), events: { emit } });
	registerLinear(pi);
	tools = new Map(registerTool.mock.calls.map(([tool]) => [tool.name, tool]));
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

describe("native Linear contracts", () => {
	it("declares all eight tools and truthful read/write/credential metadata", () => {
		const expected = {
			linear_issues: [true, false, true, true],
			linear_issue: [true, false, true, true],
			linear_states: [true, false, true, true],
			linear_status: [true, false, true, true],
			linear_comment: [false, false, false, true],
			linear_transition: [false, true, true, true],
			linear_connect: [false, true, true, true],
			linear_disconnect: [false, true, true, false],
		};
		expect([...tools.keys()].sort()).toEqual(Object.keys(expected).sort());
		for (const [name, hints] of Object.entries(expected)) {
			const tool = tools.get(name)!;
			expect(tool.namespace?.name).toBe("linear");
			expect(tool.outputSchema).toBeDefined();
			expect(tool.annotations).toEqual({
				readOnlyHint: hints[0],
				destructiveHint: hints[1],
				idempotentHint: hints[2],
				openWorldHint: hints[3],
			});
		}
	});

	it("preserves useful issue rows, complete detail/comments, states, and rate metadata", async () => {
		const issues = await call("linear_issues");
		expect(issues.isError).not.toBe(true);
		expect(issues.details).toEqual({
			segment: "issues",
			rows: [
				{
					id: "issue-id",
					identifier: "DEV-1",
					title: "Contract fixture",
					state: "In Progress",
					priority: "high",
					assignee: "Tester",
					team: "DEV",
					url: apiIssue.url,
					updatedAt: Date.parse(apiIssue.updatedAt),
				},
			],
			rate: { remaining: 19, limit: 20, resetAt: null },
		});
		expect(requests[0]?.variables).toMatchObject({
			first: 25,
			filter: {
				assignee: { isMe: { eq: true } },
				state: { type: { nin: ["completed", "canceled"] } },
			},
		});
		const issue = await call("linear_issue", { issue: "DEV-1" });
		expect(issue.details).toMatchObject({
			segment: "issue",
			block: "issue",
			issue: {
				description: "Full description",
				comments: [
					{ author: "unknown", body: "Agent: existing comment", at: Date.parse("2026-04-02T00:00:00Z") },
				],
			},
		});
		expect((await call("linear_states", { team: "DEV" })).details).toEqual({
			segment: "states",
			rows: states,
			rate: { remaining: 19, limit: 20, resetAt: null },
		});
	});

	it("preserves status capability declarations without exposing keys", async () => {
		const result = await call("linear_status");
		expect(result.isError).not.toBe(true);
		expect(result.details).toEqual({
			connected: true,
			who: { name: "Tester", email: null },
			source: "env",
			describe: LINEAR_DESCRIPTION,
		});
		expect(JSON.stringify(result)).not.toContain("contract-only-key");
	});

	it("validates empty lists as successes and a missing issue as a native refusal", async () => {
		payload = { data: { issues: { nodes: [] } } };
		const issues = await call("linear_issues", { search: "no-match", mine: false });
		expect(issues.isError).not.toBe(true);
		expect(issues.details).toMatchObject({ rows: [] });
		expect(issues.content[0]).toMatchObject({ text: "No matching issues." });
		payload = { data: { workflowStates: { nodes: [] } } };
		const statesResult = await call("linear_states");
		expect(statesResult.isError).not.toBe(true);
		expect(statesResult.details).toMatchObject({ rows: [] });
		payload = { data: { issue: null } };
		const missing = await call("linear_issue", { issue: "missing" });
		expect(missing.isError).toBe(true);
		expect(missing.details).toEqual({ refused: true });
	});

	it("refuses all authenticated operations without credentials or HTTP calls", async () => {
		vi.stubEnv("LINEAR_API_KEY", "");
		for (const name of [
			"linear_issues",
			"linear_issue",
			"linear_states",
			"linear_status",
			"linear_comment",
			"linear_transition",
		]) {
			const result = await call(name, { issue: "DEV-1", body: "Agent: test", state: "Done", yes: true });
			expect(result.isError).toBe(true);
			expect(result.details).toEqual(
				name === "linear_status" ? { refused: true, connected: false } : { refused: true },
			);
		}
		expect(fetchMock).not.toHaveBeenCalled();
		expect(existsSync(authPath)).toBe(false);
	});

	it("treats GraphQL HTTP-200 errors as native refusals, including status source", async () => {
		payload = { errors: [{ message: "permission denied" }] };
		for (const name of [
			"linear_issues",
			"linear_issue",
			"linear_states",
			"linear_status",
			"linear_comment",
			"linear_transition",
		]) {
			const result = await call(name, { issue: "DEV-1", body: "Agent: test", state: "Done", yes: true });
			expect(result.isError).toBe(true);
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("permission denied") });
			if (name === "linear_status")
				expect(result.details).toEqual({ refused: true, connected: false, source: "env" });
		}
	});

	it("keeps write confirmation gates and balanced blocked signals", async () => {
		for (const name of ["linear_comment", "linear_transition"]) {
			const params = { issue: "DEV-1", body: "Agent: test", state: "Done" };
			expect((await call(name, params)).isError).toBe(true);
			confirm.mockResolvedValueOnce(false);
			expect((await call(name, params, true)).isError).toBe(true);
		}
		expect(fetchMock).not.toHaveBeenCalled();
		expect(emit.mock.calls).toEqual([
			["herdr:blocked", { active: true, label: "confirm: comment on DEV-1" }],
			["herdr:blocked", { active: false }],
			["herdr:blocked", { active: true, label: "confirm: move DEV-1 to Done" }],
			["herdr:blocked", { active: false }],
		]);
	});

	it("returns successful comment/transition data and preserves Agent-prefixed text verbatim", async () => {
		const comment = await call("linear_comment", { issue: "DEV-1", body: "Agent: contract test", yes: true });
		expect(comment.isError).not.toBe(true);
		expect(comment.details).toEqual({
			posted: true,
			id: "new-comment",
			url: null,
			rate: { remaining: 19, limit: 20, resetAt: null },
		});
		expect(requests[0]?.variables).toEqual({ issueId: "DEV-1", body: "Agent: contract test" });
		const move = await call("linear_transition", { issue: "DEV-1", state: "done", yes: true });
		expect(move.isError).not.toBe(true);
		expect(move.details).toEqual({
			posted: true,
			state: "Done",
			rate: { remaining: 19, limit: 20, resetAt: null },
		});
		expect(requests.at(-1)?.variables).toEqual({ id: "DEV-1", stateId: "done-id" });
		expect(confirm).not.toHaveBeenCalled();
	});

	it("validates write business refusals for empty comments and unknown states", async () => {
		expect((await call("linear_comment", { issue: "DEV-1", body: " ", yes: true })).isError).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
		const result = await call("linear_transition", { issue: "DEV-1", state: "Unknown", yes: true });
		expect(result.isError).toBe(true);
		expect(requests.some((r) => r.query.includes("mutation"))).toBe(false);
	});

	it("never bypasses credential confirmation and never stores a rejected key", async () => {
		expect((await call("linear_connect", { key: " " })).isError).toBe(true);
		expect((await call("linear_connect", { key: "test-key", yes: true })).isError).toBe(true);
		confirm.mockResolvedValueOnce(false);
		expect((await call("linear_connect", { key: "test-key" }, true)).isError).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
		payload = { errors: [{ message: "invalid key" }] };
		expect((await call("linear_connect", { key: "test-key" }, true)).isError).toBe(true);
		expect(existsSync(authPath)).toBe(false);
	});

	it("connects and disconnects only in an isolated auth path, preserving unrelated credentials", async () => {
		const store = new PiAuthStore(authPath);
		await store.set("unrelated.default", "unrelated-fixture");
		const connect = await call("linear_connect", { key: " test-key ", label: "Fixture" }, true);
		expect(connect.isError).not.toBe(true);
		expect(connect.details).toEqual({ connected: true, who: "Tester" });
		expect(await store.getCredential(LINEAR_AUTH_REF)).toEqual({
			type: "api_key",
			key: "test-key",
			label: "Fixture",
		});
		expect(statSync(authPath).mode & 0o777).toBe(0o600);
		vi.stubEnv("LINEAR_API_KEY", "");
		expect((await call("linear_status")).details).toMatchObject({
			source: "integration-auth",
			connected: true,
		});
		const removed = await call("linear_disconnect");
		expect(removed.isError).not.toBe(true);
		expect(removed.details).toEqual({ disconnected: true, hadStoredKey: true });
		expect(await store.get(LINEAR_AUTH_REF)).toBeNull();
		expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
			"unrelated.default": { type: "api_key", key: "unrelated-fixture" },
		});
		const absent = await call("linear_disconnect");
		expect(absent.details).toEqual({ disconnected: true, hadStoredKey: false });
	});

	it("rejects malformed nested rows and rates instead of accepting opaque output", async () => {
		const schema = tools.get("linear_issues")!.outputSchema!;
		const result = await call("linear_issues");
		const data = JSON.parse(JSON.stringify(result.structuredContent));
		data.rows[0].updatedAt = "not a timestamp";
		expect(Value.Check(schema, data)).toBe(false);
		data.rows = [];
		data.rate.remaining = "19";
		expect(Value.Check(schema, data)).toBe(false);
		expect(Value.Check(schema, { refused: true, connected: "false" })).toBe(false);
	});
});
