import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import register from "../extensions/gauntlet.ts";
import { resetConfigCache } from "../src/config.ts";

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gauntlet-native-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", path.join(dir, "agent"));
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
		registerCommand: vi.fn(),
		appendEntry: vi.fn(),
		exec: vi.fn(async () => ({ stdout: "passed", stderr: "", code: 0 })),
	} as never);
	const ctx = {
		cwd: dir,
		hasUI: false,
		isProjectTrusted: () => false,
		sessionManager: { getBranch: () => [] },
	};
	return {
		get tool() {
			return tool;
		},
		start: () => handlers.get("session_start")!({}, ctx),
		execute: (params: Record<string, unknown>) =>
			tool.execute("call", params, undefined, undefined, ctx as never),
	};
}

describe("native gauntlet results", () => {
	it("returns schema-valid state and check outcomes", async () => {
		const h = harness();
		await h.start();
		for (const params of [
			{ action: "add_check", name: "tests", command: "test" },
			{ action: "start", goal: "Native contracts" },
			{ action: "status" },
			{ action: "run" },
			{ action: "stop" },
			{ action: "remove_check", name: "tests" },
		]) {
			const result = await h.execute(params);
			expect(Value.Check(h.tool.outputSchema!, result.structuredContent)).toBe(true);
			expect(result.isError).toBe(false);
		}
		expect(h.tool.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		});
	});

	it("marks unavailable and invalid operations as native errors with data", async () => {
		const h = harness();
		const unavailable = await h.execute({ action: "status" });
		expect(unavailable.isError).toBe(true);
		expect(Value.Check(h.tool.outputSchema!, unavailable.structuredContent)).toBe(true);
		await h.start();
		for (const params of [{ action: "add_check" }, { action: "start" }, { action: "remove_check" }]) {
			const result = await h.execute(params);
			expect(result.isError).toBe(true);
			expect(Value.Check(h.tool.outputSchema!, result.structuredContent)).toBe(true);
		}
	});
});
