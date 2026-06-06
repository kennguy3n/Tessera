//! SQLite persistence for sources and their chunks, backed by a small
//! pool of read connections.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::params;
use rusqlite::Connection;
use tessera_core::error::{Error, Result};
use tessera_core::{
    empty_read_pool, open_shared, open_shared_in_memory, with_secure_delete,
    with_secure_delete_transaction, SharedConnection, SharedReadPool, SourceId, SourceStatus,
    SourceType,
};

use crate::chunker::Chunk;
use crate::source::Source;
use crate::vector_index::{IvfIndex, IVF_BRUTE_FORCE_THRESHOLD};

fn parse_datetime(s: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map_or_else(|_| chrono::Utc::now(), |dt| dt.with_timezone(&chrono::Utc))
}

fn parse_datetime_opt(s: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .ok()
}

/// How long the corpus non-ASCII / total chunk counts returned by
/// [`SourceStore::count_non_ascii_chunks`] stay fresh before a
/// recomputation triggers another full table scan. The Settings
/// page polls model status every 1 s for download progress, but
/// the corpus stats only feed the "consider the multilingual
/// model" hint, which is advisory — a 30 s lag is invisible to a
/// user but cuts the per-poll cost on a 100K-chunk corpus from a
/// full table scan to a single mutex-guarded `Instant::elapsed`.
const NON_ASCII_CACHE_TTL: Duration = Duration::from_secs(30);

/// Source Store.
pub struct SourceStore {
    conn: SharedConnection,
    /// optional pool of read-only connections
    /// used for hot read paths (FTS5 BM25, embedding-row scan,
    /// chunk hydration, age lookup). Empty pool ⇒ every read falls
    /// back to the writer connection (preserving the legacy
    /// single-mutex behaviour). When the pool has at least one
    /// connection, the four hot reads dispatch through
    /// [`Self::with_read`], which uses a `try_lock` round-robin so
    /// independent reads don't contend on the writer mutex.
    /// Cheap to clone — [`SharedReadPool`] is internally
    /// `Arc<Vec<Mutex<Connection>>>`.
    read_pool: SharedReadPool,
    /// Memoized result of the last `count_non_ascii_chunks` SQL
    /// scan + the `Instant` at which it was computed. `None` until
    /// the first call. Per-instance, not per-connection — the
    /// staleness window is short enough that two `SourceStore`
    /// instances sharing a connection will simply each pay a
    /// 30 s-amortised scan, never collide.
    non_ascii_cache: Mutex<Option<(Instant, (u64, u64))>>,
    /// monotonic generation counter for the
    /// set of rows that [`Self::load_embeddings_for_model`] would
    /// return. Bumped on writes that can change that set —
    /// embedding upserts, chunk deletes (which cascade to embedding
    /// rows), and source-status transitions to/from
    /// [`SourceStatus::AccessRevoked`] (which gate the join).
    /// Compared against the per-entry generation in
    /// [`Self::vector_index_cache`] on every search; a mismatch
    /// invalidates the cached [`IvfIndex`] and forces a rebuild on
    /// the next call to [`Self::vector_search_path_for_model`].
    embedding_generation: AtomicU64,
    /// per-`model_id` cache of built
    /// [`IvfIndex`]es keyed by the generation counter at build
    /// time. `Arc` so multiple in-flight searches share the same
    /// instance without copying the centroid table. Entries that
    /// fall below [`IVF_BRUTE_FORCE_THRESHOLD`] rows are stored as
    /// `VectorIndexCacheEntry::BruteForce` so subsequent calls
    /// don't re-pay the k-means build cost only to discard it.
    vector_index_cache: Mutex<HashMap<String, VectorIndexCacheEntry>>,
}

/// One slot of [`SourceStore::vector_index_cache`]. `generation`
/// matches the [`SourceStore::embedding_generation`] value at
/// which the entry was built; the entry is invalid (and the
/// caller must rebuild) once the live counter advances past it.
#[derive(Debug, Clone)]
struct VectorIndexCacheEntry {
    generation: u64,
    path: CachedVectorSearchPath,
}

/// Either a built [`IvfIndex`] or a raw embedding-row buffer to
/// brute-force. The brute-force buffer is also cached so
/// `vector_search_path_for_model` doesn't re-hit SQLite on every
/// query for small corpora.
#[derive(Debug, Clone)]
enum CachedVectorSearchPath {
    Ivf(Arc<IvfIndex>),
    BruteForce(Arc<Vec<ChunkEmbeddingRow>>),
}

/// Public projection of `CachedVectorSearchPath` that
/// `hybrid_search` consumes. Borrowing semantics let the caller
/// score against the cached embedding rows without cloning.
#[derive(Debug, Clone)]
pub enum VectorSearchPath {
    /// Use the IVF-Flat ANN index to retrieve approximate
    /// top-k. O(√N) probe of `√K` cells.
    Ivf(Arc<IvfIndex>),
    /// Brute-force linear scan over every embedding row. Used
    /// when the corpus is below [`IVF_BRUTE_FORCE_THRESHOLD`] —
    /// the constant-factor cost of IVF (centroid scan + cell
    /// probe + heap maintenance) only pays off above ~1K rows.
    BruteForce(Arc<Vec<ChunkEmbeddingRow>>),
}

impl SourceStore {
    /// Open.
    pub fn open(path: &str) -> Result<Self> {
        Self::with_shared_conn(open_shared(path)?)
    }

    /// Open in memory.
    pub fn open_in_memory() -> Result<Self> {
        Self::with_shared_conn(open_shared_in_memory()?)
    }

    /// Build a store on top of a [`SharedConnection`] that is already
    /// shared with other stores. Used by the napi bridge.
    pub fn with_shared_conn(conn: SharedConnection) -> Result<Self> {
        // Defaults to the empty pool — every read falls back to the
        // writer connection, identical to the pre-Phase-19 behaviour.
        // The bridge upgrades to a populated pool via
        // `with_shared_conn_and_read_pool` once the on-disk DB is
        // open (it can't share connections for in-memory DBs).
        Self::with_shared_conn_and_read_pool(conn, empty_read_pool())
    }

    /// build a store with an explicit
    /// [`SharedReadPool`] for hot read dispatch.
    ///
    /// Production code at the bridge layer wires this with a pool
    /// of N read-only connections to the same on-disk database
    /// file (typically `N = 2`, surfaced via
    /// [`tessera_core::open_shared_read_pool_with_key`]). In-memory
    /// tests pass [`tessera_core::empty_read_pool`] (or just call
    /// the legacy `with_shared_conn` constructor, which does the
    /// same thing); every read then falls back to the writer
    /// connection.
    ///
    /// The pool is cloned so two stores sharing the same writer
    /// (rare — currently only the manager) also share the same
    /// pool, preserving the "all reads of a given DB go through
    /// the same N reader connections" invariant.
    pub fn with_shared_conn_and_read_pool(
        conn: SharedConnection,
        read_pool: SharedReadPool,
    ) -> Result<Self> {
        let store = Self {
            conn,
            read_pool,
            non_ascii_cache: Mutex::new(None),
            embedding_generation: AtomicU64::new(0),
            vector_index_cache: Mutex::new(HashMap::new()),
        };
        store.init_schema()?;
        Ok(store)
    }

    /// Read-only dispatch: pick a pool connection if any are
    /// available, otherwise fall back to the writer connection.
    ///
    /// Hot read paths use this to release the writer-mutex for
    /// long-running scans (`load_embeddings_for_model` is the
    /// canonical example — it walks every embedding row for a
    /// given model_id). When a writer is in the middle of a long
    /// transaction the pool reader still sees the pre-commit
    /// snapshot (WAL semantics), so search latency doesn't track
    /// writer latency.
    ///
    /// The closure receives a `&Connection` rather than a guard,
    /// so the lock is dropped at the closure's return — callers
    /// can't accidentally hold the connection across an unrelated
    /// operation.
    ///
    /// Empty pool ⇒ this is observationally identical to
    /// `self.conn.lock().expect(...)` followed by `f(&conn)`. Both
    /// branches return the same type, so callers can write the
    /// read body once and let the pool wiring decide where the
    /// query actually runs.
    fn with_read<R>(&self, f: impl FnOnce(&Connection) -> R) -> R {
        if self.read_pool.is_empty() {
            let guard = self.conn.lock().expect("connection mutex poisoned");
            f(&guard)
        } else {
            self.read_pool.with_read(f)
        }
    }

    fn init_schema(&self) -> Result<()> {
        let mut conn = self.conn.lock().expect("connection mutex poisoned");

        // Re-assert PRAGMA foreign_keys = ON on this connection. The
        // primary place this is set is `tessera_core::db::open_shared`,
        // which applies it at construction time so every store inherits
        // the setting. We re-assert it here as defence-in-depth: a
        // future caller that constructs a `SourceStore` from a raw
        // `rusqlite::Connection` via some yet-unwritten escape hatch
        // would otherwise silently get a no-op CASCADE on
        // `chunk_embeddings`. SQLite scopes this pragma per-connection
        // (not per-database), which is why it cannot live in a
        // database-scoped migration; the pragma is idempotent, so
        // applying it twice costs nothing.
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(Error::Sqlite)?;

        // Apply all pending schema migrations via the versioned runner
        // in `tessera_migrate`. This replaces the previous ad-hoc
        // `CREATE TABLE ... IF NOT EXISTS` + idempotent `ALTER TABLE`
        // batch. The runner is idempotent and produces a schema
        // identical to the legacy path for both fresh databases and
        // databases an older build populated: the `CREATE`s are
        // `IF NOT EXISTS` no-ops and the column-adds are skipped when
        // the column already exists.
        tessera_migrate::Migrator::new().run(&mut conn)?;

        // Ask SQLite to refresh its cost-model statistics after
        // migration. `PRAGMA optimize` consults `sqlite_stat1` /
        // `sqlite_stat4` and runs `ANALYZE` only on tables whose stats
        // are stale, so it is cheap on warm boots. Running it here gives
        // the planner fresh stats for the indexes the migrations just
        // (re)created. It is run again from
        // `SourceManager::run_idle_maintenance` for long-running
        // sessions whose corpus grew since boot.
        conn.execute_batch("PRAGMA optimize;")
            .map_err(Error::Sqlite)?;

        Ok(())
    }

