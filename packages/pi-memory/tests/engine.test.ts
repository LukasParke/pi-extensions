import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryEngine } from "../src/engine.ts";
import { HashEmbedder, OnnxEmbedder } from "../src/index/embed.ts";
import { MEMORY_SCHEMA_DOWN, MEMORY_SCHEMA_UP } from "../src/schema.ts";

/**
 * The engine (R-8.5 … R-8.9).
 *
 * The REAL encoder throughout, because the interesting behaviours — dedupe thresholds, the dense gate,
 * hybrid fusion beating either leg — are properties of real embeddings. A hash embedder would let a
 * broken threshold pass, since nothing would be semantically near anything.
 *
 * One shared model across the file: loading it per test would add ~90ms each and prove nothing.
 */

const embedder = new OnnxEmbedder();

/** The Phase-1 redaction filter, in miniature. The real one is injected by `core`. */
const redact = (s: string): string =>
	s
		.replace(/ghp_[A-Za-z0-9]{20,}/g, "«redacted:github-pat»")
		.replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, "«redacted:slack-token»")
		.replace(/sk-[A-Za-z0-9]{20,}/g, "«redacted:openai-key»");

let db: DatabaseSync;
let engine: MemoryEngine;

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	db.exec(MEMORY_SCHEMA_UP);
	engine = new MemoryEngine({ db, peerId: "peer-test", embedder, redact });
});

afterEach(() => {
	db.close();
});

const add = async (text: string, over: Record<string, unknown> = {}) =>
	await engine.add({ text, scope: "global", extracted_by: "user", ...over });

describe("schema (AC-8.1)", () => {
	it("AC-8.1 round-trips forward and backward", () => {
		const fresh = new DatabaseSync(":memory:");
		fresh.exec(MEMORY_SCHEMA_UP);
		fresh.exec(MEMORY_SCHEMA_DOWN);
		// Re-applying proves `down` left nothing behind: a leftover index makes the second `up` fail.
		fresh.exec(MEMORY_SCHEMA_UP);
		fresh.close();
	});

	it("AC-8.1 a project entry must name its project, and a global one must not", () => {
		/**
		 * Enforced by CHECK rather than by code, because a scope/project mismatch is a data-integrity bug
		 * that leaks one project's facts into every chat — and the database is the only layer no caller can
		 * route around.
		 */
		expect(() =>
			db
				.prepare(
					`INSERT INTO memory_entries (id,scope,project_id,text,text_norm,created_at,updated_at,
            lamport,origin_peer,learned_at,extracted_by) VALUES ('x','project',NULL,'t','t',1,1,1,'p',1,'user')`,
				)
				.run(),
		).toThrow();

		expect(() =>
			db
				.prepare(
					`INSERT INTO memory_entries (id,scope,project_id,text,text_norm,created_at,updated_at,
            lamport,origin_peer,learned_at,extracted_by) VALUES ('y','global','p_1','t','t',1,1,1,'p',1,'user')`,
				)
				.run(),
		).toThrow();
	});
});

