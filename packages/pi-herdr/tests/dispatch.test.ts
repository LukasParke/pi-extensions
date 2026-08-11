import { describe, expect, it } from "vitest";
import {
	dispatchHerdrTask,
	ensurePiAgent,
	ensureWorktree,
	isPromptStallError,
	isTransientStartError,
	parsePrUrl,
	promptWithVerify,
	slugify,
} from "../src/dispatch.ts";
import type { HerdrRunner } from "../src/dispatch.ts";

/** A scripted herdr CLI: routes each command to a handler and records calls. */
function fakeHerdr(routes: Record<string, (args: string[]) => any>): {
	run: HerdrRunner;
	calls: string[][];
} {
	const calls: string[][] = [];
	const run: HerdrRunner = (args) => {
		calls.push(args);
		const key = `${args[0]} ${args[1]}`;
		const handler = routes[key];
		if (!handler) return Promise.reject(new Error(`unrouted: ${key}`));
		try {
			return Promise.resolve(handler(args));
		} catch (error) {
			return Promise.reject(error);
		}
	};
	return { run, calls };
}

const noSleep = { sleep: async () => {} };

const createdWorktree = {
	root_pane: { pane_id: "pane-1" },
	workspace: { workspace_id: "ws-1" },
	worktree: { path: "/wt/agent-fix-thing" },
};

describe("parsePrUrl", () => {
	it("parses a GitHub PR URL", () => {
		expect(parsePrUrl("https://github.com/acme/web/pull/42")).toEqual({
			org: "acme",
			repo: "web",
			num: "42",
		});
	});

	it("finds the URL inside surrounding text", () => {
		expect(parsePrUrl("please review github.com/a/b/pull/7 today")?.num).toBe("7");
	});

	it("returns undefined for non-PR URLs", () => {
		expect(parsePrUrl("https://github.com/acme/web/issues/42")).toBeUndefined();
		expect(parsePrUrl("not a url")).toBeUndefined();
	});
});

describe("slugify", () => {
	it("lowercases and collapses non-alphanumerics into single dashes", () => {
		expect(slugify("Fix the Foo/Bar bug!!")).toBe("fix-the-foo-bar-bug");
	});

	it("strips leading and trailing dashes", () => {
		expect(slugify("--hello world--")).toBe("hello-world");
	});

	it("caps at 40 characters without a trailing dash", () => {
		const slug = slugify(`${"a".repeat(39)}-tail`);
		expect(slug.length).toBeLessThanOrEqual(40);
		expect(slug.endsWith("-")).toBe(false);
	});

	it("never returns an empty or digit-leading slug (herdr requires [a-z] first)", () => {
		for (const input of ["???", "日本語のタスク", "42 fix the thing", ""]) {
			expect(slugify(input), input).toMatch(/^[a-z][a-z0-9_-]*$/);
			expect(slugify(input).length).toBeLessThanOrEqual(40);
		}
		expect(slugify("42 fix the thing")).toBe("task-42-fix-the-thing");
	});
});

describe("transient-error classification", () => {
	it("treats pane-busy, shell-not-ready, and kind-mismatch as transient", () => {
		for (const message of [
			"herdr agent start: agent_pane_busy: pane has a running process",
			"herdr agent start: pane is not an available shell",
			"herdr agent start: agent_kind_mismatch: expected pi",
		]) {
			expect(isTransientStartError(message), message).toBe(true);
		}
	});

	it("treats anything else as real", () => {
		for (const message of [
			"herdr agent start: agent_name_taken: already exists",
			"Command failed: herdr",
			"ENOENT",
		]) {
			expect(isTransientStartError(message), message).toBe(false);
		}
	});

	it("classifies herdr-envelope stalls and wait-timeouts as re-sendable", () => {
		expect(isPromptStallError("herdr agent prompt: agent_prompt_stalled: no lifecycle change")).toBe(true);
		expect(isPromptStallError("herdr agent prompt: wait_timeout: timeout exceeded")).toBe(true);
		expect(isPromptStallError("agent_not_found: nope")).toBe(false);
	});

	it("does NOT classify a process-level exec timeout as re-sendable", () => {
		// The CLI died waiting, but the prompt may already have reached the
		// agent — re-sending would duplicate it.
		expect(isPromptStallError("Command failed: timeout of 120000ms exceeded")).toBe(false);
	});
});

