import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import register from "../extensions/error-log.ts";
import { resetConfigCache } from "../src/config.ts";

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-error-log-native-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", path.join(dir, "agent"));
	vi.stubEnv("PI_ERROR_LOG_PATH", path.join(dir, "errors.jsonl"));
	vi.stubEnv("PI_ERROR_LOG_ENABLED", "true");
	resetConfigCache();
});

afterEach(async () => {
	vi.unstubAllEnvs();
	resetConfigCache();
	await fs.rm(dir, { recursive: true, force: true });
});

function harness() {
	const handlers = new Map<string, Function>();
	let tool!: ToolDefinition;
	register({
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
	} as never);
	const ctx = {
		cwd: dir,
		model: undefined,
		sessionManager: { getSessionFile: () => undefined },
	};
	return {
		get tool() {
			return tool;
		},
		execute: () => tool.execute("query", {}, undefined, undefined, ctx as never),
		fire: (name: string, event: unknown) => handlers.get(name)!(event, ctx),
	};
}

describe("native error log results", () => {
	it("records parent attribution and sanitized args for native nested errors", async () => {
		const h = harness();
		const call = { toolCallId: "parent/1", parentToolCallId: "parent", toolName: "fixture" };
		await h.fire("tool_execution_start", { ...call, args: { token: "private", query: "hello" } });
		await h.fire("tool_execution_end", {
			...call,
			isError: true,
			result: { content: [{ type: "text", text: "fixture failed" }], details: {} },
		});
		const result = await h.execute();
		expect(Value.Check(h.tool.outputSchema!, result.structuredContent)).toBe(true);
		expect(result.structuredContent).toMatchObject({
			path: path.join(dir, "errors.jsonl"),
			entries: [
				{
					toolCallId: "parent/1",
					parentToolCallId: "parent",
					args: '{"token":"[redacted]","query":"hello"}',
					error: { message: "fixture failed" },
				},
			],
		});
		expect(h.tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
	});

	it("returns schema-valid empty and disabled queries", async () => {
		const h = harness();
		expect(Value.Check(h.tool.outputSchema!, (await h.execute()).structuredContent)).toBe(true);
		vi.stubEnv("PI_ERROR_LOG_ENABLED", "false");
		resetConfigCache();
		const disabled = await h.execute();
		expect(disabled.structuredContent).toEqual({ path: null, entries: [] });
		expect(Value.Check(h.tool.outputSchema!, disabled.structuredContent)).toBe(true);
	});
});