describe("add and dedupe (R-8.7)", () => {
	it("adds a proposition with provenance", async () => {
		const r = await add("the api lives in packages/core");
		expect(r?.deduped).toBe(false);
		expect(r?.entry.text).toBe("the api lives in packages/core");
		expect(r?.entry.provenance.confirmations).toBe(1);
		expect(r?.entry.provenance.extracted_by).toBe("user");
		expect(r?.entry.lamport).toBe(1);
		expect(r?.entry.origin_peer).toBe("peer-test");
	});

	it("AC-8.6 an exact repeat confirms rather than inserting", async () => {
		const first = await add("tests run with pnpm vitest");
		const second = await add("tests run with pnpm vitest");
		expect(second?.deduped).toBe(true);
		expect(second?.entry.id).toBe(first?.entry.id);
		expect(second?.entry.provenance.confirmations).toBe(2);
		expect(engine.stats().total).toBe(1);
	});

	it("AC-8.6 normalization means punctuation and case do not create a second row", async () => {
		await add("Luke prefers tabs");
		const again = await add('  "luke prefers TABS."  ');
		expect(again?.deduped).toBe(true);
		expect(engine.stats().total).toBe(1);
	});

	it("AC-8.7 a near-duplicate confirms; a merely related fact inserts", async () => {
		/**
		 * The threshold pair doing its job with real embeddings. Both cosine ≥ 0.92 AND Jaccard ≥ 0.6 must
		 * hold, which is why a paraphrase folds and a related-but-different fact does not.
		 */
		const first = await add("the deploy pipeline runs on talos");
		const paraphrase = await add("the deploy pipeline runs on talos machine");
		// High cosine and high token overlap: the same fact.
		expect(paraphrase?.entry.id).toBe(first?.entry.id);
		expect(paraphrase?.deduped).toBe(true);

		// Related topic, different fact. Must NOT fold, or the corpus loses information silently.
		const different = await add("the test suite runs on dev-mac");
		expect(different?.deduped).toBe(false);
		expect(different?.entry.id).not.toBe(first?.entry.id);
	});

	it("AC-8.7 an OPPOSITE claim does not fold, even though it is semantically close", async () => {
		/**
		 * The case that justifies requiring Jaccard as well as cosine. "the tests pass" and "the tests fail"
		 * are close in embedding space — a cosine-only rule would fold them and Circle would remember the
		 * opposite of what it was told.
		 */
		const passing = await add("the integration tests pass on linux");
		const failing = await add("the integration tests fail on linux");
		expect(failing?.entry.id).not.toBe(passing?.entry.id);
		expect(engine.stats().total).toBe(2);
	});

	it("scope keys are separate: the same text in two projects is two facts", async () => {
		const a = await add("the build uses esbuild", { scope: "project", project_id: "p_1" });
		const b = await add("the build uses esbuild", { scope: "project", project_id: "p_2" });
		expect(b?.deduped).toBe(false);
		expect(b?.entry.id).not.toBe(a?.entry.id);

		// And a global with the same text is a third, because its meaning differs.
		const g = await add("the build uses esbuild");
		expect(g?.deduped).toBe(false);
		expect(engine.stats().total).toBe(3);
	});

	it("rejects text over the length cap, and empty text", async () => {
		expect(await add("x".repeat(281))).toBe(null);
		expect(await add("   ")).toBe(null);
		expect(await add("")).toBe(null);
	});

	it("refuses a project-scoped fact with no project rather than promoting it", async () => {
		// Promotion would leak one project's facts into every other chat.
		expect(await engine.add({ text: "x", scope: "project", extracted_by: "user" })).toBe(null);
	});
});

describe("redaction (R-8.9, AC-8.15)", () => {
	it("AC-8.15 a canary secret never reaches entries, FTS, log, or vectors", async () => {
		const canary = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
		const r = await add(`the deploy token is ${canary} for the release job`);

		expect(r?.entry.text).not.toContain(canary);
		expect(r?.entry.text).toContain("«redacted:github-pat»");

		/**
		 * The whole database is scanned, not just the entries table.
		 *
		 * A column check would miss the FTS shadow tables and the log payload — and the log is where a naive
		 * implementation leaks, because it records what was asked for rather than what was stored.
		 */
		const dump = dumpAll(db);
		expect(dump).not.toContain(canary);
		expect(dump).not.toContain("ghp_");
	});

	it("AC-8.15 a candidate that is ONLY a secret is dropped, not stored as a placeholder", async () => {
		/**
		 * "«redacted:slack-token»" carries no fact worth keeping and would pollute recall with a row that
		 * looks like information.
		 */
		expect(await add("xoxb-1234567890-abcdefghijkl")).toBe(null);
		expect(await add("sk-abcdefghijklmnopqrstuvwxyz123456")).toBe(null);
		expect(engine.stats().total).toBe(0);
	});

	it("AC-8.15 redaction runs before normalize, so the dedupe key is clean too", async () => {
		const a = await add("token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa here");
		const b = await add("token ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb here");
		/**
		 * Two DIFFERENT secrets redact to the same marker, so they are the same proposition — which is
		 * correct: "there is a token here" is one fact. It also proves the key is computed after redaction.
		 */
		expect(b?.deduped).toBe(true);
		expect(a?.entry.text_norm).not.toContain("ghp_");
	});
});

