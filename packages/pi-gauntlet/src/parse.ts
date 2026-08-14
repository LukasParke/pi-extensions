/**
 * Small parsers shared by the slash commands and the project seed file.
 */

import type { GauntletCheck, GauntletState } from "./loop.ts";

/** `/gauntlet add <name> <command…>` — name is one token, the rest is the command. */
export function parseCheckArgs(args: string): { name: string; command: string } | undefined {
	const trimmed = args.trim();
	const space = trimmed.search(/\s/);
	if (space < 0) return undefined;
	const name = trimmed.slice(0, space);
	const command = trimmed.slice(space).trim();
	if (!name || !command) return undefined;
	return { name, command };
}

/**
 * Validate a `.pi/gauntlet.json` document: `{ "checks": { "<name>": "<command>" } }`.
 * Returns undefined for anything malformed — a bad seed file must never break
 * session startup.
 */
export function parseSeedChecks(json: unknown): GauntletCheck[] | undefined {
	if (typeof json !== "object" || json === null) return undefined;
	const checks = (json as { checks?: unknown }).checks;
	if (typeof checks !== "object" || checks === null || Array.isArray(checks)) return undefined;
	const parsed: GauntletCheck[] = [];
	for (const [name, command] of Object.entries(checks)) {
		if (!name.trim() || typeof command !== "string" || !command.trim()) return undefined;
		parsed.push({ name, command });
	}
	return parsed.length > 0 ? parsed : undefined;
}

/** Validate a persisted `gauntlet-state` session entry. Anything off is dropped. */
export function parseStateEntry(data: unknown): GauntletState | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const candidate = data as Partial<GauntletState>;
	if (typeof candidate.active !== "boolean" || typeof candidate.iteration !== "number") return undefined;
	if (!Array.isArray(candidate.checks)) return undefined;
	for (const check of candidate.checks) {
		if (typeof check?.name !== "string" || typeof check?.command !== "string") return undefined;
	}
	return {
		goal: typeof candidate.goal === "string" ? candidate.goal : undefined,
		active: candidate.active,
		iteration: candidate.iteration,
		checks: candidate.checks,
		results: typeof candidate.results === "object" && candidate.results !== null ? candidate.results : {},
	};
}
