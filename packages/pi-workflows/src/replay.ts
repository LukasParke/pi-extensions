/**
 * Contiguous-prefix deterministic replay.
 *
 * On resume the script restarts from the top. Each agent() call is matched by
 * sequential request id + request hash against the journal. Cached results are
 * returned only for the contiguous completed prefix; the first mismatch or gap
 * forces live execution for that call and every subsequent call.
 */

import type { AgentJournalEntry, AgentRunResult } from "./journal.ts";
import { contiguousCompletedPrefix } from "./journal.ts";

export interface ReplayCursor {
	/** Next request id the sandbox will allocate (1-based). */
	nextId: number;
	/** Cached results keyed by request id for the contiguous prefix only. */
	cached: Map<number, { requestHash: string; result: AgentRunResult; entry: AgentJournalEntry }>;
	/** Once live execution begins, never return cache again. */
	live: boolean;
}

export function createReplayCursor(entries: AgentJournalEntry[]): ReplayCursor {
	const prefix = contiguousCompletedPrefix(entries);
	const cached = new Map<number, { requestHash: string; result: AgentRunResult; entry: AgentJournalEntry }>();
	for (const entry of prefix) {
		if (!entry.result) continue;
		cached.set(entry.requestId, {
			requestHash: entry.requestHash,
			result: entry.result,
			entry,
		});
	}
	return { nextId: 1, cached, live: false };
}

/**
 * Try to satisfy an agent request from the replay cache.
 * Returns the cached result when this is the next expected id with a matching
 * hash and we have not yet gone live; otherwise undefined (caller must execute).
 */
export function takeReplayResult(
	cursor: ReplayCursor,
	requestId: number,
	requestHash: string,
): AgentRunResult | undefined {
	if (cursor.live) return undefined;
	if (requestId !== cursor.nextId) {
		// Out-of-order or gap — abandon cache for the rest of the run.
		cursor.live = true;
		return undefined;
	}
	const hit = cursor.cached.get(requestId);
	if (!hit || hit.requestHash !== requestHash) {
		cursor.live = true;
		cursor.nextId = requestId + 1;
		return undefined;
	}
	cursor.nextId = requestId + 1;
	// If this was the last cached entry, subsequent calls are live.
	if (!cursor.cached.has(cursor.nextId)) cursor.live = true;
	return hit.result;
}

export function markLive(cursor: ReplayCursor) {
	cursor.live = true;
}
