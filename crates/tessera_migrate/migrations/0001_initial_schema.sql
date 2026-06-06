-- Initial Tessera source-store schema.
--
-- Ported verbatim from the legacy ad-hoc `SourceStore::init_schema`
-- batch in `tessera_sources::store`. Every statement uses
-- `IF NOT EXISTS` so this migration is a no-op against a database that
-- an older build already populated, and produces an identical schema on
-- a fresh database.
--
-- The per-connection `PRAGMA foreign_keys = ON` that used to lead this
-- batch is intentionally NOT migrated here: it is connection-scoped (not
-- database-scoped), so it stays in `init_schema` where it is re-asserted
-- on every connection. Migrations carry only durable, database-scoped
-- DDL.

CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    path TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_indexed TEXT,
    file_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS indexed_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    hash TEXT NOT NULL,
    last_modified TEXT NOT NULL,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    indexed_file_id INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    byte_offset INTEGER NOT NULL,
    content TEXT NOT NULL,
    hash TEXT NOT NULL,
    -- Provenance columns: NULL on legacy / native-extraction rows;
    -- set to the lower-snake-case `ExtractionMethod` discriminant and
    -- the manifest entry id of the vision model that produced
    -- VLM-derived rows.
    extraction_method TEXT,
    extraction_model_id TEXT,
    FOREIGN KEY (indexed_file_id) REFERENCES indexed_files(id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content,
    content='chunks',
    content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad BEFORE DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
    INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS chunk_embeddings (
    chunk_id INTEGER NOT NULL,
    model_id TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL,
    PRIMARY KEY (chunk_id, model_id),
    FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model
    ON chunk_embeddings(model_id);

CREATE TRIGGER IF NOT EXISTS chunks_ad_embeddings BEFORE DELETE ON chunks BEGIN
    DELETE FROM chunk_embeddings WHERE chunk_id = old.id;
END;

-- Per-channel ACL projection. `kchat_principal` (id='singleton') is
-- the locally-authenticated KChat user id; `kchat_source_acl` holds
-- the authoritative member roster so retrieval-side filters can
-- enforce "principal is still a member" without a round-trip.
CREATE TABLE IF NOT EXISTS kchat_principal (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    set_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kchat_source_acl (
    source_id TEXT NOT NULL,
    member_user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    refreshed_at TEXT NOT NULL,
    PRIMARY KEY (source_id, member_user_id),
    FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_kchat_source_acl_member
    ON kchat_source_acl(member_user_id);

-- Per-source data-encryption-key (DEK) lifecycle table. One row per
-- KChat-channel source that has ingested a chat-post body chunk. The
-- wrapped DEK is dropped (and the in-memory DEK zeroized) on
-- cryptoshred so a leaked SQLCipher master key cannot decrypt any
-- surviving AEAD ciphertext for that source.
CREATE TABLE IF NOT EXISTS kchat_source_deks (
    source_id TEXT PRIMARY KEY,
    wrap_nonce BLOB NOT NULL,
    wrapped_dek BLOB NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);

-- Per-post bookkeeping. Maps the KChat-server-issued post_id to the
-- local `indexed_files` row that holds its chunks so edit/delete
-- events can locate existing rows in O(log n).
CREATE TABLE IF NOT EXISTS kchat_posts (
    source_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    root_id TEXT,
    sender_user_id TEXT NOT NULL,
    indexed_file_id INTEGER NOT NULL,
    message_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    edited_at_ms INTEGER NOT NULL,
    ingested_at TEXT NOT NULL,
    PRIMARY KEY (source_id, post_id),
    FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
    FOREIGN KEY (indexed_file_id) REFERENCES indexed_files(id)
);

CREATE INDEX IF NOT EXISTS idx_kchat_posts_channel
    ON kchat_posts(channel_id, post_id);
CREATE INDEX IF NOT EXISTS idx_kchat_posts_indexed_file
    ON kchat_posts(indexed_file_id);
