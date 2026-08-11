import type { MemoryEntry, MemoryLogRecord, MemoryOpKind, MemoryProvenance } from "../types.js";
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
export declare const MAX_OP_TEXT = 280;
export declare const MAX_CONFIRM_DELTA = 1000;
/** Generous but finite: a real clock reaches thousands, not billions. */
export declare const MAX_LAMPORT = 1000000000;
export declare function isWellFormedOp(op: MemoryLogRecord): boolean;
/** Total order over ops. Deterministic and independent of arrival order, which is the whole point. */
export declare function compareOps(a: MemoryLogRecord, b: MemoryLogRecord): number;
/**
 * Folds one op onto an entry.
 *
 * Pure: same inputs, same output, no clock and no randomness. That is what makes replay from an empty
 * store produce byte-identical entries (AC-8.20), which is in turn what makes a digest comparison a
 * meaningful convergence test.
 */
export declare function applyOp(entry: MemoryEntry | null, op: MemoryLogRecord): MemoryEntry | null;
/**
 * Materialises entries from a log.
 *
 * `fold(sort(ops))`. Sorting first is what makes the result independent of arrival order, and it is why
 * `merge(A, B) === merge(B, A)` holds without any per-field reconciliation.
 */
export declare function foldLog(ops: readonly MemoryLogRecord[]): Map<string, MemoryEntry>;
/**
 * Merges two logs.
 *
 * Deduplicated by op id, because the same op may arrive by two routes once Phase 9 has more than two
 * peers — and applying a `confirm` twice would double a count that should have incremented once.
 */
export declare function mergeLogs(a: readonly MemoryLogRecord[], b: readonly MemoryLogRecord[]): MemoryLogRecord[];
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
export declare function digestEntries(entries: Iterable<MemoryEntry>): string;
/**
 * A lamport clock.
 *
 * `max(local, observed) + 1` on every write, where observed includes anything applied from any source.
 * A clock that only counted local writes would let two peers issue the same number for causally
 * ordered ops, and the tie-break would then decide causality by peer id — which is arbitrary.
 */
export declare class LamportClock {
    private value;
    constructor(value?: number);
    current(): number;
    /** Records an op seen from elsewhere, so the next local write is strictly after it. */
    observe(lamport: number): void;
    /** Allocates the next value for a local write. */
    tick(): number;
}
/** Provenance for a manual write, so callers do not assemble it inconsistently. */
export declare function manualProvenance(by: MemoryProvenance["extracted_by"], at: number, chatId?: string | null): MemoryProvenance;
export type { MemoryOpKind };
//# sourceMappingURL=merge.d.ts.map