import { describe, expect, it } from "vitest";
import {
	type ApiCheckRun,
	type ApiFile,
	type ApiIssue,
	type ApiPull,
	checkStatus,
	checksRollup,
	MAX_PATCH_BYTES,
	mergeability,
	pullState,
	type ReviewRow,
	reviewState,
	toCheckRow,
	toIssueRow,
	toPullFile,
} from "../src/viewmodel.ts";

/**
 * The view models.
 *
 * Pure functions over GitHub's shapes, which is why they get the most tests in the package: every one of them collapses
 * several API fields into one word a human reads, and a wrong collapse is a lie that renders confidently.
 */

const pull = (over: Partial<ApiPull> = {}): ApiPull => ({
	number: 1,
	title: "t",
	state: "open",
	updated_at: "2026-07-01T00:00:00Z",
	html_url: "https://github.com/o/r/pull/1",
	...over,
});

describe("pullState — one word from three fields", () => {
	it("merged outranks closed, and draft outranks open", () => {
		/**
		 * GitHub spreads this across `state`, `draft` and `merged_at`, so a reader has to combine three fields to learn the
		 * one thing they wanted. The precedence is the decision: a merged PR is `closed` in `state`, so checking `state` first
		 * would report every merged PR as closed and lose the distinction that matters most.
		 */
		expect(pullState(pull({ state: "closed", merged_at: "2026-07-02T00:00:00Z" }))).toBe("merged");
		expect(pullState(pull({ state: "closed" }))).toBe("closed");
		expect(pullState(pull({ draft: true }))).toBe("draft");
		expect(pullState(pull())).toBe("open");
	});

	it("a merged draft is merged, not draft", () => {
		// Rare but real: a draft can be merged by an admin. The terminal fact wins.
		expect(pullState(pull({ draft: true, merged_at: "2026-07-02T00:00:00Z" }))).toBe("merged");
	});
});

describe("mergeability — null means mergeable, not unknown-and-therefore-broken", () => {
	it("clean, unstable and has_hooks are all mergeable", () => {
		/**
		 * `unstable` means "mergeable, but a non-required check is failing". Reporting it as un-mergeable would tell a user
		 * their PR is blocked when GitHub's own button is green.
		 */
		for (const state of ["clean", "unstable", "has_hooks"]) {
			expect(mergeability(pull({ mergeable_state: state })), state).toBe(null);
		}
	});

	it("names each real blocker in words a user can act on", () => {
		expect(mergeability(pull({ mergeable_state: "dirty" }))).toContain("conflicts");
		expect(mergeability(pull({ mergeable_state: "blocked" }))).toContain("required review");
		expect(mergeability(pull({ mergeable_state: "behind" }))).toContain("behind");
		expect(mergeability(pull({ mergeable_state: "draft" }))).toContain("draft");
	});

	it("while GitHub is still computing, reports nothing rather than a failure", () => {
		/**
		 * `mergeable` is null for a few seconds after a push while GitHub computes the merge. Rendering that as "cannot merge"
		 * is a lie that makes people re-push to fix a problem that does not exist.
		 */
		expect(mergeability(pull({ mergeable: null }))).toBe(null);
		expect(mergeability(pull({ mergeable_state: "unknown" }))).toBe(null);
	});

	it("falls back to the boolean when mergeable_state is absent", () => {
		expect(mergeability(pull({ mergeable: false }))).toContain("conflicts");
	});

	it("an UNRECOGNISED state is reported, not swallowed", () => {
		/**
		 * GitHub can add a state. Silence would read as "mergeable", which is the dangerous direction to guess in, so the raw
		 * word is surfaced instead.
		 */
		const out = mergeability(pull({ mergeable_state: "some_new_thing" }));
		expect(out).toContain("some_new_thing");
	});
});

describe("checkStatus and the rollup", () => {
	const run = (over: Partial<ApiCheckRun>): ApiCheckRun => ({
		name: "n",
		status: "completed",
		...over,
	});

	it("an incomplete run is pending regardless of conclusion", () => {
		expect(checkStatus(run({ status: "in_progress", conclusion: null }))).toBe("pending");
		expect(checkStatus(run({ status: "queued" }))).toBe("pending");
	});

	it("timed_out and action_required are failures, not their own words", () => {
		// A user asking "is CI red?" needs one answer. Three synonyms for red make them read three rows to find out.
		expect(checkStatus(run({ conclusion: "timed_out" }))).toBe("failing");
		expect(checkStatus(run({ conclusion: "action_required" }))).toBe("failing");
		expect(checkStatus(run({ conclusion: "failure" }))).toBe("failing");
	});

	it("skipped, cancelled and neutral are distinct from failing", () => {
		expect(checkStatus(run({ conclusion: "skipped" }))).toBe("skipped");
		expect(checkStatus(run({ conclusion: "cancelled" }))).toBe("cancelled");
		expect(checkStatus(run({ conclusion: "neutral" }))).toBe("neutral");
	});

	it('the rollup answers "do I need to look?" — failing wins over everything', () => {
		const rows = [
			{ name: "a", status: "passing" },
			{ name: "b", status: "failing" },
			{ name: "c", status: "pending" },
		];
		expect(checksRollup(rows as never)).toBe("failing");
	});

	it("skipped and cancelled do NOT drag the rollup down", () => {
		/**
		 * A repository that skips a job on some paths would otherwise report red on every PR that skipped it — and a rollup
		 * that is always red is a rollup nobody reads.
		 */
		expect(
			checksRollup([
				{ name: "a", status: "passing" },
				{ name: "b", status: "skipped" },
			] as never),
		).toBe("passing");
		expect(
			checksRollup([
				{ name: "a", status: "passing" },
				{ name: "b", status: "cancelled" },
			] as never),
		).toBe("passing");
	});

	it('no checks is its own answer, not "passing"', () => {
		// "Passing" for a repo with no CI would tell a reviewer that something verified the change. Nothing did.
		expect(checksRollup([])).toBe("no checks");
	});

	it("a run of only skipped checks is not passing", () => {
		expect(checksRollup([{ name: "a", status: "skipped" }] as never)).toBe("no checks");
	});

	it("duration is computed only when both timestamps make sense", () => {
		const withTimes = toCheckRow(
			run({ started_at: "2026-07-01T00:00:00Z", completed_at: "2026-07-01T00:01:30Z" }),
		);
		expect(withTimes.durationSec).toBe(90);
		// A completed_at before started_at is nonsense; null beats a negative number.
		expect(
			toCheckRow(run({ started_at: "2026-07-01T00:01:00Z", completed_at: "2026-07-01T00:00:00Z" }))
				.durationSec,
		).toBe(null);
		expect(toCheckRow(run({})).durationSec).toBe(null);
	});
});

