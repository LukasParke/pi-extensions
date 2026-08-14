/**
 * Append-only JSONL error log with size-based rotation and a tolerant reader.
 * Writers never throw: a logging failure must not break tool execution.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ErrorLogEntry {
	/** ISO timestamp. */
	ts: string;
	/** Session file path, when the session is persisted. */
	session?: string;
	cwd: string;
	kind: "tool" | "extension";
	tool?: string;
	toolCallId?: string;
	/** Sanitized, serialized args (see redact.ts). */
	args?: string;
	error: { message: string; stack?: string };
	model?: { provider: string; id: string };
}

/** Append one entry, rotating to `<file>.1` first when the file exceeds maxBytes. */
export async function appendError(filePath: string, maxBytes: number, entry: ErrorLogEntry): Promise<void> {
	try {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		const size = await fs.stat(filePath).then(
			(s) => s.size,
			() => 0,
		);
		if (size > maxBytes) {
			await fs.rename(filePath, `${filePath}.1`).catch(() => {});
		}
		await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
	} catch {
		// Logging must never break tool execution.
	}
}

/** Read all parseable entries, oldest first. Corrupt or partial lines are skipped. */
export async function readErrors(filePath: string): Promise<ErrorLogEntry[]> {
	let raw: string;
	try {
		raw = await fs.readFile(filePath, "utf8");
	} catch {
		return [];
	}
	const entries: ErrorLogEntry[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as ErrorLogEntry;
			if (parsed && typeof parsed.ts === "string" && parsed.error) entries.push(parsed);
		} catch {
			// skip corrupt/partial line
		}
	}
	return entries;
}

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i;
const UNIT_MS: Record<string, number> = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

/**
 * Parse a `since` filter into an epoch-ms cutoff. Accepts an ISO timestamp or
 * a duration like "30m", "2h", "1d" (relative to `now`). Returns undefined
 * when the input is empty or unparseable.
 */
export function parseSince(since: string | undefined, now = Date.now()): number | undefined {
	if (!since) return undefined;
	const input = since.trim();
	if (!input) return undefined;
	const duration = DURATION.exec(input);
	if (duration) {
		const amount = Number(duration[1]);
		const unit = UNIT_MS[duration[2]!.toLowerCase()]!;
		return now - amount * unit;
	}
	const parsed = Date.parse(input);
	return Number.isNaN(parsed) ? undefined : parsed;
}

export interface ErrorFilter {
	tool?: string;
	kind?: string;
	since?: string;
	limit?: number;
	now?: number;
}

/** Newest-first entries matching the filter. */
export function filterErrors(entries: ErrorLogEntry[], filter: ErrorFilter): ErrorLogEntry[] {
	const cutoff = parseSince(filter.since, filter.now);
	const limit = filter.limit ?? 20;
	const out: ErrorLogEntry[] = [];
	for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
		const entry = entries[i]!;
		if (filter.tool && entry.tool !== filter.tool) continue;
		if (filter.kind && entry.kind !== filter.kind) continue;
		if (cutoff !== undefined) {
			const ts = Date.parse(entry.ts);
			if (Number.isNaN(ts) || ts < cutoff) continue;
		}
		out.push(entry);
	}
	return out;
}
