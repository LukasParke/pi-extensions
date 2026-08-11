import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { herdr as realHerdr } from "./cli.ts";
import type { HerdrRunner } from "./dispatch.ts";
import { baseRepoFromCommonDir, isPathInside } from "./repos.ts";

const exec = promisify(execFile);

export type GitRunner = (args: string[]) => Promise<string>;

export interface CleanupOptions {
	herdr?: HerdrRunner;
	git?: GitRunner;
}

export interface CleanupResult {
	cleaned: boolean;
	problems?: string[];
	workspaceId: string;
	worktreePath: string;
}

const realGit: GitRunner = async (args) => {
	const { stdout } = await exec("git", args, { timeout: 15_000 });
	return stdout;
};

export async function cleanupHerdrTask(
	input: { agent: string; force?: boolean; worktreeRoots: string[] },
	options: CleanupOptions = {},
): Promise<CleanupResult> {
	const herdr = options.herdr ?? realHerdr;
	const git = options.git ?? realGit;
	const info = await herdr(["agent", "get", input.agent]);
	if (!info?.agent) throw new Error(`herdr returned no agent named "${input.agent}"`);

	const status: string = info.agent.agent_status;
	const cwd: string = info.agent.cwd;
	const workspaceId: string = info.agent.workspace_id;

	if (!input.worktreeRoots.some((root) => isPathInside(cwd, root))) {
		throw new Error(
			`Refusing cleanup: agent cwd ${cwd} is not a herdr-managed worktree. Only dispatched-task worktrees are removable.`,
		);
	}

	if (!input.force) {
		const problems: string[] = [];
		if (status === "working" || status === "blocked") problems.push(`agent is still ${status}`);

		const dirty = await git(["-C", cwd, "status", "--porcelain"]);
		if (dirty.trim()) problems.push(`uncommitted changes:\n${dirty.trim()}`);

		try {
			const unpushed = await git(["-C", cwd, "rev-list", "--oneline", "@{upstream}..HEAD"]);
			if (unpushed.trim()) problems.push(`unpushed commits:\n${unpushed.trim()}`);
		} catch {
			problems.push("branch has no upstream (never pushed)");
		}

		if (problems.length) return { cleaned: false, problems, workspaceId, worktreePath: cwd };
	}

	const removeArgs = ["worktree", "remove", "--workspace", workspaceId];
	if (input.force) removeArgs.push("--force");
	try {
		await herdr(removeArgs);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes("workspace_not_found")) throw error;

		const commonDir = await git(["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
		const baseRepo = baseRepoFromCommonDir(commonDir.trim());
		if (!baseRepo) throw new Error(`Cannot find base repo for orphaned worktree ${cwd}`);
		try {
			await herdr(["workspace", "close", workspaceId]);
		} catch {
			// The workspace is already absent; remove the orphaned checkout below.
		}
		const gitRemoveArgs = ["-C", baseRepo, "worktree", "remove"];
		if (input.force) gitRemoveArgs.push("--force");
		gitRemoveArgs.push(cwd);
		await git(gitRemoveArgs);
		await git(["-C", baseRepo, "worktree", "prune"]);
	}

	return { cleaned: true, workspaceId, worktreePath: cwd };
}
