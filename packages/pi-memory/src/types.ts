/**
 * Memory's vocabulary (R-8.2, R-8.3).
 *
 * The shapes are on-disk and cross-peer contracts, so the comments here are about what may never
 * change rather than about what the fields mean.
 */

export type MemoryScope = "global" | "project";

/**
 * One atomic proposition.
 *
 * Not a transcript chunk and not a paragraph — the constraint is the design. A 280-char limit forces
 * one fact per row, which is what makes an entry correctable: a human can read it, judge it, and
 * forget exactly the wrong thing. A paragraph containing one error has no such affordance.
 */
export interface MemoryEntry {
	/** ULID: sortable by creation and stable across peers, which a UUID is not. */
	id: string;
	scope: MemoryScope;
	/** Required when scope is `project`, null otherwise. Set by the engine, never by a model. */
	project_id: string | null;
	/** Already redacted, already normalized for display. ≤ 280 chars. */
	text: string;
	/**
	 * The dedupe key: NFKC, lowercased, whitespace-collapsed, wrapping punctuation stripped.
	 *
	 * Stored rather than computed on read because it is a lookup index — and because normalization is
	 * versioned, so a stored key records which version wrote it.
	 */
	text_norm: string;
	created_at: number;
	updated_at: number;
	/** Forgotten. Excluded from recall and from the UI list by default, never deleted. */
	tombstone: boolean;
	/** Logical clock at the writing peer. Ordering authority for merge; wall clock never is. */
	lamport: number;
	origin_peer: string;
	provenance: MemoryProvenance;
	/** Denormalized counter, best-effort. Not an op-log event: losing a count is not a correctness bug. */
	used_in_count: number;
}

export interface MemoryProvenance {
	source_chat_id: string | null;
	source_seq: number | null;
	learned_at: number;
	/**
	 * Bumped on a dedupe hit. A fact confirmed by five separate turns is more likely true than one
	 * mentioned once, which is information a human triaging the store wants.
	 */
	confirmations: number;
	/**
	 * WHO decided this. `turn` means a model extracted it unprompted; `user` and `cli` mean a human
	 * asked for it. The distinction is what makes granting an agent write access defensible (AC-8.40):
	 * "which of these did the model decide on its own" stays answerable.
	 */
	extracted_by: "turn" | "user" | "cli";
}

/** An entry with its embedding, used inside the engine. The vector never crosses the wire. */
export interface MemoryEntryWithVector extends MemoryEntry {
	embedding: Float32Array;
}

/* --------------------------------- op log --------------------------------- */

export type MemoryOpKind = "upsert" | "confirm" | "edit" | "forget";

export interface MemoryUpsertFields {
	scope: MemoryScope;
	project_id: string | null;
	text: string;
	text_norm: string;
	provenance: MemoryProvenance;
}

/**
 * A mutation, appended before the entries row changes (R-8.3).
 *
 * Phase 9 ships the transport and this shape does not change — which is the whole reason it exists in
 * Phase 8. Sync designed against a sketch becomes a rewrite; sync against a live log with real
 * `(origin_peer, lamport)` is a fold over a union.
 */
export interface MemoryLogRecord {
	/** ULID of the op itself, distinct from the entry it touches. */
	id: string;
	entry_id: string;
	op: MemoryOpKind;
	lamport: number;
	origin_peer: string;
	payload: MemoryOpPayload;
	/**
	 * Wall clock, ADVISORY ONLY. Never used for ordering.
	 *
	 * Two peers with skewed clocks would otherwise converge differently depending on whose clock was
	 * wrong, which is exactly the class of bug a lamport clock exists to remove. The field is kept
	 * because a human debugging a merge wants to know when something happened.
	 */
	ts: number;
}

export type MemoryOpPayload =
	| { fields: MemoryUpsertFields }
	| { delta: number }
	| { text: string; text_norm: string }
	| Record<string, never>;

/* -------------------------------- retrieval -------------------------------- */

export interface RecallContext {
	/** `session` applies the injection rules; `global`/`project` are the stricter UI filters. */
	scope: "global" | "project" | "session" | "all";
	project_id?: string | null;
}

export interface RecallHit {
	entry: MemoryEntry;
	/** Fused RRF score. Not a probability, and not comparable across queries. */
	score: number;
	/** Rank in the dense leg, 1-based, or null when absent from it. */
	dense_rank: number | null;
	/** Rank in the sparse leg. Both are exposed so a bad result can be diagnosed. */
	sparse_rank: number | null;
	/** Raw cosine, for the dense gate and for showing a human why something matched. */
	cosine: number | null;
}

/**
 * Turns text into a vector.
 *
 * An interface rather than a concrete class, so the engine is testable without loading a 22MB model
 * and so the model can be swapped behind a re-index rather than a rewrite. `dimensions` is part of the
 * on-disk contract: a stored vector of the wrong length is a corrupt index, not a slow one.
 */
export interface MemoryLike {
	exportLog(since?: number): MemoryLogRecord[];
	ingest(ops: readonly MemoryLogRecord[]): { applied: number; skipped: number; rejected: number };
	mergePreview(ops: readonly MemoryLogRecord[]): { digest: string; entry_count: number };
	maxLamport(): number;
	backfillVectors(limit?: number): Promise<number>;
	awaitingEmbedding(): number;
}

export interface Embedder {
	readonly dimensions: number;
	/** Stable identifier written alongside vectors, so a model change is detectable. */
	readonly modelId: string;
	/** L2-normalized, so cosine similarity is a dot product. */
	embed(texts: readonly string[]): Promise<Float32Array[]>;
	/** Releases the underlying session. Idempotent. */
	close?(): Promise<void>;
}
