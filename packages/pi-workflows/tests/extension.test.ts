import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { emptyUsage } from "../src/subagent-sdk.ts";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../src/runner.ts", async (original) => ({
	...(await original<typeof import("../src/runner.ts")>()),
	executeWorkflow: mocks.execute,
}));
vi.mock("../src/config.ts", async (original) => {
	const actual = await original<typeof import("../src/config.ts")>();
	return { ...actual, workflowConfig: async () => ({ ...actual.defaultConfig, approval: "never" }) };
});
const { default: register } = await import("../extensions/workflows.ts");
let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workflow-native-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", path.join(dir, "agent"));
	mocks.execute.mockImplementation(async (options) => ({
		runId: options.runId,
		state: "completed",
		result: 42,
		executionUsage: { ...emptyUsage(), input: 10, output: 5, cost: 0.001 },
		usage: { ...emptyUsage(), input: 100, output: 50, cost: 0.01 },
		summary: {
			runId: options.runId,
			label: "fixture",
			state: "completed",
			startedAt: 1,
			endedAt: 2,
			agentCount: 1,
			completedAgents: 1,
			failedAgents: 0,
			usage: { ...emptyUsage(), input: 100, output: 50, cost: 0.01 },
			artifactPath: dir,
		},
	}));
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await fs.rm(dir, { recursive: true, force: true });
});

async function harness() {
	const handlers = new Map<string, Function[]>();
	const messages: unknown[] = [];
	let tool!: ToolDefinition;
	await register({
		on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
		registerCommand: vi.fn(),
		registerEntryRenderer: vi.fn(),
		registerMessageRenderer: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: () => [],
		sendMessage: (message: unknown) => messages.push(message),
	} as never);
	const ctx = {
		cwd: dir,
		hasUI: false,
		sessionManager: { getSessionFile: () => "fixture" },
		ui: {
			setWidget: vi.fn(),
			setStatus: vi.fn(),
			notify: vi.fn(),
			theme: { fg: (_color: string, text: string) => text },
		},
	};
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	return {
		tool,
		messages,
		execute: (params: Record<string, unknown>) =>
			tool.execute("call", params, undefined, undefined, ctx as never),
		shutdown: async () => {
			for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
		},
	};
}

describe("native workflow accounting", () => {
	it.each([false, true])("reports fresh execution usage once for background=%s", async (background) => {
		const h = await harness();
		try {
			const started = await h.execute({ script: "return 42;", async: background });
			const id = (started.details as { runId: string }).runId;
			if (background) await vi.waitFor(() => expect(h.messages).toHaveLength(1));
			const delivered = background ? await h.execute({ action: "wait", id }) : started;
			expect(delivered.usage?.cost.total).toBeCloseTo(0.001, 10);
			expect(delivered.usage?.totalTokens).toBe(15);
			expect((await h.execute({ action: "wait", id })).usage).toBeUndefined();
			expect(h.tool.exposure).toBe("model-only");
		} finally {
			await h.shutdown();
		}
	});

	it("delivers delayed cancellation usage from the real executor exactly once", async () => {
		const actual = await vi.importActual<typeof import("../src/runner.ts")>("../src/runner.ts");
		let began!: () => void;
		const childStarted = new Promise<void>((resolve) => {
			began = resolve;
		});
		mocks.execute.mockImplementationOnce((options) =>
			actual.executeWorkflow({
				...options,
				runAgent: async (_spec, signal) => {
					began();
					await new Promise<void>((resolve) => {
						signal.addEventListener(
							"abort",
							() => {
								setTimeout(resolve, 200);
							},
							{ once: true },
						);
					});
					return { ok: false, output: "Paid cleanup", usage: { ...emptyUsage(), input: 2, cost: 0.25 } };
				},
			}),
		);
		const h = await harness();
		try {
			const started = await h.execute({
				script: 'return await agent("long", { isolation: "worktree" });',
				async: true,
			});
			const id = (started.details as { runId: string }).runId;
			await childStarted;
			await h.execute({ action: "cancel", id });
			const first = await h.execute({ action: "wait", id });
			expect(first.usage?.cost.total).toBeCloseTo(0.25, 10);
			expect(first.details).toMatchObject({ state: "cancelled" });
			expect((await h.execute({ action: "wait", id })).usage).toBeUndefined();
		} finally {
			await h.shutdown();
		}
	});

	it("keeps usage and failure details on native error results", async () => {
		const original = mocks.execute.getMockImplementation()!;
		mocks.execute.mockImplementationOnce(async (options) => {
			const value = await original(options);
			return {
				...value,
				state: "failed",
				failure: "fixture failed",
				summary: { ...value.summary, state: "failed", failure: "fixture failed" },
			};
		});
		const h = await harness();
		try {
			const failed = await h.execute({ script: "return 42;", async: false });
			expect(failed.isError).toBe(true);
			expect(failed.usage?.cost.total).toBeCloseTo(0.001, 10);
			expect(failed.details).toMatchObject({ state: "failed" });
		} finally {
			await h.shutdown();
		}
	});
});
