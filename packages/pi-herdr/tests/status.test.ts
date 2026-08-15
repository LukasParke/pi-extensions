import { describe, expect, it } from "vitest";
import { getHerdrTaskStatus } from "../src/status.ts";
import type { HerdrRunner } from "../src/dispatch.ts";
import { AmbiguousOrphanWorktreeError } from "../src/repos.ts";

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

	it("reports ambiguous orphan worktrees without selecting one", async () => {
		const herdr: HerdrRunner = async () => {
			throw new Error("herdr agent get: agent_not_found: gone");
		};
		const matches = ["/worktrees/app/agent-fix", "/worktrees/other/agent-fix"];
		await expect(
			getHerdrTaskStatus(
				{ agent: "fix", worktreeRoots: ["/worktrees"] },
				{
					findOrphan: () => {
						throw new AmbiguousOrphanWorktreeError(matches);
					},
					herdr,
				},
			),
		).resolves.toEqual({ status: "gone", worktreePath: null, matches });
	});

	it("reports a gone agent when no orphan remains", async () => {
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

	it("degrades to an unknown status when agent status polling times out", async () => {
		const herdr: HerdrRunner = async () => {
			throw new Error("herdr agent get: timed out waiting for agent status");
		};
		let searched = 0;
		await expect(
			getHerdrTaskStatus(
				{ agent: "fix", worktreeRoots: ["/worktrees"] },
				{
					herdr,
					findOrphan: () => {
						searched += 1;
						return "/worktrees/app/agent-fix";
					},
				},
			),
		).resolves.toEqual({ status: "unknown", note: "herdr agent get: timed out waiting for agent status" });
		expect(searched).toBe(0);
	});

	it("propagates other agent-get errors", async () => {
		const herdr: HerdrRunner = async () => {
			throw new Error("herdr agent get: server_unavailable: gone");
		};
		await expect(
			getHerdrTaskStatus({ agent: "fix", worktreeRoots: ["/worktrees"] }, { herdr }),
		).rejects.toThrow(/server_unavailable/);
	});

	it("looks up a live pane id without treating it as an agent name", async () => {
		const herdr: HerdrRunner = async (args) => {
			expect(args).toEqual(["agent", "get", "w7:p3"]);
			return { agent: { agent_status: "idle", cwd: "/worktrees/app/agent-fix" } };
		};
		await expect(
			getHerdrTaskStatus({ agent: "w7:p3", worktreeRoots: ["/worktrees"] }, { herdr }),
		).resolves.toEqual({ status: "idle", cwd: "/worktrees/app/agent-fix" });
	});

	it("does not search orphans by pane id", async () => {
		let searched = 0;
		const herdr: HerdrRunner = async () => {
			throw new Error("herdr agent get: agent_not_found: gone");
		};
		await expect(
			getHerdrTaskStatus(
				{ agent: "w7:p3", worktreeRoots: ["/worktrees"] },
				{
					herdr,
					findOrphan: () => {
						searched += 1;
						return "/worktrees/app/agent-fix";
					},
				},
			),
		).resolves.toEqual({ status: "gone", worktreePath: null });
		expect(searched).toBe(0);
	});
});
