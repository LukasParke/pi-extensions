/**
 * Error log configuration.
 *
 * The log is on by default and writes to `~/.pi/logs/errors.jsonl`. Override
 * via `~/.pi/error-log.json` or `PI_ERROR_LOG_*` environment variables.
 */

import * as path from "node:path";
import { boolean, load, nonEmptyString, number, piConfigDir, type Schema } from "@parke.dev/pi-ext-config";

export interface ErrorLogConfig {
	/** Master switch. When false, nothing is captured and the tool reports disabled. */
	enabled: boolean;
	/** Log file path. Defaults to `~/.pi/logs/errors.jsonl`. */
	path?: string;
	/** Rotate to `<path>.1` (replacing it) once the file exceeds this many bytes. */
	maxBytes: number;
}

export const defaultConfig: ErrorLogConfig = {
	enabled: true,
	maxBytes: 10 * 1024 * 1024,
};

export const schema: Schema<ErrorLogConfig> = {
	enabled: { validate: boolean, env: "PI_ERROR_LOG_ENABLED" },
	path: { validate: nonEmptyString, env: "PI_ERROR_LOG_PATH" },
	maxBytes: { validate: number(1024), env: "PI_ERROR_LOG_MAX_BYTES" },
};

let cached: Promise<ErrorLogConfig> | undefined;

export function errorLogConfig(): Promise<ErrorLogConfig> {
	cached ??= load({ name: "error-log", schema, defaults: defaultConfig }).then((r) => r.config);
	return cached;
}

/** Test seam: drop the memoized config. */
export function resetConfigCache(): void {
	cached = undefined;
}

export function logPath(config: ErrorLogConfig): string {
	return config.path ?? path.join(piConfigDir(), "logs", "errors.jsonl");
}
