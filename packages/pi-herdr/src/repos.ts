/** Repo discovery and worktree trust decisions. Pure given injected roots. */

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Git checkouts directly under the given roots, keyed by lowercased folder name. */
export function knownRepos(repoRoots: string[]): Map<string, string> {
	const repos = new Map<string, string>();
	for (const root of repoRoots) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (entry.isDirectory() && existsSync(join(root, entry.name, ".git"))) {
				repos.set(entry.name.toLowerCase(), join(root, entry.name));
			}
		}
	}
	return repos;
}

/** Resolve a repo by short name, or fall back to the git root of `cwd`. */
export async function resolveRepo(
	name: string | undefined,
	cwd: string,
	repoRoots: string[],
): Promise<string> {
	if (name) {
		const repos = knownRepos(repoRoots);
		const found = repos.get(name.toLowerCase());
		if (found) return found;
		throw new Error(`Unknown repo "${name}". Known: ${[...repos.keys()].sort().join(", ")}`);
	}
	const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 10_000 });
	return stdout.trim();
}

/** The base repo of a linked worktree, from git's common dir. */
export function baseRepoFromCommonDir(commonDir: string): string | undefined {
	// Linked worktree: common dir is <base-repo>/.git
	return commonDir.endsWith("/.git") ? commonDir.slice(0, -"/.git".length) : undefined;
}

export async function worktreeBaseRepo(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
			timeout: 10_000,
		});
		return baseRepoFromCommonDir(stdout.trim());
	} catch {
		return undefined;
	}
}

export type TrustDecision = "yes" | "undecided";

/**
 * Trust a worktree iff it sits under a managed worktree root AND its base repo
 * lives under a known repo root. Anything else stays undecided so pi's normal
 * trust prompt applies.
 */
export function worktreeTrust(
	cwd: string,
	baseRepo: string | undefined,
	options: { worktreeRoots: string[]; repoRoots: string[] },
): TrustDecision {
	const inWorktreeRoot = options.worktreeRoots.some((root) => cwd.startsWith(root + "/"));
	if (!inWorktreeRoot || !baseRepo) return "undecided";
	return options.repoRoots.some((root) => baseRepo.startsWith(root + "/")) ? "yes" : "undecided";
}
