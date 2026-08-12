import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { herdr, herdrText } from "../src/cli.ts";
import { cleanupHerdrTask } from "../src/cleanup.ts";
import { defaultConfig, herdrConfig, type HerdrConfig } from "../src/config.ts";
import {
	detectHerdrContext,
	requireManagedHerdr,
	withoutHerdrTools,
	withHerdrContext,
} from "../src/context.ts";
import { dispatchHerdrTask, parsePrUrl } from "../src/dispatch.ts";
import { generateNameIfOmitted } from "../src/name-from-task.ts";
import { AGENT_NAME_PATTERN, AGENT_TARGET_PATTERN } from "../src/names.ts";
import { knownRepos, resolveRepo, worktreeBaseRepo, worktreeTrust } from "../src/repos.ts";
import { getHerdrTaskStatus } from "../src/status.ts";

// Task herdr-managed pi agents in repo worktrees.
//
// /herdr-task <task...>  — command form (repo inferred: leading repo name, or cwd)
// herdr_task tool        — LLM-callable form (repo by short name, from context)
//
// Flow: resolve repo → herdr worktree create (or reuse) → herdr agent start
// (or adopt) → herdr agent prompt with swallow-guard verification.
// Fire-and-forget; check with herdr_task_status.

export default function (pi: ExtensionAPI) {
	// Completions are synchronous; keep a resolved snapshot for them.
	let configSnapshot: HerdrConfig = defaultConfig;
	void herdrConfig().then(
		(c) => (configSnapshot = c),
		() => {
			// Keep defaults; the async paths surface the load error themselves.
		},
	);

	pi.on("project_trust", async (event) => {
		const config = await herdrConfig();
		const base = await worktreeBaseRepo(event.cwd);
		return { trusted: worktreeTrust(event.cwd, base, config) };
	});

	pi.on("session_start", () => {
		if (detectHerdrContext().managed) return;
		pi.setActiveTools(withoutHerdrTools(pi.getActiveTools()));
	});

	pi.on("before_agent_start", (event) => ({
		systemPrompt: withHerdrContext(event.systemPrompt, detectHerdrContext()),
	}));

	pi.registerTool({
		name: "herdr_task",
		label: "Herdr Task",
		description:
			"Dispatch a task to a new pi agent in a herdr-managed named worktree. Infer `repo` (short name like 'pi-extensions' or 'home-ops') from the conversation; omit it to use the current directory's repo. Creates worktree + branch, starts the agent, submits the prompt, returns immediately. Write the task prompt fully self-contained: the agent has no context from this session. Omit `name` to generate a short subject label from the task (deterministic 32-character slug fallback). Check progress with herdr_task_status.",
		parameters: Type.Object({
			task: Type.String({ description: "Complete, self-contained task prompt for the agent" }),
			repo: Type.Optional(
				Type.String({
					description:
						"Repo short name (folder name under a configured repo root). Omit for the current repo.",
				}),
			),
			name: Type.Optional(
				Type.String({
					description:
						"Herdr agent name: lowercase letter first, then lowercase letters, digits, '_' or '-' (1-32). Omit to generate a subject name from the task, with a deterministic slug fallback.",
					pattern: AGENT_NAME_PATTERN,
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			requireManagedHerdr();
			const config = await herdrConfig();
			const repoPath = await resolveRepo(params.repo, ctx.cwd, config.repoRoots);
			const result = await dispatchNamedTask(repoPath, params.task, params.name, ctx);
			return {
				content: [
					{
						type: "text",
						text: `Dispatched agent "${result.agentName}" in ${result.worktreePath} (branch ${result.branch}). Check with herdr_task_status. When its completion criteria are fully verified (e.g. PR opened and green), tear it down with herdr_task_cleanup — if sentinel tools are available, register a watch on \`herdr agent get ${result.agentName}\` reaching done/idle so you are woken to verify and clean up instead of polling.`,
					},
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "herdr_task_status",
		label: "Herdr Task Status",
		description:
			"Check a herdr-dispatched agent: current state (working/idle/done/blocked) and recent terminal output. Pass wait=true to block until it settles.",
		parameters: Type.Object({
			agent: Type.String({
				description: "Agent name from herdr_task, or a Herdr pane id such as w7:p3",
				pattern: AGENT_TARGET_PATTERN,
			}),
			wait: Type.Optional(Type.Boolean({ description: "Block until the agent settles (default false)" })),
			timeout_ms: Type.Optional(Type.Number({ description: "Max wait, ms. Only with wait=true" })),
			lines: Type.Optional(Type.Number({ description: "Terminal lines to read (default 60)" })),
		}),
		async execute(_id, params, signal) {
			requireManagedHerdr();
			const config = await herdrConfig();
			if (params.wait) {
				const args = ["agent", "wait", params.agent];
				if (params.timeout_ms) args.push("--timeout", String(params.timeout_ms));
				try {
					await herdr(args);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (!message.includes("agent_not_found")) throw error;
				}
			}
			const status = await getHerdrTaskStatus({ agent: params.agent, worktreeRoots: config.worktreeRoots });
			if (status.status === "gone") {
				const text = status.matches
					? `Agent "${params.agent}" is gone, but multiple worktrees match it:\n${status.matches.join("\n")}\nResolve the ambiguity before cleanup.`
					: status.worktreePath
						? `Agent "${params.agent}" is gone (herdr forgets agents when their workspace closes), but its worktree survives at ${status.worktreePath}. Verify its branch/PR, then herdr_task_cleanup to remove it.`
						: `Agent "${params.agent}" is gone and no matching worktree was found under the configured roots.`;
				return { content: [{ type: "text" as const, text }], details: status };
			}
			const output = await herdrText(
				["agent", "read", params.agent, "--lines", String(params.lines ?? 60), "--format", "text"],
				signal as AbortSignal | undefined,
			);
			return {
				content: [
					{
						type: "text",
						text: `state: ${status.status}\ncwd: ${status.cwd}\n\n--- recent output ---\n${output}`,
					},
				],
				details: status,
			};
		},
	});

	pi.registerTool({
		name: "herdr_task_cleanup",
		label: "Herdr Task Cleanup",
		description:
			"Tear down a finished herdr-dispatched agent: removes its worktree and workspace. Refuses unless the work is verifiably safe to discard — agent settled, no uncommitted changes, no unpushed commits — because the checkout is deleted (the pushed branch survives). Call after verifying the task's completion criteria (PR opened/merged, CI green). Use force only to discard abandoned work.",
		parameters: Type.Object({
			agent: Type.String({
				description: "Agent name (or pane id such as w7:p3) from herdr_task",
				pattern: AGENT_TARGET_PATTERN,
			}),
			force: Type.Optional(
				Type.Boolean({
					description: "Skip safety checks and discard uncommitted/unpushed work (default false)",
				}),
			),
		}),
		async execute(_id, params) {
			requireManagedHerdr();
			const config = await herdrConfig();
			const result = await cleanupHerdrTask({ ...params, worktreeRoots: config.worktreeRoots });
			if (!result.cleaned) {
				let text: string;
				if (result.reason === "nothing-found") {
					text = `Agent "${params.agent}" is unknown to herdr and no matching worktree was found under the configured roots — nothing to clean up.`;
				} else if (result.reason === "ambiguous") {
					text = `Refusing cleanup of "${params.agent}": multiple worktrees match it:\n${result.matches!.join("\n")}\nResolve the ambiguity and retry.`;
				} else {
					text = `Refusing cleanup of "${params.agent}" (${result.worktreePath}):\n- ${result.problems!.join("\n- ")}\n\nResolve these (or pass force to discard) and retry.`;
				}
				return { content: [{ type: "text" as const, text }], details: result };
			}
			const text =
				result.removal === "herdr"
					? `Cleaned up "${params.agent}": workspace ${result.workspaceId} and worktree ${result.worktreePath} removed. The pushed branch survives on the remote.`
					: `Cleaned up "${params.agent}": worktree ${result.worktreePath} removed via git (workspace was already gone). The pushed branch survives on the remote.`;
			return { content: [{ type: "text" as const, text }], details: result };
		},
	});

	async function dispatchNamedTask(
		repoPath: string,
		task: string,
		name: string | undefined,
		ctx: ExtensionContext,
	) {
		return dispatchHerdrTask({ repoPath, task, name }, { generateName: generateNameIfOmitted(name, ctx) });
	}

	function ensureManagedCommand(ctx: ExtensionContext) {
		if (detectHerdrContext().managed) return true;
		ctx.ui.notify(
			"Herdr is unavailable in this standalone Pi session. Use subagent or background terminals instead.",
			"error",
		);
		return false;
	}

	async function dispatchReview(url: string, ctx: ExtensionContext): Promise<void> {
		if (!ensureManagedCommand(ctx)) return;
		const pr = parsePrUrl(url);
		if (!pr) {
			ctx.ui.notify("Usage: /review <github-pr-url>", "error");
			return;
		}
		try {
			const config = await herdrConfig();
			const repoPath = await resolveRepo(pr.repo, ctx.cwd, config.repoRoots);
			ctx.ui.notify(`Dispatching review agent for ${pr.repo}#${pr.num}...`, "info");
			const result = await dispatchNamedTask(
				repoPath,
				`/pr-review https://github.com/${pr.org}/${pr.repo}/pull/${pr.num}`,
				`review-pr-${pr.num}`,
				ctx,
			);
			ctx.ui.notify(`Review agent "${result.agentName}" running in ${result.worktreePath}`, "info");
		} catch (error) {
			ctx.ui.notify(
				`review dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	}

	pi.registerCommand("review", {
		description: "Review a GitHub PR with a herdr subagent: /review <github-pr-url>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null =>
			prefix.length === 0
				? [{ value: "", label: "<github-pr-url>", description: "paste the PR link" }]
				: null,
		handler: async (args, ctx: ExtensionContext) => {
			let url = (args ?? "").trim();
			if (!url) {
				url = ((await ctx.ui.editor("Review PR (paste the GitHub PR URL)")) ?? "").trim();
				if (!url) return;
			}
			await dispatchReview(url, ctx);
		},
	});

	pi.registerCommand("herdr-task", {
		description: "Task a herdr pi agent: /herdr-task [repo-name] <task...> (repo defaults to cwd's)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const names = [...knownRepos(configSnapshot.repoRoots).keys()].sort();
			const items = names
				.filter((n) => n.startsWith(prefix.toLowerCase()))
				.map((n) => ({ value: n, label: n, description: "target repo" }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx: ExtensionContext) => {
			if (!ensureManagedCommand(ctx)) return;
			let trimmed = (args ?? "").trim();
			if (!trimmed) {
				trimmed = ((await ctx.ui.editor("Herdr task — [repo-name] <task or PR URL>")) ?? "").trim();
				if (!trimmed) return;
			}
			// A bare PR URL means: review it.
			if (parsePrUrl(trimmed) && trimmed.split(/\s+/).length === 1) {
				await dispatchReview(trimmed, ctx);
				return;
			}
			// If the first token names a known repo, use it; otherwise the whole
			// string is the task and the repo comes from cwd.
			const config = await herdrConfig();
			const [first, ...rest] = trimmed.split(/\s+/);
			const repos = knownRepos(config.repoRoots);
			const named = repos.has(first.toLowerCase()) && rest.length > 0;
			const task = named ? rest.join(" ") : trimmed;
			try {
				const repoPath = await resolveRepo(named ? first : undefined, ctx.cwd, config.repoRoots);
				ctx.ui.notify(`Dispatching herdr agent in ${repoPath}...`, "info");
				const result = await dispatchNamedTask(repoPath, task, undefined, ctx);
				ctx.ui.notify(
					`Agent "${result.agentName}" running in ${result.worktreePath} (${result.branch})`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					`herdr-task failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
