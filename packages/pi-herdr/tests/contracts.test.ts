import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createAssistantMessageEventStream, type Model, type Usage } from "@earendil-works/pi-ai";
import type { NameContext } from "../src/name-from-task.ts";

const mocks = vi.hoisted(() => ({
	dispatch: vi.fn(),
	status: vi.fn(),
	cleanup: vi.fn(),
	read: vi.fn(),
	cli: vi.fn(),
}));
vi.mock("../src/dispatch.ts", async (original) => ({
	...(await original<typeof import("../src/dispatch.ts")>()),
	dispatchHerdrTask: mocks.dispatch,
}));
vi.mock("../src/status.ts", () => ({ getHerdrTaskStatus: mocks.status }));
vi.mock("../src/cleanup.ts", () => ({ cleanupHerdrTask: mocks.cleanup }));
vi.mock("../src/cli.ts", () => ({ herdr: mocks.cli, herdrText: mocks.read }));
vi.mock("../src/config.ts", async (original) => {
	const actual = await original<typeof import("../src/config.ts")>();
	return { ...actual, herdrConfig: async () => actual.defaultConfig };
});
vi.mock("../src/repos.ts", async (original) => ({
	...(await original<typeof import("../src/repos.ts")>()),
	resolveRepo: async () => "/fixture/repo",
}));
const { default: register } = await import("../extensions/herdr.ts");

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("HERDR_ENV", "1");
	vi.stubEnv("HERDR_SOCKET_PATH", "/fixture/not-a-real-socket");
	vi.stubEnv("HERDR_PANE_ID", "fixture-pane");
	mocks.dispatch.mockResolvedValue({
		agentName: "fixture",
		paneId: "p",
		workspaceId: "w",
		worktreePath: "/fixture/worktree",
		branch: "agent/fixture",
		repoPath: "/fixture/repo",
	});
	mocks.status.mockResolvedValue({ status: "working", cwd: "/fixture/worktree" });
	mocks.read.mockResolvedValue("Recent agent output");
	mocks.cli.mockResolvedValue({});
	mocks.cleanup.mockResolvedValue({
		cleaned: true,
		removal: "herdr",
		workspaceId: "w",
		worktreePath: "/fixture/worktree",
	});
});
afterEach(() => vi.unstubAllEnvs());

function harness(naming: NameContext = {}) {
	const tools = new Map<string, ToolDefinition>();
	register({
		on: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
	} as never);
	const ctx = { cwd: "/fixture/repo", model: undefined, ...naming };
	return {
		tools,
		async execute(name: string, params: Record<string, unknown>) {
			const tool = tools.get(name)!;
			const result = await tool.execute("call", params, undefined, undefined, ctx as never);
			expect(Value.Check(tool.outputSchema!, result.structuredContent)).toBe(true);
			return result;
		},
	};
}

