import { describe, expect, it } from "vitest";
import { emptyUsage } from "@parke.dev/pi-subagent/sdk";
import { WorkflowRunRegistry, type LiveWorkflowRun, type WorkflowTerminal } from "../src/registry.ts";

function makeRun(
	partial: Partial<LiveWorkflowRun> & Pick<LiveWorkflowRun, "runId" | "promise">,
): LiveWorkflowRun {
	return {
		sessionKey: "s1",
		label: "t",
		state: "running",
		startedAt: Date.now(),
		agentCount: 0,
		completedAgents: 0,
		failedAgents: 0,
		usage: emptyUsage(),
		artifactPath: "/tmp/x",
		delivered: false,
		claimed: false,
		controller: new AbortController(),
		sourceHash: "s",
		argsHash: "a",
		cwd: "/repo",
		...partial,
	};
}

describe("WorkflowRunRegistry", () => {
	it("tracks runs and cancels active ones", async () => {
		const registry = new WorkflowRunRegistry();
		let resolve!: (value: WorkflowTerminal) => void;
		const promise = new Promise<WorkflowTerminal>((r) => {
			resolve = r;
		});
		const run = makeRun({ runId: "wf-abc123", promise });
		registry.register(run);
		expect(registry.get("wf-abc")?.runId).toBe("wf-abc123");
		const cancelled = registry.cancel("wf-abc123");
		expect(cancelled.ok).toBe(true);
		expect(run.controller.signal.aborted).toBe(true);
		resolve({
			runId: run.runId,
			state: "cancelled",
			summary: {
				runId: run.runId,
				label: "t",
				state: "cancelled",
				startedAt: run.startedAt,
				agentCount: 0,
				completedAgents: 0,
				failedAgents: 0,
				usage: emptyUsage(),
				artifactPath: run.artifactPath,
			},
		});
		await promise;
	});

	it("can accept runs again after a session reset", async () => {
		const registry = new WorkflowRunRegistry();
		await registry.shutdown(0);
		registry.resetForSession();
		const terminal: WorkflowTerminal = {
			runId: "wf-reset",
			state: "completed",
			summary: {
				runId: "wf-reset",
				label: "t",
				state: "completed",
				startedAt: 1,
				agentCount: 0,
				completedAgents: 0,
				failedAgents: 0,
				usage: emptyUsage(),
				artifactPath: "/a",
			},
		};
		expect(() =>
			registry.register(makeRun({ runId: "wf-reset", promise: Promise.resolve(terminal) })),
		).not.toThrow();
	});

	it("lists undelivered terminal runs", async () => {
		const registry = new WorkflowRunRegistry();
		const terminal: WorkflowTerminal = {
			runId: "wf-1",
			state: "completed",
			summary: {
				runId: "wf-1",
				label: "t",
				state: "completed",
				startedAt: 1,
				endedAt: 2,
				agentCount: 1,
				completedAgents: 1,
				failedAgents: 0,
				usage: emptyUsage(),
				artifactPath: "/a",
			},
		};
		const run = makeRun({ runId: "wf-1", promise: Promise.resolve(terminal) });
		registry.register(run);
		await run.promise;
		// allow microtask settlement on registry
		await new Promise((r) => setTimeout(r, 0));
		expect(registry.undeliveredTerminal("s1").map((r) => r.runId)).toEqual(["wf-1"]);
		expect(registry.markDelivered("wf-1")).toBe(true);
		expect(registry.markDelivered("wf-1")).toBe(false);
		expect(registry.undeliveredTerminal("s1")).toEqual([]);
	});
});
