/** Repo discovery and worktree trust decisions. Pure given injected roots. */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { assertAgentName } from "./names.ts";

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

export class AmbiguousOrphanWorktreeError extends Error {
	constructor(readonly matches: string[]) {
		super(`Multiple orphaned worktrees match this agent:\n${matches.join("\n")}`);
	}
}

/** Locate a dispatched checkout after herdr forgets its closed workspace. */
export function findOrphanWorktree(agentName: string, worktreeRoots: string[]): string | undefined {
	assertAgentName(agentName);
	const matches: string[] = [];
	for (const root of worktreeRoots) {
		if (!existsSync(root)) continue;
		for (const repo of readdirSync(root, { withFileTypes: true })) {
			if (!repo.isDirectory()) continue;
			for (const candidate of [`agent-${agentName}`, agentName]) {
				const path = join(root, repo.name, candidate);
				if (existsSync(path)) matches.push(path);
			}
		}
	}
	if (matches.length > 1) throw new AmbiguousOrphanWorktreeError(matches);
	return matches[0];
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

/** Resolve symlinks when the path exists; otherwise normalize lexically. */
function canonicalize(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** True containment, immune to `..` segments and prefix-sharing siblings. */
export function isPathInside(child: string, parent: string): boolean {
	const rel = relative(canonicalize(parent), canonicalize(child));
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Trust a worktree iff it sits under a managed worktree root AND its base repo
 * lives under a known repo root. Anything else stays undecided so pi's normal
 * trust prompt applies. Paths are canonicalized (symlinks resolved, `..`
 * collapsed) before any containment check.
 */
export function worktreeTrust(
	cwd: string,
	baseRepo: string | undefined,
	options: { worktreeRoots: string[]; repoRoots: string[] },
): TrustDecision {
	const inWorktreeRoot = options.worktreeRoots.some((root) => isPathInside(cwd, root));
	if (!inWorktreeRoot || !baseRepo) return "undecided";
	return options.repoRoots.some((root) => isPathInside(baseRepo, root)) ? "yes" : "undecided";
}
