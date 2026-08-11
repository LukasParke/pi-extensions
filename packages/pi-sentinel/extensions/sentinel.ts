import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SentinelManager } from "../src/manager.ts";
import type { GateSnapshot, SentinelEvent, SentinelSnapshot } from "../src/manager.ts";
import { validatePredicate } from "../src/index.ts";
import type { Predicate } from "../src/index.ts";

const UI_KEY = "sentinel";
const MESSAGE_TYPE = "sentinel-wakeup";
const DELIVERY_QUIET_MS = 250;

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

function formatEta(nextPollAt?: number) {
	if (!nextPollAt) return "not scheduled";
	const seconds = Math.max(0, Math.ceil((nextPollAt - Date.now()) / 1000));
	return seconds === 0 ? "now" : `in ${seconds}s`;
}

function itemLine(item: SentinelSnapshot) {
	const glyph =
		item.state === "complete" ? "✓" : item.state === "timeout" ? "✗" : item.kind === "sleep" ? "◷" : "◉";
	return `${glyph} ${item.name} [${item.kind}/${item.state}] next ${formatEta(item.nextPollAt)}`;
}

function gateLine(gate: GateSnapshot) {
	const passed = gate.criteria.filter((criterion) => criterion.state === "passing").length;
	return `${gate.complete ? "✓" : "◉"} gate ${passed}/${gate.criteria.length}${gate.complete ? " ALL PASS" : ""} next ${formatEta(gate.nextPollAt)}`;
}

export function sentinelStatus(items: SentinelSnapshot[], gate?: GateSnapshot) {
	const watches = items.filter(
		(item) => item.kind === "watch" && item.state !== "complete" && item.state !== "timeout",
	).length;
	const sleeps = items.filter(
		(item) => item.kind === "sleep" && item.state !== "complete" && item.state !== "timeout",
	).length;
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

function asPredicate(value?: Record<string, unknown>) {
	validatePredicate(value);
	return value as Predicate | undefined;
}

export default function (pi: ExtensionAPI) {
	const manager = new SentinelManager();
	const pending = new Map<string, SentinelEvent>();
	let uiCtx: ExtensionContext | undefined;
	let flushTimer: NodeJS.Timeout | undefined;
	let sleepCounter = 0;

	const refreshUi = () => {
		if (!uiCtx?.hasUI) return;
		const snapshot = manager.snapshot();
		const activeItems = snapshot.items.filter(
			(item) => item.state !== "complete" && item.state !== "timeout",
		);
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
		for (const [id, event] of [...pending]) {
			try {
				pi.sendMessage(
					{
						customType: MESSAGE_TYPE,
						content: event.message,
						display: true,
						details: event.details,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
				pending.delete(id);
			} catch {
				// Keep the event queued for the next idle flush.
			}
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
			"Poll a shell command while the agent is idle. Wake when its completion predicate passes, when stdout changes if wake_on_change is enabled, or when timeout_s expires. Complex predicates belong in the command itself (for example jq). Sentinels are in-memory and do not survive a Pi restart.",
		parameters: Type.Object(
			{
				name: Type.String({ description: "Unique watch name." }),
				command: Type.String({ description: "Shell command run on each idle poll." }),
				interval_s: Type.Optional(
					Type.Number({ minimum: 1, description: "Poll interval. Defaults to 60 seconds." }),
				),
				done_when: Type.Optional(predicateSchema),
				timeout_s: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
				wake_on_change: Type.Optional(Type.Boolean()),
				note: Type.Optional(Type.String()),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const watch = manager.watch({
				name: params.name,
				command: params.command,
				cwd: ctx.cwd,
				intervalMs: params.interval_s === undefined ? undefined : params.interval_s * 1000,
				doneWhen: asPredicate(params.done_when),
				timeoutMs: params.timeout_s === undefined ? undefined : params.timeout_s * 1000,
				wakeOnChange: params.wake_on_change,
				note: params.note,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `Watching "${watch.name}". First poll runs when the agent is idle.`,
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
			"Schedule a time-based wakeup with either minutes from now or an ISO-8601 until time. Sentinels are in-memory and do not survive a Pi restart.",
		parameters: Type.Object(
			{
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
			const sleep = manager.sleep(`sleep-${++sleepCounter}`, wakeAt);
			return {
				content: [
					{
						type: "text" as const,
						text: `Sleeping until ${new Date(wakeAt).toISOString()} as "${sleep.name}".`,
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
			"Declare session completion criteria. The gate passes only when every command passes and remains passing for quiet_for_s. While open, do not claim the task is done; wait for the SENTINEL GATE: ALL PASS wakeup.",
		parameters: Type.Object(
			{
				criteria: Type.Array(
					Type.Object(
						{
							name: Type.String(),
							command: Type.String(),
							pass_when: Type.Optional(predicateSchema),
						},
						{ additionalProperties: false },
					),
					{ minItems: 1 },
				),
				quiet_for_s: Type.Optional(Type.Number({ minimum: 0 })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const gate = manager.setGate({
				cwd: ctx.cwd,
				quietForMs: params.quiet_for_s === undefined ? undefined : params.quiet_for_s * 1000,
				criteria: params.criteria.map((criterion) => ({
					name: criterion.name,
					command: criterion.command,
					passWhen: asPredicate(criterion.pass_when),
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
		description:
			"List watches, sleeps, and the session gate with state, output snippets, and next poll times.",
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
			'Cancel a named watch/sleep, cancel the session gate with name "gate", or cancel everything.',
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
