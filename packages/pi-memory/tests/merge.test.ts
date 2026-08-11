import { describe, expect, it } from "vitest";
import {
	applyOp,
	compareOps,
	digestEntries,
	foldLog,
	LamportClock,
	manualProvenance,
	mergeLogs,
} from "../src/ops/merge.ts";
import type { MemoryEntry, MemoryLogRecord, MemoryUpsertFields } from "../src/types.ts";

/**
 * The merge function (R-8.3, AC-8.18 … AC-8.20).
 *
 * Property tests over random interleavings, because the claim is not "these three cases work" — it is
 * that convergence holds for ANY order two peers might see. Phase 9 turns this into sync, so a hole here
 * becomes a data-loss bug across machines.
 */

let seq = 0;
const upsert = (
	entryId: string,
	peer: string,
	lamport: number,
	text: string,
	over: Partial<MemoryUpsertFields> = {},
): MemoryLogRecord => ({
	id: `op_${String(++seq).padStart(4, "0")}`,
	entry_id: entryId,
	op: "upsert",
	lamport,
	origin_peer: peer,
	payload: {
		fields: {
			scope: "global",
			project_id: null,
			text,
			text_norm: text.toLowerCase(),
			provenance: manualProvenance("user", 1000 + lamport),
			...over,
		},
	},
	ts: 1000 + lamport,
});

const op = (
	entryId: string,
	peer: string,
	lamport: number,
	kind: "confirm" | "forget" | "edit",
	payload: Record<string, unknown> = {},
): MemoryLogRecord => ({
	id: `op_${String(++seq).padStart(4, "0")}`,
	entry_id: entryId,
	op: kind,
	lamport,
	origin_peer: peer,
	payload: payload as MemoryLogRecord["payload"],
	ts: 1000 + lamport,
});

/** A seeded PRNG, so a failing interleaving is reproducible from the seed alone. */
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

