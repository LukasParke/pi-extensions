import { describe, expect, it } from "vitest";
import { eventPriority, sentinelStatus } from "../extensions/sentinel.ts";
import type { GateSnapshot, SentinelEvent, SentinelSnapshot } from "../src/manager.ts";

const watch: SentinelSnapshot = {
	name: "ci",
	kind: "watch",
	state: "waiting",
	createdAt: 0,
};
const gate: GateSnapshot = {
	active: true,
	complete: false,
	quietForMs: 0,
	criteria: [
		{ name: "ci", state: "passing" },
		{ name: "reviews", state: "failing" },
	],
};

describe("sentinelStatus", () => {
	it("summarizes active work and clears when empty", () => {
		expect(sentinelStatus([])).toBeUndefined();
		expect(sentinelStatus([watch], gate)).toBe("◉ 1 watch, gate 1/2");
		expect(sentinelStatus([{ ...watch, kind: "sleep" }])).toBe("◉ 1 sleep");
		expect(sentinelStatus([{ ...watch, kind: "pr" }])).toBe("◉ 1 PR");
	});
});

function event(details: Record<string, unknown>): SentinelEvent {
	return { id: "e", source: "src", urgency: "wake", message: "m", details };
}

describe("eventPriority", () => {
	it("escalates only on gate ALL PASS", () => {
		expect(eventPriority(event({ status: "all_pass" }))).toBe("escalation");
	});

	it("maps completion-ish events to completion", () => {
		expect(eventPriority(event({ status: "complete" }))).toBe("completion");
		expect(eventPriority(event({ status: "elapsed" }))).toBe("completion");
		expect(eventPriority(event({ type: "merged" }))).toBe("completion");
		expect(eventPriority(event({ type: "closed" }))).toBe("completion");
	});

	it("maps everything else to info", () => {
		expect(eventPriority(event({ status: "changed" }))).toBe("info");
		expect(eventPriority(event({ status: "failed" }))).toBe("info");
		expect(eventPriority(event({ status: "timeout" }))).toBe("info");
		expect(eventPriority(event({ type: "conflicts" }))).toBe("info");
		expect(eventPriority(event({ type: "ci_failure" }))).toBe("info");
		expect(eventPriority(event({ type: "review_feedback" }))).toBe("info");
	});
});
