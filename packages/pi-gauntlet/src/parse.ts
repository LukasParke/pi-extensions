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
	if (typeof candidate.active !== "boolean") return undefined;
	if (!Number.isInteger(candidate.iteration) || (candidate.iteration as number) < 0) return undefined;
	if (!Array.isArray(candidate.checks)) return undefined;
	for (const check of candidate.checks) {
		if (typeof check?.name !== "string" || typeof check?.command !== "string") return undefined;
	}
	return {
		goal: typeof candidate.goal === "string" ? candidate.goal : undefined,
		active: candidate.active,
		iteration: candidate.iteration as number,
		checks: candidate.checks,
		results: parseResults(candidate.results),
	};
}

/** Keep only well-formed outcomes — a bad one would crash report rendering. */
function parseResults(results: unknown): GauntletState["results"] {
	if (typeof results !== "object" || results === null || Array.isArray(results)) return {};
	const parsed: GauntletState["results"] = {};
	for (const [name, outcome] of Object.entries(results)) {
		if (
			typeof outcome === "object" &&
			outcome !== null &&
			Number.isFinite((outcome as { code?: unknown }).code) &&
			typeof (outcome as { output?: unknown }).output === "string"
		) {
			parsed[name] = outcome as GauntletState["results"][string];
		}
	}
	return parsed;
}