function shuffle<T>(items: readonly T[], rand: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

describe("ordering", () => {
	it("AC-8.18 orders by lamport, then peer, then op id — never by wall clock", () => {
		/**
		 * Wall clock is excluded deliberately: two peers with skewed clocks would otherwise converge
		 * differently depending on whose clock was wrong, which is the exact class of bug a lamport clock
		 * removes.
		 */
		const early = { ...upsert("e1", "peer-b", 5, "x"), ts: 9_999_999 };
		const late = { ...upsert("e1", "peer-a", 6, "y"), ts: 1 };
		expect(compareOps(early, late)).toBeLessThan(0);

		// Same clock: peer id breaks the tie, deterministically.
		const a = upsert("e1", "peer-a", 5, "x");
		const b = upsert("e1", "peer-b", 5, "y");
		expect(compareOps(a, b)).toBeLessThan(0);
		expect(compareOps(b, a)).toBeGreaterThan(0);

		// Same clock and peer: op id. Arbitrary, but TOTAL, which is all a tie-break needs.
		const c1 = { ...upsert("e1", "peer-a", 5, "x"), id: "op_aaa" };
		const c2 = { ...upsert("e1", "peer-a", 5, "y"), id: "op_bbb" };
		expect(compareOps(c1, c2)).toBeLessThan(0);
		// BOTH directions: a comparator that is only tested one way can be asymmetric and still pass,
		// which would make `sort` order-dependent — the exact property this whole file exists to deny.
		expect(compareOps(c2, c1)).toBeGreaterThan(0);
		expect(compareOps(c1, c1)).toBe(0);
	});
});

describe("applyOp", () => {
	it("an upsert creates an entry with the op as its version", () => {
		const e = applyOp(null, upsert("e1", "p1", 1, "Luke prefers tabs"))!;
		expect(e.id).toBe("e1");
		expect(e.text).toBe("Luke prefers tabs");
		expect(e.lamport).toBe(1);
		expect(e.origin_peer).toBe("p1");
		expect(e.tombstone).toBe(false);
		expect(e.provenance.confirmations).toBe(1);
	});

	it("a STALE upsert is ignored, so out-of-order application is safe", () => {
		/**
		 * Phase 9 applies ops as they arrive, not only in sorted batches, so each application has to be
		 * independently safe. Without this check a late-arriving old op would overwrite newer text.
		 */
		const current = applyOp(null, upsert("e1", "p1", 5, "newer"))!;
		const stale = applyOp(current, upsert("e1", "p2", 3, "older"))!;
		expect(stale.text).toBe("newer");
		expect(stale.lamport).toBe(5);
	});

	it("an edit to an unknown entry is dropped rather than inventing a row", () => {
		// A row conjured from an edit would have no provenance, which is worse than no row.
		expect(applyOp(null, op("ghost", "p1", 1, "edit", { text: "x", text_norm: "x" }))).toBe(null);
		expect(applyOp(null, op("ghost", "p1", 1, "confirm", { delta: 1 }))).toBe(null);
		expect(applyOp(null, op("ghost", "p1", 1, "forget"))).toBe(null);
	});

	it("AC-8.6 confirm ACCUMULATES, because the count is evidence", () => {
		/**
		 * The one place a counter rather than a register is needed. Two peers each confirming the same fact
		 * should produce two confirmations — last-writer-wins would discard half the evidence.
		 */
		let e = applyOp(null, upsert("e1", "p1", 1, "x"))!;
		e = applyOp(e, op("e1", "p1", 2, "confirm", { delta: 1 }))!;
		e = applyOp(e, op("e1", "p2", 3, "confirm", { delta: 1 }))!;
		expect(e.provenance.confirmations).toBe(3);
	});

	it("a confirm from BEHIND still counts but does not steal the row", () => {
		let e = applyOp(null, upsert("e1", "p1", 10, "x"))!;
		e = applyOp(e, op("e1", "p2", 4, "confirm", { delta: 1 }))!;
		// Counted...
		expect(e.provenance.confirmations).toBe(2);
		// ...but the version and owner still reflect the latest op.
		expect(e.lamport).toBe(10);
		expect(e.origin_peer).toBe("p1");
	});

	it("a confirm with a bogus delta counts at least one", () => {
		let e = applyOp(null, upsert("e1", "p1", 1, "x"))!;
		e = applyOp(e, op("e1", "p1", 2, "confirm", { delta: 0 }))!;
		e = applyOp(e, op("e1", "p1", 3, "confirm", { delta: -5 }))!;
		// A negative delta from a buggy or hostile peer must not decrement evidence.
		expect(e.provenance.confirmations).toBe(3);
	});

	it("AC-8.19 TOMBSTONE DOMINANCE: a forget at the same clock wins", () => {
		/**
		 * `<` not `<=`, and this asymmetry is the point. "I deleted that and it came back" is the failure
		 * that destroys confidence in a memory system, so a concurrent forget/edit pair resolves to
		 * forgotten. The converse — a revival needing a strictly later clock — is the acceptable cost.
		 */
		const created = applyOp(null, upsert("e1", "p1", 5, "secret-ish fact"))!;
		const forgotten = applyOp(created, op("e1", "p2", 5, "forget"))!;
		expect(forgotten.tombstone).toBe(true);
	});

	it("AC-8.19 a strictly LATER upsert revives, because relearning is legitimate", () => {
		const forgotten = applyOp(applyOp(null, upsert("e1", "p1", 1, "x"))!, op("e1", "p1", 2, "forget"))!;
		expect(forgotten.tombstone).toBe(true);
		const revived = applyOp(forgotten, upsert("e1", "p1", 3, "x learned again"))!;
		expect(revived.tombstone).toBe(false);
		expect(revived.text).toBe("x learned again");
	});

	it("an unknown op kind throws rather than being ignored", () => {
		/**
		 * The worst failure a sync protocol can have is both sides thinking they converged. A future peer
		 * sending an op this build does not model must be loud.
		 */
		const bad = { ...upsert("e1", "p1", 1, "x"), op: "invented" as never };
		expect(() => applyOp(null, bad)).toThrow(/unknown memory op/);
	});
});

describe("convergence (AC-8.18, AC-8.20)", () => {
	/** A realistic two-peer history: creates, edits, confirms, a forget, and a revival. */
	function twoPeerOps(): MemoryLogRecord[] {
		return [
			upsert("a", "mac", 1, "the api lives in packages/core"),
			upsert("b", "talos", 1, "tests run with pnpm vitest"),
			op("a", "talos", 2, "confirm", { delta: 1 }),
			op("b", "mac", 2, "edit", {
				text: "tests run with pnpm test",
				text_norm: "tests run with pnpm test",
			}),
			upsert("c", "mac", 3, "luke prefers concise commits"),
			op("a", "mac", 4, "forget"),
			op("c", "talos", 4, "confirm", { delta: 2 }),
			upsert("a", "talos", 5, "the api lives in packages/core (relearned)"),
			op("b", "talos", 6, "forget"),
		];
	}

	it("AC-8.18 merge(A,B) === merge(B,A) across 100 random interleavings", () => {
		/**
		 * The property Phase 9 rests on. Not "these cases work" but "any order two peers might see produces
		 * the same state" — which is what lets sync be a transport plus this function.
		 */
		const all = twoPeerOps();
		const canonical = digestEntries(foldLog(all).values());
		expect(canonical).toHaveLength(64);

		for (let seed = 1; seed <= 100; seed++) {
			const rand = rng(seed);
			const shuffled = shuffle(all, rand);
			// Split at a random point into two "peer logs".
			const cut = Math.floor(rand() * shuffled.length);
			const a = shuffled.slice(0, cut);
			const b = shuffled.slice(cut);

			const ab = digestEntries(foldLog(mergeLogs(a, b)).values());
			const ba = digestEntries(foldLog(mergeLogs(b, a)).values());

			expect(ab, `seed ${String(seed)}: order dependence`).toBe(ba);
			expect(ab, `seed ${String(seed)}: diverged from canonical`).toBe(canonical);
		}
	});

	it("AC-8.20 replaying a union from empty is byte-identical", () => {
		// What makes a digest comparison meaningful: the fold is pure, so replay reproduces state exactly.
		const all = twoPeerOps();
		const once = foldLog(all);
		const twice = foldLog(mergeLogs(all, all));
		expect(digestEntries(twice.values())).toBe(digestEntries(once.values()));
		// And deduplication by op id means a doubled log does not double a confirm count.
		expect(twice.get("c")?.provenance.confirmations).toBe(once.get("c")?.provenance.confirmations);
	});

	it("AC-8.18 the same op arriving twice by different routes is applied once", () => {
		/**
		 * With more than two peers an op arrives by several paths. Applying a `confirm` twice would double a
		 * count that should have incremented once — so dedupe is by op id, not by content.
		 */
		const create = upsert("x", "p1", 1, "fact");
		const confirm = op("x", "p2", 2, "confirm", { delta: 1 });
		const merged = mergeLogs([create, confirm], [confirm, create]);
		expect(merged).toHaveLength(2);
		expect(foldLog(merged).get("x")?.provenance.confirmations).toBe(2);
	});

	it("AC-8.20 the digest ignores used_in_count, which legitimately differs per peer", () => {
		/**
		 * Each peer counts its OWN injections, so including the counter would report divergence where there
		 * is none — and a convergence test that cries wolf gets muted.
		 */
		const base = applyOp(null, upsert("e1", "p1", 1, "x"))!;
		const busy: MemoryEntry = { ...base, used_in_count: 42 };
		expect(digestEntries([busy])).toBe(digestEntries([base]));
	});

	it("AC-8.20 the digest DOES notice every field that must converge", () => {
		const base = applyOp(null, upsert("e1", "p1", 1, "x"))!;
		const mutations: Partial<MemoryEntry>[] = [
			{ text: "y" },
			{ text_norm: "y" },
			{ scope: "project", project_id: "p_1" },
			{ tombstone: true },
			{ lamport: 2 },
			{ origin_peer: "p2" },
			{ provenance: { ...base.provenance, confirmations: 2 } },
			{ provenance: { ...base.provenance, extracted_by: "turn" } },
		];
		for (const m of mutations) {
			expect(digestEntries([{ ...base, ...m }]), JSON.stringify(m)).not.toBe(digestEntries([base]));
		}
	});

	it("an empty log folds to an empty state with a stable digest", () => {
		expect(foldLog([]).size).toBe(0);
		expect(digestEntries([])).toBe(digestEntries([]));
	});
});

describe("LamportClock", () => {
	it("AC-8.17 is monotonic and strictly advances past anything observed", () => {
		const c = new LamportClock();
		expect(c.tick()).toBe(1);
		expect(c.tick()).toBe(2);
		// An op from elsewhere at 10 means the next local write must be strictly after it.
		c.observe(10);
		expect(c.tick()).toBe(11);
		// A lower observation does not regress the clock.
		c.observe(3);
		expect(c.tick()).toBe(12);
	});

	it("AC-8.17 a clock that only counted local writes would break causality", () => {
		/**
		 * The reason `observe` exists. Two peers each ticking privately both issue "3" for causally ordered
		 * ops, and the tie-break then decides causality by peer id — which is arbitrary, so the result
		 * depends on which machine happens to sort first.
		 */
		const withObserve = new LamportClock();
		withObserve.observe(5);
		expect(withObserve.tick()).toBeGreaterThan(5);

		// Resuming from a persisted value works the same way.
		const resumed = new LamportClock(7);
		expect(resumed.current()).toBe(7);
		expect(resumed.tick()).toBe(8);
	});
});

describe("stale-op paths (DoD: merge at 100% branches)", () => {
	it("a stale EDIT is ignored", async () => {
		/**
		 * The same reasoning as a stale upsert, and it needs its own test because it is a separate branch:
		 * Phase 9 applies ops as they arrive, so an edit that lost a race must not overwrite newer text.
		 */
		const current = applyOp(null, upsert("e1", "p1", 9, "the newer text"))!;
		const stale = applyOp(current, op("e1", "p2", 4, "edit", { text: "older", text_norm: "older" }))!;
		expect(stale.text).toBe("the newer text");
		expect(stale.lamport).toBe(9);
	});

	it("a stale FORGET is ignored, which is the other half of tombstone dominance", () => {
		/**
		 * Dominance is about CONCURRENT ops (equal clocks), not about arbitrarily old ones. A forget from
		 * far behind must not delete an entry that has since been legitimately revived — otherwise a peer
		 * catching up after a week would erase a fact relearned yesterday.
		 */
		const revived = applyOp(null, upsert("e1", "p1", 20, "relearned fact"))!;
		const staleForget = applyOp(revived, op("e1", "p2", 3, "forget"))!;
		expect(staleForget.tombstone).toBe(false);
		expect(staleForget.text).toBe("relearned fact");
	});

	it("an edit and a forget at EQUAL clocks resolve to forgotten", () => {
		// The boundary between the two rules above, asserted directly.
		const created = applyOp(null, upsert("e1", "p1", 5, "x"))!;
		const edited = applyOp(created, op("e1", "p1", 7, "edit", { text: "y", text_norm: "y" }))!;
		const forgotten = applyOp(edited, op("e1", "p2", 7, "forget"))!;
		expect(forgotten.tombstone).toBe(true);
	});

	it("two ops identical in every ordering field compare equal", () => {
		// Reachable when the same op arrives twice; dedupe by id relies on the comparison being stable.
		const a = upsert("e1", "p1", 1, "x");
		expect(compareOps(a, { ...a })).toBe(0);
	});

	it("the digest sorts entries by id, so insertion order cannot change it", () => {
		/**
		 * Two peers materialise the same entries in different orders — one applied `b` first, the other `a`.
		 * Sorting is what makes the digest a function of STATE rather than of history.
		 */
		const a = applyOp(null, upsert("aaa", "p1", 1, "first"))!;
		const b = applyOp(null, upsert("bbb", "p1", 2, "second"))!;
		expect(digestEntries([a, b])).toBe(digestEntries([b, a]));
		// And one entry against itself is stable, covering the equal-id branch of the comparator.
		expect(digestEntries([a, a])).toBe(digestEntries([a, a]));
	});
});

describe("op validation at the trust boundary (review finding F8)", () => {
	it("a malformed op is DROPPED, not thrown on", async () => {
		/**
		 * `applyOp` is what Phase 9 will call on ops from another machine, so it is a trust boundary even though
		 * nothing crosses it yet. Throwing would let one corrupt record from one peer break the whole fold and
		 * make every entry unreadable — dropping bounds the damage to what that peer sent.
		 */
		const { isWellFormedOp, MAX_LAMPORT } = await import("../src/ops/merge.ts");
		const good = applyOp(null, upsert("e1", "p1", 5, "a legitimate fact"))!;

		const malformed: MemoryLogRecord[] = [
			// Text over the cap: the local path enforces 280, the fold path did not.
			upsert("e1", "p1", 6, "x".repeat(281)),
			// A lamport that would win every future conflict, permanently.
			upsert("e1", "p1", Number.MAX_SAFE_INTEGER, "dominant"),
			{ ...upsert("e1", "p1", 7, "x"), lamport: -1 },
			{ ...upsert("e1", "p1", 7, "x"), lamport: MAX_LAMPORT + 1 },
			// A project fact with no project, which the local CHECK constraint forbids.
			upsert("e1", "p1", 8, "x", { scope: "project", project_id: null }),
			// A global fact that names one.
			upsert("e1", "p1", 9, "x", { scope: "global", project_id: "p_1" }),
			{ ...upsert("e1", "p1", 10, "x"), origin_peer: "" },
			{ ...op("e1", "p1", 11, "edit", { text: "y".repeat(400), text_norm: "y" }) },
			{ ...op("e1", "p1", 12, "confirm", { delta: Number.POSITIVE_INFINITY }) },
		];

		for (const bad of malformed) {
			expect(isWellFormedOp(bad), JSON.stringify(bad.payload).slice(0, 60)).toBe(false);
			// The entry survives untouched, so a bad op cannot corrupt good state either.
			expect(applyOp(good, bad)).toEqual(good);
		}
	});

	it("a confirm delta is clamped at BOTH ends", async () => {
		/**
		 * Negative must not decrement evidence, and a huge value must not balloon a counter the UI renders — a
		 * hostile peer sending `delta: 1e15` would produce "confirmed 1000000000000000×" in a list.
		 */
		const { MAX_CONFIRM_DELTA } = await import("../src/ops/merge.ts");
		let e = applyOp(null, upsert("e1", "p1", 1, "x"))!;
		e = applyOp(e, op("e1", "p2", 2, "confirm", { delta: 1e15 }))!;
		expect(e.provenance.confirmations).toBe(1 + MAX_CONFIRM_DELTA);

		e = applyOp(e, op("e1", "p2", 3, "confirm", { delta: -1000 }))!;
		expect(e.provenance.confirmations).toBe(1 + MAX_CONFIRM_DELTA + 1);
	});

	it("a well-formed op still passes", () => {
		// The validator must not be so strict that ordinary traffic is dropped, which would look like sync
		// working while silently discarding everything.
		const ops = [
			upsert("e1", "p1", 1, "a global fact"),
			upsert("e2", "p1", 2, "a project fact", { scope: "project", project_id: "p_1" }),
			op("e1", "p1", 3, "confirm", { delta: 1 }),
			op("e1", "p1", 4, "edit", { text: "a corrected fact", text_norm: "a corrected fact" }),
			op("e1", "p1", 5, "forget"),
		];
		const folded = foldLog(ops);
		expect(folded.size).toBe(2);
		expect(folded.get("e1")?.tombstone).toBe(true);
		expect(folded.get("e2")?.scope).toBe("project");
	});
});
