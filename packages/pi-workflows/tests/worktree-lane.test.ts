import { describe, expect, it, vi } from "vitest";
import type { WorktreeHandle, WorktreeManager } from "@parke.dev/pi-subagent/sdk";
import { WorkflowLane } from "../src/worktree-lane.ts";

function fakeWorktrees(): WorktreeManager {
	const handle: WorktreeHandle = {
		cwd: "/tmp/wf-lane",
		branch: "wf/test",
		baseCwd: "/repo",
		baseCommit: "abc",
		changed: false,
	};
	return {
		create: vi.fn(async () => handle),
		finalize: vi.fn(async (h: WorktreeHandle) => ({ ...h, changed: true })),
	} as unknown as WorktreeManager;
}

describe("WorkflowLane", () => {
	it("serializes writers", async () => {
		const lane = new WorkflowLane(fakeWorktrees(), "/repo", "test");
		const order: string[] = [];
		const w1 = lane.withWriter(async () => {
			order.push("w1-start");
			await new Promise((r) => setTimeout(r, 30));
			order.push("w1-end");
			return 1;
		});
		const w2 = lane.withWriter(async () => {
			order.push("w2-start");
			order.push("w2-end");
			return 2;
		});
		await Promise.all([w1, w2]);
		expect(order).toEqual(["w1-start", "w1-end", "w2-start", "w2-end"]);
	});

	it("blocks readers while a writer is active", async () => {
		const lane = new WorkflowLane(fakeWorktrees(), "/repo", "test");
		const order: string[] = [];
		const writer = lane.withWriter(async () => {
			order.push("w-start");
			await new Promise((r) => setTimeout(r, 40));
			order.push("w-end");
		});
		// Give writer a tick to acquire.
		await new Promise((r) => setTimeout(r, 5));
		const reader = lane.withReader(async () => {
			order.push("r");
		});
		await Promise.all([writer, reader]);
		expect(order).toEqual(["w-start", "w-end", "r"]);
	});

	it("does not let a queued writer race a new reader", async () => {
		const lane = new WorkflowLane(fakeWorktrees(), "/repo", "test");
		const order: string[] = [];
		let releaseReader!: () => void;
		const firstReader = lane.withReader(async () => {
			order.push("r1-start");
			await new Promise<void>((resolve) => {
				releaseReader = resolve;
			});
			order.push("r1-end");
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		const writer = lane.withWriter(async () => {
			order.push("w");
		});
		const secondReader = lane.withReader(async () => {
			order.push("r2");
		});
		releaseReader();
		await Promise.all([firstReader, writer, secondReader]);
		expect(order).toEqual(["r1-start", "r1-end", "w", "r2"]);
	});

	it("creates the worktree once", async () => {
		const wt = fakeWorktrees();
		const lane = new WorkflowLane(wt, "/repo", "test");
		await Promise.all([lane.ensure(), lane.ensure()]);
		expect(wt.create).toHaveBeenCalledTimes(1);
	});
});
