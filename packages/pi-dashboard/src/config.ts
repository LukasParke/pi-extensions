/**
 * Dashboard configuration.
 *
 * Defaults keep the stock Pi UI: enabled is false, so nothing is replaced and
 * no pollers start until the user opts in via `~/.pi/dashboard.json` or env.
 */

import { boolean, load, nonEmptyString, number, type Schema } from "@parke.dev/pi-ext-config";

export interface DashboardConfig {
	/** Master switch. False leaves header/footer alone and starts no timers. */
	enabled: boolean;
	/** Replace the TUI header when enabled. */
	header: boolean;
	/** Replace the TUI footer when enabled. */
	footer: boolean;
	/** Look up an open PR for the current branch via `gh` (cached, silent on failure). */
	showPr: boolean;
	/** Git/PR poll interval in milliseconds. */
	pollIntervalMs: number;
	/** Optional header/window title override. */
	title?: string;
}

export const defaultConfig: DashboardConfig = {
	enabled: false,
	header: true,
	footer: true,
	showPr: true,
	pollIntervalMs: 3000,
};

export const schema: Schema<DashboardConfig> = {
	enabled: { validate: boolean, env: "PI_DASHBOARD_ENABLED" },
	header: { validate: boolean, env: "PI_DASHBOARD_HEADER" },
	footer: { validate: boolean, env: "PI_DASHBOARD_FOOTER" },
	showPr: { validate: boolean, env: "PI_DASHBOARD_SHOW_PR" },
	pollIntervalMs: { validate: number(250, 600_000), env: "PI_DASHBOARD_POLL_MS" },
	title: { validate: nonEmptyString, env: "PI_DASHBOARD_TITLE" },
};

export function dashboardConfig(): Promise<DashboardConfig> {
	return load({ name: "dashboard", schema, defaults: defaultConfig }).then((result) => result.config);
}

/** Pure resolve for tests (defaults ← file overrides ← env). */
export { resolve as resolveConfig } from "@parke.dev/pi-ext-config";
