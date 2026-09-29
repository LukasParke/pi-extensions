import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
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
