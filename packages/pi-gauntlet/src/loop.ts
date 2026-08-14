/**
 * The gauntlet loop engine — pure state machine, no pi imports.
 *
 * The extension wires real I/O (pi.exec, ui.notify, sendMessage) through the
 * hooks; everything a test needs to drive is injectable. `settle()` is the
 * only async entry point with side effects beyond state mutation: it runs the
 * checks and decides whether the loop succeeded, is exhausted, or should
 * inject a failure report for another iteration.
 *
 * State is a plain JSON object so the extension can persist it verbatim with
 * `pi.appendEntry` and rebuild the engine from the last entry on session
 * resume.
 */

import { failureReport } from "./report.ts";

export interface GauntletCheck {
	name: string;
	command: string;
}

export interface CheckOutcome {
	code: number;
	/** Combined stdout+stderr, already tail-truncated by the caller's exec adapter. */
	output: string;
}

export interface GauntletState {
	goal?: string;
	active: boolean;
	iteration: number;
	checks: GauntletCheck[];
	/** Last outcome per check name, keyed by name so checks can be replaced. */
	results: Record<string, CheckOutcome>;
}

export function emptyState(): GauntletState {
	return { active: false, iteration: 0, checks: [], results: {} };
}

export interface CheckExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

/** Runs one check command; the extension adapts this to `pi.exec("bash", ["-lc", …])`. */
export type CheckExec = (command: string, timeoutMs: number) => Promise<CheckExecResult>;

export interface EngineHooks {
	/** Called after every state mutation so the extension can appendEntry. */
	persist(state: GauntletState): void;
	/** All checks passed — loop done. */
	success(state: GauntletState): void;
	/** maxIterations reached with failures — loop done. */
	exhausted(state: GauntletState): void;
	/** Failure report to feed back into the conversation for another iteration. */
	inject(report: string): void;
	/** State changed in a way the widget should reflect. */
	changed(state: GauntletState): void;
}

export interface EngineOptions {
	maxIterations: number;
	checkTimeoutMs: number;
	exec: CheckExec;
	hooks: EngineHooks;
}

export class GauntletEngine {
	readonly state: GauntletState;
	private running = false;

	constructor(
		private readonly options: EngineOptions,
		initial?: GauntletState,
	) {
		this.state = initial ?? emptyState();
	}

	private mutate(fn: () => void): void {
		fn();
		this.options.hooks.persist(this.state);
		this.options.hooks.changed(this.state);
	}

	addCheck(name: string, command: string): void {
		this.mutate(() => {
			const existing = this.state.checks.find((c) => c.name === name);
			if (existing) existing.command = command;
			else this.state.checks.push({ name, command });
			delete this.state.results[name];
		});
	}

	removeCheck(name: string): boolean {
		const index = this.state.checks.findIndex((c) => c.name === name);
		if (index < 0) return false;
		this.mutate(() => {
			this.state.checks.splice(index, 1);
			delete this.state.results[name];
		});
		return true;
	}

	start(goal: string): void {
		this.mutate(() => {
			this.state.goal = goal;
			this.state.active = true;
			this.state.iteration = 0;
		});
	}

	stop(): void {
		this.mutate(() => {
			this.state.active = false;
		});
	}

	/**
	 * Run every check sequentially and record outcomes. Used by both the loop
	 * and the tool's one-shot `run` action (which wants results without loop
	 * semantics).
	 */
	async runChecks(): Promise<Record<string, CheckOutcome>> {
		for (const check of this.state.checks) {
			const result = await this.options.exec(check.command, this.options.checkTimeoutMs);
			this.state.results[check.name] = {
				code: result.code,
				output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
			};
		}
		this.options.hooks.persist(this.state);
		this.options.hooks.changed(this.state);
		return this.state.results;
	}

	/**
	 * The `agent_settled` path. Guarded against re-entry: a gauntlet run that
	 * is still executing must never overlap another, and the follow-up message
	 * we inject triggers exactly one more turn, which settles into exactly one
	 * more settle() call.
	 */
	async settle(): Promise<void> {
		if (!this.state.active || this.running) return;
		this.running = true;
		try {
			const results = await this.runChecks();
			const failures = this.state.checks.filter((c) => (results[c.name]?.code ?? 1) !== 0);
			if (failures.length === 0) {
				this.mutate(() => {
					this.state.active = false;
				});
				this.options.hooks.success(this.state);
				return;
			}
			this.state.iteration += 1;
			if (this.state.iteration >= this.options.maxIterations) {
				this.mutate(() => {
					this.state.active = false;
				});
				this.options.hooks.exhausted(this.state);
				return;
			}
			this.options.hooks.persist(this.state);
			this.options.hooks.changed(this.state);
			this.options.hooks.inject(failureReport(this.state, failures, this.options.maxIterations));
		} catch (error) {
			// An aborted check run (user pressed Esc) pauses the loop instead of
			// immediately re-triggering a turn. `/goal stop` is the explicit exit.
			if (!(error instanceof Error && error.name === "AbortError")) throw error;
		} finally {
			this.running = false;
		}
	}
}
