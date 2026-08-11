import { execFile } from "node:child_process";
import { combinedOutput, evaluatePredicate, hashOutput, truncateOutput, updateGateState } from "./index.ts";
import type { GateState, Predicate, ProbeResult } from "./index.ts";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export type SentinelKind = "watch" | "sleep";
export type SentinelState = "waiting" | "passing" | "failing" | "complete" | "timeout";

export interface WatchOptions {
	name: string;
	command: string;
	cwd: string;
	intervalMs?: number;
	doneWhen?: Predicate;
	timeoutMs?: number;
	wakeOnChange?: boolean;
	note?: string;
}

export interface CriterionOptions {
	name: string;
	command: string;
	passWhen?: Predicate;
}

export interface GateOptions {
	criteria: CriterionOptions[];
	cwd: string;
	quietForMs?: number;
	intervalMs?: number;
}

export interface SentinelSnapshot {
	name: string;
	kind: SentinelKind;
	command?: string;
	note?: string;
	state: SentinelState;
	createdAt: number;
	nextPollAt?: number;
	lastOutput?: string;
}

export interface GateCriterionSnapshot {
	name: string;
	state: "waiting" | "passing" | "failing";
	lastOutput?: string;
}

export interface GateSnapshot {
	active: boolean;
	complete: boolean;
	quietForMs: number;
	passingSince?: number;
	nextPollAt?: number;
	criteria: GateCriterionSnapshot[];
}

export interface SentinelSnapshotSet {
	items: SentinelSnapshot[];
	gate?: GateSnapshot;
}

export interface SentinelEvent {
	id: string;
	message: string;
	details: Record<string, unknown>;
}

interface Entry extends SentinelSnapshot {
	cwd?: string;
	intervalMs?: number;
	doneWhen?: Predicate;
	expiresAt?: number;
	wakeOnChange?: boolean;
	lastHash?: string;
	timer?: NodeJS.Timeout;
	running?: boolean;
	wakeAt?: number;
}

interface GateEntry {
	cwd: string;
	quietForMs: number;
	intervalMs: number;
	criteria: CriterionOptions[];
	outputs: Record<string, string>;
	state: GateState;
	nextPollAt?: number;
	timer?: NodeJS.Timeout;
	running?: boolean;
	allPassNotified: boolean;
}

export type ProbeRunner = (command: string, cwd: string) => Promise<ProbeResult>;

export function runProbe(command: string, cwd: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
	return new Promise<ProbeResult>((resolve) => {
		execFile(
			"/bin/sh",
			["-c", command],
			{ cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024 },
			(error, stdout, stderr) => {
				const code =
					error && "code" in error && typeof error.code === "number" ? error.code : error ? null : 0;
				resolve({
					exitCode: code,
					stdout,
					stderr,
					timedOut: Boolean(error && "killed" in error && error.killed),
				});
			},
		);
	});
}

export class SentinelManager {
	private readonly entries = new Map<string, Entry>();
	private gate?: GateEntry;
	private active = false;
	private idle = true;
	private disposed = false;
	private onEventHook?: (event: SentinelEvent) => void;
	private onChangeHook?: () => void;

	constructor(
		private readonly runner: ProbeRunner = runProbe,
		private readonly now = () => Date.now(),
	) {}

	onEvent(hook: (event: SentinelEvent) => void) {
		this.onEventHook = hook;
	}

	onChange(hook: () => void) {
		this.onChangeHook = hook;
	}

	startSession() {
		if (this.disposed) return;
		this.active = true;
		for (const entry of this.entries.values()) this.scheduleEntry(entry, 0);
		this.scheduleGate(0);
	}

	setIdle(idle: boolean) {
		this.idle = idle;
		if (!idle || !this.active) return;
		for (const entry of this.entries.values()) {
			if (entry.state === "waiting" || entry.state === "failing") this.scheduleEntry(entry, 0);
		}
		if (this.gate && !this.gate.state.complete) this.scheduleGate(0);
	}

	watch(options: WatchOptions) {
		const name = options.name.trim();
		if (!name) throw new Error("name must not be empty");
		if (name === "gate") throw new Error('"gate" is reserved for the session gate');
		if (this.entries.has(name)) throw new Error(`Sentinel ${name} already exists`);
		if (!options.command.trim()) throw new Error("command must not be empty");
		const now = this.now();
		const entry: Entry = {
			name,
			kind: "watch",
			command: options.command,
			note: options.note,
			state: "waiting",
			createdAt: now,
			cwd: options.cwd,
			intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
			doneWhen: options.doneWhen,
			expiresAt: options.timeoutMs ? now + options.timeoutMs : undefined,
			wakeOnChange: options.wakeOnChange,
		};
		this.entries.set(name, entry);
		this.scheduleEntry(entry, 0);
		this.changed();
		return this.snapshotEntry(entry);
	}

