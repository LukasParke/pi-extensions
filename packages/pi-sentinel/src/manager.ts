import { execFile, spawn } from "node:child_process";
import { combinedOutput, evaluatePredicate, hashOutput, truncateOutput, updateGateState } from "./index.ts";
import type { GateState, Predicate, ProbeResult } from "./index.ts";
import {
	formatPrEvent,
	formatPrSnapshot,
	prEventId,
	prEvents,
	prNeedsAction,
	type PrSnapshot,
} from "./pr.ts";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const STREAM_OUTPUT_BYTES = 1024 * 1024;
export const MAX_STREAM_WATCHES = 4;

export type SentinelKind = "watch" | "sleep" | "pr";
export type SentinelState = "waiting" | "running" | "passing" | "failing" | "failed" | "complete" | "timeout";
export type WatchMode = "poll" | "stream";
export type EventUrgency = "wake" | "next-turn";

export interface WatchOptions {
	name: string;
	command: string;
	cwd: string;
	mode?: WatchMode;
	intervalMs?: number;
	doneWhen?: Predicate;
	timeoutMs?: number;
	wakeOnChange?: boolean;
	urgency?: EventUrgency;
	note?: string;
}

export interface PrOptions {
	name: string;
	repo: string;
	number: number;
	probe: () => Promise<PrSnapshot>;
	initialSnapshot?: PrSnapshot;
	intervalMs?: number;
	timeoutMs?: number;
	note?: string;
}

export interface CriterionOptions {
	name: string;
	command: string;
	passWhen?: Predicate;
	urgency?: EventUrgency;
}

export interface GateOptions {
	criteria: CriterionOptions[];
	cwd: string;
	quietForMs?: number;
	intervalMs?: number;
	urgency?: EventUrgency;
}

export interface SentinelSnapshot {
	name: string;
	kind: SentinelKind;
	mode?: WatchMode;
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
	source: string;
	urgency: EventUrgency;
	message: string;
	details: Record<string, unknown>;
}

export interface StreamHandle {
	kill: () => void;
}

export type StreamRunner = (
	command: string,
	cwd: string,
	onExit: (result: ProbeResult) => void,
) => StreamHandle;

interface Entry extends SentinelSnapshot {
	cwd?: string;
	intervalMs?: number;
	doneWhen?: Predicate;
	expiresAt?: number;
	wakeOnChange?: boolean;
	urgency?: EventUrgency;
	lastHash?: string;
	timer?: NodeJS.Timeout;
	running?: boolean;
	wakeAt?: number;
	stream?: StreamHandle;
	prProbe?: () => Promise<PrSnapshot>;
	prSnapshot?: PrSnapshot;
	consecutiveFailures?: number;
}

interface GateEntry {
	cwd: string;
	quietForMs: number;
	intervalMs: number;
	criteria: CriterionOptions[];
	urgency: EventUrgency;
	outputs: Record<string, string>;
	state: GateState;
	nextPollAt?: number;
	timer?: NodeJS.Timeout;
	running?: boolean;
	allPassNotified: boolean;
}

export type ProbeRunner = (command: string, cwd: string) => Promise<ProbeResult>;

function prState(snapshot: PrSnapshot): SentinelState {
	if (snapshot.lifecycle === "merged" || snapshot.lifecycle === "closed") return "complete";
	return prNeedsAction(snapshot) ? "failing" : "passing";
}

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

function appendOutput(current: string, chunk: string) {
	const next = current + chunk;
	if (Buffer.byteLength(next) <= STREAM_OUTPUT_BYTES) return next;
	const bytes = Buffer.from(next);
	let start = bytes.length - STREAM_OUTPUT_BYTES;
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

export function runStream(command: string, cwd: string, onExit: (result: ProbeResult) => void) {
	const child = spawn("/bin/sh", ["-c", command], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	let stdout = "";
	let stderr = "";
	let settled = false;
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => (stdout = appendOutput(stdout, chunk)));
	child.stderr?.on("data", (chunk: string) => (stderr = appendOutput(stderr, chunk)));
	child.on("error", (error) => {
		if (settled) return;
		settled = true;
		onExit({ exitCode: null, stdout, stderr: appendOutput(stderr, error.message) });
	});
	child.on("close", (exitCode) => {
		if (settled) return;
		settled = true;
		onExit({ exitCode, stdout, stderr });
	});
	return {
		kill: () => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
				else child.kill("SIGTERM");
			} catch {
				try {
					child.kill("SIGTERM");
				} catch {
					/* already exited */
				}
			}
		},
	};
}

