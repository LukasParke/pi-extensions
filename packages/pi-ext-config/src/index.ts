/**
 * Shared configuration loader for pi extensions.
 *
 * Every extension in this monorepo needs the same thing: typed settings that
 * resolve `defaults ← config file ← environment`, tolerate a malformed file,
 * and never let a bad value through. This is that, once.
 *
 * Design notes:
 *
 * - **Validators return `undefined`, not throw.** A user with a typo in one
 *   field gets defaults for that field and a working extension, rather than an
 *   extension that fails to load. Silent degradation beats a broken startup for
 *   optional config.
 * - **Env wins over file.** Env vars are the per-shell override; the file is
 *   the durable preference. This matches pi's own precedence.
 * - **Config lives in the agent config dir, not a hardcoded `~/.pi`.** Pi can
 *   be rebranded with a different `configDir`, so the path is derived from
 *   `CONFIG_DIR_NAME` at runtime.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** A validator maps unknown input to a valid value, or `undefined` to fall through. */
export type Validator<T> = (value: unknown) => T | undefined;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Directory holding pi's user config, e.g. `~/.pi`.
 *
 * Resolved from the host's `CONFIG_DIR_NAME` when available so rebranded
 * distributions work, falling back to `.pi`.
 *
 * `PI_CODING_AGENT_DIR` overrides pi's *agent* dir (default `~/.pi/agent`), so
 * its parent is the config dir extension config files live beside. Verified
 * against pi's own `ENV_AGENT_DIR`; do not guess this variable's name.
 */
export function piAgentDir(configDirName = ".pi"): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
	return fromEnv ? path.resolve(expandTilde(fromEnv)) : path.join(os.homedir(), configDirName, "agent");
}

export function piConfigDir(configDirName = ".pi"): string {
	return path.dirname(piAgentDir(configDirName));
}

/** Path to a named extension config file, e.g. `~/.pi/steel.json`. */
export function configFilePath(name: string, configDirName = ".pi"): string {
	return path.join(piConfigDir(configDirName), `${name}.json`);
}

export function expandTilde(input: string): string {
	return input.startsWith("~") ? path.join(os.homedir(), input.slice(1)) : input;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** An absolute http(s) URL with any trailing slashes removed. */
export function httpUrl(value: unknown): string | undefined {
	const raw = nonEmptyString(value);
	if (!raw) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
	return raw.replace(/\/+$/, "");
}

export function number(min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): Validator<number> {
	return (value) => {
		const parsed = typeof value === "string" ? Number(value) : value;
		return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= min && parsed <= max
			? parsed
			: undefined;
	};
}

export function boolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	// Env vars are strings; accept the conventional spellings only.
	if (value === "true" || value === "1") return true;
	if (value === "false" || value === "0") return false;
	return undefined;
}

export function oneOf<const T extends readonly string[]>(allowed: T): Validator<T[number]> {
	return (value) =>
		typeof value === "string" && (allowed as readonly string[]).includes(value)
			? (value as T[number])
			: undefined;
}

/** An absolute or `~`-relative filesystem path. */
export function filePath(value: unknown): string | undefined {
	const raw = nonEmptyString(value);
	return raw ? path.resolve(expandTilde(raw)) : undefined;
}

export function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.map(nonEmptyString).filter((v): v is string => v !== undefined);
	return items.length ? items : undefined;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Per-field description: how to validate it, and which env var supplies it.
 * `env` is optional — some settings are file-only.
 */
export type FieldSpec<T> = { validate: Validator<T>; env?: string };

export type Schema<C> = { [K in keyof C]-?: FieldSpec<NonNullable<C[K]>> };

function prune<T extends object>(value: Partial<T>): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Keep only recognized, well-formed keys. Unknown keys and bad values drop out. */
export function sanitize<C extends object>(schema: Schema<C>, raw: unknown): Partial<C> {
	if (!raw || typeof raw !== "object") return {};
	const input = raw as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, spec] of Object.entries(schema) as [string, FieldSpec<unknown>][]) {
		if (!(key in input)) continue;
		const value = spec.validate(input[key]);
		if (value !== undefined) out[key] = value;
	}
	return out as Partial<C>;
}

/** Read the env vars named by the schema. */
export function fromEnv<C extends object>(
	schema: Schema<C>,
	env: NodeJS.ProcessEnv = process.env,
): Partial<C> {
	const out: Record<string, unknown> = {};
	for (const [key, spec] of Object.entries(schema) as [string, FieldSpec<unknown>][]) {
		if (!spec.env) continue;
		const value = spec.validate(env[spec.env]);
		if (value !== undefined) out[key] = value;
	}
	return out as Partial<C>;
}

/** defaults ← file ← env. Pure; suitable for tests. */
export function resolve<C extends object>(
	schema: Schema<C>,
	defaults: C,
	fileOverrides: Partial<C> = {},
	env: NodeJS.ProcessEnv = process.env,
): C {
	return { ...defaults, ...prune(fileOverrides), ...fromEnv(schema, env) };
}

/** Read + sanitize the optional config file. Missing or invalid files yield {}. */
export async function readFile<C extends object>(schema: Schema<C>, file: string): Promise<Partial<C>> {
	try {
		return sanitize(schema, JSON.parse(await fs.readFile(file, "utf8")));
	} catch {
		return {};
	}
}

/**
 * The whole pipeline: read `<configDir>/<name>.json`, layer env over it, return
 * a fully-resolved config plus the path consulted (useful in error messages).
 */
export async function load<C extends object>(options: {
	name: string;
	schema: Schema<C>;
	defaults: C;
	configDirName?: string;
	env?: NodeJS.ProcessEnv;
}): Promise<{ config: C; file: string }> {
	const file = configFilePath(options.name, options.configDirName);
	const fileOverrides = await readFile(options.schema, file);
	return { config: resolve(options.schema, options.defaults, fileOverrides, options.env), file };
}

/** Render a schema's env vars as a markdown table row set, for README generation. */
export function describeEnv<C extends object>(schema: Schema<C>): { field: string; env: string }[] {
	return (Object.entries(schema) as [string, FieldSpec<unknown>][])
		.filter(([, spec]) => spec.env)
		.map(([field, spec]) => ({ field, env: spec.env as string }));
}
