/**
 * Native Pi 0.99 tool contracts for bg_start / bg_status / bg_list / bg_kill:
 * namespaces, truthful annotations, and outputSchema-validated structured
 * content on success and failure branches. Uses only short-lived local
 * processes; the fake session is shut down after each test so nothing leaks.
 */
import { Check } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import register from "../extensions/background-terminals.ts";

interface ToolResult {
	content: { type: string; text: string }[];
	details?: unknown;
	structuredContent?: unknown;
	isError?: boolean;
}

interface ToolDef {
	name: string;
	outputSchema?: import("typebox").TSchema;
	namespace?: { name: string; description?: string };
	annotations?: Record<string, boolean>;
	exposure?: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<ToolResult>;
}

interface Harness {
	tools: Record<string, ToolDef>;
	handlers: Record<string, () => Promise<void>>;
	messages: { content: string; details: unknown }[];
	shutdown: () => Promise<void>;
}

function harness(): Harness {
	const tools: Record<string, ToolDef> = {};
	const handlers: Record<string, () => Promise<void>> = {};
	const messages: Harness["messages"] = [];
	register({
		registerTool: (def: ToolDef) => (tools[def.name] = def),
		registerCommand: () => {},
		on: (event: string, handler: () => Promise<void>) => (handlers[event] = handler),
		sendMessage: (message: { content: string; details: unknown }) => messages.push(message),
	} as never);
	return { tools, handlers, messages, shutdown: () => handlers.session_shutdown!() };
}

let h: Harness;
beforeEach(() => {
	h = harness();
});
afterEach(async () => {
	await h.shutdown();
});

const ctx = { cwd: process.cwd() };
const start = (command: string, title = "t") =>
	h.tools.bg_start!.execute("1", { command, title }, undefined, undefined, ctx);

async function settled(id: string): Promise<ToolResult> {
	for (let attempt = 0; attempt < 400; attempt++) {
		const result = await h.tools.bg_status!.execute("2", { id });
		if ((result.structuredContent as { status: string }).status !== "running") return result;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`terminal ${id} did not settle`);
}

describe("native tool declarations", () => {
	it("every tool has a namespace, an output schema, and truthful annotations", () => {
		expect(Object.keys(h.tools).sort()).toEqual(["bg_kill", "bg_list", "bg_start", "bg_status"]);
		for (const tool of Object.values(h.tools)) {
			expect(tool.outputSchema).toBeDefined();
			expect(tool.namespace?.name).toBe("background-terminals");
			expect(tool.exposure).toBeUndefined(); // direct exposure stays the default
		}
		expect(h.tools.bg_start!.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
		// bg_status consumes settled results: not read-only, not idempotent.
		expect(h.tools.bg_status!.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
		expect(h.tools.bg_list!.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
		expect(h.tools.bg_kill!.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
	});
});

describe("structured results", () => {
	it("bg_start validates and the text rendering is unchanged", async () => {
		const result = await start("echo hi", "hello");
		expect(Check(h.tools.bg_start!.outputSchema!, result.structuredContent)).toBe(true);
		const structured = result.structuredContent as { id: string; status: string };
		expect(structured.status).toBe("running");
		expect(result.content[0]!.text).toContain(`Started ${structured.id} "hello"`);
	});

	it("bg_status validates with a normalized, handle-free snapshot", async () => {
		const { structuredContent } = await start("echo hi && exit 0");
		const { id } = structuredContent as { id: string };
		const result = await settled(id);
		expect(Check(h.tools.bg_status!.outputSchema!, result.structuredContent)).toBe(true);
		const structured = result.structuredContent as {
			status: string;
			exitCode: number;
			stdout: { text: string; totalBytes: number };
		};
		expect(structured.status).toBe("done");
		expect(structured.exitCode).toBe(0);
		expect(structured.stdout.text).toContain("hi");
		expect(JSON.stringify(result.structuredContent)).not.toContain("ChildProcess");
		// Settled result consumed via bg_status: no duplicate completion message.
		await h.handlers.agent_settled!();
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(h.messages).toHaveLength(0);
	});

	it("bg_list validates with per-terminal summaries", async () => {
		await start("echo hi", "listed");
		const result = await h.tools.bg_list!.execute("3", {});
		expect(Check(h.tools.bg_list!.outputSchema!, result.structuredContent)).toBe(true);
		const structured = result.structuredContent as { count: number; terminals: { title: string }[] };
		expect(structured.count).toBe(1);
		expect(structured.terminals[0]!.title).toBe("listed");
	});

	it("cancels pending completion delivery on session shutdown", async () => {
		await start("echo shutdown", "closing");
		await vi.waitFor(async () => {
			const result = await h.tools.bg_list!.execute("list", {});
			expect(result.structuredContent).toMatchObject({ running: 0 });
		});
		await h.handlers.agent_settled!();
		await h.shutdown();
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(h.messages).toHaveLength(0);
	});

	it("reports bytes omitted by the tool's own tail limit", async () => {
		const { structuredContent } = await start("printf '%020000d' 0", "large");
		const { id } = structuredContent as { id: string };
		const result = await settled(id);
		const data = result.structuredContent as {
			stdout: { text: string; totalBytes: number; truncatedBytes: number };
		};
		expect(data.stdout.totalBytes).toBe(20_000);
		expect(data.stdout.truncatedBytes).toBe(20_000 - Buffer.byteLength(data.stdout.text));
		expect(data.stdout.truncatedBytes).toBeGreaterThan(0);
	});

	it("bg_status on an unknown id is an error naming the known ids", async () => {
		await start("echo hi", "known");
		await expect(h.tools.bg_status!.execute("4", { id: "bt-999" })).rejects.toThrow(
			/No background terminal bt-999\. Known: bt-1/,
		);
	});
});

describe("bg_kill partial failure honesty", () => {
	it("a mix of valid and bogus ids is isError with per-id outcomes", async () => {
		const { structuredContent } = await start("sleep 60", "sleeper");
		const { id } = structuredContent as { id: string };
		const result = await h.tools.bg_kill!.execute("5", { ids: [id, "bt-999"] });
		expect(result.isError).toBe(true);
		expect(Check(h.tools.bg_kill!.outputSchema!, result.structuredContent)).toBe(true);
		const structured = result.structuredContent as {
			results: { id: string; ok: boolean; status: string | null; error: string | null }[];
			killed: number;
			failed: number;
		};
		expect(structured.killed).toBe(1);
		expect(structured.failed).toBe(1);
		expect(structured.results.find((entry) => entry.id === id)).toMatchObject({ ok: true, status: "killed" });
		expect(structured.results.find((entry) => entry.id === "bt-999")?.ok).toBe(false);
		// The text output must not read as "all killed".
		expect(result.content[0]!.text).toContain("bt-999: No background terminal bt-999");
	});

	it("an all-success kill validates and is not an error", async () => {
		const { structuredContent } = await start("sleep 60", "sleeper");
		const { id } = structuredContent as { id: string };
		const result = await h.tools.bg_kill!.execute("6", { ids: [id] });
		expect(result.isError).toBeUndefined();
		expect(Check(h.tools.bg_kill!.outputSchema!, result.structuredContent)).toBe(true);
		expect(result.structuredContent).toMatchObject({ killed: 1, failed: 0 });
	});
});
