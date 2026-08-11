import { describe, expect, it } from "vitest";
import type { AgentJournalEntry } from "../src/journal.ts";
import { contiguousCompletedPrefix } from "../src/journal.ts";
import { createReplayCursor, takeReplayResult } from "../src/replay.ts";

function entry(
	id: number,
	status: AgentJournalEntry["status"],
	hash = `h${id}`,
	ok = true,
): AgentJournalEntry {
	return {
		kind: "agent",
		requestId: id,
		requestHash: hash,
		label: `a${id}`,
		status,
		startedAt: id,
		endedAt: status === "started" ? undefined : id + 1,
		result:
			status === "started"
				? undefined
				: {
						ok,
						output: `out${id}`,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, contextTokens: 0 },
					},
	};
}

describe("contiguousCompletedPrefix", () => {
	it("stops at the first incomplete request", () => {
		const prefix = contiguousCompletedPrefix([
			entry(1, "completed"),
			entry(2, "completed"),
			entry(3, "started"),
			entry(4, "completed"),
		]);
		expect(prefix.map((e) => e.requestId)).toEqual([1, 2]);
	});
});

describe("replay cursor", () => {
	it("returns cached results for matching contiguous prefix only", () => {
		const cursor = createReplayCursor([entry(1, "completed"), entry(2, "completed")]);
		expect(takeReplayResult(cursor, 1, "h1")?.output).toBe("out1");
		expect(takeReplayResult(cursor, 2, "h2")?.output).toBe("out2");
		// Beyond prefix → live
		expect(takeReplayResult(cursor, 3, "h3")).toBeUndefined();
		expect(cursor.live).toBe(true);
	});

	it("goes live on hash mismatch and never returns later cache", () => {
		const cursor = createReplayCursor([entry(1, "completed"), entry(2, "completed")]);
		expect(takeReplayResult(cursor, 1, "WRONG")).toBeUndefined();
		expect(cursor.live).toBe(true);
		expect(takeReplayResult(cursor, 2, "h2")).toBeUndefined();
	});
});
