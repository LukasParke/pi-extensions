/**
 * Background terminals — long-running shell commands that keep running while
 * the agent works.
 *
 * Tools: bg_start / bg_status / bg_list / bg_kill
 * Command: /ps (list, and `/ps kill <id>`)
 *
 * When a terminal exits, its result is delivered as a follow-up message so the
 * agent learns the outcome without polling — unless bg_status or bg_kill
 * already showed it, in which case the automatic delivery is suppressed to
 * avoid telling the model the same thing twice.
 *
 * Process management lives in lib/bg-manager.ts.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	formatBytes,
	formatElapsed,
	MAX_RUNNING,
	tail,
	TerminalManager,
	type TerminalSnapshot,
} from "../src/manager.ts";

/** Model-facing output caps. Status is generous; completion is compact. */
const STATUS_STDOUT_MAX = 16 * 1024;
const STATUS_STDERR_MAX = 8 * 1024;
const STATUS_STDOUT_LINES = 400;
const STATUS_STDERR_LINES = 200;
const RESULT_STDOUT_MAX = 8 * 1024;
const RESULT_STDERR_MAX = 4 * 1024;
const RESULT_STDOUT_LINES = 40;
const RESULT_STDERR_LINES = 20;

const TERMINAL_NAMESPACE = {
	name: "background-terminals",
	description: "Session-scoped asynchronous shell terminals managed alongside the blocking bash tool.",
} as const;

const statusEnum = Type.Union([
	Type.Literal("running"),
	Type.Literal("done"),
	Type.Literal("failed"),
	Type.Literal("killed"),
]);

const streamSchema = Type.Object(
	{
		text: Type.String({ description: "Tail-bounded retained output, same bound as the text rendering." }),
		totalBytes: Type.Integer({ minimum: 0, description: "Every byte ever seen on this stream." }),
		truncatedBytes: Type.Integer({
			minimum: 0,
			description: "Bytes dropped from the head of the retained view.",
		}),
	},
	{ additionalProperties: false },
);

const snapshotSchema = Type.Object(
	{
		id: Type.String(),
		title: Type.String(),
		command: Type.String(),
		cwd: Type.String(),
		pid: Type.Union([Type.Integer(), Type.Null()]),
		status: statusEnum,
		exitCode: Type.Union([Type.Integer(), Type.Null()]),
		signal: Type.Union([Type.String(), Type.Null()]),
		errorText: Type.Union([Type.String(), Type.Null()]),
		createdAt: Type.Integer(),
		settledAt: Type.Union([Type.Integer(), Type.Null()]),
		stdout: streamSchema,
		stderr: streamSchema,
	},
	{ additionalProperties: false },
);

const startSchema = Type.Object(
	{
		id: Type.String(),
		title: Type.String(),
		pid: Type.Union([Type.Integer(), Type.Null()]),
		cwd: Type.String(),
		status: Type.Literal("running"),
		maxRunning: Type.Integer(),
	},
	{ additionalProperties: false },
);

