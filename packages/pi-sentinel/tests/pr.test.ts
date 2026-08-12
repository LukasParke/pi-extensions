import { describe, expect, it } from "vitest";
import { prEventId, prEvents, snapshotFromGraphQl, type PrSnapshot } from "../src/pr.ts";

const base = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
	repo: "openrouter/openrouter",
	number: 42,
	title: "Ship it",
	url: "https://github.com/openrouter/openrouter/pull/42",
	viewer: "agent",
	lifecycle: "open",
	headSha: "abc",
	merge: "clean",
	checks: "passing",
	failingChecks: [],
	reviewDecision: "approved",
	unresolvedThreads: 0,
	activities: [],
	...over,
});

describe("PR transitions", () => {
	it("emits actionable regressions and terminal changes", () => {
		expect(prEvents(base(), base({ merge: "conflicts" })).map((event) => event.type)).toEqual(["conflicts"]);
		expect(
			prEvents(base(), base({ checks: "failing", failingChecks: ["test"] })).map((event) => event.type),
		).toEqual(["ci_failure"]);
		expect(prEvents(base(), base({ lifecycle: "merged" })).map((event) => event.type)).toEqual(["merged"]);
	});

	it("detects new review comments but ignores the attached user's own activity", () => {
		const comment = { id: "comment:1", kind: "comment" as const, author: "reviewer" };
		const events = prEvents(base(), base({ activities: [comment] }));
		expect(events[0]?.type).toBe("review_feedback");
		expect(prEvents(base(), base({ activities: [{ ...comment, author: "agent" }] }))).toEqual([]);
	});

	it("does not loop while an actionable condition remains unchanged", () => {
		const red = base({ checks: "failing", failingChecks: ["test"] });
		expect(prEvents(red, red)).toEqual([]);
		const event = prEvents(base(), red)[0]!;
		expect(prEventId("pr-42", event)).toBe("pr:pr-42:ci:abc");
	});
});

describe("GitHub snapshot", () => {
	it("fails when GitHub returns errors, no PR, or no authenticated viewer", () => {
		const repo = { owner: "o", name: "r", slug: "o/r" };
		expect(() => snapshotFromGraphQl({ errors: [{ message: "denied" }] }, repo)).toThrow("denied");
		expect(() => snapshotFromGraphQl({ data: { viewer: { login: "agent" }, repository: {} } }, repo)).toThrow(
			"GitHub PR o/r was not found or the credential cannot see it",
		);
		expect(() =>
			snapshotFromGraphQl(
				{
					data: {
						repository: {
							pullRequest: {
								number: 42,
								title: "Ship it",
								url: "https://github.com/o/r/pull/42",
								state: "OPEN",
								isDraft: false,
								merged: false,
								headRefOid: "abc",
								mergeable: "MERGEABLE",
								mergeStateStatus: "CLEAN",
							},
						},
					},
				},
				repo,
			),
		).toThrow("GitHub GraphQL response did not include the authenticated viewer login");
	});

	it("maps GraphQL rollups and activity", () => {
		const snapshot = snapshotFromGraphQl(
			{
				data: {
					viewer: { login: "agent" },
					repository: {
						pullRequest: {
							number: 42,
							title: "Ship it",
							url: "https://github.com/o/r/pull/42",
							state: "OPEN",
							isDraft: false,
							merged: false,
							headRefOid: "abc",
							mergeable: "CONFLICTING",
							mergeStateStatus: "DIRTY",
							reviewDecision: "CHANGES_REQUESTED",
							reviews: { nodes: [{ id: "R1", state: "CHANGES_REQUESTED", author: { login: "luke" } }] },
							comments: { nodes: [{ id: "C1", author: { login: "luke" } }] },
							reviewThreads: {
								nodes: [
									{
										id: "T1",
										isResolved: false,
										comments: { nodes: [{ id: "TC1", author: { login: "luke" } }] },
									},
								],
							},
							commits: {
								nodes: [
									{
										commit: {
											statusCheckRollup: {
												state: "FAILURE",
												contexts: {
													nodes: [
														{
															__typename: "CheckRun",
															name: "test",
															status: "COMPLETED",
															conclusion: "FAILURE",
														},
													],
												},
											},
										},
									},
								],
							},
						},
					},
				},
			},
			{ owner: "o", name: "r", slug: "o/r" },
		);
		expect(snapshot).toMatchObject({
			merge: "conflicts",
			checks: "failing",
			failingChecks: ["test"],
			reviewDecision: "changes_requested",
			unresolvedThreads: 1,
		});
		expect(snapshot.activities).toHaveLength(3);
	});
});
