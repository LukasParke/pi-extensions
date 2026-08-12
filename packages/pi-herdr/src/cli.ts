/**
 * Thin wrapper around the `herdr` CLI.
 *
 * Every herdr command prints a JSON envelope: `{ result }` on success,
 * `{ error: { code, message } }` on failure — but the process also exits
 * non-zero on API errors, so the envelope must be recovered from the thrown
 * exec error too.
 */

import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { promisify } from "node:util";
import { defaultConfig, herdrConfig } from "./config.ts";

const execFileAsync = promisify(execFile);

export interface HerdrError {
	code?: string;
	message: string;
}

/**
 * Pull a herdr error envelope out of raw CLI output, if one is present.
 *
 * The output may contain several JSON objects (progress lines before the
 * envelope), so each candidate is parsed individually rather than one greedy
 * first-`{`-to-last-`}` span.
 */
function jsonObjects(raw: string): string[] {
	const objects: string[] = [];
	let start = -1;
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let i = 0; i < raw.length; i++) {
		const char = raw[i];
		if (quoted) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
			continue;
		}
		if (char === '"') quoted = true;
		else if (char === "{") {
			if (depth++ === 0) start = i;
		} else if (char === "}" && depth > 0 && --depth === 0 && start >= 0) {
			objects.push(raw.slice(start, i + 1));
			start = -1;
		}
	}
	return objects;
}

export function parseHerdrError(raw: string): HerdrError | undefined {
	const candidates = jsonObjects(raw);
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const envelope = JSON.parse(candidate);
			if (envelope && typeof envelope === "object" && envelope.error?.message) {
				return { code: envelope.error.code, message: envelope.error.message };
			}
		} catch {
			// Not a structured Herdr envelope; keep scanning.
		}
	}
	return undefined;
}

export function describeHerdrError(args: string[], error: HerdrError): string {
	const command = ["herdr", args[0], args[1]].filter(Boolean).join(" ");
	return error.code ? `${command}: ${error.code}: ${error.message}` : `${command}: ${error.message}`;
}

type ExecResult = { stdout: string };
type HerdrExec = (
	file: string,
	args: string[],
	options: { timeout: number; signal?: AbortSignal },
) => Promise<ExecResult>;
type AppendLog = (path: string, data: string) => void;

export interface HerdrRunOptions {
	exec?: HerdrExec;
	appendLog?: AppendLog;
	logPath?: string;
	now?: () => number;
}

function taskArgs(args: string[]) {
	if (args[0] === "agent" && args[1] === "prompt") return args.slice(3, 4).filter(Boolean);
	if (args[0] === "agent" && args[1] === "start") {
		const separator = args.indexOf("--");
		if (separator >= 0) return args.slice(separator + 1).filter(Boolean);
	}
	return [];
}

function redactTask(args: string[]) {
	const redacted = [...args];
	if (args[0] === "agent" && args[1] === "prompt" && args.length > 3) redacted[3] = "[redacted]";
	if (args[0] === "agent" && args[1] === "start") {
		const separator = args.indexOf("--");
		if (separator >= 0) redacted.fill("[redacted]", separator + 1);
	}
	return redacted;
}

function logInvocation(
	path: string,
	appendLog: AppendLog,
	entry: { args: string[]; outcome: "ok" | "error"; error?: string; ms: number },
) {
	try {
		const error = taskArgs(entry.args).reduce(
			(message, task) => message?.replaceAll(task, "[redacted]"),
			entry.error,
		);
		appendLog(
			path,
			`${JSON.stringify({ ts: new Date().toISOString(), ...entry, args: redactTask(entry.args), error })}\n`,
		);
	} catch {
		// Diagnostics must never change command behavior.
	}
}

/** Run and log a herdr command, returning the parsed `result` from its JSON envelope. */
export async function runHerdr(args: string[], options: HerdrRunOptions = {}) {
	const exec = options.exec ?? (execFileAsync as unknown as HerdrExec);
	const appendLog = options.appendLog ?? appendFileSync;
	const now = options.now ?? Date.now;
	const startedAt = now();
	try {
		let stdout: string;
		try {
			({ stdout } = await exec("herdr", args, { timeout: 120_000 }));
		} catch (error: any) {
			if (error?.code === "ENOENT") {
				throw new Error("The `herdr` CLI is not installed or not on PATH. Install herdr to use this tool.");
			}
			const parsed = parseHerdrError(`${error?.stdout ?? ""}${error?.stderr ?? ""}`);
			if (parsed) throw new Error(describeHerdrError(args, parsed));
			throw error;
		}
		const envelope = JSON.parse(stdout);
		if (envelope.error) throw new Error(describeHerdrError(args, envelope.error));
		logInvocation(options.logPath ?? defaultConfig.logPath, appendLog, {
			args,
			outcome: "ok",
			ms: now() - startedAt,
		});
		return envelope.result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logInvocation(options.logPath ?? defaultConfig.logPath, appendLog, {
			args,
			outcome: "error",
			error: message,
			ms: now() - startedAt,
		});
		throw error;
	}
}

/** Run a herdr command using the configured invocation log. */
export async function herdr(args: string[]) {
	const config = await herdrConfig();
	return runHerdr(args, { logPath: config.logPath });
}

export interface HerdrTextOptions extends HerdrRunOptions {
	signal?: AbortSignal;
}

/** Raw text output from a herdr command that does not emit a JSON envelope. */
export async function runHerdrText(args: string[], options: HerdrTextOptions = {}) {
	const exec = options.exec ?? (execFileAsync as unknown as HerdrExec);
	const appendLog = options.appendLog ?? appendFileSync;
	const now = options.now ?? Date.now;
	const startedAt = now();
	try {
		const { stdout } = await exec("herdr", args, { timeout: 30_000, signal: options.signal });
		logInvocation(options.logPath ?? defaultConfig.logPath, appendLog, {
			args,
			outcome: "ok",
			ms: now() - startedAt,
		});
		return stdout;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logInvocation(options.logPath ?? defaultConfig.logPath, appendLog, {
			args,
			outcome: "error",
			error: message,
			ms: now() - startedAt,
		});
		throw error;
	}
}

export async function herdrText(args: string[], signal?: AbortSignal) {
	const config = await herdrConfig();
	return runHerdrText(args, { logPath: config.logPath, signal });
}