	sleep(name: string, wakeAt: number, note?: string) {
		if (!Number.isFinite(wakeAt) || wakeAt <= this.now()) throw new Error("Sleep time must be in the future");
		if (this.entries.has(name)) throw new Error(`Sentinel ${name} already exists`);
		const entry: Entry = {
			name,
			kind: "sleep",
			note,
			state: "waiting",
			createdAt: this.now(),
			wakeAt,
			nextPollAt: wakeAt,
		};
		this.entries.set(name, entry);
		this.scheduleEntry(entry, wakeAt - this.now());
		this.changed();
		return this.snapshotEntry(entry);
	}

	setGate(options: GateOptions) {
		if (!options.criteria.length) throw new Error("criteria must not be empty");
		const names = options.criteria.map((criterion) => criterion.name.trim());
		if (names.some((name) => !name)) throw new Error("criterion names must not be empty");
		if (new Set(names).size !== names.length) throw new Error("criterion names must be unique");
		if (options.criteria.some((criterion) => !criterion.command.trim())) {
			throw new Error("criterion commands must not be empty");
		}
		this.clearGate();
		this.gate = {
			cwd: options.cwd,
			criteria: options.criteria.map((criterion, index) => ({ ...criterion, name: names[index]! })),
			quietForMs: options.quietForMs ?? 0,
			intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
			outputs: {},
			state: { passes: {}, complete: false },
			allPassNotified: false,
		};
		this.scheduleGate(0);
		this.changed();
		return this.snapshotGate()!;
	}

	cancel(name?: string, all = false) {
		const cancelled: string[] = [];
		if (all) {
			for (const key of [...this.entries.keys()]) if (this.removeEntry(key)) cancelled.push(key);
			if (this.gate) {
				this.clearGate();
				cancelled.push("gate");
			}
		} else if (name === "gate") {
			if (this.gate) {
				this.clearGate();
				cancelled.push("gate");
			}
		} else if (name && this.removeEntry(name)) cancelled.push(name);
		this.changed();
		return cancelled;
	}

	snapshot(): SentinelSnapshotSet {
		return {
			items: [...this.entries.values()].map((entry) => this.snapshotEntry(entry)),
			gate: this.snapshotGate(),
		};
	}

