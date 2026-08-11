import { describe, expect, it, vi } from "vitest";
import { cleanupHerdrTask, type GitRunner } from "../src/cleanup.ts";
import type { HerdrRunner } from "../src/dispatch.ts";

const worktreeRoot = "/home/luke/.herdr/worktrees";
const cwd = `${worktreeRoot}/app/agent-fix`;

function setup(
	options: {
		status?: string;
		cwd?: string;
		dirty?: string;
		unpushed?: string;
		missingUpstream?: boolean;
		removeFailsMissingWorkspace?: boolean;
		closeFails?: boolean;
	} = {},
) {
	const calls: string[][] = [];
	const herdr: HerdrRunner = async (args) => {
		calls.push(args);
		if (args[0] === "agent") {
			return {
				agent: {
					agent_status: options.status ?? "done",
					cwd: options.cwd ?? cwd,
					workspace_id: "ws-1",
				},
			};
		}
		if (args[0] === "worktree" && options.removeFailsMissingWorkspace) {
			throw new Error("herdr worktree remove: workspace_not_found: workspace does not exist");
		}
		if (args[0] === "workspace" && options.closeFails) throw new Error("already closed");
		return {};
	};
	const git = vi.fn<GitRunner>(async (args) => {
		calls.push(["git", ...args]);
		if (args.includes("status")) return options.dirty ?? "";
		if (args.includes("rev-list")) {
			if (options.missingUpstream) throw new Error("no upstream");
			return options.unpushed ?? "";
		}
		if (args.includes("rev-parse")) return "/home/luke/github/app/.git\n";
		if (args.includes("worktree")) return "";
		throw new Error(`unexpected git command: ${args.join(" ")}`);
	});
	return { herdr, git, calls };
}

const cleanup = (herdr: HerdrRunner, git: GitRunner, force = false) =>
	cleanupHerdrTask({ agent: "fix", force, worktreeRoots: [worktreeRoot] }, { herdr, git });

describe("cleanupHerdrTask", () => {
	it("refuses a dirty worktree with listed problems", async () => {
		const { herdr, git } = setup({ dirty: " M src/index.ts\n?? notes.txt\n" });
		const result = await cleanup(herdr, git);
		expect(result).toMatchObject({
			cleaned: false,
			problems: ["uncommitted changes:\nM src/index.ts\n?? notes.txt"],
		});
	});

	it("refuses unpushed commits", async () => {
		const { herdr, git } = setup({ unpushed: "abc123 feat: unfinished\n" });
		const result = await cleanup(herdr, git);
		expect(result.problems).toEqual(["unpushed commits:\nabc123 feat: unfinished"]);
	});

	it("refuses a branch with no upstream", async () => {
		const { herdr, git } = setup({ missingUpstream: true });
		const result = await cleanup(herdr, git);
		expect(result.problems).toEqual(["branch has no upstream (never pushed)"]);
	});

	it.each(["working", "blocked"])("refuses while the agent is %s", async (status) => {
		const { herdr, git } = setup({ status });
		const result = await cleanup(herdr, git);
		expect(result.problems).toContain(`agent is still ${status}`);
	});

	it("refuses agents outside configured worktree roots", async () => {
		const { herdr, git } = setup({ cwd: "/home/luke/github/app" });
		await expect(cleanup(herdr, git)).rejects.toThrow("Only dispatched-task worktrees are removable");
		expect(git).not.toHaveBeenCalled();
	});

	it("force bypasses state and git safety checks", async () => {
		const { herdr, git, calls } = setup({
			status: "working",
			dirty: " M src/index.ts",
			unpushed: "abc123 local",
		});
		await expect(cleanup(herdr, git, true)).resolves.toMatchObject({ cleaned: true });
		expect(git).not.toHaveBeenCalled();
		expect(calls.at(-1)).toEqual(["worktree", "remove", "--workspace", "ws-1", "--force"]);
	});

	it("removes the worktree directly without invalidating its workspace id first", async () => {
		const { herdr, git, calls } = setup();
		await expect(cleanup(herdr, git)).resolves.toEqual({
			cleaned: true,
			workspaceId: "ws-1",
			worktreePath: cwd,
		});
		expect(calls).toEqual([
			["agent", "get", "fix"],
			["git", "-C", cwd, "status", "--porcelain"],
			["git", "-C", cwd, "rev-list", "--oneline", "@{upstream}..HEAD"],
			["worktree", "remove", "--workspace", "ws-1"],
		]);
	});

	it("falls back to workspace close and git removal when the workspace is missing", async () => {
		const { herdr, git, calls } = setup({ removeFailsMissingWorkspace: true });
		await expect(cleanup(herdr, git)).resolves.toMatchObject({ cleaned: true });
		expect(calls).toEqual([
			["agent", "get", "fix"],
			["git", "-C", cwd, "status", "--porcelain"],
			["git", "-C", cwd, "rev-list", "--oneline", "@{upstream}..HEAD"],
			["worktree", "remove", "--workspace", "ws-1"],
			["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
			["workspace", "close", "ws-1"],
			["git", "-C", "/home/luke/github/app", "worktree", "remove", cwd],
			["git", "-C", "/home/luke/github/app", "worktree", "prune"],
		]);
	});

	it("tolerates an already-missing workspace during the git fallback", async () => {
		const { herdr, git } = setup({ removeFailsMissingWorkspace: true, closeFails: true });
		await expect(cleanup(herdr, git)).resolves.toMatchObject({ cleaned: true });
	});
});