const listEntrySchema = Type.Object(
	{
		id: Type.String(),
		title: Type.String(),
		command: Type.String(),
		cwd: Type.String(),
		pid: Type.Union([Type.Integer(), Type.Null()]),
		status: statusEnum,
		exitCode: Type.Union([Type.Integer(), Type.Null()]),
		signal: Type.Union([Type.String(), Type.Null()]),
		createdAt: Type.Integer(),
		settledAt: Type.Union([Type.Integer(), Type.Null()]),
		stdoutBytes: Type.Integer({ minimum: 0 }),
		stderrBytes: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

const listSchema = Type.Object(
	{
		count: Type.Integer({ minimum: 0 }),
		running: Type.Integer({ minimum: 0 }),
		maxRunning: Type.Integer(),
		terminals: Type.Array(listEntrySchema),
	},
	{ additionalProperties: false },
);

const killSchema = Type.Object(
	{
		results: Type.Array(
			Type.Object(
				{
					id: Type.String(),
					ok: Type.Boolean(),
					status: Type.Union([statusEnum, Type.Null()]),
					error: Type.Union([Type.String(), Type.Null()]),
				},
				{ additionalProperties: false },
			),
		),
		killed: Type.Integer({ minimum: 0 }),
		failed: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

/** Normalized, handle-free snapshot for structuredContent: never a ChildProcess. */
function structuredSnapshot(snapshot: TerminalSnapshot) {
	return {
		id: snapshot.id,
		title: snapshot.title,
		command: snapshot.command,
		cwd: snapshot.cwd,
		pid: snapshot.pid ?? null,
		status: snapshot.status,
		exitCode: snapshot.exitCode ?? null,
		signal: snapshot.signal ?? null,
		errorText: snapshot.errorText ?? null,
		createdAt: snapshot.createdAt,
		settledAt: snapshot.settledAt ?? null,
		stdout: structuredStream(snapshot.stdout, STATUS_STDOUT_MAX, STATUS_STDOUT_LINES),
		stderr: structuredStream(snapshot.stderr, STATUS_STDERR_MAX, STATUS_STDERR_LINES),
	};
}

function structuredStream(view: TerminalSnapshot["stdout"], maxBytes: number, maxLines: number) {
	const text = tail(view.text, maxBytes, maxLines).text;
	return {
		text,
		totalBytes: view.totalBytes,
		truncatedBytes: Math.max(0, view.totalBytes - Buffer.byteLength(text)),
	};
}

const RESULT_MESSAGE_TYPE = "background-terminal-result";
const UI_KEY = "background-terminals";
/**
 * Quiet window after the agent goes idle before delivering settled results.
 *
 * Delivery must NOT be a fixed timer from settle: an LLM round-trip is seconds,
 * so a short timer fires before the agent's next bg_status can claim the result
 * and the model gets told twice. Instead results wait until the agent is idle
 * (agent_settled), which is also the only moment a followUp can be acted on.
 * This small extra delay lets a burst of exits batch into one message.
 */
const DELIVERY_QUIET_MS = 250;

const glyph = (status: TerminalSnapshot["status"]): string =>
	status === "running" ? "●" : status === "done" ? "✓" : status === "killed" ? "⊘" : "✗";

export function backgroundTerminalStatus(running: number) {
	return running > 0 ? `● ${running} background terminal${running === 1 ? "" : "s"} · /ps` : undefined;
}

function describe(snapshot: TerminalSnapshot): string {
	const age = formatElapsed(snapshot.createdAt, snapshot.settledAt);
	const exit =
		snapshot.status === "running"
			? ""
			: snapshot.signal
				? ` signal=${snapshot.signal}`
				: snapshot.exitCode !== undefined && snapshot.exitCode !== null
					? ` exit=${snapshot.exitCode}`
					: "";
	return `${glyph(snapshot.status)} ${snapshot.id} [${snapshot.status}${exit}] "${snapshot.title}" ${age} out=${formatBytes(
		snapshot.stdout.totalBytes,
	)} err=${formatBytes(snapshot.stderr.totalBytes)}`;
}

function section(
	label: string,
	view: TerminalSnapshot["stdout"],
	maxBytes: number,
	maxLines: number,
	omitEmpty = false,
): string | undefined {
	if (!view.text) return omitEmpty ? undefined : `${label}: (empty)`;
	const result = tail(view.text, maxBytes, maxLines);
	const note =
		result.truncated || view.truncatedBytes > 0
			? ` [truncated: showing the last ${formatBytes(Buffer.byteLength(result.text, "utf8"))} of ${formatBytes(
					view.totalBytes,
				)}]`
			: "";
	return `${label}${note}:\n${result.text}`;
}

function statusText(snapshot: TerminalSnapshot): string {
	return [
		describe(snapshot),
		`command: ${snapshot.command}`,
		`cwd: ${snapshot.cwd}`,
		snapshot.pid ? `pid: ${snapshot.pid}` : undefined,
		snapshot.errorText ? `error: ${snapshot.errorText}` : undefined,
		"",
		section("stdout", snapshot.stdout, STATUS_STDOUT_MAX, STATUS_STDOUT_LINES),
		section("stderr", snapshot.stderr, STATUS_STDERR_MAX, STATUS_STDERR_LINES),
	]
		.filter(Boolean)
		.join("\n");
}

function resultText(snapshot: TerminalSnapshot): string {
	return [
		`${glyph(snapshot.status)} Background terminal ${snapshot.id} "${snapshot.title}" ${snapshot.status}` +
			(snapshot.exitCode !== undefined && snapshot.exitCode !== null ? ` (exit ${snapshot.exitCode})` : "") +
			(snapshot.signal ? ` (signal ${snapshot.signal})` : ""),
		`command: ${snapshot.command}`,
		snapshot.errorText ? `error: ${snapshot.errorText}` : undefined,
		section("stdout", snapshot.stdout, RESULT_STDOUT_MAX, RESULT_STDOUT_LINES),
		section("stderr", snapshot.stderr, RESULT_STDERR_MAX, RESULT_STDERR_LINES, true),
	]
		.filter(Boolean)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	const manager = new TerminalManager();
	/** Settled results awaiting delivery, keyed by id so a retry cannot double up. */
	const pending = new Map<string, TerminalSnapshot>();
	let uiCtx: ExtensionContext | undefined;
	let closed = false;

	const refreshUi = () => {
		if (!uiCtx?.hasUI) return;
		const running = manager.list().filter((entry) => entry.status === "running");
		const status = backgroundTerminalStatus(running.length);
		uiCtx.ui.setStatus(UI_KEY, status ? uiCtx.ui.theme.fg("warning", status) : undefined);
		if (!running.length) return uiCtx.ui.setWidget(UI_KEY, undefined);
		uiCtx.ui.setWidget(
			UI_KEY,
			running.map((entry) => `● ${entry.id} ${entry.title} (${formatElapsed(entry.createdAt)})`),
		);
	};

	const flush = () => {
		if (!pending.size) return;
		const snapshots = [...pending.values()];
		pending.clear();
		for (const snapshot of snapshots) {
			try {
				pi.sendMessage(
					{
						customType: RESULT_MESSAGE_TYPE,
						content: resultText(snapshot),
						display: true,
						details: {
							id: snapshot.id,
							title: snapshot.title,
							status: snapshot.status,
							exitCode: snapshot.exitCode ?? null,
						},
					},
					// followUp never interrupts a streaming turn; triggerTurn wakes an
					// idle agent so a finished build is noticed promptly.
					{ deliverAs: "followUp", triggerTurn: true },
				);
			} catch {
				// Re-queue so a transient send failure is not a lost result.
				pending.set(snapshot.id, snapshot);
			}
		}
	};

	/**
	 * Settle -> queue. Delivery happens when the agent is idle (see agent_settled
	 * below), never straight from settle: flushing immediately races the agent's
	 * own next bg_status call and duplicates the result.
	 */
	let flushTimer: NodeJS.Timeout | undefined;
	const scheduleFlush = () => {
		if (flushTimer) clearTimeout(flushTimer);
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			flush();
		}, DELIVERY_QUIET_MS);
		flushTimer.unref?.();
	};

	manager.onSettle((snapshot, consumed) => {
		if (closed) return;
		refreshUi();
		if (consumed) return; // already shown via bg_status / bg_kill
		pending.set(snapshot.id, snapshot);
		// Deliberately no flush here — agent_settled drives delivery.
	});

	pi.on("session_start", async (_event, ctx) => {
		closed = false;
		uiCtx = ctx;
		refreshUi();
	});
	// The agent has stopped working: now it is safe to hand over any results it
	// did not already collect itself, and a followUp can actually be acted on.
	pi.on("agent_settled", async () => scheduleFlush());
	pi.on("session_shutdown", async () => {
		closed = true;
		if (flushTimer) clearTimeout(flushTimer);
		flushTimer = undefined;
		pending.clear();
		uiCtx?.ui.setStatus(UI_KEY, undefined);
		uiCtx?.ui.setWidget(UI_KEY, undefined);
		uiCtx = undefined;
		// A dev server must not outlive the session that started it.
		await manager.disposeAll();
	});

	pi.registerTool({
		name: "bg_start",
		label: "Start Terminal",
		description:
			"Start a long-running shell command in a background terminal and return immediately. Use this for dev servers, watchers, streaming builds, log tails — anything that should keep running while you continue working. Use the regular bash tool for commands that finish quickly. The command gets no stdin, so it must not expect interactive input.",
		parameters: Type.Object(
			{
				command: Type.String({ description: "Shell command to run." }),
				title: Type.String({ description: "Short label shown in listings, e.g. 'vite dev'." }),
				working_dir: Type.Optional(
					Type.String({
						description: "Directory to run in, relative to the session cwd. Defaults to the session cwd.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		outputSchema: startSchema,
		namespace: TERMINAL_NAMESPACE,
		// Spawns a real process running an arbitrary shell command: it modifies
		// the environment and can reach anything that command can reach.
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		async execute(_id, params: any, _signal, _onUpdate, ctx) {
			const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
			const snapshot = manager.start({ command: params.command, title: params.title, cwd });
			refreshUi();
			return {
				content: [
					{
						type: "text" as const,
						text: [
							`Started ${snapshot.id} "${snapshot.title}"${snapshot.pid ? ` (pid ${snapshot.pid})` : ""} in ${cwd}.`,
							`Peek with bg_status id:"${snapshot.id}", stop with bg_kill. You will get a message when it exits.`,
						].join("\n"),
					},
				],
				details: { id: snapshot.id, title: snapshot.title, pid: snapshot.pid ?? null, cwd },
				structuredContent: {
					id: snapshot.id,
					title: snapshot.title,
					pid: snapshot.pid ?? null,
					cwd,
					status: "running" as const,
					maxRunning: MAX_RUNNING,
				},
			};
		},
	});

	pi.registerTool({
		name: "bg_status",
		label: "Terminal Status",
		description:
			"Show a background terminal's status and its most recent output. Reading a finished terminal here counts as collecting its result, so you will not also get a separate completion message for it.",
		parameters: Type.Object(
			{ id: Type.String({ description: "Terminal id from bg_start / bg_list." }) },
			{
				additionalProperties: false,
			},
		),
		outputSchema: snapshotSchema,
		namespace: TERMINAL_NAMESPACE,
		// Reading a settled terminal CONSUMES its result (the automatic completion
		// message is then suppressed), so this is not universally read-only or
		// idempotent — the annotations stay off on purpose.
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_id, params: any) {
			const snapshot = manager.get(params.id);
			if (!snapshot) {
				const known = manager.list().map((entry) => entry.id);
				throw new Error(
					`No background terminal ${params.id}.${known.length ? ` Known: ${known.join(", ")}` : ""}`,
				);
			}
			// Peeking a settled terminal consumes it: no duplicate follow-up.
			if (snapshot.status !== "running") {
				manager.markConsumed(snapshot.id);
				pending.delete(snapshot.id);
			}
			return {
				content: [{ type: "text" as const, text: statusText(snapshot) }],
				details: { id: snapshot.id, status: snapshot.status, exitCode: snapshot.exitCode ?? null },
				structuredContent: structuredSnapshot(snapshot),
			};
		},
	});

	pi.registerTool({
		name: "bg_list",
		label: "List Terminals",
		description: "List all background terminals with status, age and output sizes.",
		parameters: Type.Object({}, { additionalProperties: false }),
		outputSchema: listSchema,
		namespace: TERMINAL_NAMESPACE,
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		async execute() {
			const all = manager.list();
			const running = all.filter((entry) => entry.status === "running").length;
			return {
				content: [
					{
						type: "text" as const,
						text: all.length
							? [
									`${all.length} terminal(s), ${running} running (max ${MAX_RUNNING}):`,
									...all.map(describe),
								].join("\n")
							: "No background terminals. Start one with bg_start.",
					},
				],
				details: { count: all.length, running },
				structuredContent: {
					count: all.length,
					running,
					maxRunning: MAX_RUNNING,
					terminals: all.map((entry) => ({
						id: entry.id,
						title: entry.title,
						command: entry.command,
						cwd: entry.cwd,
						pid: entry.pid ?? null,
						status: entry.status,
						exitCode: entry.exitCode ?? null,
						signal: entry.signal ?? null,
						createdAt: entry.createdAt,
						settledAt: entry.settledAt ?? null,
						stdoutBytes: entry.stdout.totalBytes,
						stderrBytes: entry.stderr.totalBytes,
					})),
				},
			};
		},
	});

	pi.registerTool({
		name: "bg_kill",
		label: "Kill Terminal",
		description:
			"Stop one or more background terminals. Sends SIGTERM, escalating to SIGKILL if the process does not exit, and kills the whole process tree so child processes do not leak.",
		parameters: Type.Object(
			{
				ids: Type.Array(Type.String(), { minItems: 1, description: "Terminal ids to kill." }),
			},
			{ additionalProperties: false },
		),
		outputSchema: killSchema,
		namespace: TERMINAL_NAMESPACE,
		// Killing terminates real processes (destructive); repeating a kill on an
		// already-settled terminal is a no-op (idempotent).
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		async execute(_id, params: any) {
			const lines: string[] = [];
			const results: Array<{
				id: string;
				ok: boolean;
				status: TerminalSnapshot["status"] | null;
				error: string | null;
			}> = [];
			for (const id of params.ids) {
				try {
					const before = manager.get(id);
					if (before && before.status !== "running") {
						manager.markConsumed(id);
						pending.delete(id);
						lines.push(`${id} was already ${before.status}`);
						results.push({ id, ok: true, status: before.status, error: null });
						continue;
					}
					const snapshot = await manager.kill(id);
					pending.delete(id);
					lines.push(`${id} ${snapshot.status}${snapshot.signal ? ` (signal ${snapshot.signal})` : ""}`);
					results.push({ id, ok: true, status: snapshot.status, error: null });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					lines.push(`${id}: ${message}`);
					results.push({ id, ok: false, status: null, error: message });
				}
			}
			refreshUi();
			const failed = results.filter((entry) => !entry.ok).length;
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { killed: results.length - failed, failed },
				// A partial failure must never read as "all killed": the result is an
				// error and the per-id outcomes stay machine-readable.
				isError: failed > 0 || undefined,
				structuredContent: { results, killed: results.length - failed, failed },
			};
		},
	});

	pi.registerCommand("ps", {
		description: "List background terminals; '/ps kill <id>' stops one",
		handler: async (args: string, ctx: ExtensionContext) => {
			const argv = args.trim().split(/\s+/).filter(Boolean);
			if (argv[0] === "kill" && argv[1]) {
				try {
					const snapshot = await manager.kill(argv[1]);
					refreshUi();
					return ctx.ui.notify(`${snapshot.id} ${snapshot.status}`, "info");
				} catch (error) {
					return ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			}
			const all = manager.list();
			ctx.ui.notify(all.length ? all.map(describe).join("\n") : "No background terminals", "info");
		},
	});
}
