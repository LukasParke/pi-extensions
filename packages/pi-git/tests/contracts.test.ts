import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerGit from "../extensions/index.ts";

let directory: string;
let repo: string;
let tools: Map<string, ToolDefinition>;

function git(...args: string[]) {
	return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

async function call(name: string, params: Record<string, unknown> = {}) {
	const tool = tools.get(name)!;
	const result = await tool.execute("contract", params, undefined, undefined, {
		cwd: repo,
	} as ExtensionToolContext);
	expect(tool.outputSchema).toBeDefined();
	expect(Value.Check(tool.outputSchema!, result.structuredContent)).toBe(true);
	expect(result.structuredContent).toEqual({
		...JSON.parse(JSON.stringify(result.details)),
		...(result.isError ? { error: result.content[0]?.type === "text" ? result.content[0].text : "" } : {}),
	});
	expect(result.content).toEqual([expect.objectContaining({ type: "text", text: expect.any(String) })]);
	return result;
}

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-contract-")));
	repo = join(directory, "repo");
	// Ignore the owner's global signing, hooks, and credential settings in disposable repos.
	vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
	vi.stubEnv("GIT_AUTHOR_NAME", "Contract Test");
	vi.stubEnv("GIT_AUTHOR_EMAIL", "contract@example.invalid");
	vi.stubEnv("GIT_COMMITTER_NAME", "Contract Test");
	vi.stubEnv("GIT_COMMITTER_EMAIL", "contract@example.invalid");
	execFileSync("git", ["init", "--initial-branch=main", repo], { stdio: "ignore" });
	writeFileSync(join(repo, "file.txt"), "before\n");
	git("add", ".");
	git("commit", "-m", "Initial contract fixture");
	const registerTool = vi.fn<ExtensionAPI["registerTool"]>();
	const pi = {} as ExtensionAPI;
	Object.assign(pi, { registerTool });
	registerGit(pi);
	tools = new Map(registerTool.mock.calls.map(([tool]) => [tool.name, tool]));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

describe("native Git contracts", () => {
	it("declares all five tools, with closed-world reads and conservative arbitrary-command hints", () => {
		expect([...tools.keys()].sort()).toEqual([
			"git_branches",
			"git_checklist",
			"git_diff",
			"git_log",
			"git_status",
		]);
		for (const tool of tools.values()) {
			expect(tool.namespace?.name).toBe("git");
			expect(tool.outputSchema).toBeDefined();
			expect(tool.annotations).toEqual(
				tool.name === "git_checklist"
					? { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
					: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			);
		}
	});

	it("returns complete status, diff hunks, branch/worktree rows, and commit summaries", async () => {
		git("branch", "feature");
		git("mv", "file.txt", "renamed.txt");
		writeFileSync(join(repo, "renamed.txt"), "before\nafter\n");
		writeFileSync(join(repo, "untracked.txt"), "untracked\n");
		const status = await call("git_status");
		expect(status.isError).not.toBe(true);
		expect(status.details).toMatchObject({
			cwd: repo,
			status: {
				isRepo: true,
				branch: "main",
				detached: false,
				upstream: null,
				ahead: 0,
				behind: 0,
				conflicted: false,
				conflictPaths: [],
				files: expect.arrayContaining([
					expect.objectContaining({
						path: "renamed.txt",
						oldPath: "file.txt",
						status: "renamed",
						staged: true,
					}),
					expect.objectContaining({ path: "untracked.txt", status: "untracked", staged: false }),
				]),
			},
		});
		const diff = await call("git_diff");
		expect(diff.details).toMatchObject({
			cwd: repo,
			summary: expect.any(String),
			diff: {
				additions: 1,
				deletions: 0,
				truncated: false,
				files: [
					expect.objectContaining({
						path: "renamed.txt",
						oldPath: null,
						binary: false,
						oldMode: null,
						newMode: null,
						noNewlineAtEof: false,
						truncated: false,
						hunks: [
							expect.objectContaining({
								header: expect.any(String),
								anchor: "renamed.txt:1",
								oldStart: 1,
								newStart: 1,
								lines: expect.arrayContaining([{ kind: "add", text: "after", oldLine: null, newLine: 2 }]),
							}),
						],
					}),
				],
			},
		});
		const staged = await call("git_diff", { ref: "--staged" });
		expect(staged.details).toMatchObject({
			diff: { files: [expect.objectContaining({ status: "renamed", oldPath: "file.txt" })] },
		});
		const branches = await call("git_branches", { include_worktrees: true });
		expect(branches.details).toMatchObject({
			branches: expect.arrayContaining([
				expect.objectContaining({
					name: "main",
					current: true,
					at: expect.any(Number),
					subject: "Initial contract fixture",
				}),
			]),
			worktrees: [{ path: repo, branch: "main", main: true, detached: false, locked: false }],
		});
		const log = await call("git_log", { format: "full" });
		expect(log.details).toEqual({
			cwd: repo,
			commits: [{ sha: git("rev-parse", "HEAD"), subject: "Initial contract fixture" }],
		});
	});

	it("validates no-match/empty successes rather than marking them as errors", async () => {
		for (const [name, params, details] of [
			["git_diff", {}, { diff: { files: [], additions: 0, deletions: 0, truncated: false } }],
			["git_diff", { file: "absent.txt" }, { diff: { files: [] } }],
			["git_log", { from: "HEAD", to: "HEAD" }, { commits: [] }],
			["git_branches", {}, { worktrees: [] }],
		] as const) {
			const result = await call(name, params);
			expect(result.isError).not.toBe(true);
			expect(result.details).toMatchObject(details);
		}
		git("checkout", "--detach", "HEAD");
		expect((await call("git_status")).details).toMatchObject({ status: { branch: null, detached: true } });
	});

	it("preserves checklist business failure states without native execution errors", async () => {
		const unconfigured = await call("git_checklist");
		expect(unconfigured.isError).not.toBe(true);
		expect(unconfigured.details).toMatchObject({
			ready: false,
			checks: expect.arrayContaining([
				{ name: "tests", state: "not configured", detail: "pass commands.tests to run this" },
			]),
		});
		const passing = await call("git_checklist", { commands: { tests: "sh -c true" }, expect: ["tests"] });
		expect(passing.details).toMatchObject({
			ready: true,
			checks: expect.arrayContaining([{ name: "tests", state: "passing", detail: null }]),
		});
		const failing = await call("git_checklist", { commands: { tests: "sh -c false" }, expect: ["tests"] });
		expect(failing.isError).not.toBe(true);
		expect(failing.details).toMatchObject({
			ready: false,
			checks: expect.arrayContaining([{ name: "tests", state: "failing", detail: "" }]),
		});
	});

	it("returns schema-valid native refusals for every tool outside a repository", async () => {
		for (const name of tools.keys()) {
			const result = await call(name, { path: directory });
			expect(result.isError).toBe(true);
			expect(result.details).toEqual({ refused: true });
			expect(result.content[0]).toMatchObject({
				text: expect.stringContaining("not inside a git repository"),
			});
		}
	});

	it("refuses unsafe revision options without altering a repository", async () => {
		for (const [name, params] of [
			["git_diff", { ref: "--output=owned.txt" }],
			["git_log", { from: "--all" }],
			["git_log", { to: "HEAD;touch-owned" }],
		] as const) {
			const result = await call(name, params);
			expect(result.isError).toBe(true);
			expect(result.details).toEqual({ refused: true });
		}
		expect(git("status", "--porcelain")).toBe("");
	});

	it("rejects malformed useful fields instead of accepting opaque output", async () => {
		const schema = tools.get("git_status")!.outputSchema!;
		const result = await call("git_status");
		const data = JSON.parse(JSON.stringify(result.structuredContent));
		data.status.files = [{ path: 123, status: "modified", staged: false, oldPath: null }];
		expect(Value.Check(schema, data)).toBe(false);
		expect(Value.Check(schema, { refused: "true" })).toBe(false);
	});
});
