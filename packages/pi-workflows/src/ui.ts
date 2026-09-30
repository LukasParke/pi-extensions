import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { LiveWorkflowRun, WorkflowRunRegistry } from "./registry.ts";
import { isTerminalState } from "./registry.ts";
import { formatDuration, formatUsageLine } from "./usage.ts";

export const WIDGET_KEY = "workflows";
export const ENTRY_TYPE = "workflow-run-v1";
export const COMPLETION_TYPE = "workflow-completion";

export const cleanLabel = (text: string) =>
	stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export function workflowTone(state: string) {
	if (state === "failed") return "error";
	if (["timeout", "partial", "waiting"].includes(state)) return "warning";
	if (["completed", "ready"].includes(state)) return "success";
	if (["cancelled", "idle"].includes(state)) return "muted";
	return "accent";
}

export function workflowStatus(runs: LiveWorkflowRun[]) {
	const active = runs.filter((run) => !isTerminalState(run.state)).length;
	const ready = runs.filter((run) => isTerminalState(run.state) && !run.delivered && !run.claimed).length;
	if (!active && !ready) return undefined;
	return [active ? `⚙ ${active} running` : "", ready ? `${ready} ready` : "", "/workflows"]
		.filter(Boolean)
		.join(" · ");
}

export function widgetLines(runs: LiveWorkflowRun[]): string[] | undefined {
	const actionable = runs.filter((run) => !isTerminalState(run.state) || (!run.delivered && !run.claimed));
	if (!actionable.length) return undefined;
	const lines = actionable
		.slice(0, 4)
		.map(
			(run) =>
				`${cleanLabel(run.label)} · ${run.phase ? cleanLabel(run.phase) : run.state} · ${run.completedAgents}/${run.agentCount} agents`,
		);
	if (actionable.length > 4) lines.push(`… +${actionable.length - 4} more · /workflows`);
	return lines;
}

export function workflowWidget(runs: LiveWorkflowRun[], theme: Theme): Component {
	return {
		render(width) {
			const actionable = runs.filter(
				(run) => !isTerminalState(run.state) || (!run.delivered && !run.claimed),
			);
			return (widgetLines(runs) ?? []).map((line, index) =>
				truncateToWidth(theme.fg(index < 4 ? workflowTone(actionable[index]!.state) : "muted", line), width),
			);
		},
		invalidate() {},
	};
}

/** Model-facing status retains ids and accounting; visual rows use label-first summaries. */
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

function visualRunLine(run: LiveWorkflowRun) {
	return `${cleanLabel(run.label)} · ${run.state}${run.phase ? ` · ${cleanLabel(run.phase)}` : ""} · ${run.completedAgents}/${run.agentCount} agents`;
}

