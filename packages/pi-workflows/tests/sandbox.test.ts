import { describe, expect, it } from "vitest";
import { runWorkflowSandbox } from "../src/sandbox.ts";

const canSandbox = process.allowedNodeEnvironmentFlags.has("--permission");

describe.skipIf(!canSandbox)("workflow sandbox", () => {
	it("exposes pipeline() and returns mapped results", async () => {
		const prompts: string[] = [];
		const result = await runWorkflowSandbox({
			source: `
        phase("map");
        const out = await pipeline([1, 2, 3], (n) => agent("n=" + n, { label: "p" + n }));
        return out.map((r) => r.output);
      `,
			args: undefined,
			cwd: process.cwd(),
			signal: new AbortController().signal,
			maxConcurrency: 2,
			onPhase: () => {},
			onAgent: async (prompt) => {
				prompts.push(prompt);
				return { ok: true, output: prompt };
			},
		});
		expect(result).toEqual(["n=1", "n=2", "n=3"]);
		expect(prompts).toEqual(["n=1", "n=2", "n=3"]);
	});

	it("passes structured args through", async () => {
		const result = await runWorkflowSandbox({
			source: `return { got: args.value, nested: args.nested.x };`,
			args: { value: 42, nested: { x: "y" } },
			cwd: process.cwd(),
			signal: new AbortController().signal,
			onPhase: () => {},
			onAgent: async () => ({ ok: true, output: "" }),
		});
		expect(result).toEqual({ got: 42, nested: "y" });
	});

	it("rejects unawaited agent calls", async () => {
		await expect(
			runWorkflowSandbox({
				source: `agent("leak"); return 1;`,
				args: undefined,
				cwd: process.cwd(),
				signal: new AbortController().signal,
				onPhase: () => {},
				onAgent: async () => ({ ok: true, output: "x" }),
			}),
		).rejects.toThrow(/unawaited/);
	});
});