describe("recall (R-8.5, AC-8.4)", () => {
	beforeEach(async () => {
		await add("the authentication module lives in packages/core/src/auth");
		await add("login sessions expire after thirty days");
		await add("the deploy pipeline runs on talos");
		await add("DEV-412 tracks the p99 latency regression");
		await add("Luke prefers concise commit messages");
	});

	it("AC-8.4 finds a fact by MEANING, with no shared words", async () => {
		/**
		 * The property that makes memory better than grep. "where is signin handled" shares no tokens with
		 * "the authentication module lives in packages/core/src/auth", so BM25 scores it zero and only the
		 * dense leg can find it.
		 */
		const { hits } = await engine.recall("where is signin handled", { mode: "global" });
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]?.entry.text).toContain("authentication module");
		expect(hits[0]?.dense_rank).toBe(1);
	});

	it("AC-8.5 finds an exact token the embedding cannot help with", async () => {
		/**
		 * The other leg. `DEV-412` is a meaningless token to an encoder, so the sparse leg is what surfaces
		 * it — and the dense gate's top-3 escape hatch is what keeps it from being filtered out.
		 */
		const { hits } = await engine.recall("DEV-412", { mode: "global" });
		expect(hits[0]?.entry.text).toContain("DEV-412");
		expect(hits[0]?.sparse_rank).toBe(1);
	});

	it("AC-8.5 fusion scores match Σ 1/(60+rank)", async () => {
		// Pinned numerically: RRF with the wrong K or a 0-based rank still "works" and ranks differently.
		const { hits } = await engine.recall("deploy pipeline talos", { mode: "global" });
		const top = hits[0];
		expect(top).toBeDefined();
		const expected =
			(top!.dense_rank !== null ? 1 / (60 + top!.dense_rank) : 0) +
			(top!.sparse_rank !== null ? 1 / (60 + top!.sparse_rank) : 0);
		expect(top!.score).toBeCloseTo(expected, 10);
	});

	it("AC-8.33 a forgotten entry disappears from BOTH legs immediately", async () => {
		const before = await engine.recall("authentication", { mode: "global" });
		const target = before.hits.find((h) => h.entry.text.includes("authentication"))!;
		expect(engine.forget(target.entry.id)).toBe(true);

		const after = await engine.recall("authentication", { mode: "global" });
		expect(after.hits.map((h) => h.entry.id)).not.toContain(target.entry.id);

		// And it is gone from the FTS table, not merely filtered — "forget" must mean forget.
		const ftsRows = db
			.prepare("SELECT COUNT(*) AS n FROM memory_fts WHERE entry_id = ?")
			.get(target.entry.id) as { n: number };
		expect(ftsRows.n).toBe(0);
		const vecRows = db
			.prepare("SELECT COUNT(*) AS n FROM memory_vec WHERE entry_id = ?")
			.get(target.entry.id) as { n: number };
		expect(vecRows.n).toBe(0);
	});

	it("AC-8.13 session scope sees project ∪ global; without a project, global only", async () => {
		await add("this repo uses pnpm workspaces", { scope: "project", project_id: "p_1" });
		await add("the other repo uses npm", { scope: "project", project_id: "p_2" });

		const inProject = await engine.recall("package manager", {
			mode: "session",
			project_id: "p_1",
		});
		const texts = inProject.hits.map((h) => h.entry.text);
		expect(texts.some((t) => t.includes("pnpm workspaces"))).toBe(true);
		// Another project's facts are never visible.
		expect(texts.some((t) => t.includes("other repo"))).toBe(false);

		const noProject = await engine.recall("package manager", { mode: "session" });
		expect(noProject.hits.every((h) => h.entry.scope === "global")).toBe(true);
	});

	it("AC-8.12 the UI project filter is STRICTER: no globals", async () => {
		/**
		 * Deliberately different from session injection. Someone browsing project memory is asking a narrower
		 * question, and interleaving globals would make the list unreadable — where injection wants globals
		 * because that is how a global fact helps every chat.
		 */
		await add("this repo uses pnpm workspaces", { scope: "project", project_id: "p_1" });
		const { hits } = await engine.recall("preferences and tooling", {
			mode: "project",
			project_id: "p_1",
		});
		expect(hits.every((h) => h.entry.scope === "project")).toBe(true);
		expect(hits.every((h) => h.entry.project_id === "p_1")).toBe(true);
	});

	it("a query matching nothing returns nothing rather than noise", async () => {
		/**
		 * The dense gate at work: without it, a linear scan always returns its 40 nearest vectors however
		 * unrelated, and recall would inject five irrelevant facts into every turn.
		 */
		const { hits } = await engine.recall("xylophone quantum marmalade", { mode: "global" });
		expect(hits.length).toBeLessThan(3);
	});

	it("respects the limit and reports how long it took", async () => {
		const { hits, tookMs } = await engine.recall("the", { mode: "global" }, 2);
		expect(hits.length).toBeLessThanOrEqual(2);
		expect(tookMs).toBeGreaterThan(0);
	});
});

