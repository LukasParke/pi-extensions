import {
	Theme,
	ToolExecutionComponent,
	initTheme,
	type ExtensionAPI,
	type ToolDefinition,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import registerSteel from "../extensions/steel.ts";
import registerSession from "../extensions/steel-session.ts";
import registerFirecrawl from "../../pi-firecrawl/extensions/firecrawl.ts";
import registerSearch from "../../pi-file-search/extensions/file-search.ts";
import registerErrorLog from "../../pi-error-log/extensions/error-log.ts";

const tools = new Map<string, ToolDefinition>();
const api = {
	registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
	registerCommand: vi.fn(),
	on: vi.fn(),
} as unknown as ExtensionAPI;
for (const register of [registerSteel, registerSession, registerFirecrawl, registerSearch, registerErrorLog])
	register(api);

const palette = {
	text: "#dddddd",
	thinkingXhigh: "#1188ff",
	accent: "#1188ff",
	toolTitle: "#dddddd",
	muted: "#888888",
	toolOutput: "#aaaaaa",
	success: "#11bb44",
	warning: "#ffbb11",
	error: "#ff2244",
};
const background = { selectedBg: "#111111" } as ConstructorParameters<typeof Theme>[1];
const theme = new Theme(palette as ConstructorParameters<typeof Theme>[0], background, "truecolor");
const alternate = new Theme(
	Object.fromEntries(Object.keys(palette).map((key) => [key, "#123456"])) as ConstructorParameters<
		typeof Theme
	>[0],
	background,
	"truecolor",
);
type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
const context = (args: unknown = {}, overrides: Partial<RenderContext> = {}): RenderContext => ({
	args,
	toolCallId: "fixture",
	invalidate: vi.fn(),
	lastComponent: undefined,
	state: {},
	cwd: "/work",
	executionStarted: true,
	argsComplete: true,
	isPartial: false,
	expanded: false,
	showImages: true,
	isError: false,
	...overrides,
});
const text = (value: string, details: unknown = {}) => ({
	content: [{ type: "text" as const, text: value }],
	details,
});
const entry = {
	ts: "2026-09-29T12:00:00Z",
	cwd: "/work",
	kind: "tool",
	tool: "rg",
	args: '{"token":"[REDACTED]","pattern":"中文"}',
	error: {
		message: "Failed to read 中文\npermission denied",
		stack: "Error: denied\n  at search (/work/search.ts:10)",
	},
};
const hostile = "中文\x1b[2K\r\x1b]8;;https://evil.invalid\x07visible\x1b]8;;\x07\x00\x9b2J";
const target = `https://example.invalid/${"中文/".repeat(24)}`;

interface Fixture {
	name: string;
	state: string;
	args?: Record<string, unknown>;
	result: ReturnType<typeof text>;
	tone: ThemeColor;
	label: string;
	partial?: boolean;
	error?: boolean;
}
const fixtures: Fixture[] = [
	{
		name: "steel_scrape",
		state: "page",
		args: { url: target },
		result: text("# 中文 page\nurl: https://example.invalid\n\n## markdown\nReadable 中文 body", {
			formats: ["markdown"],
		}),
		tone: "success",
		label: "Done",
	},
	{
		name: "steel_search",
		state: "results",
		args: { query: "中文 browser" },
		result: text("1. 中文 title\n   https://example.invalid\n   description", { count: 1 }),
		tone: "success",
		label: "Done",
	},
	{
		name: "steel_search",
		state: "no results",
		result: text('No results for "中文".', { count: 0 }),
		tone: "muted",
		label: "Empty",
	},
	{
		name: "steel_scrape",
		state: "empty",
		result: text("url: https://example.invalid", { formats: [] }),
		tone: "muted",
		label: "Empty",
	},
	{
		name: "steel_pdf",
		state: "saved PDF",
		result: text("PDF of https://example.invalid written to /tmp/page.pdf (10 KB).", {
			file: "/tmp/page.pdf",
			bytes: 10240,
		}),
		tone: "success",
		label: "Done",
	},
	{
		name: "steel_screenshot",
		state: "saved image",
		result: text("Screenshot saved to /tmp/shot.png (too large to inline).", {
			file: "/tmp/shot.png",
			bytes: 10240,
			mimeType: "image/png",
		}),
		tone: "warning",
		label: "Limited",
	},
	{
		name: "steel_look",
		state: "too large",
		result: text("Screenshot is 10 MB, too large to inline. Try fullPage:false or scope with steel_read."),
		tone: "warning",
		label: "Limited",
	},
	{
		name: "steel_session",
		state: "closed",
		args: { action: "end" },
		result: text("Released Steel session session-123.", { action: "end", released: "session-123" }),
		tone: "muted",
		label: "Closed",
	},
	{
		name: "steel_session",
		state: "ready",
		args: { action: "start" },
		result: text("Steel session session-123 is live.\nWatch it: https://viewer.invalid/session-123", {
			action: "start",
			id: "session-123",
		}),
		tone: "success",
		label: "Done",
	},
	{
		name: "steel_navigate",
		state: "progress",
		args: { url: target },
		result: text("Loading page"),
		partial: true,
		tone: "accent",
		label: "Active",
	},
	{
		name: "steel_act",
		state: "waiting",
		args: { action: "wait" },
		result: text("Settling"),
		partial: true,
		tone: "warning",
		label: "Waiting",
	},
	{
		name: "steel_act",
		state: "done",
		args: { action: "type", selector: "#password", text: "DO_NOT_RENDER_PASSWORD" },
		result: text("Typed 8 chars into #password. Now at https://example.invalid.", {
			action: "type",
			selector: "#password",
		}),
		tone: "success",
		label: "Done",
	},
	{
		name: "steel_read",
		state: "selector failure",
		result: text("Read failed: selector matched nothing"),
		error: true,
		tone: "error",
		label: "Failed",
	},
	{
		name: "steel_scrape",
		state: "capped",
		result: text("# page\nbody\n\n[truncated — full 2 MB output: /tmp/full.txt]"),
		tone: "warning",
		label: "Limited",
	},
	{
		name: "firecrawl_scrape",
		state: "empty",
		result: text("(no content returned)"),
		tone: "muted",
		label: "Empty",
	},
	{
		name: "firecrawl_search",
		state: "no results",
		result: text("No results found.", { data: [] }),
		tone: "muted",
		label: "Empty",
	},
	{
		name: "firecrawl_map",
		state: "URLs",
		args: { url: target },
		result: text("Found 2 URL(s):\n\nhttps://example.invalid/中文\nhttps://example.invalid/docs", {
			links: ["https://example.invalid/中文", "https://example.invalid/docs"],
		}),
		tone: "success",
		label: "Done",
	},
	{
		name: "firecrawl_crawl",
		state: "progress",
		args: { url: target },
		result: text("Crawl scraping: 1/8 pages", { status: "scraping", completed: 1, total: 8 }),
		partial: true,
		tone: "accent",
		label: "Active",
	},
	{
		name: "firecrawl_crawl",
		state: "waiting",
		result: text("Crawl queued: 0/? pages", { status: "queued", completed: 0, total: null }),
		partial: true,
		tone: "warning",
		label: "Waiting",
	},
	{
		name: "firecrawl_crawl",
		state: "timeout with pages",
		result: text(
			"Crawled 1 page(s) (status: scraping).\n\n### 1. 中文 page\nhttps://example.invalid\n\nPartial body",
			{ status: "scraping", completed: 1, total: 8, data: [{}] },
		),
		tone: "warning",
		label: "Partial / timeout",
	},
	{
		name: "firecrawl_crawl",
		state: "failed with pages",
		result: text("Crawled 1 page(s) (status: failed).\nPartial body", {
			status: "failed",
			completed: 1,
			total: 8,
			data: [{}],
			error: "denied",
		}),
		error: true,
		tone: "error",
		label: "Failed",
	},
	{
		name: "firecrawl_crawl",
		state: "complete empty",
		result: text("Crawled 0 page(s) (status: completed).", {
			status: "completed",
			completed: 0,
			total: 0,
			data: [],
		}),
		tone: "muted",
		label: "Empty",
	},
	{
		name: "firecrawl_scrape",
		state: "refused",
		result: text("Access refused: configuration required", {
			refused: true,
			error: "configuration required",
		}),
		error: true,
		tone: "error",
		label: "Refused",
	},
	{
		name: "fd",
		state: "paths",
		args: { pattern: "中文", path: "/work/中文" },
		result: text("src/中文.ts\nsrc/other.ts", { matches: 2, notes: [] }),
		tone: "success",
		label: "Done",
	},
	{
		name: "fd",
		state: "no results",
		result: text("No files found", { matches: 0, notes: [] }),
		tone: "muted",
		label: "Empty",
	},
	{
		name: "rg",
		state: "partial and capped",
		args: { pattern: "中文", path: "/work" },
		result: text(
			"src/中文.ts-9-before\nsrc/中文.ts:10:中文\nsrc/中文.ts-11-after\n--\nother.ts:1:中文\n\n[truncated: Full results: /tmp/full.txt]\n\n[note: some paths were unreadable; results may be incomplete]",
			{
				matches: 5000,
				partial: true,
				truncated: true,
				file: "/tmp/full.txt",
				notes: ["some paths were unreadable; results may be incomplete"],
			},
		),
		tone: "warning",
		label: "Partial",
	},
	{
		name: "rg",
		state: "failed",
		result: text("rg failed: invalid regular expression"),
		error: true,
		tone: "error",
		label: "Failed",
	},
	{
		name: "error_log",
		state: "errors",
		args: { tool: "rg", since: "2h" },
		result: text("5 error(s) from /tmp/errors.jsonl", {
			path: "/tmp/errors.jsonl",
			entries: Array.from({ length: 5 }, () => entry),
		}),
		tone: "success",
		label: "Ready",
	},
	{
		name: "error_log",
		state: "disabled",
		result: text("Error log is disabled (error-log.enabled = false).", { entries: [] }),
		tone: "warning",
		label: "Disabled",
	},
	{
		name: "error_log",
		state: "empty",
		result: text("No matching errors in /tmp/errors.jsonl.", { path: "/tmp/errors.jsonl", entries: [] }),
		tone: "muted",
		label: "Empty",
	},
];

function renderer(fixture: Fixture, expanded = false, lastComponent?: Component, nativeTheme = theme) {
	const def = tools.get(fixture.name)!;
	return def.renderResult!(
		fixture.result,
		{ expanded, isPartial: fixture.partial ?? false },
		nativeTheme,
		context(fixture.args, {
			expanded,
			isPartial: fixture.partial ?? false,
			isError: fixture.error ?? false,
			lastComponent,
		}),
	);
}

describe("registered native browser/search/log renderers", () => {
	it("all 16 tools register native callbacks without starting browser or network work", () => {
		expect(tools.size).toBe(16);
		for (const def of tools.values()) {
			expect(def.renderCall).toBeTypeOf("function");
			expect(def.renderResult).toBeTypeOf("function");
			if (["steel_session", "steel_navigate", "steel_act", "steel_read", "steel_look"].includes(def.name))
				expect(def.executionMode).toBe("sequential");
		}
	});
	for (const fixture of fixtures) {
		it(`${fixture.name}: ${fixture.state} native state/width snapshots`, () => {
			const before = JSON.stringify(fixture.result);
			const snapshot: Record<string, string[]> = {};
			for (const width of [1, 10, 60, 80, 120]) {
				const call = tools.get(fixture.name)!.renderCall!(fixture.args ?? {}, theme, context(fixture.args));
				expect(call).toBeInstanceOf(Text);
				const callRows = call.render(width);
				expect(callRows).toHaveLength(1);
				expect(callRows.join("\n")).not.toContain("DO_NOT_RENDER_PASSWORD");
				for (const expanded of [false, true]) {
					const component = renderer(fixture, expanded);
					expect(component).toBeInstanceOf(Text);
					const rows = component.render(width);
					for (const row of [...callRows, ...rows]) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
					if (!expanded) expect(rows.length).toBeLessThanOrEqual(5);
					if (width >= 60)
						snapshot[`${width} ${expanded ? "expanded" : "collapsed"}`] = [...callRows, ...rows].map(
							stripTerminalSequences,
						);
				}
			}
			expect(snapshot).toMatchSnapshot();
			const first = renderer(fixture).render(120)[0]!;
			expect(stripTerminalSequences(first)).toContain(fixture.label);
			expect(first).toContain(theme.getFgAnsi(fixture.tone));
			expect(JSON.stringify(fixture.result)).toBe(before);
		});
	}
	it("reuses lastComponent through progress/completion/expansion/theme changes", () => {
		for (const name of ["steel_navigate", "firecrawl_crawl", "rg", "error_log"]) {
			const fixture = fixtures.find((f) => f.name === name)!;
			const component = renderer({ ...fixture, partial: true });
			expect(component.render(80)).toHaveLength(1);
			const updated = renderer({ ...fixture, partial: false }, true, component, alternate);
			expect(updated).toBe(component);
			updated.invalidate();
			expect(updated.render(80)[0]).toContain(alternate.getFgAnsi(fixture.tone));
			expect(updated.render(80)[0]).not.toContain(theme.getFgAnsi(fixture.tone));
		}
	});
	it("sanitizes terminal controls in every family without stripping CJK", () => {
		for (const name of ["steel_read", "firecrawl_scrape", "rg", "error_log"]) {
			const fixture: Fixture = {
				name,
				state: "hostile",
				args: { url: hostile, pattern: hostile, tool: hostile },
				result: text(
					hostile,
					name === "error_log"
						? {
								entries: [
									{ ...entry, tool: hostile, error: { message: hostile, stack: hostile }, args: hostile },
								],
							}
						: { matches: 1 },
				),
				tone: "success",
				label: "Done",
			};
			const rows = renderer(fixture, true).render(120);
			const call = tools.get(name)!.renderCall!(fixture.args, theme, context(fixture.args)).render(120);
			const plainRows = [...call, ...rows].map(stripTerminalSequences).join("\n");
			expect(plainRows).toContain("中文");
			expect(plainRows).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
			expect([...call, ...rows].join("\n")).not.toContain("\x1b[2K");
			expect([...call, ...rows].join("\n")).not.toContain("\x1b]8");
		}
	});
	it("keeps an unpolled crawl timeout visibly partial rather than completed", () => {
		const fixture: Fixture = {
			name: "firecrawl_crawl",
			state: "unpolled",
			result: text("Crawl still scraping after timeout. Returning partial results.", {
				success: true,
				id: "job-fixture",
			}),
			tone: "warning",
			label: "Partial / timeout",
		};
		const rows = renderer(fixture).render(80).map(stripTerminalSequences).join("\n");
		expect(rows).toContain("Partial / timeout");
		expect(rows).not.toContain("Done");
	});

	it("page content cannot shadow the final generated full-output pointer", () => {
		const file = "/tmp/genuine-full-output.txt";
		const content = [
			"Page content says use steel_read",
			...Array.from({ length: 80 }, (_, index) => `Page line ${index}`),
			`[truncated — full 100kB output: ${file}]`,
		].join("\n");
		const fixture: Fixture = {
			name: "steel_scrape",
			state: "truncated",
			result: text(content, { formats: ["markdown"] }),
			tone: "warning",
			label: "Limited",
		};
		for (const expanded of [false, true])
			expect(renderer(fixture, expanded).render(80).map(stripTerminalSequences).join("\n")).toContain(file);
	});

	it("keeps context separators, partial I/O notes and full-output pointers visible", () => {
		const fixture = fixtures.find((f) => f.name === "rg" && f.state === "partial and capped")!;
		const expanded = renderer(fixture, true)
			.render(120)
			.map((row) => stripTerminalSequences(row).trimEnd())
			.join("\n");
		expect(expanded).toContain("src/中文.ts-9-before\nsrc/中文.ts:10:中文\nsrc/中文.ts-11-after\n--");
		for (const expand of [false, true]) {
			const rows = renderer(fixture, expand).render(120).map(stripTerminalSequences).join("\n");
			expect(rows).toContain("some paths were unreadable");
			expect(rows).toContain("Full results: /tmp/full.txt");
		}
	});
	it("bounds expanded output after wrapping and leaves overflow plus artifact pointers", () => {
		for (const name of ["steel_scrape", "firecrawl_scrape", "rg", "error_log"]) {
			const long = Array.from({ length: 100 }, (_, i) => `line ${i} 中文 ${"wide 中文 ".repeat(12)}`).join(
				"\n",
			);
			const fixture: Fixture = {
				name,
				state: "long",
				result: text(
					`${long}\n[truncated — full 2 MB output: /tmp/full.txt]`,
					name === "error_log"
						? { path: "/tmp/errors.jsonl", entries: [{ ...entry, error: { message: long } }] }
						: { matches: 100, file: "/tmp/full.txt" },
				),
				tone: "success",
				label: "Done",
			};
			const rows = renderer(fixture, true).render(60).map(stripTerminalSequences);
			expect(rows.length).toBeLessThanOrEqual(43);
			expect(rows.some((row) => row.includes("more display rows"))).toBe(true);
			if (name !== "firecrawl_scrape") expect(rows.at(-1)).toContain("/tmp/");
		}
	});
	it("expands stored log args and stack without changing redaction", () => {
		const fixture = fixtures.find((f) => f.name === "error_log" && f.state === "errors")!;
		const expanded = renderer(fixture, true)
			.render(120)
			.map((row) => stripTerminalSequences(row).trimEnd())
			.join("\n");
		expect(expanded).toContain('Args: {"token":"[REDACTED]","pattern":"中文"}');
		expect(expanded).toContain("Stack:\nError: denied\n  at search (/work/search.ts:10)");
		expect(renderer(fixture).render(120).map(stripTerminalSequences).join("\n")).not.toContain("Args:");
	});
	it("leaves image delivery to the native tool shell and renders only image metadata", () => {
		const image = { type: "image" as const, data: "IMAGE_BYTES_UNCHANGED", mimeType: "image/png" };
		const result = {
			content: [{ type: "text" as const, text: "Current page: https://example.invalid (10 B)" }, image],
			details: { bytes: 10 },
		};
		const def = tools.get("steel_look")!;
		for (const showImages of [true, false]) {
			const component = def.renderResult!(
				result,
				{ expanded: true, isPartial: false },
				theme,
				context({}, { showImages }),
			);
			const rows = component.render(120).map(stripTerminalSequences).join("\n");
			expect(rows).toContain(`Image · image/png · inline display ${showImages ? "enabled" : "hidden"}`);
			expect(rows).not.toContain(image.data);
		}
		expect(result.content[1]).toBe(image);
	});
	it("native ToolExecutionComponent uses callbacks with details-only results and survives invalidation", () => {
		initTheme("dark", false);
		const fixture = fixtures.find((f) => f.name === "firecrawl_crawl" && f.state === "progress")!;
		const shell = new ToolExecutionComponent(
			fixture.name,
			"native",
			fixture.args,
			{ showImages: false },
			tools.get(fixture.name),
			{ requestRender: vi.fn() } as unknown as TUI,
			"/work",
		);
		shell.markExecutionStarted();
		shell.setArgsComplete();
		shell.updateResult({ ...fixture.result, isError: false }, true);
		for (const width of [60, 80, 120]) {
			const rows = shell.render(width);
			expect(rows.map(stripTerminalSequences).join("\n")).toContain("Active · scraping · 1/8 pages");
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
		shell.updateResult(
			{
				...text("Crawled 1 page(s) (status: completed).", {
					status: "completed",
					completed: 1,
					total: 1,
					data: [{}],
				}),
				isError: false,
			},
			false,
		);
		shell.setExpanded(true);
		shell.invalidate();
		expect(shell.render(80).map(stripTerminalSequences).join("\n")).toContain("Done · completed · 1/1 pages");
	});
});
