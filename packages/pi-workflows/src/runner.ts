/**
 * Host-side workflow execution: sandbox + shared lane + journal + usage.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowConfig } from "./config.ts";
import { THINKING, VALID_PROFILES } from "./config.ts";
import {
	type AgentJournalEntry,
	type AgentRunResult,
	appendJournal,
	argsHashOf,
	initRunArtifacts,
	readDefinition,
	readJournal,
	requestHashOf,
	runDir,
	runsRoot,
	sourceHashOf,
	type WorkflowDefinitionFile,
	type WorkflowRunState,
	type WorkflowSummary,
	writeResult,
	writeSummary,
} from "./journal.ts";
import { createReplayCursor, takeReplayResult } from "./replay.ts";
import {
	type AgentRequestOptions,
	type AgentRunResult as SandboxAgentResult,
	runWorkflowSandbox,
} from "./sandbox.ts";
import {
	addUsage,
	emptyUsage,
	ProcessLockManager,
	runTasks,
	type TaskSpec,
	type UsageStats,
	WorktreeManager,
} from "./subagent-sdk.ts";
import { WorkflowLane } from "./worktree-lane.ts";

const str = (value: unknown, fallback = ""): string =>
	typeof value === "string" && value.trim() ? value.trim() : fallback;

export interface RunWorkflowOptions {
	runId: string;
	label: string;
	source: string;
	args?: unknown;
	cwd: string;
	agentDir: string;
	config: WorkflowConfig;
	signal: AbortSignal;
	ctx: Pick<ExtensionContext, "model" | "cwd">;
	/** Parent-enabled tools; workflow children can only receive this intersection. */
	activeTools?: string[];
	/** Resume from an existing run directory (replay contiguous prefix). */
	resumeFrom?: string;
	workflowName?: string;
	onProgress?: (progress: WorkflowProgress) => void;
	/** Injectable for tests. */
	runAgent?: (
		spec: TaskSpec,
		signal: AbortSignal,
		requestId?: number,
	) => Promise<SandboxAgentResult & { usage: UsageStats }>;
	worktrees?: WorktreeManager;
}

export interface WorkflowProgress {
	runId: string;
	label: string;
	phase?: string;
	agentCount: number;
	completedAgents: number;
	failedAgents: number;
	usage: UsageStats;
	state: WorkflowRunState;
}

export interface WorkflowExecutionResult {
	runId: string;
	state: WorkflowRunState;
	result?: unknown;
	failure?: string;
	summary: WorkflowSummary;
	usage: UsageStats;
}

