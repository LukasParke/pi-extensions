import { describe, expect, it } from "vitest";
import type { GauntletState } from "../src/loop.ts";
import { checkListText, failureReport, statusText, widgetLines } from "../src/report.ts";

function state(overrides: Partial<GauntletState> = {}): GauntletState {
	return {
		goal: "make CI green",
		active: true,
		iteration: 2,
		checks: [
			{ name: "tests", command: "npm test" },
			{ name: "lint", command: "npm run lint" },
			{ name: "types", command: "tsc --noEmit" },
		],
		results: {
			tests: { code: 0, output: "ok" },
			lint: { code: 2, output: "eslint error" },
		},
		...overrides,
	};
}

describe("failureReport", () => {
	it("names the goal, iteration, and each failing check with its output tail", () => {
		const s = state();
		const report = failureReport(s, [s.checks[1]!], 10);

		expect(report).toContain("iteration 2/10");
		expect(report).toContain("make CI green");
		expect(report).toContain("✗ lint (exit 2) — `npm run lint`");
		expect(report).toContain("eslint error");
		expect(report).toContain("Keep working toward the goal");
	});
});

describe("widgetLines", () => {
	it("shows ✓/✗/· per check and truncates the goal to one line", () => {
		const s = state({ goal: "a very long goal\nthat spans\nlines " + "x".repeat(100) });
		const lines = widgetLines(s, 10);

		expect(lines[0]).toMatch(/^Goal: .{1,81}$/);
		expect(lines[0]).not.toContain("\n");
		expect(lines[1]).toBe("iteration 2/10");
		expect(lines[2]).toBe("✓ tests  ✗ lint  · types");
	});
});

describe("statusText / checkListText", () => {
	it("summarizes goal, loop state, and per-check status", () => {
		const text = statusText(state(), 10);
		expect(text).toContain("Goal: make CI green");
		expect(text).toContain("active — iteration 2/10");
		expect(text).toContain("✓ tests — passing");
		expect(text).toContain("✗ lint — failing (exit 2)");
		expect(text).toContain("· types — not run");
	});

	it("checkListText handles the empty case", () => {
		expect(checkListText(state({ checks: [], results: {} }))).toContain("No gauntlet checks defined");
	});
});