    /// Add source.
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
                        .map_err(Error::Json)?,
                    source.path,
                    serde_json::to_string(&source.status)
                        .map_err(Error::Json)?,
                    source.created_at.to_rfc3339(),
                    source.last_indexed.map(|t| t.to_rfc3339()),
                    source.file_count as i64,
                ],
            )
            .map_err(Error::Sqlite)?;
        Ok(())
    }

    /// Remove source.
    pub fn remove_source(&self, source_id: &SourceId) -> Result<()> {
        let id_str = source_id.to_string();
        let mut conn = self.conn.lock().expect("connection mutex poisoned");

        // Scrub under `secure_delete = ON` so the freed chunk / file /
        // source pages are zero-filled at delete time — a removed
        // source's indexed text must not be recoverable from a later
        // forensic image of the SQLCipher file.
        //
        // The chunk / file / source DELETEs run inside a single
        // `BEGIN IMMEDIATE` transaction so crash-recovery returns either
        // the full pre-remove state or the full post-remove state, never
        // a partial removal (e.g. chunks gone but the `indexed_files` /
        // `sources` rows still present).
        with_secure_delete_transaction(&mut conn, |txn| {
            // One set-based DELETE rather than a per-file loop: it
            // scrubs every chunk for the source in a single statement
            // (firing the `chunks_ad` / `chunks_ad_embeddings` triggers
            // per removed row), which keeps the writer-lock hold short
            // even for a source with many indexed files.
            txn.execute(
                "DELETE FROM chunks
                 WHERE indexed_file_id IN
                     (SELECT id FROM indexed_files WHERE source_id = ?1)",
                params![id_str],
            )
            .map_err(Error::Sqlite)?;

            txn.execute(
                "DELETE FROM indexed_files WHERE source_id = ?1",
                params![id_str],
            )
            .map_err(Error::Sqlite)?;

            txn.execute("DELETE FROM sources WHERE id = ?1", params![id_str])
                .map_err(Error::Sqlite)?;
            Ok(())
        })?;

        // removing a source cascades through
        // chunks_ad_embeddings, so the cached IVF index for any
        // model_id may now point at deleted chunk rows. Bump so the
        // next search rebuilds against the post-delete row set.
        drop(conn);
        self.bump_embedding_generation();
        Ok(())
    }

    /// List sources.
    pub fn list_sources(&self) -> Result<Vec<Source>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT id, source_type, path, status, created_at, last_indexed, file_count FROM sources",
            )
            .map_err(Error::Sqlite)?;

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
            .map_err(Error::Sqlite)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| Error::DatabaseState(format!("corrupted row: {e}")))?;

        Ok(sources)
    }

    /// Get source.
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
            .map_err(Error::Sqlite)
    }

    /// Find the source row (if any) whose `source_type` and `path`
    /// both match the given values. Used by
    /// `SourceManager::add_kchat_channel` to make channel
    /// registration idempotent on the cache-directory path in O(log n)
    /// rather than scanning the entire sources table on every re-sync
    ///
    ///
    /// `source_type` is stored as its JSON discriminant in the
    /// `sources.source_type` column (e.g. `"\"Kchat\""`), so the SQL
    /// comparison is on the JSON-encoded form — caller passes a
    /// `SourceType` value and we serialise it the same way `add_source`
    /// does. The composite index `idx_sources_type_path` covers this
    /// query.
    ///
    /// Returns `Ok(None)` when no matching row exists; only genuine
    /// SQL/parse errors propagate as `Err`. This shape lets callers
    /// distinguish "first sync (insert + audit linked event)" from
    /// "re-sync (reindex existing row, suppress audit event)" without
    /// allocating on the not-found path.
    pub fn find_source_by_type_and_path(
        &self,
        source_type: &SourceType,
        path: &str,
    ) -> Result<Option<Source>> {
        let type_str = serde_json::to_string(source_type).map_err(Error::Json)?;
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT id, source_type, path, status, created_at, last_indexed, file_count
                 FROM sources
                 WHERE source_type = ?1 AND path = ?2
                 LIMIT 1",
            )
            .map_err(Error::Sqlite)?;
        let mut rows = stmt.query(params![type_str, path]).map_err(Error::Sqlite)?;
        match rows.next().map_err(Error::Sqlite)? {
            Some(row) => {
                let id_s: String = row.get(0).map_err(Error::Sqlite)?;
                let source_type_str: String = row.get(1).map_err(Error::Sqlite)?;
                let status_str: String = row.get(3).map_err(Error::Sqlite)?;
                let created_at_str: String = row.get(4).map_err(Error::Sqlite)?;
                let last_indexed_str: Option<String> = row.get(5).map_err(Error::Sqlite)?;

                let parsed_id = uuid::Uuid::parse_str(&id_s)
                    .map_err(|e| Error::DatabaseState(format!("corrupt source.id: {e}")))?;
                let parsed_type: SourceType =
                    serde_json::from_str(&source_type_str).map_err(|e| {
                        Error::DatabaseState(format!("corrupt source.source_type: {e}"))
                    })?;
                let parsed_status: SourceStatus = serde_json::from_str(&status_str)
                    .map_err(|e| Error::DatabaseState(format!("corrupt source.status: {e}")))?;
                let row_path: String = row.get(2).map_err(Error::Sqlite)?;
                let file_count: i64 = row.get(6).map_err(Error::Sqlite)?;
                Ok(Some(Source {
                    id: SourceId(parsed_id),
                    source_type: parsed_type,
                    path: row_path,
                    status: parsed_status,
                    created_at: parse_datetime(&created_at_str),
                    last_indexed: last_indexed_str.as_deref().and_then(parse_datetime_opt),
                    file_count: file_count as u64,
                }))
            }
            None => Ok(None),
        }
    }

    /// Update source status.
    pub fn update_source_status(
        &self,
        source_id: &SourceId,
        status: SourceStatus,
        file_count: Option<u64>,
    ) -> Result<()> {
        let id_str = source_id.to_string();
        let status_str = serde_json::to_string(&status).map_err(Error::Json)?;
        let now = chrono::Utc::now().to_rfc3339();

        let conn = self.conn.lock().expect("connection mutex poisoned");
        if let Some(count) = file_count {
            conn.execute(
                "UPDATE sources SET status = ?1, last_indexed = ?2, file_count = ?3 WHERE id = ?4",
                params![status_str, now, count as i64, id_str],
            )
            .map_err(Error::Sqlite)?;
        } else {
            conn.execute(
                "UPDATE sources SET status = ?1 WHERE id = ?2",
                params![status_str, id_str],
            )
            .map_err(Error::Sqlite)?;
        }
        // source-status transitions to/from
        // `AccessRevoked` change the join predicate in
        // `load_embeddings_for_model`. Bump unconditionally — every
        // status write potentially crosses the boundary, and the
        // amortised cost of a missed-cache rebuild is dwarfed by
        // the risk of returning revoked-source vectors in search
        // results (or vice versa).
        drop(conn);
        self.bump_embedding_generation();
        Ok(())
    }

    /// persisted sync-failure state for a single
    /// source row.
    ///
    /// Returned tuple is `(last_sync_error_json, retry_count,
    /// failed_permanently)` — primitives because the SourceStore
    /// crate intentionally does NOT depend on `tessera_connectors`
    /// (that would introduce a dependency cycle). Callers in the
    /// connectors layer deserialise the JSON into a
    /// `PersistedSyncError` themselves.
    ///
    /// Returns `Ok((None, 0, false))` for a row that has never
    /// failed AND for a row that does not exist — both are
    /// indistinguishable from the caller's perspective ("no
    /// failure state to surface").
    pub fn get_sync_failure_state(
        &self,
        source_id: &SourceId,
    ) -> Result<(Option<String>, u32, bool)> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let row: std::result::Result<(Option<String>, i64, i64), rusqlite::Error> = conn.query_row(
            "SELECT last_sync_error, retry_count, failed_permanently
             FROM sources WHERE id = ?1",
            params![id_str],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        );
        match row {
            // Devin Review PR #69: defense-in-depth
            // against a tampered `sources.db` where someone has
            // manually written a negative or out-of-range value into
            // `retry_count`. `record_sync_failure` only ever writes a
            // `u32` widened to `i64`, so the persisted value SHOULD
            // always be in `[0, u32::MAX]` (and realistically `[0,
            // 8]` per `maxRetriesBeforePermanent`). But a SQLite file
            // is user-writable, and `as u32` would silently wrap a
            // negative or huge value into garbage that the
            // connectors layer would then interpret as "millions of
            // retries already attempted, escalate to permanent
            // immediately." Explicit `try_into` collapses any
            // out-of-range value to 0 — i.e. "treat as never
            // failed", which is the safe default for downstream
            // logic (the next sync attempt is allowed to run, and
            // the retry counter starts fresh).
            Ok((err, retry, perm)) => Ok((err, u32::try_from(retry).unwrap_or(0), perm != 0)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok((None, 0, false)),
            Err(e) => Err(Error::Sqlite(e)),
        }
    }

    /// stamp a failed sync attempt onto the
    /// source row. The connectors layer constructs the JSON
    /// payload via `PersistedSyncError` + `serde_json::to_string`
    /// and passes it here as an opaque string.
    ///
    /// Atomic: a single UPDATE statement writes all three columns,
    /// so a reader between the previous-state and new-state never
    /// observes a half-written row (e.g. stamped error message but
    /// stale retry_count). Crucial because the renderer polls
    /// these three columns to render the source-health badge.
    pub fn record_sync_failure(
        &self,
        source_id: &SourceId,
        last_sync_error_json: &str,
        retry_count: u32,
        failed_permanently: bool,
    ) -> Result<()> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let n = conn
            .execute(
                "UPDATE sources
                 SET last_sync_error = ?1,
                     retry_count = ?2,
                     failed_permanently = ?3
                 WHERE id = ?4",
                params![
                    last_sync_error_json,
                    retry_count as i64,
                    i64::from(failed_permanently),
                    id_str,
                ],
            )
            .map_err(Error::Sqlite)?;
        if n == 0 {
            return Err(Error::DatabaseState(format!(
                "record_sync_failure: no source with id {id_str}"
            )));
        }
        Ok(())
    }

    /// clear sync-failure state on a successful
    /// sync. Resets `last_sync_error` to NULL, `retry_count` to 0,
    /// and `failed_permanently` to 0 — proving the source is back
    /// online means the user should not have to dismiss a stale
    /// "permanently failed" badge after a manual re-authorize.
    pub fn record_sync_success(&self, source_id: &SourceId) -> Result<()> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let n = conn
            .execute(
                "UPDATE sources
                 SET last_sync_error = NULL,
                     retry_count = 0,
                     failed_permanently = 0
                 WHERE id = ?1",
                params![id_str],
            )
            .map_err(Error::Sqlite)?;
        if n == 0 {
            return Err(Error::DatabaseState(format!(
                "record_sync_success: no source with id {id_str}"
            )));
        }
        Ok(())
    }

    /// Upsert the locally-authenticated KChat principal user id.
    ///
    /// The Node-side `kchat:connect` handler calls this with the
    /// `id` returned by `GET /users/me` so the substrate knows
    /// whose membership matters for ACL projection. Stored as a
    /// singleton (id='singleton') so concurrent calls don't
    /// accumulate rows. `set_at` carries the wall-clock for
    /// debug / audit.
    ///
    /// Block B Task 3.
    pub fn set_kchat_principal(&self, user_id: &str) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute(
                "INSERT INTO kchat_principal (id, user_id, set_at)
                 VALUES ('singleton', ?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET
                    user_id = excluded.user_id,
                    set_at  = excluded.set_at",
                params![user_id, now],
            )
            .map_err(Error::Sqlite)?;
        Ok(())
    }

    /// Return the locally-authenticated KChat principal user id,
    /// or `None` when no `kchat:connect` has succeeded since the
    /// last `kchat:disconnect`. `refresh_kchat_acl` treats a
    /// missing principal as a no-op rather than auto-revoking
    /// every source: a brief window between substrate startup and
    /// the connect handler must not flap source statuses.
    pub fn get_kchat_principal(&self) -> Result<Option<String>> {
        match self
            .conn
            .lock()
            .expect("connection mutex poisoned")
            .query_row(
                "SELECT user_id FROM kchat_principal WHERE id = 'singleton'",
                [],
                |row| row.get::<_, String>(0),
            ) {
            Ok(user_id) => Ok(Some(user_id)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(Error::Sqlite(e)),
        }
    }

    /// Clear the principal singleton on `kchat:disconnect`. The
    /// ACL roster rows are intentionally retained — a re-connect
    /// with the same user id reuses them without a refresh
    /// round-trip; a re-connect with a different user id will
    /// flip every linked source to `AccessRevoked` on the next
    /// refresh, which is the correct behaviour.
    pub fn clear_kchat_principal(&self) -> Result<()> {
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute("DELETE FROM kchat_principal WHERE id = 'singleton'", [])
            .map_err(Error::Sqlite)?;
        Ok(())
    }

    /// Atomically replace the ACL roster for a single KChat source.
    ///
    /// `members` is the authoritative list returned by
    /// `GET /channels/{id}/members` (or
    /// `KchatClient.listChannelMembers`). All previously-cached
    /// rows for `source_id` are dropped and the supplied
    /// `(user_id, role)` pairs are inserted in their place inside
    /// a single SQLite transaction so concurrent retrieval queries
    /// can never observe a partial roster.
    ///
    /// `role` is the comma-separated KChat role list (e.g.
    /// `"channel_user channel_admin"`); the substrate does not
    /// interpret it but persists it for forensics + future
    /// per-role retrieval filters.
    pub fn replace_kchat_acl(
        &self,
        source_id: &SourceId,
        members: &[(String, String)],
    ) -> Result<()> {
        let id_str = source_id.to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let mut conn = self.conn.lock().expect("connection mutex poisoned");
        let tx = conn.transaction().map_err(Error::Sqlite)?;
        tx.execute(
            "DELETE FROM kchat_source_acl WHERE source_id = ?1",
            params![id_str],
        )
        .map_err(Error::Sqlite)?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO kchat_source_acl
                       (source_id, member_user_id, role, refreshed_at)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(source_id, member_user_id) DO UPDATE SET
                        role         = excluded.role,
                        refreshed_at = excluded.refreshed_at",
                )
                .map_err(Error::Sqlite)?;
            for (user_id, role) in members {
                stmt.execute(params![id_str, user_id, role, now])
                    .map_err(Error::Sqlite)?;
            }
        }
        tx.commit().map_err(Error::Sqlite)?;
        Ok(())
    }

    /// Return `true` iff `user_id` is in the cached ACL roster for
    /// `source_id`. Backed by the `idx_kchat_source_acl_member`
    /// composite index so the call is O(log n) on the roster row
    /// count.
    pub fn is_kchat_member(&self, source_id: &SourceId, user_id: &str) -> Result<bool> {
        let id_str = source_id.to_string();
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .query_row(
                "SELECT 1 FROM kchat_source_acl
                 WHERE source_id = ?1 AND member_user_id = ?2",
                params![id_str, user_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|_| true)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(false),
                other => Err(Error::Sqlite(other)),
            })
    }

    /// List the cached ACL roster for `source_id`. Used by the
    /// renderer's source-detail surface (so an operator can see
    /// who else can read the channel) and by the cargo regression
    /// tests.
    pub fn list_kchat_acl(&self, source_id: &SourceId) -> Result<Vec<KchatAclRow>> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT member_user_id, role, refreshed_at
                 FROM kchat_source_acl
                 WHERE source_id = ?1
                 ORDER BY member_user_id",
            )
            .map_err(Error::Sqlite)?;
        let rows = stmt
            .query_map(params![id_str], |row| {
                Ok(KchatAclRow {
                    member_user_id: row.get(0)?,
                    role: row.get(1)?,
                    refreshed_at: row.get(2)?,
                })
            })
            .map_err(Error::Sqlite)?
            .filter_map(std::result::Result::ok)
            .collect();
        Ok(rows)
    }

    /// Cryptoshreds (inline destroys) every chunk + indexed_file row
    /// belonging to a single source, then defensively scrubs the
    /// SQLite freelist pages those rows occupied. Used by Block B
    /// Task 4 on the KChat `AccessRevoked` transition.
    ///
    /// Phase ordering (load-bearing for the defence-in-depth
    /// guarantee):
    ///
    /// 1. **Count** the chunks + indexed_files about to be dropped.
    ///    Returned to the caller so the audit row records what was
    ///    scrubbed even after the rows are gone.
    /// 2. **`PRAGMA secure_delete = ON`** — must run *before* any
    ///    `DELETE` so SQLite zero-fills the freed pages at delete
    ///    time. If we set it after the deletes (as an earlier draft
    ///    did), a subsequent `VACUUM` failure (e.g. insufficient
    ///    disk space for the temp file) leaves the freed pages
    ///    holding the original plaintext.
    /// 3. **`BEGIN IMMEDIATE`** — wrap the row-level mutations in an
    ///    explicit transaction so a crash mid-shred either rolls
    ///    back to the pre-shred state or commits the full scrub.
    ///    `VACUUM` (Phase 5) cannot run inside a transaction, so it
    ///    is intentionally outside.
    /// 4. **`DELETE FROM chunks` / `DELETE FROM indexed_files`** —
    ///    `chunks_ad` and `chunks_ad_embeddings` triggers cascade
    ///    the chunk delete to `chunks_fts` and `chunk_embeddings`
    ///    so the single DELETE scrubs all three retrieval surfaces
    ///    atomically. **Plus** reset `sources.last_indexed = NULL`
    ///    and `file_count = 0` so the source-detail UI mirrors the
    ///    scrub. All four statements live in the same transaction.
    /// 5. **`VACUUM`** — only when chunks or files were actually
    ///    dropped. `VACUUM` rebuilds the entire database file; on
    ///    the idempotent `already_revoked` path (drops nothing), we
    ///    skip it because rebuilding the whole file to free zero
    ///    pages would block every concurrent reader for seconds on
    ///    large databases. The `secure_delete = ON` page zero-fill
    ///    in Phase 4 still ran on the actual delete path, so the
    ///    cryptographic guarantee holds; VACUUM is the
    ///    belt-and-braces freelist sweep, not the primary scrub.
    ///    Fifth-pass Devin Review fix
    ///    (ANALYSIS_pr-review-job-ef3c7d6c..._0001): a VACUUM
    ///    failure here is NON-FATAL — the row-level scrub already
    ///    committed under `secure_delete = ON`, so the cryptographic
    ///    property holds even when VACUUM cannot rewrite the file.
    ///    The function returns `Ok(outcome)` with
    ///    `vacuum_succeeded = false` and the error text in
    ///    `vacuum_error`, which the bridge + audit logger surface as
    ///    a `vacuum_succeeded=false` row so an operator grep finds
    ///    revokes that need a manual `VACUUM` re-run. Previously a
    ///    `?`-propagated VACUUM error reached the forwarder's catch
    ///    block and defaulted the audit row to `"unlinked"`, hiding
    ///    the successful scrub from the trail.
    /// 6. **`PRAGMA secure_delete = OFF`** — restore the connection
    ///    to the default low-overhead delete path. The pragma is
    ///    connection-scoped and the connection is shared, so this
    ///    reset is required to avoid measurable write-amplification
    ///    on the steady-state indexing path.
    pub fn cryptoshred_kchat_source_evidence(
        &self,
        source_id: &SourceId,
    ) -> Result<KchatSourceCryptoshredOutcome> {
        let id_str = source_id.to_string();
        let mut conn = self.conn.lock().expect("connection mutex poisoned");

        // Phase 1 — count what we're about to drop so the audit row
        // can record observability data even after the rows are gone.
        // The counts MUST be read on the same locked Connection as
        // the deletes so a concurrent writer can't expand the row-set
        // between count and delete.
        let chunks_to_drop: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM chunks c
                 JOIN indexed_files f ON f.id = c.indexed_file_id
                 WHERE f.source_id = ?1",
                params![id_str],
                |row| row.get(0),
            )
            .map_err(Error::Sqlite)?;

        let files_to_drop: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM indexed_files WHERE source_id = ?1",
                params![id_str],
                |row| row.get(0),
            )
            .map_err(Error::Sqlite)?;

        // count the per-post bookkeeping
        // rows and the wrapped-DEK row that the scrub will also drop.
        // Surfacing both counts on the audit row gives operators a
        // straight observability signal that the DEK destruction
        // step succeeded (a `KchatChannelAccessRevoked` row WITHOUT a
        // matching `KchatSourceCryptoshredded` carrying
        // `dek_dropped=true` would mean the post-evidence layer was
        // not cryptographically retired).
        let posts_to_drop: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM kchat_posts WHERE source_id = ?1",
                params![id_str],
                |row| row.get(0),
            )
            .map_err(Error::Sqlite)?;

        let dek_to_drop: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM kchat_source_deks WHERE source_id = ?1",
                params![id_str],
                |row| row.get(0),
            )
            .map_err(Error::Sqlite)?;

        // Phase 2 — enable secure_delete BEFORE the DELETEs so the
        // freed pages are zero-filled at delete time. This is what
        // makes the scrub resilient to a later VACUUM failure: even
        // if disk pressure or process kill aborts Phase 5, the rows
        // we just deleted are already overwritten with zeros on the
        // freelist pages.
        //
        // CRITICAL: `secure_delete` is a connection-scoped pragma,
        // and the `SharedConnection` is reused by every store in
        // the process. If we set ON here and any subsequent
        // statement returns early via `?`, the pragma stays ON for
        // the remaining lifetime of the process — every chunk
        // insert / FTS5 trigger fire / audit append then pays the
        // page-zero-fill cost. We MUST reset to OFF on every exit
        // path, including errors.
        //
        // We can't use a `Drop`-based RAII guard here because it
        // would have to borrow `conn`, conflicting with the
        // `&mut conn` borrow required by `transaction_with_behavior`.
        // Instead we run the fallible phases inside an immediately-
        // invoked closure so `?`-propagation early-returns from the
        // *closure* (not the function), and the OFF reset always
        // runs after the closure returns. This is the standard Rust
        // pattern for "always run cleanup on every fallible exit"
        // when a Drop-based guard would conflict with downstream
        // borrows.
        conn.execute_batch("PRAGMA secure_delete = ON;")
            .map_err(Error::Sqlite)?;

        let scrub_result: Result<()> = (|| {
            // Phases 3+4 — wrap the row-level mutations in an
            // explicit transaction so crash-recovery returns either
            // the full pre-shred state or the full post-shred
            // state, never a partial scrub (chunks gone,
            // indexed_files still present). `BEGIN IMMEDIATE`
            // acquires a RESERVED lock right away so a concurrent
            // reader can't acquire SHARED between our COUNTs and
            // our DELETEs.
            let txn = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(Error::Sqlite)?;

            // DELETE FROM chunks fires the `chunks_ad` trigger
            // (removes the row from `chunks_fts`) and the
            // `chunks_ad_embeddings` trigger (removes the matching
            // `chunk_embeddings` rows), so this single DELETE
            // scrubs all three retrieval surfaces atomically. The
            // cascade depends on `PRAGMA foreign_keys = ON`, which
            // `apply_default_pragmas` installs on every connection
            // in `tessera_core::db`.
            txn.execute(
                "DELETE FROM chunks
                 WHERE indexed_file_id IN
                     (SELECT id FROM indexed_files WHERE source_id = ?1)",
                params![id_str],
            )
            .map_err(Error::Sqlite)?;

            // Drop the kchat_posts bookkeeping rows BEFORE
            // `indexed_files` because the post row has a FK to
            // `indexed_files.id` that does NOT cascade — the FK is
            // a referential integrity guard for the manager's
            // edit/delete paths, not a delete trigger. Letting the
            // indexed_files DELETE fire first would FK-fail the
            // shred.
            txn.execute(
                "DELETE FROM kchat_posts WHERE source_id = ?1",
                params![id_str],
            )
            .map_err(Error::Sqlite)?;

            txn.execute(
                "DELETE FROM indexed_files WHERE source_id = ?1",
                params![id_str],
            )
            .map_err(Error::Sqlite)?;

            // drop the wrapped-DEK row
            // INSIDE the same transaction so a crash between the
            // chunk-scrub and the DEK-row deletion cannot leave a
            // wrapped DEK pointing at chunk rows that no longer
            // exist. The caller (manager.rs) ALSO calls
            // `KchatCrypto::forget_dek` on the in-memory cache after
            // this function returns, so the in-process bytes are
            // zeroized too. Together these make the
            // cryptoshred-after-revoke invariant complete: chunks +
            // AEAD bytes + persisted DEK + in-memory DEK are all
            // gone before the source's revoke event finishes.
            txn.execute(
                "DELETE FROM kchat_source_deks WHERE source_id = ?1",
                params![id_str],
            )
            .map_err(Error::Sqlite)?;

            // Reset the source-row aggregates so the renderer's
            // source-detail surface reflects the scrub. Status is
            // NOT changed here — the manager has already set it to
            // `AccessRevoked` (or will, in the same overall
            // operation).
            //
            // also clear the backfill
            // cursor + completion sentinel. If the user later
            // re-grants access to this channel, the backfill walk
            // MUST start from the newest post again — the previous
            // cursor pointed at a post id whose AEAD ciphertext was
            // just shredded, and the previous "completed" flag is
            // stale because the chunks it accounted for no longer
            // exist. Doing this in the same transaction as the
            // chunk/file/post/DEK deletes keeps the invariant
            // crash-recovery atomic.
            txn.execute(
                "UPDATE sources
                 SET last_indexed = NULL,
                     file_count = 0,
                     kchat_backfill_oldest_post_id = NULL,
                     kchat_backfill_completed_at = NULL
                 WHERE id = ?1",
                params![id_str],
            )
            .map_err(Error::Sqlite)?;

            txn.commit().map_err(Error::Sqlite)?;

            // the DELETE FROM chunks above
            // cascaded into `chunk_embeddings` via the
            // `chunks_ad_embeddings` trigger. The hybrid-search
            // cache cannot tell from the embedding-row generation
            // alone that a cryptoshred just landed, so bump
            // explicitly. Done inside the closure (after commit)
            // so we only bump on the success path.
            Ok(())
        })();

        // Phase 5 — VACUUM (cannot run inside a transaction). Moved
        // OUT of the scrub_result closure
        // fix, ANALYSIS_pr-review-job-ef3c7d6c..._0001): a VACUUM
        // failure after the DELETE + UPDATE transaction commits is
        // NOT a scrub failure. The row-level deletes already ran
        // under `PRAGMA secure_delete = ON` so the freed pages are
        // zero-filled; the cryptographic property holds. VACUUM is
        // the belt-and-braces freelist sweep — a failure here means
        // the on-disk freelist still holds zero-filled pages but in
        // the original file layout. Operators want to learn about
        // that so they can re-run `VACUUM` once disk space recovers,
        // but propagating the error as a hard failure would default
        // the forwarder's audit row to `"unlinked"` ("we never saw
        // the revoke") when in fact the substrate scrub succeeded.
        //
        // Only pay the full-file-rewrite cost when we actually
        // deleted rows; the idempotent `already_revoked` path is a
        // no-op so there is nothing for VACUUM to reclaim.
        //
        // Skip VACUUM entirely if the scrub_result already errored —
        // there's no point rebuilding the file when the rows weren't
        // deleted in the first place, and running VACUUM against a
        // poisoned connection would mask the original error.
        // bump on the success path only.
        // Done here (after the scrub closure returns) because we
        // need to read `scrub_result` outside the closure scope and
        // we must NOT bump if the transaction rolled back.
        if scrub_result.is_ok() && chunks_to_drop > 0 {
            self.bump_embedding_generation();
        }

        let (vacuum_succeeded, vacuum_error) =
            if scrub_result.is_ok() && (chunks_to_drop > 0 || files_to_drop > 0) {
                match conn.execute_batch("VACUUM;") {
                    Ok(()) => (true, None),
                    Err(e) => {
                        let msg = e.to_string();
                        eprintln!(
                            "[cryptoshred] VACUUM failed for source {id_str} after a \
                         successful row-level scrub; secure_delete zero-filled the \
                         freed pages so the cryptographic guarantee holds, but the \
                         freelist sweep did not rebuild the file layout. Re-run \
                         VACUUM manually once the underlying issue resolves: {msg}"
                        );
                        (false, Some(msg))
                    }
                }
            } else {
                // No VACUUM run — either the scrub failed (we will
                // propagate the scrub error below) or there was nothing
                // to reclaim. Both are non-failures for the VACUUM
                // observability surface.
                (true, None)
            };

        // Phase 6 — ALWAYS restore the connection's default delete
        // mode, even if the scrub above failed. If we propagated
        // the error without resetting, the shared connection would
        // be stuck in `secure_delete = ON` for the rest of the
        // process lifetime, silently degrading every steady-state
        // chunk insert.
        //
        // Diagnostic-ordering invariant the reset diagnostic MUST be
        // emitted before the scrub error is propagated, otherwise
        // the rare scrub-failed + reset-failed double-failure case
        // would silently lose the reset diagnostic — the operator
        // would see the scrub error and assume the connection is
        // healthy, when in fact `secure_delete` is still ON and
        // every steady-state write is paying the page-zero-fill
        // cost for the remaining process lifetime. The eprintln!
        // here is the *only* operator-visible signal that the
        // connection is in the degraded state, so it always runs
        // first.
        //
        // The original `scrub_result` error still takes precedence
        // as the function's return value — it's what the caller
        // primarily needs to know about (e.g. a `BEGIN IMMEDIATE`
        // failing under lock contention, or a DELETE hitting a
        // poisoned page). VACUUM errors no longer flow through
        // here (Phase 5 is post-closure and reports via
        // `outcome.vacuum_succeeded` / `outcome.vacuum_error`
        // instead). The reset failure rides along in stderr so an
        // operator grep-ing the logs can correlate both failures
        // with the same audit row.
        let reset_result = conn
            .execute_batch("PRAGMA secure_delete = OFF;")
            .map_err(Error::Sqlite);

        if let Err(e) = reset_result.as_ref() {
            eprintln!(
                "[cryptoshred] failed to reset secure_delete=OFF on shared \
                 connection; steady-state writes will pay zero-fill overhead \
                 until process restart: {e}"
            );
        }

        scrub_result?;
        reset_result?;

        Ok(KchatSourceCryptoshredOutcome {
            chunks_dropped: u32::try_from(chunks_to_drop).unwrap_or(u32::MAX),
            files_dropped: u32::try_from(files_to_drop).unwrap_or(u32::MAX),
            posts_dropped: u32::try_from(posts_to_drop).unwrap_or(u32::MAX),
            dek_dropped: dek_to_drop > 0,
            vacuum_succeeded,
            vacuum_error,
        })
    }

    /// Upsert indexed file.
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
            // Re-indexing a changed file drops the previous revision's
            // chunks, which hold its indexed plaintext. Zero-fill the
            // freed pages so the superseded content cannot be recovered
            // from the freelist — same guarantee as the explicit
            // `delete_chunks_for_indexed_file` / `remove_indexed_file`
            // paths. Only the DELETE needs the pragma; the metadata
            // UPDATE below carries no freed plaintext.
            with_secure_delete(&conn, |conn| {
                conn.execute(
                    "DELETE FROM chunks WHERE indexed_file_id = ?1",
                    params![file_id],
                )
                .map_err(Error::Sqlite)
            })?;
            conn.execute(
                "UPDATE indexed_files SET hash = ?1, last_modified = ?2, chunk_count = 0 WHERE id = ?3",
                params![hash, last_modified, file_id],
            )
            .map_err(Error::Sqlite)?;
            Ok(file_id)
        } else {
            conn.execute(
                "INSERT INTO indexed_files (source_id, path, hash, last_modified, chunk_count) VALUES (?1, ?2, ?3, ?4, 0)",
                params![id_str, path, hash, last_modified],
            )
            .map_err(Error::Sqlite)?;
            Ok(conn.last_insert_rowid())
        }
    }

    /// Insert chunks.
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
                    "INSERT INTO chunks (
                        indexed_file_id, chunk_index, byte_offset, content, hash,
                        extraction_method, extraction_model_id
                     )
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )
                .map_err(Error::Sqlite)?;

            for chunk in chunks {
                stmt.execute(params![
                    indexed_file_id,
                    chunk.chunk_index as i64,
                    chunk.byte_offset as i64,
                    chunk.content,
                    chunk.hash,
                    chunk
                        .extraction_method
                        .map(crate::chunker::ExtractionMethod::as_str),
                    chunk.extraction_model_id.as_deref(),
                ])
                .map_err(Error::Sqlite)?;
                ids.push(conn.last_insert_rowid());
            }
        }

        conn.execute(
            "UPDATE indexed_files SET chunk_count = ?1 WHERE id = ?2",
            params![chunks.len() as i64, indexed_file_id],
        )
        .map_err(Error::Sqlite)?;

        // Corpus composition just changed; drop the multilingual-hint cache so
        // the next status poll re-scans rather than serving stale ratios for up
        // to NON_ASCII_CACHE_TTL.
        drop(conn);
        self.invalidate_non_ascii_cache();

        Ok(ids)
    }

    // ---- Block C Tasks 1 + 2 — KChat post storage ----
    //
    // The following methods implement the per-post bookkeeping +
    // chunk storage that lets the WS forwarder dispatch
    // `posted` / `post_edited` / `post_deleted` events into the
    // indexed corpus. They sit in `store.rs` rather than in
    // `manager.rs` because the storage shape is a property of the
    // SQLite schema, and the manager-level orchestration on top
    // (chunking + AEAD seal + audit) lives in
    // `manager::ingest_kchat_post` / `edit_kchat_post` /
    // `delete_kchat_post`.

    /// Look up the wrapped DEK for `source_id`, if one has been
    /// generated.
    ///
    /// Returns `Ok(None)` when the row does not exist — used by
    /// `KchatCrypto::ensure_dek_for_source` (manager layer) to
    /// decide whether to call `generate_and_wrap_dek` (no row) vs
    /// `unwrap_dek` (row present). Surfacing this as `Option`
    /// avoids forcing the manager to swallow a `not found` error.
    pub fn load_wrapped_dek_for_source(
        &self,
        source_id: &SourceId,
    ) -> Result<Option<crate::kchat_crypto::WrappedDek>> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let row: Option<(Vec<u8>, Vec<u8>)> = conn
            .query_row(
                "SELECT wrap_nonce, wrapped_dek FROM kchat_source_deks WHERE source_id = ?1",
                params![id_str],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        row.map(|(nonce, wrapped)| crate::kchat_crypto::WrappedDek::from_blobs(&nonce, &wrapped))
            .transpose()
    }

    /// Persist a fresh wrapped DEK for `source_id`. Idempotent: a
    /// concurrent call (or a retry after a partial failure) that
    /// finds an existing row replaces it — this is the right
    /// behaviour for the rare double-ingest race because the
    /// previous DEK has not yet sealed any rows (the manager
    /// always calls `seal_chunk` AFTER `upsert_wrapped_dek` so a
    /// rolled-back seal does not leak DEK material).
    pub fn upsert_wrapped_dek(
        &self,
        source_id: &SourceId,
        wrapped: &crate::kchat_crypto::WrappedDek,
    ) -> Result<()> {
        let id_str = source_id.to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let conn = self.conn.lock().expect("connection mutex poisoned");
        conn.execute(
            "INSERT INTO kchat_source_deks (source_id, wrap_nonce, wrapped_dek, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(source_id) DO UPDATE SET
                wrap_nonce = excluded.wrap_nonce,
                wrapped_dek = excluded.wrapped_dek,
                created_at = excluded.created_at",
            params![id_str, &wrapped.wrap_nonce[..], &wrapped.wrapped[..], now],
        )
        .map_err(Error::Sqlite)?;
        Ok(())
    }

    /// Locate an existing `kchat_posts` row by (source_id, post_id).
    /// Returns `(indexed_file_id, message_hash)` so the manager can
    /// decide between "no-op (same hash)", "edit (re-chunk)", or
    /// "delete (tombstone)".
    pub fn find_kchat_post(
        &self,
        source_id: &SourceId,
        post_id: &str,
    ) -> Result<Option<(i64, String)>> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let row: Option<(i64, String)> = conn
            .query_row(
                "SELECT indexed_file_id, message_hash
                 FROM kchat_posts
                 WHERE source_id = ?1 AND post_id = ?2",
                params![id_str, post_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        Ok(row)
    }

    /// look up the citation-metadata of
    /// a `kchat_posts` row by `(source_id, post_id)`.
    ///
    /// Returns `(channel_id, root_id, created_at_ms)` so the
    /// manager-layer `fetch_kchat_thread_context` can:
    ///
    /// 1. Short-circuit on a top-level post (`root_id IS NULL`),
    ///    because a post that is its own root has no parent
    ///    messages to surface.
    /// 2. Cap the parent-message window at the hit's
    ///    `created_at_ms`, so the renderer never sees a "parent"
    ///    that was actually posted AFTER the hit (which would be
    ///    a future-leak in a re-ingested thread where reply
    ///    indices got reordered).
    ///
    /// Sibling of `find_kchat_post` but surfaced separately so
    /// the existing call sites (ingest dedupe, edit re-chunk) can
    /// stay on the cheaper two-column lookup. This shape carries
    /// the substrate-side metadata the renderer needs to build a
    /// thread-context request.
    pub fn find_kchat_post_metadata(
        &self,
        source_id: &SourceId,
        post_id: &str,
    ) -> Result<Option<(String, Option<String>, i64)>> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let row: Option<(String, Option<String>, i64)> = conn
            .query_row(
                "SELECT channel_id, root_id, created_at_ms
                 FROM kchat_posts
                 WHERE source_id = ?1 AND post_id = ?2",
                params![id_str, post_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                },
            )
            .ok();
        Ok(row)
    }

    /// fetch up to `max_context` rows
    /// of thread context for a search hit whose `root_id` resolves
    /// to `root_post_id`.
    ///
    /// Returns the thread root (`post_id = root_post_id`) AND the
    /// most-recent earlier-replies (`root_id = root_post_id AND
    /// created_at_ms < before_created_at_ms`), capped at
    /// `max_context` rows total. The root, when present, is
    /// always included — the SQL orders by `(post_id = root) DESC`
    /// first so a row matching the root flips the boolean cast to
    /// `1` and slots ahead of any sibling reply in the same
    /// `LIMIT` window. Within the remaining slots, siblings are
    /// taken most-recent-first so the renderer surfaces the
    /// closest-in-time context to the hit rather than the thread's
    /// oldest replies.
    ///
    /// The outer `ORDER BY created_at_ms ASC` renders the result
    /// chronologically (oldest first) for top-down conversation
    /// display.
    ///
    /// **Single-chunk preview semantics.** Only the leading chunk
    /// (`chunks.chunk_index = 0`) of each context post is returned.
    /// In the typical case a KChat post body fits in one chunk
    /// (the default `Chunker` produces 1 chunk per ≤ 1024-char
    /// post; threaded replies are short by convention), so this
    /// is the entire body. For unusually-long parent messages the
    /// renderer can render a "…" affordance and offer a "show
    /// full thread" expansion.
    ///
    /// **Trust boundary.** This function returns `content` in
    /// plaintext (from `chunks.content`) AND the `content_aead` /
    /// `content_aead_nonce` ciphertext+nonce columns so the
    /// manager layer can re-verify the AEAD tag before yielding
    /// to the renderer. Rows whose ciphertext columns are NULL
    /// (cryptoshredded) survive the SQL filter (the WHERE clause
    /// does not require non-null ciphertext) so the manager
    /// distinguishes "no thread context" from "thread context
    /// dropped by AEAD verification"; both surface to the
    /// renderer as an empty / partial vec.
    ///
    /// **Same-source isolation.** The `source_id` filter is
    /// load-bearing — a `root_id` can be re-used across sources
    /// if the same post id appears in different KChat channels
    /// linked under different sources (e.g. two principals
    /// indexing the same channel). Without this filter, a
    /// `root_id` collision across sources would surface other
    /// principals' messages as thread context. The Block C Task 3
    /// per-source DEK gate at the manager layer would still drop
    /// other principals' rows on AEAD verification, but
    /// short-circuiting at the SQL layer is cheaper and
    /// independently correct.
    ///
    /// Manager-side wrapper:
    /// [`crate::manager::SourceManager::fetch_kchat_thread_context`].
    pub fn fetch_kchat_thread_context_rows(
        &self,
        source_id: &SourceId,
        root_post_id: &str,
        before_created_at_ms: i64,
        max_context: usize,
    ) -> Result<Vec<KchatThreadContextRow>> {
        let id_str = source_id.to_string();
        // Clamp to a sane upper bound — even a thread with
        // hundreds of replies should only surface a handful of
        // most-recent siblings; SQL `LIMIT` larger than
        // `i64::MAX` is a wire-format error.
        let limit = max_context.min(i64::MAX as usize) as i64;

        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                // Devin Review pass 1
                // (5860a94): the CTE's ordering relies on
                // SQLite casting the boolean `(post_id = ?2)` to 1/0,
                // so `... DESC, created_at_ms DESC` pulls the root row
                // (boolean 1) ahead of every sibling reply (boolean 0)
                // in the LIMIT window, then fills remaining slots with
                // most-recent siblings. The outer `ORDER BY
                // s.created_at_ms ASC` then restores chronological
                // order for the renderer. See the function's doc
                // comment for the full rationale.
                "WITH selected AS (
                     SELECT p.post_id, p.channel_id, p.root_id, p.sender_user_id,
                            p.created_at_ms, p.edited_at_ms, p.indexed_file_id
                     FROM kchat_posts p
                     WHERE p.source_id = ?1
                       AND (
                           p.post_id = ?2
                           OR (p.root_id = ?2 AND p.created_at_ms < ?3)
                       )
                     -- (post_id = ?2) casts to 1 for the root, 0 for
                     -- siblings; DESC pulls the root first.
                     ORDER BY (p.post_id = ?2) DESC, p.created_at_ms DESC
                     LIMIT ?4
                 )
                 SELECT s.post_id, s.channel_id, s.root_id, s.sender_user_id,
                        s.created_at_ms, s.edited_at_ms,
                        c.content, c.content_aead, c.content_aead_nonce
                 FROM selected s
                 JOIN chunks c ON c.indexed_file_id = s.indexed_file_id
                 WHERE c.chunk_index = 0
                 -- Renderer expects oldest-first conversation order.
                 ORDER BY s.created_at_ms ASC",
            )
            .map_err(Error::Sqlite)?;

        let rows: Vec<KchatThreadContextRow> = stmt
            .query_map(
                params![id_str, root_post_id, before_created_at_ms, limit],
                |row| {
                    Ok(KchatThreadContextRow {
                        post_id: row.get(0)?,
                        channel_id: row.get(1)?,
                        root_id: row.get(2)?,
                        sender_user_id: row.get(3)?,
                        created_at_ms: row.get::<_, i64>(4)?,
                        edited_at_ms: row.get::<_, i64>(5)?,
                        content: row.get(6)?,
                        content_aead: row.get(7)?,
                        content_aead_nonce: row.get(8)?,
                    })
                },
            )
            .map_err(Error::Sqlite)?
            .filter_map(std::result::Result::ok)
            .collect();

        Ok(rows)
    }

    /// Insert a new `kchat_posts` row and the matching
    /// `indexed_files` row, returning the indexed_files row id so
    /// the caller can insert chunks against it.
    ///
    /// Called by `manager::ingest_kchat_post` on the
    /// new-post path. Edit / delete paths go through the
    /// dedicated functions below to keep the SQL specialised to
    /// the action being taken.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_kchat_post_bookkeeping(
        &self,
        source_id: &SourceId,
        post_id: &str,
        channel_id: &str,
        root_id: Option<&str>,
        sender_user_id: &str,
        message_hash: &str,
        created_at_ms: i64,
        edited_at_ms: i64,
    ) -> Result<i64> {
        let id_str = source_id.to_string();
        let now = chrono::Utc::now().to_rfc3339();
        // The indexed_files `path` is `kchat:post:<post_id>` — a
        // synthetic URI distinct from any real filesystem path, so
        // the existing UNIQUE(path) constraint doesn't conflict
        // with file-sourced rows. The substring `kchat:post:` is
        // also what retrieval surfaces use to discriminate
        // post-sourced chunks from file-sourced ones without
        // joining `kchat_posts`.
        let synthetic_path = format!("kchat:post:{post_id}");

        let conn = self.conn.lock().expect("connection mutex poisoned");

        // Insert (or upsert) the indexed_files row first so the FK
        // from kchat_posts.indexed_file_id is satisfied.
        // last_modified := ingest timestamp (rfc3339) so the
        // renderer's "Sources" surface can order channels by
        // most-recent activity without joining kchat_posts.
        conn.execute(
            "INSERT INTO indexed_files (source_id, path, hash, last_modified, chunk_count)
             VALUES (?1, ?2, ?3, ?4, 0)
             ON CONFLICT(path) DO UPDATE SET
                hash = excluded.hash,
                last_modified = excluded.last_modified,
                chunk_count = 0",
            params![id_str, synthetic_path, message_hash, now],
        )
        .map_err(Error::Sqlite)?;

        let indexed_file_id: i64 = conn
            .query_row(
                "SELECT id FROM indexed_files WHERE path = ?1",
                params![synthetic_path],
                |r| r.get(0),
            )
            .map_err(Error::Sqlite)?;

        conn.execute(
            "INSERT INTO kchat_posts (
                source_id, post_id, channel_id, root_id, sender_user_id,
                indexed_file_id, message_hash, created_at_ms, edited_at_ms, ingested_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(source_id, post_id) DO UPDATE SET
                root_id = excluded.root_id,
                sender_user_id = excluded.sender_user_id,
                indexed_file_id = excluded.indexed_file_id,
                message_hash = excluded.message_hash,
                created_at_ms = excluded.created_at_ms,
                edited_at_ms = excluded.edited_at_ms,
                ingested_at = excluded.ingested_at",
            params![
                id_str,
                post_id,
                channel_id,
                root_id,
                sender_user_id,
                indexed_file_id,
                message_hash,
                created_at_ms,
                edited_at_ms,
                now,
            ],
        )
        .map_err(Error::Sqlite)?;

        Ok(indexed_file_id)
    }

    /// Insert chunks for a KChat post, writing BOTH plaintext
    /// (`content` — needed by FTS5 for tokenisation, dropped in
    /// lockstep with the AEAD copy on cryptoshred) AND
    /// AEAD-ciphertext (`content_aead` + `content_aead_nonce` —
    /// the cryptographic-forgetting belt-and-braces).
    ///
    /// `sealed` must be the same length and ordering as `chunks`;
    /// the manager layer (`manager::ingest_kchat_post`) computes
    /// both in a single pass to keep this invariant. A length
    /// mismatch is a programmer error and returns a hard
    /// `Error::DatabaseState`.
    ///
    /// On a successful insert, the matching `indexed_files`
    /// row's `chunk_count` is updated. The transaction boundary
    /// is the caller's — this function does the row-level
    /// inserts; the manager wraps the bookkeeping + chunk
    /// inserts in `BEGIN IMMEDIATE` so a partial insert cannot
    /// leak a half-indexed post.
    pub fn insert_kchat_post_chunks(
        &self,
        indexed_file_id: i64,
        chunks: &[Chunk],
        sealed: &[crate::kchat_crypto::SealedChunk],
    ) -> Result<Vec<i64>> {
        if chunks.len() != sealed.len() {
            return Err(Error::DatabaseState(format!(
                "insert_kchat_post_chunks: chunks/sealed length mismatch ({} vs {})",
                chunks.len(),
                sealed.len()
            )));
        }

        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut ids = Vec::with_capacity(chunks.len());
        {
            let mut stmt = conn
                .prepare(
                    "INSERT INTO chunks (
                        indexed_file_id, chunk_index, byte_offset, content, hash,
                        extraction_method, extraction_model_id,
                        kind, content_aead, content_aead_nonce
                     )
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                )
                .map_err(Error::Sqlite)?;
            for (chunk, seal) in chunks.iter().zip(sealed.iter()) {
                stmt.execute(params![
                    indexed_file_id,
                    chunk.chunk_index as i64,
                    chunk.byte_offset as i64,
                    chunk.content,
                    chunk.hash,
                    chunk
                        .extraction_method
                        .map(crate::chunker::ExtractionMethod::as_str),
                    chunk.extraction_model_id.as_deref(),
                    "chat_post",
                    &seal.ciphertext[..],
                    &seal.nonce[..],
                ])
                .map_err(Error::Sqlite)?;
                ids.push(conn.last_insert_rowid());
            }
        }

        conn.execute(
            "UPDATE indexed_files SET chunk_count = ?1 WHERE id = ?2",
            params![chunks.len() as i64, indexed_file_id],
        )
        .map_err(Error::Sqlite)?;

        // Same rationale as `insert_chunks_returning_ids`: invalidate the
        // multilingual-hint cache after a chunk-set mutation.
        drop(conn);
        self.invalidate_non_ascii_cache();

        Ok(ids)
    }

    /// Delete all chunks for the given `indexed_file_id`. Used by
    /// `manager::edit_kchat_post` (delete-old-then-insert-new) and
    /// by `delete_kchat_post` (tombstone-then-drop-row). Resets
    /// the `chunk_count` aggregate.
    pub fn delete_chunks_for_indexed_file(&self, indexed_file_id: i64) -> Result<u32> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        // Zero-fill the freed chunk pages at delete time so the indexed
        // plaintext cannot be recovered from the freelist after the row
        // is dropped.
        let deleted = with_secure_delete(&conn, |conn| {
            conn.execute(
                "DELETE FROM chunks WHERE indexed_file_id = ?1",
                params![indexed_file_id],
            )
            .map_err(Error::Sqlite)
        })?;
        conn.execute(
            "UPDATE indexed_files SET chunk_count = 0 WHERE id = ?1",
            params![indexed_file_id],
        )
        .map_err(Error::Sqlite)?;
        // Same rationale as `insert_chunks_returning_ids`: invalidate the
        // multilingual-hint cache after a chunk-set mutation.
        drop(conn);
        self.invalidate_non_ascii_cache();
        // the `chunks_ad_embeddings` trigger
        // cascades the chunk delete into `chunk_embeddings`, which
        // changes the row set `load_embeddings_for_model` returns.
        // Bump only when something was actually deleted to avoid
        // gratuitously invalidating the cache on no-op calls.
        if deleted > 0 {
            self.bump_embedding_generation();
        }
        Ok(u32::try_from(deleted).unwrap_or(u32::MAX))
    }

    /// Drop the `kchat_posts` row AND the `indexed_files` row for
    /// the post. Caller must have already deleted the chunks for
    /// `indexed_file_id` (or be willing to leave them orphaned —
    /// the FK from `chunks.indexed_file_id` to `indexed_files.id`
    /// does NOT cascade and the integrity check is enforced).
    pub fn delete_kchat_post_bookkeeping(
        &self,
        source_id: &SourceId,
        post_id: &str,
        indexed_file_id: i64,
    ) -> Result<()> {
        let id_str = source_id.to_string();
        let mut conn = self.conn.lock().expect("connection mutex poisoned");
        // Scrub the post bookkeeping + indexed_file rows under
        // `secure_delete = ON` so the freed pages are zero-filled. Both
        // DELETEs run in one `BEGIN IMMEDIATE` transaction: the
        // `kchat_posts` row carries a non-cascading FK to
        // `indexed_files.id`, so a crash after the first DELETE but
        // before the second (or the reverse ordering) could otherwise
        // leave an orphaned `indexed_files` row whose post bookkeeping
        // is gone.
        with_secure_delete_transaction(&mut conn, |txn| {
            txn.execute(
                "DELETE FROM kchat_posts WHERE source_id = ?1 AND post_id = ?2",
                params![id_str, post_id],
            )
            .map_err(Error::Sqlite)?;
            txn.execute(
                "DELETE FROM indexed_files WHERE id = ?1",
                params![indexed_file_id],
            )
            .map_err(Error::Sqlite)?;
            Ok(())
        })
    }

    /// Count the number of chunks currently indexed for a
    /// `kchat_posts` row, by `indexed_file_id`. Used by tests +
    /// the audit row.
    pub fn count_chunks_for_indexed_file(&self, indexed_file_id: i64) -> Result<u32> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chunks WHERE indexed_file_id = ?1",
                params![indexed_file_id],
                |r| r.get(0),
            )
            .map_err(Error::Sqlite)?;
        Ok(u32::try_from(count).unwrap_or(u32::MAX))
    }

    /// corpus-wide non-ASCII chunk ratio for the
    /// "you should consider the multilingual embedder" hint in the
    /// Settings page.
    ///
    /// Returns `(non_ascii_chunks, total_chunks)`. The renderer
    /// computes the ratio so it can also surface the absolute
    /// counts ("128 of 1,400 chunks contain non-Latin text") which
    /// is more informative than a bare percentage.
    ///
    /// **Heuristic, not exact.** The non-ASCII check is the SQLite
    /// GLOB `'*[^' || x'01' || '-' || x'7f' || ']*'` (i.e. a byte
    /// range from 0x01..=0x7F with `[^...]` negation), which counts
    /// any chunk that contains at least one byte outside the
    /// printable-ASCII range. That includes legitimate non-Latin
    /// content (CJK, Cyrillic, Arabic, Devanagari, Hangul, …) but
    /// also accidentally trips on smart quotes (`'`, `"`), em-
    /// dashes, and other Unicode punctuation that English-only
    /// content frequently carries. We are deliberately accepting
    /// that false-positive rate: the worst case is suggesting
    /// the multilingual model to a user whose corpus is actually
    /// English-with-typography, and the toast is dismissable.
    /// The alternative — running a full language detector over
    /// every chunk — would cost orders of magnitude more CPU for
    /// no actionable improvement at the suggestion threshold
    /// (10%, see Settings UI).
    ///
    /// **Memoized.** The GLOB scan is O(rows) and cannot use an
    /// index — see `NON_ASCII_CACHE_TTL` above. We compute it at
    /// most once per `NON_ASCII_CACHE_TTL` and serve subsequent
    /// calls from the in-memory cache so the 1 s status poll the
    /// Settings page runs does not full-scan the `chunks` table on
    /// every tick.
    pub fn count_non_ascii_chunks(&self) -> Result<(u64, u64)> {
        {
            let cache = self.non_ascii_cache.lock().expect("cache mutex poisoned");
            if let Some((at, value)) = *cache {
                if at.elapsed() < NON_ASCII_CACHE_TTL {
                    return Ok(value);
                }
            }
        }
        // Cache miss / stale. Drop the cache lock BEFORE acquiring
        // the connection lock to avoid pinning ordering: every
        // other call site takes the connection lock and never the
        // cache lock, so a single-direction acquisition here keeps
        // the lock-ordering DAG one-edge wide.
        let value = self.recompute_non_ascii_counts()?;
        let mut cache = self.non_ascii_cache.lock().expect("cache mutex poisoned");
        *cache = Some((Instant::now(), value));
        Ok(value)
    }

    fn recompute_non_ascii_counts(&self) -> Result<(u64, u64)> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
            .map_err(Error::Sqlite)?;
        let non_ascii: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chunks \
                 WHERE content GLOB '*[^\x01-\x7f]*'",
                [],
                |r| r.get(0),
            )
            .map_err(Error::Sqlite)?;
        Ok((non_ascii.max(0) as u64, total.max(0) as u64))
    }

    /// Drop the memoized non-ASCII counts so the next status poll
    /// recomputes. Called after batches that move the corpus
    /// composition meaningfully (chunk insert / delete). Public so
    /// the indexer / bridge can invalidate without owning a
    /// connection lock.
    pub fn invalidate_non_ascii_cache(&self) {
        let mut cache = self.non_ascii_cache.lock().expect("cache mutex poisoned");
        *cache = None;
    }

    /// read the persisted backfill state
    /// for a source.
    ///
    /// Returns `Ok(None)` when the source row does not exist.
    /// Returns `Ok(Some((None, None)))` for a source that has never
    /// run a backfill (the legacy / fresh case). The first field
    /// is the persisted "oldest ingested post id" cursor (used as
    /// the `before=` parameter on the next REST page fetch); the
    /// second is the RFC3339 timestamp at which the walk reached
    /// the end of the channel history (non-NULL ⇒ no further
    /// pagination needed).
    pub fn kchat_backfill_state(
        &self,
        source_id: &SourceId,
    ) -> Result<Option<(Option<String>, Option<String>)>> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let row = conn
            .query_row(
                "SELECT kchat_backfill_oldest_post_id, kchat_backfill_completed_at
                 FROM sources
                 WHERE id = ?1",
                params![id_str],
                |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .ok();
        Ok(row)
    }

    /// Update the backfill cursor to the oldest post id observed
    /// so far. Idempotent against the same value; safe to call
    /// inside a `withChannelSyncLock` because all access goes
    /// through the shared connection mutex.
    ///
    /// Does NOT clear `kchat_backfill_completed_at` — if the walk
    /// is already marked complete, advancing the cursor to a yet-
    /// older post is impossible by construction (the manager
    /// short-circuits the call before reaching this function), and
    /// a test that drives this path on a completed source is
    /// expected to observe the cursor moving without flipping the
    /// completion flag back to NULL.
    pub fn set_kchat_backfill_cursor(
        &self,
        source_id: &SourceId,
        oldest_post_id: &str,
    ) -> Result<()> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let updated = conn
            .execute(
                "UPDATE sources
                 SET kchat_backfill_oldest_post_id = ?2
                 WHERE id = ?1",
                params![id_str, oldest_post_id],
            )
            .map_err(Error::Sqlite)?;
        if updated == 0 {
            return Err(Error::DatabaseState(format!(
                "set_kchat_backfill_cursor: no source row for id={id_str}"
            )));
        }
        Ok(())
    }

    /// Mark the backfill walk as complete (the server returned a
    /// page with `prev_post_id == null`, i.e. there are no posts
    /// older than the current cursor). The renderer treats a
    /// non-NULL completion timestamp as a short-circuit signal so
    /// a re-trigger of `runBackfillKchatChannel` becomes a cheap
    /// "already done" no-op rather than a full re-walk.
    pub fn mark_kchat_backfill_complete(&self, source_id: &SourceId) -> Result<()> {
        let id_str = source_id.to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let updated = conn
            .execute(
                "UPDATE sources
                 SET kchat_backfill_completed_at = ?2
                 WHERE id = ?1",
                params![id_str, now],
            )
            .map_err(Error::Sqlite)?;
        if updated == 0 {
            return Err(Error::DatabaseState(format!(
                "mark_kchat_backfill_complete: no source row for id={id_str}"
            )));
        }
        Ok(())
    }

    /// Read back the AEAD-encrypted columns of a chunk row, for
    /// tests + the (future) verified-retrieval path that wants to
    /// confirm the AEAD copy decrypts to the same plaintext FTS
    /// indexed. Returns `Ok(None)` when the chunk row is a
    /// file_chunk (no AEAD columns populated).
    pub fn load_chunk_aead(
        &self,
        chunk_id: i64,
    ) -> Result<Option<crate::kchat_crypto::SealedChunk>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let row: Option<(Option<Vec<u8>>, Option<Vec<u8>>)> = conn
            .query_row(
                "SELECT content_aead, content_aead_nonce FROM chunks WHERE id = ?1",
                params![chunk_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        match row {
            Some((Some(ciphertext), Some(nonce))) => {
                Ok(Some(crate::kchat_crypto::SealedChunk { nonce, ciphertext }))
            }
            _ => Ok(None),
        }
    }

    /// Block D Task 1 test helper: overwrite the
    /// plaintext `content` column of every chat_post chunk in the
    /// store with the given string WITHOUT re-sealing the
    /// `content_aead` ciphertext. Used by
    /// `search_kchat_posts_drops_aead_mismatched_rows` to simulate
    /// a disk-tamper attack — the FTS5 trigger re-tokenises the
    /// new content, but the AEAD ciphertext still authenticates
    /// the original plaintext, so the manager's plaintext-vs-AEAD
    /// comparison drops the hit.
    ///
    /// Returns the number of rows touched. Test-only: never call
    /// this from production code.
    #[cfg(test)]
    pub(crate) fn tamper_chunk_content_for_test(&self, new_content: &str) -> Result<u32> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let n = conn
            .execute(
                "UPDATE chunks SET content = ?1 WHERE kind = 'chat_post'",
                params![new_content],
            )
            .map_err(Error::Sqlite)?;
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }

    /// variant of
    /// [`Self::tamper_chunk_content_for_test`] that targets a
    /// single `kchat_posts` row by `(source_id, post_id)`.
    ///
    /// Used by `fetch_kchat_thread_context_drops_aead_tampered_rows`
    /// to assert that a single tampered context row is dropped from
    /// the result without taking the honest siblings with it. The
    /// broader `tamper_chunk_content_for_test` helper rewrites every
    /// chat-post chunk, which would conflate the drop semantics
    /// across the whole thread.
    ///
    /// Returns the number of rows touched. Test-only: never call
    /// from production code.
    #[cfg(test)]
    pub(crate) fn tamper_chunk_content_for_post_test(
        &self,
        source_id: &SourceId,
        post_id: &str,
        new_content: &str,
    ) -> Result<u32> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let n = conn
            .execute(
                "UPDATE chunks SET content = ?1
                 WHERE indexed_file_id = (
                     SELECT indexed_file_id FROM kchat_posts
                     WHERE source_id = ?2 AND post_id = ?3
                 )",
                params![new_content, id_str, post_id],
            )
            .map_err(Error::Sqlite)?;
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }

    /// Return every chunk (including provenance columns) attached
    /// to the `indexed_files` row matching `path`, ordered by
    /// `chunk_index`. Used by tests + the renderer's per-file
    /// "show chunks" panel.
    ///
    /// The query joins `indexed_files` so callers can pass the
    /// canonical `source_path` they already have on hand (rather
    /// than threading the synthetic `indexed_file_id` through). The
    /// shape mirrors [`Chunk`] one-to-one — including the new Block
    /// C `extraction_method` / `extraction_model_id` columns — so
    /// callers can round-trip rows back into the chunker's data
    /// model.
    pub fn all_chunks_for_path(&self, path: &str) -> Result<Vec<Chunk>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT c.chunk_index, c.byte_offset, c.content, c.hash,
                        c.extraction_method, c.extraction_model_id
                 FROM chunks c
                 JOIN indexed_files f ON f.id = c.indexed_file_id
                 WHERE f.path = ?1
                 ORDER BY c.chunk_index ASC",
            )
            .map_err(Error::Sqlite)?;
        let rows = stmt
            .query_map(params![path], |row| {
                let extraction_method: Option<String> = row.get(4)?;
                let extraction_model_id: Option<String> = row.get(5)?;
                let chunk_index: i64 = row.get(0)?;
                let byte_offset: i64 = row.get(1)?;
                Ok(Chunk {
                    source_path: path.to_string(),
                    chunk_index: chunk_index as usize,
                    byte_offset: byte_offset as usize,
                    content: row.get(2)?,
                    hash: row.get(3)?,
                    extraction_method: extraction_method
                        .as_deref()
                        .and_then(crate::chunker::ExtractionMethod::from_wire),
                    extraction_model_id,
                })
            })
            .map_err(Error::Sqlite)?
            .filter_map(std::result::Result::ok)
            .collect();
        Ok(rows)
    }

    /// Stamp a `partial:`-prefixed sentinel on the stored hash for
    /// `file_id` so the next `index_file` call's hash comparison
    /// is guaranteed to miss — forcing a full re-process of the
    /// file. Used by the PDF OCR + chart passes when the rate
    /// limiter cuts processing short partway through a multi-
    /// hundred-page document: without this, the file's real
    /// content hash would already be stamped on the row, and the
    /// next pass would short-circuit on hash match and the
    /// unprocessed pages would be permanently lost until the file
    /// content changes.
    ///
    /// The `partial:` prefix is collision-proof: BLAKE3 hex is 64
    /// lowercase hex chars (`[0-9a-f]`), and `:` is not a hex
    /// character. A real BLAKE3 hash can therefore never produce a
    /// string that matches a `partial:`-prefixed sentinel, so a
    /// `existing_hash == new_hash` comparison in
    /// `upsert_indexed_file` is guaranteed to miss and the row
    /// is re-processed (including a `DELETE FROM chunks` so the
    /// partial chunks from the previous attempt are discarded
    /// before the new pass writes its replacements).
    ///
    /// Idempotent: stamping twice keeps a single `partial:` prefix
    /// (we look at the current value and only prepend when it
    /// doesn't already start with the prefix). Without that guard,
    /// repeated partial passes on the same file would compound to
    /// `partial:partial:partial:…` and bloat the row.
    pub fn mark_file_needs_reindex(&self, file_id: i64) -> Result<()> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        conn.execute(
            "UPDATE indexed_files
             SET hash = CASE
                 WHEN hash LIKE 'partial:%' THEN hash
                 ELSE 'partial:' || hash
             END
             WHERE id = ?1",
            params![file_id],
        )
        .map_err(Error::Sqlite)?;
        Ok(())
    }

    /// Get file hash.
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

    /// Remove indexed file.
    pub fn remove_indexed_file(&self, path: &str) -> Result<()> {
        let mut conn = self.conn.lock().expect("connection mutex poisoned");
        if let Ok(file_id) = conn.query_row(
            "SELECT id FROM indexed_files WHERE path = ?1",
            params![path],
            |row| row.get::<_, i64>(0),
        ) {
            // Zero-fill the freed chunk / indexed_file pages so the
            // removed file's indexed text is unrecoverable from the
            // freelist. Both DELETEs run in one `BEGIN IMMEDIATE`
            // transaction so a crash between them can't strand the
            // `indexed_files` row with its chunks already gone (or vice
            // versa).
            with_secure_delete_transaction(&mut conn, |txn| {
                txn.execute(
                    "DELETE FROM chunks WHERE indexed_file_id = ?1",
                    params![file_id],
                )
                .map_err(Error::Sqlite)?;
                txn.execute("DELETE FROM indexed_files WHERE id = ?1", params![file_id])
                    .map_err(Error::Sqlite)?;
                Ok(())
            })?;
        }
        Ok(())
    }

    /// Search fts.
    pub fn search_fts(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        // hot read path → dispatch through
        // the read pool when one is configured. WAL mode lets us
        // run this BM25 scan against a snapshot while a writer
        // continues ingesting; the writer mutex is never held by
        // this scan.
        self.with_read(|conn| {
            // retrieval-side ACL filter.
            // The `JOIN sources s` + `WHERE s.status != ?3` clause
            // excludes chunks whose source row has been transitioned
            // to `SourceStatus::AccessRevoked` (the principal lost
            // KChat-channel membership, or the channel was archived
            // / deleted). Filtering BEFORE the LIMIT means revoked
            // chunks don't consume top-k slots — the FTS5 engine
            // still scores them but they're stripped before sorting
            // truncates to `limit`. The status comparison uses the
            // exact serde-JSON-stringified form (`SourceStatus::as_stored_json`)
            // so a future variant rename cannot drift this predicate
            // from the persistence layer.
            let mut stmt = conn
                .prepare(
                    "SELECT c.id, c.content, c.hash, c.chunk_index, c.byte_offset, f.path,
                            f.source_id, rank
                     FROM chunks_fts fts
                     JOIN chunks c ON c.id = fts.rowid
                     JOIN indexed_files f ON f.id = c.indexed_file_id
                     JOIN sources s ON s.id = f.source_id
                     WHERE chunks_fts MATCH ?1
                       AND s.status != ?3
                     ORDER BY rank
                     LIMIT ?2",
                )
                .map_err(Error::Sqlite)?;

            let results = stmt
                .query_map(
                    params![
                        query,
                        limit as i64,
                        SourceStatus::AccessRevoked.as_stored_json(),
                    ],
                    |row| {
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
                    },
                )
                .map_err(Error::Sqlite)?
                .filter_map(std::result::Result::ok)
                .collect();

            Ok(results)
        })
    }

    /// Look up the contents of a set of chunks by id, preserving the
    /// input order. Used by the hybrid retrieval pipeline to hydrate
    /// the final ranked list with chunk text + source metadata after
    /// fusion has determined the order.
    ///
    /// Block B Task 3 defence-in-depth: the BM25 path
    /// (`search_fts`) and the embedding-load path
    /// (`load_embeddings_for_model`) already filter
    /// `SourceStatus::AccessRevoked` chunks out before they reach
    /// the fusion stage, but a chunk id arriving here that
    /// belongs to a now-revoked source — e.g. a slow concurrent
    /// `refresh_kchat_acl` revoked the source between the candidate
    /// gather and this fetch — must still be dropped. The
    /// `WHERE s.status != ?` clause is the last gate before
    /// content text reaches the caller; revoked rows are simply
    /// omitted (the caller's input-order reorder loop skips them
    /// transparently).
    pub fn fetch_chunks_by_ids(&self, ids: &[i64]) -> Result<Vec<SearchHit>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        // dispatched through the read pool.
        // `fetch_chunks_by_ids` is called once per hybrid search
        // to hydrate the final ranked list. Routing it through
        // the pool means a long writer transaction doesn't add
        // latency to interactive search.
        self.with_read(|conn| Self::fetch_chunks_by_ids_inner(conn, ids))
    }

    fn fetch_chunks_by_ids_inner(conn: &Connection, ids: &[i64]) -> Result<Vec<SearchHit>> {
        let placeholders = std::iter::repeat_n("?", ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT c.id, c.content, c.hash, c.chunk_index, c.byte_offset, f.path, f.source_id
             FROM chunks c
             JOIN indexed_files f ON f.id = c.indexed_file_id
             JOIN sources s ON s.id = f.source_id
             WHERE c.id IN ({placeholders})
               AND s.status != ?"
        );
        let mut stmt = conn.prepare(&sql).map_err(Error::Sqlite)?;
        let mut id_params: Vec<rusqlite::types::Value> = ids
            .iter()
            .map(|&i| rusqlite::types::Value::Integer(i))
            .collect();
        // Bind the `s.status != ?` parameter at the end so its
        // placeholder index matches the SQL above.
        id_params.push(rusqlite::types::Value::Text(
            SourceStatus::AccessRevoked.as_stored_json().to_owned(),
        ));
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
            .map_err(Error::Sqlite)?
            .filter_map(std::result::Result::ok)
            .collect();

        // Reorder to match the requested id sequence.
        let mut by_id: std::collections::HashMap<i64, SearchHit> =
            rows.into_iter().map(|h| (h.chunk_id, h)).collect();
        let ordered: Vec<SearchHit> = ids.iter().filter_map(|id| by_id.remove(id)).collect();
        Ok(ordered)
    }

    /// KChat-post-only BM25 search.
    ///
    /// Runs an FTS5 MATCH against the same `chunks_fts` virtual
    /// table that the generic [`SourceStore::search_fts`] uses,
    /// but with three additional joins / filters so the result
    /// set is restricted to chunks that originated from a KChat
    /// post body (`chunks.kind = 'chat_post'`) on a live source
    /// (`sources.status != AccessRevoked`) whose per-source DEK
    /// row exists (`kchat_source_deks.source_id IS NOT NULL`).
    ///
    /// The DEK-existence gate is structurally important: the
    /// cryptoshred path drops `kchat_source_deks` rows in lockstep
    /// with `chunks` (`SourceStore::cryptoshred_kchat_source_evidence`),
    /// but a partial-failure scenario — e.g. the DEK delete
    /// commits and the chunk delete rolls back — would leave
    /// chunks that no longer have an unwrappable key. Filtering
    /// at the SQL layer means those orphan rows can never reach
    /// the manager's AEAD-verification step, which would otherwise
    /// log a noisy "DEK not loaded" error per orphan chunk. The
    /// gate also catches the future migration scenario where a
    /// schema rev introduces post-ingestion before DEK generation
    /// is wired (defence-in-depth — there is no such migration
    /// today, but the predicate makes the invariant explicit at
    /// the query layer rather than implicit at the manager layer).
    ///
    /// The `kchat_posts` join hydrates the citation-metadata
    /// fields (channel id, post id, root id, sender id, timestamps)
    /// the renderer needs to render a "from #channel on
    /// 2026-01-15 by @user-id" badge alongside the excerpt. Joining
    /// at the SQL layer (rather than via a follow-up
    /// `find_kchat_post` call per hit) keeps the search path
    /// single-query — no N+1.
    ///
    /// The result is ordered by FTS5 BM25 (`ORDER BY rank` —
    /// `rank` is FTS5's non-positive log-relevance score), then
    /// truncated to `limit`. The manager layer applies a
    /// reciprocal-rank transformation before yielding hits to the
    /// renderer so the surface score is stable across queries.
    pub fn search_kchat_posts_fts(
        &self,
        fts_query: &str,
        limit: usize,
    ) -> Result<Vec<KchatPostSearchHitRow>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.content, c.content_aead, c.content_aead_nonce,
                        c.hash, c.chunk_index, c.byte_offset,
                        f.source_id, s.path,
                        p.post_id, p.channel_id, p.root_id, p.sender_user_id,
                        p.created_at_ms, p.edited_at_ms,
                        rank
                 FROM chunks_fts fts
                 JOIN chunks c        ON c.id = fts.rowid
                 JOIN indexed_files f ON f.id = c.indexed_file_id
                 JOIN sources s       ON s.id = f.source_id
                 JOIN kchat_posts p   ON p.indexed_file_id = f.id
                 WHERE chunks_fts MATCH ?1
                   AND c.kind = 'chat_post'
                   AND s.status != ?3
                   AND EXISTS (
                       SELECT 1 FROM kchat_source_deks d
                       WHERE d.source_id = f.source_id
                   )
                 ORDER BY rank
                 LIMIT ?2",
            )
            .map_err(Error::Sqlite)?;

        let rows: Vec<KchatPostSearchHitRow> = stmt
            .query_map(
                params![
                    fts_query,
                    limit as i64,
                    SourceStatus::AccessRevoked.as_stored_json(),
                ],
                |row| {
                    Ok(KchatPostSearchHitRow {
                        chunk_id: row.get::<_, i64>(0)?,
                        content: row.get(1)?,
                        content_aead: row.get(2)?,
                        content_aead_nonce: row.get(3)?,
                        hash: row.get(4)?,
                        chunk_index: row.get::<_, i64>(5)? as usize,
                        byte_offset: row.get::<_, i64>(6)? as usize,
                        source_id: row.get(7)?,
                        source_path: row.get(8)?,
                        post_id: row.get(9)?,
                        channel_id: row.get(10)?,
                        root_id: row.get(11)?,
                        sender_user_id: row.get(12)?,
                        created_at_ms: row.get::<_, i64>(13)?,
                        edited_at_ms: row.get::<_, i64>(14)?,
                        bm25_score: -row.get::<_, f64>(15)?,
                    })
                },
            )
            .map_err(Error::Sqlite)?
            .filter_map(std::result::Result::ok)
            .collect();

        Ok(rows)
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
        .map_err(Error::Sqlite)?;
        // a new / replaced embedding row
        // changes the set `load_embeddings_for_model` returns —
        // invalidate any cached IVF index for any model so the
        // next search rebuilds against the fresh row set. Drop the
        // writer lock first so the bump can't deadlock against the
        // cache lock under another thread.
        drop(conn);
        self.bump_embedding_generation();
        Ok(())
    }

    /// bump the embedding-generation counter
    /// so the next call to [`Self::vector_search_path_for_model`]
    /// observes a generation mismatch and rebuilds the cached
    /// [`IvfIndex`] / brute-force row buffer.
    ///
    /// Called from every write path that can change the set of
    /// rows [`Self::load_embeddings_for_model`] returns:
    /// embedding upserts, chunk deletions (which cascade to
    /// `chunk_embeddings`), source-status transitions, and
    /// AccessRevoked toggles.
    pub fn bump_embedding_generation(&self) {
        self.embedding_generation.fetch_add(1, Ordering::Release);
    }

    /// return the cached vector search
    /// strategy for `model_id`, building (and caching) a new
    /// [`IvfIndex`] on miss / staleness.
    ///
    /// `query_dim` is the dimensionality of the query vector —
    /// rows whose stored vector has a different length are excluded
    /// from the index (so the IVF result is observationally
    /// compatible with the brute-force `rank_chunks_by_cosine`
    /// path that also filters on dim).
    ///
    /// Below [`IVF_BRUTE_FORCE_THRESHOLD`] rows we don't pay the
    /// k-means build cost; the cache holds the loaded row buffer
    /// directly so subsequent calls also skip the SQL round-trip.
    /// Above the threshold we build and cache the IVF index; the
    /// query path then probes ⌈√K⌉ cells out of K = ⌈√N⌉.
    ///
    /// Mutex contention: this holds `vector_index_cache` for the
    /// duration of the SQL load + k-means build on a miss. The
    /// build is amortised across thousands of queries (cache hits
    /// are lock-only), and the per-`model_id` partitioning means
    /// different providers don't serialise against each other.
    /// Defensive: if the load returns zero rows the empty buffer
    /// is still cached so we don't re-hit SQLite on every query for
    /// fresh installs.
    pub fn vector_search_path_for_model(
        &self,
        model_id: &str,
        query_dim: usize,
    ) -> Result<VectorSearchPath> {
        let current_gen = self.embedding_generation.load(Ordering::Acquire);
        {
            // Fast path: cache hit at the current generation.
            let cache = self
                .vector_index_cache
                .lock()
                .expect("vector_index_cache mutex poisoned");
            if let Some(entry) = cache.get(model_id) {
                if entry.generation == current_gen {
                    return Ok(match &entry.path {
                        CachedVectorSearchPath::Ivf(idx) => VectorSearchPath::Ivf(Arc::clone(idx)),
                        CachedVectorSearchPath::BruteForce(rows) => {
                            VectorSearchPath::BruteForce(Arc::clone(rows))
                        }
                    });
                }
            }
            // Drop the lock before doing I/O / k-means.
        }

        // Slow path: load embeddings (full table scan, dispatches
        // through the read pool) and build the index.
        let rows = self.load_embeddings_for_model(model_id)?;
        let build_gen = self.embedding_generation.load(Ordering::Acquire);
        let path = if rows.len() < IVF_BRUTE_FORCE_THRESHOLD || query_dim == 0 {
            // Below threshold OR query has unknown dim — keep raw
            // rows so the caller can run the existing brute-force
            // cosine scan unchanged.
            CachedVectorSearchPath::BruteForce(Arc::new(rows))
        } else {
            let idx = IvfIndex::build(&rows, model_id, query_dim);
            CachedVectorSearchPath::Ivf(Arc::new(idx))
        };

        // Re-acquire the lock, install the entry (overwriting any
        // stale generation), and return a clone.
        let mut cache = self
            .vector_index_cache
            .lock()
            .expect("vector_index_cache mutex poisoned");
        cache.insert(
            model_id.to_string(),
            VectorIndexCacheEntry {
                generation: build_gen,
                path: path.clone(),
            },
        );
        Ok(match path {
            CachedVectorSearchPath::Ivf(idx) => VectorSearchPath::Ivf(idx),
            CachedVectorSearchPath::BruteForce(rows) => VectorSearchPath::BruteForce(rows),
        })
    }

    /// Load every embedding stored for a given model. Used by hybrid
    /// retrieval to scan for cosine similarity. For corpora large
    /// enough that an in-memory scan is slow (~100K+ chunks), this
    /// can be replaced with an sqlite-vec / sqlite-vss native index;
    /// the trait surface stays the same.
    ///
    /// the join through
    /// `indexed_files → sources` and the `s.status != ?` filter
    /// keep embedding rows from `AccessRevoked` sources out of the
    /// candidate pool entirely, so the vector-cosine path matches
    /// the BM25 path's ACL enforcement. Without this filter, a
    /// revoked source's vectors would still rank in the cosine
    /// top-k and waste fusion slots even though `fetch_chunks_by_ids`
    /// would later drop them — wasting compute and risking
    /// information leakage via timing / size-of-result-set side
    /// channels.
    pub fn load_embeddings_for_model(&self, model_id: &str) -> Result<Vec<ChunkEmbeddingRow>> {
        // this is the most expensive read
        // on the hybrid-search path — a full scan of
        // `chunk_embeddings` for a model_id. Dispatching it
        // through the read pool releases the writer mutex for
        // the duration of the scan; in WAL mode the pool
        // connection sees a consistent snapshot even if a writer
        // is committing new embeddings concurrently.
        self.with_read(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT ce.chunk_id, ce.model_id, ce.vec
                     FROM chunk_embeddings ce
                     JOIN chunks c       ON c.id = ce.chunk_id
                     JOIN indexed_files f ON f.id = c.indexed_file_id
                     JOIN sources s      ON s.id = f.source_id
                     WHERE ce.model_id = ?1
                       AND s.status != ?2",
                )
                .map_err(Error::Sqlite)?;
            let rows = stmt
                .query_map(
                    params![model_id, SourceStatus::AccessRevoked.as_stored_json()],
                    |row| {
                        let chunk_id: i64 = row.get(0)?;
                        let model_id: String = row.get(1)?;
                        let bytes: Vec<u8> = row.get(2)?;
                        let vector = crate::embedding::decode_vec(&bytes).unwrap_or_default();
                        Ok(ChunkEmbeddingRow {
                            chunk_id,
                            model_id,
                            vector,
                        })
                    },
                )
                .map_err(Error::Sqlite)?
                .filter_map(std::result::Result::ok)
                .filter(|r| !r.vector.is_empty())
                .collect();
            Ok(rows)
        })
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

    /// Variant of `chunks_missing_embedding` that filters out chunk
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
        // `ORDER BY c.id` makes the iteration order deterministic
        // and stable across repeated calls with the same exclude set.
        // Correctness doesn't depend on the order — the upsert is
        // idempotent and successful embeddings drop out of the
        // left-join filter on the next pass — but pinning it serves
        // two real benefits:
        //
        //   1. **Debuggability.** A backfill stall logged with the
        //      first-batch chunk ids reproduces byte-for-byte across
        //      restarts; without ORDER BY the implicit rowid order
        //      can shift if a vacuum / autovacuum reshuffles the
        //      btree leaves, making "embed chunk 4711 keeps failing"
        //      bug reports impossible to reproduce.
        //
        //   2. **Stall detector tractability.** The in-loop
        //      stall detector in `backfill_embeddings` decides whether
        //      to bail by comparing the chunk-id set returned by
        //      successive iterations. Deterministic order means the
        //      set comparison reduces to a vec-equality check at
        //      worst — and to a "first id same?" check in the
        //      common case — instead of always paying the
        //      HashSet-build cost.
        //
        // ORDER BY happens *before* LIMIT, so the cost is bounded by
        // the index on `chunks.id` (the SQLite rowid alias) rather
        // than by the size of the corpus.
        let sql = format!(
            "SELECT c.id, c.content
             FROM chunks c
             LEFT JOIN chunk_embeddings e
                ON e.chunk_id = c.id AND e.model_id = ?1
             WHERE e.chunk_id IS NULL{exclude_placeholders}
             ORDER BY c.id ASC
             LIMIT ?2"
        );
        let mut stmt = conn.prepare(&sql).map_err(Error::Sqlite)?;
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
            .map_err(Error::Sqlite)?
            .filter_map(std::result::Result::ok)
            .collect();
        Ok(rows)
    }

    /// Cheap count of how many chunks are missing an embedding for
    /// the given `model_id`. Used by
    /// `SourceManager::backfill_embeddings_tracked` to seed the
    /// progress denominator before the long-running embed loop starts,
    /// so the renderer can show a determinate `embedded / total` bar
    /// from the first poll.
    ///
    /// Separate from `chunks_missing_embedding` (which materialises
    /// every chunk's content) because the count case only needs an
    /// index-only scan via `COUNT(*)` — for a 100k-chunk corpus this
    /// is ~100x cheaper than building a Vec of the same length.
    pub fn count_chunks_missing_embedding(&self, model_id: &str) -> Result<u64> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT COUNT(*)
                 FROM chunks c
                 LEFT JOIN chunk_embeddings e
                    ON e.chunk_id = c.id AND e.model_id = ?1
                 WHERE e.chunk_id IS NULL",
            )
            .map_err(Error::Sqlite)?;
        let count: i64 = stmt
            .query_row([model_id], |row| row.get(0))
            .map_err(Error::Sqlite)?;
        Ok(count.max(0) as u64)
    }

    /// Look up `last_modified` ages in seconds (relative to `now`)
    /// for a list of chunk ids. Chunks whose `last_modified` cannot
    /// be parsed get age 0 (treated as fresh) — defensive choice so
    /// a malformed timestamp doesn't tank a result's ranking.
    pub fn ages_secs_for_chunks(&self, ids: &[i64]) -> Result<std::collections::HashMap<i64, f64>> {
        if ids.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        // small fan-out read (one row per
        // candidate id) but called once per hybrid search;
        // routing through the pool keeps it off the writer path.
        self.with_read(|conn| {
            let placeholders = std::iter::repeat_n("?", ids.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT c.id, f.last_modified
                 FROM chunks c
                 JOIN indexed_files f ON f.id = c.indexed_file_id
                 WHERE c.id IN ({placeholders})"
            );
            let mut stmt = conn.prepare(&sql).map_err(Error::Sqlite)?;
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
                .map_err(Error::Sqlite)?;
            for r in rows.flatten() {
                let age_secs = parse_datetime_opt(&r.1)
                    .map_or(0.0, |dt| (now - dt).num_seconds().max(0) as f64);
                ages.insert(r.0, age_secs);
            }
            Ok(ages)
        })
    }

    /// File count for source.
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
            .map_err(Error::Sqlite)?;
        Ok(count as u64)
    }

    /// Get chunk contents for source.
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
            .map_err(Error::Sqlite)?;
        let rows = stmt
            .query_map(params![id_str], |row| row.get::<_, String>(0))
            .map_err(Error::Sqlite)?;
        let mut contents = Vec::new();
        for row in rows {
            contents.push(row.map_err(Error::Sqlite)?);
        }
        Ok(contents)
    }

    /// Get current file hash.
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
            Err(e) => Err(Error::Sqlite(e)),
        }
    }

    /// List indexed files.
    pub fn list_indexed_files(&self, source_id: &SourceId) -> Result<Vec<IndexedFile>> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT path, hash, last_modified, chunk_count FROM indexed_files WHERE source_id = ?1",
            )
            .map_err(Error::Sqlite)?;

        let files = stmt
            .query_map(params![id_str], |row| {
                Ok(IndexedFile {
                    path: row.get(0)?,
                    hash: row.get(1)?,
                    last_modified: row.get(2)?,
                    chunk_count: row.get::<_, i64>(3)? as u64,
                })
            })
            .map_err(Error::Sqlite)?
            .filter_map(std::result::Result::ok)
            .collect();

        Ok(files)
    }
}

