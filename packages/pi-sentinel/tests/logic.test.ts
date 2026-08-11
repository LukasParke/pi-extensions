import { describe, expect, it } from "vitest";
import {
	evaluatePredicate,
	hashOutput,
	truncateOutput,
	updateGateState,
	validatePredicate,
} from "../src/index.ts";

const result = (stdout: string, exitCode: number | null = 0) => ({ stdout, stderr: "", exitCode });

describe("evaluatePredicate", () => {
	it("defaults to exit zero", () => {
		expect(evaluatePredicate(result("ok"))).toBe(true);
		expect(evaluatePredicate(result("no", 1))).toBe(false);
	});

	it("supports each explicit predicate", () => {
		expect(evaluatePredicate(result("bad", 3), { exit_code: 3 })).toBe(true);
		expect(evaluatePredicate(result("deploy ready", 1), { output_contains: "ready" })).toBe(true);
		expect(
			evaluatePredicate(result('{"checks":{"pending":0}}', 1), {
				output_json: { path: "checks.pending", equals: 0 },
			}),
		).toBe(true);
	});

	it("fails malformed JSON and missing paths", () => {
		expect(evaluatePredicate(result("not json"), { output_json: { path: "a", equals: 1 } })).toBe(false);
		expect(evaluatePredicate(result('{"a":1}'), { output_json: { path: "b", equals: 1 } })).toBe(false);
	});

	it("requires exactly one predicate", () => {
		expect(() => validatePredicate({})).toThrow("exactly one");
		expect(() => validatePredicate({ exit_code: 0, output_contains: "ok" })).toThrow("exactly one");
		expect(() => validatePredicate({ exit_code: 0 })).not.toThrow();
	});
});

describe("output helpers", () => {
	it("hashes deterministically", () => {
		expect(hashOutput("a")).toBe(hashOutput("a"));
		expect(hashOutput("a")).not.toBe(hashOutput("b"));
	});

	it("keeps the head and tail within the byte cap", () => {
		const output = `${"head".repeat(100)}${"🙂".repeat(100)}${"tail".repeat(100)}`;
		const truncated = truncateOutput(output, 120);
		expect(Buffer.byteLength(truncated)).toBeLessThanOrEqual(120);
		expect(truncated).toContain("head");
		expect(truncated).toContain("tail");
		expect(truncated).toContain("truncated");
		expect(truncated).not.toContain("�");
	});
});

describe("updateGateState", () => {
	it("tracks flips and resets the quiet window", () => {
		const first = updateGateState({ passes: {}, complete: false }, { ci: true, reviews: true }, 1_000, 600);
		expect(first.changes).toEqual([]);
		expect(first.state).toEqual({
			passes: { ci: true, reviews: true },
			passingSince: 1_000,
			complete: false,
		});

		const complete = updateGateState(first.state, { ci: true, reviews: true }, 1_600, 600);
		expect(complete.state.complete).toBe(true);

		const failed = updateGateState(complete.state, { ci: false, reviews: true }, 1_700, 600);
		expect(failed.changes).toEqual([{ name: "ci", from: true, to: false }]);
		expect(failed.state.passingSince).toBeUndefined();
		expect(failed.state.complete).toBe(false);
	});
});
