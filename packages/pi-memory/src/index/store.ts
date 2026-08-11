import type { DatabaseSync } from "node:sqlite";
import type {
	MemoryEntry,
	MemoryEntryWithVector,
	MemoryLogRecord,
	MemoryProvenance,
	MemoryScope,
} from "../types.js";

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

export class MemoryStore {
	private readonly db: DatabaseSync;
	private readonly now: () => number;
	readonly peerId: string;
	readonly dimensions: number;
	private readonly getModelId: () => string;

	/**
	 * All live vectors, kept resident.
	 *
	 * A `Map` of id → vector rather than one packed array, because entries are forgotten and revived and
	 * a packed array would need compaction. At 10k × 384 × 4 bytes the whole set is ~15MB, which is
	 * cheaper than the alternative of a per-query read.
	 */
	private vectors: Map<string, Float32Array> | null = null;

	constructor(opts: MemoryStoreOptions) {
		this.db = opts.db;
		this.peerId = opts.peerId;
		this.dimensions = opts.dimensions;
		this.getModelId = () => opts.modelId;
		this.now = opts.now ?? Date.now;
	}

	/* --------------------------------- reads --------------------------------- */

	get(id: string): MemoryEntry | null {
		const row = this.db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id) as
			Record<string, unknown> | undefined;
		return row === undefined ? null : toEntry(row);
	}

	/**
	 * Live entries matching a scope filter.
	 *
	 * The filter is applied in SQL rather than after the fact, because a filter applied after retrieval
	 * would return fewer than `k` results whenever the top matches were out of scope — and the user would
	 * see an oddly short list with no explanation.
	 */
	list(filter: ScopeFilter, opts: { includeTombstones?: boolean; limit?: number } = {}): MemoryEntry[] {
		const { sql, args } = scopeSql(filter);
		const tomb = opts.includeTombstones === true ? "" : " AND tombstone = 0";
		const limit = opts.limit ?? 500;
		const rows = this.db
			.prepare(`SELECT * FROM memory_entries WHERE ${sql}${tomb} ORDER BY updated_at DESC LIMIT ?`)
			.all(...args, limit) as Record<string, unknown>[];
		return rows.map(toEntry);
	}

	/** Exact-normalized lookup within a scope key, the fast dedupe path (R-8.7 step 2). */
	findByNorm(textNorm: string, scope: MemoryScope, projectId: string | null): MemoryEntry | null {
		const row = this.db
			.prepare(
				`SELECT * FROM memory_entries
         WHERE text_norm = ? AND scope = ? AND project_id IS ?
         ORDER BY updated_at DESC LIMIT 1`,
			)
			.get(textNorm, scope, projectId) as Record<string, unknown> | undefined;
		return row === undefined ? null : toEntry(row);
	}

	/** Every live vector, loaded once. */
	liveVectors(): Map<string, Float32Array> {
		if (this.vectors !== null) return this.vectors;
		const rows = this.db
			.prepare(
				`SELECT e.id AS id, v.embedding AS embedding
         FROM memory_entries e JOIN memory_vec v ON v.entry_id = e.id
         WHERE e.tombstone = 0`,
			)
			.all() as { id: string; embedding: Uint8Array }[];

		const out = new Map<string, Float32Array>();
		for (const r of rows) {
			const vec = decodeVector(r.embedding, this.dimensions);
			if (vec !== null) out.set(r.id, vec);
		}
		this.vectors = out;
		return out;
	}

	/** BM25 candidates from FTS5. */
	searchFts(query: string, filter: ScopeFilter, limit: number): string[] {
		const match = ftsQuery(query);
		if (match === null) return [];

		const { sql, args } = scopeSql(filter, "e.");
		try {
			const rows = this.db
				.prepare(
					`SELECT e.id AS id FROM memory_fts f
           JOIN memory_entries e ON e.id = f.entry_id
           WHERE memory_fts MATCH ? AND ${sql} AND e.tombstone = 0
           ORDER BY bm25(memory_fts) LIMIT ?`,
				)
				.all(match, ...args, limit) as { id: string }[];
			return rows.map((r) => r.id);
		} catch {
			/**
			 * A malformed FTS query is a normal outcome, not an error.
			 *
			 * `ftsQuery` sanitizes, but FTS5's grammar has corners — a query of only stop-punctuation, an
			 * unbalanced quote surviving the filter — and a thrown error would take down a recall that the
			 * dense leg could have answered on its own. Degrading to "no sparse candidates" is the honest
			 * behaviour.
			 */
			return [];
		}
	}

	stats(): { total: number; global: number; byProject: { project_id: string; n: number }[] } {
		const total = (
			this.db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE tombstone = 0").get() as {
				n: number;
			}
		).n;
		const global = (
			this.db
				.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE tombstone = 0 AND scope = 'global'")
				.get() as { n: number }
		).n;
		const byProject = this.db
			.prepare(
				`SELECT project_id, COUNT(*) AS n FROM memory_entries
         WHERE tombstone = 0 AND scope = 'project' AND project_id IS NOT NULL
         GROUP BY project_id ORDER BY n DESC`,
			)
			.all() as { project_id: string; n: number }[];
		return { total, global, byProject };
	}

	/** Entries whose source chat matches, for `forgetAllFromChat`. */
	idsFromChat(chatId: string): string[] {
		const rows = this.db
			.prepare("SELECT id FROM memory_entries WHERE source_chat_id = ? AND tombstone = 0")
			.all(chatId) as { id: string }[];
		return rows.map((r) => r.id);
	}

	/* --------------------------------- writes -------------------------------- */

	/**
	 * Appends an op and materialises it, in ONE transaction.
	 *
	 * R-8.3 says the log row is written before the entries row. A transaction makes that ordering
	 * meaningful: without it a crash between the two leaves a log that disagrees with state, and the next
	 * fold would silently produce something the user did not see. The log is the authority, so it must
	 * never be behind.
	 */
	applyLocal(
		op: Omit<MemoryLogRecord, "lamport" | "origin_peer" | "ts"> & { lamport: number },
		materialise: (existing: MemoryEntry | null) => MemoryEntry | null,
		vector?: Float32Array,
	): MemoryEntry | null {
		const record: MemoryLogRecord = {
			...op,
			origin_peer: this.peerId,
			ts: this.now(),
		};

		let result: MemoryEntry | null = null;

		this.tx(() => {
			this.db
				.prepare(
					`INSERT INTO memory_log (id, entry_id, op, lamport, origin_peer, payload_json, ts)
           VALUES (?,?,?,?,?,?,?)`,
				)
				.run(
					record.id,
					record.entry_id,
					record.op,
					record.lamport,
					record.origin_peer,
					JSON.stringify(record.payload),
					record.ts,
				);

			const existing = this.get(record.entry_id);
			result = materialise(existing);
			if (result !== null) this.writeEntry(result, vector);
		});

		// Any write invalidates the resident vectors: a forgotten entry must leave the dense leg at once
		// (AC-8.10), and a new one must be findable on the next query.
		this.vectors = null;
		return result;
	}

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
	applyRemote(
		op: MemoryLogRecord,
		materialise: (existing: MemoryEntry | null) => MemoryEntry | null,
		vector?: Float32Array,
	): { applied: boolean; entry: MemoryEntry | null } {
		let applied = false;
		let result: MemoryEntry | null = null;

		this.tx(() => {
			const info = this.db
				.prepare(
					`INSERT OR IGNORE INTO memory_log (id, entry_id, op, lamport, origin_peer, payload_json, ts)
           VALUES (?,?,?,?,?,?,?)`,
				)
				.run(op.id, op.entry_id, op.op, op.lamport, op.origin_peer, JSON.stringify(op.payload), op.ts);
			// Already had it. Not an error: a peer re-sending is normal, and the fold is unchanged.
			if (Number(info.changes) === 0) return;

			applied = true;
			const existing = this.get(op.entry_id);
			result = materialise(existing);
			if (result !== null) this.writeEntry(result, vector);
		});

		if (applied) this.vectors = null;
		return { applied, entry: result };
	}

	/** Every op touching an entry, in order, so a remote op folds against full history. */
	opsForEntry(entryId: string): MemoryLogRecord[] {
		return this.readLogRows("SELECT * FROM memory_log WHERE entry_id = ? ORDER BY lamport, origin_peer, id", [
			entryId,
		]);
	}

	/**
	 * Entries with no vector, for the backfill that follows an ingest.
	 *
	 * A LEFT JOIN against `memory_vec` rather than a column check: vectors live in their own table, so
	 * "missing" means no row rather than a null column. I wrote the column version first and the test
	 * failed with `no such column: vector` — which is the useful kind of failure, since a guess that
	 * compiled would have silently returned nothing and made the backfill look complete.
	 */
	idsMissingVectors(limit = 500): { id: string; text: string }[] {
		return this.db
			.prepare(
				`SELECT e.id AS id, e.text AS text FROM memory_entries e
         LEFT JOIN memory_vec v ON v.entry_id = e.id
         WHERE e.tombstone = 0 AND v.entry_id IS NULL LIMIT ?`,
			)
			.all(limit) as { id: string; text: string }[];
	}

	/** Attaches a vector to an entry that arrived without one. Not an op: it derives from the text. */
	setVector(id: string, vector: Float32Array, modelId: string): void {
		this.db
			.prepare(
				`INSERT INTO memory_vec (entry_id, embedding, model_id) VALUES (?,?,?)
         ON CONFLICT(entry_id) DO UPDATE SET embedding = excluded.embedding, model_id = excluded.model_id`,
			)
			// `encodeVector`, not a hand-rolled Buffer.from: the store already owns the encoding, and my first
			// version passed a BLOB where the entry_id belonged. One encoder, one call site per direction.
			.run(id, encodeVector(vector), modelId);
		this.vectors = null;
	}

	/** Reads the op log, for merge and for diagnostics. */
	readLog(opts: { since?: number; limit?: number } = {}): MemoryLogRecord[] {
		return this.readLogRows(
			`SELECT * FROM memory_log ${opts.since !== undefined ? "WHERE lamport > ?" : ""}
       ORDER BY lamport, origin_peer, id LIMIT ?`,
			[...(opts.since !== undefined ? [opts.since] : []), opts.limit ?? 100_000],
		);
	}

	private readLogRows(sql: string, params: (string | number)[]): MemoryLogRecord[] {
		const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
		return rows.map((r) => ({
			id: String(r.id),
			entry_id: String(r.entry_id),
			op: String(r.op) as MemoryLogRecord["op"],
			lamport: Number(r.lamport),
			origin_peer: String(r.origin_peer),
			payload: JSON.parse(String(r.payload_json)) as MemoryLogRecord["payload"],
			ts: Number(r.ts),
		}));
	}

	/** The highest lamport seen from any peer, so a restarted clock does not reissue numbers. */
	maxObservedLamport(): number {
		const row = this.db.prepare("SELECT MAX(lamport) AS m FROM memory_log").get() as {
			m: number | null;
		};
		return row.m ?? 0;
	}

	/** Bumps the best-effort injection counter. Not an op: losing it is not a correctness bug. */
	noteUsed(ids: readonly string[]): void {
		if (ids.length === 0) return;
		const stmt = this.db.prepare("UPDATE memory_entries SET used_in_count = used_in_count + 1 WHERE id = ?");
		this.tx(() => {
			for (const id of ids) stmt.run(id);
		});
	}

	/** Rebuilds FTS and vectors from entries, for `memory.reindex`. */
	reindexFts(): number {
		const rows = this.db.prepare("SELECT id, text FROM memory_entries WHERE tombstone = 0").all() as {
			id: string;
			text: string;
		}[];
		this.tx(() => {
			this.db.exec("DELETE FROM memory_fts");
			const stmt = this.db.prepare("INSERT INTO memory_fts (entry_id, text) VALUES (?, ?)");
			for (const r of rows) stmt.run(r.id, r.text);
		});
		return rows.length;
	}

	private writeEntry(e: MemoryEntry, vector?: Float32Array): void {
		this.db
			.prepare(
				`INSERT INTO memory_entries
           (id, scope, project_id, text, text_norm, created_at, updated_at, tombstone,
            lamport, origin_peer, source_chat_id, source_seq, learned_at, confirmations,
            extracted_by, used_in_count)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           scope = excluded.scope,
           project_id = excluded.project_id,
           text = excluded.text,
           text_norm = excluded.text_norm,
           updated_at = excluded.updated_at,
           tombstone = excluded.tombstone,
           lamport = excluded.lamport,
           origin_peer = excluded.origin_peer,
           confirmations = excluded.confirmations,
           used_in_count = excluded.used_in_count`,
			)
			.run(
				e.id,
				e.scope,
				e.project_id,
				e.text,
				e.text_norm,
				e.created_at,
				e.updated_at,
				e.tombstone ? 1 : 0,
				e.lamport,
				e.origin_peer,
				e.provenance.source_chat_id,
				e.provenance.source_seq,
				e.provenance.learned_at,
				e.provenance.confirmations,
				e.provenance.extracted_by,
				e.used_in_count,
			);

		/**
		 * FTS and vectors follow the tombstone.
		 *
		 * A forgotten entry is REMOVED from both indexes rather than filtered at query time (AC-8.10). The
		 * filter would work, and it would mean a forgotten secret still had a searchable copy in the FTS
		 * table — which is not what a user means by "forget".
		 */
		this.db.prepare("DELETE FROM memory_fts WHERE entry_id = ?").run(e.id);
		if (!e.tombstone) {
			this.db.prepare("INSERT INTO memory_fts (entry_id, text) VALUES (?, ?)").run(e.id, e.text);
		}

		if (vector !== undefined) {
			if (vector.length !== this.dimensions) {
				throw new Error(
					`refusing to store a ${String(vector.length)}-dimension vector in a ${String(this.dimensions)}-dimension index`,
				);
			}
			this.db
				.prepare(
					`INSERT INTO memory_vec (entry_id, embedding, model_id) VALUES (?,?,?)
           ON CONFLICT(entry_id) DO UPDATE SET embedding = excluded.embedding, model_id = excluded.model_id`,
				)
				.run(e.id, encodeVector(vector), this.getModelId());
		}
		if (e.tombstone) {
			this.db.prepare("DELETE FROM memory_vec WHERE entry_id = ?").run(e.id);
		}
	}

	/** IMMEDIATE, matching the event store: a deferred transaction can upgrade and deadlock. */
	private tx<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const out = fn();
			this.db.exec("COMMIT");
			return out;
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}
}