#[derive(Debug, Clone)]
/// Search Hit.
pub struct SearchHit {
    /// Chunk id.
    pub chunk_id: i64,
    /// Content.
    pub content: String,
    /// Hash.
    pub hash: String,
    /// Chunk index.
    pub chunk_index: usize,
    /// Byte offset.
    pub byte_offset: usize,
    /// Source path.
    pub source_path: String,
    /// Source id.
    pub source_id: String,
    /// Relevance.
    pub relevance: f64,
}

/// one raw chunk-hit row produced by
/// [`SourceStore::search_kchat_posts_fts`].
///
/// This is intentionally a substrate-internal shape, not a
/// renderer-facing one — the manager layer
/// ([`crate::manager::SourceManager::search_kchat_posts`]) does
/// two transformations before yielding hits to the bridge:
///
/// 1. It AEAD-verifies the chunk by re-opening
///    `content_aead` under the per-source DEK and comparing the
///    decrypted bytes against the plaintext `content` column,
///    discarding any row whose ciphertext does not authenticate.
///    Without this check, the search path would happily return
///    the plaintext copy of a chunk whose AEAD tag fails — which
///    would defeat the integrity property that motivated Block C
///    Task 2's column-AEAD design in the first place.
/// 2. It computes a query-aware excerpt and a reciprocal-rank
///    relevance score so the renderer never sees the raw
///    `bm25_score` (which is unstable across queries and
///    corpus-dependent — see [`crate::search::SearchResult`]).
///
/// Plaintext `content`, `content_aead`, and `content_aead_nonce`
/// flow through this struct because the AEAD verification step
/// in the manager needs all three; they are dropped from the
/// renderer-facing
/// [`crate::manager::KchatPostSearchHit`] (which only carries the
/// verified plaintext).
#[derive(Debug, Clone)]
pub struct KchatPostSearchHitRow {
    /// Chunk id.
    pub chunk_id: i64,
    /// Content.
    pub content: String,
    /// Content aead.
    pub content_aead: Option<Vec<u8>>,
    /// Content aead nonce.
    pub content_aead_nonce: Option<Vec<u8>>,
    /// Hash.
    pub hash: String,
    /// Chunk index.
    pub chunk_index: usize,
    /// Byte offset.
    pub byte_offset: usize,
    /// Source id.
    pub source_id: String,
    /// Source path.
    pub source_path: String,
    /// Post id.
    pub post_id: String,
    /// Channel id.
    pub channel_id: String,
    /// Root id.
    pub root_id: Option<String>,
    /// Sender user id.
    pub sender_user_id: String,
    /// Created at ms.
    pub created_at_ms: i64,
    /// Edited at ms.
    pub edited_at_ms: i64,
    /// Raw FTS5 BM25 score (`-rank` in the SQL — FTS5 reports
    /// `rank` as a non-positive log-relevance, so we negate to
    /// keep "higher is more relevant"). Used by the manager
    /// layer to order hits before reciprocal-rank scoring;
    /// never surfaced to the renderer.
    pub bm25_score: f64,
}

