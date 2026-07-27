/**
 * Workflows — model-authored multi-agent orchestration.
 *
 * The `workflow` tool takes a JavaScript program written by the model and runs
 * it in a locked-down sandbox. The script fans work out to isolated child
 * agents and can branch on what they return:
 *
 *   phase("Discover")
 *   const found = await agent("List every file lacking X", { schema: {...} })
 *
 *   phase("Audit")
 *   const results = await parallel(
 *     found.structured.files.map(f => () => agent(`Audit ${f}`)),
 *     { concurrency: 4 },
 *   )
 *
 *   if (!results.every(r => r.ok)) return { status: "partial", results }
 *   return { status: "ok", results }
 *
 * Why this exists when `subagent { tasks: [...] }` already does fan-out: the
 * shape of a workflow can depend on results. Map-reduce over a set discovered
 * at runtime, escalation ladders (cheap model, then stronger on failure),
 * review→fix→re-review loops, consensus with tie-break. None of those can be
 * expressed as a fixed task list, and doing them from the parent costs a turn
 * and a context window per step.
 *
 * Two layers of isolation, and they are different things:
 *
 *  - The **script** runs under Node `--permission` with no fs/net/spawn, in a
 *    `vm` context with a null-prototype global and code generation disabled.
 *    See lib/workflow-sandbox.ts and lib/workflow-child.cjs.
 *  - Each **agent call** is executed by the `subagent` runner, so children
 *    inherit our worktree isolation, budgets, profiles, retries and structured
 *    output. This is the deliberate difference from the reference
 *    implementation, whose workflow children run with ambient parent tool
 *    access and no worktree — meaning parallel writers there can corrupt each
 *    other. Here a writing workflow gets a worktree per child.
 *
 * Artifacts land in ~/.pi/agent/workflows/<runId>/ so a run can be inspected
 * after the fact. There is no resume: a failed workflow is re-run.
 */

import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type AgentRequestOptions,
	type AgentRunResult,
	runWorkflowSandbox,
	safeStringify,
} from "../src/sandbox.ts";
import { THINKING, VALID_PROFILES, workflowConfig } from "../src/config.ts";

interface AgentRecord {
	id: number;
	label: string;
	phase?: string;
	model: string;
	ok: boolean;
	error?: string;
	outputBytes: number;
	startedAt: number;
	endedAt?: number;
	/** Branch holding a writer's changes, when its worktree ended up modified. */
	worktreeBranch?: string;
}

function workflowsDir(): string {
	// getAgentDir() respects PI_AGENT_DIR and rebranded distributions.
	return path.join(getAgentDir(), "workflows");
}

const str = (value: unknown, fallback = ""): string =>
	typeof value === "string" && value.trim() ? value.trim() : fallback;

/**
 * Resolve `runTasks` from the pi-subagent package.
 *
 * `runTasks` (the orchestrator), not `runSubagent` (a bare child process): only
 * the orchestrator honours `isolation: "worktree"`, by creating the worktree
 * before launch and finalizing it after. `runSubagent` silently ignores the
 * field, which would put every parallel writer in the same checkout — exactly
 * the corruption this tool claims to prevent.
 *
 * The package ships TypeScript source with no `exports` map, so the module
 * cannot be reached by bare subpath specifier. Resolving its `package.json`
 * through `createRequire` finds the install wherever npm actually put it (local
 * node_modules, a workspace symlink, a global pi package dir) instead of
 * guessing at hardcoded home-directory paths. `PI_SUBAGENT_SRC` remains as an
 * escape hatch for a checkout that is not installed as a dependency at all.
 */
type RunSubagent = (specs: unknown[], options: { signal?: AbortSignal }) => Promise<{ results: any[] }>;
/**
 * Cache the in-flight *promise*, not the resolved function. Concurrent agent()
 * calls (the normal case inside parallel()) would otherwise each start their own
 * `import()` of the same module: the second caller can observe a half-evaluated
 * module and get `runSubagent` before its class declarations are initialized,
 * failing with "Cannot access 'ChildRunner' before initialization". One shared
 * promise means one evaluation; a failed load clears the cache so it can retry.
 */