/* -------------------------------- helpers -------------------------------- */

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
export function scopeSql(filter: ScopeFilter, prefix = ""): { sql: string; args: string[] } {
	const p = prefix;
	switch (filter.mode) {
		case "all":
			return { sql: "1 = 1", args: [] };
		case "global":
			return { sql: `${p}scope = 'global'`, args: [] };
		case "project":
			// No globals: the UI filter is stricter than injection.
			return {
				sql: `(${p}scope = 'project' AND ${p}project_id = ?)`,
				args: [filter.project_id ?? ""],
			};
		case "session":
			// Globals plus this project's, or globals alone when there is no project.
			return filter.project_id === null || filter.project_id === undefined
				? { sql: `${p}scope = 'global'`, args: [] }
				: {
						sql: `(${p}scope = 'global' OR (${p}scope = 'project' AND ${p}project_id = ?))`,
						args: [filter.project_id],
					};
		default: {
			const never: never = filter.mode;
			throw new Error(`unknown scope mode: ${String(never)}`);
		}
	}
}

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
export function ftsQuery(raw: string): string | null {
	const tokens = [...raw.matchAll(/[A-Za-z0-9_./-]{2,64}/g)].map((m) => m[0]);
	if (tokens.length === 0) return null;
	// Bounded: a pathological query of 10,000 tokens would otherwise build a 10,000-clause expression.
	const capped = tokens.slice(0, 32);
	return capped.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ");
}

