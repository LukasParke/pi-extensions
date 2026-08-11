import { emptyUsage } from "@parke.dev/pi-subagent/sdk";
import { describe, expect, it } from "vitest";
import type { LiveWorkflowRun } from "../src/registry.ts";
import { workflowStatus } from "../src/ui.ts";

function run(overrides: Partial<LiveWorkflowRun> = {}): LiveWorkflowRun {
	return {
		runId: "wf-test",
		sessionKey: "session",
		label: "test",
		state: "running",
		startedAt: 1,
		agentCount: 1,
		completedAgents: 0,
		failedAgents: 0,
		usage: emptyUsage(),
		artifactPath: "/tmp/workflow",
		delivered: false,
		claimed: false,
		controller: new AbortController(),
		promise: new Promise(() => {}),
		sourceHash: "source",
		argsHash: "args",
		cwd: "/repo",
		...overrides,
	};
}

describe("workflowStatus", () => {
	it("shows active and ready counts, then clears when nothing is actionable", () => {
		expect(workflowStatus([run(), run({ runId: "done", state: "completed" })])).toBe(
			"⚙ 1 running · 1 ready · /workflows",
		);
		expect(
			workflowStatus([
				run({ state: "completed", delivered: true }),
				run({ runId: "claimed", state: "failed", claimed: true }),
			]),
		).toBeUndefined();
	});
});
