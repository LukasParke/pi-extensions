import { describe, expect, it } from "vitest";
import { MAX_CANDIDATES_PER_TURN, parseCandidates, turnDigest } from "../src/extract/extract.ts";

/**
 * Extraction (R-8.6, AC-8.8).
 *
 * The model proposes and this decides. Every rule exists because the alternative pollutes the store —
 * and a polluted store is worse than an empty one: recall returns noise, the user stops trusting it, and
 * the feature is dead.
 */

describe("parsing what a model actually returns", () => {
	it("accepts a clean array", () => {
		const r = parseCandidates('[{"text":"Luke prefers tabs","scope":"global"}]');
		expect(r.candidates).toEqual([{ text: "Luke prefers tabs", scope: "global" }]);
		expect(r.rejected).toEqual([]);
	});

	it("tolerates a markdown fence, which the prompt forbids and models produce anyway", () => {
		/**
		 * Tolerant of FORMATTING, never of meaning. Discarding a whole turn's learning because a model wrapped
		 * its answer in backticks would be a self-inflicted wound.
		 */
		const r = parseCandidates('```json\n[{"text":"the api is in packages/core","scope":"project"}]\n```');
		expect(r.candidates).toHaveLength(1);
	});

	it("tolerates prose before and after the array", () => {
		const r = parseCandidates(
			'Here are the durable facts:\n[{"text":"tests run with pnpm","scope":"project"}]\nThat is all.',
		);
		expect(r.candidates).toHaveLength(1);
	});

	it("AC-8.8 an empty array is SUCCESS, not a failure", () => {
		// Quiet turns are the common case. Treating [] as an error would make every ordinary turn log a fault.
		expect(parseCandidates("[]").candidates).toEqual([]);
		expect(parseCandidates("[]").rejected).toEqual([]);
	});

	it("AC-8.8 non-JSON and non-array responses are rejected with a reason", () => {
		for (const bad of ["not json at all", '{"text":"an object not an array"}', "", "   "]) {
			const r = parseCandidates(bad);
			expect(r.candidates, bad).toEqual([]);
			expect(r.rejected.length, bad).toBeGreaterThan(0);
		}
	});

	it("AC-8.8 rejects items over the length cap, empty, or the wrong shape", () => {
		const r = parseCandidates(
			JSON.stringify([
				{ text: "x".repeat(281), scope: "global" },
				{ text: "", scope: "global" },
				{ text: "   ", scope: "global" },
				{ text: 42, scope: "global" },
				{ text: "valid but bad scope", scope: "everywhere" },
				{ text: "no scope at all" },
				null,
				"a bare string",
				{ text: "the one good fact", scope: "global" },
			]),
		);
		expect(r.candidates).toEqual([{ text: "the one good fact", scope: "global" }]);
		expect(r.rejected).toHaveLength(8);
		// The reasons are specific, so a failing extraction is diagnosable.
		expect(r.rejected.map((x) => x.reason)).toContain("scope must be global or project");
		expect(r.rejected.some((x) => x.reason.includes("limit"))).toBe(true);
	});

	it("AC-8.8 rejects transient state, which is worthless tomorrow", () => {
		/**
		 * "the build is running" in a memory store makes recall useless within the hour. The pattern list is
		 * deliberately SHORT: a long heuristic would reject real facts — "the api is deprecated" contains "is"
		 * and is perfectly durable — so only unambiguous cases are caught and the rest is left to the prompt.
		 */
		const r = parseCandidates(
			JSON.stringify([
				{ text: "I will refactor the parser next", scope: "project" },
				{ text: "I'll add tests after this", scope: "project" },
				{ text: "the test suite is running now", scope: "project" },
				{ text: "the api is deprecated in v3", scope: "project" },
			]),
		);
		// The durable one survives; the three transient ones do not.
		expect(r.candidates).toEqual([{ text: "the api is deprecated in v3", scope: "project" }]);
	});

	it("AC-8.8 rejects descriptions of the conversation rather than facts from it", () => {
		// "The user asked me to…" is a summary of the turn, not knowledge gained in it.
		const r = parseCandidates(
			JSON.stringify([
				{ text: "The user asked me to fix the login bug", scope: "project" },
				{ text: "we discussed the caching strategy", scope: "project" },
				{ text: "login uses a JWT stored in an httpOnly cookie", scope: "project" },
			]),
		);
		expect(r.candidates).toHaveLength(1);
		expect(r.candidates[0]?.text).toContain("JWT");
	});

	it("AC-8.8 caps at five SURVIVORS, not five inputs", () => {
		/**
		 * The distinction matters: a model returning eight candidates of which the first three are junk should
		 * still yield five good ones. Capping the input would silently discard real facts because bad ones came
		 * first.
		 */
		const items = [
			{ text: "", scope: "global" },
			{ text: "I will do something", scope: "global" },
			{ text: "x".repeat(400), scope: "global" },
			...Array.from({ length: 7 }, (_, i) => ({
				text: `durable fact ${String(i)}`,
				scope: "global",
			})),
		];
		const r = parseCandidates(JSON.stringify(items));
		expect(r.candidates).toHaveLength(MAX_CANDIDATES_PER_TURN);
		expect(r.candidates.every((c) => c.text.startsWith("durable fact"))).toBe(true);
	});

	it("no catastrophic backtracking on a hostile response", () => {
		// Model output is external input, and this codebase has shipped two production ReDoS bugs.
		const hostile = `[${'{"text":"'.repeat(5000)}`;
		const t0 = performance.now();
		parseCandidates(hostile);
		parseCandidates("```".repeat(10_000));
		expect(performance.now() - t0).toBeLessThan(200);
	});
});