/// one raw row produced by
/// [`SourceStore::fetch_kchat_thread_context_rows`].
///
/// Substrate-internal shape — the manager layer
/// ([`crate::manager::SourceManager::fetch_kchat_thread_context`])
/// AEAD-verifies each row's ciphertext against the per-source
/// DEK before yielding to the renderer. A row whose ciphertext
/// fails verification is dropped (same posture as
/// [`KchatPostSearchHitRow`] → search results) — the renderer
/// gets a partial vec rather than a hard error, on the principle
/// that a tampered DB should never hide ALL thread context for
/// honest sibling rows.
///
/// Plaintext `content` flows alongside the ciphertext so the
/// manager's verification step can compare the AEAD-opened bytes
/// to the indexed plaintext column; divergence (a row whose
/// `chunks.content` was edited out-of-band but whose
/// `content_aead` still authenticates as the original) is a
/// substrate-integrity event the manager surfaces as a dropped
/// row.
#[derive(Debug, Clone)]
pub struct KchatThreadContextRow {
    /// Post id.
    pub post_id: String,
    /// Channel id.
    pub channel_id: String,
    /// Root id.
    pub root_id: Option<String>,
    /// Sender user id.
    pub sender_user_id: String,
    /// Created at ms.
    pub created_at_ms: i64,
    /// Edited at ms.
    pub edited_at_ms: i64,
    /// Content.
    pub content: String,
    /// Content aead.
    pub content_aead: Option<Vec<u8>>,
    /// Content aead nonce.
    pub content_aead_nonce: Option<Vec<u8>>,
}

