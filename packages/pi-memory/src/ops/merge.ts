import { createHash } from "node:crypto";
import type {
	MemoryEntry,
	MemoryLogRecord,
	MemoryOpKind,
	MemoryProvenance,
	MemoryUpsertFields,
} from "../types.js";

/**
 * The merge function Phase 9 turns into sync (R-8.3, §2.5).
 *
 * ## Why this exists in Phase 8
 *
 * Because `merge(A, B) === merge(B, A)` is a property of a pure function over two logs, and proving it
 * needs no network. Phase 9 then ships a transport and calls this — as opposed to designing sync
 * against a sketch, discovering the log shape is wrong, and migrating live user data.
 *
 * ## The ordering rule
 *
 * `(lamport, origin_peer, op_id)`. Lamport first, because it is causal: an op that observed another has
 * a strictly greater clock. Ties broken by peer id, then op id, both of which are arbitrary but
 * *total* — and total is the only property tie-breaking needs. Wall clock is never consulted, because
 * two peers with skewed clocks would converge differently depending on whose clock was wrong.
 *
 * ## Why fold rather than CRDT machinery
 *
 * The entry is small and its fields are last-writer-wins with one exception (tombstones, below). A
 * register CRDT per field would be more general and would buy nothing here: there is no field where
 * two concurrent values need preserving. `confirmations` is the one counter, and it is handled as a
 * counter rather than a register — see `applyOp`.
 */

/**
 * Bounds on an incoming op (review finding F8).
 *
 * `applyOp` is the function Phase 9 will call on ops from ANOTHER MACHINE, so it is a trust boundary even
 * though nothing crosses it yet. A hostile or buggy peer could otherwise send:
 *
 *  - a 10MB `text`, which the local write path caps at 280 but the fold path did not;
 *  - `confirm` with `delta: 1e15`, ballooning a counter the UI renders;
 *  - `lamport: Number.MAX_SAFE_INTEGER`, winning every future conflict until local clocks catch up —
 *    effectively permanent dominance over one entry.
 *
 * Validating at fold time rather than at receive time is deliberate: receive is Phase 9's code and does not
 * exist, and a check that lives only there could be bypassed by any other caller of `foldLog`.
 */
export const MAX_OP_TEXT = 280;
export const MAX_CONFIRM_DELTA = 1000;
/** Generous but finite: a real clock reaches thousands, not billions. */
export const MAX_LAMPORT = 1_000_000_000;

export function isWellFormedOp(op: MemoryLogRecord): boolean {
	if (!Number.isSafeInteger(op.lamport) || op.lamport < 0 || op.lamport > MAX_LAMPORT) return false;
	if (op.entry_id === "" || op.origin_peer === "") return false;

	if (op.op === "upsert") {
		const fields = (op.payload as { fields?: MemoryUpsertFields }).fields;
		if (fields === undefined) return false;
		if (typeof fields.text !== "string" || fields.text.length > MAX_OP_TEXT) return false;
		if (fields.scope !== "global" && fields.scope !== "project") return false;
		// The same invariant the local CHECK constraint enforces: a project fact names its project.
		if (fields.scope === "project" && (fields.project_id ?? null) === null) return false;
		if (fields.scope === "global" && (fields.project_id ?? null) !== null) return false;
	}
	if (op.op === "edit") {
		const text = (op.payload as { text?: string }).text;
		if (typeof text !== "string" || text.length > MAX_OP_TEXT) return false;
	}
	if (op.op === "confirm") {
		const delta = (op.payload as { delta?: number }).delta;
		if (typeof delta !== "number" || !Number.isFinite(delta)) return false;
	}
	return true;
}

/** Total order over ops. Deterministic and independent of arrival order, which is the whole point. */
export function compareOps(a: MemoryLogRecord, b: MemoryLogRecord): number {
	if (a.lamport !== b.lamport) return a.lamport - b.lamport;
	if (a.origin_peer !== b.origin_peer) return a.origin_peer < b.origin_peer ? -1 : 1;
	if (a.id !== b.id) return a.id < b.id ? -1 : 1;
	return 0;
}