	dispose() {
		this.disposed = true;
		this.active = false;
		for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer);
		this.clearGate();
		this.entries.clear();
	}

	private changed() {
		this.onChangeHook?.();
	}

	private snapshotEntry(entry: Entry): SentinelSnapshot {
		const { name, kind, command, note, state, createdAt, nextPollAt, lastOutput } = entry;
		return { name, kind, command, note, state, createdAt, nextPollAt, lastOutput };
	}

	private snapshotGate(): GateSnapshot | undefined {
		const gate = this.gate;
		if (!gate) return;
		return {
			active: !gate.state.complete,
			complete: gate.state.complete,
			quietForMs: gate.quietForMs,
			passingSince: gate.state.passingSince,
			nextPollAt: gate.nextPollAt,
			criteria: gate.criteria.map((criterion) => ({
				name: criterion.name,
				state:
					gate.state.passes[criterion.name] === undefined
						? "waiting"
						: gate.state.passes[criterion.name]
							? "passing"
							: "failing",
				lastOutput: gate.outputs[criterion.name],
			})),
		};
	}

	private scheduleEntry(entry: Entry, delay: number) {
		if (entry.timer && delay === 0 && entry.nextPollAt !== undefined && entry.nextPollAt > this.now()) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
		if (
			!this.active ||
			this.disposed ||
			entry.timer ||
			entry.running ||
			entry.state === "complete" ||
			entry.state === "timeout"
		)
			return;
		const actualDelay = Math.max(0, delay);
		entry.nextPollAt = this.now() + actualDelay;
		entry.timer = setTimeout(() => {
			entry.timer = undefined;
			void this.pollEntry(entry);
		}, actualDelay);
		entry.timer.unref?.();
	}

	private async pollEntry(entry: Entry) {
		if (!this.active || this.disposed || !this.entries.has(entry.name)) return;
		const now = this.now();
		if (entry.kind === "sleep") {
			if (now < entry.wakeAt!) return this.scheduleEntry(entry, entry.wakeAt! - now);
			entry.state = "complete";
			entry.nextPollAt = undefined;
			this.emit({
				id: `sleep:${entry.name}:elapsed`,
				message: `Sentinel sleep "${entry.name}" elapsed${entry.note ? ` — ${entry.note}` : ""}.`,
				details: { name: entry.name, status: "elapsed" },
			});
			return this.changed();
		}
		if (!this.idle) return;
		if (entry.expiresAt && now >= entry.expiresAt) return this.expireEntry(entry);

		entry.running = true;
		entry.nextPollAt = undefined;
		const result = await this.runner(entry.command!, entry.cwd!);
		entry.running = false;
		if (!this.entries.has(entry.name)) return;
		const output = truncateOutput(combinedOutput(result));
		const hash = hashOutput(result.stdout);
		const changed = entry.lastHash !== undefined && entry.lastHash !== hash;
		entry.lastHash = hash;
		entry.lastOutput = output;
		const done = evaluatePredicate(result, entry.doneWhen);
		entry.state = done ? "complete" : "failing";
		if (done) {
			this.emit({
				id: `watch:${entry.name}:complete`,
				message: `Sentinel watch "${entry.name}" completed.\n${output}`,
				details: { name: entry.name, status: "complete", exitCode: result.exitCode },
			});
		} else if (entry.expiresAt && this.now() >= entry.expiresAt) {
			return this.expireEntry(entry);
		} else {
			if (entry.wakeOnChange && changed) {
				this.emit({
					id: `watch:${entry.name}:change:${hash}`,
					message: `Sentinel watch "${entry.name}" output changed.\n${output}`,
					details: { name: entry.name, status: "changed", exitCode: result.exitCode },
				});
			}
			const untilExpiry = entry.expiresAt ? entry.expiresAt - this.now() : entry.intervalMs!;
			this.scheduleEntry(entry, Math.min(entry.intervalMs!, untilExpiry));
		}
		this.changed();
	}

	private expireEntry(entry: Entry) {
		entry.state = "timeout";
		entry.nextPollAt = undefined;
		this.emit({
			id: `watch:${entry.name}:timeout`,
			message: `Sentinel watch "${entry.name}" timed out.\n${entry.lastOutput ?? "No output captured."}`,
			details: { name: entry.name, status: "timeout" },
		});
		this.changed();
	}

	private scheduleGate(delay: number) {
		const gate = this.gate;
		if (gate?.timer && delay === 0 && gate.nextPollAt !== undefined && gate.nextPollAt > this.now()) {
			clearTimeout(gate.timer);
			gate.timer = undefined;
		}
		if (!this.active || this.disposed || !gate || gate.timer || gate.running || gate.state.complete) return;
		const actualDelay = Math.max(0, delay);
		gate.nextPollAt = this.now() + actualDelay;
		gate.timer = setTimeout(() => {
			gate.timer = undefined;
			void this.pollGate(gate);
		}, actualDelay);
		gate.timer.unref?.();
	}

	private async pollGate(gate: GateEntry) {
		if (!this.idle || this.gate !== gate || gate.state.complete) return;
		gate.running = true;
		gate.nextPollAt = undefined;
		const results = await Promise.all(
			gate.criteria.map(
				async (criterion) => [criterion, await this.runner(criterion.command, gate.cwd)] as const,
			),
		);
		gate.running = false;
		if (this.gate !== gate) return;
		const passes: Record<string, boolean> = {};
		for (const [criterion, result] of results) {
			passes[criterion.name] = evaluatePredicate(result, criterion.passWhen);
			gate.outputs[criterion.name] = truncateOutput(combinedOutput(result));
		}
		const update = updateGateState(gate.state, passes, this.now(), gate.quietForMs);
		gate.state = update.state;
		const table = this.gateTable(gate);
		if (update.changes.length) {
			const changed = update.changes
				.map((change) => `${change.name}: ${change.from ? "PASS" : "FAIL"} → ${change.to ? "PASS" : "FAIL"}`)
				.join(", ");
			this.emit({
				id: `gate:flip:${update.changes.map((change) => `${change.name}:${change.to}`).join("|")}:${this.now()}`,
				message: `Sentinel gate changed: ${changed}\n\n${table}`,
				details: { status: "changed", changes: update.changes, passes },
			});
		}
		if (gate.state.complete && !gate.allPassNotified) {
			gate.allPassNotified = true;
			this.emit({
				id: "gate:all-pass",
				message: `SENTINEL GATE: ALL PASS\n\n${table}`,
				details: { status: "all_pass", passes },
			});
		} else if (!gate.state.complete) {
			const allPass = Object.values(passes).every(Boolean);
			const quietRemaining = allPass
				? Math.max(0, gate.quietForMs - (this.now() - gate.state.passingSince!))
				: gate.intervalMs;
			this.scheduleGate(Math.min(gate.intervalMs, quietRemaining || gate.intervalMs));
		}
		this.changed();
	}

	private gateTable(gate: GateEntry) {
		return [
			"| Criterion | State |",
			"| --- | --- |",
			...gate.criteria.map(
				(criterion) =>
					`| ${criterion.name.replaceAll("|", "\\|")} | ${gate.state.passes[criterion.name] ? "PASS" : "FAIL"} |`,
			),
		].join("\n");
	}

	private emit(event: SentinelEvent) {
		this.onEventHook?.(event);
	}

	private removeEntry(name: string) {
		const entry = this.entries.get(name);
		if (!entry) return false;
		if (entry.timer) clearTimeout(entry.timer);
		this.entries.delete(name);
		return true;
	}

	private clearGate() {
		if (this.gate?.timer) clearTimeout(this.gate.timer);
		this.gate = undefined;
	}
}