describe("correction (R-8.13, AC-8.9, AC-8.34)", () => {
	it("AC-8.9 an edit is visible to the very next recall", async () => {
		const r = await add("the api runs on port 3000");
		await engine.update(r!.entry.id, "the api runs on port 8080");

		const { hits } = await engine.recall("which port does the api use", { mode: "global" });
		const found = hits.find((h) => h.entry.id === r!.entry.id);
		expect(found?.entry.text).toBe("the api runs on port 8080");

		/**
		 * The old text is gone from the ENTRY and from the indexes — but it survives in the op log, and that
		 * is correct rather than a leak.
		 *
		 * My first assertion scanned the whole database and failed on the `upsert` payload. The op log is an
		 * append-only audit of what was believed and when; erasing history to satisfy a correction would mean
		 * a merge could not replay, and Phase 9's convergence rests on replay. "Edit" means the current
		 * belief changed, not that the past did.
		 *
		 * The distinction that matters for privacy is elsewhere: a SECRET never enters the log either,
		 * because redaction runs before the op is written (asserted above). And `forget` does remove content
		 * from the searchable indexes, which is what a user means by forgetting.
		 */
		expect(engine.store.get(r!.entry.id)?.text).not.toContain("port 3000");
		const fts = db.prepare("SELECT text FROM memory_fts").all() as { text: string }[];
		expect(JSON.stringify(fts)).not.toContain("port 3000");

		// The log DOES keep it, deliberately: it is the record that makes replay and merge possible.
		const log = engine.exportLog();
		expect(JSON.stringify(log)).toContain("port 3000");
		expect(log.map((o) => o.op)).toEqual(["upsert", "edit"]);
	});

	it("AC-8.34 an edit that collides with another entry FOLDS rather than bifurcating", async () => {
		/**
		 * Correcting a fact into one that already exists must not leave two rows saying the same thing —
		 * the corpus would then return both and look broken.
		 */
		const keep = await add("the deploy pipeline runs on talos");
		const other = await add("Luke prefers concise commit messages");

		const result = await engine.update(other!.entry.id, "the deploy pipeline runs on talos");
		expect(result?.id).toBe(keep!.entry.id);
		// The survivor gained the confirmation; the edited row is tombstoned.
		expect(result?.provenance.confirmations).toBe(2);
		expect(engine.store.get(other!.entry.id)?.tombstone).toBe(true);
		expect(engine.stats().total).toBe(1);
	});

	it("editing a forgotten or unknown entry does nothing", async () => {
		const r = await add("a fact");
		engine.forget(r!.entry.id);
		expect(await engine.update(r!.entry.id, "a revised fact")).toBe(null);
		expect(await engine.update("no-such-id", "x")).toBe(null);
	});

	it("AC-8.10 forget is idempotent", async () => {
		const r = await add("a fact to forget");
		expect(engine.forget(r!.entry.id)).toBe(true);
		// A user clicking twice is not an error.
		expect(engine.forget(r!.entry.id)).toBe(true);
		expect(engine.forget("never-existed")).toBe(false);
	});

	it("AC-8.29 forgetAllFromChat tombstones every entry from that chat and counts them", async () => {
		await add("fact one", { source_chat_id: "c_1" });
		await add("fact two", { source_chat_id: "c_1" });
		await add("fact three", { source_chat_id: "c_2" });

		expect(engine.forgetAllFromChat("c_1")).toBe(2);
		expect(engine.stats().total).toBe(1);
		// Idempotent: a second call finds nothing left to forget.
		expect(engine.forgetAllFromChat("c_1")).toBe(0);
	});
});