/**
 * Folds one op onto an entry.
 *
 * Pure: same inputs, same output, no clock and no randomness. That is what makes replay from an empty
 * store produce byte-identical entries (AC-8.20), which is in turn what makes a digest comparison a
 * meaningful convergence test.
 */
export function applyOp(entry: MemoryEntry | null, op: MemoryLogRecord): MemoryEntry | null {
	/**
	 * A malformed op is DROPPED, not thrown on.
	 *
	 * Throwing would let one bad op from one peer break the whole fold, so a single corrupt record would
	 * make every entry unreadable. Dropping means the peer's other ops still apply and the damage is bounded
	 * to what it actually sent.
	 */
	if (!isWellFormedOp(op)) return entry;

	switch (op.op) {
		case "upsert": {
			const fields = (op.payload as { fields: MemoryUpsertFields }).fields;

			if (entry === null) {
				return {
					id: op.entry_id,
					scope: fields.scope,
					project_id: fields.project_id,
					text: fields.text,
					text_norm: fields.text_norm,
					created_at: op.ts,
					updated_at: op.ts,
					tombstone: false,
					lamport: op.lamport,
					origin_peer: op.origin_peer,
					provenance: fields.provenance,
					used_in_count: 0,
				};
			}

			/**
			 * An upsert with a lower clock than what we have is STALE and ignored.
			 *
			 * Without this, replaying a union in sorted order still converges but an out-of-order single
			 * application would not — and Phase 9 will apply ops as they arrive, not only in batches. The
			 * check makes each application independently safe.
			 */
			if (op.lamport < entry.lamport) return entry;

			/**
			 * An upsert REVIVES a tombstone only if it is strictly later.
			 *
			 * The alternative — tombstones are permanent — loses a legitimate case: a fact forgotten and then
			 * learned again should come back. Requiring a strictly greater clock means a concurrent
			 * forget/upsert pair resolves to the forget (see AC-8.19), because the forget wins ties.
			 */
			return {
				...entry,
				scope: fields.scope,
				project_id: fields.project_id,
				text: fields.text,
				text_norm: fields.text_norm,
				updated_at: op.ts,
				tombstone: false,
				lamport: op.lamport,
				origin_peer: op.origin_peer,
				provenance: fields.provenance,
			};
		}

		case "edit": {
			// An edit to an entry we have never seen is dropped: there is nothing to edit, and inventing a
			// row from an edit would produce an entry with no provenance.
			if (entry === null) return null;
			if (op.lamport < entry.lamport) return entry;
			const { text, text_norm } = op.payload as { text: string; text_norm: string };
			return {
				...entry,
				text,
				text_norm,
				updated_at: op.ts,
				lamport: op.lamport,
				origin_peer: op.origin_peer,
			};
		}

		case "confirm": {
			if (entry === null) return null;
			/**
			 * A COUNTER, not a register — and this is the one place the distinction matters.
			 *
			 * Two peers each confirming the same fact should produce two confirmations, not one: the count is
			 * evidence, and last-writer-wins would discard half of it. So `delta` accumulates regardless of
			 * clock order, and the clock is only advanced (never regressed) so the entry's version still
			 * reflects the latest op that touched it.
			 */
			const delta = (op.payload as { delta: number }).delta;
			return {
				...entry,
				provenance: {
					...entry.provenance,
					// Clamped at both ends: a negative delta must not decrement evidence, and a huge one must not
					// balloon a counter the UI renders as "confirmed 1000000000×".
					confirmations: entry.provenance.confirmations + Math.min(MAX_CONFIRM_DELTA, Math.max(1, delta)),
				},
				updated_at: Math.max(entry.updated_at, op.ts),
				lamport: Math.max(entry.lamport, op.lamport),
				// The peer that wrote the LATEST op owns the row, so a confirm from behind does not steal it.
				origin_peer: op.lamport >= entry.lamport ? op.origin_peer : entry.origin_peer,
			};
		}

		case "forget": {
			if (entry === null) return null;
			/**
			 * TOMBSTONE DOMINANCE (AC-8.19).
			 *
			 * `<` not `<=`: a forget at the same clock as an existing op still wins. That is deliberate and
			 * it is the asymmetry that makes forgetting trustworthy — a user who forgets something
			 * concurrently with an edit on another peer must not find it back. "I deleted that and it
			 * returned" is the failure that destroys confidence in a memory system, and it is worse than the
			 * converse (a revival needing a strictly later clock).
			 */
			if (op.lamport < entry.lamport) return entry;
			return {
				...entry,
				tombstone: true,
				updated_at: op.ts,
				lamport: op.lamport,
				origin_peer: op.origin_peer,
			};
		}

		default: {
			/**
			 * Exhaustiveness, checked at compile time.
			 *
			 * A new op kind must be handled here or the build fails. A `default: return entry` would silently
			 * ignore an op a future peer sends — which is the worst possible failure for a sync protocol,
			 * because both sides think they converged.
			 */
			const never: never = op.op;
			throw new Error(`unknown memory op: ${String(never)}`);
		}
	}
}

