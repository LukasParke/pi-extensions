import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager, type WorktreeHandle } from "../src/worktree.js";
import { loadConfig, sanitizeConfigOverrides } from "../src/config.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
async function fixture(): Promise<WorktreeHandle> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-finalize-deadline-"));
	dirs.push(root);
	const cwd = path.join(root, "private-task", "work");
	await fs.mkdir(cwd, { recursive: true });
	return { cwd, branch: "fixture", baseCwd: root, baseCommit: "base", changed: false };
}

describe("bounded worktree cleanup", () => {
	it("bounds even an unresponsive inspection without deleting unknown work", async () => {
		const handle = await fixture();
		const calls: string[][] = [];
		const manager = new WorktreeManager(async (_command, args) => { calls.push(args); return new Promise(() => {}); }, handle.baseCwd, 10);
		const outcome = await Promise.race([
			manager.finalize(handle).then(() => "completed", (error: unknown) => error instanceof Error ? error.name : "error"),
			new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
		]);
		expect(outcome).toBe("TimeoutError");
		expect(calls).toEqual([["status", "--porcelain"]]);
		expect(await fs.stat(handle.cwd)).toBeDefined();
	});

	it("passes one cleanup deadline through inspection and both Git mutations", async () => {
		const handle = await fixture();
		const signals: (AbortSignal | undefined)[] = [];
		const manager = new WorktreeManager(async (_command, args, _cwd, signal) => {
			signals.push(signal);
			return { code: 0, stderr: "", stdout: args[0] === "rev-parse" ? "base\n" : "" };
		}, handle.baseCwd, 1000);
		await manager.finalize(handle);
		expect(signals).toHaveLength(4);
		expect(signals.every((signal) => signal === signals[0] && signal instanceof AbortSignal)).toBe(true);
	});

	it("lets configuration override the safety deadline without introducing turn/spend policy", () => {
		expect(loadConfig({}, {}).worktreeFinalizeTimeoutMs).toBe(8000);
		expect(loadConfig({}, { PI_SUBAGENT_WORKTREE_FINALIZE_TIMEOUT_MS: "15000" }).worktreeFinalizeTimeoutMs).toBe(15000);
		expect(sanitizeConfigOverrides({ worktreeFinalizeTimeoutMs: 0 })).toEqual({});
	});
});