let runnerCache: Promise<RunSubagent> | undefined;

function loadRunner(): Promise<RunSubagent> {
	if (!runnerCache) {
		runnerCache = loadRunnerUncached().catch((error: unknown) => {
			runnerCache = undefined;
			throw error;
		});
	}
	return runnerCache;
}

async function loadRunnerUncached(): Promise<RunSubagent> {
	const candidates: string[] = [];
	if (process.env.PI_SUBAGENT_SRC) {
		candidates.push(path.join(process.env.PI_SUBAGENT_SRC, "src/orchestrator.ts"));
	}
	try {
		// Resolve the dependency wherever it really is, rather than assuming a path.
		const require = createRequire(import.meta.url);
		const root = path.dirname(require.resolve("@parke.dev/pi-subagent/package.json"));
		candidates.push(path.join(root, "src/orchestrator.ts"));
	} catch {
		// Not installed as a resolvable dependency; PI_SUBAGENT_SRC may still work.
	}

	const failures: string[] = [];
	for (const candidate of candidates) {
		try {
			const module = await import(candidate);
			if (typeof module.runTasks === "function") return module.runTasks as RunSubagent;
			failures.push(`${candidate}: no runTasks export`);
		} catch (error) {
			failures.push(`${candidate}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
		}
	}
	throw new Error(
		[
			"workflow needs @parke.dev/pi-subagent to execute agent() calls, but could not load it.",
			"Install it with: pi install npm:@parke.dev/pi-subagent",
			"Or set PI_SUBAGENT_SRC to a local checkout's package root.",
			candidates.length
				? `Tried:\n${failures.map((line) => `  ${line}`).join("\n")}`
				: "No candidate paths were resolvable.",
		].join("\n"),
	);
}

export default async function (pi: ExtensionAPI) {
	const config = await workflowConfig();

	pi.registerTool({
		name: "workflow",
		label: "Workflow",
		description: [
			"Run a multi-phase, multi-agent orchestration program that you write yourself in JavaScript.",
			"",
			"Use this ONLY when the shape of the work depends on results you do not have yet:",
			"map-reduce over a set discovered at runtime, escalating to a stronger model when a cheap one fails,",
			"review->fix->re-review loops, or consensus with a tie-break. For a fixed set of independent tasks,",
			"use `subagent` with `tasks` instead — it is simpler and cheaper.",
			"",
			"Available inside the script (no imports, no require, no fs, no network):",
			"  phase(title)                        mark progress",
			"  await agent(prompt, options?)       run one child agent; resolves {ok, output, structured?, error?} and NEVER throws",
			`  await parallel([() => agent(...)])  run thunks concurrently (max ${config.maxConcurrency})`,
			"  args                                the JSON you passed as `args`",
			"  return value                        becomes the tool result (must be JSON-serializable)",
			"",
			"agent() options: { label, phase, model, thinking, profile, schema }.",
			"Pass `schema` (a JSON Schema) to get validated `structured` output back.",
			"profile 'explore'/'review' are read-only; 'general' can write and each writer gets its own git worktree.",
			"",
			`Limits: ${config.maxAgentRequests} agent calls per run, concurrency ${config.maxConcurrency}, ${config.agentMaxTurns} turns and $${config.agentMaxCost} per agent.`,
			"Every agent() call must be awaited. There is no resume: a failed run is re-run.",
		].join("\n"),
		parameters: Type.Object(
			{
				script: Type.String({
					minLength: 1,
					description:
						"JavaScript body (not a module). Use await at top level, call phase()/agent()/parallel(), and `return` a JSON-serializable summary.",
				}),
				description: Type.Optional(
					Type.String({ description: "Short label for this run, shown in /workflows." }),
				),
				args: Type.Optional(
					Type.String({ description: "JSON string made available to the script as `args`." }),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params: any, signal, onUpdate, ctx: ExtensionContext) {
			const runId = `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
			const label = str(params.description, "workflow");
			const startedAt = Date.now();

			let parsedArgs: unknown;
			if (params.args !== undefined) {
				try {
					parsedArgs = JSON.parse(params.args);
				} catch (error) {
					throw new Error(
						`args must be a JSON string: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}

			const records: AgentRecord[] = [];
			let currentPhase: string | undefined;
			const phases: string[] = [];

			const report = () => {
				const done = records.filter((record) => record.endedAt).length;
				const failed = records.filter((record) => record.endedAt && !record.ok).length;
				onUpdate?.({
					content: [
						{
							type: "text",
							text: [
								`${label} — ${currentPhase ?? "starting"}`,
								`agents: ${done}/${records.length} done${failed ? `, ${failed} failed` : ""}`,
							].join("\n"),
						},
					],
					details: { runId, phase: currentPhase, agents: records.length, done, failed },
				} as never);
			};

			// Workflow-wide timeout, layered over the caller's signal.
			const controller = new AbortController();
			const onOuterAbort = () => controller.abort();
			signal?.addEventListener("abort", onOuterAbort, { once: true });
			const timeout = setTimeout(() => controller.abort(), config.workflowTimeoutMs);
			timeout.unref?.();

			/**
			 * Execute one agent() call through the subagent runner, so it inherits
			 * worktrees, budgets and profile enforcement. Resolves {ok:false} on
			 * failure rather than throwing: the script branches on `ok`.
			 */
			const onAgent = async (
				prompt: string,
				options: AgentRequestOptions,
				agentSignal: AbortSignal,
			): Promise<AgentRunResult> => {
				const id = records.length + 1;
				const model = str(options.model, config.defaultModel ?? ctx.model?.id ?? "");
				const thinking = THINKING.has(String(options.thinking))
					? String(options.thinking)
					: config.defaultThinking;
				const profile = VALID_PROFILES.has(String(options.profile))
					? String(options.profile)
					: config.defaultProfile;
				const record: AgentRecord = {
					id,
					label: str(options.label, `agent-${id}`),
					phase: str(options.phase, currentPhase ?? ""),
					model,
					ok: false,
					outputBytes: 0,
					startedAt: Date.now(),
				};
				records.push(record);
				report();

				try {
					const run = await (
						await loadRunner()
					)(
						[
							{
								task: prompt,
								label: record.label,
								model,
								thinking: thinking as never,
								profile: profile as never,
								// Read-only profiles get a read-only tool set; a writer gets a
								// worktree so parallel writers cannot corrupt each other.
								tools: profile === "general" ? undefined : ["read", "grep", "find", "ls"],
								canWrite: profile === "general",
								isolation: profile === "general" ? "worktree" : "shared",
								cwd: ctx.cwd,
								timeoutMs: config.agentTimeoutMs,
								maxTurns: config.agentMaxTurns,
								maxCost: config.agentMaxCost,
								...(options.schema !== undefined
									? { outputSchema: options.schema as Record<string, unknown> }
									: {}),
							},
						] as never[],
						{ signal: agentSignal },
					);
					const result = run.results[0];
					if (!result) throw new Error("subagent orchestrator returned no result");

					record.endedAt = Date.now();
					const output = String(result.finalOutput ?? result.liveText ?? "");
					record.outputBytes = Buffer.byteLength(output, "utf8");
					record.ok = result.state === "completed" || result.state === "partial";
					if (!record.ok) record.error = result.errorMessage ?? result.state;
					// A writer's edits live on its own branch, not in ctx.cwd. Record it so
					// the caller can find the work (subagent action:'diff'/'apply').
					if (result.worktree?.changed) record.worktreeBranch = String(result.worktree.branch);
					report();
					return {
						ok: record.ok,
						output,
						...(result.structuredOutput !== undefined ? { structured: result.structuredOutput } : {}),
						...(record.ok ? {} : { error: record.error }),
					};
				} catch (error) {
					record.endedAt = Date.now();
					record.error = error instanceof Error ? error.message : String(error);
					report();
					return { ok: false, output: "", error: record.error };
				}
			};

			let result: unknown;
			let failure: string | undefined;
			try {
				result = await runWorkflowSandbox({
					source: params.script,
					args: parsedArgs,
					cwd: ctx.cwd,
					signal: controller.signal,
					maxAgentRequests: config.maxAgentRequests,
					maxConcurrency: config.maxConcurrency,
					onAgent,
					onPhase: (title) => {
						currentPhase = title;
						phases.push(title);
						report();
					},
				});
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			} finally {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onOuterAbort);
			}

			// Persist artifacts before returning so a failed run is still inspectable.
			const dir = path.join(workflowsDir(), runId);
			let artifactNote = "";
			try {
				await fs.mkdir(dir, { recursive: true, mode: 0o700 });
				await fs.writeFile(path.join(dir, "script.js"), params.script, { mode: 0o600 });
				if (params.args !== undefined)
					await fs.writeFile(path.join(dir, "args.json"), params.args, { mode: 0o600 });
				await fs.writeFile(
					path.join(dir, "workflow.json"),
					safeStringify(
						{
							runId,
							label,
							startedAt,
							endedAt: Date.now(),
							phases,
							failure: failure ?? null,
							agents: records,
						},
						1024 * 1024,
					),
					{ mode: 0o600 },
				);
				if (failure === undefined) {
					await fs.writeFile(path.join(dir, "result.json"), safeStringify(result, 1024 * 1024), {
						mode: 0o600,
					});
				}
				artifactNote = `\nartifacts: ${dir}`;
			} catch {
				artifactNote = "\n(artifacts could not be written)";
			}

			const summary = [
				`${label} — ${records.length} agent call(s) in ${phases.length || 1} phase(s), ${(
					(Date.now() - startedAt) /
					1000
				).toFixed(1)}s`,
				...records.map(
					(record) =>
						`  ${record.ok ? "✓" : "✗"} ${record.label}${record.phase ? ` [${record.phase}]` : ""} ${record.model}` +
						`${record.error ? ` — ${record.error}` : ""}` +
						`${record.worktreeBranch ? ` — changes on branch ${record.worktreeBranch}` : ""}`,
				),
				...(records.some((record) => record.worktreeBranch)
					? [
							"",
							"Writers ran in isolated worktrees: their edits are on the branches above, not in this checkout.",
						]
					: []),
			].join("\n");

			if (failure !== undefined) {
				// Throw so pi marks the tool failed, but keep the per-agent detail:
				// paid work already done should not be invisible.
				throw new Error(`Workflow failed: ${failure}\n\n${summary}${artifactNote}`);
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `${summary}${artifactNote}\n\nresult:\n${safeStringify(result, 256 * 1024)}`,
					},
				],
				details: { runId, label, phases, agents: records, dir },
			};
		},
	});

	pi.registerCommand("workflows", {
		description: "List recent workflow runs and where their artifacts are",
		handler: async (_args: string, ctx: ExtensionContext) => {
			try {
				const entries = await fs.readdir(workflowsDir(), { withFileTypes: true });
				const runs = entries
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name)
					.sort()
					.reverse()
					.slice(0, 15);
				if (!runs.length) return ctx.ui.notify("No workflow runs yet", "info");
				const lines: string[] = [];
				for (const run of runs) {
					try {
						const meta = JSON.parse(
							await fs.readFile(path.join(workflowsDir(), run, "workflow.json"), "utf8"),
						);
						const ok = meta.failure ? "✗" : "✓";
						lines.push(
							`${ok} ${run} ${meta.label} — ${meta.agents?.length ?? 0} agents${meta.failure ? ` (${meta.failure})` : ""}`,
						);
					} catch {
						lines.push(`? ${run}`);
					}
				}
				ctx.ui.notify([`${workflowsDir()}`, ...lines].join("\n"), "info");
			} catch {
				ctx.ui.notify("No workflow runs yet", "info");
			}
		},
	});
}