export class SentinelManager {
	private readonly entries = new Map<string, Entry>();
	private gate?: GateEntry;
	private active = false;
	private idle = true;
	private disposed = false;
	private onEventHook?: (event: SentinelEvent) => void;
	private onChangeHook?: () => void;
	private onSuppressHook?: (sources: string[]) => void;

	constructor(
		private readonly runner: ProbeRunner = runProbe,
		private readonly now = () => Date.now(),
		private readonly streamRunner: StreamRunner = runStream,
	) {}

	onEvent(hook: (event: SentinelEvent) => void) {
		this.onEventHook = hook;
	}

	onChange(hook: () => void) {
		this.onChangeHook = hook;
	}

	onSuppress(hook: (sources: string[]) => void) {
		this.onSuppressHook = hook;
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
			if (
				entry.mode !== "stream" &&
				(entry.state === "waiting" ||
					(entry.state === "failing" && entry.kind !== "pr") ||
					(entry.kind === "pr" && entry.prSnapshot === undefined && !entry.consecutiveFailures))
			) {
				this.scheduleEntry(entry, 0);
			}
		}
		if (this.gate && !this.gate.state.complete) this.scheduleGate(0);
	}

	watch(options: WatchOptions) {
		const name = options.name.trim();
		if (!name) throw new Error("name must not be empty");
		if (name === "gate") throw new Error('"gate" is reserved for the session gate');
		if (this.entries.has(name)) throw new Error(`Sentinel ${name} already exists`);
		if (!options.command.trim()) throw new Error("command must not be empty");
		const mode = options.mode ?? "poll";
		if (mode === "stream" && this.streamCount() >= MAX_STREAM_WATCHES) {
			throw new Error(
				`Max ${MAX_STREAM_WATCHES} stream watches can run at once. Cancel one before starting another.`,
			);
		}
		const now = this.now();
		const entry: Entry = {
			name,
			kind: "watch",
			mode,
			command: options.command,
			note: options.note,
			state: "waiting",
			createdAt: now,
			cwd: options.cwd,
			intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
			doneWhen: options.doneWhen,
			expiresAt: options.timeoutMs ? now + options.timeoutMs : undefined,
			wakeOnChange: options.wakeOnChange,
			urgency: options.urgency ?? "wake",
		};
		this.entries.set(name, entry);
		this.scheduleEntry(entry, 0);
		this.changed();
		return this.snapshotEntry(entry);
	}

	attachPr(options: PrOptions) {
		const name = options.name.trim();
		if (!name) throw new Error("name must not be empty");
		if (name === "gate") throw new Error('"gate" is reserved for the session gate');
		if (this.entries.has(name)) throw new Error(`Sentinel ${name} already exists`);
		const now = this.now();
		const initial = options.initialSnapshot;
		const entry: Entry = {
			name,
			kind: "pr",
			note: options.note ?? `${options.repo}#${options.number}`,
			state: initial ? prState(initial) : "waiting",
			createdAt: now,
			intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
			expiresAt: options.timeoutMs ? now + options.timeoutMs : undefined,
			urgency: "wake",
			prProbe: options.probe,
			prSnapshot: initial,
			lastOutput: initial ? formatPrSnapshot(initial) : undefined,
		};
		this.entries.set(name, entry);
		this.scheduleEntry(entry, initial ? entry.intervalMs! : 0);
		this.changed();
		return this.snapshotEntry(entry);
	}

	sleep(name: string, wakeAt: number, note?: string) {
		if (!Number.isFinite(wakeAt) || wakeAt <= this.now()) throw new Error("Sleep time must be in the future");
		const normalized = name.trim();
		if (!normalized) throw new Error("name must not be empty");
		if (normalized === "gate") throw new Error('"gate" is reserved for the session gate');
		const existing = this.entries.get(normalized);
		if (existing && existing.kind !== "sleep") throw new Error(`Sentinel ${normalized} already exists`);
		if (existing) this.removeEntry(normalized, true);
		const entry: Entry = {
			name: normalized,
			kind: "sleep",
			note,
			state: "waiting",
			createdAt: this.now(),
			wakeAt,
			nextPollAt: wakeAt,
		};
		this.entries.set(normalized, entry);
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
		this.clearGate(true);
		this.gate = {
			cwd: options.cwd,
			criteria: options.criteria.map((criterion, index) => ({ ...criterion, name: names[index]! })),
			quietForMs: options.quietForMs ?? 0,
			intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
			urgency: options.urgency ?? "wake",
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
			for (const key of [...this.entries.keys()]) if (this.removeEntry(key, true)) cancelled.push(key);
			if (this.gate) {
				this.clearGate(true);
				cancelled.push("gate");
			}
		} else if (name === "gate") {
			if (this.gate) {
				this.clearGate(true);
				cancelled.push("gate");
			}
		} else if (name && this.removeEntry(name, true)) cancelled.push(name);
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
		for (const entry of this.entries.values()) this.stopEntry(entry);
		this.clearGate();
		this.entries.clear();
	}

	private changed() {
		this.onChangeHook?.();
	}

	private suppress(source: string) {
		this.onSuppressHook?.([source]);
	}

	private snapshotEntry(entry: Entry): SentinelSnapshot {
		const { name, kind, mode, command, note, state, createdAt, nextPollAt, lastOutput } = entry;
		return { name, kind, mode, command, note, state, createdAt, nextPollAt, lastOutput };
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
		if (entry.mode === "stream") {
			if (this.active && !this.disposed && !entry.stream && entry.state === "waiting")
				this.startStream(entry);
			return;
		}
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
			entry.state === "timeout" ||
			entry.state === "failed"
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

	private startStream(entry: Entry) {
		entry.state = "running";
		entry.running = true;
		entry.nextPollAt = entry.expiresAt;
		try {
			entry.stream = this.streamRunner(entry.command!, entry.cwd!, (result) =>
				this.finishStream(entry, result),
			);
		} catch (error) {
			entry.running = false;
			entry.state = "failed";
			entry.lastOutput = error instanceof Error ? error.message : String(error);
			this.emitWatchEvent(entry, "failed to start", { status: "failed", exitCode: null });
			return this.changed();
		}
		if (entry.expiresAt) {
			entry.timer = setTimeout(() => this.expireEntry(entry), Math.max(0, entry.expiresAt! - this.now()));
			entry.timer.unref?.();
		}
		this.changed();
	}

	private finishStream(entry: Entry, result: ProbeResult) {
		if (!this.entries.has(entry.name) || entry.state !== "running") return;
		if (entry.timer) clearTimeout(entry.timer);
		entry.timer = undefined;
		entry.stream = undefined;
		entry.running = false;
		entry.nextPollAt = undefined;
		entry.lastOutput = truncateOutput(combinedOutput(result));
		const done = evaluatePredicate(result, entry.doneWhen);
		entry.state = done ? "complete" : "failed";
		this.emitWatchEvent(entry, done ? "completed" : "exited without satisfying its predicate", {
			status: done ? "complete" : "failed",
			exitCode: result.exitCode,
		});
		this.changed();
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
				source: entry.name,
				urgency: "wake",
				message: `Sentinel sleep "${entry.name}" elapsed${entry.note ? ` — ${entry.note}` : ""}.`,
				details: { name: entry.name, status: "elapsed" },
			});
			return this.changed();
		}
		if (!this.idle) return;
		if (entry.expiresAt && now >= entry.expiresAt) return this.expireEntry(entry);
		if (entry.kind === "pr") return this.pollPr(entry);

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
			this.emitWatchEvent(entry, "completed", { status: "complete", exitCode: result.exitCode });
		} else if (entry.expiresAt && this.now() >= entry.expiresAt) {
			return this.expireEntry(entry);
		} else {
			if (entry.wakeOnChange && changed) {
				this.emit({
					id: `watch:${entry.name}:change:${hash}`,
					source: entry.name,
					urgency: entry.urgency ?? "wake",
					message: `Sentinel watch "${entry.name}" output changed.\n${output}`,
					details: { name: entry.name, status: "changed", exitCode: result.exitCode },
				});
			}
			const untilExpiry = entry.expiresAt ? entry.expiresAt - this.now() : entry.intervalMs!;
			this.scheduleEntry(entry, Math.min(entry.intervalMs!, untilExpiry));
		}
		this.changed();
	}

	private async pollPr(entry: Entry) {
		entry.running = true;
		entry.nextPollAt = undefined;
		try {
			const snapshot = await entry.prProbe!();
			entry.running = false;
			if (!this.entries.has(entry.name)) return;
			entry.lastOutput = formatPrSnapshot(snapshot);
			entry.consecutiveFailures = 0;
			const previous = entry.prSnapshot;
			entry.prSnapshot = snapshot;
			if (previous) {
				for (const event of prEvents(previous, snapshot)) {
					this.emit({
						id: prEventId(entry.name, event),
						source: entry.name,
						urgency: "wake",
						message: formatPrEvent(event),
						details: { name: entry.name, type: event.type, pr: snapshot },
					});
				}
			}
			entry.state = prState(snapshot);
			if (entry.state === "complete") {
				entry.nextPollAt = undefined;
			} else {
				const untilExpiry = entry.expiresAt ? entry.expiresAt - this.now() : entry.intervalMs!;
				this.scheduleEntry(entry, Math.min(entry.intervalMs!, untilExpiry));
			}
		} catch (error) {
			entry.running = false;
			if (!this.entries.has(entry.name)) return;
			entry.state = "failing";
			entry.lastOutput = truncateOutput(error instanceof Error ? error.message : String(error));
			entry.consecutiveFailures = (entry.consecutiveFailures ?? 0) + 1;
			const delay = entry.intervalMs! * 2 ** Math.min(entry.consecutiveFailures, 5);
			const untilExpiry = entry.expiresAt ? entry.expiresAt - this.now() : delay;
			this.scheduleEntry(entry, Math.min(delay, untilExpiry));
		}
		this.changed();
	}

	private emitWatchEvent(entry: Entry, action: string, details: Record<string, unknown>) {
		this.emit({
			id: `watch:${entry.name}:${details.status}`,
			source: entry.name,
			urgency: entry.urgency ?? "wake",
			message: `Sentinel watch "${entry.name}" ${action}.\n${entry.lastOutput ?? "No output captured."}`,
			details: { name: entry.name, ...details },
		});
	}

	private expireEntry(entry: Entry) {
		if (!this.entries.has(entry.name) || ["complete", "timeout", "failed"].includes(entry.state)) return;
		entry.stream?.kill();
		entry.stream = undefined;
		entry.running = false;
		if (entry.timer) clearTimeout(entry.timer);
		entry.timer = undefined;
		entry.state = "timeout";
		entry.nextPollAt = undefined;
		this.emit({
			id: `${entry.kind}:${entry.name}:timeout`,
			source: entry.name,
			urgency: entry.urgency ?? "wake",
			message: `Sentinel ${entry.kind} "${entry.name}" timed out.\n${entry.lastOutput ?? "No output captured."}`,
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
			for (const change of update.changes) {
				const criterion = gate.criteria.find((item) => item.name === change.name)!;
				this.emit({
					id: `gate:flip:${change.name}:${change.to}:${this.now()}`,
					source: "gate",
					urgency: criterion.urgency ?? "next-turn",
					message: `Sentinel gate changed: ${change.name}: ${change.from ? "PASS" : "FAIL"} → ${change.to ? "PASS" : "FAIL"}\n\n${table}`,
					details: { status: "changed", changes: [change], passes },
				});
			}
		}
		if (gate.state.complete && !gate.allPassNotified) {
			gate.allPassNotified = true;
			this.suppress("gate");
			this.emit({
				id: "gate:all-pass",
				source: "gate",
				urgency: gate.urgency,
				message: `SENTINEL GATE: ALL PASS\n\n${table}`,
				details: { status: "all_pass", passes },
			});
		} else if (!gate.state.complete) {
			const allPass = Object.values(passes).every(Boolean);
			const quietRemaining = allPass
				? Math.max(0, gate.quietForMs - (this.now() - gate.state.passingSince!))
				: gate.intervalMs;
			this.scheduleGate(Math.min(gate.intervalMs, quietRemaining));
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

	private streamCount() {
		return [...this.entries.values()].filter(
			(entry) => entry.mode === "stream" && (entry.state === "waiting" || entry.state === "running"),
		).length;
	}

	private stopEntry(entry: Entry) {
		if (entry.timer) clearTimeout(entry.timer);
		entry.stream?.kill();
		entry.timer = undefined;
		entry.stream = undefined;
	}

	private removeEntry(name: string, suppress = false) {
		const entry = this.entries.get(name);
		if (!entry) return false;
		this.entries.delete(name);
		this.stopEntry(entry);
		if (suppress) this.suppress(name);
		return true;
	}

	private clearGate(suppress = false) {
		if (this.gate?.timer) clearTimeout(this.gate.timer);
		this.gate = undefined;
		if (suppress) this.suppress("gate");
	}
}
