import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { dispatchQueue, ensureDelivery } from "@parke.dev/pi-dispatch";
import type { DispatchPriority } from "@parke.dev/pi-dispatch";
import { NO_REPO_MESSAGE, parseRepo, resolveRepo, resolveToken } from "@parke.dev/pi-github";
import { SentinelManager } from "../src/manager.ts";
import type {
	EventUrgency,
	GateSnapshot,
	SentinelEvent,
	SentinelSnapshot,
	WatchMode,
} from "../src/manager.ts";
import { validatePredicate } from "../src/index.ts";
import { createGitHubPrProbe, formatPrSnapshot, prNeedsAction } from "../src/pr.ts";
import type { Predicate } from "../src/index.ts";

const UI_KEY = "sentinel";

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
	const prs = items.filter((item) => item.kind === "pr" && isActive(item)).length;
	const parts = [
		prs ? `${prs} PR${prs === 1 ? "" : "s"}` : undefined,
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

export function eventPriority(event: SentinelEvent): DispatchPriority {
	if (event.details.status === "all_pass") return "escalation";
	if (event.details.status === "complete" || event.details.status === "elapsed") return "completion";
	if (event.details.type === "merged" || event.details.type === "closed") return "completion";
	return "info";
}

function asPredicate(value?: Record<string, unknown>) {
	validatePredicate(value);
	return value as Predicate | undefined;
}

export function registerSentinel(pi: ExtensionAPI, manager = new SentinelManager()) {
	let uiCtx: ExtensionContext | undefined;

	ensureDelivery(pi);

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

	manager.onEvent((event) => {
		dispatchQueue().publish({
			id: event.id,
			source: `sentinel:${event.source}`,
			priority: eventPriority(event),
			urgency: event.urgency,
			message: event.message,
			details: event.details,
		});
	});
	manager.onSuppress((sources) => {
		for (const source of sources) dispatchQueue().suppress(`sentinel:${source}`);
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
	});
	pi.on("session_shutdown", () => {
		manager.dispose();
		uiCtx?.ui.setStatus(UI_KEY, undefined);
		uiCtx?.ui.setWidget(UI_KEY, undefined);
		uiCtx = undefined;
	});

	pi.registerTool({
		name: "sentinel_watch",
		label: "Watch Sentinel",
		description:
			"Watch a shell command until it completes or times out. Poll mode runs it on an interval while idle. Stream mode spawns it once and reacts immediately when it exits. next-turn urgency queues information without triggering a model turn. Re-registering a same-name, same-spec watch succeeds and returns the existing watch.",
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
				replace: Type.Optional(
					Type.Boolean({
						description:
							"If a same-name watch exists with a different spec, replace it instead of failing. Same-spec re-registration always succeeds and returns the existing watch.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { sentinel, created } = manager.watch({
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
				replace: params.replace,
			});
			const description = created
				? sentinel.mode === "stream"
					? `Streaming "${sentinel.name}". The command was spawned once and will wake on exit.`
					: `Watching "${sentinel.name}". First poll runs when the agent is idle.`
				: `"${sentinel.name}" was already registered with the same spec; existing ${sentinel.mode ?? "poll"} watch (${sentinel.state}) returned.`;
			return {
				content: [{ type: "text" as const, text: description }],
				details: sentinel,
			};
		},
	});

	pi.registerTool({
		name: "sentinel_pr",
		label: "Attach PR Sentinel",
		description:
			"Attach a GitHub pull request to this session. Authenticated polling wakes the agent for merge conflicts, broken CI, review feedback, and closure or merge. Supports private and internal repositories through GitHub credentials. Re-attaching the same PR with the same spec succeeds and returns the existing sentinel.",
		parameters: Type.Object(
			{
				number: Type.Integer({ minimum: 1, description: "Pull request number." }),
				repo: Type.Optional(
					Type.String({
						description: 'Repository as "owner/name". Defaults to the current checkout origin.',
					}),
				),
				name: Type.Optional(Type.String({ description: "Unique sentinel name. Defaults to pr-N." })),
				interval_s: Type.Optional(
					Type.Number({ minimum: 10, description: "Poll interval. Defaults to 60 seconds." }),
				),
				timeout_s: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
				note: Type.Optional(Type.String()),
				replace: Type.Optional(
					Type.Boolean({
						description:
							"If a same-name sentinel exists with a different spec, replace it instead of failing. Same-spec re-attach always succeeds and returns the existing sentinel.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const repo = params.repo ? parseRepo(params.repo) : await resolveRepo(undefined, { cwd: ctx.cwd });
			if (!repo) throw new Error(NO_REPO_MESSAGE);
			const credential = await resolveToken();
			if (!credential) {
				throw new Error(
					"No GitHub credential found. Run `gh auth login`, set GITHUB_TOKEN, or connect with the pi-github integration.",
				);
			}
			const name = params.name ?? `pr-${params.number}`;
			const probe = createGitHubPrProbe({ token: credential.token, repo, number: params.number });
			const initialSnapshot = await probe();
			const { sentinel, created } = manager.attachPr({
				name,
				repo: repo.slug,
				number: params.number,
				probe,
				initialSnapshot,
				intervalMs: params.interval_s === undefined ? undefined : params.interval_s * 1000,
				timeoutMs: params.timeout_s === undefined ? undefined : params.timeout_s * 1000,
				note: params.note,
				replace: params.replace,
			});
			const attachedText = created
				? `Attached ${repo.slug}#${params.number} as "${name}" using ${credential.detail}. Current state: ${formatPrSnapshot(initialSnapshot)}.${prNeedsAction(initialSnapshot) ? " Action is already required." : " Actionable updates wake the agent."}`
				: `"${name}" was already registered with the same spec for ${repo.slug}#${params.number}; existing sentinel (state: ${sentinel.state}) returned. ${formatPrSnapshot(initialSnapshot)}`;
			return {
				content: [{ type: "text" as const, text: attachedText }],
				details: sentinel,
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
		description:
			"List attached PRs, watches, sleeps, and the session gate with state, output snippets, and poll ETAs.",
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
			'Cancel a named PR/watch/sleep, cancel the session gate with name "gate", or cancel everything. Undelivered queued events from cancelled sentinels are dropped.',
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
