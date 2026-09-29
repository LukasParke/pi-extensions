import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import {
	createEventBus,
	defineTool,
	type ExtensionAPI,
	type ExtensionToolContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerSession from "../extensions/steel-session.ts";
import registerSteel from "../extensions/steel.ts";

const config = vi.hoisted(() => ({
	baseUrl: "http://steel.invalid",
	cdpUrl: "http://cdp.invalid",
	timeoutMs: 1000,
	screenshotTimeoutMs: 1000,
	sessionTimeoutMs: 1_800_000,
	maxInlineImageBytes: 100,
}));
vi.mock("../src/config.ts", async (original) => ({
	...(await original<typeof import("../src/config.ts")>()),
	steelConfig: async () => config,
}));

const tools = new Map<string, ToolDefinition>();
const fetchMock = vi.fn<typeof fetch>();
const sent: { method: string; params: Record<string, unknown> }[] = [];
const files = new Set<string>();
const url = "https://example.com/page";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]);
let binary: Buffer;
let scrape: object;
let search: object;
let restFailure: string | undefined;
let cdpFailure: string | undefined;
let pageUrl: string;
let pageText: string;
let missingRoot: boolean;
let locationFailure: boolean;
let createSession: object;
let dom: ReturnType<typeof makeDom>;

function makeDom() {
	const field = {
		id: "field",
		name: "field",
		tagName: "INPUT",
		type: "text",
		value: "",
		required: true,
		labels: [{ innerText: "Name" }],
		getAttribute: () => null,
		scrollIntoView: vi.fn(),
		focus: vi.fn(),
		dispatchEvent: vi.fn(),
	};
	const button = {
		id: "submit",
		tagName: "BUTTON",
		type: "submit",
		innerText: "Submit",
		required: false,
		getAttribute: () => null,
		scrollIntoView: vi.fn(),
		click: vi.fn(),
	};
	const body = {
		get innerText() {
			return pageText;
		},
		querySelectorAll: (selector: string) => {
			if (selector === "a[href]") return [{ innerText: "Docs", href: "https://example.com/docs" }];
			if (selector.startsWith("input:not")) return [field];
			if (selector.startsWith("button,")) return [button];
			return [];
		},
	};
	return {
		field,
		button,
		document: {
			body,
			title: "Example",
			readyState: "complete",
			querySelector: (selector: string) => {
				if (selector === "#missing" || missingRoot) return null;
				if (selector === "#field") return field;
				if (selector === "#submit") return button;
				return body;
			},
			querySelectorAll: () => [field],
		},
		window: { innerHeight: 800, scrollBy: vi.fn() },
	};
}

class MockSocket {
	onopen?: () => void;
	onmessage?: (event: { data: string }) => void;
	onclose?: () => void;
	constructor(readonly url: string) {
		queueMicrotask(() => this.onopen?.());
	}
	send(raw: string) {
		const message: { id: number; method: string; params: Record<string, unknown> } = JSON.parse(raw);
		sent.push(message);
		let result: object = {};
		let error: { message: string } | undefined;
		if (message.method === cdpFailure) error = { message: "mock CDP failure" };
		else if (message.method === "Target.getTargets")
			result = { targetInfos: [{ type: "page", targetId: "page" }] };
		else if (message.method === "Target.attachToTarget") result = { sessionId: "attached" };
		else if (message.method === "Page.navigate") pageUrl = String(message.params.url);
		else if (message.method === "Page.captureScreenshot") result = { data: binary.toString("base64") };
		else if (message.method === "Runtime.evaluate") {
			try {
				const expression = String(message.params.expression);
				if (expression === "location.href" && locationFailure) throw new Error("location unavailable");
				result = {
					result: {
						value: runInNewContext(expression, {
							...dom,
							location: { href: pageUrl },
							CSS: { escape: (value: string) => value },
							Event,
						}),
					},
				};
			} catch (cause) {
				result = { exceptionDetails: { text: String(cause) } };
			}
		}
		queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result, error }) }));
	}
	close() {
		this.onclose?.();
	}
}

