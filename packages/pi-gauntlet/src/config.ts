/**
 * Gauntlet configuration.
 *
 * Defaults are deliberately conservative: ten iterations is enough for a
 * competent agent to converge on a failing test suite without burning a day of
 * tokens, and five minutes covers slow typechecks without hanging forever.
 * Override via `~/.pi/gauntlet.json` or the `PI_GAUNTLET_*` env vars.
 */

import { load, number, type Schema } from "@parke.dev/pi-ext-config";

export interface GauntletConfig {
	/** Most failures injected back into the conversation before the loop gives up. */
	maxIterations: number;
	/** Per-check timeout, ms. A check that exceeds it counts as failed. */
	checkTimeoutMs: number;
}

export const defaultConfig: GauntletConfig = {
	maxIterations: 10,
	checkTimeoutMs: 300_000,
};

export const schema: Schema<GauntletConfig> = {
	maxIterations: { validate: number(1, 100), env: "PI_GAUNTLET_MAX_ITERATIONS" },
	checkTimeoutMs: { validate: number(1_000), env: "PI_GAUNTLET_CHECK_TIMEOUT_MS" },
};

let cached: Promise<GauntletConfig> | undefined;

export function gauntletConfig(): Promise<GauntletConfig> {
	cached ??= load({ name: "gauntlet", schema, defaults: defaultConfig })
		.then((r) => r.config)
		.catch((error) => {
			cached = undefined;
			throw error;
		});
	return cached;
}

/** Test seam: drop the memoized config. */
export function resetConfigCache(): void {
	cached = undefined;
}
