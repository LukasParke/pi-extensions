import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAuthStore } from "@parke.dev/pi-integration-auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GITHUB_AUTH_REF, NO_TOKEN_MESSAGE, resolveToken } from "../src/auth.ts";
import { NO_REPO_MESSAGE, parseRepo, repoFromRemoteUrl, resolveRepo } from "../src/repo.ts";

/**
 * Credential and repository resolution.
 *
 * Every test injects its environment, its `gh` reader and its store, so none reads the developer's real credentials —
 * which matters more here than usual: a test that fell through to the real `resolveToken` would pass on this machine
 * because `gh` is authenticated, and fail in CI for a reason nobody could reproduce locally.
 */

let dir: string;
let store: PiAuthStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-gh-auth-"));
	store = new PiAuthStore(join(dir, "integration-auth.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const noGh = async (): Promise<string | null> => null;

describe("AC-12.40 token resolution order", () => {
	it("GITHUB_TOKEN wins over everything", async () => {
		await store.set(GITHUB_AUTH_REF, "stored");
		const r = await resolveToken({
			env: { GITHUB_TOKEN: "from-env" },
			store,
			ghToken: async () => "from-gh",
		});
		/**
		 * Explicit beats implicit.
		 *
		 * A user who set the variable has said which token they want used, and that must beat a keyring they may have
		 * forgotten about — otherwise `GITHUB_TOKEN=x pi ...` silently does nothing, which is the least debuggable outcome
		 * available.
		 */
		expect(r?.token).toBe("from-env");
		expect(r?.source).toBe("env");
		expect(r?.detail).toContain("GITHUB_TOKEN");
	});

	it("GH_TOKEN is honoured too, after GITHUB_TOKEN", async () => {
		expect((await resolveToken({ env: { GH_TOKEN: "g" }, store, ghToken: noGh }))?.token).toBe("g");
		const both = await resolveToken({
			env: { GITHUB_TOKEN: "a", GH_TOKEN: "b" },
			store,
			ghToken: noGh,
		});
		expect(both?.token).toBe("a");
	});

	it("the stored credential beats gh, because the user chose it deliberately", async () => {
		await store.set(GITHUB_AUTH_REF, "stored");
		const r = await resolveToken({ env: {}, store, ghToken: async () => "from-gh" });
		expect(r?.token).toBe("stored");
		expect(r?.source).toBe("integration-auth");
	});

	it("gh is the last resort, and says the token is not ours", async () => {
		const r = await resolveToken({ env: {}, store, ghToken: async () => "from-gh" });
		expect(r?.token).toBe("from-gh");
		/**
		 * `cli`, not `gh-cli` — the source names became generic when resolution moved into `@parke.dev/pi-integration-auth`.
		 *
		 * Four packages share the resolver and only GitHub has a CLI, so a provider-specific enum value would have meant either a
		 * union that grows per provider or three packages carrying a name they never emit. WHICH cli is in `detail`, which is
		 * where a human reads it anyway.
		 */
		expect(r?.source).toBe("cli");
		/**
		 * The detail states that nothing was copied.
		 *
		 * `gh`'s keyring is STRONGER than the 0600 file this package would otherwise write, so reading it is a feature — but a
		 * user must be able to tell that logging out of `gh` will take the credential away, rather than discovering it later.
		 */
		expect(r?.detail).toContain("not stored");
	});

	it("an empty or whitespace value is not a credential", async () => {
		// An exported-but-empty variable is the classic CI footgun: it looks set and authenticates as nobody.
		expect(await resolveToken({ env: { GITHUB_TOKEN: "" }, store, ghToken: noGh })).toBe(null);
		expect(await resolveToken({ env: { GITHUB_TOKEN: "   " }, store, ghToken: noGh })).toBe(null);
	});

	it("a token is trimmed, because a pasted one usually has a newline", async () => {
		const r = await resolveToken({ env: { GITHUB_TOKEN: "tok\n" }, store, ghToken: noGh });
		expect(r?.token).toBe("tok");
	});

	it("nothing resolves to null, and the message names ALL THREE remedies", async () => {
		expect(await resolveToken({ env: {}, store, ghToken: noGh })).toBe(null);
		/**
		 * A credential error that does not say how to fix it makes the user guess which of three mechanisms they were
		 * supposed to use. All three are named, in the order they are tried.
		 */
		expect(NO_TOKEN_MESSAGE).toContain("gh auth login");
		expect(NO_TOKEN_MESSAGE).toContain("/github-login");
		expect(NO_TOKEN_MESSAGE).toContain("GITHUB_TOKEN");
	});

	it("never leaks the token into the detail line", async () => {
		/**
		 * `detail` is printed by `github_status` and lands in a transcript.
		 *
		 * A canary rather than an eyeball: the value is distinctive enough that a substring check cannot pass by accident, and
		 * a single-character canary would make this test fail always rather than never.
		 */
		const canary = "ghp_CANARY_0123456789abcdefABCDEF";
		for (const opts of [
			{ env: { GITHUB_TOKEN: canary }, store, ghToken: noGh },
			{ env: {}, store, ghToken: async () => canary },
		]) {
			const r = await resolveToken(opts);
			expect(r?.detail ?? "", JSON.stringify(r?.source)).not.toContain(canary);
		}
		await store.set(GITHUB_AUTH_REF, canary);
		const stored = await resolveToken({ env: {}, store, ghToken: noGh });
		expect(stored?.detail ?? "").not.toContain(canary);
	});
});

describe("AC-12.45 repository slugs", () => {
	it("accepts the ordinary form", () => {
		expect(parseRepo("vitest-dev/vitest")?.slug).toBe("vitest-dev/vitest");
		expect(parseRepo("a/b.c_d-e")?.name).toBe("b.c_d-e");
	});

	it("strips a trailing .git, which is what a remote URL carries", () => {
		expect(parseRepo("o/r.git")?.name).toBe("r");
	});

	it("rejects anything that could reach a different endpoint", () => {
		/**
		 * The slug is interpolated into an API path, so this is a security boundary rather than input tidiness. A value
		 * containing a slash, a query string or a traversal would send the request somewhere the caller did not name.
		 */
		for (const bad of [
			"o/r/extra",
			"o",
			"",
			"/",
			"o/",
			"/r",
			"o/..",
			"o/.",
			"../o/r",
			"o/r?x=1",
			"o/r#f",
			"o r/x",
			"o/r x",
			"-bad/r",
			"bad-/r",
			"o/r/../../secrets",
		]) {
			expect(parseRepo(bad), bad).toBe(null);
		}
	});

	it("rejects an owner that is too long, with a bounded pattern", () => {
		// GitHub caps owners at 39 characters, and the bound is explicit so the regex cannot backtrack on a long input.
		expect(parseRepo(`${"a".repeat(39)}/r`)).not.toBe(null);
		expect(parseRepo(`${"a".repeat(40)}/r`)).toBe(null);
	});

	it("a pathological input does not take exponential time", () => {
		// The bounded-quantifier lesson: the host shipped two ReDoS bugs (122s, 14s) from unbounded ones on external input.
		const t0 = Date.now();
		parseRepo(`${"a-".repeat(30_000)}/r`);
		repoFromRemoteUrl(`https://github.com/${"a".repeat(50_000)}`);
		expect(Date.now() - t0).toBeLessThan(200);
	});
});

describe("repository from a remote URL", () => {
	it("handles the three forms git produces", () => {
		expect(repoFromRemoteUrl("https://github.com/o/r.git")?.slug).toBe("o/r");
		expect(repoFromRemoteUrl("git@github.com:o/r.git")?.slug).toBe("o/r");
		expect(repoFromRemoteUrl("ssh://git@github.com/o/r")?.slug).toBe("o/r");
	});

	it("works for an enterprise host, because the host is discarded", () => {
		expect(repoFromRemoteUrl("https://ghe.corp.example/team/repo.git")?.slug).toBe("team/repo");
	});

	it("a non-GitHub-shaped remote yields null rather than a guess", () => {
		expect(repoFromRemoteUrl("/local/path/to/repo")).toBe(null);
		expect(repoFromRemoteUrl("https://gitlab.com/g/s/p")).toBe(null);
	});
});

describe("resolveRepo", () => {
	it("an explicit argument wins and the cwd is not consulted", async () => {
		let consulted = false;
		const r = await resolveRepo("o/r", {
			cwd: "/x",
			gitRemote: async () => {
				consulted = true;
				return "https://github.com/other/thing";
			},
		});
		expect(r?.slug).toBe("o/r");
		expect(consulted, "an explicit repo must not trigger a git call").toBe(false);
	});

	it("falls back to the checkout, so a user in a repo need not say which", async () => {
		const r = await resolveRepo(undefined, {
			cwd: "/x",
			gitRemote: async () => "git@github.com:o/r.git",
		});
		expect(r?.slug).toBe("o/r");
	});

	it("no remote yields null, and the message names the parameter", async () => {
		/**
		 * An explicit failure rather than a plausible guess.
		 *
		 * An integration that operates on the wrong repository because it inferred one is worse than one that asks — the user
		 * would not find out until the comment appeared somewhere unexpected.
		 */
		expect(await resolveRepo(undefined, { cwd: "/x", gitRemote: async () => null })).toBe(null);
		expect(NO_REPO_MESSAGE).toContain("repo");
		expect(NO_REPO_MESSAGE).toContain("owner/name");
	});

	it("an empty explicit argument falls through to the checkout", async () => {
		// `repo: ''` from a model means "I did not supply one", not "the repository named empty string".
		const r = await resolveRepo("", { cwd: "/x", gitRemote: async () => "https://github.com/o/r" });
		expect(r?.slug).toBe("o/r");
	});
});
