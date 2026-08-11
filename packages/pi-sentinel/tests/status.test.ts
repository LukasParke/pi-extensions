import { describe, expect, it } from "vitest";
import { sentinelStatus } from "../extensions/sentinel.ts";
import type { GateSnapshot, SentinelSnapshot } from "../src/manager.ts";

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
	});
});
