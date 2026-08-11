import type { DatabaseSync } from "node:sqlite";
import { NEAR_DUP_COSINE, NEAR_DUP_JACCARD, normalize } from "./index/normalize.js";
import { MemoryStore, type ScopeFilter } from "./index/store.js";
import { manualProvenance } from "./ops/merge.js";
import type { Embedder, MemoryEntry, MemoryLogRecord, MemoryProvenance, MemoryScope, RecallHit } from "./types.js";
/**
 * The memory engine (R-8.5 … R-8.9).
 *
 * Owns the decisions that are not persistence and not embedding: what counts as the same fact, what
 * gets recalled, and what never enters the store at all.
 *
 * `redact` is INJECTED rather than imported, because the corpus lives in `core` and `memory` may not
 * depend on it — and because a redaction pass that memory owned separately would drift from the one the
 * event log uses. One corpus, two callers.
 */
export interface MemoryEngineOptions {
    db: DatabaseSync;
    peerId: string;
    embedder: Embedder;
    /**
     * The shared redaction filter. Required, not optional: a default of identity would make it possible
     * to construct an engine that quietly stores secrets, which is the one failure this phase cannot have.
     */
    redact: (text: string) => string;
    now?: () => number;
}
/** Retrieval constants from R-8.5. Named so a change shows up in a diff. */
export declare const K_DENSE = 40;
export declare const K_SPARSE = 40;
export declare const DENSE_GATE = 0.25;
export declare class MemoryEngine {
    readonly opts: MemoryEngineOptions;
    readonly store: MemoryStore;
    private readonly clock;
    private readonly embedder;
    private readonly redact;
    private readonly now;
    constructor(opts: MemoryEngineOptions);
    /**
     * Hybrid retrieval (R-8.5, AC-8.4, AC-8.5).
     *
     * Dense and sparse legs, fused by reciprocal rank. The two fail differently, which is the argument for
     * running both: the dense leg finds "login is failing" for a query about authentication, and the sparse
     * leg finds `DEV-412` for a query containing `DEV-412` — where an embedding sees a meaningless token.
     */
    recall(query: string, context: ScopeFilter, limit?: number): Promise<{
        hits: RecallHit[];
        tookMs: number;
    }>;
    /**
     * Adds a proposition, or confirms an existing one (R-8.7, R-8.9).
     *
     * Redaction comes first, before normalize and embed, so a secret never reaches a vector — a vector is
     * not reversible but it is a fingerprint, and an FTS row certainly is.
     */
    add(input: {
        text: string;
        scope: MemoryScope;
        project_id?: string | null;
        extracted_by: MemoryProvenance["extracted_by"];
        source_chat_id?: string | null;
        source_seq?: number | null;
    }): Promise<{
        entry: MemoryEntry;
        deduped: boolean;
    } | null>;
    /**
     * Edits an entry, re-embedding and re-checking for duplicates (R-8.7, AC-8.34).
     *
     * An edit that collides with another live entry FOLDS into it — confirm the survivor, forget the
     * edited id — so correcting a fact into an existing one does not bifurcate the corpus into two rows
     * saying the same thing.
     */
    update(id: string, text: string): Promise<MemoryEntry | null>;
    /** Tombstones. Idempotent, because a user clicking twice is not an error. */
    forget(id: string): boolean;
    /** Forgets everything a chat taught (AC-8.29). The count is what a UI reports. */
    forgetAllFromChat(chatId: string): number;
    private confirm;
    /** Dense neighbours within one scope key, for dedupe. */
    private nearestInScope;
    stats(): {
        total: number;
        global: number;
        by_project: {
            project_id: string;
            n: number;
        }[];
    };
    /** Re-embeds everything, for a model change or a corrupt index. */
    reindex(): Promise<number>;
    /** A pure merge preview, for tests and for Phase 9's handshake. */
    mergePreview(incoming: readonly MemoryLogRecord[]): {
        digest: string;
        entry_count: number;
    };
    /**
     * Ingests ops from another peer (R-9.6, AC-9.26).
     *
     * ## What this is NOT allowed to do
     *
     * It must not decide anything. Which value wins, how a tombstone beats an edit, how confirmations
     * combine — all of that is `applyOp`, tested in Phase 8 with `merge.ts` at 100% branch coverage. If
     * ingest re-implemented any of it, two hosts could fold the same log differently, and the convergence
     * property would be a claim about two functions agreeing rather than about one function.
     *
     * ## The order matters
     *
     * Ops are sorted by the same total order the local fold uses before being applied. Applying in arrival
     * order would give the right final state only because `applyOp` is order-insensitive by design — and
     * relying on that means an ordering bug in a later phase would produce state that is wrong and looks
     * fine. Sorting makes the ingest deterministic on its own terms.
     *
     * ## The clock
     *
     * Every op observed advances the Lamport clock, so the next LOCAL write is strictly after everything
     * this peer has seen. Skipping that would let this host reissue a lamport another host already used, and
     * the tie-break would then be resolved by peer id — silently discarding one of two concurrent facts.
     */
    ingest(ops: readonly MemoryLogRecord[]): {
        applied: number;
        skipped: number;
        rejected: number;
    };
    /**
     * Embeds entries that arrived without a vector (R-9.6).
     *
     * Separate from `ingest` because embedding is async and a transaction must not await, and because an
     * ingest that blocked on the encoder would make sync latency depend on model load time. Until this runs,
     * a synced entry is findable by text and not by meaning — a degradation the sync status reports rather
     * than a loss.
     */
    backfillVectors(limit?: number): Promise<number>;
    /**
     * The highest lamport this peer has observed from anyone (R-9.6).
     *
     * Read from the log rather than from the in-memory clock, because the clock is rebuilt at startup and a
     * restarted peer that reported a lower number would reissue lamports another peer already used.
     */
    maxLamport(): number;
    /**
     * Live entries in a scope, newest first.
     *
     * Delegates to `store.list`, which already takes a `ScopeFilter`. My first version added a second
     * listing query with its own `scope` string — a duplicate that would have drifted from the real one and,
     * worse, bypassed the scope filter that Phase 8's review found compiling to `1 = 1`.
     */
    list(filter: ScopeFilter, opts?: {
        limit?: number;
    }): MemoryEntry[];
    /**
     * How many live entries have no vector yet (R-9.6).
     *
     * Surfaced by `memory.syncStatus` rather than hidden, because these entries are findable by text and not
     * by meaning: a real degradation that looks exactly like a working sync until a user asks a question in
     * their own words.
     */
    awaitingEmbedding(): number;
    /** This peer's log, for Phase 9 to ship. */
    exportLog(since?: number): MemoryLogRecord[];
    noteUsed(ids: readonly string[]): void;
    close(): Promise<void>;
}
/**
 * A ULID-shaped id: sortable by creation, random enough not to collide.
 *
 * Not a UUID, because a memory id appears in a UI list and in `circle memory show <id>` — and a
 * time-sortable id means "the newest entries" is a string sort rather than a join. Crockford base32,
 * lowercased for typing.
 */
export declare function ulid(at: number): string;
export { manualProvenance, NEAR_DUP_COSINE, NEAR_DUP_JACCARD, normalize };
//# sourceMappingURL=engine.d.ts.map