describe("ensureWorktree", () => {
	it("returns the pane and workspace from a fresh create", async () => {
		const { run } = fakeHerdr({ "worktree create": () => createdWorktree });
		const handle = await ensureWorktree("/repo", "agent/fix", "fix", { herdr: run });
		expect(handle).toEqual({ paneId: "pane-1", workspaceId: "ws-1", worktreePath: "/wt/agent-fix-thing" });
	});

	it("reuses an existing worktree for the same branch after a failed dispatch", async () => {
		const { run, calls } = fakeHerdr({
			"worktree create": () => {
				throw new Error("herdr worktree create: branch_exists: agent/fix already exists");
			},
			"worktree list": () => ({
				worktrees: [
					{ branch: "main", is_linked_worktree: false },
					{
						branch: "agent/fix",
						is_linked_worktree: true,
						open_workspace_id: "ws-old",
						path: "/wt/existing",
					},
				],
			}),
			"pane list": () => ({ panes: [{ pane_id: "pane-old" }] }),
		});
		const handle = await ensureWorktree("/repo", "agent/fix", "fix", { herdr: run });
		expect(handle).toEqual({ paneId: "pane-old", workspaceId: "ws-old", worktreePath: "/wt/existing" });
		expect(calls.map((c) => `${c[0]} ${c[1]}`)).toEqual(["worktree create", "worktree list", "pane list"]);
	});

	it("rethrows the create error when no reusable worktree exists", async () => {
		const { run } = fakeHerdr({
			"worktree create": () => {
				throw new Error("herdr worktree create: disk_full: no");
			},
			"worktree list": () => ({ worktrees: [] }),
		});
		await expect(ensureWorktree("/repo", "agent/fix", "fix", { herdr: run })).rejects.toThrow(/disk_full/);
	});
});

describe("ensurePiAgent", () => {
	it("adopts a pi agent already running in the pane", async () => {
		const { run, calls } = fakeHerdr({
			"agent get": () => ({ agent: { agent: "pi", name: "existing-pi" } }),
		});
		const name = await ensurePiAgent("fix", "pane-1", { herdr: run, ...noSleep });
		expect(name).toBe("existing-pi");
		expect(calls.some((c) => c[1] === "start")).toBe(false);
	});

	it("renames an adopted agent that only answers to its pane id", async () => {
		const { run, calls } = fakeHerdr({
			"agent get": () => ({ agent: { agent: "pi" } }),
			"agent rename": () => ({}),
		});
		const name = await ensurePiAgent("fix", "pane-1", { herdr: run, ...noSleep });
		expect(name).toBe("fix");
		expect(calls.find((c) => c[1] === "rename")).toEqual(["agent", "rename", "pane-1", "fix"]);
	});

	it("retries transient pane-busy errors until the pane is ready", async () => {
		let attempts = 0;
		const { run } = fakeHerdr({
			"agent get": () => {
				throw new Error("agent_not_found");
			},
			"agent start": () => {
				attempts += 1;
				if (attempts < 3) throw new Error("agent_pane_busy: checkout still running");
				return { agent: { name: "fix" } };
			},
		});
		const name = await ensurePiAgent("fix", "pane-1", { herdr: run, ...noSleep });
		expect(name).toBe("fix");
		expect(attempts).toBe(3);
	});

	it("retries agent_kind_mismatch as transient", async () => {
		let attempts = 0;
		const { run } = fakeHerdr({
			"agent get": () => {
				throw new Error("agent_not_found");
			},
			"agent start": () => {
				attempts += 1;
				if (attempts === 1) throw new Error("agent_kind_mismatch: shell still settling");
				return { agent: { name: "fix" } };
			},
		});
		await expect(ensurePiAgent("fix", "pane-1", { herdr: run, ...noSleep })).resolves.toBe("fix");
		expect(attempts).toBe(2);
	});

	it("gives up on transient errors once the deadline passes", async () => {
		let clock = 0;
		const { run } = fakeHerdr({
			"agent get": () => {
				throw new Error("agent_not_found");
			},
			"agent start": () => {
				throw new Error("agent_pane_busy: forever");
			},
		});
		await expect(
			ensurePiAgent("fix", "pane-1", {
				herdr: run,
				sleep: async () => {
					clock += 3_000;
				},
				now: () => clock,
				startDeadlineMs: 10_000,
			}),
		).rejects.toThrow(/agent_pane_busy/);
	});

	it("propagates non-transient start errors immediately", async () => {
		let attempts = 0;
		const { run } = fakeHerdr({
			"agent get": () => {
				throw new Error("agent_not_found");
			},
			"agent start": () => {
				attempts += 1;
				throw new Error("agent_name_taken: fix");
			},
		});
		await expect(ensurePiAgent("fix", "pane-1", { herdr: run, ...noSleep })).rejects.toThrow(
			/agent_name_taken/,
		);
		expect(attempts).toBe(1);
	});
});

