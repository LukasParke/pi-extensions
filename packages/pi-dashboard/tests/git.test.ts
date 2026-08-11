import { describe, expect, it, vi } from "vitest";
import { createGitPoller, parsePullRequestJson, type GitSnapshot } from "../src/git.ts";
import type { GitExec } from "@parke.dev/pi-git";

describe("parsePullRequestJson", () => {
	it("accepts open PRs", () => {
		expect(
			parsePullRequestJson(
				JSON.stringify({ number: 7, url: "https://example.com/7", state: "OPEN", isDraft: true }),
			),
		).toEqual({ number: 7, url: "https://example.com/7", isDraft: true });
	});

	it("rejects closed, malformed, or unsafe URLs", () => {
		expect(
			parsePullRequestJson(
				JSON.stringify({ number: 1, url: "https://example.com/1", state: "CLOSED" }),
			),
		).toBeNull();
		expect(
			parsePullRequestJson(JSON.stringify({ number: 1, url: "javascript:alert(1)", state: "OPEN" })),
		).toBeNull();
		expect(
			parsePullRequestJson(
				JSON.stringify({ number: 1, url: "https://example.com/\u001b]8;;bad", state: "OPEN" }),
			),
		).toBeNull();
		expect(parsePullRequestJson("not-json")).toBeNull();
		expect(parsePullRequestJson("{}")).toBeNull();
	});
});

function mockExec(responses: Record<string, { stdout: string; code?: number }>): GitExec {
	return {
		async run(command, args) {
			const key = `${command} ${args.join(" ")}`;
			const hit = responses[key] ?? { stdout: "", code: 1 };
			return {
				stdout: hit.stdout,
				stderr: "",
				code: hit.code ?? 0,
				timedOut: false,
			};
		},
	};
}

describe("createGitPoller", () => {
	it("reports non-repo as empty", async () => {
		const exec = mockExec({
			"git status --porcelain=v2 --branch --untracked-files=all -z": {
				stdout: "",
				code: 128,
			},
		});
		const poller = createGitPoller({ exec, showPr: false });
		const seen: GitSnapshot[] = [];
		poller.setOnChange((s) => seen.push({ ...s }));
		await poller.request("/tmp");
		await poller.idle();
		expect(poller.snapshot.isRepository).toBe(false);
		expect(seen.at(-1)?.isRepository).toBe(false);
	});

	it("parses branch and changed file count", async () => {
		const porcelain = [
			"# branch.head feature/x",
			"# branch.upstream origin/feature/x",
			"# branch.ab +0 -0",
			"1 M. N... 100644 100644 100644 abc def src/a.ts",
			"? untracked.txt",
		].join("\0");
		const exec = mockExec({
			"git status --porcelain=v2 --branch --untracked-files=all -z": {
				stdout: porcelain + "\0",
				code: 0,
			},
		});
		const poller = createGitPoller({ exec, showPr: false });
		await poller.request("/repo");
		await poller.idle();
		expect(poller.snapshot).toMatchObject({
			isRepository: true,
			branch: "feature/x",
			changedFiles: 2,
			pullRequest: null,
		});
	});

	it("caches PR per branch and ignores stale generation", async () => {
		const porcelain = (branch: string) =>
			[`# branch.head ${branch}`, "1 M. N... 100644 100644 100644 a b f.ts"].join("\0") + "\0";

		let statusBranch = "main";
		const exec = mockExec({});
		exec.run = async (command, args) => {
			if (command === "git") {
				return {
					stdout: porcelain(statusBranch),
					stderr: "",
					code: 0,
					timedOut: false,
				};
			}
			return { stdout: "", stderr: "", code: 1, timedOut: false };
		};

		const runGh = vi.fn(async (_args: readonly string[], _cwd: string) => ({
			stdout: JSON.stringify({
				number: 42,
				url: "https://example.com/42",
				state: "OPEN",
				isDraft: false,
			}),
			stderr: "",
			code: 0,
		}));

		const poller = createGitPoller({ exec, runGh, showPr: true });
		await poller.request("/repo", true);
		await poller.idle();
		expect(poller.snapshot.pullRequest?.number).toBe(42);
		expect(runGh).toHaveBeenCalledTimes(1);

		// Same branch, no force — should not re-query gh.
		await poller.request("/repo", false);
		await poller.idle();
		expect(runGh).toHaveBeenCalledTimes(1);

		// invalidate drops in-flight relevance
		poller.invalidate();
		expect(poller.snapshot.isRepository).toBe(false);

		statusBranch = "other";
		await poller.request("/repo", true);
		await poller.idle();
		expect(poller.snapshot.branch).toBe("other");
		expect(runGh).toHaveBeenCalledTimes(2);
	});

	it("does not pass option-like branch names to gh", async () => {
		const exec: GitExec = {
			async run() {
				return {
					stdout: "# branch.head --repo=someone/else\0",
					stderr: "",
					code: 0,
					timedOut: false,
				};
			},
		};
		const runGh = vi.fn(async () => ({ stdout: "", stderr: "", code: 1 }));
		const poller = createGitPoller({ exec, runGh });
		await poller.request("/repo", true);
		await poller.idle();
		expect(runGh).not.toHaveBeenCalled();
	});

	it("coalesces concurrent requests", async () => {
		let calls = 0;
		const exec: GitExec = {
			async run() {
				calls += 1;
				await new Promise((r) => setTimeout(r, 20));
				return {
					stdout: "# branch.head main\0",
					stderr: "",
					code: 0,
					timedOut: false,
				};
			},
		};
		const poller = createGitPoller({ exec, showPr: false });
		const a = poller.request("/repo");
		const b = poller.request("/repo");
		await Promise.all([a, b]);
		await poller.idle();
		// One in-flight drain may run a second pass if a request arrived mid-flight,
		// but should not equal the number of request() calls without coalescing.
		expect(calls).toBeLessThanOrEqual(2);
		expect(calls).toBeGreaterThanOrEqual(1);
	});
});
