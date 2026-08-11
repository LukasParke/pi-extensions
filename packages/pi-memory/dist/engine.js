import { randomUUID } from "node:crypto";
import { cosine, fuseRankings, isNearDuplicate, MAX_TEXT_LENGTH, NEAR_DUP_COSINE, NEAR_DUP_JACCARD, normalize, } from "./index/normalize.js";
import { MemoryStore } from "./index/store.js";
import { applyOp, compareOps, digestEntries, foldLog, isWellFormedOp, LamportClock, manualProvenance, mergeLogs, } from "./ops/merge.js";
/** Retrieval constants from R-8.5. Named so a change shows up in a diff. */
export const K_DENSE = 40;
export const K_SPARSE = 40;
export const DENSE_GATE = 0.25;
export class MemoryEngine {
    opts;
    store;
    clock;
    embedder;
    redact;
    now;
    constructor(opts) {
        this.opts = opts;
        this.store = new MemoryStore({
            db: opts.db,
            peerId: opts.peerId,
            dimensions: opts.embedder.dimensions,
            get modelId() {
                return opts.embedder.modelId;
            },
            ...(opts.now !== undefined ? { now: opts.now } : {}),
        });
        this.embedder = opts.embedder;
        this.redact = opts.redact;
        this.now = opts.now ?? Date.now;
        /**
         * The clock resumes from the log, not from zero.
         *
         * A restarted daemon that began at 1 would reissue lamport numbers it had already used, and
         * `UNIQUE(origin_peer, lamport)` would reject the write — or worse, in Phase 9, two different ops
         * would claim the same position.
         */
        this.clock = new LamportClock(this.store.maxObservedLamport());
    }
    /* --------------------------------- recall -------------------------------- */
    /**
     * Hybrid retrieval (R-8.5, AC-8.4, AC-8.5).
     *
     * Dense and sparse legs, fused by reciprocal rank. The two fail differently, which is the argument for
     * running both: the dense leg finds "login is failing" for a query about authentication, and the sparse
     * leg finds `DEV-412` for a query containing `DEV-412` — where an embedding sees a meaningless token.
     */
    async recall(query, context, limit = 8) {
        const started = performance.now();
        // Sparse first: it needs no model, so a corpus with no vectors still answers.
        const sparseIds = this.store.searchFts(query, context, K_SPARSE);
        const [queryVector] = await this.embedder.embed([query]);
        const dense = [];
        if (queryVector !== undefined) {
            const eligible = new Set(this.store.list(context, { limit: 100_000 }).map((e) => e.id));
            for (const [id, vec] of this.store.liveVectors()) {
                /**
                 * The scope filter is applied to the CANDIDATE SET, not after fusion.
                 *
                 * Filtering afterwards would return fewer than `limit` results whenever the top matches were out
                 * of scope, and the user would see a short list with no explanation.
                 */
                if (!eligible.has(id))
                    continue;
                dense.push({ id, cosine: cosine(queryVector, vec) });
            }
            dense.sort((a, b) => b.cosine - a.cosine);
            dense.length = Math.min(dense.length, K_DENSE);
        }
        const denseIds = dense.map((d) => d.id);
        const cosById = new Map(dense.map((d) => [d.id, d.cosine]));
        const fused = fuseRankings([denseIds, sparseIds]);
        const denseRank = new Map(denseIds.map((id, i) => [id, i + 1]));
        const sparseRank = new Map(sparseIds.map((id, i) => [id, i + 1]));
        const hits = [];
        for (const [id, score] of fused) {
            const entry = this.store.get(id);
            if (entry === null || entry.tombstone)
                continue;
            const cos = cosById.get(id) ?? null;
            const sRank = sparseRank.get(id) ?? null;
            /**
             * The dense gate, with an exact-token escape hatch (R-8.5 step 5).
             *
             * A weak semantic match is noise, so anything under 0.25 is dropped — EXCEPT when the sparse leg
             * ranked it in its top three, which is how `DEV-412` survives. An embedding has nothing useful to
             * say about a ticket id, and dropping the one result that literally contains the query would be
             * indefensible.
             */
            if (cos !== null && cos < DENSE_GATE && (sRank === null || sRank > 3))
                continue;
            hits.push({
                entry,
                score,
                dense_rank: denseRank.get(id) ?? null,
                sparse_rank: sRank,
                cosine: cos,
            });
        }
        hits.sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : 1));
        return { hits: hits.slice(0, limit), tookMs: performance.now() - started };
    }
    /* ---------------------------------- write --------------------------------- */
    /**
     * Adds a proposition, or confirms an existing one (R-8.7, R-8.9).
     *
     * Redaction comes first, before normalize and embed, so a secret never reaches a vector — a vector is
     * not reversible but it is a fingerprint, and an FTS row certainly is.
     */
    async add(input) {
        const redacted = this.redact(input.text).trim();
        /**
         * A candidate that is empty or only redaction markers is DROPPED.
         *
         * "«redacted:aws-key» is the deploy key" carries no fact worth keeping and would pollute recall with
         * a row that looks like information. Dropping is better than storing a placeholder.
         */
        if (redacted === "" || /^(«redacted:[^»]*»[\s,.:;-]*)+$/.test(redacted))
            return null;
        if (redacted.length > MAX_TEXT_LENGTH)
            return null;
        const scope = input.scope;
        const projectId = scope === "project" ? (input.project_id ?? null) : null;
        /**
         * A project-scoped fact with no project is a contradiction, so it is refused rather than silently
         * promoted to global — promotion would leak one project's facts into every other chat.
         */
        if (scope === "project" && projectId === null)
            return null;
        const textNorm = normalize(redacted);
        if (textNorm === "")
            return null;
        // Exact path first: it is one indexed lookup and catches the common repeat.
        const exact = this.store.findByNorm(textNorm, scope, projectId);
        if (exact !== null)
            return { entry: this.confirm(exact.id), deduped: true };
        const [vector] = await this.embedder.embed([redacted]);
        if (vector === undefined)
            return null;
        // Near-dup path: dense top-5 within the same scope key.
        const nearest = this.nearestInScope(vector, scope, projectId, 5);
        for (const candidate of nearest) {
            const verdict = isNearDuplicate(redacted, candidate.entry.text, vector, candidate.vector);
            if (verdict.duplicate)
                return { entry: this.confirm(candidate.entry.id), deduped: true };
        }
        const at = this.now();
        const provenance = {
            source_chat_id: input.source_chat_id ?? null,
            source_seq: input.source_seq ?? null,
            learned_at: at,
            confirmations: 1,
            extracted_by: input.extracted_by,
        };
        const entryId = ulid(at);
        const entry = this.store.applyLocal({
            id: ulid(at),
            entry_id: entryId,
            op: "upsert",
            lamport: this.clock.tick(),
            payload: {
                fields: { scope, project_id: projectId, text: redacted, text_norm: textNorm, provenance },
            },
        }, (existing) => applyOp(existing, lastOp(this.store, entryId)), vector);
        if (entry === null)
            return null;
        return { entry, deduped: false };
    }
    /**
     * Edits an entry, re-embedding and re-checking for duplicates (R-8.7, AC-8.34).
     *
     * An edit that collides with another live entry FOLDS into it — confirm the survivor, forget the
     * edited id — so correcting a fact into an existing one does not bifurcate the corpus into two rows
     * saying the same thing.
     */
    async update(id, text) {
        const existing = this.store.get(id);
        if (existing === null || existing.tombstone)
            return null;
        const redacted = this.redact(text).trim();
        if (redacted === "" || redacted.length > MAX_TEXT_LENGTH)
            return null;
        const textNorm = normalize(redacted);
        if (textNorm === "")
            return null;
        const [vector] = await this.embedder.embed([redacted]);
        if (vector === undefined)
            return null;
        for (const candidate of this.nearestInScope(vector, existing.scope, existing.project_id, 5)) {
            if (candidate.entry.id === id)
                continue;
            const verdict = isNearDuplicate(redacted, candidate.entry.text, vector, candidate.vector);
            if (verdict.duplicate) {
                // Fold: the survivor gains the confirmation, the edited row is forgotten.
                this.confirm(candidate.entry.id);
                this.forget(id);
                return this.store.get(candidate.entry.id);
            }
        }
        const opId = ulid(this.now());
        return this.store.applyLocal({
            id: opId,
            entry_id: id,
            op: "edit",
            lamport: this.clock.tick(),
            payload: { text: redacted, text_norm: textNorm },
        }, (current) => applyOp(current, lastOp(this.store, id)), vector);
    }
    /** Tombstones. Idempotent, because a user clicking twice is not an error. */
    forget(id) {
        const existing = this.store.get(id);
        if (existing === null)
            return false;
        if (existing.tombstone)
            return true;
        this.store.applyLocal({ id: ulid(this.now()), entry_id: id, op: "forget", lamport: this.clock.tick(), payload: {} }, (current) => applyOp(current, lastOp(this.store, id)));
        return true;
    }
    /** Forgets everything a chat taught (AC-8.29). The count is what a UI reports. */
    forgetAllFromChat(chatId) {
        const ids = this.store.idsFromChat(chatId);
        let n = 0;
        for (const id of ids)
            if (this.forget(id))
                n++;
        return n;
    }
    confirm(id) {
        const result = this.store.applyLocal({
            id: ulid(this.now()),
            entry_id: id,
            op: "confirm",
            lamport: this.clock.tick(),
            payload: { delta: 1 },
        }, (current) => applyOp(current, lastOp(this.store, id)));
        // `applyLocal` returns null only when the entry vanished mid-transaction, which cannot happen inside
        // one IMMEDIATE transaction — but the type says it can, and a non-null assertion would be a lie.
        return result ?? this.store.get(id);
    }
    /** Dense neighbours within one scope key, for dedupe. */
    nearestInScope(vector, scope, projectId, k) {
        const filter = scope === "global" ? { mode: "global" } : { mode: "project", project_id: projectId };
        const eligible = new Map(this.store.list(filter, { limit: 100_000 }).map((e) => [e.id, e]));
        const scored = [];
        for (const [id, vec] of this.store.liveVectors()) {
            const entry = eligible.get(id);
            if (entry === undefined)
                continue;
            scored.push({ entry, vector: vec, cos: cosine(vector, vec) });
        }
        scored.sort((a, b) => b.cos - a.cos);
        return scored.slice(0, k);
    }
    /* --------------------------------- admin --------------------------------- */
    stats() {
        const s = this.store.stats();
        return { total: s.total, global: s.global, by_project: s.byProject };
    }
    /** Re-embeds everything, for a model change or a corrupt index. */
    async reindex() {
        const entries = this.store.list({ mode: "all" }, { limit: 100_000 });
        const live = entries.filter((e) => !e.tombstone);
        this.store.reindexFts();
        for (const batch of chunk(live, 32)) {
            const vectors = await this.embedder.embed(batch.map((e) => e.text));
            for (const [i, entry] of batch.entries()) {
                const v = vectors[i];
                if (v === undefined)
                    continue;
                this.store.applyLocal({
                    id: ulid(this.now()),
                    entry_id: entry.id,
                    op: "edit",
                    lamport: this.clock.tick(),
                    payload: { text: entry.text, text_norm: entry.text_norm },
                }, (current) => applyOp(current, lastOp(this.store, entry.id)), v);
            }
        }
        return live.length;
    }
    /** A pure merge preview, for tests and for Phase 9's handshake. */
    mergePreview(incoming) {
        const merged = mergeLogs(this.store.readLog(), incoming);
        const folded = foldLog(merged);
        return { digest: digestEntries(folded.values()), entry_count: folded.size };
    }
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
    ingest(ops) {
        let applied = 0;
        let skipped = 0;
        let rejected = 0;
        for (const op of [...ops].sort(compareOps)) {
            /**
             * A malformed op is REJECTED at the boundary rather than dropped inside the fold.
             *
             * `applyOp` already ignores one, so nothing would break — but then a peer sending garbage would be
             * indistinguishable from a peer sending nothing, and R-9.6's sync status has to be able to say
             * 'this peer sent 12 ops I refused'. Silence about bad input is how a broken peer stays broken.
             */
            if (!isWellFormedOp(op)) {
                rejected++;
                continue;
            }
            // The clock advances even for an op that turns out to be a duplicate: it was still observed.
            this.clock.observe(op.lamport);
            const res = this.store.applyRemote(op, (existing) => 
            // Folded against the entry's FULL history, including this op, so a late-arriving op that loses to
            // an edit this host already has does not overwrite it.
            applyOp(existing, op) === null ? null : foldEntry(this.store, op.entry_id, op));
            if (res.applied)
                applied++;
            else
                skipped++;
        }
        return { applied, skipped, rejected };
    }
    /**
     * Embeds entries that arrived without a vector (R-9.6).
     *
     * Separate from `ingest` because embedding is async and a transaction must not await, and because an
     * ingest that blocked on the encoder would make sync latency depend on model load time. Until this runs,
     * a synced entry is findable by text and not by meaning — a degradation the sync status reports rather
     * than a loss.
     */
    async backfillVectors(limit = 500) {
        const missing = this.store.idsMissingVectors(limit);
        if (missing.length === 0)
            return 0;
        const vectors = await this.embedder.embed(missing.map((m) => m.text));
        let done = 0;
        for (const [i, row] of missing.entries()) {
            const v = vectors[i];
            if (v === undefined)
                continue;
            this.store.setVector(row.id, v, this.embedder.modelId);
            done++;
        }
        return done;
    }
    /**
     * The highest lamport this peer has observed from anyone (R-9.6).
     *
     * Read from the log rather than from the in-memory clock, because the clock is rebuilt at startup and a
     * restarted peer that reported a lower number would reissue lamports another peer already used.
     */
    maxLamport() {
        return this.store.maxObservedLamport();
    }
    /**
     * Live entries in a scope, newest first.
     *
     * Delegates to `store.list`, which already takes a `ScopeFilter`. My first version added a second
     * listing query with its own `scope` string — a duplicate that would have drifted from the real one and,
     * worse, bypassed the scope filter that Phase 8's review found compiling to `1 = 1`.
     */
    list(filter, opts = {}) {
        return this.store.list(filter, opts);
    }
    /**
     * How many live entries have no vector yet (R-9.6).
     *
     * Surfaced by `memory.syncStatus` rather than hidden, because these entries are findable by text and not
     * by meaning: a real degradation that looks exactly like a working sync until a user asks a question in
     * their own words.
     */
    awaitingEmbedding() {
        return this.store.idsMissingVectors(100_000).length;
    }
    /** This peer's log, for Phase 9 to ship. */
    exportLog(since) {
        return this.store.readLog(since !== undefined ? { since } : {});
    }
    noteUsed(ids) {
        this.store.noteUsed(ids);
    }
    async close() {
        await this.embedder.close?.();
    }
}
/* -------------------------------- helpers -------------------------------- */
/**
 * Folds one entry from its complete op history.
 *
 * Used by ingest rather than applying the incoming op to current state. The difference shows up with a
 * late arrival: an op with a low lamport that reaches this host after a higher-lamport edit must LOSE, and
 * it only loses if the fold sees both. Applying it to current state would let arrival order decide, which
 * is exactly what a CRDT exists to prevent.
 */
