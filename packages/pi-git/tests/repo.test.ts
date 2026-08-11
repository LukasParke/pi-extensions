import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	branches,
	commitsBetween,
	diff,
	headCommit,
	isSafeRevisionSpec,
	parseRepoSlug,
	remoteUrl,
	status,
	worktrees,
} from "../src/repo.ts";

/**
 * Git reads against scripted fixture repos (AC-7.18).
 *
 * The spec lists the states that must work: clean, dirty, conflicted, detached, no-remote, submodule.
 * Each is BUILT by running git rather than committed as an archive, so the fixtures cannot drift from
 * what git actually produces and a git upgrade is caught here rather than in the field.
 */

/**
 * A local `GitExec`, defined here rather than imported from `host core`.
 *
 * `integrations` must not depend on `core` — the dependency runs the other way, since the daemon
 * consumes adapters. `GitExec` is the narrow seam in `repo.ts` for exactly this reason: the git
 * functions need four fields off a process result and nothing else, so both a real `LocalHostExec`
 * and this twenty-line stand-in satisfy them. Phase 9's SSH implementation will too.
 */
class TestExec {
	async run(
		command: string,
		args: readonly string[],
		opts: { cwd: string; timeoutMs?: number; maxBuffer?: number },
	): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
		try {
			const stdout = execFileSync(command, [...args], {
				cwd: opts.cwd,
				encoding: "utf8",
				env: { ...process.env, ...GIT_ENV, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
				timeout: opts.timeoutMs ?? 15_000,
				maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
			});
			return { stdout, stderr: "", code: 0, timedOut: false };
		} catch (e) {
			const err = e as { stdout?: string; stderr?: string; status?: number };
			return {
				stdout: err.stdout ?? "",
				stderr: err.stderr ?? "",
				code: err.status ?? 1,
				timedOut: false,
			};
		}
	}
}

const GIT_ENV = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	HOME: "/nonexistent-for-tests",
};

let root: string;
const exec = new TestExec();

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...GIT_ENV },
		timeout: 15_000,
	});
}

/** A repo with one commit, ready to be dirtied. */
function newRepo(name: string): string {
	const repo = join(root, name);
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "x@y.z");
	git(repo, "config", "user.name", "X");
	writeFileSync(join(repo, "README.md"), "# fixture\n");
	writeFileSync(join(repo, "src.ts"), "export const a = 1\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "initial commit");
	return repo;
}

