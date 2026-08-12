import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { herdr as realHerdr } from "./cli.ts";
import type { HerdrRunner } from "./dispatch.ts";
import { assertAgentTarget, isAgentName } from "./names.ts";
import {
	AmbiguousOrphanWorktreeError,
	baseRepoFromCommonDir,
	findOrphanWorktree,
	isPathInside,
} from "./repos.ts";

const exec = promisify(execFile);

export type GitRunner = (args: string[]) => Promise<string>;

export interface CleanupOptions {
	herdr?: HerdrRunner;
	git?: GitRunner;
	findOrphan?: (agentName: string, roots: string[]) => string | undefined;
}

export interface CleanupResult {
	cleaned: boolean;
	problems?: string[];
	reason?: "nothing-found" | "ambiguous";
	matches?: string[];
	removal?: "herdr" | "git";
	workspaceId: string | null;
	worktreePath: string | null;
}

const realGit: GitRunner = async (args) => {
	const { stdout } = await exec("git", args, { timeout: 30_000 });
	return stdout;
};

export async function cleanupHerdrTask(
	input: { agent: string; force?: boolean; worktreeRoots: string[] },
	options: CleanupOptions = {},
): Promise<CleanupResult> {
	assertAgentTarget(input.agent);
	const herdr = options.herdr ?? realHerdr;
	const git = options.git ?? realGit;
	let status: string;
	let cwd: string;
	let workspaceId: string | undefined;
	try {
		const info = await herdr(["agent", "get", input.agent]);
		if (!info?.agent) throw new Error(`herdr returned no agent named "${input.agent}"`);
		status = info.agent.agent_status;
		cwd = info.agent.cwd;
		workspaceId = info.agent.workspace_id;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes("agent_not_found")) throw error;
		try {
			const orphan = isAgentName(input.agent)
				? (options.findOrphan ?? findOrphanWorktree)(input.agent, input.worktreeRoots)
				: undefined;
			if (!orphan) {
				return {
					cleaned: false,
					reason: "nothing-found",
					workspaceId: null,
					worktreePath: null,
				};
			}
			status = "gone";
			cwd = orphan;
		} catch (orphanError) {
			if (!(orphanError instanceof AmbiguousOrphanWorktreeError)) throw orphanError;
			return {
				cleaned: false,
				reason: "ambiguous",
				matches: orphanError.matches,
				workspaceId: null,
				worktreePath: null,
			};
		}
	}

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
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("no upstream")) throw error;
			problems.push("branch has no upstream (never pushed)");
		}

		if (problems.length) {
			return { cleaned: false, problems, workspaceId: workspaceId ?? null, worktreePath: cwd };
		}
	}

	if (workspaceId) {
		const removeArgs = ["worktree", "remove", "--workspace", workspaceId];
		if (input.force) removeArgs.push("--force");
		try {
			await herdr(removeArgs);
			return {
				cleaned: true,
				removal: "herdr",
				workspaceId,
				worktreePath: cwd,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("workspace_not_found")) throw error;
		}
	}

	const commonDir = await git(["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const baseRepo = baseRepoFromCommonDir(commonDir.trim());
	if (!baseRepo) throw new Error(`Cannot find base repo for orphaned worktree ${cwd}`);
	const gitRemoveArgs = ["-C", baseRepo, "worktree", "remove"];
	if (input.force) gitRemoveArgs.push("--force");
	gitRemoveArgs.push(cwd);
	await git(gitRemoveArgs);
	await git(["-C", baseRepo, "worktree", "prune"]);

	return {
		cleaned: true,
		removal: "git",
		workspaceId: workspaceId ?? null,
		worktreePath: cwd,
	};
}
