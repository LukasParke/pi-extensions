/**
 * Lightweight /workflows overlay and widget helpers using existing extension APIs.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { LiveWorkflowRun, WorkflowRunRegistry } from "./registry.ts";
import { isTerminalState } from "./registry.ts";
import { formatDuration, formatUsageLine } from "./usage.ts";

export const WIDGET_KEY = "workflows";
export const ENTRY_TYPE = "workflow-run-v1";
export const COMPLETION_TYPE = "workflow-completion";

export function workflowStatus(runs: LiveWorkflowRun[]) {
	const active = runs.filter((run) => !isTerminalState(run.state)).length;
	const ready = runs.filter((run) => isTerminalState(run.state) && !run.delivered && !run.claimed).length;
	if (!active && !ready) return undefined;
	return [active ? `⚙ ${active} running` : "", ready ? `${ready} ready` : "", "/workflows"]
		.filter(Boolean)
		.join(" · ");
}

export function widgetLines(runs: LiveWorkflowRun[]): string[] | undefined {
	const active = runs.filter((run) => !isTerminalState(run.state));
	const ready = runs.filter((run) => isTerminalState(run.state) && !run.delivered && !run.claimed);
	if (!active.length && !ready.length) return undefined;
	const lines: string[] = [];
	for (const run of active.slice(0, 5)) {
		lines.push(
			`⚙ ${run.runId.slice(0, 14)} ${run.label} — ${run.phase ?? run.state} · ${run.completedAgents}/${run.agentCount} agents · ${formatUsageLine(run.usage)}`,
		);
	}
	for (const run of ready.slice(0, 3)) {
		const glyph = run.state === "completed" ? "✓" : "✗";
		lines.push(`${glyph} ${run.runId.slice(0, 14)} ${run.label} ready · /workflows`);
	}
	if (active.length + ready.length > lines.length) {
		lines.push(`… +${active.length + ready.length - lines.length} more`);
	}
	return lines;
}

export function formatRunLine(run: LiveWorkflowRun) {
	const glyph =
		run.state === "running" || run.state === "pending"
			? "⚙"
			: run.state === "completed"
				? "✓"
				: run.state === "cancelled"
					? "⊘"
					: "✗";
	const elapsed = formatDuration((run.endedAt ?? Date.now()) - run.startedAt);
	return `${glyph} ${run.runId} ${run.label} [${run.state}] ${run.completedAgents}/${run.agentCount} · ${formatUsageLine(run.usage, (run.endedAt ?? Date.now()) - run.startedAt)} · ${elapsed}`;
}

export interface WorkflowOverlayAdapter {
	list(): LiveWorkflowRun[];
	cancel(id: string): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Minimal keyboard overlay listing runs; Enter cancels selection when running. */
export function openWorkflowsOverlay(
	tui: TUI,
	theme: Theme,
	done: (result: void) => void,
	adapter: WorkflowOverlayAdapter,
): Component & { dispose?(): void } {
	let selected = 0;
	let disposed = false;
	const invalidate = () => {
		if (!disposed) tui.requestRender();
	};

	const component: Component & { dispose?(): void } = {
		render(width: number) {
			const runs = adapter.list();
			const lines = [
				theme.fg("accent", "Workflows") + theme.fg("dim", "  j/k move · x cancel · q close"),
				theme.fg("dim", "─".repeat(Math.min(width, 60))),
			];
			if (!runs.length) {
				lines.push(theme.fg("dim", "No workflow runs in this session."));
			} else {
				runs.slice(0, 30).forEach((run, index) => {
					const mark = index === selected ? theme.fg("accent", "› ") : "  ";
					lines.push(mark + truncateToWidth(formatRunLine(run), Math.max(10, width - 2)));
				});
			}
			return lines;
		},
		handleInput(data: string) {
			const runs = adapter.list();
			if (matchesKey(data, "escape") || matchesKey(data, "q")) {
				done(undefined);
				return;
			}
			if (matchesKey(data, "j") || matchesKey(data, "down")) {
				selected = Math.min(runs.length - 1, selected + 1);
				invalidate();
				return;
			}
			if (matchesKey(data, "k") || matchesKey(data, "up")) {
				selected = Math.max(0, selected - 1);
				invalidate();
				return;
			}
			if (matchesKey(data, "x") || matchesKey(data, "delete")) {
				const run = runs[selected];
				if (run && !isTerminalState(run.state)) {
					adapter.cancel(run.runId);
					adapter.notify(`Cancelled ${run.runId}`, "info");
					invalidate();
				}
			}
		},
		invalidate() {},
		dispose() {
			disposed = true;
		},
	};
	return component;
}

export function refreshWorkflowUi(
	setWidget: (key: string, content: string[] | undefined) => void,
	setStatus: (key: string, content: string | undefined) => void,
	registry: WorkflowRunRegistry,
	sessionKey: string,
) {
	const runs = registry.list(sessionKey);
	setWidget(WIDGET_KEY, widgetLines(runs));
	setStatus(WIDGET_KEY, workflowStatus(runs));
}
