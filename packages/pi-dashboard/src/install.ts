/**
 * UI install boundary.
 *
 * Separated from the extension entry so tests can prove a disabled config
 * never touches header/footer/title, without booting a full ExtensionAPI.
 */

import type { ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, truncateToWidth } from "@earendil-works/pi-tui";
import type { DashboardConfig } from "./config.ts";
import { createSessionCostCache } from "./cost.ts";
import { center, columns, formatCost, formatDirectory, formatTokens, formatTokPerSec } from "./format.ts";
import type { GitSnapshot } from "./git.ts";
import { formatGitLabel } from "./git.ts";
import { formatModelLabel, type ModelSnapshot } from "./model.ts";
import { sanitizeTerminalLabel } from "./sanitize.ts";

export interface DashboardState {
	config: DashboardConfig;
	model: ModelSnapshot;
	git: GitSnapshot;
	home: string | undefined;
	title: string;
}

export interface InstallHandles {
	/** Clear header/footer replacements. */
	uninstall: () => void;
	/** Ask the TUI to repaint, if installed. */
	requestRender: () => void;
}

/**
 * Install custom header/footer when config says so.
 * Returns null when nothing should be installed (disabled / no UI).
 */
export function installDashboardUi(
	ctx: ExtensionContext,
	state: DashboardState,
	getState: () => DashboardState,
): InstallHandles | null {
	if (!state.config.enabled) return null;
	if (ctx.mode !== "tui") return null;
	if (!state.config.header && !state.config.footer) return null;

	const costCache = createSessionCostCache();
	let requestRender: () => void = () => {};

	if (state.config.header) {
		ctx.ui.setHeader((tui, theme) => {
			requestRender = () => tui.requestRender();
			return {
				invalidate() {},
				render(width: number) {
					const current = getState();
					const label = sanitizeTerminalLabel(current.config.title ?? current.title);
					const line = theme.fg("accent", center(label, width));
					return ["", line, ""];
				},
			};
		});
	}

	if (state.config.footer) {
		ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
			requestRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number) {
					const current = getState();
					const directory = theme.fg(
						"text",
						formatDirectory(ctx.sessionManager.getCwd(), current.home),
					);
					const model = theme.fg("muted", formatModelLabel(current.model));

					const entries = ctx.sessionManager.getEntries();
					const totals = costCache.get(entries);
					const usage = ctx.getContextUsage();
					const contextPercent =
						usage?.percent != null
							? `${Math.round(usage.percent)}`
							: current.model.contextPercent != null
								? `${Math.round(current.model.contextPercent)}`
								: "?";
					const contextWindow = usage?.contextWindow || current.model.contextWindow || 0;
					const contextColor =
						usage?.percent != null
							? usage.percent >= 90
								? "error"
								: usage.percent >= 70
									? "warning"
									: "muted"
							: "muted";
					const contextPart = theme.fg(contextColor, `${contextPercent}%/${formatTokens(contextWindow)}`);
					const costPart = theme.fg("muted", formatCost(totals.cost));
					const tpsPart = theme.fg("muted", formatTokPerSec(current.model.tokensPerSecond));
					const usageLine = `${contextPart}${theme.fg("dim", " · ")}${costPart}${theme.fg("dim", " · ")}${tpsPart}`;

					let gitText = formatGitLabel(current.git, current.config.showPr);
					// Prefer live poller state; fall back to host branch if poller empty.
					if (!gitText) {
						const hostBranch = footerData.getGitBranch?.();
						if (hostBranch) {
							gitText = sanitizeTerminalLabel(hostBranch);
						}
					}
					if (current.config.showPr && current.git.pullRequest) {
						const prLabel = `PR #${current.git.pullRequest.number}`;
						const linked = getCapabilities().hyperlinks
							? hyperlink(prLabel, current.git.pullRequest.url)
							: prLabel;
						// formatGitLabel already appends PR #N; rebuild without the plain suffix
						// when we can hyperlink.
						const base = formatGitLabel({ ...current.git, pullRequest: null }, false);
						gitText = base ? `${base} · ${linked}` : linked;
					}

					const lines = [
						columns(directory, model, width),
						columns(usageLine, theme.fg("muted", gitText), width),
					];

					const statuses = footerData.getExtensionStatuses();
					for (const [, text] of [...statuses.entries()].sort(([a], [b]) => a.localeCompare(b))) {
						if (!text) continue;
						for (const statusLine of text.split("\n")) {
							lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "…")));
						}
					}

					return lines;
				},
			};
		});
	}

	const title = sanitizeTerminalLabel(state.config.title ?? state.title);
	try {
		ctx.ui.setTitle(`pi · ${title}`);
	} catch {
		// setTitle is best-effort
	}

	return {
		requestRender: () => requestRender(),
		uninstall() {
			try {
				if (state.config.header) ctx.ui.setHeader(undefined);
				if (state.config.footer) ctx.ui.setFooter(undefined);
			} catch {
				// host may already be torn down
			}
		},
	};
}
