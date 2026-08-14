import { describe, expect, it } from "vitest";
import { parseCheckArgs, parseSeedChecks, parseStateEntry } from "../src/parse.ts";

describe("parseCheckArgs", () => {
	it("splits the name from a multi-word command", () => {
		expect(parseCheckArgs("tests npm run test -- --run")).toEqual({
			name: "tests",
			command: "npm run test -- --run",
		});
	});

	it("rejects missing pieces", () => {
		expect(parseCheckArgs("tests")).toBeUndefined();
		expect(parseCheckArgs("")).toBeUndefined();
		expect(parseCheckArgs("   ")).toBeUndefined();
	});
});

describe("parseSeedChecks", () => {
	it("accepts the documented shape", () => {
		expect(parseSeedChecks({ checks: { tests: "npm test", lint: "npm run lint" } })).toEqual([
			{ name: "tests", command: "npm test" },
			{ name: "lint", command: "npm run lint" },
		]);
	});

	it("rejects malformed documents", () => {
		expect(parseSeedChecks(null)).toBeUndefined();
		expect(parseSeedChecks({})).toBeUndefined();
		expect(parseSeedChecks({ checks: [] })).toBeUndefined();
		expect(parseSeedChecks({ checks: {} })).toBeUndefined();
		expect(parseSeedChecks({ checks: { tests: 42 } })).toBeUndefined();
		expect(parseSeedChecks({ checks: { "": "npm test" } })).toBeUndefined();
	});
});

describe("parseStateEntry", () => {
	it("round-trips a persisted state", () => {
		const state = {
			goal: "g",
			active: true,
			iteration: 3,
			checks: [{ name: "tests", command: "npm test" }],
			results: { tests: { code: 0, output: "ok" } },
		};
		expect(parseStateEntry(state)).toEqual(state);
	});

	it("drops malformed entries", () => {
		expect(parseStateEntry(undefined)).toBeUndefined();
		expect(parseStateEntry({ active: "yes", iteration: 1, checks: [] })).toBeUndefined();
		expect(parseStateEntry({ active: true, iteration: 1, checks: [{ name: 1 }] })).toBeUndefined();
	});

	it("rejects non-integer or negative iterations", () => {
		expect(parseStateEntry({ active: true, iteration: -1, checks: [] })).toBeUndefined();
		expect(parseStateEntry({ active: true, iteration: Number.NaN, checks: [] })).toBeUndefined();
		expect(parseStateEntry({ active: true, iteration: 1.5, checks: [] })).toBeUndefined();
	});

	it("drops malformed result outcomes but keeps valid ones", () => {
		const parsed = parseStateEntry({
			active: true,
			iteration: 1,
			checks: [{ name: "tests", command: "npm test" }],
			results: {
				tests: { code: 0, output: "ok" },
				lint: "oops",
				types: { code: "2", output: "bad code" },
				build: { code: 1 },
			},
		});
		expect(parsed?.results).toEqual({ tests: { code: 0, output: "ok" } });
	});
});
