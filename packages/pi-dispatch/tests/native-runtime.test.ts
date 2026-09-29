import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import {
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	type AssistantMessage,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createCodemodeExtension,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSessionRuntime,
	type ExtensionAPI,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { dispatchQueue, ensureDelivery, resetDispatchForTests } from "../src/index.ts";

let dir: string;
const runtimes: AgentSessionRuntime[] = [];
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-native-runtime-"));
	resetDispatchForTests();
});
afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
	resetDispatchForTests();
	await fs.rm(dir, { recursive: true, force: true });
});

function usage(cost = 0): Usage {
	return {
		input: cost ? 1 : 0,
		output: cost ? 2 : 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: cost ? 3 : 0,
		cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

async function runtimeFor(factories: ExtensionFactory[], code?: string) {
	const agentDir = path.join(dir, "agent");
	const models = await ModelRuntime.create({
		authPath: path.join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: path.join(agentDir, "models-store.json"),
		refreshOnCreate: false,
	});
	let request = 0;
	models.registerProvider("native-fixture", {
		baseUrl: "https://fixture.invalid",
		apiKey: "fixture-only",
		api: "native-fixture",
		models: [
			{
				id: "fixture",
				name: "Fixture",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_000,
				maxTokens: 1024,
			},
		],
		streamSimple: (model) => {
			const calling = code !== undefined && request++ === 0;
			const message: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: calling
					? [{ type: "toolCall", id: "outer", name: "codemode", arguments: { code } }]
					: [{ type: "text", text: "Finished fixture" }],
				stopReason: calling ? "toolUse" : "stop",
				timestamp: Date.now(),
				usage: usage(),
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: { ...message, stopReason: "pending" } });
			stream.push({ type: "done", reason: calling ? "toolUse" : "stop", message });
			stream.end();
			return stream;
		},
	});
	const runtime = await createAgentSessionRuntime(
		async (options) => {
			const services = await createAgentSessionServices({
				cwd: options.cwd,
				agentDir,
				modelRuntime: models,
				settingsManager: SettingsManager.inMemory({
					compaction: { enabled: false },
					retry: { enabled: false },
					defaultTools: ["+codemode"],
				}),
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					systemPrompt: "Owner fixture instruction",
					extensionFactories: factories,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager: options.sessionManager,
					sessionStartEvent: options.sessionStartEvent,
					model: models.getModel("native-fixture", "fixture")!,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		},
		{ cwd: dir, agentDir, sessionManager: SessionManager.inMemory(dir) },
	);
	runtimes.push(runtime);
	runtime.setRebindSession(async (session) => {
		await session.bindExtensions({ mode: "json" });
	});
	await runtime.session.bindExtensions({ mode: "json" });
	return runtime;
}

describe("native Pi 0.99 host contracts", () => {
	it("rewires shared dispatch on real SDK session replacement and invalidates the old API", async () => {
		const apis: ExtensionAPI[] = [];
		const wire: ExtensionFactory = (pi) => {
			apis.push(pi);
			ensureDelivery(pi);
		};
		const runtime = await runtimeFor([wire, wire]);
		const previous = runtime.session;
		dispatchQueue().publish({
			id: "first",
			source: "fixture",
			priority: "info",
			urgency: "next-turn",
			message: "First runtime",
		});
		await vi.waitFor(
			() => expect(previous.messages.some((message) => message.role === "custom")).toBe(true),
			{ timeout: 4000 },
		);
		await runtime.newSession();
		expect(apis).toHaveLength(4);
		expect(() => apis[0]!.sendMessage({ customType: "fixture", content: "stale", display: false })).toThrow();
		dispatchQueue().publish({
			id: "second",
			source: "fixture",
			priority: "info",
			urgency: "next-turn",
			message: "Replacement runtime",
		});
		await vi.waitFor(
			() => expect(runtime.session.messages.some((message) => message.role === "custom")).toBe(true),
			{ timeout: 4000 },
		);
		const delivered = runtime.session.messages.filter((message) => message.role === "custom");
		expect(delivered).toHaveLength(1);
		expect(JSON.stringify(delivered)).toContain("Replacement runtime");
		expect(JSON.stringify(delivered)).not.toContain("First runtime");
	}, 15_000);

	it("runs native codemode with structured errors, permissions, parent attribution, and exact nested usage", async () => {
		const executed = vi.fn();
		let sentPrompt = "";
		let concurrent = 0;
		let peakConcurrent = 0;
		const nested: { parent?: string; name: string }[] = [];
		const fixtures: ExtensionFactory = (pi) => {
			pi.on("context_with_system", (event) => {
				sentPrompt = getCurrentSystemPrompt(event.messages);
			});
			pi.on("before_agent_start", (event) => {
				event.systemPromptOptions.sections.fixture_policy = "Native fixture policy";
			});
			pi.registerTool({
				name: "fixture_data",
				label: "Data",
				description: "Fixture data",
				parameters: Type.Object({}),
				outputSchema: Type.Object({ value: Type.Number() }),
				namespace: { name: "fixtures" },
				annotations: { readOnlyHint: true },
				execute: async () => ({
					content: [{ type: "text", text: "Readable fixture data" }],
					details: {},
					structuredContent: { value: 42 },
					usage: usage(0.25),
				}),
			});
			pi.registerTool({
				name: "fixture_failure",
				label: "Failure",
				description: "Failure with data",
				parameters: Type.Object({}),
				outputSchema: Type.Object({ error: Type.String() }),
				execute: async () => ({
					content: [{ type: "text", text: "Expected failure" }],
					details: {},
					structuredContent: { error: "Expected failure" },
					isError: true,
					usage: usage(0.5),
				}),
			});
			pi.registerTool({
				name: "fixture_blocked",
				label: "Blocked",
				description: "Must not execute",
				parameters: Type.Object({}),
				execute: async () => {
					executed();
					return { content: [{ type: "text", text: "Wrong" }], details: {} };
				},
			});
			pi.registerTool({
				name: "fixture_model_only",
				label: "Model only",
				description: "Not callable from scripts",
				exposure: "model-only",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "Model only" }], details: {} }),
			});
			pi.registerTool({
				name: "fixture_sequence",
				label: "Sequential",
				description: "Shared state fixture",
				executionMode: "sequential",
				parameters: Type.Object({}),
				execute: async () => {
					concurrent++;
					peakConcurrent = Math.max(peakConcurrent, concurrent);
					await new Promise((resolve) => setTimeout(resolve, 10));
					concurrent--;
					return { content: [{ type: "text", text: "Sequential fixture" }], details: {} };
				},
			});
			pi.on("tool_call", (event) => {
				if (event.toolName === "fixture_blocked") return { block: true, reason: "Blocked fixture" };
			});
			pi.on("tool_execution_start", (event) => {
				if (event.parentToolCallId) nested.push({ parent: event.parentToolCallId, name: event.toolName });
			});
		};
		const runtime = await runtimeFor(
			[fixtures, createCodemodeExtension({ models: false })],
			`
			const data = await tools.fixture_data({});
			const failed = await tools.fixture_failure({});
			const blocked = await Promise.allSettled([tools.fixture_blocked({})]);
			await Promise.all([tools.fixture_sequence({}), tools.fixture_sequence({})]);
			return { value: data.value, error: failed.error, blocked: blocked[0].status, modelOnlyVisible: ALL_TOOLS.some(t => t.name === "fixture_model_only") };
		`,
		);
		await runtime.session.prompt("Run the local fixture");
		expect(runtime.session.systemPrompt).toContain("Owner fixture instruction");
		expect(sentPrompt).toContain("Owner fixture instruction");
		expect(sentPrompt).toContain("<fixture_policy>\nNative fixture policy\n</fixture_policy>");
		const results = runtime.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(results[0]!.toolName).toBe("codemode");
		expect(results[0]!.isError).toBe(false);
		expect(results[0]!.usage?.cost.total).toBeCloseTo(0.75, 10);
		expect(results[0]!.usage?.totalTokens).toBe(6);
		const text = results[0]!.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(text).toMatch(/"value"\s*:\s*42/);
		expect(text).toContain("Expected failure");
		expect(text).toMatch(/"blocked"\s*:\s*"rejected"/);
		expect(text).toMatch(/"modelOnlyVisible"\s*:\s*false/);
		expect(executed).not.toHaveBeenCalled();
		expect(peakConcurrent).toBe(1);
		expect(nested).toEqual([
			{ parent: "outer", name: "fixture_data" },
			{ parent: "outer", name: "fixture_failure" },
			{ parent: "outer", name: "fixture_blocked" },
			{ parent: "outer", name: "fixture_sequence" },
			{ parent: "outer", name: "fixture_sequence" },
		]);
	});

	it("propagates cancellation through native codemode into nested tools", async () => {
		let started = false;
		let cancelled = false;
		const fixture: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "fixture_wait",
				label: "Wait",
				description: "Abort fixture",
				parameters: Type.Object({}),
				execute: async (_id, _params, signal) => {
					if (!signal) throw new Error("Missing native nested signal");
					started = true;
					return new Promise<never>((_resolve, reject) => {
						signal.addEventListener(
							"abort",
							() => {
								cancelled = true;
								reject(new Error("Fixture aborted"));
							},
							{ once: true },
						);
					});
				},
			});
		};
		const runtime = await runtimeFor(
			[fixture, createCodemodeExtension({ models: false })],
			"await tools.fixture_wait({});",
		);
		const pending = runtime.session.prompt("Run the cancellation fixture");
		await vi.waitFor(() => expect(started).toBe(true));
		await runtime.session.abort();
		await pending;
		expect(cancelled).toBe(true);
		expect(runtime.session.isIdle).toBe(true);
	});
});
