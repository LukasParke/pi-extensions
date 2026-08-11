import http from "node:http";
import https from "node:https";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { githubApi } from "../src/api.ts";
import { GitHubClient } from "../src/client.ts";
import { parseRepo } from "../src/repo.ts";

/**
 * No test in this package may reach the network.
 *
 * ## Why an interceptor and not a convention
 *
 * "The tests all inject a fetch" is a claim that decays. One test forgets, CI starts calling api.github.com, and the
 * symptom is a suite that is green locally and intermittently rate-limited in CI for a month before anyone traces it. Far
 * worse here than in a read-only package: this one can POST a comment or submit a review, so an unstubbed call in CI
 * could write to someone's real repository.
 *
 * So the failure is loud and immediate. `live.test.ts` is the one file that may reach GitHub, and it is opt-in behind an
 * environment variable and a real token.
 */

class Blocked extends Error {
	constructor(what: string) {
		super(`Blocked live network call: ${what}. Pass a fetchImpl, or put the test in live.test.ts (opt-in).`);
		this.name = "Blocked";
	}
}

let originalFetch: typeof globalThis.fetch;
let originalHttp: typeof http.request;
let originalHttps: typeof https.request;

beforeAll(() => {
	originalFetch = globalThis.fetch;
	originalHttp = http.request;
	originalHttps = https.request;

	globalThis.fetch = (async (input: RequestInfo | URL) => {
		throw new Blocked(String(input));
	}) as typeof globalThis.fetch;

	/**
	 * `http`/`https` are blocked too, not only `fetch`.
	 *
	 * Nothing in this package uses them, so a call arriving there means a dependency did something unexpected — and an
	 * interceptor that only covers the code you wrote is an interceptor that proves nothing.
	 */
	const block = ((..._args: unknown[]) => {
		throw new Blocked("raw http(s).request");
	}) as unknown as typeof http.request;
	http.request = block;
	https.request = block;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	http.request = originalHttp;
	https.request = originalHttps;
});

describe("the guard itself works", () => {
	it("an API client with no fetchImpl is blocked", async () => {
		/**
		 * Proves the interceptor bites, rather than asserting it exists.
		 *
		 * A guard nobody has seen fail is a guard that might be installed after the code it guards, or scoped to the wrong
		 * global. This runs the real code path with the real default `fetch`.
		 *
		 * ## The blocked error arrives WRAPPED, and that is correct
		 *
		 * My first version asserted on the message `/Blocked live network call/` and failed: the client catches an unknown
		 * throw and reports `provider_error: could not reach GitHub`, because from its point of view a `fetch` that throws IS
		 * an unreachable GitHub. The blocked message survives in `providerMessage`, which is where a diagnostic belongs.
		 *
		 * So the assertion is on `providerMessage`, and `maxRetries: 0` is set — without it the client dutifully retried the
		 * blocked call twice with backoff, and the test took 1.5 seconds to assert something instant.
		 */
		const api = githubApi({ token: "t", maxRetries: 0, sleep: async () => undefined });
		const err = await api.request({ method: "GET", path: "/user" }).catch((e: unknown) => e);
		expect((err as { code?: string }).code).toBe("provider_error");
		expect((err as { providerMessage?: string }).providerMessage).toMatch(/Blocked live network call/);
	});

	it("a client with no fetchImpl is blocked on every read", async () => {
		const repo = parseRepo("o/r")!;
		const c = new GitHubClient({ token: "t", maxRetries: 0, sleep: async () => undefined });
		for (const call of [
			() => c.viewer(),
			() => c.pulls(repo),
			() => c.pull(repo, 1),
			() => c.checks(repo, "main"),
			() => c.issues(repo),
			() => c.search(repo, "x", "pr"),
		]) {
			await expect(call()).rejects.toThrow();
		}
	});

	it("a WRITE with no fetchImpl is blocked", async () => {
		/**
		 * Named separately from the reads, because this is the case that would do damage.
		 *
		 * A read leaking to CI costs rate limit. A write leaking to CI posts a comment on a real repository, which someone has
		 * to go and delete and which cannot be undone from here.
		 */
		const repo = parseRepo("o/r")!;
		const c = new GitHubClient({ token: "t", maxRetries: 0, sleep: async () => undefined });
		await expect(c.comment(repo, 1, "this must never be posted")).rejects.toThrow();
		await expect(c.review(repo, 1, "APPROVE", "")).rejects.toThrow();
	});
});
