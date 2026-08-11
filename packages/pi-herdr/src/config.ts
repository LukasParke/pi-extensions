/**
 * Herdr extension configuration.
 *
 * Defaults match the conventional layout: repos under `~/github` or
 * `~/Development`, herdr worktrees under `~/.herdr/worktrees` (or a plain
 * `~/.worktrees`). Override via `~/.pi/herdr.json` or environment variables
 * when repos live elsewhere.
 */

import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expandTilde, load, type Schema, type Validator } from "@parke.dev/pi-ext-config";

export interface HerdrConfig {
	/** Directories scanned for repos addressable by short name. */
	repoRoots: string[];
	/** Roots whose git worktrees inherit trust from their base repo. */
	worktreeRoots: string[];
	/** JSONL audit log for every herdr CLI invocation. */
	logPath: string;
}

export const defaultConfig: HerdrConfig = {
	repoRoots: [join(homedir(), "github"), join(homedir(), "Development")],
	worktreeRoots: [join(homedir(), ".herdr", "worktrees"), join(homedir(), ".worktrees")],
	logPath: join(homedir(), ".pi", "herdr-task.log"),
};

/** A list of paths: an array in the file, or a PATH-style separated string from env. */
const pathList: Validator<string[]> = (value) => {
	const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(delimiter) : undefined;
	if (!items) return undefined;
	const paths = items
		.filter((item): item is string => typeof item === "string" && item.trim() !== "")
		.map((item) => resolve(expandTilde(item.trim())));
	return paths.length ? paths : undefined;
};

const path: Validator<string> = (value) =>
	typeof value === "string" && value.trim() ? resolve(expandTilde(value.trim())) : undefined;

export const schema: Schema<HerdrConfig> = {
	repoRoots: { validate: pathList, env: "HERDR_REPO_ROOTS" },
	worktreeRoots: { validate: pathList, env: "HERDR_WORKTREE_ROOTS" },
	logPath: { validate: path, env: "HERDR_LOG_PATH" },
};

let cached: Promise<HerdrConfig> | undefined;

export function herdrConfig(): Promise<HerdrConfig> {
	cached ??= load({ name: "herdr", schema, defaults: defaultConfig }).then((r) => r.config);
	return cached;
}

/** Test seam: drop the memoized config. */
export function resetConfigCache(): void {
	cached = undefined;
}
