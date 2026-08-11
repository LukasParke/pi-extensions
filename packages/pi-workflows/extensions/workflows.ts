/**
 * Workflows — model-authored multi-agent orchestration.
 *
 * The `workflow` tool runs a JavaScript program in a locked-down sandbox and
 * fans each agent() call out through `@parke.dev/pi-subagent/sdk`. Background
 * registry, journal replay, shared worktree lane, approval, saved definitions,
 * and Ultracode policy all live in this package — no Pi core changes.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestLaunchApproval } from "../src/approval.ts";
import { coerceArgs, prepareWorkflowArguments } from "../src/args.ts";
import { workflowConfig } from "../src/config.ts";
import { argsHashOf, listRecentSummaries, readDefinition, runDir, sourceHashOf } from "../src/journal.ts";
import {
	isTerminalState,
	type LiveWorkflowRun,
	type WorkflowTerminal,
	WorkflowRunRegistry,
} from "../src/registry.ts";
import { executeWorkflow, loadResumeSource, newRunId } from "../src/runner.ts";
import { safeStringify } from "../src/sandbox.ts";
import { listSavedWorkflows, resolveSavedWorkflow, saveWorkflow } from "../src/saved.ts";
// Stable boundary module (re-exports the planned `@parke.dev/pi-subagent/sdk` surface).
import { emptyUsage } from "../src/subagent-sdk.ts";
import {
	COMPLETION_TYPE,
	ENTRY_TYPE,
	formatRunLine,
	openWorkflowsOverlay,
	refreshWorkflowUi,
	WIDGET_KEY,
} from "../src/ui.ts";
import { createUltracodeState, registerUltracode } from "../src/ultracode.ts";
import { formatUsageLine } from "../src/usage.ts";

const str = (value: unknown, fallback = ""): string =>
	typeof value === "string" && value.trim() ? value.trim() : fallback;

function sessionKeyOf(ctx: ExtensionContext) {
	return ctx.sessionManager?.getSessionFile?.() ?? ctx.cwd ?? "default";
}

export default async function (pi: ExtensionAPI) {
	const config = await workflowConfig();
	const registry = new WorkflowRunRegistry();
	const ultracode = createUltracodeState(config.defaultSize);
	let activeSessionKey = "default";
	let widgetCtx: ExtensionContext | undefined;

	const paint = () => {
		if (!widgetCtx?.ui) return;
		refreshWorkflowUi(
			(key, content) => widgetCtx!.ui.setWidget(key, content),
			(key, content) =>
				widgetCtx!.ui.setStatus(key, content ? widgetCtx!.ui.theme.fg("warning", content) : undefined),
			registry,
			activeSessionKey,
		);
	};
	registry.subscribe((run) => {
		paint();
		if (isTerminalState(run.state) && !registry.isShuttingDown) {
			void deliverCompletion(pi, registry, run);
		}
	});

	registerUltracode(pi, ultracode, config);

	pi.registerEntryRenderer(ENTRY_TYPE, (entry, _opts, theme) => {
		const data = (entry.data ?? {}) as {
			runId?: string;
			state?: string;
			label?: string;
			phase?: string;
			counts?: string;
			cost?: string;
		};
		const line =
			theme.fg("accent", "workflow") +
			` ${data.runId ?? "?"} ${data.label ?? ""} [${data.state ?? "?"}] ${data.phase ?? ""} ${data.counts ?? ""} ${data.cost ?? ""}`.trim();
		return {
			render: () => [line],
			invalidate() {},
		};
	});

	pi.on("session_start", (_event, ctx) => {
		registry.resetForSession();
		activeSessionKey = sessionKeyOf(ctx);
		widgetCtx = ctx;
		paint();
	});

	pi.on("session_shutdown", async () => {
		widgetCtx?.ui.setStatus(WIDGET_KEY, undefined);
		widgetCtx?.ui.setWidget(WIDGET_KEY, undefined);
		widgetCtx = undefined;
		await registry.shutdown();
	});

	pi.on("agent_settled", () => {
		// Deliver background completions once the parent is idle.
		for (const run of registry.undeliveredTerminal(activeSessionKey)) {
			void deliverCompletion(pi, registry, run);
		}
	});

	const launch = async (options: {
		script: string;
		description?: string;
		args?: unknown;
		name?: string;
		ctx: ExtensionContext;
		signal?: AbortSignal;
		background: boolean;
		resumeFrom?: string;
		preApproved?: boolean;
		runId?: string;
		toolExecution?: boolean;
	}) => {
		const runId = options.runId ?? newRunId();
		const label = str(options.description, options.name ?? "workflow");
		const agentDir = getAgentDir();
		const sk = sessionKeyOf(options.ctx);
		activeSessionKey = sk;
		widgetCtx = options.ctx;

		const approval = await requestLaunchApproval({
			config,
			request: {
				label,
				description: options.description,
				scriptPreview: options.script,
				maxAgentRequests: config.maxAgentRequests,
				maxConcurrency: config.maxConcurrency,
				agentMaxCost: config.agentMaxCost,
				agentMaxTurns: config.agentMaxTurns,
				workflowTimeoutMs: config.workflowTimeoutMs,
				writersPossible: /profile\s*:\s*["']general["']|isolation\s*:\s*["']worktree["']/.test(
					options.script,
				),
				savedName: options.name,
				preApproved: options.preApproved,
			},
			ctx: options.ctx,
			pi: options.toolExecution ? pi : undefined,
			signal: options.signal,
		});
		if (!approval.ok) throw new Error(approval.reason);

		const existing = registry.get(runId);
		if (existing && !isTerminalState(existing.state))
			throw new Error(`Workflow run ${runId} is still active`);

		if (options.script.length > 100 && countAgentCallsHint(options.script) >= config.largeRunWarnAgents) {
			options.ctx.ui.notify(
				`Large workflow warning: script may exceed ~${config.largeRunWarnAgents} agent calls (hard cap ${config.maxAgentRequests}).`,
				"warning",
			);
		}

		const controller = new AbortController();
		const onOuter = () => controller.abort(new Error("Workflow cancelled"));
		if (!options.background) options.signal?.addEventListener("abort", onOuter, { once: true });
		const timeout = setTimeout(
			() => controller.abort(new Error("Workflow timed out")),
			config.workflowTimeoutMs,
		);
		timeout.unref?.();

		const artifactPath = options.resumeFrom ?? runDir(agentDir, runId);

		const promise = executeWorkflow({
			runId,
			label,
			source: options.script,
			args: options.args,
			cwd: options.ctx.cwd,
			agentDir,
			config,
			signal: controller.signal,
			ctx: options.ctx,
			activeTools: pi.getActiveTools(),
			resumeFrom: options.resumeFrom,
			workflowName: options.name,
			onProgress: (progress) => {
				registry.update(runId, {
					phase: progress.phase,
					agentCount: progress.agentCount,
					completedAgents: progress.completedAgents,
					failedAgents: progress.failedAgents,
					usage: progress.usage,
					state: progress.state,
				});
			},
		}).finally(() => {
			clearTimeout(timeout);
			if (!options.background) options.signal?.removeEventListener("abort", onOuter);
		});

		const live: LiveWorkflowRun = {
			runId,
			sessionKey: sk,
			label,
			state: "running",
			startedAt: Date.now(),
			agentCount: 0,
			completedAgents: 0,
			failedAgents: 0,
			usage: emptyUsage(),
			artifactPath,
			delivered: false,
			claimed: false,
			controller,
			promise: promise.then((exec): WorkflowTerminal => ({
				runId,
				state: exec.state,
				result: exec.result,
				failure: exec.failure,
				summary: exec.summary,
			})),
			sourceHash: sourceHashOf(options.script),
			argsHash: argsHashOf(options.args),
			cwd: options.ctx.cwd,
			workflowName: options.name,
		};
		registry.register(live);

		pi.appendEntry(ENTRY_TYPE, {
			runId,
			state: "running",
			label,
			phase: "starting",
			counts: "0/0",
			artifactPath,
		});

		if (!options.background) {
			const terminal = await live.promise;
			registry.claim(runId);
			if (registry.markDelivered(runId)) appendTerminalEntry(pi, terminal);
			return formatTerminalToolResult(terminal);
		}

		return {
			content: [
				{
					type: "text" as const,
					text: [
						`Workflow started: ${runId}`,
						`label: ${label}`,
						`artifacts: ${artifactPath}`,
						"Use workflow action status/wait/cancel or /workflows to inspect.",
					].join("\n"),
				},
			],
			details: { runId, label, state: "running", artifactPath },
		};
	};

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
			"Actions: start (default) | status | wait | cancel | resume | rerun | list.",
			"Start with either `script` (inline body) or `name` (saved workflow). Never pass filesystem paths.",
			"",
			"Available inside the script (no imports, no require, no fs, no network):",
			"  phase(title)                              mark progress",
			"  await agent(prompt, options?)             run one child; resolves {ok, output, structured?, error?, usage?}",
			`  await parallel([() => agent(...)])        concurrent thunks (max ${config.maxConcurrency})`,
			`  await pipeline(items, x => agent(...))    map a discovered collection (max ${config.maxConcurrency})`,
			"  args                                      structured invocation data",
			"  return value                              tool result (JSON-serializable)",
			"",
			"agent() options: { label, phase, model, thinking, profile, schema, isolation, maxTurns, maxCost, timeoutMs, fallbackModels }.",
			"isolation: 'workflow' (default shared lane) | 'worktree' (independent writer).",
			"profile 'explore'/'review' are read-only; 'general' writes on the shared workflow worktree (serialized).",
			"",
			`Limits: ${config.maxAgentRequests} agent calls, concurrency ${config.maxConcurrency}, ${config.agentMaxTurns} turns and $${config.agentMaxCost} per agent.`,
			"Background by default: start returns a run id; completion is delivered as a follow-up.",
		].join("\n"),
		parameters: Type.Object(
			{
				action: Type.Optional(
					Type.String({
						description: "start | status | wait | cancel | resume | rerun | list (default start)",
					}),
				),
				script: Type.Optional(
					Type.String({
						description: "JavaScript body (not a module). Required for start unless `name` is set.",
					}),
				),
				name: Type.Optional(
					Type.String({
						description: "Saved workflow name (resolved only in trusted global/project definition dirs).",
					}),
				),
				description: Type.Optional(Type.String({ description: "Short label for this run." })),
				args: Type.Optional(
					Type.Unknown({ description: "Structured args object (or legacy JSON string) exposed as `args`." }),
				),
				id: Type.Optional(Type.String({ description: "Run id for status/wait/cancel/resume/rerun." })),
				async: Type.Optional(
					Type.Boolean({
						description: "If false, block until the run finishes. Default: config backgroundByDefault.",
					}),
				),
				timeout_ms: Type.Optional(
					Type.Number({ description: "For wait: max ms to block (default no extra limit)." }),
				),
			},
			{ additionalProperties: false },
		),
		prepareArguments: prepareWorkflowArguments,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const action = str(params.action, "start").toLowerCase();

			if (action === "list") {
				const live = registry.list(sessionKeyOf(ctx));
				const recent = await listRecentSummaries(getAgentDir(), 10);
				const lines = [
					"Live:",
					...(live.length ? live.map(formatRunLine) : ["  (none)"]),
					"",
					"Recent artifacts:",
					...(recent.length
						? recent.map(
								(s) =>
									`  ${s.state === "completed" ? "✓" : "✗"} ${s.runId} ${s.label} — ${s.agentCount} agents ${s.failure ? `(${s.failure})` : ""}`,
							)
						: ["  (none)"]),
				];
				return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { live, recent } };
			}

			if (action === "status") {
				const run = requireRun(registry, params.id);
				onUpdate?.({
					content: [{ type: "text", text: formatRunLine(run) }],
					details: registry.toSummary(run),
				} as never);
				return {
					content: [{ type: "text" as const, text: formatRunLine(run) }],
					details: registry.toSummary(run),
				};
			}

			if (action === "cancel") {
				const result = registry.cancel(str(params.id));
				if (!result.ok) throw new Error(result.error);
				return {
					content: [
						{
							type: "text" as const,
							text: result.alreadyDone
								? `Run ${result.run.runId} already ${result.run.state}`
								: `Cancelled ${result.run.runId}`,
						},
					],
					details: registry.toSummary(result.run),
				};
			}

			if (action === "wait") {
				const run = requireRun(registry, params.id);
				const ms = typeof params.timeout_ms === "number" ? params.timeout_ms : undefined;
				const terminal = await waitForRun(run, ms, signal);
				registry.claim(run.runId);
				if (registry.markDelivered(run.runId)) appendTerminalEntry(pi, terminal);
				return formatTerminalToolResult(terminal);
			}

			if (action === "resume" || action === "rerun") {
				const id = str(params.id);
				if (!id) throw new Error(`${action} requires id`);
				const loaded = await loadResumeSource(getAgentDir(), id);
				// Also allow prefix via live registry artifact path.
				const live = registry.get(id);
				const dir = loaded?.dir ?? live?.artifactPath;
				const definition = loaded?.definition ?? (dir ? await readDefinition(dir) : undefined);
				if (!definition || !dir) throw new Error(`Unknown workflow run: ${id}`);

				if (action === "resume") {
					return launch({
						script: definition.source,
						description: definition.identity.label,
						args: definition.args,
						name: definition.identity.workflowName,
						ctx,
						signal,
						background: params.async !== false && config.backgroundByDefault,
						resumeFrom: dir,
						preApproved: true,
						runId: definition.identity.runId,
						toolExecution: true,
					});
				}
				// rerun from scratch with same source/args
				return launch({
					script: definition.source,
					description: definition.identity.label,
					args: definition.args,
					name: definition.identity.workflowName,
					ctx,
					signal,
					background: params.async !== false && config.backgroundByDefault,
					preApproved: true,
					toolExecution: true,
				});
			}

			// start
			const argsResult = coerceArgs(params.args);
			if (!argsResult.ok) throw new Error(argsResult.error);

			let script = typeof params.script === "string" ? params.script : undefined;
			let name = typeof params.name === "string" ? params.name : undefined;
			let description = typeof params.description === "string" ? params.description : undefined;
			let preApproved = false;

			if (name) {
				const saved = await resolveSavedWorkflow({
					name,
					cwd: ctx.cwd,
					projectTrusted: ctx.isProjectTrusted(),
					agentDir: getAgentDir(),
				});
				if (!saved) throw new Error(`Unknown saved workflow "${name}" (name-based resolution only)`);
				script = saved.script;
				description = description ?? saved.description ?? saved.name;
				preApproved = saved.defaults?.preApproved === true;
			}

			if (!script?.trim()) throw new Error("start requires script or name");

			const background = typeof params.async === "boolean" ? params.async : config.backgroundByDefault;

			return launch({
				script,
				description,
				args: argsResult.args,
				name,
				ctx,
				signal,
				background,
				preApproved,
				toolExecution: true,
			});
		},
	});

	pi.registerCommand("workflows", {
		description: "List/inspect workflow runs (overlay when UI available)",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = (parts[0] ?? "").toLowerCase();

			if (sub === "save") {
				const name = parts[1];
				if (!name) return ctx.ui.notify("Usage: /workflows save <name> [global|project]", "info");
				// Save most recent live/completed script from artifacts.
				const recent = registry.list(sessionKeyOf(ctx))[0] ?? undefined;
				const dir = recent?.artifactPath;
				const definition = dir ? await readDefinition(dir) : undefined;
				if (!definition) return ctx.ui.notify("No recent workflow script to save", "warning");
				const scope = parts[2] === "project" ? "project" : "global";
				if (scope === "project" && !ctx.isProjectTrusted()) {
					return ctx.ui.notify("Project is not trusted; save to global or trust the project", "warning");
				}
				const path = await saveWorkflow({
					name,
					script: definition.source,
					description: definition.identity.label,
					scope,
					cwd: ctx.cwd,
					agentDir: getAgentDir(),
				});
				return ctx.ui.notify(`Saved ${name} → ${path}`, "info");
			}

			if (sub === "saved") {
				const saved = await listSavedWorkflows({
					cwd: ctx.cwd,
					projectTrusted: ctx.isProjectTrusted(),
					agentDir: getAgentDir(),
				});
				if (!saved.length) return ctx.ui.notify("No saved workflows", "info");
				return ctx.ui.notify(
					saved.map((s) => `${s.name} (${s.scope}) ${s.description ?? ""}`).join("\n"),
					"info",
				);
			}

			if (sub === "cancel" && parts[1]) {
				const result = registry.cancel(parts[1]);
				return ctx.ui.notify(result.ok ? `cancel ${parts[1]}` : result.error, result.ok ? "info" : "error");
			}

			if (ctx.hasUI) {
				await ctx.ui.custom(
					(tui, theme, _kb, done) =>
						openWorkflowsOverlay(tui, theme, done, {
							list: () => registry.list(sessionKeyOf(ctx)),
							cancel: (id) => {
								registry.cancel(id);
							},
							notify: (message, type) => ctx.ui.notify(message, type),
						}),
					{ overlay: true, overlayOptions: { width: "80%", maxHeight: "70%" } },
				);
				return;
			}

			const live = registry.list(sessionKeyOf(ctx));
			const recent = await listRecentSummaries(getAgentDir(), 15);
			const lines = [
				...live.map(formatRunLine),
				...recent.map((s) => `${s.state === "completed" ? "✓" : "✗"} ${s.runId} ${s.label}`),
			];
			ctx.ui.notify(lines.length ? lines.join("\n") : "No workflow runs yet", "info");
		},
	});

	// Named launch: /workflow <name>
	pi.registerCommand("workflow", {
		description: "Run a saved workflow by name",
		handler: async (args, ctx) => {
			const name = (args ?? "").trim().split(/\s+/)[0];
			if (!name) return ctx.ui.notify("Usage: /workflow <saved-name>", "info");
			const saved = await resolveSavedWorkflow({
				name,
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
				agentDir: getAgentDir(),
			});
			if (!saved) return ctx.ui.notify(`Unknown saved workflow "${name}"`, "error");
			try {
				const result = await launch({
					script: saved.script,
					description: saved.description ?? saved.name,
					name: saved.name,
					ctx,
					background: true,
					preApproved: saved.defaults?.preApproved === true,
				});
				const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
				ctx.ui.notify(text, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

function requireRun(registry: WorkflowRunRegistry, id: unknown) {
	const run = registry.get(str(id));
	if (!run) throw new Error(`Unknown workflow run: ${String(id ?? "")}`);
	return run;
}

async function waitForRun(run: LiveWorkflowRun, timeoutMs: number | undefined, signal?: AbortSignal) {
	if (isTerminalState(run.state)) return run.promise;
	if (timeoutMs === undefined) {
		if (signal) {
			return new Promise<WorkflowTerminal>((resolve, reject) => {
				const onAbort = () => reject(new Error("wait aborted"));
				signal.addEventListener("abort", onAbort, { once: true });
				void run.promise.then(
					(value) => {
						signal.removeEventListener("abort", onAbort);
						resolve(value);
					},
					(error) => {
						signal.removeEventListener("abort", onAbort);
						reject(error);
					},
				);
			});
		}
		return run.promise;
	}
	return new Promise<WorkflowTerminal>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`wait timed out after ${timeoutMs}ms`)), timeoutMs);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("wait aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		void run.promise.then(
			(value) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function appendTerminalEntry(pi: ExtensionAPI, terminal: WorkflowTerminal) {
	// Installed pi appendEntry is (type, data) only; cost is recorded in the
	// summary payload and tool-result details (native cost option lands in newer pi).
	pi.appendEntry(ENTRY_TYPE, {
		runId: terminal.runId,
		state: terminal.state,
		label: terminal.summary.label,
		phase: terminal.summary.phase,
		counts: `${terminal.summary.completedAgents}/${terminal.summary.agentCount}`,
		cost: formatUsageLine(terminal.summary.usage),
		usageCost: terminal.summary.usage.cost,
		artifactPath: terminal.summary.artifactPath,
	});
}

async function deliverCompletion(pi: ExtensionAPI, registry: WorkflowRunRegistry, run: LiveWorkflowRun) {
	if (run.claimed || registry.isShuttingDown || !registry.markDelivered(run.runId)) return;
	try {
		const terminal = await run.promise;
		if (registry.isShuttingDown || run.claimed) return;
		appendTerminalEntry(pi, terminal);
		const text = formatTerminalText(terminal);
		pi.sendMessage(
			{
				customType: COMPLETION_TYPE,
				content: text,
				display: true,
				details: { runId: terminal.runId, state: terminal.state },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	} catch {
		/* already recorded on run */
	}
}

function formatTerminalToolResult(terminal: WorkflowTerminal) {
	return {
		content: [{ type: "text" as const, text: formatTerminalText(terminal) }],
		details: {
			runId: terminal.runId,
			state: terminal.state,
			summary: terminal.summary,
			result: terminal.result,
		},
	};
}

function formatTerminalText(terminal: WorkflowTerminal) {
	const s = terminal.summary;
	const lines = [
		`Workflow ${terminal.runId} — ${terminal.state}`,
		`${s.label} · ${s.completedAgents}/${s.agentCount} agents · ${formatUsageLine(s.usage, (s.endedAt ?? Date.now()) - s.startedAt)}`,
		s.workflowBranch ? `workflow branch: ${s.workflowBranch}` : undefined,
		s.failure ? `failure: ${s.failure}` : undefined,
		`artifacts: ${s.artifactPath}`,
		terminal.result !== undefined ? `result:\n${safeStringify(terminal.result, 256 * 1024)}` : undefined,
	].filter(Boolean);
	return lines.join("\n");
}

function countAgentCallsHint(script: string) {
	const matches = script.match(/\bagent\s*\(/g);
	return matches?.length ?? 0;
}
