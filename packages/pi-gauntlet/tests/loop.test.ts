import { describe, expect, it, vi } from "vitest";
import { GauntletEngine, emptyState, type CheckExec, type EngineHooks } from "../src/loop.ts";

function harness(exec: CheckExec, maxIterations = 3) {
	const hooks: EngineHooks = {
		persist: vi.fn(),
		success: vi.fn(),
		exhausted: vi.fn(),
		inject: vi.fn(),
		changed: vi.fn(),
	};
	const engine = new GauntletEngine({ maxIterations, checkTimeoutMs: 1_000, exec, hooks });
	engine.addCheck("tests", "npm test");
	engine.addCheck("lint", "npm run lint");
	return { engine, hooks };
}

const passing: CheckExec = async () => ({ stdout: "ok", stderr: "", code: 0 });
const failingLint: CheckExec = async (command) =>
	command.includes("lint") ? { stdout: "", stderr: "boom", code: 2 } : { stdout: "ok", stderr: "", code: 0 };

describe("GauntletEngine.settle", () => {
	it("does nothing when the loop is not active", async () => {
		const exec = vi.fn(passing);
		const { engine } = harness(exec);
		await engine.settle();
		expect(exec).not.toHaveBeenCalled();
	});

	it("stops the loop and reports success when every check passes", async () => {
		const { engine, hooks } = harness(passing);
		engine.start("ship it");
		await engine.settle();

		expect(engine.state.active).toBe(false);
		expect(hooks.success).toHaveBeenCalledOnce();
		expect(hooks.inject).not.toHaveBeenCalled();
		expect(hooks.persist).toHaveBeenCalled();
	});

	it("increments the iteration and injects a report on failure", async () => {
		const { engine, hooks } = harness(failingLint);
		engine.start("ship it");
		await engine.settle();

		expect(engine.state.active).toBe(true);
		expect(engine.state.iteration).toBe(1);
		const report = vi.mocked(hooks.inject).mock.calls[0]![0] as string;
		expect(report).toContain("iteration 1/3");
		expect(report).toContain("ship it");
		expect(report).toContain("✗ lint (exit 2)");
		expect(report).toContain("boom");
		expect(report).not.toContain("✗ tests");
	});

	it("stops with exhausted when maxIterations is reached", async () => {
		const { engine, hooks } = harness(failingLint, 2);
		engine.start("ship it");
		await engine.settle();
		expect(engine.state.active).toBe(true);
		await engine.settle();

		expect(engine.state.iteration).toBe(2);
		expect(engine.state.active).toBe(false);
		expect(hooks.exhausted).toHaveBeenCalledOnce();
		expect(hooks.inject).toHaveBeenCalledOnce();
	});

	it("never overlaps concurrent settle calls", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const exec = vi.fn(async (): ReturnType<CheckExec> => {
			await gate;
			return { stdout: "", stderr: "", code: 0 };
		});
		const { engine } = harness(exec);
		engine.start("ship it");

		const first = engine.settle();
		const second = engine.settle();
		release();
		await Promise.all([first, second]);

		// Two checks, one gauntlet run: the second settle() was skipped entirely.
		expect(exec).toHaveBeenCalledTimes(2);
	});

	it("pauses without injecting when a check run is aborted", async () => {
		const abort: CheckExec = async () => {
			const error = new Error("aborted");
			error.name = "AbortError";
			throw error;
		};
		const { engine, hooks } = harness(abort);
		engine.start("ship it");
		await engine.settle();

		expect(engine.state.active).toBe(true);
		expect(hooks.inject).not.toHaveBeenCalled();
	});
});

describe("GauntletEngine state mutations", () => {
	it("addCheck replaces a same-named check and clears its result", async () => {
		const { engine } = harness(passing);
		await engine.runChecks();
		expect(engine.state.results.tests?.code).toBe(0);

		engine.addCheck("tests", "vitest run");
		expect(engine.state.checks).toHaveLength(2);
		expect(engine.state.checks.find((c) => c.name === "tests")?.command).toBe("vitest run");
		expect(engine.state.results.tests).toBeUndefined();
	});

	it("removeCheck drops the check and its result", async () => {
		const { engine } = harness(passing);
		await engine.runChecks();
		expect(engine.removeCheck("lint")).toBe(true);
		expect(engine.removeCheck("lint")).toBe(false);
		expect(engine.state.checks.map((c) => c.name)).toEqual(["tests"]);
		expect(engine.state.results.lint).toBeUndefined();
	});

	it("runChecks returns per-check outcomes without loop semantics", async () => {
		const { engine, hooks } = harness(failingLint);
		const results = await engine.runChecks();

		expect(results.tests?.code).toBe(0);
		expect(results.lint?.code).toBe(2);
		expect(engine.state.iteration).toBe(0);
		expect(hooks.inject).not.toHaveBeenCalled();
	});

	it("restores from a persisted state", () => {
		const restored = { ...emptyState(), goal: "old", active: true, iteration: 4 };
		const { engine } = harness(passing);
		const resumed = new GauntletEngine(
			{
				maxIterations: 3,
				checkTimeoutMs: 1_000,
				exec: passing,
				hooks: {
					persist: vi.fn(),
					success: vi.fn(),
					exhausted: vi.fn(),
					inject: vi.fn(),
					changed: vi.fn(),
				},
			},
			restored,
		);
		expect(resumed.state.goal).toBe("old");
		expect(resumed.state.iteration).toBe(4);
		expect(engine.state.active).toBe(false);
	});
});
