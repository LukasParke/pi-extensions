import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SentinelManager } from "../src/manager.ts";
import type {
	EventUrgency,
	GateSnapshot,
	SentinelEvent,
	SentinelSnapshot,
	WatchMode,
} from "../src/manager.ts";
import { validatePredicate } from "../src/index.ts";
import type { Predicate } from "../src/index.ts";

const UI_KEY = "sentinel";
const MESSAGE_TYPE = "sentinel-wakeup";
const DELIVERY_QUIET_MS = 2_000;

const predicateSchema = Type.Object(
	{
		exit_code: Type.Optional(Type.Integer()),
		output_contains: Type.Optional(Type.String()),
		output_json: Type.Optional(
			Type.Object(
				{
					path: Type.String(),
					equals: Type.Unknown(),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

const modeSchema = Type.Unsafe<WatchMode>({ type: "string", enum: ["poll", "stream"] });
const urgencySchema = Type.Unsafe<EventUrgency>({ type: "string", enum: ["wake", "next-turn"] });

function formatEta(nextPollAt?: number) {
	if (!nextPollAt) return "not scheduled";
	const seconds = Math.max(0, Math.ceil((nextPollAt - Date.now()) / 1000));
	return seconds === 0 ? "now" : `in ${seconds}s`;
}

function itemLine(item: SentinelSnapshot) {
	const glyph =
		item.state === "complete"
			? "✓"
			: item.state === "timeout" || item.state === "failed"
				? "✗"
				: item.kind === "sleep"
					? "◷"
					: "◉";
	const mode = item.kind === "watch" ? `/${item.mode ?? "poll"}` : "";
	return `${glyph} ${item.name} [${item.kind}${mode}/${item.state}] next ${formatEta(item.nextPollAt)}`;
}

function gateLine(gate: GateSnapshot) {
	const passed = gate.criteria.filter((criterion) => criterion.state === "passing").length;
	return `${gate.complete ? "✓" : "◉"} gate ${passed}/${gate.criteria.length}${gate.complete ? " ALL PASS" : ""} next ${formatEta(gate.nextPollAt)}`;
}

function isActive(item: SentinelSnapshot) {
	return item.state !== "complete" && item.state !== "timeout" && item.state !== "failed";
}

export function sentinelStatus(items: SentinelSnapshot[], gate?: GateSnapshot) {
	const watches = items.filter((item) => item.kind === "watch" && isActive(item)).length;
	const sleeps = items.filter((item) => item.kind === "sleep" && isActive(item)).length;
	const parts = [
		watches ? `${watches} watch${watches === 1 ? "" : "es"}` : undefined,
		sleeps ? `${sleeps} sleep${sleeps === 1 ? "" : "s"}` : undefined,
		gate?.active
			? `gate ${gate.criteria.filter((criterion) => criterion.state === "passing").length}/${gate.criteria.length}`
			: undefined,
	].filter(Boolean);
	return parts.length ? `◉ ${parts.join(", ")}` : undefined;
}

function statusText(items: SentinelSnapshot[], gate?: GateSnapshot) {
	const lines = [
		...items.map((item) =>
			[
				itemLine(item),
				item.note ? `  note: ${item.note}` : undefined,
				item.lastOutput ? `  output: ${item.lastOutput}` : undefined,
			]
				.filter(Boolean)
				.join("\n"),
		),
		gate ? gateLine(gate) : undefined,
		...(gate?.criteria.map(
			(criterion) =>
				`  ${criterion.state === "passing" ? "✓" : criterion.state === "failing" ? "✗" : "·"} ${criterion.name} [${criterion.state}]${criterion.lastOutput ? `\n    ${criterion.lastOutput}` : ""}`,
		) ?? []),
	].filter(Boolean);
	return lines.length ? lines.join("\n") : "No sentinels are registered.";
}

function activeSnapshot(items: SentinelSnapshot[], gate?: GateSnapshot) {
	const lines = [...items.filter(isActive).map(itemLine), gate?.active ? gateLine(gate) : undefined].filter(
		Boolean,
	);
	return lines.length ? `Active sentinels:\n${lines.join("\n")}` : "Active sentinels: none.";
}

export function coalescedMessage(events: SentinelEvent[], items: SentinelSnapshot[], gate?: GateSnapshot) {
	const body =
		events.length === 1 ? events[0]!.message : events.map((event) => `- ${event.message}`).join("\n");
	return `${events.length === 1 ? "Sentinel wakeup" : `Sentinel wakeup (${events.length} events)`}:\n\n${body}\n\n${activeSnapshot(items, gate)}`;
}

function asPredicate(value?: Record<string, unknown>) {
	validatePredicate(value);
	return value as Predicate | undefined;
}

export function registerSentinel(pi: ExtensionAPI, manager = new SentinelManager()) {
	const pending = new Map<string, SentinelEvent>();
	let uiCtx: ExtensionContext | undefined;
	let flushTimer: NodeJS.Timeout | undefined;

	const refreshUi = () => {
		if (!uiCtx?.hasUI) return;
		const snapshot = manager.snapshot();
		const activeItems = snapshot.items.filter(isActive);
		const status = sentinelStatus(activeItems, snapshot.gate);
		uiCtx.ui.setStatus(UI_KEY, status ? uiCtx.ui.theme.fg("warning", status) : undefined);
		if (!status) return uiCtx.ui.setWidget(UI_KEY, undefined);
		uiCtx.ui.setWidget(UI_KEY, [
			...activeItems.map(itemLine),
			...(snapshot.gate?.active ? [gateLine(snapshot.gate)] : []),
		]);
	};

	const flush = () => {
		if (!pending.size || !uiCtx?.isIdle()) return;
		const events = [...pending.values()];
		const snapshot = manager.snapshot();
		try {
			pi.sendMessage(
				{
					customType: MESSAGE_TYPE,
					content: coalescedMessage(events, snapshot.items, snapshot.gate),
					display: true,
					details: { events: events.map((event) => event.details), snapshot },
				},
				{
					deliverAs: "followUp",
					...(events.some((event) => event.urgency === "wake") ? { triggerTurn: true } : {}),
				},
			);
			for (const event of events) pending.delete(event.id);
		} catch {
			// Keep the batch queued for the next idle flush.
		}
	};

	const scheduleFlush = () => {
		if (flushTimer) clearTimeout(flushTimer);
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			flush();
		}, DELIVERY_QUIET_MS);
		flushTimer.unref?.();
	};

	manager.onEvent((event) => {
		pending.set(event.id, event);
		scheduleFlush();
	});
	manager.onSuppress((sources) => {
		for (const [id, event] of pending) if (sources.includes(event.source)) pending.delete(id);
	});
	manager.onChange(refreshUi);

	pi.on("session_start", (_event, ctx) => {
		uiCtx = ctx;
		manager.setIdle(ctx.isIdle());
		manager.startSession();
		refreshUi();
	});
	pi.on("agent_start", () => manager.setIdle(false));
	pi.on("agent_settled", () => {
		manager.setIdle(true);
		scheduleFlush();
	});
	pi.on("session_shutdown", () => {
		if (flushTimer) clearTimeout(flushTimer);
		flushTimer = undefined;
		pending.clear();
		manager.dispose();
		uiCtx?.ui.setStatus(UI_KEY, undefined);
		uiCtx?.ui.setWidget(UI_KEY, undefined);
		uiCtx = undefined;
	});

	pi.registerTool({
		name: "sentinel_watch",
		label: "Watch Sentinel",
		description:
			"Watch a shell command until it completes or times out. Poll mode runs it on an interval while idle. Stream mode spawns it once and reacts immediately when it exits. next-turn urgency queues information without triggering a model turn.",
		parameters: Type.Object(
			{
				name: Type.String({ description: "Unique watch name." }),
				command: Type.String({ description: "Shell command to poll or run as a blocking stream." }),
				mode: Type.Optional(modeSchema),
				interval_s: Type.Optional(
					Type.Number({ minimum: 1, description: "Poll interval. Defaults to 60 seconds." }),
				),
				done_when: Type.Optional(predicateSchema),
				timeout_s: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
				wake_on_change: Type.Optional(Type.Boolean()),
				urgency: Type.Optional(urgencySchema),
				note: Type.Optional(Type.String()),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const watch = manager.watch({
				name: params.name,
				command: params.command,
				cwd: ctx.cwd,
				mode: params.mode,
				intervalMs: params.interval_s === undefined ? undefined : params.interval_s * 1000,
				doneWhen: asPredicate(params.done_when),
				timeoutMs: params.timeout_s === undefined ? undefined : params.timeout_s * 1000,
				wakeOnChange: params.wake_on_change,
				urgency: params.urgency,
				note: params.note,
			});
			return {
				content: [
					{
						type: "text" as const,
						text:
							watch.mode === "stream"
								? `Streaming "${watch.name}". The command was spawned once and will wake on exit.`
								: `Watching "${watch.name}". First poll runs when the agent is idle.`,
					},
				],
				details: watch,
			};
		},
	});

	pi.registerTool({
		name: "sentinel_sleep",
		label: "Sleep Sentinel",
		description:
			'Schedule or replace a time-based wakeup. Unnamed sleeps share the fixed "sleep" slot; a new unnamed sleep replaces the pending one. Named sleeps replace the same name.',
		parameters: Type.Object(
			{
				name: Type.Optional(Type.String({ description: "Optional replaceable sleep slot name." })),
				minutes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
				until: Type.Optional(Type.String({ description: "ISO-8601 timestamp." })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params) {
			if ((params.minutes === undefined) === (params.until === undefined)) {
				throw new Error("Set exactly one of minutes or until");
			}
			const wakeAt = params.until ? Date.parse(params.until) : Date.now() + params.minutes! * 60_000;
			if (!Number.isFinite(wakeAt)) throw new Error("until must be a valid ISO-8601 timestamp");
			const sleep = manager.sleep(params.name ?? "sleep", wakeAt);
			return {
				content: [
					{
						type: "text" as const,
						text: `Sleeping until ${new Date(wakeAt).toISOString()} as "${sleep.name}". This replaces any pending sleep with the same name.`,
					},
				],
				details: sleep,
			};
		},
	});

	pi.registerTool({
		name: "sentinel_gate",
		label: "Set Sentinel Gate",
		description:
			"Declare session completion criteria. Criterion flips queue for the next natural turn by default; ALL PASS wakes immediately by default. While open, do not claim completion.",
		parameters: Type.Object(
			{
				criteria: Type.Array(
					Type.Object(
						{
							name: Type.String(),
							command: Type.String(),
							pass_when: Type.Optional(predicateSchema),
							urgency: Type.Optional(urgencySchema),
						},
						{ additionalProperties: false },
					),
					{ minItems: 1 },
				),
				quiet_for_s: Type.Optional(Type.Number({ minimum: 0 })),
				urgency: Type.Optional(urgencySchema),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const gate = manager.setGate({
				cwd: ctx.cwd,
				quietForMs: params.quiet_for_s === undefined ? undefined : params.quiet_for_s * 1000,
				urgency: params.urgency,
				criteria: params.criteria.map((criterion) => ({
					name: criterion.name,
					command: criterion.command,
					passWhen: asPredicate(criterion.pass_when),
					urgency: criterion.urgency,
				})),
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `Gate opened with ${gate.criteria.length} criteria${gate.quietForMs ? ` and a ${gate.quietForMs / 1000}s quiet window` : ""}. Do not claim completion until it reports ALL PASS.`,
					},
				],
				details: gate,
			};
		},
	});

	pi.registerTool({
		name: "sentinel_status",
		label: "Sentinel Status",
		description: "List watches, sleeps, and the session gate with state, output snippets, and poll ETAs.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			const snapshot = manager.snapshot();
			return {
				content: [{ type: "text" as const, text: statusText(snapshot.items, snapshot.gate) }],
				details: snapshot,
			};
		},
	});

	pi.registerTool({
		name: "sentinel_cancel",
		label: "Cancel Sentinel",
		description:
			'Cancel a named watch/sleep, cancel the session gate with name "gate", or cancel everything. Undelivered queued events from cancelled sentinels are dropped.',
		parameters: Type.Object(
			{
				name: Type.Optional(Type.String()),
				all: Type.Optional(Type.Boolean()),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params) {
			if (!params.all && !params.name) throw new Error("Set name or all:true");
			const cancelled = manager.cancel(params.name, params.all);
			return {
				content: [
					{
						type: "text" as const,
						text: cancelled.length ? `Cancelled: ${cancelled.join(", ")}` : "No matching sentinels.",
					},
				],
				details: { cancelled },
			};
		},
	});
}

export default registerSentinel;
