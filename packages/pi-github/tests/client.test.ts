import { describe, expect, it } from "vitest";
import { GitHubClient } from "../src/client.ts";
import { parseRepo } from "../src/repo.ts";

/**
 * The client: the layer between HTTP and the view models.
 *
 * Every test scripts its own fetch by URL, so a route that changes shape fails here rather than at runtime. The routing
 * table is deliberately explicit — a catch-all stub would let a typo'd path pass by matching the wrong response.
 */

const repo = parseRepo("o/r")!;

/** Routes a request by substring, so a test declares exactly which endpoints it expects to be hit. */
function router(routes: Record<string, unknown>): { fetchImpl: typeof fetch; hits: string[] } {
	const hits: string[] = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		hits.push(`${(init?.method ?? "GET").toUpperCase()} ${url.replace("https://api.github.com", "")}`);
		for (const [needle, body] of Object.entries(routes)) {
			if (url.includes(needle)) {
				return new Response(JSON.stringify(body), {
					status: 200,
					headers: {
						"content-type": "application/json",
						"x-ratelimit-remaining": "4000",
						"x-ratelimit-limit": "5000",
					},
				});
			}
		}
		// An unrouted URL is a test bug, and saying which one beats a confusing assertion failure later.
		return new Response(JSON.stringify({ message: `unrouted: ${url}` }), { status: 404 });
	}) as typeof fetch;
	return { fetchImpl, hits };
}

const client = (fetchImpl: typeof fetch): GitHubClient =>
	new GitHubClient({ token: "t", fetchImpl, sleep: async () => undefined });

const apiPull = (over: Record<string, unknown> = {}) => ({
	number: 7,
	title: "a change",
	state: "open",
	updated_at: "2026-07-01T00:00:00Z",
	html_url: "https://github.com/o/r/pull/7",
	user: { login: "alice" },
	head: { ref: "feat", sha: "deadbeef" },
	base: { ref: "main" },
	...over,
});

describe("pulls", () => {
	it("enriches the first rows with real check and review state", async () => {
		const { fetchImpl, hits } = router({
			"/pulls?": [apiPull()],
			"/check-runs": { check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] },
			"/reviews": [{ state: "APPROVED", user: { login: "bob" }, submitted_at: "2026-07-01T01:00:00Z" }],
		});
		const res = await client(fetchImpl).pulls(repo, { limit: 5 });
		expect(res.data[0]?.checks).toBe("failing");
		expect(res.data[0]?.review).toBe("approved");
		// Three calls: the list, plus checks and reviews for the one row.
		expect(hits.filter((h) => h.includes("check-runs"))).toHaveLength(1);
	});

	it('rows beyond the enrich budget say "no checks" rather than guessing', async () => {
		/**
		 * `/pulls` returns neither check nor review state, so enrichment is one call per PR — which is how an integration
		 * spends a user's whole rate budget on a list view. The bound is the design; the unenriched rows are honest about what
		 * is unknown.
		 */
		const { fetchImpl, hits } = router({
			"/pulls?": [apiPull({ number: 1 }), apiPull({ number: 2 }), apiPull({ number: 3 })],
			"/check-runs": { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] },
			"/reviews": [],
		});
		const res = await client(fetchImpl).pulls(repo, { limit: 5, enrich: 1 });
		expect(res.data[0]?.checks).toBe("passing");
		expect(res.data[1]?.checks).toBe("no checks");
		expect(res.data[2]?.checks).toBe("no checks");
		expect(
			hits.filter((h) => h.includes("check-runs")),
			"exactly one PR enriched",
		).toHaveLength(1);
	});

	it("a failure enriching ONE row does not fail the whole list", async () => {
		/**
		 * A PR whose head branch was deleted returns 404 for its checks. A list that threw would show the user nothing at all
		 * instead of every usable row — the failure mode where one broken item hides nineteen good ones.
		 */
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/pulls?")) {
				return new Response(JSON.stringify([apiPull()]), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.includes("/check-runs"))
				return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
			return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
		}) as typeof fetch;
		const res = await client(fetchImpl).pulls(repo, { limit: 5 });
		expect(res.data).toHaveLength(1);
		expect(res.data[0]?.checks).toBe("no checks");
	});

	it('a requested reviewer with no submitted review is "review required"', async () => {
		const { fetchImpl } = router({
			"/pulls?": [apiPull({ requested_reviewers: [{ login: "carol" }] })],
			"/check-runs": { check_runs: [] },
			"/reviews": [],
		});
		const res = await client(fetchImpl).pulls(repo, { limit: 1 });
		expect(res.data[0]?.review).toBe("review required");
	});

	it("caps the limit, so a model cannot ask for a thousand rows", async () => {
		const { fetchImpl, hits } = router({
			"/pulls?": [],
			"/check-runs": { check_runs: [] },
			"/reviews": [],
		});
		await client(fetchImpl).pulls(repo, { limit: 9999 });
		expect(hits[0]).toContain("per_page=100");
	});
});

