import { describe, expect, it, vi } from "vitest";
import { cleanupHerdrTask, type GitRunner } from "../src/cleanup.ts";
import type { HerdrRunner } from "../src/dispatch.ts";
import { AmbiguousOrphanWorktreeError } from "../src/repos.ts";

const worktreeRoot = "/home/luke/.herdr/worktrees";
const cwd = `${worktreeRoot}/app/agent-fix`;

function setup(
	options: {
		status?: string;
		cwd?: string;
		dirty?: string;
		unpushed?: string;
		missingUpstream?: boolean;
		revListError?: Error;
		removeFailsMissingWorkspace?: boolean;
		agentNotFound?: boolean;
	} = {},
) {
	const calls: string[][] = [];
	const herdr: HerdrRunner = async (args) => {
		calls.push(args);
		if (args[0] === "agent") {
			if (options.agentNotFound) throw new Error("herdr agent get: agent_not_found: gone");
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
		return {};
	};
	const git = vi.fn<GitRunner>(async (args) => {
		calls.push(["git", ...args]);
		if (args.includes("status")) return options.dirty ?? "";
		if (args.includes("rev-list")) {
			if (options.revListError) throw options.revListError;
			if (options.missingUpstream) throw new Error("fatal: no upstream configured for branch 'agent/fix'");
			return options.unpushed ?? "";
		}
		if (args.includes("rev-parse")) return "/home/luke/github/app/.git\n";
		if (args.includes("worktree")) return "";
		throw new Error(`unexpected git command: ${args.join(" ")}`);
	});
	return { herdr, git, calls };
}

const cleanup = (herdr: HerdrRunner, git: GitRunner, force = false) =>
	cleanupHerdrTask(
		{ agent: "fix", force, worktreeRoots: [worktreeRoot] },
		{ herdr, git, existsPath: () => true },
	);

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

	it("refuses a branch with no upstream even when HEAD exists on another remote ref", async () => {
		const { herdr, git } = setup({ missingUpstream: true });
		const result = await cleanup(herdr, git);
		expect(result.problems).toEqual(["branch has no upstream (never pushed)"]);
		expect(git.mock.calls.some(([args]) => args.includes("log"))).toBe(false);
	});

	it("propagates unexpected rev-list failures", async () => {
		const { herdr, git } = setup({ revListError: new Error("fatal: corrupt repository") });
		await expect(cleanup(herdr, git)).rejects.toThrow("corrupt repository");
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
			removal: "herdr",
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

	it("falls back to git removal when the workspace is missing", async () => {
		const { herdr, git, calls } = setup({ removeFailsMissingWorkspace: true });
		await expect(cleanup(herdr, git)).resolves.toMatchObject({ cleaned: true });
		expect(calls).toEqual([
			["agent", "get", "fix"],
			["git", "-C", cwd, "status", "--porcelain"],
			["git", "-C", cwd, "rev-list", "--oneline", "@{upstream}..HEAD"],
			["worktree", "remove", "--workspace", "ws-1"],
			["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
			["git", "-C", "/home/luke/github/app", "worktree", "remove", cwd],
			["git", "-C", "/home/luke/github/app", "worktree", "prune"],
		]);
	});

	it("reports nothing to clean when herdr forgot the agent and no orphan remains", async () => {
		const { herdr, git } = setup({ agentNotFound: true });
		await expect(
			cleanupHerdrTask(
				{ agent: "fix", worktreeRoots: [worktreeRoot] },
				{ herdr, git, findOrphan: () => undefined },
			),
		).resolves.toEqual({
			cleaned: false,
			reason: "nothing-found",
			workspaceId: null,
			worktreePath: null,
		});
		expect(git).not.toHaveBeenCalled();
	});

	it("refuses ambiguous orphan matches without running git", async () => {
		const { herdr, git } = setup({ agentNotFound: true });
		const matches = [`${worktreeRoot}/app/agent-fix`, `${worktreeRoot}/other/agent-fix`];
		await expect(
			cleanupHerdrTask(
				{ agent: "fix", worktreeRoots: [worktreeRoot] },
				{
					findOrphan: () => {
						throw new AmbiguousOrphanWorktreeError(matches);
					},
					git,
					herdr,
				},
			),
		).resolves.toMatchObject({ cleaned: false, reason: "ambiguous", matches });
		expect(git).not.toHaveBeenCalled();
	});

	it("removes the surviving workspace when the worktree path is already gone", async () => {
		const { herdr, git, calls } = setup();
		await expect(
			cleanupHerdrTask(
				{ agent: "fix", worktreeRoots: [worktreeRoot] },
				{ herdr, git, existsPath: () => false },
			),
		).resolves.toEqual({
			cleaned: true,
			removal: "herdr",
			note: `worktree path ${cwd} was already deleted; removed the surviving workspace`,
			workspaceId: "ws-1",
			worktreePath: cwd,
		});
		expect(git).not.toHaveBeenCalled();
		expect(calls).toEqual([
			["agent", "get", "fix"],
			["worktree", "remove", "--workspace", "ws-1"],
		]);
	});

	it("reports gone only when the workspace itself is confirmed gone", async () => {
		const { herdr, git, calls } = setup({ removeFailsMissingWorkspace: true });
		await expect(
			cleanupHerdrTask(
				{ agent: "fix", worktreeRoots: [worktreeRoot] },
				{ herdr, git, existsPath: () => false },
			),
		).resolves.toEqual({
			cleaned: true,
			removal: "gone",
			note: `worktree path ${cwd} no longer exists; nothing to remove`,
			workspaceId: "ws-1",
			worktreePath: cwd,
		});
		expect(git).not.toHaveBeenCalled();
		expect(calls).toEqual([
			["agent", "get", "fix"],
			["worktree", "remove", "--workspace", "ws-1"],
		]);
	});

	it.each(["working", "blocked"])(
		"refuses to remove a surviving workspace while the agent is %s",
		async (status) => {
			const { herdr, git, calls } = setup({ status });
			await expect(
				cleanupHerdrTask(
					{ agent: "fix", worktreeRoots: [worktreeRoot] },
					{ herdr, git, existsPath: () => false },
				),
			).resolves.toMatchObject({
				cleaned: false,
				problems: [`agent is still ${status}`],
			});
			expect(calls).toEqual([["agent", "get", "fix"]]);
		},
	);

	it("force removes a surviving workspace for a gone checkout", async () => {
		const { herdr, git, calls } = setup({ status: "working" });
		await expect(
			cleanupHerdrTask(
				{ agent: "fix", force: true, worktreeRoots: [worktreeRoot] },
				{ herdr, git, existsPath: () => false },
			),
		).resolves.toMatchObject({ cleaned: true, removal: "herdr" });
		expect(calls).toEqual([
			["agent", "get", "fix"],
			["worktree", "remove", "--workspace", "ws-1", "--force"],
		]);
	});

	it("treats a vanished orphan checkout as already cleaned", async () => {
		const { herdr, git } = setup({ agentNotFound: true });
		await expect(
			cleanupHerdrTask(
				{ agent: "fix", worktreeRoots: [worktreeRoot] },
				{ herdr, git, findOrphan: () => cwd, existsPath: () => false },
			),
		).resolves.toMatchObject({ cleaned: true, removal: "gone", workspaceId: null });
		expect(git).not.toHaveBeenCalled();
	});

	it("cleans an orphan when herdr has forgotten the agent", async () => {
		const { herdr, git, calls } = setup({ agentNotFound: true });
		await expect(
			cleanupHerdrTask(
				{ agent: "fix", worktreeRoots: [worktreeRoot] },
				{ herdr, git, findOrphan: () => cwd, existsPath: () => true },
			),
		).resolves.toMatchObject({ cleaned: true, removal: "git", workspaceId: null });
		expect(calls).toContainEqual(["git", "-C", "/home/luke/github/app", "worktree", "remove", cwd]);
	});

	it("looks up a live pane id without searching orphans by that id", async () => {
		const { herdr, git, calls } = setup();
		let searched = 0;
		await expect(
			cleanupHerdrTask(
				{ agent: "w7:p3", worktreeRoots: [worktreeRoot] },
				{
					herdr,
					existsPath: () => true,
					git,
					findOrphan: () => {
						searched += 1;
						return cwd;
					},
				},
			),
		).resolves.toMatchObject({ cleaned: true, removal: "herdr" });
		expect(searched).toBe(0);
		expect(calls[0]).toEqual(["agent", "get", "w7:p3"]);
	});

	it("does not search orphans when a gone pane id has no live agent", async () => {
		const { herdr, git } = setup({ agentNotFound: true });
		let searched = 0;
		await expect(
			cleanupHerdrTask(
				{ agent: "w7:p3", worktreeRoots: [worktreeRoot] },
				{
					herdr,
					git,
					findOrphan: () => {
						searched += 1;
						return cwd;
					},
				},
			),
		).resolves.toEqual({
			cleaned: false,
			reason: "nothing-found",
			workspaceId: null,
			worktreePath: null,
		});
		expect(searched).toBe(0);
		expect(git).not.toHaveBeenCalled();
	});

	it("treats a git removal failure from a raced deletion as success and prunes", async () => {
		const { herdr, calls } = setup({ removeFailsMissingWorkspace: true });
		const git: GitRunner = async (args) => {
			calls.push(["git", ...args]);
			if (args.includes("status")) return "";
			if (args.includes("rev-list")) return "";
			if (args.includes("rev-parse")) return "/home/luke/github/app/.git\n";
			if (args.includes("remove")) throw new Error(`fatal: '${cwd}' is not a working tree`);
			if (args.includes("prune")) return "";
			throw new Error(`unexpected git command: ${args.join(" ")}`);
		};
		await expect(
			cleanupHerdrTask(
				{ agent: "fix", worktreeRoots: [worktreeRoot] },
				{ herdr, git, existsPath: () => true },
			),
		).resolves.toMatchObject({
			cleaned: true,
			removal: "gone",
			note: `worktree ${cwd} was already gone; pruned stale metadata`,
		});
		expect(calls.at(-1)).toEqual(["git", "-C", "/home/luke/github/app", "worktree", "prune"]);
	});

	it("rethrows git removal failures unrelated to missing checkouts", async () => {
		const { herdr, calls } = setup({ removeFailsMissingWorkspace: true });
		const git: GitRunner = async (args) => {
			calls.push(["git", ...args]);
			if (args.includes("status")) return "";
			if (args.includes("rev-list")) return "";
			if (args.includes("rev-parse")) return "/home/luke/github/app/.git\n";
			if (args.includes("remove")) throw new Error("fatal: contains modified or untracked files");
			throw new Error(`unexpected git command: ${args.join(" ")}`);
		};
		await expect(
			cleanupHerdrTask(
				{ agent: "fix", worktreeRoots: [worktreeRoot] },
				{ herdr, git, existsPath: () => true },
			),
		).rejects.toThrow(/modified or untracked/);
	});

	it("passes --force to the git fallback before the worktree path", async () => {
		const { herdr, git, calls } = setup({ agentNotFound: true });
		await cleanupHerdrTask(
			{ agent: "fix", force: true, worktreeRoots: [worktreeRoot] },
			{ herdr, git, findOrphan: () => cwd, existsPath: () => true },
		);
		expect(calls).toContainEqual([
			"git",
			"-C",
			"/home/luke/github/app",
			"worktree",
			"remove",
			"--force",
			cwd,
		]);
	});
});