export interface WorkflowOverlayAdapter {
	list(): LiveWorkflowRun[];
	cancel(id: string): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export function openWorkflowsOverlay(
	tui: TUI,
	theme: Theme,
	done: (result: void) => void,
	adapter: WorkflowOverlayAdapter,
): Component & { dispose(): void } {
	let selectedId: string | undefined;
	let selected = 0;
	let expanded = false;
	let disposed = false;
	const list = () => {
		const group = (run: LiveWorkflowRun) =>
			!isTerminalState(run.state) ? 0 : !run.delivered && !run.claimed ? 1 : 2;
		const runs = adapter
			.list()
			.slice()
			.sort((a, b) => group(a) - group(b));
		const previous = runs.findIndex((run) => run.runId === selectedId);
		selected = previous >= 0 ? previous : Math.max(0, Math.min(selected, runs.length - 1));
		selectedId = runs[selected]?.runId;
		return runs;
	};
	const repaint = () => {
		if (!disposed) tui.requestRender();
	};
	return {
		render(width) {
			const runs = list();
			const run = runs[selected];
			const height = Math.max(4, Math.floor((tui.terminal?.rows ?? 24) * 0.7));
			const detail =
				expanded && run
					? [
							theme.fg(
								"muted",
								`${run.runId} · ${formatUsageLine(run.usage)} · ${formatDuration((run.endedAt ?? Date.now()) - run.startedAt)}`,
							),
							theme.fg("muted", `Artifacts: ${cleanLabel(run.artifactPath)}`),
						]
					: [];
			const pageSize = Math.max(1, height - 3 - detail.length);
			const start = Math.max(0, Math.min(selected - pageSize + 1, runs.length - pageSize));
			const lines = [theme.fg("accent", "Workflows") + theme.fg("muted", ` · ${runs.length} runs`)];
			if (!runs.length) lines.push(theme.fg("muted", "No workflow runs in this session."));
			for (const [index, item] of runs.slice(start, start + pageSize).entries()) {
				const group = !isTerminalState(item.state)
					? "running"
					: !item.delivered && !item.claimed
						? "ready"
						: "history";
				lines.push(
					(start + index === selected ? "› " : "  ") +
						theme.fg(workflowTone(item.state), visualRunLine(item)) +
						theme.fg("dim", ` · ${group}`),
				);
			}
			lines.push(...detail);
			lines.push(
				theme.fg(
					"muted",
					`${runs.length ? `${selected + 1}/${runs.length} · j/k move · enter ${expanded ? "summary" : "details"} · ` : ""}${run && !isTerminalState(run.state) ? "x cancel · " : ""}q/esc close`,
				),
			);
			return lines.map((line) => truncateToWidth(line, width));
		},
		handleInput(data) {
			if (disposed) return;
			const runs = list();
			if (matchesKey(data, "escape") || matchesKey(data, "q")) {
				disposed = true;
				done(undefined);
				return;
			}
			if (matchesKey(data, "j") || matchesKey(data, "down"))
				selected = Math.min(runs.length - 1, selected + 1);
			if (matchesKey(data, "k") || matchesKey(data, "up")) selected = Math.max(0, selected - 1);
			if (matchesKey(data, "enter")) expanded = !expanded;
			if (matchesKey(data, "x") || matchesKey(data, "delete")) {
				const run = runs[selected];
				if (run && !isTerminalState(run.state)) {
					adapter.cancel(run.runId);
					adapter.notify(`Cancelled ${run.runId}`, "info");
				}
			}
			selectedId = runs[selected]?.runId;
			repaint();
		},
		invalidate: repaint,
		dispose() {
			disposed = true;
		},
	};
}

/** Text provides native rendering; pre-truncate rows so wrapping never exceeds the row budget. */
export function compactText(lines: () => string[]): Component {
	return {
		render(width) {
			return new Text(
				lines()
					.map((line) => truncateToWidth(line, width))
					.join("\n"),
				0,
				0,
			).render(width);
		},
		invalidate() {},
	};
}

export function workflowResultLines(
	result: { content: { type: string; text?: string }[]; details?: unknown },
	options: { expanded: boolean; isPartial: boolean; isError?: boolean },
	theme: Theme,
) {
	const details =
		result.details && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {};
	const summary =
		details.summary && typeof details.summary === "object"
			? (details.summary as Record<string, unknown>)
			: details;
	const text = result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
	const state = options.isError
		? "failed"
		: typeof details.state === "string"
			? details.state
			: options.isPartial
				? "running"
				: "completed";
	const label =
		typeof summary.label === "string"
			? summary.label
			: typeof details.label === "string"
				? details.label
				: "Workflow";
	const lines = [theme.fg(workflowTone(state), `${cleanLabel(label)} · ${state}`)];
	if (Array.isArray(details.live) && Array.isArray(details.recent)) {
		lines[0] = theme.fg(
			"success",
			`${details.live.length} live · ${details.recent.length} recent · /workflows`,
		);
	}
	if (summary.agentCount !== undefined)
		lines.push(
			theme.fg(
				"muted",
				`${summary.completedAgents ?? 0}/${summary.agentCount} agents${summary.phase ? ` · ${cleanLabel(String(summary.phase))}` : ""}`,
			),
		);
	if (options.isError || summary.failure)
		lines.push(
			theme.fg("error", cleanLabel(String(summary.failure ?? text.split("\n")[0] ?? "Workflow failed"))),
		);
	if (options.expanded) {
		const body = text.split("\n");
		lines.push(...body.slice(0, 40).map((line) => theme.fg("toolOutput", cleanLabel(line))));
		if (body.length > 40) lines.push(theme.fg("muted", "… more in workflow artifacts"));
	} else if (summary.artifactPath) {
		lines.push(theme.fg("muted", `Artifacts: ${cleanLabel(String(summary.artifactPath))}`));
	}
	return lines;
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