/**
 * Materialises entries from a log.
 *
 * `fold(sort(ops))`. Sorting first is what makes the result independent of arrival order, and it is why
 * `merge(A, B) === merge(B, A)` holds without any per-field reconciliation.
 */
export function foldLog(ops: readonly MemoryLogRecord[]): Map<string, MemoryEntry> {
	const sorted = [...ops].sort(compareOps);
	const out = new Map<string, MemoryEntry>();

	for (const op of sorted) {
		const current = out.get(op.entry_id) ?? null;
		const next = applyOp(current, op);
		if (next !== null) out.set(op.entry_id, next);
	}
	return out;
}

/**
 * Merges two logs.
 *
 * Deduplicated by op id, because the same op may arrive by two routes once Phase 9 has more than two
 * peers — and applying a `confirm` twice would double a count that should have incremented once.
 */
export function mergeLogs(a: readonly MemoryLogRecord[], b: readonly MemoryLogRecord[]): MemoryLogRecord[] {
	const byId = new Map<string, MemoryLogRecord>();
	for (const op of [...a, ...b]) byId.set(op.id, op);
	return [...byId.values()].sort(compareOps);
}

/**
 * A canonical digest of materialised state (AC-8.18, AC-8.20).
 *
 * Field order is fixed and explicit rather than `JSON.stringify(entry)`, because key order in an object
 * literal is an implementation detail that would make two identical states digest differently. Entries
 * are sorted by id for the same reason.
 *
 * `used_in_count` is EXCLUDED: it is a best-effort local counter that legitimately differs between
 * peers (each counts its own injections), so including it would report divergence where there is none.
 */
export function digestEntries(entries: Iterable<MemoryEntry>): string {
	const sorted = [...entries].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
	const h = createHash("sha256");

	for (const e of sorted) {
		h.update(
			[
				e.id,
				e.scope,
				e.project_id ?? "",
				e.text,
				e.text_norm,
				e.tombstone ? "1" : "0",
				String(e.lamport),
				e.origin_peer,
				String(e.provenance.confirmations),
				e.provenance.source_chat_id ?? "",
				e.provenance.extracted_by,
			].join("\u0001"),
		);
		h.update("\u0002");
	}
	return h.digest("hex");
}

/**
 * A lamport clock.
 *
 * `max(local, observed) + 1` on every write, where observed includes anything applied from any source.
 * A clock that only counted local writes would let two peers issue the same number for causally
 * ordered ops, and the tie-break would then decide causality by peer id — which is arbitrary.
 */
export class LamportClock {
	constructor(private value = 0) {}

	current(): number {
		return this.value;
	}

	/** Records an op seen from elsewhere, so the next local write is strictly after it. */
	observe(lamport: number): void {
		if (lamport > this.value) this.value = lamport;
	}

	/** Allocates the next value for a local write. */
	tick(): number {
		this.value += 1;
		return this.value;
	}
}

/** Provenance for a manual write, so callers do not assemble it inconsistently. */
export function manualProvenance(
	by: MemoryProvenance["extracted_by"],
	at: number,
	chatId: string | null = null,
): MemoryProvenance {
	return {
		source_chat_id: chatId,
		source_seq: null,
		learned_at: at,
		confirmations: 1,
		extracted_by: by,
	};
}

export type { MemoryOpKind };
