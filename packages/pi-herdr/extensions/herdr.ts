import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { herdr, herdrText } from "../src/cli.ts";
import { defaultConfig, herdrConfig, type HerdrConfig } from "../src/config.ts";
import { dispatchHerdrTask, parsePrUrl } from "../src/dispatch.ts";
import { knownRepos, resolveRepo, worktreeBaseRepo, worktreeTrust } from "../src/repos.ts";

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
	void herdrConfig().then((c) => (configSnapshot = c));

	pi.on("project_trust", async (event) => {
		const config = await herdrConfig();
		const inWorktreeRoot = config.worktreeRoots.some((root) => event.cwd.startsWith(root + "/"));
		if (!inWorktreeRoot) return { trusted: "undecided" as const };
		const base = await worktreeBaseRepo(event.cwd);
		return { trusted: worktreeTrust(event.cwd, base, config) };
	});

	pi.registerTool({
		name: "herdr_task",
		label: "Herdr Task",
		description:
			"Dispatch a task to a new pi agent in a herdr-managed named worktree. Infer `repo` (short name like 'pi-extensions' or 'home-ops') from the conversation; omit it to use the current directory's repo. Creates worktree + branch, starts the agent, submits the prompt, returns immediately. Write the task prompt fully self-contained: the agent has no context from this session. Check progress with herdr_task_status.",
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
					description: "Short kebab-case label for the agent/worktree; derived from the task if omitted",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const config = await herdrConfig();
			const repoPath = await resolveRepo(params.repo, ctx.cwd, config.repoRoots);
			const result = await dispatchHerdrTask({ repoPath, task: params.task, name: params.name });
			return {
				content: [
					{
						type: "text",
						text: `Dispatched agent "${result.agentName}" in ${result.worktreePath} (branch ${result.branch}). Check with herdr_task_status.`,
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
			agent: Type.String({ description: "Agent name from herdr_task" }),
			wait: Type.Optional(Type.Boolean({ description: "Block until the agent settles (default false)" })),
			timeout_ms: Type.Optional(Type.Number({ description: "Max wait, ms. Only with wait=true" })),
			lines: Type.Optional(Type.Number({ description: "Terminal lines to read (default 60)" })),
		}),
		async execute(_id, params, signal) {
			if (params.wait) {
				const args = ["agent", "wait", params.agent];
				if (params.timeout_ms) args.push("--timeout", String(params.timeout_ms));
				await herdr(args);
			}
			const info = await herdr(["agent", "get", params.agent]);
			const output = await herdrText(
				["agent", "read", params.agent, "--lines", String(params.lines ?? 60), "--format", "text"],
				signal as AbortSignal | undefined,
			);
			return {
				content: [
					{
						type: "text",
						text: `state: ${info.agent.agent_status}\ncwd: ${info.agent.cwd}\n\n--- recent output ---\n${output}`,
					},
				],
				details: { status: info.agent.agent_status, cwd: info.agent.cwd },
			};
		},
	});

	async function dispatchReview(url: string, ctx: ExtensionContext): Promise<void> {
		const pr = parsePrUrl(url);
		if (!pr) {
			ctx.ui.notify("Usage: /review <github-pr-url>", "error");
			return;
		}
		try {
			const config = await herdrConfig();
			const repoPath = await resolveRepo(pr.repo, ctx.cwd, config.repoRoots);
			ctx.ui.notify(`Dispatching review agent for ${pr.repo}#${pr.num}...`, "info");
			const result = await dispatchHerdrTask({
				repoPath,
				task: `/pr-review https://github.com/${pr.org}/${pr.repo}/pull/${pr.num}`,
				name: `review-pr-${pr.num}`,
			});
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
				const result = await dispatchHerdrTask({ repoPath, task });
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
