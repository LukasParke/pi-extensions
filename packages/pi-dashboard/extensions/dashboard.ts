/**
 * Optional dashboard: custom TUI header + footer with cwd, model/thinking,
 * compaction-aware context, full session cost, live tok/s, git branch +
 * changed-file count, and optional open-PR hyperlink.
 *
 * Default is disabled. Nothing replaces stock UI and no pollers start until
 * `enabled` is set via `~/.pi/dashboard.json` or `PI_DASHBOARD_ENABLED`.
 *
 * Inspired by Ben Davis / davis7dotsh's my-pi-setup dashboard — independent
 * implementation, not a fork. Plain async, no Effect, no event bus.
 */

import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createGitPoller,
	createStreamTracker,
	dashboardConfig,
	defaultConfig,
	emptyGitSnapshot,
	emptyModelSnapshot,
	formatDirectory,
	installDashboardUi,
	type DashboardConfig,
	type DashboardState,
	type GitSnapshot,
	type InstallHandles,
	type ModelSnapshot,
} from "../src/index.ts";

export default function (pi: ExtensionAPI) {
	let config: DashboardConfig = { ...defaultConfig };
	let model: ModelSnapshot = emptyModelSnapshot();
	let git: GitSnapshot = emptyGitSnapshot();
	let handles: InstallHandles | null = null;
	let currentCtx: ExtensionContext | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let generation = 0;

	const stream = createStreamTracker();
	let poller = createGitPoller({ showPr: defaultConfig.showPr });

	const getState = (): DashboardState => ({
		config,
		model,
		git,
		home: process.env.HOME ?? homedir(),
		title: currentCtx ? formatDirectory(currentCtx.cwd, process.env.HOME ?? homedir()) : "pi",
	});

	const bumpModel = (patch: Partial<ModelSnapshot>) => {
		model = { ...model, ...patch };
		handles?.requestRender();
	};

	const refreshModelFromCtx = (ctx: ExtensionContext) => {
		const m = ctx.model;
		const usage = ctx.getContextUsage();
		bumpModel({
			provider: m?.provider ?? "",
			modelId: m?.id ?? "no-model",
			thinking: m?.reasoning ? pi.getThinkingLevel() : "off",
			contextPercent: usage?.percent ?? null,
			contextWindow: usage?.contextWindow ?? m?.contextWindow ?? 0,
			tokensPerSecond: stream.tokensPerSecond,
		});
	};

	const stopPolling = () => {
		if (pollTimer !== undefined) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
	};

	const startPolling = (ctx: ExtensionContext) => {
		stopPolling();
		if (!config.enabled || (!config.header && !config.footer)) return;

		poller.setOnChange((next) => {
			git = next;
			handles?.requestRender();
		});
		poller.request(ctx.cwd, true);

		pollTimer = setInterval(() => {
			if (!currentCtx) return;
			poller.request(currentCtx.cwd, false);
		}, config.pollIntervalMs);
		// Don't keep the process alive solely for the poller.
		pollTimer.unref?.();
	};

	const teardown = () => {
		generation += 1;
		stopPolling();
		poller.setOnChange(undefined);
		poller.invalidate();
		handles?.uninstall();
		handles = null;
		currentCtx = undefined;
		git = emptyGitSnapshot();
		model = emptyModelSnapshot();
		stream.resetRun();
	};

	pi.on("session_start", async (_event, ctx) => {
		teardown();
		const gen = (generation += 1);
		currentCtx = ctx;

		config = await dashboardConfig();
		if (gen !== generation) return;

		if (!config.enabled) {
			// Explicit no-op boundary: stock UI stays, no pollers.
			return;
		}

		poller = createGitPoller({ showPr: config.showPr });
		handles = installDashboardUi(ctx, getState(), getState);
		if (!handles) return;
		refreshModelFromCtx(ctx);
		startPolling(ctx);
	});

	pi.on("session_shutdown", () => {
		teardown();
	});

	pi.on("model_select", (event, ctx) => {
		if (!config.enabled) return;
		bumpModel({
			provider: event.model.provider,
			modelId: event.model.id,
			thinking: event.model.reasoning ? pi.getThinkingLevel() : "off",
			contextWindow: event.model.contextWindow,
		});
		refreshModelFromCtx(ctx);
	});

	pi.on("thinking_level_select", (event) => {
		if (!config.enabled) return;
		bumpModel({ thinking: event.level ?? "off" });
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!config.enabled) return;
		stream.resetRun();
		bumpModel({ tokensPerSecond: null, generating: true });
		refreshModelFromCtx(ctx);
	});

	pi.on("message_start", (event) => {
		if (!config.enabled) return;
		if (event.message.role === "assistant") stream.resetMessage();
	});

	pi.on("message_update", (event) => {
		if (!config.enabled) return;
		if (event.message.role !== "assistant") return;
		const streamEvent = event.assistantMessageEvent;
		if (!streamEvent) return;

		if (streamEvent.type === "toolcall_delta") {
			stream.onToolCall();
			return;
		}
		if (streamEvent.type !== "text_delta" && streamEvent.type !== "thinking_delta") return;
		if (!streamEvent.delta) return;

		const rate = stream.onContentDelta(streamEvent.delta);
		if (rate !== model.tokensPerSecond) {
			bumpModel({ tokensPerSecond: rate });
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (!config.enabled) return;
		if (event.message.role !== "assistant") return;
		const output = event.message.usage.output;
		const rate = stream.endMessage({ outputTokens: output });
		bumpModel({ tokensPerSecond: rate });
		refreshModelFromCtx(ctx);
		// Git often changes after tool turns; coalesce a refresh.
		if (currentCtx) poller.request(currentCtx.cwd, false);
	});

	pi.on("turn_end", (_event, ctx) => {
		if (!config.enabled) return;
		refreshModelFromCtx(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!config.enabled) return;
		bumpModel({ generating: false });
		refreshModelFromCtx(ctx);
		if (currentCtx) poller.request(currentCtx.cwd, false);
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		if (!config.enabled || !config.footer) return;
		poller.request(ctx.cwd, false);
	});
}
