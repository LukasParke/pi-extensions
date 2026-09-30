import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import slack from "../extensions/index.ts";
import { resolveToken } from "../src/auth.ts";

const auth = vi.hoisted(() => ({
	stored: false,
	set: vi.fn(),
	remove: vi.fn(),
	register: vi.fn(),
}));
vi.mock("@parke.dev/pi-integration-auth", () => ({
	registerCredentialCommand: auth.register,
	PiAuthStore: class {
		async get() {
			return auth.stored ? { type: "api_key", key: "fixture-token" } : null;
		}
		setCredential = auth.set;
		delete = auth.remove;
		describe() {
			return "in-memory fixture";
		}
	},
}));
vi.mock("../src/auth.ts", () => ({
	SLACK_AUTH_REF: "slack.default",
	NO_TOKEN_MESSAGE: "No fixture token.",
	resolveToken: vi.fn(),
}));

const channel = "C12345678";
const rate = { remaining: null, limit: null, resetAt: null };
const responses = new Map<string, unknown>();
const requests: Request[] = [];
const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
	const request = new Request(input, init);
	requests.push(request);
	const method = new URL(request.url).pathname.split("/").at(-1) ?? "";
	if (!responses.has(method)) throw new Error(`Unexpected fixture request: ${method}`);
	return Response.json(responses.get(method));
});
const confirm = vi.fn(async () => true);
const emit = vi.fn();
let tools: Map<string, ToolDefinition>;

function tool(name: string) {
	const definition = tools.get(name);
	if (!definition) throw new Error(`Missing tool ${name}`);
	return definition;
}

async function run(name: string, params: Record<string, unknown> = {}, hasUI = false) {
	const definition = tool(name);
	const ctx = { hasUI, ui: { confirm } } as unknown as ExtensionToolContext;
	const result = await definition.execute("fixture", params, undefined, undefined, ctx);
	expect(definition.outputSchema).toBeDefined();
	expect(Value.Check(definition.outputSchema!, result.structuredContent)).toBe(true);
	expect(result.structuredContent).toEqual(JSON.parse(JSON.stringify(result.details)));
	expect(result.content[0]).toMatchObject({ type: "text" });
	return result;
}

beforeEach(() => {
	vi.clearAllMocks();
	responses.clear();
	requests.length = 0;
	auth.stored = false;
	confirm.mockResolvedValue(true);
	vi.mocked(resolveToken).mockResolvedValue({ token: "fixture-token", source: "env", detail: "fixture" });
	vi.stubGlobal("fetch", fetchMock);
	tools = new Map();
	slack({
		registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition),
		events: { emit },
	} as unknown as ExtensionAPI);
});
afterEach(() => vi.unstubAllGlobals());