describe("native Herdr tool contracts without a real Herdr connection", () => {
	it("returns typed dispatch and transcript data", async () => {
		const h = harness();
		expect(
			(await h.execute("herdr_task", { task: "fixture", name: "fixture" })).structuredContent,
		).toMatchObject({ agentName: "fixture", branch: "agent/fixture" });
		expect((await h.execute("herdr_task_status", { agent: "fixture" })).structuredContent).toMatchObject({
			status: "working",
			output: "Recent agent output",
		});
		for (const tool of h.tools.values()) expect(tool.namespace?.name).toBe("herdr");
		expect(h.tools.get("herdr_task")!.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		});
		expect(h.tools.get("herdr_task_status")!.annotations).toMatchObject({ readOnlyHint: true });
	});

	it.each([false, true])(
		"preserves naming usage when dispatch fails or naming is cancelled (%s)",
		async (cancel) => {
			const controller = new AbortController();
			const sideEffect = vi.fn();
			const model: Model<"openai-completions"> = {
				id: "fixture",
				name: "Fixture",
				provider: "fixture",
				api: "openai-completions",
				baseUrl: "https://fixture.invalid",
				reasoning: false,
				input: ["text"],
				contextWindow: 1000,
				maxTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			const usage: Usage = {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0.25, cacheRead: 0, cacheWrite: 0, total: 0.25 },
			};
			const h = harness({
				model,
				signal: controller.signal,
				modelRegistry: {
					streamSimple: () => {
						const stream = createAssistantMessageEventStream();
						if (cancel) controller.abort(new Error("Cancelled naming"));
						stream.end({
							role: "assistant",
							api: model.api,
							provider: model.provider,
							model: model.id,
							timestamp: 1,
							stopReason: cancel ? "aborted" : "stop",
							content: [{ type: "text", text: "fixture-task" }],
							usage,
						});
						return stream;
					},
				},
			});
			const actual = await vi.importActual<typeof import("../src/dispatch.ts")>("../src/dispatch.ts");
			mocks.dispatch.mockImplementationOnce((input, options) =>
				actual.dispatchHerdrTask(input, {
					...options,
					herdr: async () => {
						sideEffect();
						throw new Error("Dispatch failed after naming");
					},
				}),
			);
			const result = await h.execute("herdr_task", { task: "fixture" });
			expect(result.isError).toBe(true);
			expect(result.usage).toEqual(usage);
			expect(result.structuredContent).toEqual({
				error: cancel ? "Cancelled naming" : "Dispatch failed after naming",
			});
			if (cancel) expect(sideEffect).not.toHaveBeenCalled();
			else expect(sideEffect).toHaveBeenCalled();
		},
	);

	it.each(["gone", "unknown"])("preserves useful %s status results", async (status) => {
		mocks.status.mockResolvedValue({ status, worktreePath: null, note: "Unavailable" });
		const result = await harness().execute("herdr_task_status", { agent: "fixture" });
		expect(result.structuredContent).toMatchObject({ status, output: expect.any(String) });
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("marks unsafe cleanup refusal as an error while preserving its problems", async () => {
		mocks.cleanup.mockResolvedValue({
			cleaned: false,
			problems: ["unpushed commits"],
			workspaceId: "w",
			worktreePath: "/fixture/worktree",
		});
		const result = await harness().execute("herdr_task_cleanup", { agent: "fixture" });
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ cleaned: false, problems: ["unpushed commits"] });
	});

	it.each([12, 60, 80, 120])("renders registered Herdr calls/outcomes at %i columns", (width) => {
		const h = harness();
		const fg = vi.fn((_tone: string, text: string) => `\x1b[32m${text}\x1b[0m`);
		const theme = { fg, bold: (text: string) => text } as unknown as Theme;
		const cases = [
			{
				name: "herdr_task",
				details: { agentName: "Fixture 中文", branch: "agent/fixture", worktreePath: "/tmp/fixture" },
				tone: "accent",
			},
			{ name: "herdr_task_status", details: { status: "working", cwd: "/tmp/fixture" }, tone: "accent" },
			{ name: "herdr_task_status", details: { status: "unknown", note: "Timeout" }, tone: "warning" },
			{
				name: "herdr_task_status",
				details: { status: "gone", matches: ["/tmp/a", "/tmp/b"] },
				tone: "warning",
			},
			{
				name: "herdr_task_cleanup",
				details: { cleaned: false, problems: ["unpushed commits"] },
				tone: "error",
			},
			{ name: "herdr_task_cleanup", details: { cleaned: false, reason: "nothing-found" }, tone: "muted" },
			{ name: "herdr_task_cleanup", details: { cleaned: true, removal: "herdr" }, tone: "success" },
		];
		const body = Array.from({ length: 90 }, (_, index) => `line ${index} 中文`).join("\n");
		for (const fixture of cases) {
			const tool = h.tools.get(fixture.name)!;
			const context = { args: { agent: "Fixture 中文\x1b]0;spoof\x07" }, executionStarted: true } as never;
			const call = tool.renderCall!(
				{ name: "Fixture 中文\x1b]0;spoof\x07", repo: "/tmp/fixture" },
				theme,
				context,
			);
			const result = { content: [{ type: "text" as const, text: body }], details: fixture.details };
			const before = structuredClone(result);
			fg.mockClear();
			const collapsed = tool.renderResult!(result, { expanded: false, isPartial: false }, theme, context);
			expect(collapsed).toBeInstanceOf(Text);
			expect(collapsed.render(width).length).toBeLessThanOrEqual(5);
			expect(fg.mock.calls.map(([tone]) => tone)).toContain(fixture.tone);
			const expanded = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, {
				args: {},
				lastComponent: collapsed,
			} as never);
			expect(expanded).toBe(collapsed);
			const rows = expanded.render(width);
			expect(rows.length).toBeLessThanOrEqual(46);
			for (const row of [...call.render(width), ...rows]) {
				expect(visibleWidth(row)).toBeLessThanOrEqual(width);
				expect(stripTerminalSequences(row)).not.toContain("spoof");
			}
			if (width >= 60) expect(stripTerminalSequences(rows.join("\n"))).toContain("more display rows");
			expect(result).toEqual(before);
		}
		const tool = h.tools.get("herdr_task_status")!;
		const partial = tool.renderResult!(
			{ content: [{ type: "text", text: body }], details: {} },
			{ expanded: true, isPartial: true },
			theme,
			{ args: { agent: "Fixture", wait: true } } as never,
		);
		expect(partial.render(width)).toHaveLength(1);
		if (width >= 60) expect(stripTerminalSequences(partial.render(width)[0]!)).toContain("Waiting");
	});

	it("keeps successful and nothing-to-clean results non-errors", async () => {
		const h = harness();
		expect((await h.execute("herdr_task_cleanup", { agent: "fixture" })).isError).not.toBe(true);
		mocks.cleanup.mockResolvedValue({
			cleaned: false,
			reason: "nothing-found",
			workspaceId: null,
			worktreePath: null,
		});
		expect((await h.execute("herdr_task_cleanup", { agent: "fixture" })).isError).not.toBe(true);
	});
});
