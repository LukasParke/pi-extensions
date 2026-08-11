import { describe, expect, it } from "vitest";
import { Semaphore, WorktreeManager, addUsage, emptyUsage, runTasks } from "@parke.dev/pi-subagent/sdk";

describe("subagent sdk boundary", () => {
	it("exports the stable surface workflows need", () => {
		expect(typeof runTasks).toBe("function");
		expect(typeof WorktreeManager).toBe("function");
		expect(typeof Semaphore).toBe("function");
		expect(typeof addUsage).toBe("function");
		expect(typeof emptyUsage).toBe("function");
		const u = addUsage(emptyUsage(), { input: 1, output: 2, cost: 0.1 });
		expect(u.input).toBe(1);
		expect(u.output).toBe(2);
	});
});
