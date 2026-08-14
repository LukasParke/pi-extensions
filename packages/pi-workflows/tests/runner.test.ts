import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyUsage } from "@parke.dev/pi-subagent/sdk";
import { defaultConfig } from "../src/config.ts";
import { readJournal, readSummary } from "../src/journal.ts";
import { executeWorkflow, newRunId } from "../src/runner.ts";

const canSandbox = process.allowedNodeEnvironmentFlags.has("--permission");
const temps: string[] = [];

afterEach(async () => {
	await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-run-"));
	temps.push(dir);
	return dir;
}

describe.skipIf(!canSandbox)("executeWorkflow", () => {
	it("aggregates child usage and writes journal", async () => {
		const agentDir = await tempDir();
		const runAgent = vi.fn(async (spec: { task: string }) => ({
			ok: true,
			output: `done:${spec.task}`,
			usage: {
				...emptyUsage(),
				input: 10,
				output: 5,
				cost: 0.01,
				turns: 1,
			},
		}));

		const exec = await executeWorkflow({
			runId: newRunId(),
			label: "usage-test",
			source: `
        const a = await agent("one", { label: "a" });
        const b = await agent("two", { label: "b" });
        return { a: a.output, b: b.output, ua: a.usage?.cost };
      `,
			cwd: process.cwd(),
			agentDir,
			config: { ...defaultConfig, approval: "never" },
			signal: new AbortController().signal,
			ctx: { cwd: process.cwd(), model: undefined },
			runAgent,
			worktrees: {
				create: vi.fn(async () => ({
					cwd: process.cwd(),
					branch: "wf/test",
					baseCwd: process.cwd(),
					baseCommit: "x",
					changed: false,
				})),
				finalize: vi.fn(async (h) => h),
			} as never,
		});

		expect(exec.state).toBe("completed");
		expect(exec.usage.input).toBe(20);
		expect(exec.usage.cost).toBeCloseTo(0.02);
		expect(runAgent).toHaveBeenCalledTimes(2);

		const journal = await readJournal(exec.summary.artifactPath);
		expect(journal.some((e) => e.kind === "agent" && e.status === "completed")).toBe(true);
		const summary = await readSummary(exec.summary.artifactPath);
		expect(summary?.agentCount).toBe(2);
	});

	it("replays contiguous prefix on resume", async () => {
		const agentDir = await tempDir();
		let calls = 0;
		const runAgent = vi.fn(async (spec: { task: string }) => {
			calls++;
			return {
				ok: true,
				output: `live:${spec.task}:${calls}`,
				usage: { ...emptyUsage(), input: 1, output: 1, cost: 0.001, turns: 1 },
			};
		});

		const worktrees = {
			create: vi.fn(async () => ({
				cwd: process.cwd(),
				branch: "wf/test",
				baseCwd: process.cwd(),
				baseCommit: "x",
				changed: false,
			})),
			finalize: vi.fn(async (h: unknown) => h),
		} as never;

		const first = await executeWorkflow({
			runId: newRunId(),
			label: "resume-test",
			source: `
        const a = await agent("one", { label: "a" });
        const b = await agent("two", { label: "b" });
        return [a.output, b.output];
      `,
			cwd: process.cwd(),
			agentDir,
			config: { ...defaultConfig, approval: "never" },
			signal: new AbortController().signal,
			ctx: { cwd: process.cwd(), model: undefined },
			runAgent,
			worktrees,
		});
		expect(first.state).toBe("completed");
		expect(calls).toBe(2);

		calls = 0;
		runAgent.mockClear();
		const second = await executeWorkflow({
			runId: newRunId(),
			label: "resume-test",
			source: `
        const a = await agent("one", { label: "a" });
        const b = await agent("two", { label: "b" });
        return [a.output, b.output];
      `,
			cwd: process.cwd(),
			agentDir,
			config: { ...defaultConfig, approval: "never" },
			signal: new AbortController().signal,
			ctx: { cwd: process.cwd(), model: undefined },
			runAgent,
			worktrees,
			resumeFrom: first.summary.artifactPath,
		});
		expect(second.state).toBe("completed");
		// Both served from journal — no live agent calls.
		expect(runAgent).not.toHaveBeenCalled();
		expect(second.result).toEqual(["live:one:1", "live:two:2"]);
		expect(second.summary.agentCount).toBe(2);
		expect(second.summary.completedAgents).toBe(2);
	});

	it("passes maxCost through unclamped when agentMaxCost is unset", async () => {
		const agentDir = await tempDir();
		const specs: { maxCost?: number }[] = [];
		const runAgent = vi.fn(async (spec: { maxCost?: number }) => {
			specs.push(spec);
			return { ok: true, output: "ok", usage: emptyUsage() };
		});

		const exec = await executeWorkflow({
			runId: newRunId(),
			label: "cost-unset-test",
			source: `
        await agent("one", { label: "a" });
        await agent("two", { label: "b", maxCost: 5 });
        return true;
      `,
			cwd: process.cwd(),
			agentDir,
			config: { ...defaultConfig, approval: "never" },
			signal: new AbortController().signal,
			ctx: { cwd: process.cwd(), model: undefined },
			runAgent,
			worktrees: {
				create: vi.fn(async () => ({
					cwd: process.cwd(),
					branch: "wf/test",
					baseCwd: process.cwd(),
					baseCommit: "x",
					changed: false,
				})),
				finalize: vi.fn(async (h) => h),
			} as never,
		});

		expect(exec.state).toBe("completed");
		expect(specs[0]?.maxCost).toBeUndefined();
		expect(specs[1]?.maxCost).toBe(5);
	});

	it("defaults and clamps maxCost when agentMaxCost is set", async () => {
		const agentDir = await tempDir();
		const specs: { maxCost?: number }[] = [];
		const runAgent = vi.fn(async (spec: { maxCost?: number }) => {
			specs.push(spec);
			return { ok: true, output: "ok", usage: emptyUsage() };
		});

		const exec = await executeWorkflow({
			runId: newRunId(),
			label: "cost-set-test",
			source: `
        await agent("one", { label: "a" });
        await agent("two", { label: "b", maxCost: 5 });
        return true;
      `,
			cwd: process.cwd(),
			agentDir,
			config: { ...defaultConfig, approval: "never", agentMaxCost: 0.5 },
			signal: new AbortController().signal,
			ctx: { cwd: process.cwd(), model: undefined },
			runAgent,
			worktrees: {
				create: vi.fn(async () => ({
					cwd: process.cwd(),
					branch: "wf/test",
					baseCwd: process.cwd(),
					baseCommit: "x",
					changed: false,
				})),
				finalize: vi.fn(async (h) => h),
			} as never,
		});

		expect(exec.state).toBe("completed");
		expect(specs[0]?.maxCost).toBe(0.5);
		expect(specs[1]?.maxCost).toBe(0.5);
	});
});