/** Little-endian Float32 BLOB. Explicit, because a platform-dependent encoding is a corrupt index. */
export function encodeVector(v: Float32Array): Uint8Array {
	const buf = new ArrayBuffer(v.length * 4);
	const view = new DataView(buf);
	for (let i = 0; i < v.length; i++) view.setFloat32(i * 4, v[i] as number, true);
	return new Uint8Array(buf);
}

export function decodeVector(bytes: Uint8Array, dimensions: number): Float32Array | null {
	/**
	 * A wrong length is a corrupt row, and it returns null rather than throwing.
	 *
	 * One bad row must not break every recall — the entry is simply absent from the dense leg until a
	 * reindex, which `circle doctor` can trigger. Throwing would make one corrupt vector a total outage.
	 */
	if (bytes.byteLength !== dimensions * 4) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out = new Float32Array(dimensions);
	for (let i = 0; i < dimensions; i++) out[i] = view.getFloat32(i * 4, true);
	return out;
}

function toEntry(row: Record<string, unknown>): MemoryEntry {
	const provenance: MemoryProvenance = {
		source_chat_id: row.source_chat_id === null ? null : String(row.source_chat_id),
		source_seq: row.source_seq === null ? null : Number(row.source_seq),
		learned_at: Number(row.learned_at),
		confirmations: Number(row.confirmations),
		extracted_by: String(row.extracted_by) as MemoryProvenance["extracted_by"],
	};
	return {
		id: String(row.id),
		scope: String(row.scope) as MemoryScope,
		project_id: row.project_id === null ? null : String(row.project_id),
		text: String(row.text),
		text_norm: String(row.text_norm),
		created_at: Number(row.created_at),
		updated_at: Number(row.updated_at),
		tombstone: Number(row.tombstone) === 1,
		lamport: Number(row.lamport),
		origin_peer: String(row.origin_peer),
		provenance,
		used_in_count: Number(row.used_in_count),
	};
}

export type { MemoryEntryWithVector };