export async function executeWorkflow(options: RunWorkflowOptions): Promise<WorkflowExecutionResult> {
	const { config, ctx } = options;
	const worktrees = options.worktrees ?? new WorktreeManager();
	const lane = new WorkflowLane(worktrees, options.cwd, options.label);
	const startedAt = Date.now();

	let definition: WorkflowDefinitionFile;
	let artifactPath: string;
	let replayEntries: AgentJournalEntry[] = [];

	if (options.resumeFrom) {
		const existing = await readDefinition(options.resumeFrom);
		if (!existing) throw new Error(`Cannot resume: missing definition in ${options.resumeFrom}`);
		if (existing.identity.sourceHash !== sourceHashOf(options.source)) {
			throw new Error("Cannot resume: workflow source changed");
		}
		if (existing.identity.argsHash !== argsHashOf(options.args)) {
			throw new Error("Cannot resume: workflow args changed");
		}
		if (existing.identity.cwd !== options.cwd) {
			throw new Error("Cannot resume: working directory changed");
		}
		definition = existing;
		artifactPath = options.resumeFrom;
		const journal = await readJournal(artifactPath);
		replayEntries = journal.filter((e): e is AgentJournalEntry => e.kind === "agent");
		await appendJournal(artifactPath, { kind: "meta", event: "resume", at: Date.now() });
	} else {
		definition = {
			version: 1,
			identity: {
				runId: options.runId,
				sourceHash: sourceHashOf(options.source),
				argsHash: argsHashOf(options.args),
				cwd: options.cwd,
				label: options.label,
				workflowName: options.workflowName,
			},
			source: options.source,
			args: options.args,
			configSnapshot: {
				maxAgentRequests: config.maxAgentRequests,
				maxConcurrency: config.maxConcurrency,
				agentMaxTurns: config.agentMaxTurns,
				agentMaxCost: config.agentMaxCost,
				agentTimeoutMs: config.agentTimeoutMs,
				workflowTimeoutMs: config.workflowTimeoutMs,
			},
			createdAt: startedAt,
		};
		artifactPath = await initRunArtifacts({ agentDir: options.agentDir, definition });
		await appendJournal(artifactPath, { kind: "meta", event: "start", at: startedAt });
	}

	const cursor = createReplayCursor(replayEntries);
	let currentPhase: string | undefined;
	// Sandbox request ids always restart at 1 on each script invocation.
	let requestSequence = 0;
	let agentCount = cursor.cached.size;
	let completedAgents = 0;
	let failedAgents = 0;
	let usage = emptyUsage();
	// Seed progress counters from the contiguous prefix we may replay.
	for (const entry of cursor.cached.values()) {
		completedAgents++;
		if (!entry.result.ok) failedAgents++;
		if (entry.result.usage) usage = addUsage(usage, entry.result.usage);
	}

	const report = (state: WorkflowRunState = "running") => {
		options.onProgress?.({
			runId: options.runId,
			label: options.label,
			phase: currentPhase,
			agentCount,
			completedAgents,
			failedAgents,
			usage,
			state,
		});
	};
	report("running");

	const lockRoot = `${options.agentDir}/workflows/locks`;
	const locks = new ProcessLockManager({ rootDir: lockRoot });
	const runAgentImpl =
		options.runAgent ??
		(async (spec: TaskSpec, signal: AbortSignal, requestId?: number) => {
			const run = await runTasks([spec], {
				signal,
				worktrees,
				locks,
				runId: `${options.runId}:${requestId ?? 0}`,
				parentSessionKey: options.runId,
			});
			const result = run.results[0];
			if (!result) throw new Error("subagent orchestrator returned no result");
			const output = String(result.liveText ?? "");
			const ok = result.state === "completed" || result.state === "partial";
			return {
				ok,
				output,
				...(result.structuredOutput !== undefined ? { structured: result.structuredOutput } : {}),
				...(ok ? {} : { error: result.errorMessage ?? result.state }),
				usage: result.usage ?? emptyUsage(),
				worktreeBranch: result.worktree?.changed ? result.worktree.branch : undefined,
			};
		});

	const onAgent = async (
		prompt: string,
		rawOptions: AgentRequestOptions,
		agentSignal: AbortSignal,
	): Promise<SandboxAgentResult> => {
		const requestId = ++requestSequence;
		const normalized = normalizeAgentOptions(rawOptions, config, ctx, currentPhase);
		const reqHash = requestHashOf(prompt, {
			label: normalized.label,
			phase: normalized.phase,
			model: normalized.model,
			thinking: normalized.thinking,
			profile: normalized.profile,
			isolation: normalized.isolation,
			schema: normalized.schema ?? null,
			maxTurns: normalized.maxTurns,
			maxCost: normalized.maxCost,
			timeoutMs: normalized.timeoutMs,
			fallbackModels: normalized.fallbackModels ?? null,
		});

		const cached = takeReplayResult(cursor, requestId, reqHash);
		if (cached) {
			// Progress already seeded from the prefix; just refresh the widget.
			report();
			return toSandboxResult(cached);
		}
		agentCount = Math.max(agentCount, requestId);

		await appendJournal(artifactPath, {
			kind: "agent",
			requestId,
			requestHash: reqHash,
			phase: normalized.phase,
			label: normalized.label,
			status: "started",
			startedAt: Date.now(),
			isolation: normalized.isolation,
		});

		const execute = async (cwd: string, isolation: "shared" | "worktree") => {
			const wantedTools =
				normalized.profile === "general"
					? ["read", "grep", "find", "ls", "bash", "edit", "write"]
					: ["read", "grep", "find", "ls"];
			const active = options.activeTools ? new Set(options.activeTools) : undefined;
			const spec: TaskSpec = {
				task: prompt,
				label: normalized.label,
				model: normalized.model || undefined,
				thinking: normalized.thinking as TaskSpec["thinking"],
				profile: normalized.profile as TaskSpec["profile"],
				tools: active ? wantedTools.filter((tool) => active.has(tool)) : wantedTools,
				canWrite: normalized.profile === "general",
				// Shared lane already is a worktree; children use isolation shared on that cwd.
				// Explicit isolation:'worktree' gets a fresh branch from the orchestrator.
				isolation,
				cwd,
				timeoutMs: normalized.timeoutMs,
				maxTurns: normalized.maxTurns,
				maxCost: normalized.maxCost,
				...(normalized.fallbackModels ? { fallbackModels: normalized.fallbackModels } : {}),
				...(normalized.schema !== undefined
					? { outputSchema: normalized.schema as Record<string, unknown> }
					: {}),
			};
			return runAgentImpl(spec, agentSignal, requestId);
		};

		let agentResult: SandboxAgentResult & { usage: UsageStats };
		try {
			if (normalized.isolation === "worktree") {
				// Independent writer — orchestrator creates its own worktree from base cwd.
				agentResult = await execute(options.cwd, "worktree");
			} else if (normalized.profile === "general") {
				// Shared-lane writer: serialize writes on the workflow worktree.
				agentResult = await lane.withWriter((snap) => execute(snap.cwd, "shared"), agentSignal);
			} else {
				// Read-only on the lane so reviewers see writer output.
				agentResult = await lane.withReader((snap) => execute(snap.cwd, "shared"), agentSignal);
			}
		} catch (error) {
			agentResult = {
				ok: false,
				output: "",
				error: error instanceof Error ? error.message : String(error),
				usage: emptyUsage(),
			};
		}

		const journalResult: AgentRunResult = {
			ok: agentResult.ok,
			output: agentResult.output,
			...(agentResult.structured !== undefined ? { structured: agentResult.structured } : {}),
			...(agentResult.error ? { error: agentResult.error } : {}),
			usage: agentResult.usage,
			...(agentResult.worktreeBranch ? { worktreeBranch: agentResult.worktreeBranch } : {}),
		};

		await appendJournal(artifactPath, {
			kind: "agent",
			requestId,
			requestHash: reqHash,
			phase: normalized.phase,
			label: normalized.label,
			status: agentResult.ok ? "completed" : "failed",
			startedAt: Date.now(),
			endedAt: Date.now(),
			result: journalResult,
			isolation: normalized.isolation,
			worktree: lane.snapshot
				? { cwd: lane.snapshot.cwd, branch: lane.snapshot.branch, changed: lane.snapshot.changed }
				: undefined,
		});

		completedAgents++;
		if (!agentResult.ok) failedAgents++;
		usage = addUsage(usage, agentResult.usage);
		report();
		return toSandboxResult(journalResult);
	};

	let result: unknown;
	let failure: string | undefined;
	let state: WorkflowRunState = "running";

	try {
		result = await runWorkflowSandbox({
			source: options.source,
			args: options.args,
			cwd: options.cwd,
			signal: options.signal,
			maxAgentRequests: config.maxAgentRequests,
			maxConcurrency: config.maxConcurrency,
			onAgent,
			onPhase: (title) => {
				currentPhase = title;
				void appendJournal(artifactPath, { kind: "phase", title, at: Date.now() });
				report();
			},
		});
		state = "completed";
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
		const abortReason = options.signal.reason;
		const reasonText = abortReason instanceof Error ? abortReason.message : String(abortReason ?? "");
		if (/timeout|timed out/i.test(`${failure} ${reasonText}`)) state = "timeout";
		else if (options.signal.aborted) state = "cancelled";
		else state = "failed";
	}

	const laneFinal = await lane.finalize().catch(() => lane.snapshot);
	if (result !== undefined) await writeResult(artifactPath, result).catch(() => {});

	const summary: WorkflowSummary = {
		runId: options.runId,
		label: options.label,
		state,
		phase: currentPhase,
		startedAt,
		endedAt: Date.now(),
		agentCount,
		completedAgents,
		failedAgents,
		usage,
		artifactPath,
		failure,
		workflowBranch: laneFinal?.changed ? laneFinal.branch : laneFinal?.branch,
		workflowName: options.workflowName,
	};
	await writeSummary(artifactPath, summary).catch(() => {});
	await appendJournal(artifactPath, {
		kind: "meta",
		event: state,
		at: Date.now(),
		detail: { failure, workflowBranch: summary.workflowBranch },
	}).catch(() => {});
	report(state);

	return { runId: options.runId, state, result, failure, summary, usage };
}