describe("native Slack contracts", () => {
	it("registers seven namespaced tools with accurate effects", () => {
		expect([...tools.keys()].sort()).toEqual([
			"slack_channels",
			"slack_connect",
			"slack_disconnect",
			"slack_post",
			"slack_search",
			"slack_status",
			"slack_thread",
		]);
		for (const definition of tools.values()) {
			expect(definition.namespace?.name).toBe("slack");
			expect(definition.outputSchema).toBeDefined();
			const credentialWrite = ["slack_connect", "slack_disconnect"].includes(definition.name);
			expect(definition.annotations).toEqual({
				readOnlyHint: !credentialWrite && definition.name !== "slack_post",
				destructiveHint: credentialWrite,
				idempotentHint: definition.name !== "slack_post",
				openWorldHint: definition.name !== "slack_disconnect",
			});
			expect(Value.Check(definition.outputSchema!, { unrelated: true })).toBe(false);
		}
	});

	it("returns parsed channels and preserves text, rows and rate", async () => {
		responses.set("conversations.info", {
			ok: true,
			channel: { id: channel, name: "fixtures", is_private: true, num_members: 3 },
		});
		responses.set("conversations.history", {
			ok: true,
			messages: [{ ts: "1.5", text: " latest message ", reply_count: 2 }],
		});
		const result = await run("slack_channels", { channels: [channel] });
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({
			segment: "channels",
			rows: [
				{
					id: channel,
					name: "fixtures",
					topic: "",
					privacy: "private",
					memberCount: 3,
					latestText: "latest message",
					latestAt: 1500,
					replyCount: 2,
				},
			],
			truncated: false,
			rate,
		});
		expect(result.content[0]).toMatchObject({
			text: "#fixtures (private; 3 members; 2 replies) latest message",
		});
	});

	it("returns an empty channel list as success", async () => {
		responses.set("conversations.list", { ok: true, channels: [] });
		const result = await run("slack_channels");
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toMatchObject({ rows: [], truncated: false });
		expect(result.content[0]).toMatchObject({ text: "No matching channels." });
	});

	it("returns a parsed thread with resolved authors", async () => {
		responses.set("conversations.replies", {
			ok: true,
			messages: [
				{ ts: "1.5", user: "U1", text: "root" },
				{ ts: "2", username: "Fixture bot", text: "reply" },
			],
		});
		responses.set("users.info", { ok: true, user: { real_name: "Fixture user" } });
		responses.set("chat.getPermalink", { ok: true, permalink: "https://fixture.test/thread" });
		const result = await run("slack_thread", { ref: `${channel}/1.5` });
		expect(result.structuredContent).toMatchObject({
			segment: "thread",
			thread: {
				channel,
				ts: "1.5",
				permalink: "https://fixture.test/thread",
				messages: [
					{ author: "Fixture user", root: true, at: 1500, text: "root", ts: "1.5" },
					{ author: "Fixture bot", root: false, at: 2000, text: "reply", ts: "2" },
				],
			},
		});
	});

	it("returns search view models rather than raw API matches", async () => {
		responses.set("search.messages", {
			ok: true,
			messages: {
				matches: [{ ts: "1.5", user: "U1", text: "match", channel: { id: channel, name: "fixtures" } }],
				pagination: { total_count: 2 },
			},
		});
		responses.set("users.info", { ok: true, user: { real_name: "Fixture user" } });
		const result = await run("slack_search", { query: "fixture" });
		expect(result.structuredContent).toEqual({
			segment: "search",
			rows: [
				{
					channel,
					channelName: "fixtures",
					ts: "1.5",
					author: "Fixture user",
					text: "match",
					permalink: "",
					at: 1500,
				},
			],
			truncated: true,
			rate,
		});
	});

	it("distinguishes no matches from a failed search", async () => {
		responses.set("search.messages", { ok: true, messages: { matches: [] } });
		const result = await run("slack_search", { query: "no match" });
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({ segment: "search", rows: [], truncated: false, rate });
		expect(result.content[0]).toMatchObject({ text: "No matching messages." });
	});

	it("posts Agent-prefixed text with the thread timestamp intact", async () => {
		responses.set("chat.postMessage", { ok: true, channel, ts: "2" });
		const result = await run("slack_post", {
			channel,
			text: "Agent: fixture reply",
			threadTs: "1.5",
			yes: true,
		});
		expect(result.structuredContent).toEqual({ posted: true, channel, ts: "2", rate });
		expect(await requests[0]!.json()).toMatchObject({ text: "Agent: fixture reply", thread_ts: "1.5" });
		expect(confirm).not.toHaveBeenCalled();
	});

	it("keeps interactive confirmation and balanced blocked events", async () => {
		responses.set("chat.postMessage", { ok: true, channel, ts: "2" });
		await run("slack_post", { channel, text: "Agent: fixture" }, true);
		expect(confirm).toHaveBeenCalledWith(expect.any(String), "Agent: fixture", { signal: undefined });
		expect(emit.mock.calls).toEqual([
			["herdr:blocked", { active: true, label: expect.any(String) }],
			["herdr:blocked", { active: false }],
		]);
	});

	it("reports the identity, credential source and capabilities", async () => {
		responses.set("auth.test", { ok: true, team: "Fixtures", user: "Fixture", user_id: "U1" });
		const result = await run("slack_status");
		expect(result.structuredContent).toMatchObject({
			connected: true,
			source: "env",
			who: { team: "Fixtures", user: "Fixture", userId: "U1", botId: null },
			describe: { kind: "slack", needsCredential: true },
		});
	});

	it("connects only after confirmation and writes to the mocked store", async () => {
		responses.set("auth.test", { ok: true, team: "Fixtures", user: "Fixture" });
		const result = await run("slack_connect", { token: " fixture-token ", label: "fixture" }, true);
		expect(result.structuredContent).toEqual({ connected: true, who: "Fixture on Fixtures" });
		expect(auth.set).toHaveBeenCalledWith("slack.default", {
			type: "api_key",
			key: "fixture-token",
			label: "fixture",
		});
		expect(confirm).toHaveBeenCalledOnce();
	});

	it.each([false, true])("disconnects from the mocked store (stored=%s)", async (stored) => {
		auth.stored = stored;
		const result = await run("slack_disconnect");
		expect(result.structuredContent).toEqual({ disconnected: true, hadStoredKey: stored });
		expect(auth.remove).toHaveBeenCalledWith("slack.default");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["slack_connect", "slack_disconnect"])(
		"returns storage errors as schema-valid refusals for %s",
		async (name) => {
			responses.set("auth.test", { ok: true, team: "Fixtures", user: "Fixture" });
			const write = name === "slack_connect" ? auth.set : auth.remove;
			write.mockRejectedValueOnce(new Error("Fixture storage failure"));
			const result = await run(name, { token: "fixture-token" }, true);
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toMatchObject({
				refused: true,
				error: expect.stringContaining("Fixture storage failure"),
			});
		},
	);

	it.each(["slack_channels", "slack_thread", "slack_search", "slack_post", "slack_status"])(
		"returns a schema-valid missing-credential refusal for %s",
		async (name) => {
			vi.mocked(resolveToken).mockResolvedValue(null);
			const result = await run(name, {
				channel,
				ts: "1",
				query: "fixture",
				text: "Agent: fixture",
				yes: true,
			});
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toMatchObject({ refused: true, error: "No fixture token." });
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each([
		["slack_channels", "conversations.list"],
		["slack_thread", "conversations.replies"],
		["slack_search", "search.messages"],
		["slack_post", "chat.postMessage"],
		["slack_status", "auth.test"],
		["slack_connect", "auth.test"],
	])("returns a schema-valid HTTP-200 provider error for %s", async (name, method) => {
		responses.set(method, { ok: false, error: "missing_scope" });
		const result = await run(
			name,
			{ channel, ts: "1", query: "fixture", text: "Agent: fixture", yes: true, token: "fixture-token" },
			true,
		);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			refused: true,
			error: expect.stringContaining("missing_scope"),
		});
		expect(auth.set).not.toHaveBeenCalled();
	});

	it.each([
		["slack_thread", {}, false],
		["slack_post", { channel, text: "Agent: fixture" }, false],
		["slack_connect", { token: "" }, true],
		["slack_connect", { token: "fixture-token", yes: true }, false],
	])("keeps validation/headless guards for %s", async (name, params, hasUI) => {
		const result = await run(name as string, params as Record<string, unknown>, hasUI as boolean);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ refused: true, error: expect.any(String) });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(auth.set).not.toHaveBeenCalled();
	});

	it.each(["slack_post", "slack_connect"])(
		"does not perform %s when confirmation is declined",
		async (name) => {
			confirm.mockResolvedValue(false);
			const result = await run(name, { channel, text: "Agent: fixture", token: "fixture-token" }, true);
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toMatchObject({
				refused: true,
				error: expect.stringContaining("declined"),
			});
			expect(fetchMock).not.toHaveBeenCalled();
			expect(auth.set).not.toHaveBeenCalled();
		},
	);

	it("preserves cancellation while confirming", async () => {
		confirm.mockRejectedValueOnce(new DOMException("Cancelled", "AbortError"));
		await expect(run("slack_post", { channel, text: "Agent: fixture" }, true)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(emit.mock.calls.at(-1)).toEqual(["herdr:blocked", { active: false }]);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
