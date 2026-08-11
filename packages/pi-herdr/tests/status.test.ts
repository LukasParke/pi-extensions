import { describe, expect, it } from "vitest";
import { getHerdrTaskStatus } from "../src/status.ts";
import type { HerdrRunner } from "../src/dispatch.ts";

describe("getHerdrTaskStatus", () => {
	it("reports a gone agent with its surviving orphan worktree", async () => {
		const herdr: HerdrRunner = async () => {
			throw new Error("herdr agent get: agent_not_found: gone");
		};
		await expect(
			getHerdrTaskStatus(
				{ agent: "fix", worktreeRoots: ["/worktrees"] },
				{ herdr, findOrphan: () => "/worktrees/app/agent-fix" },
			),
		).resolves.toEqual({ status: "gone", worktreePath: "/worktrees/app/agent-fix" });
	});

	it("reports a gone agent as fully cleaned when no orphan remains", async () => {
		const herdr: HerdrRunner = async () => {
			throw new Error("herdr agent get: agent_not_found: gone");
		};
		await expect(
			getHerdrTaskStatus(
				{ agent: "fix", worktreeRoots: ["/worktrees"] },
				{ herdr, findOrphan: () => undefined },
			),
		).resolves.toEqual({ status: "gone", worktreePath: null });
	});
});