function tool(name: string) {
	const definition = tools.get(name);
	if (!definition) throw new Error(`Missing tool ${name}`);
	return definition;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function execute(name: string, params: Record<string, unknown>, cwd = process.cwd()) {
	const definition = tool(name);
	expect(Value.Check(definition.parameters, params)).toBe(true);
	const result = await definition.execute("contract", params, undefined, undefined, {
		cwd,
	} as ExtensionToolContext);
	if (!definition.outputSchema) throw new Error(`Missing output schema for ${name}`);
	expect(Value.Check(definition.outputSchema, result.structuredContent)).toBe(true);
	expect(result.structuredContent).toEqual(JSON.parse(JSON.stringify(result.structuredContent)));
	const output = result.structuredContent;
	if (!isObject(output)) throw new Error("Expected business object");
	for (const key of ["file", "fullOutputPath"]) {
		if (typeof output[key] === "string") files.add(output[key]);
	}
	return { result, output };
}

beforeEach(async () => {
	tools.clear();
	sent.length = 0;
	binary = png;
	scrape = {};
	search = {};
	restFailure = undefined;
	cdpFailure = undefined;
	pageUrl = url;
	pageText = "Hello page";
	missingRoot = false;
	locationFailure = false;
	createSession = { id: "session-123", sessionViewerUrl: "https://viewer.invalid/session-123" };
	config.maxInlineImageBytes = 100;
	dom = makeDom();
	fetchMock.mockReset().mockImplementation(async (input) => {
		const route = new URL(String(input)).pathname;
		if (restFailure === route) return Response.json({ message: "mock REST failure" }, { status: 403 });
		if (route === "/v1/scrape") return Response.json(scrape);
		if (route === "/v1/search") return Response.json(search);
		if (route === "/v1/screenshot" || route === "/v1/pdf") return new Response(new Uint8Array(binary));
		if (route === "/v1/sessions") return Response.json(createSession);
		if (route.endsWith("/release")) return Response.json({});
		if (route === "/json/version")
			return Response.json({ webSocketDebuggerUrl: "ws://localhost/devtools/browser/mock" });
		throw new Error(`Unexpected mock REST request: ${input}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	vi.stubGlobal("WebSocket", MockSocket);
	const unexpected = (): never => {
		throw new Error("Unexpected Pi API use");
	};
	const api: ExtensionAPI = {
		registerTool: (definition) => {
			tools.set(definition.name, defineTool(definition));
		},
		registerCommand: vi.fn(),
		on: () => () => {},
		events: createEventBus(),
		registerShortcut: unexpected,
		registerFlag: unexpected,
		getFlag: unexpected,
		registerMessageRenderer: unexpected,
		registerMarkdownTransformer: unexpected,
		registerEntryRenderer: unexpected,
		sendMessage: unexpected,
		sendUserMessage: unexpected,
		appendEntry: unexpected,
		setSessionName: unexpected,
		getSessionName: unexpected,
		setLabel: unexpected,
		exec: unexpected,
		getActiveTools: unexpected,
		getAllTools: unexpected,
		getSettings: unexpected,
		setActiveTools: unexpected,
		getCommands: unexpected,
		setModel: unexpected,
		getThinkingLevel: unexpected,
		setThinkingLevel: unexpected,
		registerProvider: unexpected,
		unregisterProvider: unexpected,
		registerMcpServer: unexpected,
		unregisterMcpServer: unexpected,
		getMcpServers: unexpected,
		registerVirtualModel: unexpected,
		unregisterVirtualModel: unexpected,
	};
	registerSteel(api);
	registerSession(api);
	await execute("steel_session", { action: "end" });
	fetchMock.mockClear();
	sent.length = 0;
});

afterEach(async () => {
	await execute("steel_session", { action: "end" });
	vi.unstubAllGlobals();
	for (const file of files) await fs.rm(path.dirname(file), { recursive: true, force: true });
	files.clear();
});

describe("native Steel contracts", () => {
	it("registers nine business schemas, a namespace, and conservative shared-session metadata", () => {
		expect(tools.size).toBe(9);
		for (const definition of tools.values()) {
			expect(definition.namespace?.name).toBe("steel");
			expect(definition.annotations?.openWorldHint).toBe(true);
			expect(definition.outputSchema).toBeDefined();
			expect(JSON.stringify(definition.outputSchema)).not.toContain('"type":"any"');
		}
		for (const name of ["steel_session", "steel_navigate", "steel_act", "steel_read", "steel_look"]) {
			expect(tool(name).annotations?.readOnlyHint).toBe(false);
			expect(tool(name).executionMode).toBe("sequential");
		}
		for (const name of ["steel_navigate", "steel_act", "steel_read", "steel_look"])
			expect(tool(name).annotations?.idempotentHint).toBe(false);
		expect(tool("steel_act").annotations?.destructiveHint).toBe(true);
	});

	it("scrapes all formats including empty strings and keeps all links beyond the text's first 200", async () => {
		const links = Array.from({ length: 205 }, (_, index) => ({
			text: `Link ${index}`,
			url: `${url}/${index}`,
		}));
		const metadata = {
			title: "Title",
			urlSource: url,
			statusCode: 200,
			description: "Description",
			wordCount: 3,
		};
		scrape = { metadata, content: { markdown: "Page", html: "", cleaned_html: "  " }, links };
		const { result, output } = await execute("steel_scrape", { url, includeLinks: true });
		expect(output).toMatchObject({
			url,
			metadata,
			content: { markdown: "Page", html: "", cleaned_html: "  " },
			links,
			truncated: false,
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("## links (205)"),
		});
		expect(result.content[0]).toMatchObject({ text: expect.not.stringContaining("Link 204") });
	});

	it("handles empty scrape and leaves links out unless requested", async () => {
		expect((await execute("steel_scrape", { url })).output).toEqual({
			url,
			metadata: {},
			content: {},
			truncated: false,
		});
		scrape = { links: [{ url }] };
		expect((await execute("steel_scrape", { url })).output).not.toHaveProperty("links");
	});

	it("spills capped scrape text without losing structured content", async () => {
		const markdown = "x".repeat(60_000);
		scrape = { content: { markdown } };
		const { output } = await execute("steel_scrape", { url });
		expect(output).toMatchObject({ content: { markdown }, truncated: true });
		if (typeof output.fullOutputPath !== "string") throw new Error("Missing spill path");
		expect(await fs.readFile(output.fullOutputPath, "utf8")).toContain(markdown);
	});

	it("returns search business results without filtering or dropping extra fields", async () => {
		const results = [{ title: "One", url, description: "Snippet", score: 1 }, { url: `${url}/2` }];
		search = { results };
		const { result, output } = await execute("steel_search", { query: "query", limit: 2 });
		expect(output).toEqual({ query: "query", count: 2, results, truncated: false });
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("(untitled)") });
		expect((await execute("steel_search", { query: "query", limit: 1 })).output.count).toBe(1);
	});

	it("returns empty search results as an array", async () => {
		expect((await execute("steel_search", { query: "missing" })).output).toEqual({
			query: "missing",
			count: 0,
			results: [],
			truncated: false,
		});
	});

	it("spills long search output, retaining snippets", async () => {
		const results = [{ url, description: "x".repeat(60_000) }];
		search = { results };
		const { output } = await execute("steel_search", { query: "large" });
		expect(output).toMatchObject({ results, truncated: true });
		if (typeof output.fullOutputPath !== "string") throw new Error("Missing spill path");
		expect(await fs.readFile(output.fullOutputPath, "utf8")).toContain(results[0].description);
	});

	it("returns identical inline screenshot blocks to native callers", async () => {
		const { result, output } = await execute("steel_screenshot", { url, fullPage: true, delay: 10 });
		expect(output).toEqual({
			url,
			bytes: png.length,
			mimeType: "image/png",
			fullPage: true,
			file: null,
			image: { type: "image", data: png.toString("base64"), mimeType: "image/png" },
		});
		expect(result.content[1]).toEqual(output.image);
		const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
		expect(body).toEqual({ url, fullPage: true, delay: 10 });
	});

	it.each(["large", "unrecognized", "empty"])("saves %s screenshot bytes unchanged", async (kind) => {
		if (kind === "large") config.maxInlineImageBytes = 1;
		if (kind === "unrecognized") binary = Buffer.from("not an image");
		if (kind === "empty") binary = Buffer.alloc(0);
		const { result, output } = await execute("steel_screenshot", { url });
		expect(output.image).toBeNull();
		expect(result.content).toHaveLength(1);
		if (typeof output.file !== "string") throw new Error("Missing image path");
		expect(await fs.readFile(output.file)).toEqual(binary);
	});

	it.each([false, true])("writes PDF bytes to a %s explicit path", async (explicit) => {
		binary = Buffer.from("%PDF-mock");
		const outputPath = explicit
			? path.join(await fs.mkdtemp(path.join(os.tmpdir(), "pi-steel-test-")), "page.pdf")
			: undefined;
		const { output } = await execute("steel_pdf", { url, ...(outputPath ? { output: outputPath } : {}) });
		expect(output).toMatchObject({ url, bytes: binary.length });
		if (typeof output.file !== "string") throw new Error("Missing PDF path");
		if (outputPath) expect(output.file).toBe(outputPath);
		expect(await fs.readFile(output.file)).toEqual(binary);
	});

	it("resolves relative PDF output against the native tool context", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-steel-pdf-cwd-"));
		files.add(path.join(cwd, "cleanup"));
		binary = Buffer.from("%PDF-context");
		const { output } = await execute("steel_pdf", { url, output: "nested/page.pdf" }, cwd);
		expect(output.file).toBe(path.join(cwd, "nested/page.pdf"));
		expect(await fs.readFile(String(output.file))).toEqual(binary);
	});

	it.each(["steel_scrape", "steel_search", "steel_screenshot", "steel_pdf"])(
		"surfaces REST failure for %s",
		async (name) => {
			restFailure = `/v1/${name.slice(6)}`;
			await expect(execute(name, name === "steel_search" ? { query: "query" } : { url })).rejects.toThrow(
				"unauthenticated",
			);
		},
	);

	it("reports empty lifecycle, starts once, reports live state, and releases once", async () => {
		expect((await execute("steel_session", { action: "status" })).output).toMatchObject({
			action: "status",
			live: false,
			id: null,
		});
		const started = (await execute("steel_session", { action: "start" })).output;
		expect(started).toMatchObject({
			action: "start",
			live: true,
			id: "session-123",
			viewerUrl: "https://viewer.invalid/session-123",
		});
		await execute("steel_session", { action: "start" });
		expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/v1/sessions"))).toHaveLength(1);
		expect((await execute("steel_session", { action: "status" })).output).toMatchObject({ live: true, url });
		expect((await execute("steel_session", { action: "end" })).output).toMatchObject({
			live: false,
			released: "session-123",
		});
		expect((await execute("steel_session", { action: "end" })).output.released).toBeNull();
	});

	it("normalizes missing viewer URLs and failed URL evaluation", async () => {
		createSession = { id: "session-123" };
		locationFailure = true;
		expect((await execute("steel_session", { action: "start" })).output.viewerUrl).toBeNull();
		expect((await execute("steel_session", { action: "status" })).output.url).toBeNull();
	});

	it("navigates with real CDP expressions and keeps business page text", async () => {
		const target = "https://example.com/new";
		const { output } = await execute("steel_navigate", { url: target });
		expect(output).toEqual({
			url: target,
			sessionId: "session-123",
			title: "Example",
			text: "Hello page",
			truncated: false,
		});
		expect(sent).toContainEqual(
			expect.objectContaining({ method: "Page.navigate", params: { url: target } }),
		);
	});

	it("handles empty page text and documents extraction separately from transcript capping", async () => {
		pageText = "";
		expect((await execute("steel_navigate", { url })).output.text).toBe("");
		pageText = "x".repeat(50_000);
		const { output } = await execute("steel_read", { mode: "text" });
		expect(output.text).toBe("x".repeat(40_000));
		expect(output.truncated).toBe(false);
	});

	it.each(["text", "links", "forms", "all"])("runs the actual read script in %s mode", async (mode) => {
		const { output } = await execute("steel_read", { mode });
		expect(output).toMatchObject({ mode, sessionId: "session-123", url, title: "Example", error: null });
		if (mode === "text" || mode === "all") expect(output.text).toBe(pageText);
		if (mode === "links" || mode === "all")
			expect(output.links).toEqual([{ text: "Docs", href: "https://example.com/docs" }]);
		if (mode === "forms" || mode === "all") {
			expect(output.fields).toEqual([
				expect.objectContaining({ selector: "#field", unique: true, label: "Name" }),
			]);
			expect(output.buttons).toEqual([
				expect.objectContaining({ selector: "#submit", unique: true, label: "Submit" }),
			]);
		}
	});

	it("preserves selector misses as structured failures", async () => {
		const { result, output } = await execute("steel_read", { selector: "#missing" });
		expect(output).toEqual({
			mode: "text",
			sessionId: "session-123",
			truncated: false,
			error: "selector matched nothing",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: "Read failed: selector matched nothing" });
	});

	it.each(["click", "type", "press", "select", "scroll", "wait"])(
		"executes %s actions and reports business state",
		async (action) => {
			const selector =
				action === "click" ? "#submit" : ["type", "select"].includes(action) ? "#field" : undefined;
			const text = action === "press" ? "Enter" : "value";
			const { output } = await execute("steel_act", {
				action,
				...(selector ? { selector } : {}),
				text,
				waitMs: 0,
			});
			expect(output).toMatchObject({ action, selector: selector ?? null, url, summary: expect.any(String) });
			if (action === "click") expect(dom.button.click).toHaveBeenCalled();
			if (action === "type")
				expect(sent).toContainEqual(
					expect.objectContaining({ method: "Input.insertText", params: { text } }),
				);
			if (action === "select") expect(dom.field.value).toBe(text);
		},
	);

	it("rejects missing selectors and selector misses for actions", async () => {
		await expect(execute("steel_act", { action: "click", waitMs: 0 })).rejects.toThrow("requires a selector");
		await expect(execute("steel_act", { action: "click", selector: "#missing", waitMs: 0 })).rejects.toThrow(
			"No element matched",
		);
	});

	it("returns the identical current-page image or withholds oversized bytes", async () => {
		const { result, output } = await execute("steel_look", { fullPage: true });
		expect(output).toMatchObject({
			url,
			bytes: png.length,
			mimeType: "image/png",
			fullPage: true,
			tooLarge: false,
		});
		expect(output.image).toEqual(result.content[1]);
		expect(output.image).toEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
		config.maxInlineImageBytes = 1;
		const large = await execute("steel_look", {});
		expect(large.output).toMatchObject({ bytes: png.length, tooLarge: true });
		expect(large.output).not.toHaveProperty("image");
		expect(large.result.content).toHaveLength(1);
	});

	it("handles unknown current URL without non-JSON values in images or actions", async () => {
		locationFailure = true;
		expect((await execute("steel_look", {})).output).not.toHaveProperty("url");
		expect((await execute("steel_act", { action: "wait", waitMs: 0 })).output).not.toHaveProperty("url");
	});

	it.each(["steel_session", "steel_navigate", "steel_act", "steel_read", "steel_look"])(
		"surfaces session creation failure for %s",
		async (name) => {
			restFailure = "/v1/sessions";
			const params =
				name === "steel_session"
					? { action: "start" }
					: name === "steel_navigate"
						? { url }
						: name === "steel_act"
							? { action: "wait", waitMs: 0 }
							: {};
			await expect(execute(name, params)).rejects.toThrow("mock REST failure");
		},
	);

	it.each([
		["steel_session", "Target.getTargets", { action: "start" }],
		["steel_navigate", "Page.navigate", { url }],
		["steel_act", "Input.dispatchKeyEvent", { action: "press", waitMs: 0 }],
		["steel_read", "Runtime.evaluate", {}],
		["steel_look", "Page.captureScreenshot", {}],
	] as const)("surfaces CDP failure for %s", async (name, method, params) => {
		cdpFailure = method;
		await expect(execute(name, params)).rejects.toThrow("mock CDP failure");
	});
});