#[derive(Debug, Clone)]
/// Chunk Embedding Row.
pub struct ChunkEmbeddingRow {
    /// Chunk id.
    pub chunk_id: i64,
    /// Model id.
    pub model_id: String,
    /// Vector.
    pub vector: Vec<f32>,
}

#[derive(Debug, Clone)]
/// Indexed File.
pub struct IndexedFile {
    /// Path.
    pub path: String,
    /// Hash.
    pub hash: String,
    /// Last modified.
    pub last_modified: String,
    /// Chunk count.
    pub chunk_count: u64,
}

/// One row of the cached ACL roster for a KChat-backed source.
///
/// the substrate persists the
/// authoritative member list returned by
/// `GET /channels/{id}/members` so retrieval-side filters can
/// answer "is the locally-authenticated principal still a member
/// of this channel" without a round-trip to KChat on every search.
/// The roster is refreshed whenever the WS forwarder receives a
/// membership-change event (`user_added`, `user_removed`,
/// `channel_updated`).
#[derive(Debug, Clone)]
pub struct KchatAclRow {
    /// KChat user id (the same opaque `id` returned by
    /// `GET /users/me`). Stored verbatim — the substrate does
    /// not canonicalise or normalise.
    pub member_user_id: String,
    /// KChat role list as a single space-separated string (the
    /// wire form: `"channel_user channel_admin"`). Persisted for
    /// forensics + future per-role retrieval filters; the
    /// retrieval path itself only checks for the presence of a
    /// row, not the role contents.
    pub role: String,
    /// RFC3339 wall-clock at which the roster was last refreshed.
    pub refreshed_at: String,
}