describe("turnDigest", () => {
	it("includes tool NAMES but not their arguments", () => {
		/**
		 * Names say what the turn was about — "read, edit, bash" is a code change — without the arguments,
		 * which are usually paths and sometimes secrets.
		 */
		const d = turnDigest({
			userText: "fix the login bug",
			assistantText: "Fixed the JWT expiry check.",
			toolNames: ["read", "edit", "read", "bash"],
			projectName: "Circle",
		});
		expect(d).toContain("Project: Circle");
		expect(d).toContain("fix the login bug");
		expect(d).toContain("Tools used: read, edit, bash");
		// Deduplicated, so a turn with forty reads does not produce forty entries.
		expect(d.match(/read/g)).toHaveLength(1);
	});

	it("truncates hard, because the point is what was LEARNED", () => {
		// A 40-message transcript makes the model summarise instead of extract.
		const d = turnDigest({
			userText: "x".repeat(5000),
			assistantText: "y".repeat(9000),
			toolNames: [],
		});
		expect(d.length).toBeLessThan(5000);
	});

	it("omits the project line when there is no project", () => {
		const d = turnDigest({ userText: "a", assistantText: "b", toolNames: [] });
		expect(d).not.toContain("Project:");
	});
});

describe("extraction failure never breaks a turn (AC-8.36)", () => {
	it("AC-8.36 a model error or timeout yields no candidates and no partial writes", () => {
		/**
		 * Extraction is background work on a turn that has already succeeded. A failure must therefore be
		 * silent: the user got their answer, and a red banner about a memory pass they never asked for would be
		 * noise about something they cannot act on.
		 *
		 * The engine's contribution is that `parseCandidates` never throws — every failure mode returns an empty
		 * candidate list with a reason, so a caller cannot accidentally write half a turn's facts.
		 */
		const failures = [
			"", // timeout produced nothing
			"I apologize, but I cannot complete this request.", // a refusal
			'{"error": "rate limited"}', // an error object
			'[{"text":', // truncated mid-stream
			"null",
			"undefined",
			"[[[[[[[[[[", // malformed nesting
		];

		for (const raw of failures) {
			const r = parseCandidates(raw);
			expect(r.candidates, JSON.stringify(raw)).toEqual([]);
			// A reason is always available for a log line, so a silent failure is still diagnosable.
			expect(r.rejected.length, JSON.stringify(raw)).toBeGreaterThan(0);
		}
	});

	it("AC-8.36 a PARTIALLY valid response yields only the valid part", () => {
		/**
		 * The subtler failure: a model that returns three good facts and then breaks. Discarding all three would
		 * lose real learning over a formatting error, and writing the broken one would store junk.
		 */
		const r = parseCandidates(
			'[{"text":"the first fact","scope":"global"},{"text":"the second fact","scope":"global"},{"bad":"shape"}]',
		);
		expect(r.candidates.map((c) => c.text)).toEqual(["the first fact", "the second fact"]);
		expect(r.rejected).toHaveLength(1);
	});
});
