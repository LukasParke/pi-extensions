import type { DatabaseSync } from "node:sqlite";
import type { MemoryEntry, MemoryEntryWithVector, MemoryLogRecord, MemoryScope } from "../types.js";
/**
 * Memory persistence (R-8.1, R-8.2, R-8.3).
 *
 * ## Why vectors are a BLOB and not an index
 *
 * `node:sqlite` has FTS5 but not `vec0`, so there is no ANN index available without a native extension.
 * Before adding one, the brute-force cost was measured: **10,000 × 384-dimension dot products take
 * 3.3ms p95**, against a 50ms budget for the whole recall.
 *
 * So there is no ANN index, deliberately. That removes a native dependency, a build matrix, and a whole
 * class of index-corruption bugs — an ANN index can silently return wrong neighbours after a partial
 * write, where a linear scan cannot be wrong, only slow. At 100k entries this decision needs revisiting;
 * the scan is the thing to measure then, and `AC-8.2` is the test that will say so.
 *
 * Vectors are read once into a typed array and kept there. Reading 10k BLOBs per query would dominate
 * the budget; the cache is invalidated by the same writes that touch the log.
 */
export interface MemoryStoreOptions {
    db: DatabaseSync;
    /** This daemon's peer id, written into every op so Phase 9 needs no backfill. */
    peerId: string;
    dimensions: number;
    modelId: string;
    now?: () => number;
}
export declare class MemoryStore {
    private readonly db;
    private readonly now;
    readonly peerId: string;
    readonly dimensions: number;
    private readonly getModelId;
    /**
     * All live vectors, kept resident.
     *
     * A `Map` of id → vector rather than one packed array, because entries are forgotten and revived and
     * a packed array would need compaction. At 10k × 384 × 4 bytes the whole set is ~15MB, which is
     * cheaper than the alternative of a per-query read.
     */
    private vectors;
    constructor(opts: MemoryStoreOptions);
    get(id: string): MemoryEntry | null;
    /**
     * Live entries matching a scope filter.
     *
     * The filter is applied in SQL rather than after the fact, because a filter applied after retrieval
     * would return fewer than `k` results whenever the top matches were out of scope — and the user would
     * see an oddly short list with no explanation.
     */
    list(filter: ScopeFilter, opts?: {
        includeTombstones?: boolean;
        limit?: number;
    }): MemoryEntry[];
    /** Exact-normalized lookup within a scope key, the fast dedupe path (R-8.7 step 2). */
    findByNorm(textNorm: string, scope: MemoryScope, projectId: string | null): MemoryEntry | null;
    /** Every live vector, loaded once. */
    liveVectors(): Map<string, Float32Array>;
    /** BM25 candidates from FTS5. */
    searchFts(query: string, filter: ScopeFilter, limit: number): string[];
    stats(): {
        total: number;
        global: number;
        byProject: {
            project_id: string;
            n: number;
        }[];
    };
    /** Entries whose source chat matches, for `forgetAllFromChat`. */
    idsFromChat(chatId: string): string[];
    /**
     * Appends an op and materialises it, in ONE transaction.
     *
     * R-8.3 says the log row is written before the entries row. A transaction makes that ordering
     * meaningful: without it a crash between the two leaves a log that disagrees with state, and the next
     * fold would silently produce something the user did not see. The log is the authority, so it must
     * never be behind.
     */
    applyLocal(op: Omit<MemoryLogRecord, "lamport" | "origin_peer" | "ts"> & {
        lamport: number;
    }, materialise: (existing: MemoryEntry | null) => MemoryEntry | null, vector?: Float32Array): MemoryEntry | null;
    /**
     * Applies an op that came from ANOTHER peer (R-9.6).
     *
     * Three differences from `applyLocal`, and each is a correctness requirement rather than a style choice:
     *
     *  - `origin_peer` and `lamport` come from the op, not from this peer. Rewriting them would destroy the
     *    causality the merge depends on and make the same op look different on every host it passed through.
     *  - the insert is `OR IGNORE` on the op id, so replaying a log is free. Sync retries, and a retry that
     *    duplicated ops would inflate confirmation counts — a fact would look better-established purely
     *    because the network was flaky.
     *  - the vector is computed by the CALLER after the transaction, because embedding is async and a
     *    transaction must not await. A missing vector leaves the entry findable by text and not by meaning,
     *    which is a degradation rather than a loss.
     *
     * Returns whether the op was new, so a caller can report an honest count.
     */
    applyRemote(op: MemoryLogRecord, materialise: (existing: MemoryEntry | null) => MemoryEntry | null, vector?: Float32Array): {
        applied: boolean;
        entry: MemoryEntry | null;
    };
    /** Every op touching an entry, in order, so a remote op folds against full history. */
    opsForEntry(entryId: string): MemoryLogRecord[];
    /**
     * Entries with no vector, for the backfill that follows an ingest.
     *
     * A LEFT JOIN against `memory_vec` rather than a column check: vectors live in their own table, so
     * "missing" means no row rather than a null column. I wrote the column version first and the test
     * failed with `no such column: vector` — which is the useful kind of failure, since a guess that
     * compiled would have silently returned nothing and made the backfill look complete.
     */
    idsMissingVectors(limit?: number): {
        id: string;
        text: string;
    }[];
    /** Attaches a vector to an entry that arrived without one. Not an op: it derives from the text. */
    setVector(id: string, vector: Float32Array, modelId: string): void;
    /** Reads the op log, for merge and for diagnostics. */
    readLog(opts?: {
        since?: number;
        limit?: number;
    }): MemoryLogRecord[];
    private readLogRows;
    /** The highest lamport seen from any peer, so a restarted clock does not reissue numbers. */
    maxObservedLamport(): number;
    /** Bumps the best-effort injection counter. Not an op: losing it is not a correctness bug. */
    noteUsed(ids: readonly string[]): void;
    /** Rebuilds FTS and vectors from entries, for `memory.reindex`. */
    reindexFts(): number;
    private writeEntry;
    /** IMMEDIATE, matching the event store: a deferred transaction can upgrade and deadlock. */
    private tx;
}
export interface ScopeFilter {
    mode: "global" | "project" | "session" | "all";
    project_id?: string | null;
}
/**
 * The scope filter as SQL (R-8.5).
 *
 * The strictness difference between `session` and `project` is deliberate and worth restating: session
 * injection sees globals because that is how a global fact helps every chat, while a UI project filter
 * must not interleave them because a person browsing project memory is asking a narrower question.
 */
export declare function scopeSql(filter: ScopeFilter, prefix?: string): {
    sql: string;
    args: string[];
};
/**
 * A user string as an FTS5 MATCH expression.
 *
 * FTS5's query language treats `"`, `*`, `:`, `^`, `-`, `(`, `)`, `NEAR`, `AND`, `OR` and `NOT` as
 * syntax, so a query containing any of them is either a syntax error or does something the user did not
 * ask for. Every token is quoted and joined with OR, which makes the query a bag of words — which is
 * what BM25 wants anyway.
 *
 * Returns null when nothing usable survives, so the caller skips the sparse leg rather than sending a
 * query that matches everything.
 */
export declare function ftsQuery(raw: string): string | null;
/** Little-endian Float32 BLOB. Explicit, because a platform-dependent encoding is a corrupt index. */
export declare function encodeVector(v: Float32Array): Uint8Array;
export declare function decodeVector(bytes: Uint8Array, dimensions: number): Float32Array | null;
export type { MemoryEntryWithVector };
//# sourceMappingURL=store.d.ts.map