export function newRunId() {
	return `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function loadResumeSource(agentDir: string, runId: string) {
	const exact = runDir(agentDir, runId);
	const exactDefinition = await readDefinition(exact);
	if (exactDefinition) return { dir: exact, definition: exactDefinition };

	let names: string[];
	try {
		const fs = await import("node:fs/promises");
		names = (await fs.readdir(runsRoot(agentDir))).filter((name) => name.startsWith(runId));
	} catch {
		return undefined;
	}
	if (names.length !== 1) return undefined;
	const dir = runDir(agentDir, names[0]!);
	const definition = await readDefinition(dir);
	return definition ? { dir, definition } : undefined;
}

function normalizeAgentOptions(
	raw: AgentRequestOptions,
	config: WorkflowConfig,
	ctx: Pick<ExtensionContext, "model">,
	currentPhase?: string,
) {
	const profile = VALID_PROFILES.has(String(raw.profile)) ? String(raw.profile) : config.defaultProfile;
	const thinking = THINKING.has(String(raw.thinking)) ? String(raw.thinking) : config.defaultThinking;
	const isolation = raw.isolation === "worktree" ? ("worktree" as const) : ("workflow" as const);
	const maxTurns = clampInt(raw.maxTurns, 1, config.agentMaxTurns, config.agentMaxTurns);
	const maxCost = clampNum(raw.maxCost, 0, config.agentMaxCost, config.agentMaxCost);
	const timeoutMs = clampInt(raw.timeoutMs, 1_000, config.agentTimeoutMs, config.agentTimeoutMs);
	const fallbackModels = Array.isArray(raw.fallbackModels)
		? raw.fallbackModels.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
		: undefined;
	return {
		label: str(raw.label, "agent"),
		phase: str(raw.phase, currentPhase ?? ""),
		model: str(raw.model, config.defaultModel ?? ctx.model?.id ?? ""),
		thinking,
		profile,
		isolation,
		schema: raw.schema,
		maxTurns,
		maxCost,
		timeoutMs,
		fallbackModels: fallbackModels?.length ? fallbackModels : undefined,
	};
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(n)));
}

function clampNum(value: unknown, min: number, max: number, fallback: number) {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

function toSandboxResult(result: AgentRunResult): SandboxAgentResult {
	return {
		ok: result.ok,
		output: result.output,
		...(result.structured !== undefined ? { structured: result.structured } : {}),
		...(result.error ? { error: result.error } : {}),
		...(result.usage ? { usage: result.usage } : {}),
		...(result.worktreeBranch ? { worktreeBranch: result.worktreeBranch } : {}),
	};
}
