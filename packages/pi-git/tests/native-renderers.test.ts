import { readFileSync } from "node:fs";
import { Theme, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import git from "../extensions/index.ts";
import github from "../../pi-github/extensions/index.ts";
import slack from "../../pi-slack/extensions/index.ts";
import linear from "../../pi-linear/extensions/index.ts";
import notion from "../../pi-notion/extensions/index.ts";

type Context = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
const context = (overrides: Partial<Context> = {}): Context => ({
	args: {},
	toolCallId: "fixture",
	invalidate: vi.fn(),
	lastComponent: undefined,
	state: {},
	cwd: "/fixture",
	executionStarted: true,
	argsComplete: true,
	isPartial: false,
	expanded: false,
	showImages: false,
	isError: false,
	...overrides,
});
// The registered callbacks and native Text/width implementation run unchanged.
// Theme spies expose semantic tokens without depending on a terminal palette.
function palette(name: string | null) {
	const fg = vi.fn((token: string, text: string) => (name === null ? text : `[${name}:${token}]${text}`));
	return { theme: { fg } as unknown as Theme, fg };
}
const tools = new Map<string, ToolDefinition>();
const api = {
	registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
	registerCommand: vi.fn(),
	on: vi.fn(),
} as unknown as ExtensionAPI;
for (const extension of [git, github, slack, linear, notion]) extension(api);
const hostile = "界面👩‍💻 e\u0301\x1b[2K\r\x1b]8;;https://evil\x07text\x1b]8;;\x07\u009b31m\t";
const long = `${hostile}${"漢字".repeat(100)}`;
const body = `BODY-BEGIN\n${long}\nBODY-END`;
const result = (details: Record<string, unknown>, text = body) => ({
	content: [{ type: "text" as const, text }],
	details,
	structuredContent: JSON.parse(JSON.stringify(details)),
});
const many = <T>(row: T) => Array.from({ length: 9 }, () => row);
const file = { path: long, status: "modified", additions: 2, deletions: 1 };
const branch = { name: long, current: true, ahead: 2, behind: 1, upstream: "origin/main" };
const check = { name: long, status: "pending", durationSec: null, summary: body };
const issue = {
	id: "id",
	identifier: "DEV-7",
	number: 7,
	title: long,
	state: "In Progress",
	priority: "high",
	assignee: "Luke",
	team: "DEV",
	url: "https://fixture/7",
	description: body,
	comments: [{ author: hostile, body }],
	labels: ["bug"],
	assignees: ["Luke"],
};
const page = {
	id: "page-id",
	title: long,
	parent: "workspace",
	url: "https://fixture/page",
	blocks: [
		{ type: "paragraph", text: body },
		{ type: "code", source: body, language: "ts" },
		{ type: "table", headers: [long], rows: [[long]] },
		{ type: "unsupported", label: hostile },
	],
	truncated: false,
};
const pull = {
	number: 7,
	title: long,
	author: hostile,
	state: "open",
	review: "approved",
	checks: "passing",
	labels: [],
	assignees: [],
};
const fixtures: Record<string, Record<string, unknown>> = {
	git_status: {
		status: { branch: long, ahead: 2, behind: 1, files: many({ ...file, staged: true }), conflicted: false },
	},
	git_diff: { diff: { files: many(file) } },
	git_branches: { branches: many(branch) },
	git_checklist: { ready: false, checks: many({ name: long, state: "timed out", detail: body }) },
	git_log: { commits: many({ sha: "12345678abcdef", subject: long }) },
	github_prs: { rows: many(pull), repo: "o/r" },
	github_issues: { rows: many(issue), repo: "o/r" },
	github_checks: { rows: many(check), rollup: "pending" },
	github_pr: {
		pr: {
			...pull,
			body,
			branch: "feature",
			baseBranch: "main",
			additions: 2,
			deletions: 1,
			changedFiles: 1,
			url: "https://fixture/pr/7",
			checks: [check],
			reviews: [{ author: "Luke", state: "COMMENTED", body }],
			files: [{ ...file, patch: `+added\n-removed\n${body}`, previousPath: null, patchOmitted: null }],
			mergeable: "blocked",
			filesTruncated: false,
		},
	},
	slack_channels: { rows: many({ name: long, latestText: body, privacy: "private", replyCount: 2 }) },
	slack_search: {
		rows: many({ channelName: long, author: "Luke", text: body, permalink: "https://fixture/thread" }),
	},
	slack_thread: {
		thread: {
			channelName: "eng",
			messages: many({ author: hostile, text: body, root: true }),
			permalink: "https://fixture/thread",
			truncated: false,
		},
	},
	linear_issues: { rows: many(issue) },
	linear_issue: { issue },
	linear_states: { rows: many({ name: long, type: "started" }) },
	notion_search: { rows: many(page) },
	notion_page: { page },
};
const empty: Record<string, Record<string, unknown>> = {
	git_status: { status: { branch: "main", ahead: 0, behind: 0, files: [], conflicted: false } },
	git_diff: { diff: { files: [] } },
	git_branches: { branches: [] },
	git_checklist: { ready: false, checks: [] },
	git_log: { commits: [] },
	github_prs: { rows: [] },
	github_issues: { rows: [] },
	github_checks: { rows: [] },
	slack_channels: { rows: [] },
	slack_search: { rows: [] },
	slack_thread: { thread: { channelName: "eng", messages: [], permalink: "", truncated: false } },
	linear_issues: { rows: [] },
	linear_states: { rows: [] },
	notion_search: { rows: [] },
	notion_page: { page: { ...page, blocks: [] } },
};
function render(
	name: string,
	data: ReturnType<typeof result>,
	expanded = false,
	isPartial = false,
	theme = palette("dark").theme,
	ctx = context(),
) {
	const callback = tools.get(name)?.renderResult;
	expect(callback).toBeTypeOf("function");
	return callback!(data, { expanded, isPartial }, theme, ctx);
}
function bounded(lines: string[], width: number) {
	expect(lines.length).toBeGreaterThan(0);
	for (const line of lines) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(line).not.toMatch(/\x1b\[2K|\x1b\]|\r|\u009b/);
	}
}
describe("registered native integration renderers", () => {
	it("covers all 35 registrations", () => expect(tools.size).toBe(35));
	for (const [name, tool] of tools) {
		it(`${name}: call, collapse, expand, partial, failure, theme and reuse at 60/80/120`, () => {
			const dark = palette("dark");
			const light = palette("light");
			const data = fixtures[name] ?? {
				connected: true,
				posted: true,
				who: "Luke",
				token: "DO-NOT-DISPLAY",
				key: "DO-NOT-DISPLAY",
			};
			const value = result(
				data,
				fixtures[name]
					? body
					: "Connected or posted · Luke\nCredential source: fixture\nAgent: safe metadata",
			);
			const original = structuredClone(value);
			const collapsed = render(name, value, false, false, dark.theme);
			expect(collapsed).toBeInstanceOf(Text);
			const expanded = render(name, value, true, false, dark.theme);
			const partial = render(name, value, false, true, dark.theme);
			const failed = render(
				name,
				{
					...result({ refused: true }, "The user declined. Nothing was posted."),
					isError: true,
				} as ReturnType<typeof result>,
				true,
				false,
				dark.theme,
			);
			for (const width of [60, 80, 120]) {
				const call = tool.renderCall!(
					{
						path: long,
						repo: long,
						issue: long,
						page: long,
						channel: long,
						ref: long,
						token: "DO-NOT-DISPLAY",
						key: "DO-NOT-DISPLAY",
					},
					dark.theme,
					context(),
				);
				bounded(call.render(width), width);
				expect(call.render(width)).toHaveLength(1);
				expect(call.render(width).join("\n")).not.toContain("DO-NOT-DISPLAY");
				for (const component of [collapsed, expanded, partial, failed])
					bounded(component.render(width), width);
				expect(collapsed.render(width).length).toBeLessThanOrEqual(7);
				expect(expanded.render(width).length).toBeLessThanOrEqual(200);
				expect(partial.render(width)[0]).toContain("partial");
				expect(failed.render(width).length).toBeGreaterThan(1);
				expect(failed.render(width)[0]).toContain("error");
				expect(failed.render(width)[0]).not.toMatch(/clean|no changes|ready/);
			}
			expect(dark.fg.mock.calls.map(([token]) => token)).toContain("accent");
			expect(dark.fg.mock.calls.map(([token]) => token)).toContain("warning");
			expect(dark.fg.mock.calls.map(([token]) => token)).toContain("error");
			const reused = render(name, value, true, false, light.theme, context({ lastComponent: collapsed }));
			expect(reused).toBe(collapsed);
			expect(reused.render(80).join("\n")).toContain("light:");
			expect(reused.render(80).join("\n")).not.toContain("dark:");
			expect(reused.render(80).join("\n")).not.toContain("DO-NOT-DISPLAY");
			expect(value).toEqual(original);
			const noData = render(name, result({}, ""));
			expect(noData.render(80)).toHaveLength(1);
			expect(noData.render(80)[0]).toContain("no result data");
			if (empty[name]) {
				const emptyView = render(name, result(empty[name], ""));
				expect(emptyView.render(120).length).toBeLessThanOrEqual(name === "notion_page" ? 2 : 1);
			}
		});
	}
	for (const name of [
		"git_diff",
		"github_pr",
		"slack_thread",
		"slack_search",
		"linear_issue",
		"notion_page",
	]) {
		it(`${name}: expanded body is not the collapsed preview`, () => {
			const lines = render(name, result(fixtures[name]), true).render(120).join("\n");
			expect(lines).toContain("BODY-BEGIN");
			expect(lines).toContain("BODY-END");
		});
	}
	it("expanded errors preserve complete diagnostics and remediation", () => {
		const diagnostic = "DIAGNOSTIC " + "x".repeat(200) + "\nREMEDIATION reconnect safely";
		for (const name of ["git_status", "github_prs", "slack_channels", "linear_issues", "notion_search"]) {
			const view = render(
				name,
				result({ refused: true }, diagnostic),
				true,
				false,
				palette(null).theme,
				context({ isError: true }),
			);
			const rows = view
				.render(60)
				.map((row) => stripTerminalSequences(row).trimEnd())
				.join("\n");
			expect(rows).toContain("REMEDIATION reconnect safely");
			expect(rows.replace(/\s/g, "")).toContain("x".repeat(200));
		}
	});

	it("expanded mutation results preserve the full first-line URL", () => {
		const url = "https://fixture.invalid/" + "a".repeat(240);
		for (const name of ["github_comment", "slack_post", "linear_comment", "notion_append"]) {
			const rows = render(
				name,
				result({ posted: true }, `Posted: ${url}`),
				true,
				false,
				palette(null).theme,
			).render(60);
			expect(
				rows
					.map((row) => stripTerminalSequences(row).trimEnd())
					.join("")
					.replace(/\s/g, ""),
			).toContain(url);
		}
	});

	it("expanded PR detail retains merge blockers", () => {
		const pr = {
			...(fixtures.github_pr.pr as Record<string, unknown>),
			mergeable: "behind the base branch",
			checks: [],
			files: [],
			reviews: [],
		};
		const rows = render("github_pr", result({ pr }), true, false, palette(null).theme)
			.render(80)
			.map(stripTerminalSequences)
			.join("\n");
		expect(rows).toContain("cannot merge: behind the base branch");
	});

	it("real native palettes re-theme reused Text components and preserve visible bounds", () => {
		const json = JSON.parse(
			readFileSync(
				new URL(
					"../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json",
					import.meta.url,
				),
				"utf8",
			),
		) as { colors: Record<string, unknown> };
		const nativePalette = (color: string) => {
			const colors = Object.fromEntries(Object.keys(json.colors).map((key) => [key, color]));
			return new Theme(
				colors as ConstructorParameters<typeof Theme>[0],
				colors as ConstructorParameters<typeof Theme>[1],
				"truecolor",
			);
		};
		const dark = nativePalette("#123456");
		const light = nativePalette("#abcdef");
		for (const name of tools.keys()) {
			const value = result(fixtures[name] ?? { connected: true }, "Connected · Luke");
			const view = render(name, value, false, false, dark);
			const before = view.render(80).join("\n");
			const reused = render(name, value, false, false, light, context({ lastComponent: view }));
			expect(reused).toBe(view);
			expect(reused.render(80).join("\n")).not.toEqual(before);
			for (const width of [10, 60, 80, 120]) bounded(reused.render(width), width);
		}
	});
	it("provider truncation is partial even after execution ends", () => {
		for (const [name, field] of [
			["github_prs", "truncated"],
			["slack_search", "truncated"],
			["notion_search", "truncated"],
		]) {
			const lines = render(name, result({ ...fixtures[name], [field]: true })).render(120);
			expect(lines[0]).toContain("partial");
			expect(lines[0]).toContain("more available");
		}
	});
	it("context errors win over success-shaped details", () => {
		for (const name of tools.keys()) {
			const view = render(
				name,
				result(fixtures[name] ?? { posted: true }, "execution failed"),
				false,
				false,
				palette("dark").theme,
				context({ isError: true }),
			);
			expect(view.render(80)).toHaveLength(1);
			expect(view.render(80)[0]).toContain("error");
		}
	});
	it("a real local git refusal cannot become a fake clean status", async () => {
		const tool = tools.get("git_status")!;
		const value = await tool.execute(
			"refusal",
			{ path: "/definitely-not-a-repository" },
			new AbortController().signal,
			undefined,
			{ cwd: "/definitely-not-a-repository" } as Parameters<typeof tool.execute>[4],
		);
		const lines = render("git_status", value as ReturnType<typeof result>).render(120);
		expect(stripTerminalSequences(lines.join("\n"))).toContain("not inside a git repository");
		expect(lines.join("\n")).not.toContain("clean");
	});
});
