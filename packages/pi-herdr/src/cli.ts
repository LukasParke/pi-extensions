/**
 * Thin wrapper around the `herdr` CLI.
 *
 * Every herdr command prints a JSON envelope: `{ result }` on success,
 * `{ error: { code, message } }` on failure — but the process also exits
 * non-zero on API errors, so the envelope must be recovered from the thrown
 * exec error too.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

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
export function parseHerdrError(raw: string): HerdrError | undefined {
	const candidates = [
		...raw.split("\n").filter((line) => line.trimStart().startsWith("{")),
		// Fallback for pretty-printed (multi-line) envelopes.
		raw.match(/\{.*\}/s)?.[0],
	];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const envelope = JSON.parse(candidate);
			if (envelope && typeof envelope === "object" && envelope.error?.message) {
				return { code: envelope.error.code, message: envelope.error.message };
			}
		} catch {
			// Not an envelope; keep scanning.
		}
	}
	return undefined;
}

export function describeHerdrError(args: string[], error: HerdrError): string {
	const command = ["herdr", args[0], args[1]].filter(Boolean).join(" ");
	return error.code ? `${command}: ${error.code}: ${error.message}` : `${command}: ${error.message}`;
}

/** Run a herdr command and return the parsed `result` from its JSON envelope. */
export async function herdr(args: string[]): Promise<any> {
	let stdout: string;
	try {
		({ stdout } = await exec("herdr", args, { timeout: 120_000 }));
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			throw new Error("The `herdr` CLI is not installed or not on PATH. Install herdr to use this tool.");
		}
		// herdr exits non-zero on API errors but still prints the JSON envelope;
		// surface the structured code/message instead of "Command failed".
		const parsed = parseHerdrError(`${error?.stdout ?? ""}${error?.stderr ?? ""}`);
		if (parsed) throw new Error(describeHerdrError(args, parsed));
		throw error;
	}
	const envelope = JSON.parse(stdout);
	if (envelope.error) throw new Error(describeHerdrError(args, envelope.error));
	return envelope.result;
}

/** Raw text output from a herdr command that does not emit a JSON envelope. */
export async function herdrText(args: string[], signal?: AbortSignal): Promise<string> {
	const { stdout } = await exec("herdr", args, { timeout: 30_000, signal });
	return stdout;
}
