/**
 * Human- and model-facing rendering for gauntlet state.
 *
 * Three surfaces share this module: the failure report injected into the
 * conversation (model-facing, markdown), the TUI widget (user-facing, one
 * line per fact), and the `/goal status` / tool `status` text. Keeping them
 * together keeps the ✓/✗/· vocabulary consistent everywhere.
 */

import type { GauntletCheck, GauntletState } from "./loop.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, type Component } from "@earendil-works/pi-tui";

/** Failure report injected into the conversation for another iteration. */
export function failureReport(
	state: GauntletState,
	failures: GauntletCheck[],
	maxIterations: number,
): string {
	const lines = [
		`Gauntlet failed (iteration ${state.iteration}/${maxIterations}). Goal: ${state.goal ?? "(none)"}`,
		"",
		"Keep working toward the goal until every check exits 0. Failing checks:",
	];
	for (const check of failures) {
		const outcome = state.results[check.name];
		lines.push("", `✗ ${check.name} (exit ${outcome?.code ?? "?"}) — \`${check.command}\``);
		const output = outcome?.output.trim();
		if (output) lines.push("```", output, "```");
	}
	return lines.join("\n");
}

export function checkGlyph(state: GauntletState, name: string): string {
	const outcome = state.results[name];
	if (!outcome) return "·";
	return outcome.code === 0 ? "✓" : "✗";
}

/** Widget lines shown while the loop is active. */
export function widgetLines(state: GauntletState, maxIterations: number): string[] {
	const goal = state.goal ?? "(no goal)";
	const oneLine = goal.replace(/\s+/g, " ").trim();
	return [
		`Goal: ${oneLine}`,
		`iteration ${state.iteration}/${maxIterations}`,
		state.checks.map((c) => `${checkGlyph(state, c.name)} ${c.name}`).join("  "),
	];
}

export function gauntletWidget(state: GauntletState, maxIterations: number, theme: Theme): Component {
	return {
		render(width) {
			const clean = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
			const passed = state.checks.filter((c) => state.results[c.name]?.code === 0).length;
			const lines = [
				theme.fg("accent", clean(state.goal ?? "Gauntlet")),
				theme.fg(
					passed === state.checks.length ? "success" : "warning",
					`${passed}/${state.checks.length} passing · iteration ${state.iteration}/${maxIterations} · /goal status`,
				),
			];
			for (const check of state.checks.slice(0, 2)) {
				const code = state.results[check.name]?.code;
				lines.push(
					theme.fg(
						code === undefined ? "muted" : code === 0 ? "success" : "error",
						`${checkGlyph(state, check.name)} ${clean(check.name)} · ${code === undefined ? "waiting" : code === 0 ? "passing" : "failed"}`,
					),
				);
			}
			if (state.checks.length > 2)
				lines.push(theme.fg("muted", `… +${state.checks.length - 2} checks · /gauntlet`));
			return lines.map((line) => truncateToWidth(line, width));
		},
		invalidate() {},
	};
}

/** One `<glyph> <name> — <status> — <command>` line, shared by list and status. */
function checkLine(state: GauntletState, check: GauntletCheck): string {
	const outcome = state.results[check.name];
	const status = outcome ? (outcome.code === 0 ? "passing" : `failing (exit ${outcome.code})`) : "not run";
	return `${checkGlyph(state, check.name)} ${check.name} — ${status} — \`${check.command}\``;
}

/** Just the checks with last status, for bare `/gauntlet`. */
export function checkListText(state: GauntletState): string {
	if (state.checks.length === 0)
		return "No gauntlet checks defined. Add one with /gauntlet add <name> <command>.";
	return state.checks.map((check) => checkLine(state, check)).join("\n");
}

/** Plain-text status for `/goal status` and the tool's `status` action. */
export function statusText(state: GauntletState, maxIterations: number): string {
	const lines = [
		`Goal: ${state.goal ?? "(none)"}`,
		`Loop: ${state.active ? "active" : "stopped"} — iteration ${state.iteration}/${maxIterations}`,
	];
	if (state.checks.length === 0) lines.push("No checks defined.");
	for (const check of state.checks) {
		lines.push(checkLine(state, check));
	}
	return lines.join("\n");
}
