import { describe, expect, it } from "vitest";
import {
	BRIEF_FILENAME,
	BRIEF_POINTER,
	dispatchHerdrTask,
	ensurePiAgent,
	ensureWorktree,
	INLINE_TASK_MAX_LENGTH,
	isPromptEncodingError,
	isPromptStallError,
	isTransientStartError,
	needsBriefFile,
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

	it("caps at 32 characters without a trailing dash", () => {
		const slug = slugify(`${"a".repeat(31)}-tail`);
		expect(slug.length).toBeLessThanOrEqual(32);
		expect(slug.endsWith("-")).toBe(false);
	});

	it("never returns an empty or digit-leading slug (herdr requires [a-z] first)", () => {
		for (const input of ["???", "日本語のタスク", "42 fix the thing", ""]) {
			expect(
				slugify(input, () => 0xabcdef),
				input,
			).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
			expect(slugify(input, () => 0xabcdef).length).toBeLessThanOrEqual(32);
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

	it("classifies argv-encoding rejections on agent start as prompt-encoding errors", () => {
		expect(
			isPromptEncodingError(
				"herdr agent start: invalid_agent_argument: agent arguments cannot be encoded safely for the target shell",
			),
		).toBe(true);
		expect(isPromptEncodingError("herdr agent prompt: invalid_agent_argument: nope")).toBe(false);
		expect(isPromptEncodingError("herdr agent start: agent_name_taken: fix")).toBe(false);
	});
});

describe("needsBriefFile", () => {
	it("flags multi-line and overlong tasks", () => {
		expect(needsBriefFile("line one\nline two")).toBe(true);
		expect(needsBriefFile("a".repeat(INLINE_TASK_MAX_LENGTH + 1))).toBe(true);
	});

	it("accepts short single-line tasks as argv", () => {
		expect(needsBriefFile("Fix the thing.")).toBe(false);
		expect(needsBriefFile("a".repeat(INLINE_TASK_MAX_LENGTH))).toBe(false);
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
		const result = await ensurePiAgent("fix", "pane-1", "do the thing", {
			herdr: run,
			...noSleep,
		});
		expect(result).toEqual({ agentName: "existing-pi", launchedWithTask: false });
		expect(calls.some((c) => c[1] === "start")).toBe(false);
	});

	it("renames an adopted agent that only answers to its pane id", async () => {
		const { run, calls } = fakeHerdr({
			"agent get": () => ({ agent: { agent: "pi" } }),
			"agent rename": () => ({}),
		});
		const result = await ensurePiAgent("fix", "pane-1", "do the thing", {
			herdr: run,
			...noSleep,
		});
		expect(result).toEqual({ agentName: "fix", launchedWithTask: false });
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
		const result = await ensurePiAgent("fix", "pane-1", "do the thing", {
			herdr: run,
			...noSleep,
		});
		expect(result).toEqual({ agentName: "fix", launchedWithTask: true });
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
		await expect(ensurePiAgent("fix", "pane-1", "do the thing", { herdr: run, ...noSleep })).resolves.toEqual(
			{ agentName: "fix", launchedWithTask: true },
		);
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
			ensurePiAgent("fix", "pane-1", "do the thing", {
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
		await expect(ensurePiAgent("fix", "pane-1", "do the thing", { herdr: run, ...noSleep })).rejects.toThrow(
			/agent_name_taken/,
		);
		expect(attempts).toBe(1);
	});

	it("passes the task in argv when starting pi", async () => {
		const { run, calls } = fakeHerdr({
			"agent get": () => {
				throw new Error("agent_not_found");
			},
			"agent start": () => ({ agent: { name: "fix" } }),
		});
		await ensurePiAgent("fix", "pane-1", "do the thing", { herdr: run, ...noSleep });
		expect(calls.at(-1)).toEqual([
			"agent",
			"start",
			"fix",
			"--kind",
			"pi",
			"--pane",
			"pane-1",
			"--",
			"do the thing",
		]);
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
	it("writes a brief file and starts with a pointer for multi-line tasks", async () => {
		const written: { path: string; contents: string }[] = [];
		const { run, calls } = fakeHerdr({
			"worktree create": () => createdWorktree,
			"agent get": () => {
				throw new Error("agent_not_found");
			},
			"agent start": () => ({ agent: { name: "fix-thing" } }),
			"agent wait": () => ({}),
		});
		const task = "Fix the thing.\n\nSteps:\n1. read the file\n2. fix it";
		const result = await dispatchHerdrTask(
			{ repoPath: "/repo", task, name: "fix-thing" },
			{
				herdr: run,
				excludePath: async () => {},
				writeFile: async (path, contents) => {
					written.push({ path, contents });
				},
				...noSleep,
			},
		);
		expect(written).toEqual([{ path: `/wt/agent-fix-thing/${BRIEF_FILENAME}`, contents: task }]);
		expect(result.briefPath).toBe(`/wt/agent-fix-thing/${BRIEF_FILENAME}`);
		expect(calls.find((call) => call[1] === "start")?.slice(-2)).toEqual(["--", BRIEF_POINTER]);
	});

	it("excludes the brief via the worktree's git info/exclude at write time", async () => {
		const excluded: { worktreePath: string; basename: string }[] = [];
		const { run } = fakeHerdr({
			"worktree create": () => createdWorktree,
			"agent get": () => {
				throw new Error("agent_not_found");
			},
			"agent start": () => ({ agent: { name: "fix-thing" } }),
			"agent wait": () => ({}),
		});
		await dispatchHerdrTask(
			{ repoPath: "/repo", task: "line one\nline two", name: "fix-thing" },
			{
				herdr: run,
				writeFile: async () => {},
				excludePath: async (worktreePath, basename) => {
					excluded.push({ worktreePath, basename });
				},
				...noSleep,
			},
		);
		expect(excluded).toEqual([{ worktreePath: "/wt/agent-fix-thing", basename: BRIEF_FILENAME }]);
	});

	it("writes a brief file and starts with a pointer for overlong single-line tasks", async () => {
		const written: string[] = [];
		const { run, calls } = fakeHerdr({
			"worktree create": () => createdWorktree,
			"agent get": () => {
				throw new Error("agent_not_found");
			},
			"agent start": () => ({ agent: { name: "fix-thing" } }),
			"agent wait": () => ({}),
		});
		const task = "x".repeat(INLINE_TASK_MAX_LENGTH + 1);
		const result = await dispatchHerdrTask(
			{ repoPath: "/repo", task, name: "fix-thing" },
			{
				herdr: run,
				excludePath: async () => {},
				writeFile: async (path) => {
					written.push(path);
				},
				...noSleep,
			},
		);
		expect(written).toEqual([`/wt/agent-fix-thing/${BRIEF_FILENAME}`]);
		expect(result.briefPath).toBe(`/wt/agent-fix-thing/${BRIEF_FILENAME}`);
		expect(calls.find((call) => call[1] === "start")?.slice(-2)).toEqual(["--", BRIEF_POINTER]);
	});

	it("falls back to a brief file when the CLI rejects argv encoding", async () => {
		const written: string[] = [];
		let starts = 0;
		const { run, calls } = fakeHerdr({
			"worktree create": () => createdWorktree,
			"agent get": () => {
				throw new Error("agent_not_found");
			},
			"agent start": () => {
				starts += 1;
				if (starts === 1) {
					throw new Error(
						"herdr agent start: invalid_agent_argument: agent arguments cannot be encoded safely for the target shell",
					);
				}
				return { agent: { name: "fix-thing" } };
			},
			"agent wait": () => ({}),
		});
		const result = await dispatchHerdrTask(
			{ repoPath: "/repo", task: "quote: ' single-line but unsafe", name: "fix-thing" },
			{
				herdr: run,
				excludePath: async () => {},
				writeFile: async (path) => {
					written.push(path);
				},
				...noSleep,
			},
		);
		expect(starts).toBe(2);
		expect(written).toEqual([`/wt/agent-fix-thing/${BRIEF_FILENAME}`]);
		expect(result.briefPath).toBe(`/wt/agent-fix-thing/${BRIEF_FILENAME}`);
		const startCalls = calls.filter((call) => call[1] === "start");
		expect(startCalls[1].slice(-2)).toEqual(["--", BRIEF_POINTER]);
	});

	it("re-throws invalid_agent_argument when a brief file was already used", async () => {
		const { run } = fakeHerdr({
			"worktree create": () => createdWorktree,
			"agent get": () => {
				throw new Error("agent_not_found");
			},
			"agent start": () => {
				throw new Error(
					"herdr agent start: invalid_agent_argument: agent arguments cannot be encoded safely for the target shell",
				);
			},
		});
		await expect(
			dispatchHerdrTask(
				{ repoPath: "/repo", task: "one\ntwo", name: "fix-thing" },
				{ herdr: run, excludePath: async () => {}, writeFile: async () => {}, ...noSleep },
			),
		).rejects.toThrow(/invalid_agent_argument/);
	});

	it("prompts the pointer, not the brief, when an argv-launched brief task stays idle", async () => {
		const { run, calls } = fakeHerdr({
			"worktree create": () => createdWorktree,
			"agent get": (args) => {
				if (args[2] === "pane-1") throw new Error("agent_not_found");
				return { agent: { agent_status: "idle" } };
			},
			"agent start": () => ({ agent: { name: "fix-thing" } }),
			"agent wait": () => {
				throw new Error("wait_timeout");
			},
			"agent prompt": () => ({}),
		});
		await dispatchHerdrTask(
			{ repoPath: "/repo", task: "line one\nline two", name: "fix-thing" },
			{ herdr: run, excludePath: async () => {}, writeFile: async () => {}, ...noSleep },
		);
		expect(calls.filter((call) => call[1] === "prompt")).toEqual([
			["agent", "prompt", "fix-thing", BRIEF_POINTER, "--wait", "--until", "working"],
		]);
	});

	it("does not write a brief file for short single-line tasks", async () => {
		let written = 0;
		const { run } = fakeHerdr({
			"worktree create": () => createdWorktree,
			"agent get": () => {
				throw new Error("agent_not_found");
			},
			"agent start": () => ({ agent: { name: "fix-thing" } }),
			"agent wait": () => ({}),
		});
		const result = await dispatchHerdrTask(
			{ repoPath: "/repo", task: "Fix the thing", name: "fix-thing" },
			{
				herdr: run,
				excludePath: async () => {},
				writeFile: async () => {
					written += 1;
				},
				...noSleep,
			},
		);
		expect(written).toBe(0);
		expect(result.briefPath).toBeUndefined();
	});

	it("launches with the task and does not prompt when pi starts working", async () => {
		const { run, calls } = fakeHerdr({
			"worktree create": () => createdWorktree,
			"agent get": () => {
				throw new Error("agent_not_found");
			},
			"agent start": () => ({ agent: { name: "fix-thing" } }),
			"agent wait": () => ({}),
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
			"agent wait",
		]);
		expect(calls.find((call) => call[1] === "start")?.slice(-2)).toEqual(["--", "Fix the thing"]);
	});

	it("falls back to a verified prompt only when argv launch remains idle after the grace period", async () => {
		const { run, calls } = fakeHerdr({
			"worktree create": () => createdWorktree,
			"agent get": (args) => {
				if (args[2] === "pane-1") throw new Error("agent_not_found");
				return { agent: { agent_status: "idle" } };
			},
			"agent start": () => ({ agent: { name: "fix-thing" } }),
			"agent wait": () => {
				throw new Error("wait_timeout");
			},
			"agent prompt": () => ({}),
		});
		await dispatchHerdrTask(
			{ repoPath: "/repo", task: "Fix the thing", name: "fix-thing" },
			{ herdr: run, ...noSleep },
		);
		expect(calls.filter((call) => call[1] === "prompt")).toEqual([
			["agent", "prompt", "fix-thing", "Fix the thing", "--wait", "--until", "working"],
		]);
	});

	it("propagates non-timeout argv wait failures without prompting", async () => {
		const { run, calls } = fakeHerdr({
			"worktree create": () => createdWorktree,
			"agent get": () => {
				throw new Error("agent_not_found");
			},
			"agent start": () => ({ agent: { name: "fix-thing" } }),
			"agent wait": () => {
				throw new Error("server_unavailable");
			},
		});
		await expect(
			dispatchHerdrTask(
				{ repoPath: "/repo", task: "Fix the thing", name: "fix-thing" },
				{ herdr: run, ...noSleep },
			),
		).rejects.toThrow("server_unavailable");
		expect(calls.some((call) => call[1] === "prompt")).toBe(false);
	});

	it("does not prompt when argv launch settled before status verification", async () => {
		const { run, calls } = fakeHerdr({
			"worktree create": () => createdWorktree,
			"agent get": (args) => {
				if (args[2] === "pane-1") throw new Error("agent_not_found");
				return { agent: { agent_status: "working" } };
			},
			"agent start": () => ({ agent: { name: "fix-thing" } }),
			"agent wait": () => {
				throw new Error("wait_timeout");
			},
		});
		await dispatchHerdrTask(
			{ repoPath: "/repo", task: "Fix the thing", name: "fix-thing" },
			{ herdr: run, ...noSleep },
		);
		expect(calls.some((call) => call[1] === "prompt")).toBe(false);
	});

	it("always prompts an adopted agent instead of launching it with argv", async () => {
		const { run, calls } = fakeHerdr({
			"worktree create": () => createdWorktree,
			"agent get": () => ({ agent: { agent: "pi", name: "existing-pi" } }),
			"agent prompt": () => ({}),
		});
		await dispatchHerdrTask(
			{ repoPath: "/repo", task: "Fix the thing", name: "fix-thing" },
			{ herdr: run, ...noSleep },
		);
		expect(calls.some((call) => call[1] === "start")).toBe(false);
		expect(calls.some((call) => call[1] === "prompt")).toBe(true);
	});

	it.each(["", ".", "..", "with/slash", "with\\slash", "Fix-Thing", "1leading", "has space", "a".repeat(33)])(
		"rejects invalid explicit agent name %j before creating a worktree",
		async (name) => {
			const { run, calls } = fakeHerdr({});
			await expect(
				dispatchHerdrTask({ repoPath: "/repo", task: "Fix the thing", name }, { herdr: run, ...noSleep }),
			).rejects.toThrow(
				"agent name must start with a lowercase letter and contain only lowercase letters, digits, '-' or '_' (1-32 characters)",
			);
			expect(calls).toEqual([]);
		},
	);

	it("uses a generated omitted name for agent start, worktree label, and branch", async () => {
		const { run, calls } = fakeHerdr({
			"worktree create": () => createdWorktree,
			"agent get": () => {
				throw new Error("agent_not_found");
			},
			"agent start": (args) => ({ agent: { name: args[2] } }),
			"agent wait": () => ({}),
		});
		const generateName = async () => "agent-name-limit";
		const result = await dispatchHerdrTask(
			{ repoPath: "/repo", task: "Fix and land the confirmed invalid_agent_name regression" },
			{ herdr: run, generateName, ...noSleep },
		);
		const started = calls.find((call) => call[1] === "start");
		const created = calls.find((call) => call[1] === "create");
		expect(started?.[2]).toBe("agent-name-limit");
		expect(created?.[created.indexOf("--label") + 1]).toBe("agent-name-limit");
		expect(created?.[created.indexOf("--branch") + 1]).toBe("agent/agent-name-limit");
		expect(result.agentName).toBe("agent-name-limit");
		expect(result.branch).toBe("agent/agent-name-limit");
	});

	it("normalizes overlong model output and falls back when generation fails", async () => {
		const { run, calls } = fakeHerdr({
			"worktree create": () => createdWorktree,
			"agent get": () => {
				throw new Error("agent_not_found");
			},
			"agent start": (args) => ({ agent: { name: args[2] } }),
			"agent wait": () => ({}),
		});
		const first = await dispatchHerdrTask(
			{ repoPath: "/repo", task: "Add clickable transcript file paths" },
			{
				herdr: run,
				generateName: async () => "`Clickable File Paths!!` because that is the subject",
				...noSleep,
			},
		);
		expect(first.agentName).toBe("clickable-file-paths");
		const second = await dispatchHerdrTask(
			{ repoPath: "/repo", task: "Add CI caching for Node builds" },
			{
				herdr: run,
				generateName: async () => {
					throw new Error("no auth");
				},
				...noSleep,
			},
		);
		expect(second.agentName).toBe("add-ci-caching-for-node-builds");
		expect(second.branch).toBe("agent/add-ci-caching-for-node-builds");
		expect(calls.filter((call) => call[1] === "start")).toHaveLength(2);
	});

	it("does not generate a name when an explicit name is provided", async () => {
		const { run } = fakeHerdr({
			"worktree create": () => createdWorktree,
			"agent get": () => {
				throw new Error("agent_not_found");
			},
			"agent start": (args) => ({ agent: { name: args[2] } }),
			"agent wait": () => ({}),
		});
		let generated = 0;
		const result = await dispatchHerdrTask(
			{ repoPath: "/repo", task: "Fix the thing", name: "fix-thing" },
			{
				herdr: run,
				generateName: async () => {
					generated += 1;
					return "should-not-run";
				},
				...noSleep,
			},
		);
		expect(generated).toBe(0);
		expect(result.agentName).toBe("fix-thing");
	});

	it("derives the branch and agent name from the task when no name is given", async () => {
		const { run } = fakeHerdr({
			"worktree create": () => createdWorktree,
			"agent get": () => {
				throw new Error("agent_not_found");
			},
			"agent start": (args) => ({ agent: { name: args[2] } }),
			"agent wait": () => ({}),
		});
		const result = await dispatchHerdrTask(
			{ repoPath: "/repo", task: "Add CI caching for Node builds" },
			{ herdr: run, ...noSleep },
		);
		expect(result.branch).toBe("agent/add-ci-caching-for-node-builds");
		expect(result.agentName).toBe("add-ci-caching-for-node-builds");
	});

	it("starts a long omitted-name task with one Herdr-valid identifier for agent, label, and branch", async () => {
		const { run, calls } = fakeHerdr({
			"worktree create": () => createdWorktree,
			"agent get": () => {
				throw new Error("agent_not_found");
			},
			"agent start": (args) => ({ agent: { name: args[2] } }),
			"agent wait": () => ({}),
		});
		const result = await dispatchHerdrTask(
			{ repoPath: "/repo", task: "backport patch review this set of patch" },
			{ herdr: run, ...noSleep },
		);
		const started = calls.find((call) => call[0] === "agent" && call[1] === "start");
		const created = calls.find((call) => call[0] === "worktree" && call[1] === "create");
		const name = started?.[2];
		expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
		expect(name?.length).toBeLessThanOrEqual(32);
		expect(created?.[created.indexOf("--label") + 1]).toBe(name);
		expect(created?.[created.indexOf("--branch") + 1]).toBe(`agent/${name}`);
		expect(result.agentName).toBe(name);
		expect(result.branch).toBe(`agent/${name}`);
	});
});
