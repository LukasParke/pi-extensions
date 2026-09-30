import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildRunner, Semaphore, type TaskResult, type TaskSpec } from "@parke.dev/pi-subagent/sdk";
// @ts-expect-error deterministic ESM child fixture
import { getFakePiCommand } from "../../pi-subagent/tests/helpers/fake-pi.mjs";
import { executeWorkflow, newRunId } from "../src/runner.ts";
import { defaultConfig } from "../src/config.ts";

const dirs: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!process.allowedNodeEnvironmentFlags.has("--permission"))(
	"workflow budgets through real child runner",
	() => {
		it.each([
			{ name: "omitted budgets", maxTurns: undefined, maxCost: undefined, stopReason: undefined },
			{ name: "505 turns", maxTurns: 505, maxCost: undefined, stopReason: "max_turns" },
			{ name: "explicit spend", maxTurns: undefined, maxCost: 0.05, stopReason: "max_cost" },
		])("honors $name without the retired default ceilings", async ({ maxTurns, maxCost, stopReason }) => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-real-budget-"));
			dirs.push(dir);
			vi.stubEnv("FAKE_PI_MODE", "many-turns");
			const fake = getFakePiCommand();
			const specs: TaskSpec[] = [];
			const children: TaskResult[] = [];
			const runner = new ChildRunner(
				new Semaphore(1, 5),
				() => fake,
				path.join(dir, "sessions"),
				() => {},
				50,
			);
			const result = await executeWorkflow({
				runId: newRunId(),
				label: "real child budget",
				cwd: dir,
				agentDir: path.join(dir, "agent"),
				source: `return await agent("fixture", ${JSON.stringify({ isolation: "worktree", maxTurns, maxCost })});`,
				config: { ...defaultConfig, approval: "never" },
				signal: new AbortController().signal,
				ctx: { cwd: dir, model: undefined },
				runAgent: async (spec, signal) => {
					specs.push(spec);
					const child = await runner.run({ ...spec, cwd: dir, isolation: "shared", graceTurns: 0 }, signal);
					children.push(child);
					return {
						ok: child.state === "completed" || child.state === "partial",
						output: child.liveText ?? "",
						usage: child.usage,
					};
				},
			});
			expect(result.state).toBe("completed");
			expect(specs[0]?.maxTurns).toBe(maxTurns);
			expect(specs[0]?.maxCost).toBe(maxCost);
			if (stopReason === undefined) {
				expect(children[0]?.state).toBe("completed");
				expect(children[0]?.usage.turns).toBe(510);
			} else {
				expect(children[0]?.state).toBe("partial");
				expect(children[0]?.stopReason).toBe(stopReason);
				if (maxTurns !== undefined) expect(children[0]?.usage.turns).toBeGreaterThanOrEqual(maxTurns);
				if (maxCost !== undefined) expect(children[0]?.usage.cost).toBeGreaterThanOrEqual(maxCost);
			}
		});
	},
);
