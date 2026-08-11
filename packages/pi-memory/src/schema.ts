/**
 * Memory's tables (R-8.1, R-8.2, R-8.3).
 *
 * Exported as SQL rather than applied here, so `core` adds them through the existing migration framework
 * — one migration list, one version number, one round-trip test. A second migration mechanism inside
 * `memory` would be a second thing to keep in step.
 */

export const MEMORY_SCHEMA_UP = `
  CREATE TABLE memory_entries (
    id            TEXT    PRIMARY KEY,
    scope         TEXT    NOT NULL CHECK (scope IN ('global','project')),
    project_id    TEXT,
    text          TEXT    NOT NULL,
    -- The dedupe key: NFKC, lowercased, whitespace-collapsed. Indexed, because the exact path is one
    -- lookup per candidate and extraction runs on every turn.
    text_norm     TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    tombstone     INTEGER NOT NULL DEFAULT 0,
    lamport       INTEGER NOT NULL,
    origin_peer   TEXT    NOT NULL,
    source_chat_id TEXT,
    source_seq    INTEGER,
    learned_at    INTEGER NOT NULL,
    confirmations INTEGER NOT NULL DEFAULT 1,
    -- 'turn' means a model decided this unprompted; 'user'/'cli' mean a human asked. The distinction is
    -- what makes granting an agent write access defensible.
    extracted_by  TEXT    NOT NULL CHECK (extracted_by IN ('turn','user','cli')),
    used_in_count INTEGER NOT NULL DEFAULT 0,
    -- A project-scoped entry must name its project; a global one must not.
    CHECK ((scope = 'project' AND project_id IS NOT NULL) OR (scope = 'global' AND project_id IS NULL))
  ) STRICT;

  CREATE INDEX memory_norm ON memory_entries(text_norm, scope, project_id);
  CREATE INDEX memory_scope ON memory_entries(scope, project_id, tombstone);
  CREATE INDEX memory_chat ON memory_entries(source_chat_id) WHERE source_chat_id IS NOT NULL;

  CREATE TABLE memory_log (
    id           TEXT    PRIMARY KEY,
    entry_id     TEXT    NOT NULL,
    op           TEXT    NOT NULL CHECK (op IN ('upsert','confirm','edit','forget')),
    lamport      INTEGER NOT NULL,
    origin_peer  TEXT    NOT NULL,
    payload_json TEXT    NOT NULL,
    -- Wall clock, advisory only. Ordering is (lamport, origin_peer, id) and never touches this.
    ts           INTEGER NOT NULL,
    -- Per-peer lamport is gap-tolerant but unique: two ops from one peer cannot claim one position.
    UNIQUE (origin_peer, lamport)
  ) STRICT;

  CREATE INDEX memory_log_entry ON memory_log(entry_id, lamport);
  CREATE INDEX memory_log_peer ON memory_log(origin_peer, lamport);

  -- Vectors as BLOBs with no ANN index: 10k x 384 dot products measured at 3.3ms p95 against a 50ms
  -- budget, so a linear scan is fast enough and cannot return wrong neighbours after a partial write.
  CREATE TABLE memory_vec (
    entry_id  TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    -- Which model wrote it, so a mixed index after a model swap is detectable rather than mysterious.
    model_id  TEXT NOT NULL,
    FOREIGN KEY (entry_id) REFERENCES memory_entries(id) ON DELETE CASCADE
  ) STRICT;

  -- FTS5 is available in node:sqlite; vec0 is not. The sparse leg finds exact tokens like DEV-412,
  -- which an embedding has nothing useful to say about.
  CREATE VIRTUAL TABLE memory_fts USING fts5(entry_id UNINDEXED, text);
`;

export const MEMORY_SCHEMA_DOWN = `
  DROP TABLE memory_fts;
  DROP TABLE memory_vec;
  DROP INDEX memory_log_peer;
  DROP INDEX memory_log_entry;
  DROP TABLE memory_log;
  DROP INDEX memory_chat;
  DROP INDEX memory_scope;
  DROP INDEX memory_norm;
  DROP TABLE memory_entries;
`;
