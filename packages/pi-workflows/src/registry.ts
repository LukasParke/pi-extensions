/**
 * Session-scoped background workflow run registry.
 *
 * Mirrors the pi-subagent pattern: start returns a handle immediately, live
 * state is queryable, completion is delivered once via follow-up message, and
 * session_shutdown aborts owned runs.
 */

import type { UsageStats } from "./subagent-sdk.ts";
import { emptyUsage } from "./subagent-sdk.ts";
import type { WorkflowRunState, WorkflowSummary } from "./journal.ts";

export type WorkflowAction = "start" | "status" | "wait" | "cancel" | "resume" | "rerun" | "list";

export interface LiveWorkflowRun {
	runId: string;
	sessionKey: string;
	label: string;
	state: WorkflowRunState;
	phase?: string;
	startedAt: number;
	endedAt?: number;
	agentCount: number;
	completedAgents: number;
	failedAgents: number;
	usage: UsageStats;
	artifactPath: string;
	failure?: string;
	workflowBranch?: string;
	workflowName?: string;
	/** True once completion was delivered to the parent agent. */
	delivered: boolean;
	/** True when a tool/command already returned the terminal result. */
	claimed: boolean;
	controller: AbortController;
	promise: Promise<WorkflowTerminal>;
	/** Identity for resume checks. */
	sourceHash: string;
	argsHash: string;
	cwd: string;
}

export interface WorkflowTerminal {
	runId: string;
	state: WorkflowRunState;
	result?: unknown;
	failure?: string;
	summary: WorkflowSummary;
}

export type RegistryListener = (run: LiveWorkflowRun) => void;

const TERMINAL = new Set<WorkflowRunState>(["completed", "failed", "cancelled", "timeout"]);

export class WorkflowRunRegistry {
	private readonly runs = new Map<string, LiveWorkflowRun>();
	private readonly listeners = new Set<RegistryListener>();
	private shuttingDown = false;

	subscribe(listener: RegistryListener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	list(sessionKey?: string) {
		const all = [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
		return sessionKey ? all.filter((run) => run.sessionKey === sessionKey) : all;
	}

	get(runId: string) {
		const exact = this.runs.get(runId);
		if (exact) return exact;
		// Prefix match when unique.
		const matches = [...this.runs.values()].filter(
			(run) => run.runId === runId || run.runId.startsWith(runId),
		);
		if (matches.length === 1) return matches[0];
		return undefined;
	}

	register(run: LiveWorkflowRun) {
		if (this.shuttingDown) throw new Error("Cannot start a workflow while the session is shutting down");
		this.runs.set(run.runId, run);
		this.emit(run);
		void run.promise.then(
			(terminal) => {
				run.state = terminal.state;
				run.endedAt = terminal.summary.endedAt ?? Date.now();
				run.failure = terminal.failure;
				run.usage = terminal.summary.usage;
				run.agentCount = terminal.summary.agentCount;
				run.completedAgents = terminal.summary.completedAgents;
				run.failedAgents = terminal.summary.failedAgents;
				run.workflowBranch = terminal.summary.workflowBranch;
				run.phase = terminal.summary.phase;
				this.emit(run);
			},
			(error) => {
				run.state = "failed";
				run.endedAt = Date.now();
				run.failure = error instanceof Error ? error.message : String(error);
				this.emit(run);
			},
		);
	}

	update(runId: string, patch: Partial<LiveWorkflowRun>) {
		const run = this.runs.get(runId);
		if (!run) return;
		Object.assign(run, patch);
		this.emit(run);
	}

	cancel(runId: string) {
		const run = this.get(runId);
		if (!run) return { ok: false as const, error: `Unknown workflow run: ${runId}` };
		if (TERMINAL.has(run.state)) return { ok: true as const, run, alreadyDone: true };
		run.controller.abort(new Error("Workflow cancelled"));
		run.state = "cancelled";
		run.endedAt = Date.now();
		this.emit(run);
		return { ok: true as const, run, alreadyDone: false };
	}

	claim(runId: string) {
		const run = this.get(runId);
		if (!run) return undefined;
		run.claimed = true;
		return run;
	}

	/** Atomically claim completion delivery. Exactly one waiter/notifier wins. */
	markDelivered(runId: string) {
		const run = this.runs.get(runId);
		if (!run || run.delivered) return false;
		run.delivered = true;
		return true;
	}

	undeliveredTerminal(sessionKey: string) {
		return this.list(sessionKey).filter((run) => TERMINAL.has(run.state) && !run.delivered && !run.claimed);
	}

	async shutdown(graceMs = 8_000) {
		this.shuttingDown = true;
		const pending: Promise<unknown>[] = [];
		for (const run of this.runs.values()) {
			if (!TERMINAL.has(run.state)) {
				run.controller.abort(new Error("Session shutdown"));
				run.state = "cancelled";
				run.endedAt = Date.now();
				pending.push(run.promise.catch(() => undefined));
			}
		}
		if (!pending.length) return;
		await Promise.race([
			Promise.allSettled(pending),
			new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, graceMs);
				timer.unref?.();
			}),
		]);
	}

	resetForSession() {
		this.shuttingDown = false;
	}

	get isShuttingDown() {
		return this.shuttingDown;
	}

	toSummary(run: LiveWorkflowRun): WorkflowSummary {
		return {
			runId: run.runId,
			label: run.label,
			state: run.state,
			phase: run.phase,
			startedAt: run.startedAt,
			endedAt: run.endedAt,
			agentCount: run.agentCount,
			completedAgents: run.completedAgents,
			failedAgents: run.failedAgents,
			usage: run.usage ?? emptyUsage(),
			artifactPath: run.artifactPath,
			failure: run.failure,
			workflowBranch: run.workflowBranch,
			workflowName: run.workflowName,
		};
	}

	private emit(run: LiveWorkflowRun) {
		for (const listener of this.listeners) {
			try {
				listener(run);
			} catch {
				/* listener errors must not break runs */
			}
		}
	}
}

export function isTerminalState(state: WorkflowRunState) {
	return TERMINAL.has(state);
}
