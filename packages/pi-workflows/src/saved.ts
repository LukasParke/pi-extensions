/**
 * Saved workflow definitions.
 *
 * Name-based resolution only — never accept arbitrary script paths from the
 * model. Project-local definitions load only when the project is trusted.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { WorkflowSize } from "./config.ts";
import { VALID_SIZES } from "./config.ts";

export interface SavedWorkflow {
	version: 1;
	name: string;
	description?: string;
	script: string;
	defaults?: {
		size?: WorkflowSize;
		/** When true, skip interactive approval for this saved workflow. */
		preApproved?: boolean;
	};
	/** Absolute path the definition was loaded from. */
	path: string;
	scope: "global" | "project";
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function isValidWorkflowName(name: string) {
	return NAME_RE.test(name);
}

export function globalDefinitionsDir(agentDir = getAgentDir()) {
	return path.join(agentDir, "workflows", "definitions");
}

export function projectDefinitionsDir(cwd: string) {
	return path.join(cwd, ".pi", "workflows");
}

function expandTilde(input: string) {
	return input.startsWith("~") ? path.join(os.homedir(), input.slice(1)) : input;
}

/**
 * Resolve a saved workflow by name. Project definitions win when the project
 * is trusted; otherwise only the global directory is searched.
 */
export async function resolveSavedWorkflow(options: {
	name: string;
	cwd: string;
	projectTrusted: boolean;
	agentDir?: string;
}): Promise<SavedWorkflow | undefined> {
	const name = options.name.trim();
	if (!isValidWorkflowName(name)) return undefined;

	const candidates: Array<{ dir: string; scope: "global" | "project" }> = [];
	if (options.projectTrusted) {
		candidates.push({ dir: projectDefinitionsDir(options.cwd), scope: "project" });
	}
	candidates.push({ dir: globalDefinitionsDir(options.agentDir), scope: "global" });

	for (const { dir, scope } of candidates) {
		const filePath = path.join(dir, `${name}.workflow.json`);
		// Reject path escape even if name somehow contained separators.
		if (path.dirname(path.resolve(filePath)) !== path.resolve(dir)) continue;
		const loaded = await readSavedFile(filePath, scope);
		if (loaded) return loaded;
	}
	return undefined;
}

export async function listSavedWorkflows(options: {
	cwd: string;
	projectTrusted: boolean;
	agentDir?: string;
}): Promise<SavedWorkflow[]> {
	const out: SavedWorkflow[] = [];
	const seen = new Set<string>();
	const dirs: Array<{ dir: string; scope: "global" | "project" }> = [];
	if (options.projectTrusted) dirs.push({ dir: projectDefinitionsDir(options.cwd), scope: "project" });
	dirs.push({ dir: globalDefinitionsDir(options.agentDir), scope: "global" });

	for (const { dir, scope } of dirs) {
		let names: string[];
		try {
			names = await fs.readdir(dir);
		} catch {
			continue;
		}
		for (const file of names) {
			if (!file.endsWith(".workflow.json")) continue;
			const loaded = await readSavedFile(path.join(dir, file), scope);
			if (!loaded || seen.has(loaded.name)) continue;
			seen.add(loaded.name);
			out.push(loaded);
		}
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveWorkflow(options: {
	name: string;
	script: string;
	description?: string;
	scope: "global" | "project";
	cwd: string;
	agentDir?: string;
	defaults?: SavedWorkflow["defaults"];
}): Promise<string> {
	if (!isValidWorkflowName(options.name)) {
		throw new Error(`Invalid workflow name "${options.name}" (use letters, digits, ._- ; max 64)`);
	}
	const dir =
		options.scope === "project" ? projectDefinitionsDir(options.cwd) : globalDefinitionsDir(options.agentDir);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const filePath = path.join(dir, `${options.name}.workflow.json`);
	const body = {
		version: 1 as const,
		name: options.name,
		...(options.description ? { description: options.description } : {}),
		script: options.script,
		...(options.defaults ? { defaults: options.defaults } : {}),
	};
	await fs.writeFile(filePath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
	return filePath;
}

async function readSavedFile(
	filePath: string,
	scope: "global" | "project",
): Promise<SavedWorkflow | undefined> {
	let raw: string;
	try {
		raw = await fs.readFile(expandTilde(filePath), "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const obj = parsed as Record<string, unknown>;
	if (obj.version !== 1) return undefined;
	if (typeof obj.name !== "string" || !isValidWorkflowName(obj.name)) return undefined;
	if (typeof obj.script !== "string" || !obj.script.trim()) return undefined;
	const defaults = parseDefaults(obj.defaults);
	return {
		version: 1,
		name: obj.name,
		description: typeof obj.description === "string" ? obj.description : undefined,
		script: obj.script,
		defaults,
		path: path.resolve(filePath),
		scope,
	};
}

function parseDefaults(value: unknown): SavedWorkflow["defaults"] | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	const size =
		typeof obj.size === "string" && VALID_SIZES.has(obj.size) ? (obj.size as WorkflowSize) : undefined;
	const preApproved = obj.preApproved === true ? true : undefined;
	if (!size && preApproved === undefined) return undefined;
	return {
		...(size ? { size } : {}),
		...(preApproved ? { preApproved: true } : {}),
	};
}