describe("promptWithVerify", () => {
	it("returns on a clean --wait --until working prompt", async () => {
		const { run, calls } = fakeHerdr({ "agent prompt": () => ({}) });
		await promptWithVerify("fix", "do the thing", { herdr: run, ...noSleep });
		expect(calls).toEqual([["agent", "prompt", "fix", "do the thing", "--wait", "--until", "working"]]);
	});

	it("re-sends a swallowed prompt when the agent stays idle", async () => {
		let prompts = 0;
		const { run } = fakeHerdr({
			"agent prompt": () => {
				prompts += 1;
				if (prompts === 1) throw new Error("agent_prompt_stalled: no lifecycle change");
				return {};
			},
			"agent get": () => ({ agent: { agent_status: "idle" } }),
		});
		await promptWithVerify("fix", "task", { herdr: run, ...noSleep });
		expect(prompts).toBe(2);
	});

	it("does NOT re-send when a stalled prompt actually landed (agent is working)", async () => {
		let prompts = 0;
		const { run } = fakeHerdr({
			"agent prompt": () => {
				prompts += 1;
				throw new Error("agent_prompt_stalled: slow state flip");
			},
			"agent get": () => ({ agent: { agent_status: "working" } }),
		});
		await promptWithVerify("fix", "task", { herdr: run, ...noSleep });
		expect(prompts).toBe(1);
	});

	it("gives up after three stalled attempts with a clear error", async () => {
		let prompts = 0;
		const { run } = fakeHerdr({
			"agent prompt": () => {
				prompts += 1;
				throw new Error("agent_prompt_stalled: swallowed");
			},
			"agent get": () => ({ agent: { agent_status: "idle" } }),
		});
		await expect(promptWithVerify("fix", "task", { herdr: run, ...noSleep })).rejects.toThrow(
			/prompt not accepted after 3 attempts/,
		);
		expect(prompts).toBe(3);
	});

	it("propagates non-stall prompt errors immediately", async () => {
		let prompts = 0;
		const { run } = fakeHerdr({
			"agent prompt": () => {
				prompts += 1;
				throw new Error("agent_not_found: fix");
			},
		});
		await expect(promptWithVerify("fix", "task", { herdr: run, ...noSleep })).rejects.toThrow(
			/agent_not_found/,
		);
		expect(prompts).toBe(1);
	});
});

describe("dispatchHerdrTask", () => {
	it("runs the full flow: worktree → agent → verified prompt", async () => {
		const { run, calls } = fakeHerdr({
			"worktree create": () => createdWorktree,
			"agent get": (args) =>
				args[2] === "pane-1"
					? (() => {
							throw new Error("agent_not_found");
						})()
					: { agent: { agent_status: "working" } },
			"agent start": () => ({ agent: { name: "fix-thing" } }),
			"agent prompt": () => ({}),
		});
		const result = await dispatchHerdrTask(
			{ repoPath: "/repo", task: "Fix the thing", name: "fix-thing" },
			{ herdr: run, ...noSleep },
		);
		expect(result).toEqual({
			agentName: "fix-thing",
			paneId: "pane-1",
			workspaceId: "ws-1",
			worktreePath: "/wt/agent-fix-thing",
			branch: "agent/fix-thing",
			repoPath: "/repo",
		});
		expect(calls.map((c) => `${c[0]} ${c[1]}`)).toEqual([
			"worktree create",
			"agent get",
			"agent start",
			"agent prompt",
		]);
	});

	it("derives the branch and agent name from the task when no name is given", async () => {
		const { run } = fakeHerdr({
			"worktree create": () => createdWorktree,
			"agent get": () => {
				throw new Error("agent_not_found");
			},
			"agent start": (args) => ({ agent: { name: args[2] } }),
			"agent prompt": () => ({}),
		});
		const result = await dispatchHerdrTask(
			{ repoPath: "/repo", task: "Add CI caching for Node builds" },
			{ herdr: run, ...noSleep },
		);
		expect(result.branch).toBe("agent/add-ci-caching-for-node-builds");
		expect(result.agentName).toBe("add-ci-caching-for-node-builds");
	});
});