beforeAll(() => {
	/**
	 * Resolved, because git reports resolved paths.
	 *
	 * On macOS `/var` is a symlink to `/private/var`, so `git worktree list` returns a path that does
	 * not string-match the one the test created. Phase 4 shipped a bug from comparing one side
	 * unresolved, and this is the same trap in a new place — which is why the invariant is written down
	 * rather than fixed twice.
	 */
	root = realpathSync(mkdtempSync(join(tmpdir(), "pi-gitrepo-")));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("status across the states the spec names (AC-7.18)", () => {
	it("a CLEAN repo reports its branch and no files", async () => {
		const repo = newRepo("clean");
		const s = await status(exec, repo);
		expect(s.isRepo).toBe(true);
		expect(s.branch).toBe("main");
		expect(s.detached).toBe(false);
		expect(s.files).toEqual([]);
		expect(s.conflicted).toBe(false);
	});

	it("a DIRTY repo distinguishes staged, unstaged and untracked", async () => {
		const repo = newRepo("dirty");
		writeFileSync(join(repo, "src.ts"), "export const a = 2\n");
		writeFileSync(join(repo, "staged.ts"), "export const b = 1\n");
		writeFileSync(join(repo, "untracked.txt"), "loose\n");
		git(repo, "add", "staged.ts");

		const s = await status(exec, repo);
		const byPath = Object.fromEntries(s.files.map((f) => [f.path, f]));

		// Statuses are WORDS, not letter codes: a screen reader cannot announce "M".
		expect(byPath["src.ts"]?.status).toBe("modified");
		expect(byPath["src.ts"]?.staged).toBe(false);
		expect(byPath["staged.ts"]?.status).toBe("added");
		expect(byPath["staged.ts"]?.staged).toBe(true);
		expect(byPath["untracked.txt"]?.status).toBe("untracked");
	});

	it("a RENAME carries its original path", async () => {
		/**
		 * The `-z` trap: with NUL separators the original path is the NEXT record, not a tab-separated
		 * suffix. Reading it the wrong way works without `-z` and breaks with it — and only on renamed
		 * files, so it survives casual testing.
		 */
		const repo = newRepo("renamed");
		git(repo, "mv", "src.ts", "moved.ts");

		const s = await status(exec, repo);
		const r = s.files.find((f) => f.status === "renamed");
		expect(r).toBeDefined();
		expect(r?.path).toBe("moved.ts");
		expect(r?.oldPath).toBe("src.ts");
	});

	it("a filename containing a newline does not become two files", async () => {
		// Works until someone commits `weird\nname.txt`, then a '\n' split invents files that do not
		// exist. `-z` makes it impossible rather than unlikely.
		const repo = newRepo("newline-name");
		const weird = "we\nird.txt";
		writeFileSync(join(repo, weird), "x\n");

		const s = await status(exec, repo);
		const found = s.files.filter((f) => f.status === "untracked");
		expect(found).toHaveLength(1);
		expect(found[0]!.path).toContain("\n");
	});

	it("a CONFLICTED repo lists the unresolved paths", async () => {
		const repo = newRepo("conflicted");
		git(repo, "checkout", "-q", "-b", "other");
		writeFileSync(join(repo, "src.ts"), "export const a = 99\n");
		git(repo, "commit", "-qam", "other side");
		git(repo, "checkout", "-q", "main");
		writeFileSync(join(repo, "src.ts"), "export const a = 42\n");
		git(repo, "commit", "-qam", "main side");
		try {
			git(repo, "merge", "other");
		} catch {
			// Expected: the merge conflicts, which is the fixture.
		}

		const s = await status(exec, repo);
		expect(s.conflicted).toBe(true);
		expect(s.conflictPaths).toContain("src.ts");
		expect(s.files.find((f) => f.path === "src.ts")?.status).toBe("conflicted");
	});

	it("a DETACHED head is reported as detached, not as a branch named HEAD", async () => {
		const repo = newRepo("detached");
		const sha = git(repo, "rev-parse", "HEAD").trim();
		git(repo, "checkout", "-q", sha);

		const s = await status(exec, repo);
		expect(s.detached).toBe(true);
		// A UI that showed "on branch (detached)" would be lying about a state that surprises people
		// mid-rebase.
		expect(s.branch).toBe(null);
	});

	it("a NO-REMOTE repo has no upstream and that is not an error", async () => {
		const repo = newRepo("no-remote");
		const s = await status(exec, repo);
		expect(s.upstream).toBe(null);
		expect(s.ahead).toBe(0);
		expect(s.behind).toBe(0);
		expect(await remoteUrl(exec, repo)).toBe(null);
	});

	it("ahead and behind are counted against a real upstream", async () => {
		const origin = newRepo("origin-bare-src");
		const bare = join(root, "origin.git");
		execFileSync("git", ["clone", "--bare", "-q", origin, bare], {
			env: { ...process.env, ...GIT_ENV },
			timeout: 15_000,
		});
		const clone = join(root, "clone");
		execFileSync("git", ["clone", "-q", bare, clone], {
			env: { ...process.env, ...GIT_ENV },
			timeout: 15_000,
		});
		git(clone, "config", "user.email", "x@y.z");
		git(clone, "config", "user.name", "X");
		writeFileSync(join(clone, "local.txt"), "ahead\n");
		git(clone, "add", "-A");
		git(clone, "commit", "-qm", "local only");

		const s = await status(exec, clone);
		expect(s.upstream).toMatch(/origin\//);
		expect(s.ahead).toBe(1);
		expect(s.behind).toBe(0);
	});

	it("a NON-REPO directory reports isRepo false rather than throwing", async () => {
		// Absence of git is never an error (the Phase 4 rule, kept).
		const plain = join(root, "not-a-repo");
		mkdirSync(plain, { recursive: true });
		const s = await status(exec, plain);
		expect(s.isRepo).toBe(false);
		expect(s.files).toEqual([]);
	});

	it("a SUBMODULE is reported without recursing into it", async () => {
		const inner = newRepo("submodule-inner");
		const outer = newRepo("submodule-outer");
		git(outer, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "vendor");
		git(outer, "commit", "-qm", "add submodule");

		const s = await status(exec, outer);
		expect(s.isRepo).toBe(true);
		// The submodule directory itself must not appear as thousands of untracked files.
		expect(s.files.filter((f) => f.path.startsWith("vendor/"))).toEqual([]);
	});
});

describe("diff on the host (AC-7.38)", () => {
	it("a worktree diff parses through the same view model", async () => {
		const repo = newRepo("diff-worktree");
		writeFileSync(join(repo, "src.ts"), "export const a = 1\nexport const b = 2\n");

		const d = await diff(exec, repo, { kind: "worktree" });
		expect(d.files).toHaveLength(1);
		expect(d.files[0]!.path).toBe("src.ts");
		expect(d.files[0]!.additions).toBe(1);
	});

	it("a staged diff differs from a worktree diff", async () => {
		const repo = newRepo("diff-staged");
		writeFileSync(join(repo, "src.ts"), "export const a = 2\n");
		git(repo, "add", "src.ts");
		writeFileSync(join(repo, "src.ts"), "export const a = 3\n");

		const staged = await diff(exec, repo, { kind: "staged" });
		const worktree = await diff(exec, repo, { kind: "worktree" });
		// Both show one file, but different content — conflating them is a classic panel bug.
		expect(staged.files[0]!.hunks[0]!.lines.some((l) => l.text.includes("= 2"))).toBe(true);
		expect(worktree.files[0]!.hunks[0]!.lines.some((l) => l.text.includes("= 3"))).toBe(true);
	});

	it("a diff limited to one path returns only that file", async () => {
		const repo = newRepo("diff-onefile");
		writeFileSync(join(repo, "src.ts"), "changed\n");
		writeFileSync(join(repo, "README.md"), "# changed\n");

		const d = await diff(exec, repo, { kind: "worktree", path: "src.ts" });
		expect(d.files.map((f) => f.path)).toEqual(["src.ts"]);
	});

	it("a range diff works, for reviewing a branch against main", async () => {
		const repo = newRepo("diff-range");
		git(repo, "checkout", "-q", "-b", "feature");
		writeFileSync(join(repo, "feature.ts"), "export const f = 1\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "feature work");

		const d = await diff(exec, repo, { kind: "range", spec: "main...HEAD" });
		expect(d.files.map((f) => f.path)).toContain("feature.ts");
	});
});

describe("branches and worktrees", () => {
	it("AC-7.18 branches report current, subject and date", async () => {
		const repo = newRepo("branches");
		git(repo, "checkout", "-q", "-b", "feature/one");
		writeFileSync(join(repo, "x.txt"), "x\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "work on one");

		const bs = await branches(exec, repo);
		const names = bs.map((b) => b.name);
		expect(names).toContain("main");
		expect(names).toContain("feature/one");

		const current = bs.find((b) => b.current);
		expect(current?.name).toBe("feature/one");
		expect(current?.subject).toBe("work on one");
		expect(current?.at).toBeGreaterThan(0);
		// No upstream is null, not a fabricated origin.
		expect(current?.upstream).toBe(null);
	});

	it("AC-7.18 worktrees list the main checkout plus any linked ones", async () => {
		const repo = newRepo("worktrees");
		const extra = join(root, "worktree-extra");
		git(repo, "worktree", "add", "-q", "-b", "wt", extra);

		const ws = await worktrees(exec, repo);
		expect(ws.length).toBeGreaterThanOrEqual(2);
		// The first stanza is always the main worktree, which cannot be removed.
		expect(ws[0]!.main).toBe(true);
		const linked = ws.find((w) => w.path === extra);
		expect(linked?.main).toBe(false);
		expect(linked?.branch).toBe("wt");
	});

	it("a non-repo yields empty lists rather than throwing", async () => {
		const plain = join(root, "plain-2");
		mkdirSync(plain, { recursive: true });
		expect(await branches(exec, plain)).toEqual([]);
		expect(await worktrees(exec, plain)).toEqual([]);
	});
});

describe("commits and remotes", () => {
	it("AC-7.42 headCommit returns the host-side sha, for a PR body that references it", async () => {
		const repo = newRepo("head-commit");
		const h = await headCommit(exec, repo);
		expect(h?.sha).toMatch(/^[0-9a-f]{40}$/);
		expect(h?.subject).toBe("initial commit");
	});

	it("commitsBetween lists a branch's own commits", async () => {
		const repo = newRepo("commits-between");
		git(repo, "checkout", "-q", "-b", "topic");
		for (const n of [1, 2, 3]) {
			writeFileSync(join(repo, `f${n}.txt`), `${n}\n`);
			git(repo, "add", "-A");
			git(repo, "commit", "-qm", `commit ${n}`);
		}
		const cs = await commitsBetween(exec, repo, "main..HEAD");
		expect(cs).toHaveLength(3);
		// Newest first, which is what a drafted PR body should list.
		expect(cs[0]!.subject).toBe("commit 3");
	});

	it("a repo slug is parsed from every real remote form, and nothing else", () => {
		/**
		 * A wrong slug produces a link to someone else's project, so anything unrecognised returns null
		 * rather than a guess.
		 */
		expect(parseRepoSlug("https://github.com/acme/web.git")).toBe("acme/web");
		expect(parseRepoSlug("https://github.com/acme/web")).toBe("acme/web");
		expect(parseRepoSlug("git@github.com:acme/web.git")).toBe("acme/web");
		expect(parseRepoSlug("ssh://git@github.com/acme/web.git")).toBe("acme/web");
		expect(parseRepoSlug(null)).toBe(null);
		expect(parseRepoSlug("/local/path/repo")).toBe(null);
		expect(parseRepoSlug("not a url")).toBe(null);
	});
});

describe("argument injection into git (review finding F4)", () => {
	it("a spec that looks like an option is refused", async () => {
		/**
		 * The high-severity finding, and a real one — verified by hand before fixing:
		 *
		 *   git diff --no-color --output=/tmp/PROOF   →   writes /tmp/PROOF
		 *
		 * `execFile` with an args array prevents SHELL injection but not ARGUMENT injection, and `spec`
		 * landed in argv before any `--`. Since `HostExec` deliberately bypasses the tool gate — those calls
		 * are supposed to originate in the host application's code with fixed arguments — that was an agent-driven
		 * file write with no approval anywhere in its path.
		 */
		const repo = newRepo("arginject");
		for (const hostile of [
			"--output=/tmp/pi-should-not-exist",
			"--ext-diff",
			"-O/tmp/x",
			"--no-index",
			// A range that starts innocently but carries an option.
			"main --output=/tmp/x",
		]) {
			await expect(diff(exec, repo, { kind: "range", spec: hostile }), hostile).rejects.toThrow(
				/refusing to use/,
			);
		}
		expect(existsSync("/tmp/pi-should-not-exist")).toBe(false);
	});

	it("legitimate revisions and ranges still work", async () => {
		/**
		 * An allowlist is only correct if it admits what people actually use. A denylist of dangerous flags
		 * was the alternative and is wrong: git has hundreds of options and more arrive every release, so
		 * enumerating the safe SHAPE is the version that stays correct.
		 */
		const repo = newRepo("argok");
		git(repo, "checkout", "-q", "-b", "topic");
		writeFileSync(join(repo, "new.ts"), "export const t = 1\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "topic work");

		for (const spec of ["main", "main..HEAD", "main...topic", "HEAD~1", "HEAD^", "topic"]) {
			await expect(diff(exec, repo, { kind: "range", spec }), spec).resolves.toBeTruthy();
		}
		// And the range actually resolves rather than being silently empty.
		const d = await diff(exec, repo, { kind: "range", spec: "main..HEAD" });
		expect(d.files.map((f) => f.path)).toContain("new.ts");
	});

	it("commitsBetween validates its range too", async () => {
		const repo = newRepo("argrange");
		await expect(commitsBetween(exec, repo, "--output=/tmp/x")).rejects.toThrow(/refusing to use/);
		// And still works for a real range.
		await expect(commitsBetween(exec, repo, "HEAD~0..HEAD")).resolves.toBeTruthy();
	});

	it("a pathspec cannot be read as an option, because it follows --", async () => {
		// Already correct, and asserted now that its sibling turned out not to be.
		const repo = newRepo("pathspec");
		writeFileSync(join(repo, "src.ts"), "changed\n");
		const d = await diff(exec, repo, { kind: "worktree", path: "--output=/tmp/nope" });
		// No such path, so no files — and critically, no file written.
		expect(d.files).toEqual([]);
		expect(existsSync("/tmp/nope")).toBe(false);
	});

	it("isSafeRevisionSpec has no catastrophic backtracking", () => {
		// Two production ReDoS bugs make this mandatory for any new regex on external input.
		const hostile = "a".repeat(100_000);
		const t0 = performance.now();
		isSafeRevisionSpec(hostile);
		isSafeRevisionSpec(`${".".repeat(50_000)}${"/".repeat(50_000)}`);
		expect(performance.now() - t0).toBeLessThan(100);
	});
});