describe("the op log (R-8.3, AC-8.16, AC-8.17)", () => {
	it("AC-8.16 every mutation writes a log row", async () => {
		const r = await add("a fact");
		await engine.update(r!.entry.id, "a revised fact");
		engine.forget(r!.entry.id);
		await add("a fact");

		const log = engine.exportLog();
		expect(log.map((o) => o.op)).toEqual(["upsert", "edit", "forget", "upsert"]);
		// Every op carries this peer's id, so Phase 9 needs no backfill.
		expect(log.every((o) => o.origin_peer === "peer-test")).toBe(true);
	});

	it("AC-8.17 lamport values are unique and monotonic", async () => {
		for (let i = 0; i < 10; i++) await add(`distinct fact number ${String(i)}`);
		const log = engine.exportLog();
		const lamports = log.map((o) => o.lamport);
		expect(new Set(lamports).size).toBe(lamports.length);
		expect([...lamports].sort((a, b) => a - b)).toEqual(lamports);
	});

	it("AC-8.17 a restarted engine resumes the clock rather than reissuing numbers", async () => {
		/**
		 * A clock starting at 1 after a restart would collide with `UNIQUE(origin_peer, lamport)` — or worse
		 * in Phase 9, two different ops would claim the same position and one would be silently discarded.
		 */
		await add("fact before restart");
		const before = engine.exportLog().at(-1)!.lamport;

		const resumed = new MemoryEngine({ db, peerId: "peer-test", embedder, redact });
		await resumed.add({ text: "fact after restart", scope: "global", extracted_by: "user" });

		const after = resumed.exportLog().at(-1)!.lamport;
		expect(after).toBeGreaterThan(before);
	});

	it("AC-8.20 mergePreview folds an incoming log deterministically", async () => {
		await add("local fact");
		const incoming = [
			{
				id: "op_remote_1",
				entry_id: "entry_remote",
				op: "upsert" as const,
				lamport: 50,
				origin_peer: "peer-talos",
				payload: {
					fields: {
						scope: "global" as const,
						project_id: null,
						text: "a fact from talos",
						text_norm: "a fact from talos",
						provenance: {
							source_chat_id: null,
							source_seq: null,
							learned_at: 1,
							confirmations: 1,
							extracted_by: "turn" as const,
						},
					},
				},
				ts: 1,
			},
		];
		const a = engine.mergePreview(incoming);
		const b = engine.mergePreview(incoming);
		expect(a.digest).toBe(b.digest);
		expect(a.entry_count).toBe(2);
	});
});

describe("reindex", () => {
	it("re-embeds every live entry and rebuilds FTS", async () => {
		await add("the first fact");
		await add("the second fact");
		const r = await add("the third fact");
		engine.forget(r!.entry.id);

		const count = await engine.reindex();
		// Only live entries: re-embedding a tombstone would resurrect it in the vector table.
		expect(count).toBe(2);
		const { hits } = await engine.recall("first", { mode: "global" });
		expect(hits.length).toBeGreaterThan(0);
	});
});

describe("the hash embedder is usable but announces itself", () => {
	it("the engine works with it, so a host without weights is degraded rather than broken", async () => {
		const hashDb = new DatabaseSync(":memory:");
		hashDb.exec(MEMORY_SCHEMA_UP);
		const hashEngine = new MemoryEngine({
			db: hashDb,
			peerId: "peer-hash",
			embedder: new HashEmbedder(),
			redact,
		});
		const r = await hashEngine.add({
			text: "a fact stored without the real model",
			scope: "global",
			extracted_by: "cli",
		});
		expect(r?.deduped).toBe(false);
		// Exact-token recall still works; only the semantic leg is weak.
		const { hits } = await hashEngine.recall("fact stored without", { mode: "global" });
		expect(hits.length).toBeGreaterThan(0);
		hashDb.close();
	});
});