function foldEntry(store, entryId, incoming) {
    const ops = store.opsForEntry(entryId);
    const all = ops.some((o) => o.id === incoming.id) ? ops : [...ops, incoming];
    return foldLog(all).get(entryId) ?? null;
}
/**
 * The last op written for an entry.
 *
 * `applyLocal` inserts the log row and then asks for the materialised entry, so the materialiser needs
 * the op it just wrote. Reading it back rather than passing it through keeps the log as the single
 * authority: if the row on disk differs from what was intended, the entry follows the row.
 */
function lastOp(store, entryId) {
    const log = store.readLog({ limit: 100_000 });
    const forEntry = log.filter((o) => o.entry_id === entryId);
    const last = forEntry[forEntry.length - 1];
    if (last === undefined)
        throw new Error(`no op for entry ${entryId}`);
    return last;
}
/**
 * A ULID-shaped id: sortable by creation, random enough not to collide.
 *
 * Not a UUID, because a memory id appears in a UI list and in `circle memory show <id>` — and a
 * time-sortable id means "the newest entries" is a string sort rather than a join. Crockford base32,
 * lowercased for typing.
 */
export function ulid(at) {
    const time = at.toString(32).padStart(10, "0");
    const rand = randomUUID().replaceAll("-", "").slice(0, 16);
    return `${time}${rand}`;
}
function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size)
        out.push(items.slice(i, i + size));
    return out;
}
export { manualProvenance, NEAR_DUP_COSINE, NEAR_DUP_JACCARD, normalize };
//# sourceMappingURL=engine.js.map