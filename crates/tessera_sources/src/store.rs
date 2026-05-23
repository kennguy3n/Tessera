use rusqlite::params;
use tessera_core::error::{Error, Result};
use tessera_core::{
    open_shared, open_shared_in_memory, SharedConnection, SourceId, SourceStatus, SourceType,
};

use crate::chunker::Chunk;
use crate::source::Source;

fn parse_datetime(s: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map_or_else(|_| chrono::Utc::now(), |dt| dt.with_timezone(&chrono::Utc))
}

fn parse_datetime_opt(s: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .ok()
}

pub struct SourceStore {
    conn: SharedConnection,
}

impl SourceStore {
    pub fn open(path: &str) -> Result<Self> {
        Self::with_shared_conn(open_shared(path)?)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::with_shared_conn(open_shared_in_memory()?)
    }

    /// Build a store on top of a [`SharedConnection`] that is already
    /// shared with other stores. Used by the napi bridge.
    pub fn with_shared_conn(conn: SharedConnection) -> Result<Self> {
        let store = Self { conn };
        store.init_schema()?;
        Ok(store)
    }

    fn init_schema(&self) -> Result<()> {
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute_batch(
                "
            -- Re-assert PRAGMA foreign_keys = ON on this connection.
            -- The primary place this is set is `tessera_core::db::
            -- open_shared`, which applies it at construction time so
            -- every store inherits the setting regardless of which
            -- `init_schema` runs first. We re-assert it here as
            -- defence-in-depth: a future caller that constructs a
            -- `SourceStore` from a raw `rusqlite::Connection` via some
            -- yet-unwritten escape hatch would otherwise silently get
            -- a no-op CASCADE on `chunk_embeddings`. The pragma is
            -- idempotent, so applying it twice costs nothing.
            -- Note that SQLite scopes this pragma per-connection (not
            -- per-database); the per-connection nature is why the
            -- pragma cannot live solely in the schema migration.
            PRAGMA foreign_keys = ON;

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
            ",
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    pub fn add_source(&self, source: &Source) -> Result<()> {
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute(
                "INSERT INTO sources (id, source_type, path, status, created_at, last_indexed, file_count)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    source.id.to_string(),
                    serde_json::to_string(&source.source_type)
                        .map_err(|e| Error::Database(e.to_string()))?,
                    source.path,
                    serde_json::to_string(&source.status)
                        .map_err(|e| Error::Database(e.to_string()))?,
                    source.created_at.to_rfc3339(),
                    source.last_indexed.map(|t| t.to_rfc3339()),
                    source.file_count as i64,
                ],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    pub fn remove_source(&self, source_id: &SourceId) -> Result<()> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");

        let file_ids: Vec<i64> = conn
            .prepare("SELECT id FROM indexed_files WHERE source_id = ?1")
            .map_err(|e| Error::Database(e.to_string()))?
            .query_map(params![id_str], |row| row.get(0))
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .collect();

        for fid in &file_ids {
            conn.execute(
                "DELETE FROM chunks WHERE indexed_file_id = ?1",
                params![fid],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        }

        conn.execute(
            "DELETE FROM indexed_files WHERE source_id = ?1",
            params![id_str],
        )
        .map_err(|e| Error::Database(e.to_string()))?;

        conn.execute("DELETE FROM sources WHERE id = ?1", params![id_str])
            .map_err(|e| Error::Database(e.to_string()))?;

        Ok(())
    }

    pub fn list_sources(&self) -> Result<Vec<Source>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT id, source_type, path, status, created_at, last_indexed, file_count FROM sources",
            )
            .map_err(|e| Error::Database(e.to_string()))?;

        let sources = stmt
            .query_map([], |row| {
                let id_str: String = row.get(0)?;
                let source_type_str: String = row.get(1)?;
                let status_str: String = row.get(3)?;
                let created_at_str: String = row.get(4)?;
                let last_indexed_str: Option<String> = row.get(5)?;

                let parsed_id = uuid::Uuid::parse_str(&id_str).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
                let parsed_type: SourceType =
                    serde_json::from_str(&source_type_str).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            1,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?;
                let parsed_status: SourceStatus =
                    serde_json::from_str(&status_str).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            3,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?;

                Ok(Source {
                    id: SourceId(parsed_id),
                    source_type: parsed_type,
                    path: row.get(2)?,
                    status: parsed_status,
                    created_at: parse_datetime(&created_at_str),
                    last_indexed: last_indexed_str.as_deref().and_then(parse_datetime_opt),
                    file_count: row.get::<_, i64>(6)? as u64,
                })
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| Error::Database(format!("corrupted row: {e}")))?;

        Ok(sources)
    }

    pub fn get_source(&self, source_id: &SourceId) -> Result<Source> {
        let id_str = source_id.to_string();
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .query_row(
                "SELECT id, source_type, path, status, created_at, last_indexed, file_count FROM sources WHERE id = ?1",
                params![id_str],
                |row| {
                    let id_s: String = row.get(0)?;
                    let source_type_str: String = row.get(1)?;
                    let status_str: String = row.get(3)?;
                    let created_at_str: String = row.get(4)?;
                    let last_indexed_str: Option<String> = row.get(5)?;

                    let parsed_id = uuid::Uuid::parse_str(&id_s).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
                    })?;
                    let parsed_type: SourceType = serde_json::from_str(&source_type_str).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(e))
                    })?;
                    let parsed_status: SourceStatus = serde_json::from_str(&status_str).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e))
                    })?;

                    Ok(Source {
                        id: SourceId(parsed_id),
                        source_type: parsed_type,
                        path: row.get(2)?,
                        status: parsed_status,
                        created_at: parse_datetime(&created_at_str),
                        last_indexed: last_indexed_str.as_deref().and_then(parse_datetime_opt),
                        file_count: row.get::<_, i64>(6)? as u64,
                    })
                },
            )
            .map_err(|e| Error::Database(e.to_string()))
    }

    pub fn update_source_status(
        &self,
        source_id: &SourceId,
        status: SourceStatus,
        file_count: Option<u64>,
    ) -> Result<()> {
        let id_str = source_id.to_string();
        let status_str =
            serde_json::to_string(&status).map_err(|e| Error::Database(e.to_string()))?;
        let now = chrono::Utc::now().to_rfc3339();

        let conn = self.conn.lock().expect("connection mutex poisoned");
        if let Some(count) = file_count {
            conn.execute(
                "UPDATE sources SET status = ?1, last_indexed = ?2, file_count = ?3 WHERE id = ?4",
                params![status_str, now, count as i64, id_str],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        } else {
            conn.execute(
                "UPDATE sources SET status = ?1 WHERE id = ?2",
                params![status_str, id_str],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        }
        Ok(())
    }

    pub fn upsert_indexed_file(
        &self,
        source_id: &SourceId,
        path: &str,
        hash: &str,
        last_modified: &str,
    ) -> Result<i64> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");

        let existing: Option<(i64, String)> = conn
            .query_row(
                "SELECT id, hash FROM indexed_files WHERE path = ?1",
                params![path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();

        if let Some((file_id, old_hash)) = existing {
            if old_hash == hash {
                return Ok(file_id);
            }
            conn.execute(
                "DELETE FROM chunks WHERE indexed_file_id = ?1",
                params![file_id],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
            conn.execute(
                "UPDATE indexed_files SET hash = ?1, last_modified = ?2, chunk_count = 0 WHERE id = ?3",
                params![hash, last_modified, file_id],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
            Ok(file_id)
        } else {
            conn.execute(
                "INSERT INTO indexed_files (source_id, path, hash, last_modified, chunk_count) VALUES (?1, ?2, ?3, ?4, 0)",
                params![id_str, path, hash, last_modified],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
            Ok(conn.last_insert_rowid())
        }
    }

    pub fn insert_chunks(&self, indexed_file_id: i64, chunks: &[Chunk]) -> Result<()> {
        self.insert_chunks_returning_ids(indexed_file_id, chunks)
            .map(|_| ())
    }

    /// Insert chunks and return the `(chunk_index, chunk_id)` pairs
    /// in the same order as the input slice. Used by the indexer to
    /// hand newly-created chunks off to the embedding pipeline
    /// without a follow-up SELECT.
    pub fn insert_chunks_returning_ids(
        &self,
        indexed_file_id: i64,
        chunks: &[Chunk],
    ) -> Result<Vec<i64>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut ids = Vec::with_capacity(chunks.len());
        {
            let mut stmt = conn
                .prepare(
                    "INSERT INTO chunks (indexed_file_id, chunk_index, byte_offset, content, hash)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )
                .map_err(|e| Error::Database(e.to_string()))?;

            for chunk in chunks {
                stmt.execute(params![
                    indexed_file_id,
                    chunk.chunk_index as i64,
                    chunk.byte_offset as i64,
                    chunk.content,
                    chunk.hash,
                ])
                .map_err(|e| Error::Database(e.to_string()))?;
                ids.push(conn.last_insert_rowid());
            }
        }

        conn.execute(
            "UPDATE indexed_files SET chunk_count = ?1 WHERE id = ?2",
            params![chunks.len() as i64, indexed_file_id],
        )
        .map_err(|e| Error::Database(e.to_string()))?;

        Ok(ids)
    }

    pub fn get_file_hash(&self, path: &str) -> Result<Option<String>> {
        let result = self
            .conn
            .lock()
            .expect("connection mutex poisoned")
            .query_row(
                "SELECT hash FROM indexed_files WHERE path = ?1",
                params![path],
                |row| row.get(0),
            )
            .ok();
        Ok(result)
    }

    pub fn remove_indexed_file(&self, path: &str) -> Result<()> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        if let Ok(file_id) = conn.query_row(
            "SELECT id FROM indexed_files WHERE path = ?1",
            params![path],
            |row| row.get::<_, i64>(0),
        ) {
            conn.execute(
                "DELETE FROM chunks WHERE indexed_file_id = ?1",
                params![file_id],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
            conn.execute("DELETE FROM indexed_files WHERE id = ?1", params![file_id])
                .map_err(|e| Error::Database(e.to_string()))?;
        }
        Ok(())
    }

    pub fn search_fts(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.content, c.hash, c.chunk_index, c.byte_offset, f.path,
                        f.source_id, rank
                 FROM chunks_fts fts
                 JOIN chunks c ON c.id = fts.rowid
                 JOIN indexed_files f ON f.id = c.indexed_file_id
                 WHERE chunks_fts MATCH ?1
                 ORDER BY rank
                 LIMIT ?2",
            )
            .map_err(|e| Error::Database(e.to_string()))?;

        let results = stmt
            .query_map(params![query, limit as i64], |row| {
                Ok(SearchHit {
                    chunk_id: row.get::<_, i64>(0)?,
                    content: row.get(1)?,
                    hash: row.get(2)?,
                    chunk_index: row.get::<_, i64>(3)? as usize,
                    byte_offset: row.get::<_, i64>(4)? as usize,
                    source_path: row.get(5)?,
                    source_id: row.get(6)?,
                    relevance: -row.get::<_, f64>(7)?,
                })
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .collect();

        Ok(results)
    }

    /// Look up the contents of a set of chunks by id, preserving the
    /// input order. Used by the hybrid retrieval pipeline to hydrate
    /// the final ranked list with chunk text + source metadata after
    /// fusion has determined the order.
    pub fn fetch_chunks_by_ids(&self, ids: &[i64]) -> Result<Vec<SearchHit>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let placeholders = std::iter::repeat_n("?", ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT c.id, c.content, c.hash, c.chunk_index, c.byte_offset, f.path, f.source_id
             FROM chunks c
             JOIN indexed_files f ON f.id = c.indexed_file_id
             WHERE c.id IN ({placeholders})"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| Error::Database(e.to_string()))?;
        let id_params: Vec<rusqlite::types::Value> = ids
            .iter()
            .map(|&i| rusqlite::types::Value::Integer(i))
            .collect();
        let rows: Vec<SearchHit> = stmt
            .query_map(rusqlite::params_from_iter(id_params.iter()), |row| {
                Ok(SearchHit {
                    chunk_id: row.get::<_, i64>(0)?,
                    content: row.get(1)?,
                    hash: row.get(2)?,
                    chunk_index: row.get::<_, i64>(3)? as usize,
                    byte_offset: row.get::<_, i64>(4)? as usize,
                    source_path: row.get(5)?,
                    source_id: row.get(6)?,
                    // relevance is filled in by the caller based on the
                    // hybrid-fusion score; we set 0.0 here as a sentinel.
                    relevance: 0.0,
                })
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .collect();

        // Reorder to match the requested id sequence.
        let mut by_id: std::collections::HashMap<i64, SearchHit> =
            rows.into_iter().map(|h| (h.chunk_id, h)).collect();
        let ordered: Vec<SearchHit> = ids.iter().filter_map(|id| by_id.remove(id)).collect();
        Ok(ordered)
    }

    /// Upsert an embedding for a chunk. Replaces any existing row with
    /// the same `(chunk_id, model_id)` pair so re-embedding the same
    /// chunk doesn't accumulate duplicates.
    pub fn upsert_chunk_embedding(
        &self,
        chunk_id: i64,
        model_id: &str,
        dim: usize,
        vec_bytes: &[u8],
    ) -> Result<()> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        conn.execute(
            "INSERT INTO chunk_embeddings (chunk_id, model_id, dim, vec)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(chunk_id, model_id) DO UPDATE SET
                dim = excluded.dim,
                vec = excluded.vec",
            params![chunk_id, model_id, dim as i64, vec_bytes],
        )
        .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    /// Load every embedding stored for a given model. Used by hybrid
    /// retrieval to scan for cosine similarity. For corpora large
    /// enough that an in-memory scan is slow (~100K+ chunks), this
    /// can be replaced with an sqlite-vec / sqlite-vss native index;
    /// the trait surface stays the same.
    pub fn load_embeddings_for_model(&self, model_id: &str) -> Result<Vec<ChunkEmbeddingRow>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare("SELECT chunk_id, model_id, vec FROM chunk_embeddings WHERE model_id = ?1")
            .map_err(|e| Error::Database(e.to_string()))?;
        let rows = stmt
            .query_map(params![model_id], |row| {
                let chunk_id: i64 = row.get(0)?;
                let model_id: String = row.get(1)?;
                let bytes: Vec<u8> = row.get(2)?;
                let vector = crate::embedding::decode_vec(&bytes).unwrap_or_default();
                Ok(ChunkEmbeddingRow {
                    chunk_id,
                    model_id,
                    vector,
                })
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .filter(|r| !r.vector.is_empty())
            .collect();
        Ok(rows)
    }

    /// Find chunks that don't yet have an embedding for the given
    /// model. The indexer uses this to incrementally back-fill
    /// embeddings without re-processing every chunk on every run.
    pub fn chunks_missing_embedding(
        &self,
        model_id: &str,
        limit: usize,
    ) -> Result<Vec<(i64, String)>> {
        self.chunks_missing_embedding_excluding(model_id, limit, &[])
    }

    /// Variant of [`chunks_missing_embedding`] that filters out chunk
    /// IDs the caller has already attempted-and-failed this session.
    ///
    /// `backfill_embeddings` calls this with the running set of
    /// permanently-failing chunk IDs so the SQL query doesn't keep
    /// returning the same broken chunks on every iteration. Without
    /// this filter, a corpus with P passing chunks and F permanently-
    /// failing chunks at batch_size B requires `O(P * ⌈F/B⌉ / B)`
    /// iterations to converge — every batch reads F failures before
    /// finding the next B passes. With the filter, the failing set
    /// is paid for exactly once (the first time each failure is hit)
    /// and convergence is `O(P/B + F/B)`.
    ///
    /// SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is 32766 in modern
    /// builds, so callers can safely accumulate thousands of excludes
    /// before the prepared statement compiler complains; in practice
    /// backfill should bail via the in-loop stall detector long before
    /// the exclude list gets that large.
    pub fn chunks_missing_embedding_excluding(
        &self,
        model_id: &str,
        limit: usize,
        exclude_chunk_ids: &[i64],
    ) -> Result<Vec<(i64, String)>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        // Build the SQL with one `?` placeholder per excluded ID. We
        // can't bind a Vec to a single placeholder in rusqlite; the
        // canonical workaround is to construct the in-clause with the
        // matching number of placeholders. We could use a temp table
        // instead, but for the small exclude sets backfill produces
        // (bounded by `total_chunks - successfully_embedded`), in-line
        // binding is faster and simpler.
        let exclude_placeholders = if exclude_chunk_ids.is_empty() {
            String::new()
        } else {
            let placeholders: Vec<String> = (0..exclude_chunk_ids.len())
                .map(|i| format!("?{}", i + 3))
                .collect();
            format!(" AND c.id NOT IN ({})", placeholders.join(", "))
        };
        let sql = format!(
            "SELECT c.id, c.content
             FROM chunks c
             LEFT JOIN chunk_embeddings e
                ON e.chunk_id = c.id AND e.model_id = ?1
             WHERE e.chunk_id IS NULL{exclude_placeholders}
             LIMIT ?2"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| Error::Database(e.to_string()))?;
        // Build the parameter list: ?1 = model_id, ?2 = limit,
        // ?3.. = exclude IDs in order.
        let mut params_vec: Vec<rusqlite::types::Value> =
            Vec::with_capacity(2 + exclude_chunk_ids.len());
        params_vec.push(rusqlite::types::Value::Text(model_id.to_string()));
        params_vec.push(rusqlite::types::Value::Integer(limit as i64));
        for id in exclude_chunk_ids {
            params_vec.push(rusqlite::types::Value::Integer(*id));
        }
        let params_iter = rusqlite::params_from_iter(params_vec.iter());
        let rows = stmt
            .query_map(params_iter, |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .collect();
        Ok(rows)
    }

    /// Look up `last_modified` ages in seconds (relative to `now`)
    /// for a list of chunk ids. Chunks whose `last_modified` cannot
    /// be parsed get age 0 (treated as fresh) — defensive choice so
    /// a malformed timestamp doesn't tank a result's ranking.
    pub fn ages_secs_for_chunks(&self, ids: &[i64]) -> Result<std::collections::HashMap<i64, f64>> {
        if ids.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let placeholders = std::iter::repeat_n("?", ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT c.id, f.last_modified
             FROM chunks c
             JOIN indexed_files f ON f.id = c.indexed_file_id
             WHERE c.id IN ({placeholders})"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| Error::Database(e.to_string()))?;
        let id_params: Vec<rusqlite::types::Value> = ids
            .iter()
            .map(|&i| rusqlite::types::Value::Integer(i))
            .collect();
        let now = chrono::Utc::now();
        let mut ages = std::collections::HashMap::new();
        let rows = stmt
            .query_map(rusqlite::params_from_iter(id_params.iter()), |row| {
                let id: i64 = row.get(0)?;
                let last_mod: String = row.get(1)?;
                Ok((id, last_mod))
            })
            .map_err(|e| Error::Database(e.to_string()))?;
        for r in rows.flatten() {
            let age_secs =
                parse_datetime_opt(&r.1).map_or(0.0, |dt| (now - dt).num_seconds().max(0) as f64);
            ages.insert(r.0, age_secs);
        }
        Ok(ages)
    }

    pub fn file_count_for_source(&self, source_id: &SourceId) -> Result<u64> {
        let id_str = source_id.to_string();
        let count: i64 = self
            .conn
            .lock()
            .expect("connection mutex poisoned")
            .query_row(
                "SELECT COUNT(*) FROM indexed_files WHERE source_id = ?1",
                params![id_str],
                |row| row.get(0),
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(count as u64)
    }

    pub fn get_chunk_contents_for_source(&self, source_id: &SourceId) -> Result<Vec<String>> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT c.content FROM chunks c
                 INNER JOIN indexed_files f ON c.indexed_file_id = f.id
                 WHERE f.source_id = ?1
                 ORDER BY c.chunk_index",
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        let rows = stmt
            .query_map(params![id_str], |row| row.get::<_, String>(0))
            .map_err(|e| Error::Database(e.to_string()))?;
        let mut contents = Vec::new();
        for row in rows {
            contents.push(row.map_err(|e| Error::Database(e.to_string()))?);
        }
        Ok(contents)
    }

    pub fn get_current_file_hash(&self, file_path: &str) -> Result<Option<String>> {
        let result = self
            .conn
            .lock()
            .expect("connection mutex poisoned")
            .query_row(
                "SELECT hash FROM indexed_files WHERE path = ?1 ORDER BY rowid DESC LIMIT 1",
                params![file_path],
                |row| row.get::<_, String>(0),
            );
        match result {
            Ok(hash) => Ok(Some(hash)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(Error::Database(e.to_string())),
        }
    }

    pub fn list_indexed_files(&self, source_id: &SourceId) -> Result<Vec<IndexedFile>> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT path, hash, last_modified, chunk_count FROM indexed_files WHERE source_id = ?1",
            )
            .map_err(|e| Error::Database(e.to_string()))?;

        let files = stmt
            .query_map(params![id_str], |row| {
                Ok(IndexedFile {
                    path: row.get(0)?,
                    hash: row.get(1)?,
                    last_modified: row.get(2)?,
                    chunk_count: row.get::<_, i64>(3)? as u64,
                })
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .collect();

        Ok(files)
    }
}

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub chunk_id: i64,
    pub content: String,
    pub hash: String,
    pub chunk_index: usize,
    pub byte_offset: usize,
    pub source_path: String,
    pub source_id: String,
    pub relevance: f64,
}

#[derive(Debug, Clone)]
pub struct ChunkEmbeddingRow {
    pub chunk_id: i64,
    pub model_id: String,
    pub vector: Vec<f32>,
}

#[derive(Debug, Clone)]
pub struct IndexedFile {
    pub path: String,
    pub hash: String,
    pub last_modified: String,
    pub chunk_count: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn store_add_and_list_sources() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        let sources = store.list_sources().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].path, "/tmp/test");
    }

    #[test]
    fn store_remove_source() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();
        store.remove_source(&source.id).unwrap();

        let sources = store.list_sources().unwrap();
        assert!(sources.is_empty());
    }

    #[test]
    fn store_index_and_search() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/test/doc.txt", "abc123", "2026-01-01")
            .unwrap();

        let chunks = vec![
            crate::chunker::Chunk {
                source_path: "/tmp/test/doc.txt".to_string(),
                chunk_index: 0,
                byte_offset: 0,
                content: "Tessera is a local-first productivity workspace".to_string(),
                hash: "hash1".to_string(),
            },
            crate::chunker::Chunk {
                source_path: "/tmp/test/doc.txt".to_string(),
                chunk_index: 1,
                byte_offset: 48,
                content: "It indexes local folders and files for search".to_string(),
                hash: "hash2".to_string(),
            },
        ];

        store.insert_chunks(file_id, &chunks).unwrap();

        let results = store.search_fts("productivity workspace", 10).unwrap();
        assert!(!results.is_empty());
        assert!(results[0].content.contains("productivity"));
    }

    #[test]
    fn store_dedup_by_hash() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        let file_id1 = store
            .upsert_indexed_file(&source.id, "/tmp/test/a.txt", "samehash", "2026-01-01")
            .unwrap();
        let file_id2 = store
            .upsert_indexed_file(&source.id, "/tmp/test/a.txt", "samehash", "2026-01-01")
            .unwrap();

        assert_eq!(file_id1, file_id2);
    }

    #[test]
    fn store_update_changed_file() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        let fid = store
            .upsert_indexed_file(&source.id, "/tmp/test/a.txt", "hash1", "2026-01-01")
            .unwrap();
        let chunks = vec![crate::chunker::Chunk {
            source_path: "/tmp/test/a.txt".to_string(),
            chunk_index: 0,
            byte_offset: 0,
            content: "old content".to_string(),
            hash: "oldhash".to_string(),
        }];
        store.insert_chunks(fid, &chunks).unwrap();

        let fid2 = store
            .upsert_indexed_file(&source.id, "/tmp/test/a.txt", "hash2", "2026-01-02")
            .unwrap();
        assert_eq!(fid, fid2);

        let results = store.search_fts("old content", 10).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn store_file_count() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        store
            .upsert_indexed_file(&source.id, "/tmp/test/a.txt", "h1", "2026-01-01")
            .unwrap();
        store
            .upsert_indexed_file(&source.id, "/tmp/test/b.txt", "h2", "2026-01-01")
            .unwrap();

        let count = store.file_count_for_source(&source.id).unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn source_store_shares_database_with_clone() {
        // Two stores built on the same SharedConnection see the same
        // rows. Mirrors `audit_store_shares_database_with_clone` so the
        // shared-connection refactor is exercised per-crate.
        let conn = tessera_core::open_shared_in_memory().unwrap();
        let a = SourceStore::with_shared_conn(conn.clone()).unwrap();
        let b = SourceStore::with_shared_conn(conn).unwrap();
        let source = Source::new_local_folder("/tmp/shared".to_string());
        a.add_source(&source).unwrap();
        let sources = b.list_sources().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].path, "/tmp/shared");
    }

    #[test]
    fn pragma_foreign_keys_is_enabled_on_store_connection() {
        // Regression for the original finding that `chunk_embeddings`
        // had `ON DELETE CASCADE` but SQLite's default
        // `foreign_keys = OFF` silently turned the cascade into a
        // no-op. We now `PRAGMA foreign_keys = ON` in `init_schema()`
        // so the cascade actually fires. Pin that pragma stays ON
        // for the rest of the connection's lifetime — pragmas are
        // per-connection and could be silently flipped by any later
        // `execute_batch` that runs on the same connection.
        let store = SourceStore::open_in_memory().unwrap();
        let conn = store.conn.lock().expect("connection mutex poisoned");
        let fk_on: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            fk_on, 1,
            "PRAGMA foreign_keys must be ON for chunk_embeddings cascade to fire"
        );
    }

    #[test]
    fn chunk_embeddings_cascade_fires_when_parent_chunk_is_deleted() {
        // Defence-in-depth regression test for ANALYSIS_0003: with
        // foreign_keys=ON, deleting a chunk must remove its
        // associated `chunk_embeddings` row via either the trigger
        // (belt) or the CASCADE clause (suspenders). We assert the
        // chunk_embeddings row disappears after the parent delete.
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/cascade-test".to_string());
        store.add_source(&source).unwrap();

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("doc.txt"),
            "alpha bravo charlie delta echo foxtrot golf",
        )
        .unwrap();

        // Index with an embedder so chunk_embeddings rows get populated.
        let embedder: Arc<dyn crate::embedding::EmbeddingProvider> =
            Arc::new(crate::embedding::HashTrickEmbedding::default_config());
        let indexer = crate::indexer::Indexer::default().with_embedder(Arc::clone(&embedder));
        indexer
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();

        let embedding_count_before: i64 = {
            let conn = store.conn.lock().expect("connection mutex poisoned");
            conn.query_row("SELECT COUNT(*) FROM chunk_embeddings", [], |r| r.get(0))
                .unwrap()
        };
        assert!(
            embedding_count_before > 0,
            "expected the embedder to have populated chunk_embeddings"
        );

        // Delete a single chunk directly (not via remove_source, which
        // already deletes embeddings explicitly). The trigger +
        // CASCADE pair must remove the matching chunk_embeddings row.
        let chunk_id: i64 = {
            let conn = store.conn.lock().expect("connection mutex poisoned");
            conn.query_row("SELECT id FROM chunks LIMIT 1", [], |r| r.get(0))
                .unwrap()
        };
        {
            let conn = store.conn.lock().expect("connection mutex poisoned");
            conn.execute("DELETE FROM chunks WHERE id = ?1", params![chunk_id])
                .unwrap();
        }

        let leftover: i64 = {
            let conn = store.conn.lock().expect("connection mutex poisoned");
            conn.query_row(
                "SELECT COUNT(*) FROM chunk_embeddings WHERE chunk_id = ?1",
                params![chunk_id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(
            leftover, 0,
            "deleting a chunk must cascade-remove its chunk_embeddings rows"
        );
    }
}