/// Counters returned by
/// [`SourceStore::cryptoshred_kchat_source_evidence`] .
///
/// Surfaced through the bridge so the Node-side audit row
/// (`KchatSourceCryptoshredded`) records how much evidence was
/// scrubbed. `u32` is wide enough — a single KChat-backed source
/// will not realistically index billions of chunks.
///
/// `vacuum_succeeded` records whether Phase 5 (`VACUUM`) completed
/// cleanly. Phase 5 is the belt-and-braces freelist sweep that runs
/// AFTER the DELETE + UPDATE transaction has already committed under
/// `PRAGMA secure_delete = ON` (Phase 2-4): the cryptographic scrub
/// is already done at that point — SQLite zero-filled the freed
/// pages on the row-level DELETEs. A `VACUUM` failure (e.g. disk
/// pressure preventing the temp-file rewrite) is therefore NOT a
/// scrub failure; it just means the freelist pages were not
/// additionally rewritten to a fresh file layout. The data is gone
/// either way — but operators rely on the audit trail to learn that
/// the belt-and-braces sweep didn't complete so they can re-run
/// `VACUUM` manually when disk space recovers. Fifth-pass Devin
/// Review fix (ANALYSIS_pr-review-job-ef3c7d6c..._0001): previously
/// a `VACUUM` failure propagated `?` up to the forwarder's catch
/// block, defaulting the outcome to `"unlinked"` — operator-visible
/// audit said "we never saw the revoke" when in fact the row-level
/// scrub committed successfully.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KchatSourceCryptoshredOutcome {
    /// Number of rows deleted from the `chunks` table (which also
    /// cascades to `chunks_fts` and `chunk_embeddings` via the
    /// `chunks_ad` / `chunks_ad_embeddings` triggers).
    pub chunks_dropped: u32,
    /// Number of rows deleted from the `indexed_files` table.
    pub files_dropped: u32,
    /// number of rows deleted from
    /// `kchat_posts` (the per-post bookkeeping table that maps
    /// post_id → indexed_file_id). An audit operator who sees
    /// `chunks_dropped > 0` AND `posts_dropped == 0` knows the
    /// source held only file-attachment chunks (no chat-body
    /// chunks); the reverse means a misconfigured source somehow
    /// had post bookkeeping without chunks (would indicate bug).
    pub posts_dropped: u32,
    /// `true` when the wrapped-DEK row
    /// existed and was deleted (i.e. the per-source AEAD key was
    /// destroyed). `false` when the source never ingested a chat
    /// post and therefore had no DEK to drop. The Node-side audit
    /// row surfaces this so operators can verify the DEK lifecycle
    /// closed cleanly on every revoke.
    pub dek_dropped: bool,
    /// `true` when Phase 5 (`VACUUM`) ran cleanly OR was skipped
    /// because there was nothing to reclaim (idempotent
    /// `already_revoked` path drops zero rows). `false` only when
    /// `VACUUM` actually ran and rusqlite returned an error.
    pub vacuum_succeeded: bool,
    /// First-error message text on a `VACUUM` failure. `None`
    /// otherwise. Surfaced to the audit row via
    /// `bridge_log_kchat_source_cryptoshredded` so operators have
    /// the underlying SQLite error code (e.g. `database or disk
    /// is full`) without needing to chase the eprintln in stderr.
    pub vacuum_error: Option<String>,
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

    // Tenth-pass: indexed equality lookup
    // by (source_type, path). Used by SourceManager::add_kchat_channel
    // for idempotent channel registration.
    #[test]
    fn find_source_by_type_and_path_locates_existing_kchat_row() {
        let store = SourceStore::open_in_memory().unwrap();
        let kchat = Source::new_kchat_channel("/tmp/kchat/channel-A".to_string());
        store.add_source(&kchat).unwrap();
        // Mix in some other-type and other-path rows to confirm the
        // query doesn't match them.
        let folder = Source::new_local_folder("/tmp/kchat/channel-A".to_string());
        store.add_source(&folder).unwrap();
        let kchat_other = Source::new_kchat_channel("/tmp/kchat/channel-B".to_string());
        store.add_source(&kchat_other).unwrap();

        let found = store
            .find_source_by_type_and_path(&SourceType::Kchat, "/tmp/kchat/channel-A")
            .unwrap()
            .expect("query should match the KChat row");
        assert_eq!(found.id, kchat.id);
        assert!(matches!(found.source_type, SourceType::Kchat));
        assert_eq!(found.path, "/tmp/kchat/channel-A");
    }

    #[test]
    fn find_source_by_type_and_path_returns_none_when_path_differs() {
        let store = SourceStore::open_in_memory().unwrap();
        let kchat = Source::new_kchat_channel("/tmp/kchat/channel-A".to_string());
        store.add_source(&kchat).unwrap();

        let found = store
            .find_source_by_type_and_path(&SourceType::Kchat, "/tmp/kchat/channel-Z")
            .unwrap();
        assert!(found.is_none(), "no row should match a different path");
    }

    #[test]
    fn find_source_by_type_and_path_returns_none_when_type_differs() {
        // A LocalFolder row at the same path must NOT be returned
        // when the caller asks for a Kchat source — the composite
        // index isolates the two namespaces.
        let store = SourceStore::open_in_memory().unwrap();
        let folder = Source::new_local_folder("/tmp/shared/path".to_string());
        store.add_source(&folder).unwrap();

        let found = store
            .find_source_by_type_and_path(&SourceType::Kchat, "/tmp/shared/path")
            .unwrap();
        assert!(
            found.is_none(),
            "LocalFolder rows must not be returned when caller asked for Kchat"
        );
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

    /// `remove_source` deletes the source's chunks, its `indexed_files`
    /// rows, and the `sources` row as one `BEGIN IMMEDIATE` unit, so a
    /// successful call must leave NO orphaned chunk or indexed_file rows
    /// behind for that source — across multiple indexed files. This pins
    /// the all-or-nothing contract the transactional wrapper provides
    /// (a partial scrub would leave `indexed_files`/`chunks` rows whose
    /// parent `sources` row is gone, the failure mode the flag called
    /// out).
    #[test]
    fn remove_source_leaves_no_orphaned_files_or_chunks() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/multi".to_string());
        store.add_source(&source).unwrap();

        // Two indexed files, each with chunks, so the chunk delete spans
        // more than one file (the path the old per-file loop walked).
        for (path, hash) in [("/tmp/multi/a.txt", "h-a"), ("/tmp/multi/b.txt", "h-b")] {
            let fid = store
                .upsert_indexed_file(&source.id, path, hash, "2026-01-01")
                .unwrap();
            store
                .insert_chunks(
                    fid,
                    &[crate::chunker::Chunk {
                        source_path: path.to_string(),
                        chunk_index: 0,
                        byte_offset: 0,
                        content: format!("sentinel for {path}"),
                        hash: format!("{hash}-0"),
                        extraction_method: None,
                        extraction_model_id: None,
                    }],
                )
                .unwrap();
        }

        let id_str = source.id.to_string();
        let count = |sql: &str| -> i64 {
            let conn = store.conn.lock().expect("conn poisoned");
            conn.query_row(sql, params![id_str], |row| row.get::<_, i64>(0))
                .expect("count query should return a row")
        };

        assert_eq!(
            count("SELECT COUNT(*) FROM indexed_files WHERE source_id = ?1"),
            2,
            "precondition: both files indexed",
        );
        assert_eq!(
            count(
                "SELECT COUNT(*) FROM chunks
                 WHERE indexed_file_id IN
                     (SELECT id FROM indexed_files WHERE source_id = ?1)",
            ),
            2,
            "precondition: both files' chunks present",
        );

        store.remove_source(&source.id).unwrap();

        assert!(
            store.list_sources().unwrap().is_empty(),
            "the source row must be gone",
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM indexed_files WHERE source_id = ?1"),
            0,
            "no orphaned indexed_files rows may survive remove_source",
        );
        assert_eq!(
            count(
                "SELECT COUNT(*) FROM chunks
                 WHERE indexed_file_id IN
                     (SELECT id FROM indexed_files WHERE source_id = ?1)",
            ),
            0,
            "no orphaned chunk rows may survive remove_source",
        );
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
                extraction_method: None,
                extraction_model_id: None,
            },
            crate::chunker::Chunk {
                source_path: "/tmp/test/doc.txt".to_string(),
                chunk_index: 1,
                byte_offset: 48,
                content: "It indexes local folders and files for search".to_string(),
                hash: "hash2".to_string(),
                extraction_method: None,
                extraction_model_id: None,
            },
        ];

        store.insert_chunks(file_id, &chunks).unwrap();

        let results = store.search_fts("productivity workspace", 10).unwrap();
        assert!(!results.is_empty());
        assert!(results[0].content.contains("productivity"));
    }

    /// Block B Task 3 retrieval-side ACL enforcement.
    ///
    /// `search_fts` joins through `indexed_files` to `sources` and
    /// rejects chunks whose source's `status` matches the
    /// stored-JSON form of `SourceStatus::AccessRevoked`. A
    /// regression here would surface a chunk from a channel the
    /// user has been removed from — exactly the failure mode the
    /// task is designed to prevent. The test exercises BOTH the
    /// "still indexed" → returned AND the "now revoked" → excluded
    /// paths so a refactor that silently drops the predicate is
    /// detected immediately rather than only at integration time.
    #[test]
    fn search_fts_excludes_chunks_whose_source_is_access_revoked() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_kchat_channel("/tmp/kchat-acl".to_string());
        store.add_source(&source).unwrap();

        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/kchat-acl/a.txt", "h1", "2026-01-01")
            .unwrap();
        store
            .insert_chunks(
                file_id,
                &[crate::chunker::Chunk {
                    source_path: "/tmp/kchat-acl/a.txt".to_string(),
                    chunk_index: 0,
                    byte_offset: 0,
                    content: "operator secret rotation plan".to_string(),
                    hash: "h-content".to_string(),
                    extraction_method: None,
                    extraction_model_id: None,
                }],
            )
            .unwrap();

        // Pre-condition: while the source is in its default state,
        // the chunk is searchable.
        let hits_before = store.search_fts("operator", 10).unwrap();
        assert_eq!(
            hits_before.len(),
            1,
            "control: chunk must be searchable before revocation"
        );

        // Revoke the source.
        store
            .update_source_status(&source.id, SourceStatus::AccessRevoked, None)
            .unwrap();

        // Post-condition: the same query returns no rows because
        // the source's status is now AccessRevoked.
        let hits_after = store.search_fts("operator", 10).unwrap();
        assert!(
            hits_after.is_empty(),
            "retrieval-side filter must exclude AccessRevoked sources \
             but got {} hit(s)",
            hits_after.len(),
        );
    }

    /// Companion to `search_fts_excludes_...` covering the
    /// `fetch_chunks_by_ids` defence-in-depth filter. A chunk
    /// might enter the candidate set via the cosine path even
    /// when the FTS predicate excluded it (e.g. if the
    /// `load_embeddings_for_model` filter ever regresses); the
    /// fetch-by-id boundary is the final gate.
    #[test]
    fn fetch_chunks_by_ids_excludes_chunks_whose_source_is_access_revoked() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_kchat_channel("/tmp/kchat-acl-fetch".to_string());
        store.add_source(&source).unwrap();
        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/kchat-acl-fetch/a.txt", "h1", "2026-01-01")
            .unwrap();
        store
            .insert_chunks(
                file_id,
                &[crate::chunker::Chunk {
                    source_path: "/tmp/kchat-acl-fetch/a.txt".to_string(),
                    chunk_index: 0,
                    byte_offset: 0,
                    content: "yetanother secret".to_string(),
                    hash: "h-fetch".to_string(),
                    extraction_method: None,
                    extraction_model_id: None,
                }],
            )
            .unwrap();
        // Grab the chunk id via the search path (already verified
        // above) while the source is still Indexable.
        let hit = store
            .search_fts("yetanother", 10)
            .unwrap()
            .into_iter()
            .next()
            .expect("control hit must exist before revoke");

        store
            .update_source_status(&source.id, SourceStatus::AccessRevoked, None)
            .unwrap();

        let fetched = store.fetch_chunks_by_ids(&[hit.chunk_id]).unwrap();
        assert!(
            fetched.is_empty(),
            "fetch_chunks_by_ids must filter AccessRevoked sources \
             but got {} chunk(s)",
            fetched.len(),
        );
    }

    /// Vector-cosine candidate generator must also drop revoked
    /// sources at the embedding-load boundary — otherwise the
    /// fusion ranker still considers them top-k candidates
    /// (wasting compute and risking a size-of-result-set side
    /// channel even after `fetch_chunks_by_ids` drops them).
    #[test]
    fn load_embeddings_for_model_excludes_chunks_whose_source_is_access_revoked() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_kchat_channel("/tmp/kchat-acl-emb".to_string());
        store.add_source(&source).unwrap();
        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/kchat-acl-emb/a.txt", "h1", "2026-01-01")
            .unwrap();
        store
            .insert_chunks(
                file_id,
                &[crate::chunker::Chunk {
                    source_path: "/tmp/kchat-acl-emb/a.txt".to_string(),
                    chunk_index: 0,
                    byte_offset: 0,
                    content: "vectoronly content".to_string(),
                    hash: "h-emb".to_string(),
                    extraction_method: None,
                    extraction_model_id: None,
                }],
            )
            .unwrap();
        // Look up the chunk_id via the search path while the
        // source is still in a non-revoked state.
        let probe = store
            .search_fts("vectoronly", 10)
            .unwrap()
            .into_iter()
            .next()
            .expect("control hit must exist before revoke");
        let chunk_id = probe.chunk_id;
        let vec = [0.1f32, 0.2, 0.3, 0.4];
        let vec_bytes = crate::embedding::encode_vec(&vec);
        store
            .upsert_chunk_embedding(chunk_id, "test-model", vec.len(), &vec_bytes)
            .unwrap();

        // Control: the embedding is loaded for an indexed source.
        let rows_before = store.load_embeddings_for_model("test-model").unwrap();
        assert_eq!(
            rows_before.len(),
            1,
            "control: embedding must be loaded before revoke"
        );

        store
            .update_source_status(&source.id, SourceStatus::AccessRevoked, None)
            .unwrap();
        let rows_after = store.load_embeddings_for_model("test-model").unwrap();
        assert!(
            rows_after.is_empty(),
            "load_embeddings_for_model must drop AccessRevoked rows \
             but got {} row(s)",
            rows_after.len(),
        );
    }

    /// small-corpus path returns the cached
    /// brute-force row buffer (not an `IvfIndex`). Verifies the
    /// threshold short-circuit so we don't pay k-means build cost
    /// on tiny corpora where the brute-force scan is already
    /// faster.
    #[test]
    fn vector_search_path_under_threshold_returns_brute_force() {
        use crate::store::VectorSearchPath;
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_kchat_channel("/tmp/vsp-small".to_string());
        store.add_source(&source).unwrap();
        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/vsp-small/a.txt", "h", "2026-01-01")
            .unwrap();
        let ids = store
            .insert_chunks_returning_ids(
                file_id,
                &[crate::chunker::Chunk {
                    source_path: "/tmp/vsp-small/a.txt".to_string(),
                    chunk_index: 0,
                    byte_offset: 0,
                    content: "alpha".to_string(),
                    hash: "h1".to_string(),
                    extraction_method: None,
                    extraction_model_id: None,
                }],
            )
            .unwrap();
        let vec_bytes = crate::embedding::encode_vec(&[1.0f32, 0.0, 0.0]);
        store
            .upsert_chunk_embedding(ids[0], "test-model", 3, &vec_bytes)
            .unwrap();

        let path = store.vector_search_path_for_model("test-model", 3).unwrap();
        match path {
            VectorSearchPath::BruteForce(rows) => {
                assert_eq!(rows.len(), 1, "tiny corpus must brute-force");
                assert_eq!(rows[0].chunk_id, ids[0]);
            }
            VectorSearchPath::Ivf(_) => panic!("expected BruteForce path below threshold"),
        }
    }

    /// the cache returns the same `Arc` on
    /// back-to-back calls at the same generation. Pins the
    /// "build once, reuse forever" contract that makes IVF
    /// amortised — without it the k-means build would re-run on
    /// every query.
    #[test]
    fn vector_search_path_caches_across_calls_at_same_generation() {
        use crate::store::VectorSearchPath;
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_kchat_channel("/tmp/vsp-cache".to_string());
        store.add_source(&source).unwrap();
        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/vsp-cache/a.txt", "h", "2026-01-01")
            .unwrap();
        let chunks: Vec<_> = (0..5)
            .map(|i| crate::chunker::Chunk {
                source_path: "/tmp/vsp-cache/a.txt".to_string(),
                chunk_index: i,
                byte_offset: i,
                content: format!("c{i}"),
                hash: format!("h{i}"),
                extraction_method: None,
                extraction_model_id: None,
            })
            .collect();
        let ids = store.insert_chunks_returning_ids(file_id, &chunks).unwrap();
        for (i, &id) in ids.iter().enumerate() {
            let vec_bytes = crate::embedding::encode_vec(&[i as f32, 0.0, 0.0]);
            store
                .upsert_chunk_embedding(id, "test-model", 3, &vec_bytes)
                .unwrap();
        }

        let p1 = store.vector_search_path_for_model("test-model", 3).unwrap();
        let p2 = store.vector_search_path_for_model("test-model", 3).unwrap();
        // Cached path must share `Arc` storage with the previous
        // return value — `Arc::strong_count` would be > 1 because
        // both `p1` and the cache slot hold references.
        match (p1, p2) {
            (VectorSearchPath::BruteForce(a), VectorSearchPath::BruteForce(b)) => {
                assert!(
                    Arc::ptr_eq(&a, &b),
                    "cache must hand out the same Arc on consecutive calls"
                );
            }
            _ => panic!("expected BruteForce on both reads"),
        }
    }

    /// an embedding-row upsert must
    /// invalidate the cache so the NEXT search observes the new
    /// row. Pins the bump in `upsert_chunk_embedding`.
    #[test]
    fn vector_search_path_invalidates_on_embedding_upsert() {
        use crate::store::VectorSearchPath;
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_kchat_channel("/tmp/vsp-inv".to_string());
        store.add_source(&source).unwrap();
        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/vsp-inv/a.txt", "h", "2026-01-01")
            .unwrap();
        let ids = store
            .insert_chunks_returning_ids(
                file_id,
                &[crate::chunker::Chunk {
                    source_path: "/tmp/vsp-inv/a.txt".to_string(),
                    chunk_index: 0,
                    byte_offset: 0,
                    content: "first".to_string(),
                    hash: "h1".to_string(),
                    extraction_method: None,
                    extraction_model_id: None,
                }],
            )
            .unwrap();
        let v1_bytes = crate::embedding::encode_vec(&[1.0f32, 0.0]);
        store
            .upsert_chunk_embedding(ids[0], "test-model", 2, &v1_bytes)
            .unwrap();

        // Warm the cache.
        let warm = store.vector_search_path_for_model("test-model", 2).unwrap();
        let warm_rows = match warm {
            VectorSearchPath::BruteForce(rows) => rows,
            VectorSearchPath::Ivf(_) => panic!("small corpus expected to brute-force"),
        };
        assert_eq!(warm_rows.len(), 1);

        // Add a second chunk + embedding. The cache MUST observe
        // the bump and rebuild.
        let new_ids = store
            .insert_chunks_returning_ids(
                file_id,
                &[crate::chunker::Chunk {
                    source_path: "/tmp/vsp-inv/a.txt".to_string(),
                    chunk_index: 1,
                    byte_offset: 1,
                    content: "second".to_string(),
                    hash: "h2".to_string(),
                    extraction_method: None,
                    extraction_model_id: None,
                }],
            )
            .unwrap();
        let v2_bytes = crate::embedding::encode_vec(&[0.0f32, 1.0]);
        store
            .upsert_chunk_embedding(new_ids[0], "test-model", 2, &v2_bytes)
            .unwrap();

        let after = store.vector_search_path_for_model("test-model", 2).unwrap();
        let after_rows = match after {
            VectorSearchPath::BruteForce(rows) => rows,
            VectorSearchPath::Ivf(_) => panic!("small corpus expected to brute-force"),
        };
        assert_eq!(
            after_rows.len(),
            2,
            "cache must rebuild after embedding upsert"
        );
    }

    /// a source-status transition into
    /// AccessRevoked must invalidate the cache so the revoked
    /// rows drop out on the next search. Pins the bump in
    /// `update_source_status`.
    #[test]
    fn vector_search_path_invalidates_on_source_status_change() {
        use crate::store::VectorSearchPath;
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_kchat_channel("/tmp/vsp-acl".to_string());
        store.add_source(&source).unwrap();
        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/vsp-acl/a.txt", "h", "2026-01-01")
            .unwrap();
        let ids = store
            .insert_chunks_returning_ids(
                file_id,
                &[crate::chunker::Chunk {
                    source_path: "/tmp/vsp-acl/a.txt".to_string(),
                    chunk_index: 0,
                    byte_offset: 0,
                    content: "x".to_string(),
                    hash: "hx".to_string(),
                    extraction_method: None,
                    extraction_model_id: None,
                }],
            )
            .unwrap();
        let vb = crate::embedding::encode_vec(&[1.0f32, 0.0]);
        store
            .upsert_chunk_embedding(ids[0], "test-model", 2, &vb)
            .unwrap();

        // Warm the cache.
        let warm = store.vector_search_path_for_model("test-model", 2).unwrap();
        match warm {
            VectorSearchPath::BruteForce(rows) => assert_eq!(rows.len(), 1),
            VectorSearchPath::Ivf(_) => panic!("expected BruteForce on small corpus"),
        }

        // Revoke. Cache must observe the bump and the next call
        // must reload from SQL with the AccessRevoked filter
        // dropping the row.
        store
            .update_source_status(&source.id, SourceStatus::AccessRevoked, None)
            .unwrap();
        let after = store.vector_search_path_for_model("test-model", 2).unwrap();
        match after {
            VectorSearchPath::BruteForce(rows) => assert!(
                rows.is_empty(),
                "revoked-source rows must drop out after status change"
            ),
            VectorSearchPath::Ivf(_) => {
                panic!("expected BruteForce on small (revoked → 0) corpus")
            }
        }
    }

    /// when the corpus exceeds
    /// `IVF_BRUTE_FORCE_THRESHOLD` rows the cache hands out an
    /// `IvfIndex`, not a row buffer. Smoke test — recall vs
    /// brute-force is exercised by the vector_index unit tests.
    #[test]
    fn vector_search_path_above_threshold_returns_ivf() {
        use crate::store::VectorSearchPath;
        use crate::vector_index::IVF_BRUTE_FORCE_THRESHOLD;
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_kchat_channel("/tmp/vsp-big".to_string());
        store.add_source(&source).unwrap();
        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/vsp-big/a.txt", "h", "2026-01-01")
            .unwrap();
        // Insert IVF_BRUTE_FORCE_THRESHOLD + 1 chunks so the
        // threshold check definitely fires. The chunks themselves
        // are simple — different per-chunk content gives unique
        // hashes which `insert_chunks_returning_ids` requires.
        let n = IVF_BRUTE_FORCE_THRESHOLD + 1;
        let chunks: Vec<_> = (0..n)
            .map(|i| crate::chunker::Chunk {
                source_path: "/tmp/vsp-big/a.txt".to_string(),
                chunk_index: i,
                byte_offset: i,
                content: format!("c{i}"),
                hash: format!("h{i}"),
                extraction_method: None,
                extraction_model_id: None,
            })
            .collect();
        let ids = store.insert_chunks_returning_ids(file_id, &chunks).unwrap();
        for (i, &id) in ids.iter().enumerate() {
            let v = vec![(i as f32) / (n as f32), 0.5, 0.5];
            let vb = crate::embedding::encode_vec(&v);
            store
                .upsert_chunk_embedding(id, "test-model", 3, &vb)
                .unwrap();
        }

        let path = store.vector_search_path_for_model("test-model", 3).unwrap();
        match path {
            VectorSearchPath::Ivf(idx) => assert_eq!(idx.len(), n, "IVF must hold all rows"),
            VectorSearchPath::BruteForce(_) => {
                panic!("corpus above threshold must build IvfIndex, got BruteForce")
            }
        }
    }

    /// low-level regression for
    /// `cryptoshred_kchat_source_evidence`. The store-level test
    /// proves the DELETE-then-VACUUM path scrubs all three
    /// retrieval surfaces (chunks, chunks_fts, chunk_embeddings)
    /// in a single transaction. The manager-level tests pin the
    /// end-to-end behaviour through `refresh_kchat_acl` /
    /// `revoke_kchat_source`; this test isolates the store layer
    /// so a future change to the cascade triggers is caught here.
    #[test]
    fn cryptoshred_kchat_source_evidence_scrubs_chunks_fts_and_embeddings() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_kchat_channel("/tmp/kchat-shred".to_string());
        store.add_source(&source).unwrap();

        let file_id_a = store
            .upsert_indexed_file(&source.id, "/tmp/kchat-shred/a.txt", "h-a", "2026-01-01")
            .unwrap();
        let file_id_b = store
            .upsert_indexed_file(&source.id, "/tmp/kchat-shred/b.txt", "h-b", "2026-01-01")
            .unwrap();
        store
            .insert_chunks(
                file_id_a,
                &[crate::chunker::Chunk {
                    source_path: "/tmp/kchat-shred/a.txt".to_string(),
                    chunk_index: 0,
                    byte_offset: 0,
                    content: "operator alpha rotation plan".to_string(),
                    hash: "h-a-0".to_string(),
                    extraction_method: None,
                    extraction_model_id: None,
                }],
            )
            .unwrap();
        store
            .insert_chunks(
                file_id_b,
                &[crate::chunker::Chunk {
                    source_path: "/tmp/kchat-shred/b.txt".to_string(),
                    chunk_index: 0,
                    byte_offset: 0,
                    content: "operator bravo rotation plan".to_string(),
                    hash: "h-b-0".to_string(),
                    extraction_method: None,
                    extraction_model_id: None,
                }],
            )
            .unwrap();

        // Grab one chunk id so we can attach an embedding to it.
        // We attach before the shred so the test verifies the
        // `chunks_ad_embeddings` cascade fires.
        let pre = store.search_fts("operator", 10).unwrap();
        assert_eq!(
            pre.len(),
            2,
            "control: both chunks must be searchable pre-shred"
        );
        let any_chunk_id = pre[0].chunk_id;
        let dim: usize = 4;
        let vec_bytes: Vec<u8> = vec![0.1_f32, 0.2, 0.3, 0.4]
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect();
        store
            .upsert_chunk_embedding(any_chunk_id, "test-model", dim, &vec_bytes)
            .unwrap();
        let pre_embeddings = store.load_embeddings_for_model("test-model").unwrap();
        assert_eq!(
            pre_embeddings.len(),
            1,
            "control: embedding row must exist pre-shred",
        );

        // Run the shred.
        let outcome = store.cryptoshred_kchat_source_evidence(&source.id).unwrap();
        assert_eq!(
            outcome,
            KchatSourceCryptoshredOutcome {
                chunks_dropped: 2,
                files_dropped: 2,
                // no chat-post evidence
                // existed for this source, so no posts/DEK rows
                // were dropped.
                posts_dropped: 0,
                dek_dropped: false,
                vacuum_succeeded: true,
                vacuum_error: None,
            },
        );

        // All three retrieval surfaces are scrubbed.
        assert!(store.search_fts("operator", 10).unwrap().is_empty());
        assert!(store.list_indexed_files(&source.id).unwrap().is_empty());
        assert!(
            store
                .load_embeddings_for_model("test-model")
                .unwrap()
                .is_empty(),
            "chunk_embeddings cascade must fire on the shred path",
        );

        // The source row itself is preserved (file_count reset,
        // last_indexed cleared) so operator-side forensics still
        // shows the channel existed and was revoked.
        let refreshed = store.get_source(&source.id).unwrap();
        assert_eq!(refreshed.file_count, 0);
        assert_eq!(refreshed.last_indexed, None);
    }

    /// Block B Task 4 second-pass regression:
    /// `secure_delete` is connection-scoped, and the
    /// `SharedConnection` is reused by every store in the process.
    /// If `cryptoshred_kchat_source_evidence` leaves `secure_delete`
    /// set to `ON` after returning, every subsequent chunk insert,
    /// FTS5 trigger fire, and audit-append pays the page-zero-fill
    /// cost for the lifetime of the process. This test pins the
    /// invariant by inspecting `PRAGMA secure_delete` after a normal
    /// (Ok) shred path and after an idempotent (zero-row) shred
    /// path. The error path is asserted by the structure of the
    /// closure-based cleanup pattern in `store.rs` itself (the OFF
    /// reset runs unconditionally after the closure returns).
    #[test]
    fn cryptoshred_kchat_source_evidence_restores_secure_delete_off() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_kchat_channel("/tmp/kchat-shred-pragma".to_string());
        store.add_source(&source).unwrap();

        // Helper: read the connection-scoped `secure_delete` pragma
        // through the same shared connection the store uses, so the
        // assertion sees exactly what subsequent indexer writes
        // would see.
        let read_secure_delete = || -> i64 {
            let conn = store.conn.lock().expect("conn poisoned");
            conn.query_row("PRAGMA secure_delete", [], |row| row.get::<_, i64>(0))
                .expect("PRAGMA secure_delete should always return a row")
        };

        // Baseline: secure_delete defaults to OFF (0).
        assert_eq!(
            read_secure_delete(),
            0,
            "control: secure_delete should default to OFF on a fresh connection",
        );

        // Path 1: idempotent shred (no rows to drop) — must still
        // restore OFF.
        let _ = store.cryptoshred_kchat_source_evidence(&source.id).unwrap();
        assert_eq!(
            read_secure_delete(),
            0,
            "secure_delete must be restored to OFF after an idempotent shred",
        );

        // Seed one chunk + one indexed_file so the next shred takes
        // the non-idempotent path (transaction + VACUUM).
        let file_id = store
            .upsert_indexed_file(
                &source.id,
                "/tmp/kchat-shred-pragma/a.txt",
                "h-pragma",
                "2026-01-01",
            )
            .unwrap();
        store
            .insert_chunks(
                file_id,
                &[crate::chunker::Chunk {
                    source_path: "/tmp/kchat-shred-pragma/a.txt".to_string(),
                    chunk_index: 0,
                    byte_offset: 0,
                    content: "operator pragma rotation plan".to_string(),
                    hash: "h-pragma-0".to_string(),
                    extraction_method: None,
                    extraction_model_id: None,
                }],
            )
            .unwrap();

        // Path 2: successful shred with VACUUM — must restore OFF.
        let outcome = store.cryptoshred_kchat_source_evidence(&source.id).unwrap();
        assert_eq!(outcome.chunks_dropped, 1);
        assert_eq!(outcome.files_dropped, 1);
        assert_eq!(
            read_secure_delete(),
            0,
            "secure_delete must be restored to OFF after a successful shred + VACUUM",
        );
    }

    /// Every content-bearing deletion path must (a) actually remove
    /// the rows and (b) leave the connection-scoped `secure_delete`
    /// pragma restored to OFF — leaving it ON would silently impose
    /// page-zero-fill write amplification on every steady-state
    /// indexer insert for the rest of the process lifetime. This
    /// pins the contract for `remove_source`,
    /// `delete_chunks_for_indexed_file`, and `remove_indexed_file`,
    /// which now route their DELETEs through `with_secure_delete`.
    #[test]
    fn deletion_paths_scrub_rows_and_restore_secure_delete_off() {
        let store = SourceStore::open_in_memory().unwrap();

        let read_secure_delete = || -> i64 {
            let conn = store.conn.lock().expect("conn poisoned");
            conn.query_row("PRAGMA secure_delete", [], |row| row.get::<_, i64>(0))
                .expect("PRAGMA secure_delete should always return a row")
        };

        assert_eq!(read_secure_delete(), 0, "control: defaults to OFF");

        // --- delete_chunks_for_indexed_file -----------------------
        let source = Source::new_local_folder("/tmp/scrub".to_string());
        store.add_source(&source).unwrap();
        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/scrub/a.txt", "h-a", "2026-01-01")
            .unwrap();
        store
            .insert_chunks(
                file_id,
                &[crate::chunker::Chunk {
                    source_path: "/tmp/scrub/a.txt".to_string(),
                    chunk_index: 0,
                    byte_offset: 0,
                    content: "secret sentinel alpha".to_string(),
                    hash: "h-a-0".to_string(),
                    extraction_method: None,
                    extraction_model_id: None,
                }],
            )
            .unwrap();
        let dropped = store.delete_chunks_for_indexed_file(file_id).unwrap();
        assert_eq!(dropped, 1, "the chunk should have been deleted");
        assert_eq!(
            read_secure_delete(),
            0,
            "delete_chunks_for_indexed_file must restore secure_delete=OFF",
        );

        // --- remove_indexed_file -----------------------------------
        store
            .insert_chunks(
                file_id,
                &[crate::chunker::Chunk {
                    source_path: "/tmp/scrub/a.txt".to_string(),
                    chunk_index: 0,
                    byte_offset: 0,
                    content: "secret sentinel bravo".to_string(),
                    hash: "h-a-1".to_string(),
                    extraction_method: None,
                    extraction_model_id: None,
                }],
            )
            .unwrap();
        store.remove_indexed_file("/tmp/scrub/a.txt").unwrap();
        assert_eq!(
            store.all_chunks_for_path("/tmp/scrub/a.txt").unwrap().len(),
            0,
            "remove_indexed_file should drop the file's chunks",
        );
        assert_eq!(
            read_secure_delete(),
            0,
            "remove_indexed_file must restore secure_delete=OFF",
        );

        // --- remove_source -----------------------------------------
        let file_id2 = store
            .upsert_indexed_file(&source.id, "/tmp/scrub/b.txt", "h-b", "2026-01-01")
            .unwrap();
        store
            .insert_chunks(
                file_id2,
                &[crate::chunker::Chunk {
                    source_path: "/tmp/scrub/b.txt".to_string(),
                    chunk_index: 0,
                    byte_offset: 0,
                    content: "secret sentinel charlie".to_string(),
                    hash: "h-b-0".to_string(),
                    extraction_method: None,
                    extraction_model_id: None,
                }],
            )
            .unwrap();
        store.remove_source(&source.id).unwrap();
        assert!(
            !store
                .list_sources()
                .unwrap()
                .iter()
                .any(|s| s.id == source.id),
            "remove_source should delete the source row",
        );
        assert_eq!(
            read_secure_delete(),
            0,
            "remove_source must restore secure_delete=OFF",
        );

        // --- upsert_indexed_file re-index (hash change) -------------
        // Re-indexing a file whose content changed drops the previous
        // revision's chunks. That superseded plaintext must be
        // zero-filled too, and the pragma restored to OFF.
        let source2 = Source::new_local_folder("/tmp/reindex".to_string());
        store.add_source(&source2).unwrap();
        let rid = store
            .upsert_indexed_file(&source2.id, "/tmp/reindex/c.txt", "rev-1", "2026-01-01")
            .unwrap();
        store
            .insert_chunks(
                rid,
                &[crate::chunker::Chunk {
                    source_path: "/tmp/reindex/c.txt".to_string(),
                    chunk_index: 0,
                    byte_offset: 0,
                    content: "secret sentinel delta".to_string(),
                    hash: "rev-1-0".to_string(),
                    extraction_method: None,
                    extraction_model_id: None,
                }],
            )
            .unwrap();
        // Same path, NEW hash → the existing-row branch deletes the old
        // chunks before resetting chunk_count.
        let rid_again = store
            .upsert_indexed_file(&source2.id, "/tmp/reindex/c.txt", "rev-2", "2026-01-02")
            .unwrap();
        assert_eq!(rid_again, rid, "re-index keeps the same indexed_file row");
        assert_eq!(
            store
                .all_chunks_for_path("/tmp/reindex/c.txt")
                .unwrap()
                .len(),
            0,
            "re-index must drop the superseded revision's chunks",
        );
        assert_eq!(
            read_secure_delete(),
            0,
            "upsert_indexed_file re-index must restore secure_delete=OFF",
        );
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
    fn mark_file_needs_reindex_forces_next_pass_to_reprocess() {
        // The partial-OCR / partial-chart recovery contract: when
        // a VLM pass is cut short by the rate limiter, the indexer
        // stamps a `partial:` sentinel on the row so the next
        // `index_file` call's hash-equality check misses and the
        // file is fully re-processed. This test pins the
        // round-trip: upsert with hash H, mark partial, then call
        // upsert AGAIN with the same hash H — the second upsert
        // MUST see a mismatch (because the row now stores
        // `partial:H` not `H`), delete the existing chunks, and
        // stamp the row with the raw hash again.
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        let real_hash = "a".repeat(64); // realistic 64-hex-char BLAKE3
        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/test/big.pdf", &real_hash, "2026-01-01")
            .unwrap();

        // Insert two chunks so we can verify the re-process
        // actually deletes them.
        let chunks = vec![crate::chunker::Chunk {
            source_path: "/tmp/test/big.pdf".to_string(),
            chunk_index: 0,
            byte_offset: 0,
            content: "page 1 ocr text".to_string(),
            hash: "c1".to_string(),
            extraction_method: Some(crate::chunker::ExtractionMethod::VlmOcr),
            extraction_model_id: Some("test-vlm".to_string()),
        }];
        store.insert_chunks(file_id, &chunks).unwrap();
        assert_eq!(
            store
                .all_chunks_for_path("/tmp/test/big.pdf")
                .unwrap()
                .len(),
            1
        );

        // Stamp partial sentinel.
        store.mark_file_needs_reindex(file_id).unwrap();
        let stored = store.get_file_hash("/tmp/test/big.pdf").unwrap().unwrap();
        assert_eq!(stored, format!("partial:{real_hash}"));

        // Now upsert with the same real hash — must DETECT mismatch
        // (partial:H vs H) and delete the existing chunks.
        let file_id_after = store
            .upsert_indexed_file(&source.id, "/tmp/test/big.pdf", &real_hash, "2026-01-01")
            .unwrap();
        assert_eq!(file_id, file_id_after, "row identity must be preserved");
        // Hash is now the real one again.
        let stored_after = store.get_file_hash("/tmp/test/big.pdf").unwrap().unwrap();
        assert_eq!(stored_after, real_hash);
        // Previous partial chunks have been wiped.
        assert!(
            store
                .all_chunks_for_path("/tmp/test/big.pdf")
                .unwrap()
                .is_empty(),
            "upsert-after-partial MUST delete the partial chunks so the next pass writes a clean set"
        );
    }

    #[test]
    fn mark_file_needs_reindex_is_idempotent() {
        // Re-stamping a row that's already `partial:` must NOT
        // compound the prefix. Without the `WHEN hash LIKE 'partial:%'`
        // guard in the UPDATE statement, repeated partial passes
        // on the same file would produce `partial:partial:partial:HEX`
        // and bloat the row over time.
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        let real_hash = "b".repeat(64);
        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/test/big.pdf", &real_hash, "2026-01-01")
            .unwrap();

        // Stamp partial three times.
        store.mark_file_needs_reindex(file_id).unwrap();
        store.mark_file_needs_reindex(file_id).unwrap();
        store.mark_file_needs_reindex(file_id).unwrap();

        let stored = store.get_file_hash("/tmp/test/big.pdf").unwrap().unwrap();
        assert_eq!(
            stored,
            format!("partial:{real_hash}"),
            "repeated partial stamps must NOT compound: expected single `partial:` prefix, got `{stored}`"
        );
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
            extraction_method: None,
            extraction_model_id: None,
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
        // Defence-in-depth regression test: with
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

    #[test]
    fn chunks_missing_embedding_excluding_returns_ascending_chunk_id() {
        // Regression test: the SELECT in
        // `chunks_missing_embedding_excluding` previously had no
        // ORDER BY clause, relying on SQLite's implicit rowid order.
        // That ordering is an implementation detail and can shift
        // when the btree is reshuffled (autovacuum, page-split
        // rebalances), so a backfill stall reproducer logged with
        // the first-batch chunk ids would have been impossible to
        // reproduce on a later run.
        //
        // This test pins the contract: ascending `chunks.id`,
        // stable across repeated calls with the same exclude set.
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/ordering".to_string());
        store.add_source(&source).unwrap();

        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/ordering/doc.txt", "h", "2026-01-01")
            .unwrap();

        // Insert five chunks. SQLite will assign them rowids 1..=5
        // in insertion order; we intentionally do NOT sort the
        // input list — the ORDER BY in the query is what pins the
        // output order, not the insertion order.
        let chunks: Vec<_> = (0..5)
            .map(|i| crate::chunker::Chunk {
                source_path: "/tmp/ordering/doc.txt".to_string(),
                chunk_index: i,
                byte_offset: i * 100,
                content: format!("chunk body {i}"),
                hash: format!("hash{i}"),
                extraction_method: None,
                extraction_model_id: None,
            })
            .collect();
        store.insert_chunks(file_id, &chunks).unwrap();

        let model_id = "test-embed-v1";

        // First call: no excludes. Should return all 5 ids in
        // ascending order.
        let first = store
            .chunks_missing_embedding_excluding(model_id, 100, &[])
            .unwrap();
        let first_ids: Vec<i64> = first.iter().map(|(id, _)| *id).collect();
        assert_eq!(first_ids.len(), 5, "expected all 5 chunks unembedded");
        for w in first_ids.windows(2) {
            assert!(
                w[0] < w[1],
                "chunks_missing_embedding_excluding output must be ascending; saw {w:?}"
            );
        }

        // Repeat the same call 20 times to make sure the ordering
        // is truly stable, not just "happened to be ascending once".
        // Without ORDER BY this would still typically pass on a
        // freshly-built table, so the windowing assertion above is
        // the real meat — but pinning stability across iterations
        // catches any future "let's optimise this with a hash
        // join" regression that would shuffle the rows.
        for _ in 0..20 {
            let again = store
                .chunks_missing_embedding_excluding(model_id, 100, &[])
                .unwrap();
            let again_ids: Vec<i64> = again.iter().map(|(id, _)| *id).collect();
            assert_eq!(
                again_ids, first_ids,
                "chunks_missing_embedding_excluding must be order-stable across repeated calls"
            );
        }

        // With excludes: pulling out the middle chunk must keep
        // the remaining four in ascending order.
        let middle = first_ids[2];
        let with_excludes = store
            .chunks_missing_embedding_excluding(model_id, 100, &[middle])
            .unwrap();
        let with_exclude_ids: Vec<i64> = with_excludes.iter().map(|(id, _)| *id).collect();
        let expected: Vec<i64> = first_ids
            .iter()
            .copied()
            .filter(|id| *id != middle)
            .collect();
        assert_eq!(
            with_exclude_ids, expected,
            "exclude set must not perturb the ascending-id contract"
        );
    }

    #[test]
    fn count_chunks_missing_embedding_matches_vec_path() {
        // The count path uses a separate SQL statement (`SELECT
        // COUNT(*)` vs. `SELECT c.id, c.content`) so we explicitly
        // pin that it returns the same answer as the materialising
        // path. This is the contract the bridge layer relies on
        // to seed the progress denominator.
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/counts".to_string());
        store.add_source(&source).unwrap();

        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/counts/doc.txt", "h", "2026-01-01")
            .unwrap();

        // Insert 7 chunks; none have embeddings yet.
        let chunks: Vec<_> = (0..7)
            .map(|i| crate::chunker::Chunk {
                source_path: "/tmp/counts/doc.txt".to_string(),
                chunk_index: i,
                byte_offset: i * 100,
                content: format!("body {i}"),
                hash: format!("h{i}"),
                extraction_method: None,
                extraction_model_id: None,
            })
            .collect();
        store.insert_chunks(file_id, &chunks).unwrap();

        let model_id = "embed-test-v1";

        // Cross-check the count against the Vec path.
        let vec_len = store
            .chunks_missing_embedding(model_id, 1024)
            .unwrap()
            .len() as u64;
        let count = store.count_chunks_missing_embedding(model_id).unwrap();
        assert_eq!(count, 7);
        assert_eq!(count, vec_len);

        // Embed three of the seven chunks. The count must drop to 4
        // while the model_id we just used disappears from the
        // missing set; a *different* model_id still sees all 7.
        let materialised = store.chunks_missing_embedding(model_id, 3).unwrap();
        for (id, _content) in &materialised {
            store
                .upsert_chunk_embedding(*id, model_id, 4, &[0u8; 16])
                .unwrap();
        }
        let count_after = store.count_chunks_missing_embedding(model_id).unwrap();
        assert_eq!(count_after, 4);

        let other_count = store
            .count_chunks_missing_embedding("different-model-v1")
            .unwrap();
        assert_eq!(
            other_count, 7,
            "embeddings for one model must not satisfy the missing count for another"
        );
    }

    // -- sync-failure persistence tests --------------------
    //
    // The connectors crate doesn't depend on tessera_sources (and
    // tessera_sources doesn't depend on tessera_connectors — would
    // be a cycle), so these tests exercise the storage layer
    // directly with raw JSON strings rather than constructing a
    // `PersistedSyncError`. The shape-level round-trip is
    // covered in `tessera_connectors::failure_state` tests; this
    // module pins the *persistence* contract.

    #[test]
    fn sync_failure_state_defaults_to_empty_for_pristine_source() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        let (err, retry_count, failed) = store.get_sync_failure_state(&source.id).unwrap();
        assert!(err.is_none());
        assert_eq!(retry_count, 0);
        assert!(!failed);
    }

    #[test]
    fn record_sync_failure_then_read_round_trips_all_fields() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        let payload = r#"{"kind":"transient","message":"timeout"}"#;
        store
            .record_sync_failure(&source.id, payload, 3, false)
            .unwrap();

        let (err, retry_count, failed) = store.get_sync_failure_state(&source.id).unwrap();
        assert_eq!(err.as_deref(), Some(payload));
        assert_eq!(retry_count, 3);
        assert!(!failed);
    }

    #[test]
    fn record_sync_failure_with_permanent_flag_persists_sticky_bit() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        let payload = r#"{"kind":"permanent","message":"revoked"}"#;
        store
            .record_sync_failure(&source.id, payload, 1, true)
            .unwrap();
        let (_, _, failed) = store.get_sync_failure_state(&source.id).unwrap();
        assert!(failed, "permanent failure must set the sticky bit");
    }

    #[test]
    fn record_sync_success_clears_failure_state_completely() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();
        store
            .record_sync_failure(&source.id, r#"{"kind":"permanent","message":"x"}"#, 7, true)
            .unwrap();

        store.record_sync_success(&source.id).unwrap();

        let (err, retry_count, failed) = store.get_sync_failure_state(&source.id).unwrap();
        assert!(err.is_none());
        assert_eq!(retry_count, 0);
        assert!(
            !failed,
            "success must clear the permanently-failed sticky bit so the user does not have to dismiss a stale badge"
        );
    }

    #[test]
    fn record_sync_failure_for_missing_source_id_errors_loudly() {
        let store = SourceStore::open_in_memory().unwrap();
        let phantom = SourceId(uuid::Uuid::new_v4());
        let err = store.record_sync_failure(&phantom, r#"{}"#, 1, false);
        assert!(
            err.is_err(),
            "writing to a non-existent source id must surface an error"
        );
    }

    #[test]
    fn get_sync_failure_state_for_missing_source_id_returns_empty_tuple() {
        // The reader path treats "no row" and "fresh row" as the
        // same thing because the renderer cannot do anything
        // meaningful with the distinction. Pin this contract.
        let store = SourceStore::open_in_memory().unwrap();
        let phantom = SourceId(uuid::Uuid::new_v4());
        let (err, retry_count, failed) = store.get_sync_failure_state(&phantom).unwrap();
        assert!(err.is_none());
        assert_eq!(retry_count, 0);
        assert!(!failed);
    }

    #[test]
    fn sync_failure_writes_are_atomic_across_all_three_columns() {
        // Pin that record_sync_failure is a single statement that
        // updates all three columns together. Achieved by writing
        // ONLY the JSON column first (impossible via the public
        // API — this test simulates a corrupt-on-disk partial
        // write by raw SQL) then asserting `record_sync_failure`
        // rewrites all three together.
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        // Simulate a torn write on disk: stamp the JSON column
        // but leave retry_count + failed_permanently as defaults.
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "UPDATE sources SET last_sync_error = ?1 WHERE id = ?2",
                params![
                    "{\"kind\":\"transient\",\"message\":\"stale\"}",
                    source.id.to_string()
                ],
            )
            .unwrap();
        }

        // Now call record_sync_failure — the new state must
        // completely replace the partial state.
        store
            .record_sync_failure(
                &source.id,
                r#"{"kind":"permanent","message":"fresh"}"#,
                5,
                true,
            )
            .unwrap();

        let (err, retry_count, failed) = store.get_sync_failure_state(&source.id).unwrap();
        assert!(err.as_deref().unwrap().contains("fresh"));
        assert_eq!(retry_count, 5);
        assert!(failed);
    }

    #[test]
    fn count_non_ascii_chunks_is_memoized_and_invalidates_on_insert() {
        // Devin Review FLAG: the multilingual hint
        // poll runs at 1 s and the underlying SQL is a GLOB scan that
        // cannot use an index. We memoize for NON_ASCII_CACHE_TTL and
        // invalidate the cache from chunk-mutation paths so the hint
        // stays accurate AND polls stay cheap. This test pins both
        // halves of that contract.
        use crate::chunker::Chunk;

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        // Phase 1: empty corpus → (0, 0). Cache is populated.
        assert_eq!(store.count_non_ascii_chunks().unwrap(), (0, 0));

        // Phase 2: write directly via the raw connection (bypassing
        // insert_chunks, which would call invalidate_non_ascii_cache).
        // The next call MUST still return the cached (0, 0) — proving
        // the cache is doing its job and skipping the GLOB scan.
        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/test/a.txt", "hashA", "2026-01-01")
            .unwrap();
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO chunks (indexed_file_id, chunk_index, byte_offset, content, hash) \
                 VALUES (?1, 0, 0, '財務報告', 'h1')",
                params![file_id],
            )
            .unwrap();
        }
        assert_eq!(
            store.count_non_ascii_chunks().unwrap(),
            (0, 0),
            "cache must hide the raw-SQL insert until invalidated"
        );

        // Phase 3: now call insert_chunks via the public API. It MUST
        // invalidate the cache so the next call observes ALL chunks
        // (both the raw-SQL one from phase 2 AND the public one).
        let chunks = vec![Chunk {
            source_path: "/tmp/test/a.txt".to_string(),
            chunk_index: 1,
            byte_offset: 100,
            content: "english only".to_string(),
            hash: "h2".to_string(),
            extraction_method: None,
            extraction_model_id: None,
        }];
        store.insert_chunks(file_id, &chunks).unwrap();
        assert_eq!(
            store.count_non_ascii_chunks().unwrap(),
            (1, 2),
            "insert_chunks must invalidate so the next poll re-scans"
        );

        // Phase 4: delete_chunks_for_indexed_file also invalidates.
        store.delete_chunks_for_indexed_file(file_id).unwrap();
        assert_eq!(store.count_non_ascii_chunks().unwrap(), (0, 0));
    }
}