/** Every byte in the database, for a canary scan. */
function dumpAll(database: DatabaseSync): string {
	const tables = database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all() as {
		name: string;
	}[];
	let out = "";
	for (const t of tables) {
		try {
			const rows = database.prepare(`SELECT * FROM "${t.name}"`).all() as Record<string, unknown>[];
			out += JSON.stringify(rows);
		} catch {
			// A virtual table's shadow may not be directly selectable; its content tables are, and they are
			// listed separately.
		}
	}
	return out;
}

describe("recall is entirely local (AC-8.3)", () => {
	it("AC-8.3 recall makes ZERO network calls, proven by blocking them", async () => {
		/**
		 * The property that makes memory usable on a plane, and the reason a hosted embedding API was never an
		 * option. Asserted by REPLACING the network rather than by inspecting imports: a transitive dependency
		 * could reach out, and only an interceptor catches that.
		 */
		const original = { fetch: globalThis.fetch };
		let attempts = 0;
		globalThis.fetch = (() => {
			attempts++;
			throw new Error("NETWORK BLOCKED — recall must be entirely local");
		}) as typeof globalThis.fetch;

		try {
			const r = await add("recall works with the network unplugged");
			expect(r?.entry.text).toContain("network unplugged");

			const { hits } = await engine.recall("does this work offline", { mode: "global" });
			expect(hits.length).toBeGreaterThan(0);

			// Also the query path with an exact token, so both retrieval legs are covered.
			const exact = await engine.recall("unplugged", { mode: "global" });
			expect(exact.hits.length).toBeGreaterThan(0);

			expect(attempts, "something tried to use the network").toBe(0);
		} finally {
			globalThis.fetch = original.fetch;
		}
	});

	it("AC-8.3 the same query returns IDENTICAL results with the network blocked", async () => {
		// Not merely "it did not crash": a degraded path that silently returned fewer results would pass a
		// weaker assertion.
		await add("the encoder is bundled, not fetched");
		await add("vectors live in sqlite as blobs");

		const before = await engine.recall("where do vectors live", { mode: "global" });

		const original = globalThis.fetch;
		globalThis.fetch = (() => {
			throw new Error("blocked");
		}) as typeof globalThis.fetch;
		try {
			const after = await engine.recall("where do vectors live", { mode: "global" });
			expect(after.hits.map((h) => h.entry.id)).toEqual(before.hits.map((h) => h.entry.id));
			expect(after.hits.map((h) => h.score)).toEqual(before.hits.map((h) => h.score));
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe("two-peer merge (AC-8.35)", () => {
	it("AC-8.35 merging a second peer's log is deterministic and order-independent", async () => {
		/**
		 * The Phase 9 rehearsal, at the engine level rather than the pure-function level. A real store with real
		 * vectors merges a foreign log, and the digest must not depend on which order the two arrived.
		 */
		await add("a fact learned on this machine");
		const localLog = engine.exportLog();

		const remote = [
			{
				id: "op_talos_1",
				entry_id: "entry_from_talos",
				op: "upsert" as const,
				lamport: 100,
				origin_peer: "peer-talos",
				payload: {
					fields: {
						scope: "global" as const,
						project_id: null,
						text: "a fact learned on talos",
						text_norm: "a fact learned on talos",
						provenance: {
							source_chat_id: null,
							source_seq: null,
							learned_at: 5,
							confirmations: 1,
							extracted_by: "turn" as const,
						},
					},
				},
				ts: 5,
			},
			{
				id: "op_talos_2",
				entry_id: "entry_from_talos",
				op: "confirm" as const,
				lamport: 101,
				origin_peer: "peer-talos",
				payload: { delta: 1 },
				ts: 6,
			},
		];

		const forward = engine.mergePreview(remote);
		const reverse = engine.mergePreview([...remote].reverse());
		expect(forward.digest).toBe(reverse.digest);
		expect(forward.entry_count).toBe(2);

		// And the local log is untouched by a preview: it is a pure function, not an apply.
		expect(engine.exportLog()).toHaveLength(localLog.length);
	});
});