describe("reviewState — latest per author", () => {
	const review = (author: string, state: string, at: number): ReviewRow => ({
		author,
		state,
		body: "",
		at,
	});

	it("an author who requested changes and then approved counts as approved", () => {
		/**
		 * THE bug this function exists to prevent.
		 *
		 * GitHub returns every review ever submitted, so counting all of them reports "changes requested" forever — the PR
		 * looks blocked to everyone including the reviewer who unblocked it.
		 */
		const rows = [review("a", "changes requested", 100), review("a", "approved", 200)];
		expect(reviewState(rows, 0)).toBe("approved");
	});

	it("one blocking review from a DIFFERENT author still blocks", () => {
		const rows = [review("a", "approved", 200), review("b", "changes requested", 100)];
		expect(reviewState(rows, 0)).toBe("changes requested");
	});

	it("comments and dismissals do not count as review decisions", () => {
		// A "commented" review is not an opinion on merging, and a dismissed one has been explicitly retracted.
		expect(reviewState([review("a", "commented", 100)], 0)).toBe("no reviews");
		expect(reviewState([review("a", "dismissed", 100)], 0)).toBe("no reviews");
	});

	it('a pending requested reviewer is "review required"', () => {
		expect(reviewState([], 2)).toBe("review required");
		expect(reviewState([], 0)).toBe("no reviews");
	});

	it("equal timestamps do not lose a review", () => {
		// Two reviews in the same second is real; `>=` keeps the later-listed one rather than dropping both.
		const rows = [review("a", "changes requested", 100), review("a", "approved", 100)];
		expect(reviewState(rows, 0)).toBe("approved");
	});
});

describe("patches", () => {
	const file = (over: Partial<ApiFile> = {}): ApiFile => ({
		filename: "a.ts",
		status: "modified",
		additions: 1,
		deletions: 0,
		...over,
	});

	it("a missing patch says WHY it is missing", () => {
		/**
		 * GitHub omits `patch` for binaries and oversized files. Rendering that as an empty diff makes a reader believe
		 * nothing changed — so the reason travels with the row and every renderer states it.
		 */
		const f = toPullFile(file({ patch: null }));
		expect(f.patch).toBe(null);
		expect(f.patchOmitted).toContain("binary");
	});

	it("an oversized patch is omitted with its size, not truncated mid-hunk", () => {
		/**
		 * A truncated diff is worse than an absent one: it looks complete, and a reviewer can approve a change whose second
		 * half they never saw.
		 */
		const f = toPullFile(file({ patch: "x".repeat(MAX_PATCH_BYTES + 1) }));
		expect(f.patch).toBe(null);
		expect(f.patchOmitted).toContain("KB");
		expect(f.patchOmitted).toContain("too large");
	});

	it("a normal patch passes through intact", () => {
		const f = toPullFile(file({ patch: "@@ -1 +1 @@\n-a\n+b" }));
		expect(f.patch).toBe("@@ -1 +1 @@\n-a\n+b");
		expect(f.patchOmitted).toBe(null);
	});

	it("a rename carries its previous path", () => {
		const f = toPullFile(file({ status: "renamed", previous_filename: "old.ts", patch: "" }));
		expect(f.previousPath).toBe("old.ts");
	});
});

describe("issues", () => {
	const issue = (over: Partial<ApiIssue> = {}): ApiIssue => ({
		number: 5,
		title: "i",
		state: "open",
		updated_at: "2026-07-01T00:00:00Z",
		html_url: "u",
		...over,
	});

	it("labels arrive as objects or strings and both work", () => {
		// GitHub returns objects from /issues and strings from some search paths. A crash on one shape would be intermittent.
		expect(toIssueRow(issue({ labels: [{ name: "bug" }, "chore"] })).labels).toEqual(["bug", "chore"]);
	});

	it("a nameless label is dropped rather than rendered as an empty chip", () => {
		expect(toIssueRow(issue({ labels: [{}, { name: "ok" }] })).labels).toEqual(["ok"]);
	});

	it('a missing author is "unknown", never undefined', () => {
		// A deleted GitHub account leaves `user: null`. "undefined" rendered in a terminal is a bug report waiting to happen.
		expect(toIssueRow(issue({ user: null })).author).toBe("unknown");
	});

	it("an unparseable timestamp is 0, not NaN", () => {
		/**
		 * `Date.parse` returns NaN for junk, and NaN in a sort comparator makes the order non-deterministic — a list that
		 * shuffles between refreshes with no visible cause.
		 */
		expect(toIssueRow(issue({ updated_at: "not a date" })).updatedAt).toBe(0);
	});
});
