import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	AmbiguousOrphanWorktreeError,
	baseRepoFromCommonDir,
	findOrphanWorktree,
	knownRepos,
	resolveRepo,
	worktreeTrust,
} from "../src/repos.ts";

let root: string;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 15_000 });
}

function newRepo(parent: string, name: string): string {
	const repo = join(parent, name);
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-q", "-b", "main");
	return repo;
}

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "pi-herdr-repos-")));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("knownRepos", () => {
	it("finds git checkouts directly under the roots, keyed by lowercased name", () => {
		const reposRoot = join(root, "github");
		newRepo(reposRoot, "Home-Ops");
		newRepo(reposRoot, "pi-extensions");
		mkdirSync(join(reposRoot, "not-a-repo"), { recursive: true });

		const repos = knownRepos([reposRoot]);
		expect(repos.get("home-ops")).toBe(join(reposRoot, "Home-Ops"));
		expect(repos.get("pi-extensions")).toBe(join(reposRoot, "pi-extensions"));
		expect(repos.has("not-a-repo")).toBe(false);
	});

	it("skips roots that do not exist", () => {
		expect(knownRepos([join(root, "missing")]).size).toBe(0);
	});
});

describe("findOrphanWorktree", () => {
	it("finds dispatch-named worktrees", () => {
		const worktreeRoot = join(root, "orphans");
		const path = join(worktreeRoot, "app", "agent-fix");
		mkdirSync(path, { recursive: true });
		expect(findOrphanWorktree("fix", [worktreeRoot])).toBe(path);
	});

	it("finds legacy bare-name worktrees", () => {
		const worktreeRoot = join(root, "bare-orphans");
		const path = join(worktreeRoot, "app", "fix");
		mkdirSync(path, { recursive: true });
		expect(findOrphanWorktree("fix", [worktreeRoot])).toBe(path);
	});

	it("refuses to choose between multiple matching worktrees", () => {
		const firstRoot = join(root, "ambiguous-a");
		const secondRoot = join(root, "ambiguous-b");
		mkdirSync(join(firstRoot, "app", "agent-fix"), { recursive: true });
		mkdirSync(join(secondRoot, "other", "agent-fix"), { recursive: true });
		expect(() => findOrphanWorktree("fix", [firstRoot, secondRoot])).toThrow(AmbiguousOrphanWorktreeError);
	});

	it("returns undefined when no matching worktree survives", () => {
		expect(findOrphanWorktree("missing", [join(root, "orphans")])).toBeUndefined();
	});

	it.each(["", ".", "..", "with/slash", "with\\slash"])("rejects invalid agent name %j", (name) => {
		expect(() => findOrphanWorktree(name, [join(root, "orphans")])).toThrow("non-empty path segment");
	});
});

describe("resolveRepo", () => {
	it("resolves a repo by short name case-insensitively", async () => {
		const reposRoot = join(root, "dev");
		const repo = newRepo(reposRoot, "MyApp");
		expect(await resolveRepo("myapp", "/anywhere", [reposRoot])).toBe(repo);
	});

	it("lists the known repos when the name is unknown", async () => {
		const reposRoot = join(root, "dev2");
		newRepo(reposRoot, "alpha");
		newRepo(reposRoot, "beta");
		await expect(resolveRepo("gamma", "/anywhere", [reposRoot])).rejects.toThrow(
			/Unknown repo "gamma".*alpha, beta/,
		);
	});

	it("falls back to the git root of cwd when no name is given", async () => {
		const repo = newRepo(join(root, "cwd-fallback"), "here");
		const nested = join(repo, "src", "deep");
		mkdirSync(nested, { recursive: true });
		expect(await resolveRepo(undefined, nested, [])).toBe(repo);
	});
});

describe("baseRepoFromCommonDir", () => {
	it("recovers the base repo from a linked worktree's common dir", () => {
		expect(baseRepoFromCommonDir("/Users/x/github/app/.git")).toBe("/Users/x/github/app");
	});

	it("returns undefined for a main checkout (relative .git)", () => {
		expect(baseRepoFromCommonDir(".git")).toBeUndefined();
	});
});

describe("worktreeTrust", () => {
	const options = {
		worktreeRoots: ["/home/u/.herdr/worktrees", "/home/u/.worktrees"],
		repoRoots: ["/home/u/github", "/home/u/Development"],
	};

	it("trusts a herdr worktree whose base repo lives under a repo root", () => {
		expect(worktreeTrust("/home/u/.herdr/worktrees/app/agent-fix", "/home/u/github/app", options)).toBe(
			"yes",
		);
	});

	it("stays undecided outside the worktree roots, even for a trusted base", () => {
		expect(worktreeTrust("/tmp/somewhere", "/home/u/github/app", options)).toBe("undecided");
	});

	it("stays undecided when the base repo is outside every repo root", () => {
		expect(worktreeTrust("/home/u/.worktrees/x", "/opt/checkouts/mystery", options)).toBe("undecided");
	});

	it("stays undecided when the base repo is unknown", () => {
		expect(worktreeTrust("/home/u/.worktrees/x", undefined, options)).toBe("undecided");
	});

	it("does not trust a sibling directory that merely shares the root as a prefix", () => {
		expect(worktreeTrust("/home/u/.worktrees-evil/x", "/home/u/github-evil/app", options)).toBe("undecided");
	});

	it("is immune to `..` traversal that lexically matches a root", () => {
		expect(worktreeTrust("/home/u/.worktrees/../outside", "/home/u/github/app", options)).toBe("undecided");
		expect(worktreeTrust("/home/u/.worktrees/x", "/home/u/github/../secrets/app", options)).toBe("undecided");
	});

	it("resolves symlinks before deciding trust", () => {
		const worktreesRoot = join(root, "trust", ".worktrees");
		const outside = join(root, "trust", "outside");
		mkdirSync(worktreesRoot, { recursive: true });
		mkdirSync(outside, { recursive: true });
		// A symlink under the managed root pointing outside it must not be trusted.
		const link = join(worktreesRoot, "escape");
		symlinkSync(outside, link);
		expect(
			worktreeTrust(link, join(root, "trust", "github", "app"), {
				worktreeRoots: [worktreesRoot],
				repoRoots: [join(root, "trust", "github")],
			}),
		).toBe("undecided");
	});
});