describe("pull detail", () => {
	it("assembles files, checks and reviews into one block", async () => {
		const { fetchImpl } = router({
			"/pulls/7/files": [
				{ filename: "a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1 @@" },
			],
			"/pulls/7/reviews": [
				{
					state: "CHANGES_REQUESTED",
					user: { login: "bob" },
					body: "no",
					submitted_at: "2026-07-01T01:00:00Z",
				},
			],
			"/check-runs": { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] },
			"/pulls/7": apiPull({
				body: "why",
				additions: 2,
				deletions: 1,
				changed_files: 1,
				mergeable_state: "blocked",
			}),
		});
		const res = await client(fetchImpl).pull(repo, 7);
		expect(res.data.body).toBe("why");
		expect(res.data.files[0]?.patch).toBe("@@ -1 +1 @@");
		expect(res.data.checks[0]?.status).toBe("passing");
		expect(res.data.reviews[0]?.state).toBe("changes requested");
		expect(res.data.mergeable).toContain("required review");
	});

	it("a PR still loads when its checks and reviews both fail", async () => {
		/**
		 * The detail view is the review surface, so it must degrade rather than disappear: a user reading a diff does not lose
		 * the diff because a check endpoint 404'd.
		 */
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/files"))
				return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
			if (url.includes("/pulls/7")) {
				return new Response(JSON.stringify(apiPull()), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ message: "gone" }), { status: 404 });
		}) as typeof fetch;
		const res = await client(fetchImpl).pull(repo, 7);
		expect(res.data.number).toBe(7);
		expect(res.data.checks).toEqual([]);
		expect(res.data.reviews).toEqual([]);
	});

	it("marks the file list as truncated when it was cut short", async () => {
		const many = Array.from({ length: 100 }, (_, i) => ({
			filename: `f${String(i)}.ts`,
			status: "modified",
			additions: 1,
			deletions: 0,
			patch: "x",
		}));
		const { fetchImpl } = router({
			"/pulls/7/files": many,
			"/pulls/7/reviews": [],
			"/check-runs": { check_runs: [] },
			"/pulls/7": apiPull({ changed_files: 100 }),
		});
		const res = await client(fetchImpl).pull(repo, 7);
		expect(res.data.files.length).toBeLessThan(100);
		// A partial answer must say so, or a reviewer approves a change they only partly saw.
		expect(res.data.filesTruncated).toBe(true);
	});
});

describe("checks", () => {
	it("an empty ref returns no checks WITHOUT calling GitHub", async () => {
		/**
		 * A PR whose head SHA is missing — a deleted branch — is a real state. Calling GitHub with an empty path segment
		 * produces a confusing 404 the caller then has to interpret; "no checks" is both true and actionable.
		 */
		let called = false;
		const fetchImpl = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		const res = await client(fetchImpl).checks(repo, "");
		expect(res.data).toEqual([]);
		expect(called).toBe(false);
	});

	it("encodes the ref, so a branch with a slash works", async () => {
		const { fetchImpl, hits } = router({ "/check-runs": { check_runs: [] } });
		await client(fetchImpl).checks(repo, "feature/thing");
		// `feature/thing` unencoded would create an extra path segment and hit a different endpoint.
		expect(hits[0]).toContain("feature%2Fthing");
	});
});

