import { describe, expect, it, vi } from "vitest";
import { cmuxTarget, createCmuxStatus, runCmux } from "../src/cmux.ts";

const env = {
	CMUX_WORKSPACE_ID: "11111111-1111-1111-1111-111111111111",
	CMUX_SURFACE_ID: "22222222-2222-2222-2222-222222222222",
};
const target = () => cmuxTarget(env, "test-session")!;

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("cmux targeting", () => {
	it("requires explicit workspace, surface and session; honors disabled children", () => {
		for (const invalid of [
			{},
			{ ...env, CMUX_WORKSPACE_ID: undefined },
			{ ...env, CMUX_SURFACE_ID: undefined },
			{ ...env, CMUX_WORKSPACE_ID: "workspace:1" },
			{ ...env, CMUX_SURFACE_ID: "selected" },
			{ ...env, CMUX_WORKSPACE_ID: `${env.CMUX_WORKSPACE_ID}\n` },
			{ ...env, CMUX_PI_HOOKS_DISABLED: "1" },
		])
			expect(cmuxTarget(invalid, "session")).toBeUndefined();
		expect(cmuxTarget(env, "")).toBeUndefined();
	});

	it("isolates sessions, surfaces and reloads, without exposing their IDs", () => {
		const targets = [
			target(),
			target(),
			cmuxTarget(env, "other-session")!,
			cmuxTarget({ ...env, CMUX_SURFACE_ID: env.CMUX_WORKSPACE_ID }, "test-session")!,
		];
		expect(new Set(targets.map((t) => t.key)).size).toBe(4);
		for (const t of targets) {
			expect(t.workspace).toBe(env.CMUX_WORKSPACE_ID);
			expect(t.key).toMatch(/^sentinel-[a-f0-9]{24}$/);
			expect(t.binary).toBe("cmux");
		}
		expect(cmuxTarget({ ...env, CMUX_BUNDLED_CLI_PATH: "/app/bin/cmux" }, "s")?.binary).toBe("/app/bin/cmux");
	});
});

describe("cmux latest-value queue", () => {
	it("serializes, coalesces and deduplicates updates with explicit targeting", async () => {
		const first = deferred();
		const run = vi
			.fn()
			.mockImplementationOnce(() => first.promise)
			.mockResolvedValue(undefined);
		const t = target();
		const status = createCmuxStatus(t, run);
		status.update(undefined);
		await status.flush();
		expect(run).not.toHaveBeenCalled();
		status.update("◉ 1 watch");
		await Promise.resolve();
		status.update("◉ 2 watches");
		status.update("◉ 3 watches, 1 sleep, gate 0/2");
		expect(run).toHaveBeenCalledTimes(1);
		first.resolve();
		await status.flush();
		expect(run.mock.calls).toEqual([
			[
				t.binary,
				[
					"set-status",
					t.key,
					"Watching · 1 watch",
					"--workspace",
					t.workspace,
					"--icon",
					"eye",
					"--color",
					"#e5b567",
				],
			],
			[
				t.binary,
				[
					"set-status",
					t.key,
					"Watching · 3 watches, 1 sleep, gate 0/2",
					"--workspace",
					t.workspace,
					"--icon",
					"eye",
					"--color",
					"#e5b567",
				],
			],
		]);
		status.update("◉ 3 watches, 1 sleep, gate 0/2");
		await status.flush();
		expect(run).toHaveBeenCalledTimes(2);
		status.update(undefined);
		await status.flush();
		expect(run).toHaveBeenLastCalledWith(t.binary, ["clear-status", t.key, "--workspace", t.workspace]);
		await status.close();
		expect(run).toHaveBeenCalledTimes(3);
	});

	it("clears after an in-flight write, drops pending writes, ignores late updates", async () => {
		const first = deferred();
		const run = vi
			.fn()
			.mockImplementationOnce(() => first.promise)
			.mockResolvedValue(undefined);
		const status = createCmuxStatus(target(), run);
		status.update("◉ 1 watch");
		await Promise.resolve();
		status.update("◉ 2 watches");
		const closing = status.close();
		const closingAgain = status.close();
		status.update("◉ 3 watches");
		expect(run).toHaveBeenCalledTimes(1);
		first.resolve();
		await Promise.all([closing, closingAgain]);
		expect(run.mock.calls.map((call) => call[1][0])).toEqual(["set-status", "clear-status"]);
		status.update("◉ 4 watches");
		await status.flush();
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("cannot clear a new session's badge during late cleanup", async () => {
		const pending = deferred();
		const run = vi
			.fn()
			.mockImplementationOnce(() => pending.promise)
			.mockResolvedValue(undefined);
		const oldTarget = target();
		const newTarget = target();
		const oldStatus = createCmuxStatus(oldTarget, run);
		const newStatus = createCmuxStatus(newTarget, run);
		oldStatus.update("◉ 1 watch");
		await Promise.resolve();
		const closing = oldStatus.close();
		newStatus.update("◉ 1 sleep");
		await newStatus.flush();
		pending.resolve();
		await closing;
		expect(run.mock.calls.map((call) => call[1].slice(0, 2))).toEqual([
			["set-status", oldTarget.key],
			["set-status", newTarget.key],
			["clear-status", oldTarget.key],
		]);
		await newStatus.close();
	});

	it("coalesces same-turn sets and shutdown without leaving a badge", async () => {
		const run = vi.fn().mockResolvedValue(undefined);
		const status = createCmuxStatus(target(), run);
		status.update("◉ 1 watch");
		await status.close();
		expect(run).not.toHaveBeenCalled();
	});

	it("survives sync/async errors, retries only on update, and contains cleanup failure", async () => {
		const run = vi
			.fn()
			.mockImplementationOnce(() => {
				throw new Error("missing CLI");
			})
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("offline at shutdown"));
		const status = createCmuxStatus(target(), run);
		for (let i = 1; i <= 3; i++) {
			status.update("◉ 1 watch");
			await status.flush();
			expect(run).toHaveBeenCalledTimes(i);
		}
		await status.close();
		await status.close();
		expect(run).toHaveBeenCalledTimes(4);
	});

	it("attempts final clear even when the preceding set failed", async () => {
		const run = vi.fn().mockRejectedValue(new Error("offline"));
		const status = createCmuxStatus(target(), run);
		status.update("◉ 1 watch");
		await status.flush();
		await status.close();
		expect(run.mock.calls.map((call) => call[1][0])).toEqual(["set-status", "clear-status"]);
	});
});

describe("bounded CLI execution (no live cmux)", () => {
	it("rejects missing binaries, nonzero exits and excess output", async () => {
		await expect(runCmux("/nonexistent/sentinel-cmux", [])).rejects.toThrow();
		await expect(runCmux(process.execPath, ["-e", "process.exit(1)"])).rejects.toThrow();
		await expect(
			runCmux(process.execPath, ["-e", "process.stdout.write('x'.repeat(32768))"]),
		).rejects.toThrow();
		await expect(runCmux(process.execPath, ["-e", "process.exit(0)"])).resolves.toBeUndefined();
	});

	it("kills a stuck process even if it ignores SIGTERM", async () => {
		await expect(
			runCmux(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"]),
		).rejects.toMatchObject({ killed: true, signal: "SIGKILL" });
	});
});