describe("issues", () => {
	it("filters out pull requests, which GitHub returns from the issues endpoint", async () => {
		/**
		 * A PR *is* an issue in GitHub's data model, so `/issues` returns both. A list that silently mixes them makes both
		 * counts wrong, and a user asking for issues does not mean PRs.
		 */
		const { fetchImpl } = router({
			"/issues?": [
				{
					number: 1,
					title: "real issue",
					state: "open",
					updated_at: "2026-07-01T00:00:00Z",
					html_url: "u",
				},
				{
					number: 2,
					title: "a PR",
					state: "open",
					updated_at: "2026-07-01T00:00:00Z",
					html_url: "u",
					pull_request: { url: "x" },
				},
			],
		});
		const res = await client(fetchImpl).issues(repo, { limit: 10 });
		expect(res.data).toHaveLength(1);
		expect(res.data[0]?.title).toBe("real issue");
	});

	it("passes label and assignee filters through", async () => {
		const { fetchImpl, hits } = router({ "/issues?": [] });
		await client(fetchImpl).issues(repo, { labels: "bug,p1", assignee: "alice" });
		expect(hits[0]).toContain("labels=bug%2Cp1");
		expect(hits[0]).toContain("assignee=alice");
	});

	it("omits empty filters rather than sending blank ones", async () => {
		// `labels=` is not the same as no filter: GitHub can interpret it, and a user who typed nothing meant nothing.
		const { fetchImpl, hits } = router({ "/issues?": [] });
		await client(fetchImpl).issues(repo, { labels: "", assignee: "" });
		expect(hits[0]).not.toContain("labels=");
		expect(hits[0]).not.toContain("assignee=");
	});
});

describe("search", () => {
	it("scopes to the repository and the kind", async () => {
		const { fetchImpl, hits } = router({ "/search/issues": { items: [] } });
		await client(fetchImpl).search(repo, "author:me broken", "pr");
		const url = decodeURIComponent(hits[0] ?? "");
		// The repo scope is added, not left to the caller — an unscoped search would return the whole of GitHub.
		expect(url).toContain("repo:o/r");
		expect(url).toContain("is:pr");
		expect(url).toContain("author:me broken");
	});
});

describe("writes", () => {
	it("posts a comment and returns its URL", async () => {
		const { fetchImpl, hits } = router({
			"/issues/7/comments": { html_url: "https://github.com/o/r/pull/7#c1" },
		});
		const res = await client(fetchImpl).comment(repo, 7, "hello");
		expect(res.data.url).toContain("#c1");
		expect(hits[0]).toBe("POST /repos/o/r/issues/7/comments");
	});

	it("refuses an empty comment before calling GitHub", async () => {
		let called = false;
		const fetchImpl = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		await expect(client(fetchImpl).comment(repo, 7, "   ")).rejects.toMatchObject({
			code: "invalid_request",
		});
		// Caught locally, so a user's mistake is not a round trip and a 422 to interpret.
		expect(called).toBe(false);
	});

	it("refuses to request changes with no explanation", async () => {
		/**
		 * A blocked review with no body produces a PR whose author cannot tell what to do — a worse outcome than an error,
		 * because it is someone else who is stuck and they have no way to ask.
		 */
		const { fetchImpl } = router({ "/reviews": { html_url: "u", state: "CHANGES_REQUESTED" } });
		await expect(client(fetchImpl).review(repo, 7, "REQUEST_CHANGES", "")).rejects.toMatchObject({
			code: "invalid_request",
		});
	});

	it("allows an approval with no body, because GitHub does", async () => {
		const { fetchImpl, hits } = router({ "/reviews": { html_url: "u", state: "APPROVED" } });
		const res = await client(fetchImpl).review(repo, 7, "APPROVE", "");
		expect(res.data.state).toBe("APPROVED");
		expect(hits[0]).toBe("POST /repos/o/r/pulls/7/reviews");
	});

	it("sends the event verbatim, because approve and request_changes are opposites", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
			calls.push(String(init?.body));
			return new Response(JSON.stringify({ html_url: "u", state: "x" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		await client(fetchImpl).review(repo, 7, "REQUEST_CHANGES", "please fix");
		expect(calls[0]).toContain('"event":"REQUEST_CHANGES"');
		expect(calls[0]).toContain("please fix");
	});
});
