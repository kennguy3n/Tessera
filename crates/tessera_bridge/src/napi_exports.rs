//! Top-level N-API entry points wiring the Rust core managers to the
//! desktop app, including async tasks shared across bridge modules.

use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Task};
use napi_derive::napi;

use tessera_artifacts::automations::AutomationStore;
use tessera_artifacts::manager::ArtifactManager;
use tessera_artifacts::tasks::TaskStore;
use tessera_audit::logger::AuditLogger;
use tessera_audit::store::AuditStore;
use tessera_citations::tracker::CitationTracker;
use tessera_core::{
    default_read_pool_size, empty_read_pool, open_shared_read_pool_with_key, open_shared_with_key,
    SharedReadPool,
};
use tessera_sources::manager::SourceManager;
use tessera_sources::progress::EmbeddingProgressTracker;

use crate::artifacts;
use crate::automations;
use crate::citations;
use crate::exporter;
use crate::sources;
use crate::tasks;
use crate::templates;

static APP_STATE: std::sync::OnceLock<AppState> = std::sync::OnceLock::new();

// N-API callbacks are single-threaded (main thread only), so deadlocks from
// concurrent lock acquisition cannot occur. Mutexes provide interior mutability.
//
// There are TWO acquisition patterns in this file:
//
//   A. **Stacked acquisition** — used when an operation needs to
//      hold multiple locks simultaneously (e.g. `bridge_export_artifact_to_file`
//      reads both `artifact_manager` and `citation_tracker` and exports them
//      together). When stacking, acquire in this order to keep the lock graph
//      a DAG and to prevent any future async refactor from deadlocking:
//
//        1. audit_logger → 2. source_manager → 3. artifact_manager →
//        4. citation_tracker → 5. task_store → 6. automation_store
//
//   B. **Sequential non-overlapping acquisition** — used for the audit-after-action
//      pattern. The handler acquires a per-store lock, runs the operation, drops
//      that lock, then acquires `audit_logger` to emit the row. The two locks
//      are never held at the same time, so there is no deadlock risk regardless
//      of which one is documented "first" in pattern A above. The fence between
//      operate-and-emit-audit is an explicit `drop(per_store_lock)` so the
//      ordering is mechanically clear from the source. This pattern
//      (a) prevents phantom audit rows on failed operations (the audit emit is
//      gated on the operation's `?` early-return) and (b) ensures the audit
//      append never delays the user-visible action by holding the per-store lock
//      across a SQLite write to the audit DB.
//
// Both patterns are safe; the choice depends on whether the audit row's data
// is computed only after the operation completes (→ use B) or is known before
// (→ either, but B is preferred for new code so the audit is gated on success).
//
// Every store is also internally backed by a single shared
// `Arc<Mutex<rusqlite::Connection>>` (opened once in `init_bridge`), so
// regardless of which outer per-store mutex is held, all DB work
// ultimately serialises on the same inner connection. That collapses
// the lock graph to a single physical writer and means the per-store
// outer mutexes really only protect interior state on the Rust side
// (e.g. `ArtifactManager::last_version_at`).
struct AppState {
    source_manager: Mutex<SourceManager>,
    artifact_manager: Mutex<ArtifactManager>,
    audit_logger: Mutex<AuditLogger>,
    citation_tracker: Mutex<CitationTracker>,
    task_store: Mutex<TaskStore>,
    automation_store: Mutex<AutomationStore>,
    template_dir: String,
    /// Cached `Arc` clone of the embedding-progress tracker that
    /// lives inside `source_manager`. Read by
    /// `bridge_get_embedding_progress` without locking the
    /// `source_manager` mutex, so progress polls succeed even while
    /// a `bridge_backfill_embeddings` `AsyncTask` is in flight on a
    /// libuv worker thread holding the `source_manager` lock.
    embedding_progress: Arc<EmbeddingProgressTracker>,
    /// tracker for in-flight ONNX embedding-model
    /// downloads. Pollable from any thread without locking
    /// `source_manager`, just like `embedding_progress` — important
    /// because the download `AsyncTask` runs on a libuv worker
    /// thread that does NOT hold the source-manager mutex (the
    /// download is purely a filesystem + network operation) but
    /// the renderer polls progress on its own timer that must not
    /// block on either.
    download_progress: Arc<sources::DownloadProgressTracker>,
    /// Arc clone of the shared SQLite connection so
    /// `bridge_dispose` can run `wal_checkpoint(TRUNCATE)` without
    /// going through any individual store's lock. Holding it here
    /// also keeps the connection alive even if every individual
    /// store is dropped or replaced during shutdown.
    shared_conn: tessera_core::SharedConnection,
}

/// Initialise the bridge. `db_key`, when non-empty, is a 64-character
/// hex string holding the raw SQLCipher key derived by
/// `apps/desktop/electron/dbKey.ts` (random 32 bytes, persisted on disk
/// wrapped by `safeStorage`). When `db_key` is empty or `None`, the
/// database is opened unencrypted — this path exists for testing and
/// for headless environments where Electron's `safeStorage` is
/// unavailable and the renderer chose not to prompt for a fallback
/// password
///
/// `napi-rs` 2.x maps `Option<String>` to a TypeScript `string | null | undefined`
/// at the boundary, so callers can simply pass `null` or omit the
/// argument in JS.
#[napi]
pub fn init_bridge(
    db_path: String,
    template_dir: String,
    db_key: Option<String>,
) -> napi::Result<()> {
    // Open a single shared `rusqlite::Connection` and hand `Arc` clones to
    // each store via `with_shared_conn`. This reduces the file-descriptor
    // / per-connection-cache footprint from 6 to 1 and ensures every
    // writer ultimately serialises on the same inner mutex, which keeps
    // SQLite's write semantics unchanged even though the outer per-store
    // mutexes used to be the only serialisation boundary.
    //
    // When `db_key` is `Some(hex)`, `open_shared_with_key` issues
    // `PRAGMA key = "x'<hex>'"` immediately after open and, if the
    // file is a pre-encryption plaintext DB, transparently migrates
    // it via `sqlcipher_export`. See `tessera_core::db` for the full
    // protocol including wrong-key behaviour and the file-header
    // heuristic that drives the migration path.
    //
    // Treat an empty string from JS the same as `None`: the renderer
    // sometimes serialises an unset key as `""` rather than `null`,
    // and silently letting an empty key flow into `validate_hex_key`
    // would produce a confusing "db key must be 64 hex characters,
    // got 0" error instead of the intended "no encryption" path.
    let key_ref = match db_key.as_deref() {
        Some("") | None => None,
        Some(k) => Some(k),
    };
    let conn = open_shared_with_key(&db_path, key_ref)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    // run `PRAGMA integrity_check` (with one
    // retry after `wal_checkpoint(TRUNCATE)`) before any store
    // touches the database. If corruption persists past the retry
    // we surface a structured error to the renderer rather than
    // letting the first store-level write fail with a less helpful
    // SQLite-internal message.
    tessera_core::db::integrity_check_with_retry(&conn)
        .map_err(|e| napi::Error::from_reason(format!("database integrity check failed: {e}")))?;

    // open a pool of read-only connections backing the
    // SourceStore's hot read paths (BM25 FTS5, embedding-row scan,
    // chunk hydration, age lookup). The size is auto-tuned from the
    // host CPU count and capped at `MAX_READ_POOL_SIZE` (2 on this
    // single-user desktop build) via `default_read_pool_size` — large
    // enough to keep search latency off the writer mutex when a writer
    // is mid-transaction (WAL gives readers a snapshot without blocking
    // the writer) and to overlap a user search with a background ingest
    // read, small enough that we don't burn idle file descriptors +
    // page caches on a many-core host that a single-user app can't use.
    //
    // For `:memory:` test paths the pool is unconditionally
    // empty (in-memory DBs can't be shared across connections);
    // SourceStore transparently falls back to the writer
    // connection in that case so behaviour is identical.
    let read_pool_size = default_read_pool_size();
    let read_pool: SharedReadPool = match open_shared_read_pool_with_key(
        &db_path,
        key_ref,
        read_pool_size,
    ) {
        Ok(pool) => pool,
        Err(e) => {
            // Don't fail bridge init if pool open fails — the
            // writer is the source of truth and SourceStore
            // falls back to it for reads when the pool is empty.
            // Log the cause so the user-visible degradation has a
            // record.
            eprintln!(
                "[tessera_bridge] failed to open read pool for {db_path}: {e}; falling back to single-connection reads"
            );
            empty_read_pool()
        }
    };

    // Pre-warm the freshly-opened pool so the first user-facing read
    // (initial search / source list) doesn't pay the per-connection
    // cold-cache + SQLCipher schema-decrypt cost on its critical
    // path. Best-effort and a no-op on the empty (in-memory / failed)
    // pool; see `SharedReadPool::prewarm`.
    read_pool.prewarm();

    let mut source_manager =
        SourceManager::with_shared_conn_and_read_pool(conn.clone(), read_pool, &[])
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    // bind the per-source DEK / AEAD
    // facade in the manager to the same master key that protects
    // the SQLCipher file. Without this rebind, ingestion would use
    // the ephemeral per-process random key the constructor falls
    // back to — which is fine for tests but would lose every
    // ingested post body across a process restart. When the
    // renderer hasn't supplied a key (the `Some("") | None` plain
    // SQLite path), we leave the ephemeral key in place; the
    // SQLCipher protection is the strong layer, so a plain-DB
    // configuration has nothing to bind to.
    if let Some(k) = key_ref {
        source_manager
            .set_kchat_master_key(k)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    }
    let artifact_manager = ArtifactManager::with_shared_conn(conn.clone())
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let audit_logger = AuditLogger::with_shared_conn(conn.clone())
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let citation_tracker = CitationTracker::with_shared_conn(conn.clone())
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let task_store = TaskStore::with_shared_conn(conn.clone())
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let automation_store = AutomationStore::with_shared_conn(conn.clone())
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let embedding_progress = source_manager.embedding_progress_handle();

    APP_STATE
        .set(AppState {
            source_manager: Mutex::new(source_manager),
            artifact_manager: Mutex::new(artifact_manager),
            audit_logger: Mutex::new(audit_logger),
            citation_tracker: Mutex::new(citation_tracker),
            task_store: Mutex::new(task_store),
            automation_store: Mutex::new(automation_store),
            template_dir,
            embedding_progress,
            // tracker starts in `idle` with no
            // download in flight; the first call to
            // `bridge_download_embedding_model` flips it to
            // `downloading` synchronously before the AsyncTask
            // spawns, defusing the same renderer-polls-stale-state
            // race the embedding-progress tracker handles.
            download_progress: Arc::new(sources::DownloadProgressTracker::new()),
            shared_conn: conn,
        })
        .map_err(|_| napi::Error::from_reason("Bridge already initialized"))?;

    Ok(())
}

/// graceful-shutdown hook. Runs
/// `PRAGMA wal_checkpoint(TRUNCATE)` so the on-disk WAL is folded
/// back into the main database file and shrunk to zero bytes
/// before the process exits. The Electron side calls this from
/// `app.on("will-quit", ...)` so the next cold-start does not need
/// to replay WAL frames, and so backup tools see a single self-
/// contained file.
///
/// Safe to call before `init_bridge` (returns `Ok(())` as a no-op)
/// so the renderer doesn't need to guard against the bridge
/// failing to initialise.
#[napi]
pub fn bridge_dispose() -> napi::Result<()> {
    let Some(state) = APP_STATE.get() else {
        return Ok(());
    };
    tessera_core::db::wal_checkpoint_truncate(&state.shared_conn)
        .map(|_| ())
        .map_err(|e| napi::Error::from_reason(format!("wal checkpoint failed: {e}")))
}

fn state() -> napi::Result<&'static AppState> {
    APP_STATE
        .get()
        .ok_or_else(|| napi::Error::from_reason("Bridge not initialized. Call init_bridge first."))
}

// --- Sources ---

#[napi]
/// N-API entry point: registers a local folder source and emits a
/// `SourceAdded` audit row on success.
pub fn bridge_add_local_folder(path: String) -> napi::Result<sources::SourceInfo> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let info = sources::add_local_folder(&mgr, &path)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    // Audit AFTER the add commits (sequential non-overlapping
    // acquisition; pattern B in the file-level comment). A failed
    // add (invalid path, permission denied, duplicate source,
    // FS error) must not leave a phantom "SourceAdded" row.
    drop(mgr);
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_source_added(&path);
    }
    Ok(info)
}

#[napi]
/// N-API entry point: registers a single local file source and
/// emits a `SourceAdded` audit row on success.
pub fn bridge_add_local_file(path: String) -> napi::Result<sources::SourceInfo> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let info = sources::add_local_file(&mgr, &path)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    // Audit AFTER the add commits (pattern B). Same rationale as
    // `bridge_add_local_folder` above: phantom-row prevention on
    // every audit-emitting source-add path.
    drop(mgr);
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_source_added(&path);
    }
    Ok(info)
}

/// Register-or-reindex a KChat-channel source backed by a local cache
/// directory populated by the Node-side KChat client. Re-uses the
/// local-folder indexing pipeline (text extraction → chunking →
/// embeddings → FTS5).
///
/// **Idempotent on `cache_dir`** — the Node side calls this on every
/// channel re-sync (the convergent-sync pattern owned by the
/// `sources:addKchatChannel` handler). A previous implementation
/// generated a fresh `SourceId` on every call, leaving duplicate
/// source rows per sync. The returned outcome's `newly_created` flag
/// is true only on the call that inserted the row; subsequent re-
/// syncs return the same `SourceId` with `newly_created=false`.
///
/// We only emit the `SourceAdded` audit event when the call actually
/// inserted a row — re-syncs do not add a row, so they do not emit
/// a duplicate "source added" audit either. The Node-side handler
/// applies the same gate to `KchatChannelLinked`.
#[napi]
pub fn bridge_add_kchat_channel(
    cache_dir: String,
) -> napi::Result<sources::KchatChannelAddOutcomeInfo> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let outcome = sources::add_kchat_channel(&mgr, &cache_dir)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let newly_created = outcome.newly_created;
    // Audit AFTER the add commits — same phantom-row prevention
    // discipline as `bridge_add_local_folder`. Skipped on re-sync so
    // the audit log doesn't accumulate one "source added" event per
    // re-sync of the same cache_dir.
    drop(mgr);
    if newly_created {
        if let Ok(logger) = s.audit_logger.lock() {
            let _ = logger.log_source_added(&cache_dir);
        }
    }
    Ok(outcome)
}

/// Returns whether a KChat source row exists for the given
/// `cache_dir`. Called by the Block B Task 2 WS forwarder on every
/// `file_added` event so a push for an unlinked channel never
/// triggers a download. Lookup is O(log n) on the
/// `idx_sources_type_path` composite index — cheap enough to call
/// once per push.
#[napi]
pub fn bridge_is_kchat_channel_linked(cache_dir: String) -> napi::Result<bool> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::is_kchat_channel_linked(&mgr, &cache_dir)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Targeted single-file index for a KChat-channel source.
///
/// Called by the Block B Task 2 WS forwarder after it has
/// downloaded the bytes referenced by a `file_added` event into
/// the channel cache directory. The substrate side re-applies
/// path-traversal containment on `file_basename` as
/// defence-in-depth — the Node side also sanitises with
/// `path.basename(...)`, but a regression in either layer would
/// otherwise let a malicious server-supplied name escape the
/// cache root.
///
/// The returned outcome's `was_linked && indexed` AND condition
/// is what the forwarder records as the `triggered_reindex` flag
/// on the `KchatFileEventReceived` audit row, so the audit log
/// accurately reflects whether THIS event drove indexer work
/// (vs. arriving for a channel that's not linked, or for a file
/// a concurrent full sync had already indexed).
#[napi]
pub fn bridge_index_kchat_file(
    cache_dir: String,
    file_basename: String,
) -> napi::Result<sources::KchatFileIndexOutcomeInfo> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::index_kchat_file(&mgr, &cache_dir, &file_basename)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Refresh a KChat channel's ACL roster + project status onto the
/// source row.
///
/// Called by the Node-side `KchatEventForwarder` after every
/// membership-change event (`user_added`, `user_removed`,
/// `channel_updated`) with the authoritative roster fetched from
/// `GET /channels/{id}/members`. See
/// `SourceManager::refresh_kchat_acl` for the full status
/// projection rules; the napi layer is a thin pass-through that
/// converts the typed outcome enum into the JS-facing string +
/// summary fields.
#[napi]
pub fn bridge_refresh_kchat_acl(
    cache_dir: String,
    members: Vec<sources::KchatAclMemberInfo>,
) -> napi::Result<sources::KchatAclRefreshOutcomeInfo> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::refresh_kchat_acl(&mgr, &cache_dir, &members)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Explicitly revoke a KChat-channel source. Used for
/// `channel_archived` / `channel_deleted` / self-`user_removed`
/// events.
#[napi]
pub fn bridge_revoke_kchat_source(
    cache_dir: String,
) -> napi::Result<sources::KchatRevokeOutcomeInfo> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::revoke_kchat_source(&mgr, &cache_dir)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Set the locally-authenticated KChat principal user id on the
/// substrate. Called by the Node-side `kchat:connect` IPC handler
/// after the `/users/me` probe succeeds. The substrate persists
/// the id in a singleton row so subsequent `refresh_kchat_acl`
/// calls can check membership without re-threading the id
/// through every event.
#[napi]
pub fn bridge_set_kchat_principal(user_id: String) -> napi::Result<()> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::set_kchat_principal(&mgr, &user_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Clear the persisted KChat principal on `kchat:disconnect`.
#[napi]
pub fn bridge_clear_kchat_principal() -> napi::Result<()> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::clear_kchat_principal(&mgr).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: returns every registered source.
pub fn bridge_list_sources() -> napi::Result<Vec<sources::SourceInfo>> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::list_sources(&mgr).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: removes a source and its indexed data,
/// emitting a `SourceRemoved` audit row.
pub fn bridge_remove_source(source_id: String) -> napi::Result<()> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::remove_source(&mgr, &source_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    // Audit AFTER the remove commits (pattern B). A failed remove
    // (bad source_id, FK constraint, lock contention) must not
    // leave a phantom "SourceRemoved" row claiming the source was
    // removed when it still exists in the source table.
    drop(mgr);
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_source_removed(&source_id);
    }
    Ok(())
}

// -- sync-failure persistence napi exports ------------
//
// The TS-side `runConnectorSync` calls these three functions in
// the failure / success paths to durably persist a source's
// `last_sync_error` + `retry_count` + `failed_permanently`
// columns. The actual retry-and-backoff policy (when to flip
// "permanent", how long to wait between retries) is computed in
// TS (`connectorBackoff.ts`) so the connectors layer remains the
// single classification authority — this bridge surface is pure
// CRUD.

/// JS-facing shape mirroring `SourceStore::get_sync_failure_state`'s
/// `(Option<String>, u32, bool)` tuple. Returned to the renderer
/// (and to the TS connector orchestrator) as a structured object
/// so the call site cannot transpose the fields.
#[napi(object)]
pub struct SourceSyncFailureStateView {
    /// JSON-serialised `PersistedSyncError` (`{"kind": ...,
    /// "message": ...}`) or `None` when the source has never
    /// failed.
    pub last_error_json: Option<String>,
    /// Consecutive transient failures since the last successful
    /// sync. Reset to 0 on success.
    pub retry_count: u32,
    /// Sticky bit set when a Permanent-classified failure is
    /// observed OR when `retry_count` exceeds the policy
    /// threshold. Only cleared by a successful sync.
    pub failed_permanently: bool,
}

#[napi]
/// Bridge get source sync failure state.
pub fn bridge_get_source_sync_failure_state(
    source_id: String,
) -> napi::Result<SourceSyncFailureStateView> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let (last_error_json, retry_count, failed_permanently) =
        sources::get_source_sync_failure_state(&mgr, &source_id)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(SourceSyncFailureStateView {
        last_error_json,
        retry_count,
        failed_permanently,
    })
}

#[napi]
/// Bridge record source sync failure.
pub fn bridge_record_source_sync_failure(
    source_id: String,
    last_sync_error_json: String,
    retry_count: u32,
    failed_permanently: bool,
) -> napi::Result<()> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::record_source_sync_failure(
        &mgr,
        &source_id,
        &last_sync_error_json,
        retry_count,
        failed_permanently,
    )
    .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// Bridge record source sync success.
pub fn bridge_record_source_sync_success(source_id: String) -> napi::Result<()> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::record_source_sync_success(&mgr, &source_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: hybrid-searches file sources for the query.
pub fn bridge_search_sources(
    query: String,
    limit: u32,
) -> napi::Result<Vec<sources::SearchHitInfo>> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::search_sources(&mgr, &query, limit as usize)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// query the KChat-post FTS5 index for
/// chat-body chunks that match `query`. The Node-side
/// `kchat:searchPosts` IPC handler maps the returned shape
/// (which carries channel id, post id, sender id, timestamps)
/// into a renderer-facing structure that includes a
/// `kchat://<server>/channel/<channel_id>/post/<post_id>`
/// permalink — the IPC layer composes the URL because the
/// substrate does not know the server URL, only kchat-auth does.
#[napi]
pub fn bridge_search_kchat_posts(
    query: String,
    limit: u32,
) -> napi::Result<Vec<sources::KchatPostSearchHitInfo>> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::search_kchat_posts(&mgr, &query, limit as usize)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// fetch thread context for a search
/// hit whose `root_id` is non-null. The Node-side
/// `kchat:fetchThreadContext` IPC handler calls this after a
/// `kchat:searchPosts` row was selected by the user; the result
/// is a chronologically-ordered transcript of up to 3 parent
/// messages (the thread root + up to 2 most-recent earlier
/// replies). Returns an empty vec for top-level posts, unknown
/// post ids, and revoked sources (see
/// [`tessera_sources::manager::SourceManager::fetch_kchat_thread_context`]
/// for the full taxonomy).
#[napi]
pub fn bridge_fetch_kchat_thread_context(
    source_id: String,
    post_id: String,
) -> napi::Result<Vec<sources::KchatThreadContextMessageInfo>> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::fetch_kchat_thread_context(&mgr, &source_id, &post_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: returns a source plus its indexed files.
pub fn bridge_get_source_detail(source_id: String) -> napi::Result<sources::SourceDetailInfo> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::get_source_detail(&mgr, &source_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: re-runs indexing for a source and returns
/// its refreshed info.
pub fn bridge_reindex_source(source_id: String) -> napi::Result<sources::SourceInfo> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let info = sources::reindex_source(&mgr, &source_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    // Audit AFTER the reindex commits (matches the contract for
    // `bridge_add_citation` below): a failed reindex must not
    // leave a phantom row claiming the source was reindexed. This
    // uses the sequential non-overlapping acquisition pattern
    // (pattern B in the file-level comment): per-store lock is
    // explicitly dropped BEFORE the audit logger lock is acquired,
    // so the two locks are never held simultaneously and the
    // operation can't be rolled back by a failed audit append.
    drop(mgr);
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_source_reindexed(&source_id);
    }
    Ok(info)
}

/// Returns the latest indexing progress snapshot. Safe to poll on
/// a short interval — see [`tessera_sources::progress`] for the
/// lifecycle semantics.
#[napi]
pub fn bridge_get_indexing_progress(
    source_id: String,
) -> napi::Result<sources::IndexingProgressInfo> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::get_indexing_progress(&mgr, &source_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// `napi::Task` that runs `backfill_embeddings_tracked` on a libuv
/// worker thread instead of the Node main thread. The whole point
/// of running off-main is that the JS event loop stays responsive
/// during a long backfill — in particular, `bridge_get_embedding_progress`
/// polls scheduled by the renderer's `useEmbeddingProgress` hook
/// must actually be served while the worker thread is locking the
/// `SourceManager` mutex.
///
/// That's why the progress polls (see `bridge_get_embedding_progress`
/// below) read from `AppState.embedding_progress` directly rather
/// than re-locking the source manager: the worker thread holds the
/// outer manager lock for the duration of the backfill, but the
/// inner `EmbeddingProgressTracker` has its own mutex so concurrent
/// reads return the in-flight counters in microseconds.
pub struct BackfillEmbeddingsTask {
    batch_size: Option<u32>,
}

impl Task for BackfillEmbeddingsTask {
    type Output = sources::BackfillEmbeddingsResult;
    type JsValue = sources::BackfillEmbeddingsResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        // `state()` returns `&'static AppState`, which is `Send`
        // because every field is either `Sync` (the mutexes), `Send`
        // (the cloned `Arc`), or owned `String`. The worker thread
        // can safely lock the source manager here without
        // contending with main-thread napi callbacks for the same
        // physical SQLite connection — the inner per-connection
        // mutex serialises writes, exactly as the synchronous code
        // path did.
        let s = state()?;
        let mgr = s
            .source_manager
            .lock()
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        sources::backfill_embeddings(&mgr, self.batch_size)
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// Triggers an embedding backfill pass over every chunk that doesn't
/// yet have an embedding for the active provider's model. Returns
/// the number of newly-embedded chunks and a snapshot of the
/// progress tracker (so the renderer doesn't need an extra round
/// trip to render the final state).
///
/// Pass `None` for `batch_size` to use the bridge-default; the
/// renderer doesn't need to know the value. Idempotent — a second
/// call against an up-to-date index reports `embedded=0`.
///
/// **Async**: returns a `Promise` from JS. The heavy DB / embedding
/// work runs on a libuv worker thread (Node's built-in thread pool)
/// so the JS event loop stays free to serve `getEmbeddingProgress`
/// polls from the renderer's progress UI.
///
/// **Pre-flight tracker reset (race fix)**: before constructing the
/// `AsyncTask`, this function calls `embedding_progress.mark_starting()`
/// *on the JS main thread*. The point is to flip the snapshot to
/// `Running` BEFORE the renderer can issue its first
/// `bridge_get_embedding_progress` poll. Without this, the worker
/// thread's `backfill_embeddings_tracked → tracker.start()` call would
/// race with the renderer's polling loop: a poll arriving before the
/// worker had acquired the `SourceManager` lock would see the previous
/// run's terminal status (`Done`/`Failed`), and the React hook would
/// treat that as "this backfill already finished" and stop polling —
/// meaning the user never sees any in-flight progress for the new
/// pass. By eagerly resetting the snapshot synchronously here, every
/// observable poll for the new generation sees `Running` from the
/// outset. The worker thread's subsequent `start(total, model)` call
/// inside `compute()` overwrites `total_chunks` / `model_id` with the
/// real numbers once it has computed them.
///
/// **IPC ordering invariant (why pre-flight reset is sufficient)**:
/// Electron's IPC layer processes messages from a given renderer
/// channel strictly in-order on the main process. The renderer's
/// `sources:backfillEmbeddings` IPC arrives BEFORE any subsequent
/// `sources:getEmbeddingProgress` IPC issued by the same renderer
/// because both go through the same `ipcMain.handle` queue in the
/// same WebContents. So `mark_starting()` (synchronous, on the main
/// thread, before this function returns the `AsyncTask`) is
/// guaranteed to complete before the renderer's first poll for the
/// new generation is dispatched. The `AsyncTask::resolve` value
/// (the `Promise` we hand back to JS) is awaited by the IPC handler
/// in `ipc/sources.ts`, but the actual `compute()` body — which
/// flips status back to `Running` with real counters and then
/// drains the backfill loop — runs on a libuv worker thread that
/// can race the renderer's polling. That's exactly the race the
/// pre-flight `mark_starting()` defuses: it guarantees the
/// renderer's first observable poll sees `Running` with zeroed
/// counters instead of the previous generation's stale terminal
/// state, regardless of which thread wins the lock race after.
#[napi]
pub fn bridge_backfill_embeddings(
    batch_size: Option<u32>,
) -> napi::Result<AsyncTask<BackfillEmbeddingsTask>> {
    let s = state()?;
    s.embedding_progress.mark_starting();
    Ok(AsyncTask::new(BackfillEmbeddingsTask { batch_size }))
}

/// Lightweight poll for the renderer. Always returns the latest
/// snapshot of the embedding-progress tracker — `status=Done` plus
/// the final counters are what the renderer uses to dismiss the
/// progress banner after a `bridge_backfill_embeddings` call.
///
/// Reads from `AppState.embedding_progress` directly so the call
/// stays cheap even while a `BackfillEmbeddingsTask` is holding the
/// `source_manager` mutex on a worker thread.
#[napi]
pub fn bridge_get_embedding_progress() -> napi::Result<sources::EmbeddingProgressInfo> {
    let s = state()?;
    Ok(sources::get_embedding_progress_from_tracker(
        &s.embedding_progress,
    ))
}

/// Returns the current effective hybrid retrieval config so the
/// renderer's Settings page can populate its initial form state.
#[napi]
pub fn bridge_get_hybrid_search_config() -> napi::Result<sources::HybridSearchConfigInfo> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::get_hybrid_search_config(&mgr).map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Apply a partial-update patch to the hybrid retrieval config.
/// Returns the new effective config so the renderer can echo it
/// back into its form state (e.g. to display the clamped value if
/// validation rounded something). Validation errors surface as
/// `napi::Error` so the renderer can show them inline next to the
/// offending field.
#[napi]
pub fn bridge_update_hybrid_search_config(
    update: sources::HybridSearchConfigUpdate,
) -> napi::Result<sources::HybridSearchConfigInfo> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::update_hybrid_search_config(&mgr, update)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

// =====================================================================
// ONNX embedding-model management exports.
//
// Four exports mirror the four IPC channels in
// `apps/desktop/electron/ipc/settings.ts`:
//   * `bridge_get_embedding_model_status` — list models + download/loaded status
//   * `bridge_download_embedding_model` — async download with progress polling
//   * `bridge_get_embedding_download_progress` — lightweight progress poll
//   * `bridge_switch_embedding_model` — synchronous swap of the live embedder
//
// The download is the only async path; switching is intentionally
// synchronous (a few hundred ms to load the ONNX session) so the
// renderer can chain "switch → backfill_embeddings" in a single
// `await` without waking up an extra worker thread.
// =====================================================================

/// Snapshot of available embedding models + the bridge's current
/// download/active state. Single round-trip so the Settings UI
/// renders in one frame. `user_data_dir` is the app's userData
/// path (e.g. Electron's `app.getPath("userData")`); the registry
/// stores models under `{user_data_dir}/models/onnx/{slug}/`.
#[napi]
pub fn bridge_get_embedding_model_status(
    user_data_dir: String,
) -> napi::Result<sources::EmbeddingModelStatusInfo> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::get_embedding_model_status(&mgr, &s.download_progress, &user_data_dir)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// `napi::Task` that downloads the ONNX model + tokenizer for `slug`
/// on a libuv worker thread.
///
/// The IPC layer awaits the resulting Promise, but the renderer can
/// (and does) poll `bridge_get_embedding_download_progress`
/// concurrently on a 500 ms timer to render the progress bar. The
/// download `AsyncTask` does NOT hold the `SourceManager` mutex —
/// downloads are pure filesystem + network work that doesn't touch
/// the DB — so the renderer's other IPCs (search, list_sources,
/// etc.) keep working at full speed while a 120 MB model
/// downloads.
///
/// On success the tracker is flipped to `done`. On failure the
/// tracker is flipped to `failed` with the error message attached.
/// Either way the Promise also resolves / rejects so an `await` on
/// the JS side gets the result without polling.
pub struct DownloadEmbeddingModelTask {
    slug: String,
    user_data_dir: String,
    tracker: Arc<sources::DownloadProgressTracker>,
}

impl Task for DownloadEmbeddingModelTask {
    type Output = sources::EmbeddingModelInfo;
    type JsValue = sources::EmbeddingModelInfo;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let slug = self.slug.clone();
        let user_data_dir = self.user_data_dir.clone();
        let tracker = Arc::clone(&self.tracker);

        // The registry's `download_model` is async (it uses
        // streaming `reqwest`). napi `Task::compute` runs
        // synchronously on a worker thread, so we spin up a
        // current-thread tokio runtime here. A current-thread
        // runtime is correct because the registry function only
        // spawns its own work via `await` on the request future —
        // there's no need for the multi-thread runtime's worker
        // pool overhead.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| napi::Error::from_reason(format!("tokio runtime build: {e}")))?;

        let install_dir_result = rt.block_on(sources::download_embedding_model(
            &slug,
            &user_data_dir,
            Arc::clone(&tracker),
        ));

        match install_dir_result {
            Ok(_install_dir) => {
                tracker.mark_done();
                let mgr = state()?
                    .source_manager
                    .lock()
                    .map_err(|e| napi::Error::from_reason(e.to_string()))?;
                sources::get_embedding_model_status(&mgr, &tracker, &user_data_dir)
                    .map(|status| {
                        status
                            .models
                            .into_iter()
                            .find(|m| m.slug == slug)
                            .unwrap_or(sources::EmbeddingModelInfo {
                                slug,
                                display_name: String::new(),
                                dim: 0,
                                model_size_bytes: 0.0,
                                tokenizer_size_bytes: 0.0,
                                languages: String::new(),
                                installed: false,
                                model_id: String::new(),
                            })
                    })
                    .map_err(|e| napi::Error::from_reason(e.to_string()))
            }
            Err(e) => {
                let msg = e.to_string();
                tracker.mark_failed(&msg);
                Err(napi::Error::from_reason(msg))
            }
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// Trigger an ONNX embedding-model download. Returns a Promise
/// that resolves with the final [`sources::EmbeddingModelInfo`]
/// (with `installed=true` and the canonical `model_id` filled in)
/// or rejects with the download error.
///
/// The pre-flight `mark_starting(&slug)` flips the tracker to
/// `downloading` synchronously on the JS main thread so the
/// renderer's first progress poll for this download cannot see
/// the previous run's terminal state. Same race-defusing pattern
/// as `bridge_backfill_embeddings`.
#[napi]
pub fn bridge_download_embedding_model(
    slug: String,
    user_data_dir: String,
) -> napi::Result<AsyncTask<DownloadEmbeddingModelTask>> {
    let s = state()?;
    s.download_progress.mark_starting(&slug);
    Ok(AsyncTask::new(DownloadEmbeddingModelTask {
        slug,
        user_data_dir,
        tracker: Arc::clone(&s.download_progress),
    }))
}

/// Lightweight progress poll for in-flight ONNX model downloads.
/// Mirrors `bridge_get_embedding_progress` — bypasses the
/// `source_manager` lock so the renderer's progress bar updates
/// at full timer cadence regardless of what else is going on.
#[napi]
pub fn bridge_get_embedding_download_progress() -> napi::Result<sources::DownloadProgressInfo> {
    let s = state()?;
    Ok(s.download_progress.snapshot())
}

/// Synchronously swap the active embedder to a downloaded ONNX
/// model. Returns the freshly-loaded model's catalogue entry so
/// the renderer can echo it back as the new "current" badge.
///
/// Does NOT trigger a re-embed pass — that's the renderer's
/// responsibility (it'll typically call
/// `bridge_backfill_embeddings` immediately after) so the
/// progress UI can show the backfill bar without the bridge
/// having to invent a synthetic combined progress payload.
#[napi]
pub fn bridge_switch_embedding_model(
    slug: String,
    user_data_dir: String,
) -> napi::Result<sources::EmbeddingModelInfo> {
    let s = state()?;
    let mut mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::switch_embedding_model(&mut mgr, &user_data_dir, &slug)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

// --- Artifacts ---

#[napi]
/// N-API entry point: creates a new artifact and returns it.
pub fn bridge_create_artifact(
    title: String,
    artifact_type: String,
    template_id: Option<String>,
) -> napi::Result<artifacts::ArtifactInfo> {
    let s = state()?;
    let mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let info = artifacts::create_artifact(&mgr, &title, &artifact_type, template_id.as_deref())
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    // Audit AFTER the artifact has been persisted so a failed
    // create (e.g. invalid template id, lock contention) doesn't
    // leave a phantom "created" row. Matches the contract for
    // every other artifact lifecycle event in this file.
    drop(mgr);
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_artifact_created(&title);
    }
    Ok(info)
}

#[napi]
/// N-API entry point: replaces an artifact's content, creating a
/// new version.
pub fn bridge_update_artifact_content(
    artifact_id: String,
    content: String,
) -> napi::Result<artifacts::ArtifactInfo> {
    let s = state()?;
    let mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let info = artifacts::update_artifact_content(&mgr, &artifact_id, &content)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    // Audit AFTER the update commits to avoid phantom rows on
    // failed updates (e.g. bad UUID, lock contention).
    drop(mgr);
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_artifact_updated(&artifact_id);
    }
    Ok(info)
}

#[napi]
/// N-API entry point: fetches a single artifact by id.
pub fn bridge_get_artifact(artifact_id: String) -> napi::Result<artifacts::ArtifactInfo> {
    let s = state()?;
    let mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    artifacts::get_artifact(&mgr, &artifact_id).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: lists all artifacts.
pub fn bridge_list_artifacts() -> napi::Result<Vec<artifacts::ArtifactInfo>> {
    let s = state()?;
    let mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    artifacts::list_artifacts(&mgr).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: deletes an artifact by id.
pub fn bridge_delete_artifact(artifact_id: String) -> napi::Result<()> {
    let s = state()?;
    let mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    artifacts::delete_artifact(&mgr, &artifact_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    // Audit AFTER the delete commits — a failed delete (e.g. bad
    // UUID, FK constraint, lock contention) must not leave a
    // phantom row claiming the artifact was deleted.
    drop(mgr);
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_artifact_deleted(&artifact_id);
    }
    Ok(())
}

// --- Export ---

/// Exports an artifact to the given format.
///
/// `include_citations` defaults to `true` (existing behaviour) when
/// the JS caller passes `null` or omits it. Callers that want a
/// citation-free export must pass `false` explicitly.
#[napi]
pub fn bridge_export_artifact(
    artifact_id: String,
    format: String,
    content_override: Option<String>,
    include_citations: Option<bool>,
) -> napi::Result<exporter::ExportResult> {
    let s = state()?;
    let art_mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let tracker = s
        .citation_tracker
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let result = exporter::export_artifact(
        &art_mgr,
        &tracker,
        &artifact_id,
        &format,
        content_override.as_deref(),
        include_citations.unwrap_or(true),
    )
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    // Audit-after-action (sequential non-overlapping pattern B): a
    // failed export (missing artifact, missing citation, format
    // unsupported, content_override invalid) must not leave a
    // phantom row claiming the artifact was exported. Drop the
    // per-store locks first so the audit logger lock is acquired
    // after they release.
    drop(tracker);
    drop(art_mgr);
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_artifact_exported(&artifact_id, &format);
    }
    Ok(result)
}

/// Binary-aware variant of [`bridge_export_artifact`]. Same
/// `include_citations` default semantics — `None`/null/omitted means
/// citations are included (back-compat).
#[napi]
pub fn bridge_export_artifact_to_file(
    artifact_id: String,
    format: String,
    path: String,
    content_override: Option<String>,
    include_citations: Option<bool>,
) -> napi::Result<()> {
    let s = state()?;
    let art_mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let tracker = s
        .citation_tracker
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    exporter::export_artifact_to_file(
        &art_mgr,
        &tracker,
        &artifact_id,
        &format,
        &path,
        content_override.as_deref(),
        include_citations.unwrap_or(true),
    )
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    // Audit AFTER the export commits to disk so a failed write
    // (permission denied, path-safety violation, format
    // unsupported) never produces a phantom row claiming the
    // artifact was exported. Per-store locks are dropped first
    // (sequential non-overlapping acquisition; pattern B in the
    // file-level comment) so the audit logger lock and the
    // per-store locks are never held simultaneously.
    drop(tracker);
    drop(art_mgr);
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_artifact_exported(&artifact_id, &format);
    }
    Ok(())
}

// --- Templates ---

#[napi]
/// N-API entry point: lists all registered templates.
pub fn bridge_list_templates() -> napi::Result<Vec<templates::TemplateInfo>> {
    let s = state()?;
    // route every parse / validation failure
    // encountered while walking `template_dir` into the audit log
    // so a packaged-build operator can find templates that were
    // silently dropped from the list — `eprintln!` alone goes to
    // the Electron main process's stderr, which a user has no UI
    // to read. We swallow the audit-logger lock-poison case (mirrors
    // every other audit call site here) and fall through to the
    // non-audit variant; the registry walk itself still produces
    // its stderr surface for the operator.
    if let Ok(logger) = s.audit_logger.lock() {
        return templates::list_templates_with_audit(&s.template_dir, &logger)
            .map_err(|e| napi::Error::from_reason(e.to_string()));
    }
    templates::list_templates(&s.template_dir).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: fetches a single template by id.
pub fn bridge_get_template(template_id: String) -> napi::Result<Option<templates::TemplateInfo>> {
    let s = state()?;
    // Same audit posture as `bridge_list_templates`: a validation
    // failure on lookup is mapped to `Ok(None)` for back-compat,
    // which means the only surface the operator has to discover the
    // dropped template is the audit row. Falls back to the
    // non-audit variant if the audit logger is poisoned.
    if let Ok(logger) = s.audit_logger.lock() {
        return templates::get_template_with_audit(&s.template_dir, &template_id, &logger)
            .map_err(|e| napi::Error::from_reason(e.to_string()));
    }
    templates::get_template(&s.template_dir, &template_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

// --- Citations ---

#[napi]
/// N-API entry point: lists citations for an artifact.
pub fn bridge_list_citations(artifact_id: String) -> napi::Result<Vec<citations::CitationInfo>> {
    let s = state()?;
    let tracker = s
        .citation_tracker
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    citations::list_citations(&tracker, &artifact_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: attaches a citation to an artifact.
pub fn bridge_add_citation(
    req: citations::AddCitationRequest,
) -> napi::Result<citations::CitationInfo> {
    let s = state()?;
    // Parse artifact_id before locking to validate early
    let artifact_uuid = uuid::Uuid::parse_str(&req.artifact_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    // Capture the citation arguments needed for the audit log before
    // `req` is moved into `add_citation` below. The audit call itself
    // happens AFTER the citation has been persisted so we don't log
    // failed adds (mirroring the contract for replace/remove which
    // also log on success only).
    let artifact_id_for_audit = req.artifact_id.clone();
    let source_uri_for_audit = req.source_uri.clone();
    let src_mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let art_mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut tracker = s
        .citation_tracker
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let info = citations::add_citation(&mut tracker, &src_mgr, req)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    // Persist citation ID to the artifact's record so citationCount is accurate
    let cid = uuid::Uuid::parse_str(&info.citation_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    art_mgr
        .add_citation(
            &tessera_core::ArtifactId(artifact_uuid),
            tessera_core::CitationId(cid),
        )
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    // Drop the per-store locks BEFORE acquiring the audit logger
    // (sequential non-overlapping acquisition; pattern B in the
    // file-level comment). The two locks are never held
    // simultaneously, so the user-visible citation persists even
    // if the audit append fails afterwards, and the audit row is
    // gated on the citation having actually been written.
    drop(tracker);
    drop(art_mgr);
    drop(src_mgr);
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_citation_added(
            &artifact_id_for_audit,
            &info.citation_id,
            &source_uri_for_audit,
        );
    }
    Ok(info)
}

#[napi]
/// N-API entry point: detaches a citation from an artifact.
pub fn bridge_remove_citation(artifact_id: String, citation_id: String) -> napi::Result<()> {
    let s = state()?;
    let mut tracker = s
        .citation_tracker
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    citations::remove_citation(&mut tracker, &artifact_id, &citation_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    // Audit-after-action (sequential non-overlapping pattern B):
    // a failed remove (bad citation_id, FK constraint, lock
    // contention) must not leave a phantom row claiming the
    // citation was removed. Drop the per-store lock first so the
    // audit logger lock is acquired after it releases.
    drop(tracker);
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_citation_removed(&artifact_id, &citation_id);
    }
    Ok(())
}

#[napi]
/// N-API entry point: reports whether a cited source has changed
/// since the citation was captured.
pub fn bridge_check_source_changed(citation_id: String) -> napi::Result<bool> {
    let s = state()?;
    // Acquire source_manager (lock 2) before citation_tracker (lock 4) per documented ordering
    let src_mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let tracker = s
        .citation_tracker
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    citations::check_source_changed(&tracker, &src_mgr, &citation_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: recomputes a citation's freshness against
/// the current source state.
pub fn bridge_check_citation_freshness(citation_id: String) -> napi::Result<String> {
    let s = state()?;
    let src_mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let tracker = s
        .citation_tracker
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let status = citations::check_source_freshness(&tracker, &src_mgr, &citation_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(status.as_str().to_string())
}

#[napi]
/// N-API entry point: swaps a citation's target for an updated
/// source snapshot.
pub fn bridge_replace_citation(
    req: citations::ReplaceCitationRequest,
) -> napi::Result<citations::ReplaceCitationResult> {
    let s = state()?;
    let artifact_id = req.artifact_id.clone();
    let citation_id = req.citation_id.clone();
    let new_source_uri = req.source_uri.clone();
    let result = {
        // Scoped lock acquisition matches the documented order:
        // audit_logger lock is taken after replace returns so we can
        // log the real previous URI captured by the bridge call.
        let src_mgr = s
            .source_manager
            .lock()
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let mut tracker = s
            .citation_tracker
            .lock()
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        citations::replace_citation(&mut tracker, &src_mgr, req)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?
    };
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_citation_replaced(
            &artifact_id,
            &citation_id,
            &result.previous_source_uri,
            &new_source_uri,
        );
    }
    Ok(result)
}

// --- Version History ---

#[napi]
/// N-API entry point: lists an artifact's version history.
pub fn bridge_list_versions(
    artifact_id: String,
) -> napi::Result<Vec<artifacts::ArtifactVersionInfo>> {
    let s = state()?;
    let mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let uuid =
        uuid::Uuid::parse_str(&artifact_id).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let aid = tessera_core::ArtifactId(uuid);
    let versions = mgr
        .list_versions(&aid)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(versions
        .into_iter()
        .map(|v| artifacts::ArtifactVersionInfo {
            version: v.version_number,
            content: v.content_snapshot,
            created_at: v.created_at,
        })
        .collect())
}

#[napi]
/// N-API entry point: restores an artifact to a prior version.
pub fn bridge_restore_version(
    artifact_id: String,
    version_number: u32,
) -> napi::Result<artifacts::ArtifactInfo> {
    let s = state()?;
    let mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let uuid =
        uuid::Uuid::parse_str(&artifact_id).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let aid = tessera_core::ArtifactId(uuid);
    let restored = mgr
        .restore_version(&aid, version_number)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let info = artifacts::artifact_to_info(&restored);
    // Audit AFTER the restore commits. Version restore is
    // semantically an artifact update — the content snapshot at
    // `version_number` is rewritten into the canonical artifact
    // row. Audit it as `ArtifactUpdated` so a future compliance
    // review sees the lineage ("this artifact was rolled back at
    // <time>") rather than a silent overwrite. Logging AFTER the
    // restore (rather than before) ensures a failed restore (bad
    // UUID, missing version, lock contention) never produces a
    // phantom rollback row.
    drop(mgr);
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_artifact_updated(&artifact_id);
    }
    Ok(info)
}

// --- Artifact Generation ---

#[napi]
/// N-API entry point: generates a new artifact from a template
/// and its source bindings.
pub fn bridge_generate_from_template(
    template_id: String,
    source_ids: Vec<String>,
) -> napi::Result<artifacts::ArtifactInfo> {
    let s = state()?;
    let src_mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let art_mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let template = tessera_templates::parser::load_template_by_id(&s.template_dir, &template_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let selected_source_set: std::collections::HashSet<String> = source_ids.into_iter().collect();

    let mut section_contents = Vec::new();
    for section in &template.sections {
        let hits = src_mgr
            .search_broad(&section.prompt, 20)
            .unwrap_or_default();
        let filtered: Vec<_> = if selected_source_set.is_empty() {
            hits.into_iter().take(5).collect()
        } else {
            hits.into_iter()
                .filter(|h| selected_source_set.contains(&h.source_id))
                .take(5)
                .collect()
        };
        let context: String = filtered
            .iter()
            .map(|h| h.content.as_str())
            .collect::<Vec<_>>()
            .join("\n\n---\n\n");
        let content = if context.is_empty() {
            format!(
                "## {}\n\n*No source material found for this section.*\n",
                section.title
            )
        } else {
            format!("## {}\n\n{}\n", section.title, context)
        };
        section_contents.push(content);
    }

    let template_name = template.name.clone();
    let full_content = section_contents.join("\n");
    let atype = template.artifact_type;
    let tid = tessera_core::TemplateId::from_string(&template_id);
    let art = art_mgr
        .create(template_name.clone(), atype, Some(tid))
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    art_mgr
        .update_content(&art.id, full_content)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let updated = art_mgr
        .get(&art.id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    drop(src_mgr);
    drop(art_mgr);
    let audit = s
        .audit_logger
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let _ = audit.log_artifact_created(&template_name);
    drop(audit);

    Ok(artifacts::artifact_to_info(&updated))
}

#[napi]
/// N-API entry point: extracts tasks and decisions from a source's
/// text.
pub fn bridge_extract_tasks_decisions(source_id: String) -> napi::Result<String> {
    let s = state()?;
    let src_mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let source_uuid =
        uuid::Uuid::parse_str(&source_id).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let sid = tessera_core::SourceId(source_uuid);

    let chunks = src_mgr.get_chunks_for_source(&sid).unwrap_or_default();

    let items = tessera_artifacts::extraction::extract_tasks_decisions(&chunks, &source_id);

    serde_json::to_string(&items).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: computes a structured comparison between two
/// sources.
pub fn bridge_compare_sources(
    source_id_a: String,
    source_id_b: String,
) -> napi::Result<artifacts::CompareSourcesResult> {
    let s = state()?;
    let src_mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let art_mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let uuid_a =
        uuid::Uuid::parse_str(&source_id_a).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let uuid_b =
        uuid::Uuid::parse_str(&source_id_b).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let sid_a = tessera_core::SourceId(uuid_a);
    let sid_b = tessera_core::SourceId(uuid_b);

    // Resolve source labels bridge-side so the renderer doesn't
    // have to round-trip a second IPC to look them up. Falls back
    // to "Source A" / "Source B" if a source has been deleted
    // between the time the user picked them and the time the
    // comparison ran — preserving the legacy markdown label so
    // anyone diffing artifacts from before/after this refactor
    // doesn't see a content shift.
    // Resolve paths for both sources first so we can disambiguate
    // the labels when both sources share the same last path segment
    // (e.g. `/home/alice/docs` vs `/home/bob/docs`). `disambiguate_labels`
    // escalates from 1-segment to 4-segment labels until the two
    // are distinct, falling back to the full path only for fully
    // prefix-identical sources (which are pathological in practice).
    let path_a = src_mgr.get_source(&sid_a).ok().map(|src| src.path.clone());
    let path_b = src_mgr.get_source(&sid_b).ok().map(|src| src.path.clone());
    let (label_a, label_b) = match (path_a.as_deref(), path_b.as_deref()) {
        (Some(a), Some(b)) => disambiguate_labels(a, b),
        (Some(a), None) => (friendly_source_label(a), "Source B".to_string()),
        (None, Some(b)) => ("Source A".to_string(), friendly_source_label(b)),
        (None, None) => ("Source A".to_string(), "Source B".to_string()),
    };

    let chunks_a = src_mgr.get_chunks_for_source(&sid_a).unwrap_or_default();
    let chunks_b = src_mgr.get_chunks_for_source(&sid_b).unwrap_or_default();

    let result = tessera_artifacts::comparison::compare_sources(&chunks_a, &chunks_b);
    let content = result.to_markdown(&label_a, &label_b);

    let art = art_mgr
        .create(
            "Source Comparison".to_string(),
            tessera_core::ArtifactType::Document,
            None,
        )
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    art_mgr
        .update_content(&art.id, content)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let updated = art_mgr
        .get(&art.id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let info = artifacts::artifact_to_info(&updated);
    // Audit AFTER the comparison artifact has been persisted under
    // the same `ArtifactCreated` event type used by
    // `bridge_create_artifact` so reports counting created
    // artifacts don't undercount comparison results. Logging AFTER
    // ensures a failed comparison (chunk fetch error, content
    // generation panic, persist failure) never produces a phantom
    // "Source Comparison" audit row.
    drop(art_mgr);
    drop(src_mgr);
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_artifact_created("Source Comparison");
    }

    // Convert the Rust-side `ComparisonResult` into the napi-shaped
    // mirror. The truncation order (≤30 common, ≤20 unique each)
    // was already applied inside `compare_sources` so we just
    // collect here.
    let comparison = artifacts::ComparisonInfo {
        similarity_score: result.similarity_score,
        common_themes: result
            .common_themes
            .iter()
            .map(|t| artifacts::ThemeInfo {
                label: t.label.clone(),
                // `frequency` is `usize` on the Rust side; the napi
                // contract is `i32`. Saturate at `i32::MAX` instead
                // of wrapping so a pathologically large frequency
                // (would require ~2.1B chunks containing the same
                // phrase, which is impossible in practice) still
                // produces a sensible UI rendering instead of a
                // negative number.
                frequency: i32::try_from(t.frequency).unwrap_or(i32::MAX),
            })
            .collect(),
        unique_to_a: result
            .unique_to_a
            .iter()
            .map(|t| artifacts::ThemeInfo {
                label: t.label.clone(),
                frequency: i32::try_from(t.frequency).unwrap_or(i32::MAX),
            })
            .collect(),
        unique_to_b: result
            .unique_to_b
            .iter()
            .map(|t| artifacts::ThemeInfo {
                label: t.label.clone(),
                frequency: i32::try_from(t.frequency).unwrap_or(i32::MAX),
            })
            .collect(),
    };

    Ok(artifacts::CompareSourcesResult {
        artifact: info,
        comparison,
        label_a,
        label_b,
    })
}

/// Build a short human-readable label for a source path. Used by
/// `bridge_compare_sources` to render the two compared sources in
/// the modal heading and the rendered markdown without dumping a
/// full absolute path (which would push the rest of the modal
/// content off-screen on narrow viewports). Falls back to the
/// trimmed path if no separator is present (e.g. a connector URI
/// that is one logical segment).
fn friendly_source_label(path: &str) -> String {
    // Strip trailing slashes so a folder source path of
    // `/home/user/docs/` produces `docs`, not "".
    let trimmed = path.trim_end_matches(['/', '\\']);
    let last_segment = trimmed
        .rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or(trimmed);
    if last_segment.is_empty() {
        path.to_string()
    } else {
        last_segment.to_string()
    }
}

/// Like `friendly_source_label` but returns the LAST `n` non-empty
/// segments joined with `/`. Used by `disambiguate_labels` to
/// produce parent-qualified labels when two sources have the same
/// last segment (e.g. `/home/alice/docs` and `/home/bob/docs` would
/// both collapse to `docs` under `friendly_source_label`; this
/// returns `alice/docs` and `bob/docs` for n=2).
fn friendly_source_label_n(path: &str, n: usize) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    let mut segments: Vec<&str> = trimmed
        .rsplit(['/', '\\'])
        .filter(|s| !s.is_empty())
        .take(n)
        .collect();
    if segments.is_empty() {
        return path.to_string();
    }
    segments.reverse();
    segments.join("/")
}

/// Compute friendly labels for a pair of source paths, escalating
/// from 1-segment to 2-segment (or further) labels until the two
/// labels are distinct. Caps the escalation at 4 segments to avoid
/// dumping a full absolute path when sources are deeply nested in
/// the same prefix (e.g. `/a/b/c/d/docs` vs `/a/b/c/e/docs` — at
/// n=2 both become `d/docs` / `e/docs` which is enough to disambig).
/// If both paths are identical, returns `(label, "Source B")` so
/// the modal still renders two distinct labels.
fn disambiguate_labels(path_a: &str, path_b: &str) -> (String, String) {
    if path_a == path_b {
        // Pathological but possible if the user picks the same
        // source twice through different routes — preserve A/B
        // distinction in the UI so the modal isn't visually
        // identical on both sides.
        return (friendly_source_label(path_a), "Source B".to_string());
    }
    for n in 1..=4 {
        let label_a = friendly_source_label_n(path_a, n);
        let label_b = friendly_source_label_n(path_b, n);
        if label_a != label_b {
            return (label_a, label_b);
        }
    }
    // Fully prefix-identical paths up to 4 segments — fall back to
    // the full trimmed paths, which are guaranteed distinct because
    // we ruled out `path_a == path_b` above.
    (
        path_a.trim_end_matches(['/', '\\']).to_string(),
        path_b.trim_end_matches(['/', '\\']).to_string(),
    )
}

#[cfg(test)]
mod compare_label_tests {
    use super::{disambiguate_labels, friendly_source_label, friendly_source_label_n};

    #[test]
    fn friendly_source_label_strips_path_prefix() {
        assert_eq!(friendly_source_label("/home/user/docs"), "docs");
    }

    #[test]
    fn friendly_source_label_handles_trailing_slash() {
        assert_eq!(friendly_source_label("/home/user/docs/"), "docs");
    }

    #[test]
    fn friendly_source_label_handles_windows_backslash() {
        assert_eq!(friendly_source_label("C:\\Users\\user\\docs"), "docs");
    }

    #[test]
    fn friendly_source_label_falls_back_to_full_path_when_no_segments() {
        // Connector-style URIs that have no separator should pass
        // through intact so the user still sees a meaningful label.
        assert_eq!(friendly_source_label("notion://workspace"), "workspace");
        assert_eq!(friendly_source_label("standalone-name"), "standalone-name");
    }

    #[test]
    fn friendly_source_label_handles_root() {
        // Pathological case: nothing but separators. Fall back to
        // the original input rather than returning an empty string.
        assert_eq!(friendly_source_label("/"), "/");
    }

    #[test]
    fn friendly_source_label_n_returns_multi_segment() {
        assert_eq!(friendly_source_label_n("/home/alice/docs", 2), "alice/docs");
        assert_eq!(
            friendly_source_label_n("/home/alice/docs", 3),
            "home/alice/docs",
        );
        // Asking for more segments than the path has should just
        // return the whole trimmed path.
        assert_eq!(friendly_source_label_n("/docs", 4), "docs");
    }

    #[test]
    fn disambiguate_labels_uses_single_segment_when_distinct() {
        // Standard happy path — last segments are already distinct.
        assert_eq!(
            disambiguate_labels("/home/user/projects/alpha", "/home/user/projects/beta"),
            ("alpha".to_string(), "beta".to_string()),
        );
    }

    #[test]
    fn disambiguate_labels_escalates_to_two_segments_on_collision() {
        // Disambiguation regression: two sources sharing the same
        // last segment should produce parent-qualified labels so the
        // modal heading isn't "Comparison: docs vs docs".
        assert_eq!(
            disambiguate_labels("/home/alice/docs", "/home/bob/docs"),
            ("alice/docs".to_string(), "bob/docs".to_string()),
        );
    }

    #[test]
    fn disambiguate_labels_escalates_further_when_two_segments_also_collide() {
        // `/a/x/notes` vs `/b/x/notes` — at n=1 both are `notes`, at
        // n=2 both are `x/notes`, at n=3 they become `a/x/notes` /
        // `b/x/notes` which is enough to disambiguate.
        assert_eq!(
            disambiguate_labels("/a/x/notes", "/b/x/notes"),
            ("a/x/notes".to_string(), "b/x/notes".to_string()),
        );
    }

    #[test]
    fn disambiguate_labels_handles_identical_paths() {
        // The user picked the same source twice through different
        // routes. Preserve A/B distinction in the UI so the modal
        // sides are visually different.
        let (a, b) = disambiguate_labels("/home/user/docs", "/home/user/docs");
        assert_eq!(a, "docs");
        assert_eq!(b, "Source B");
    }

    #[test]
    fn disambiguate_labels_handles_windows_paths() {
        // Two Windows paths sharing the last segment.
        assert_eq!(
            disambiguate_labels("C:\\Users\\Alice\\docs", "C:\\Users\\Bob\\docs"),
            ("Alice/docs".to_string(), "Bob/docs".to_string()),
        );
    }
}

#[napi]
/// N-API entry point: exports an artifact and its citations as an
/// evidence pack.
pub fn bridge_export_evidence_pack(
    artifact_id: String,
    output_path: String,
) -> napi::Result<String> {
    let s = state()?;
    let art_mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let tracker = s
        .citation_tracker
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let uuid =
        uuid::Uuid::parse_str(&artifact_id).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let aid = tessera_core::ArtifactId(uuid);
    let artifact = art_mgr
        .get(&aid)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let citation_list = tracker.list_for_artifact(&aid).unwrap_or_default();

    let zip_path =
        tessera_export::evidence_pack::build_evidence_pack(&artifact, &citation_list, &output_path)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    // Audit AFTER the ZIP has been built and written. The evidence
    // pack is a ZIP export — record it under the shared
    // `ArtifactExported` event type so an auditor sees every form
    // of export (file format + evidence pack) in one query.
    // Logging AFTER ensures a failed pack build (missing artifact,
    // disk full, path-safety violation) never produces a phantom
    // export row.
    drop(tracker);
    drop(art_mgr);
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_artifact_exported(&artifact_id, "evidence_pack");
    }
    Ok(zip_path)
}

/// In-memory evidence-pack variant. Returns the ZIP bytes directly
/// so callers (specifically the KChat share path) can stream them
/// straight into an upload without staging on disk. The audit row
/// is still emitted because the bytes are about to leave the
/// Tessera process — keeping the on-disk and in-memory paths in
/// audit-parity is what lets the audit trail be the canonical
/// source of "what got exported where".
#[napi]
pub fn bridge_evidence_pack_bytes(artifact_id: String) -> napi::Result<Buffer> {
    let s = state()?;
    let art_mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let tracker = s
        .citation_tracker
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let uuid =
        uuid::Uuid::parse_str(&artifact_id).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let aid = tessera_core::ArtifactId(uuid);
    let artifact = art_mgr
        .get(&aid)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let citation_list = tracker.list_for_artifact(&aid).unwrap_or_default();

    let bytes = tessera_export::evidence_pack::evidence_pack_bytes(&artifact, &citation_list)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    drop(tracker);
    drop(art_mgr);
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_artifact_exported(&artifact_id, "evidence_pack");
    }
    Ok(Buffer::from(bytes))
}

// --- Tasks ---

#[napi]
/// N-API entry point: creates a task and returns it.
pub fn bridge_create_task(req_json: String) -> napi::Result<tasks::TaskInfo> {
    let req: tasks::CreateTaskRequest =
        serde_json::from_str(&req_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let s = state()?;
    let store = s
        .task_store
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    tasks::create_task(&store, req).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: lists tasks.
pub fn bridge_list_tasks() -> napi::Result<Vec<tasks::TaskInfo>> {
    let s = state()?;
    let store = s
        .task_store
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    tasks::list_tasks(&store).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: fetches a single task by id.
pub fn bridge_get_task(task_id: String) -> napi::Result<Option<tasks::TaskInfo>> {
    let s = state()?;
    let store = s
        .task_store
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    tasks::get_task(&store, &task_id).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: updates a task's fields and returns it.
pub fn bridge_update_task(task_id: String, req_json: String) -> napi::Result<tasks::TaskInfo> {
    let req: tasks::UpdateTaskRequest =
        serde_json::from_str(&req_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let s = state()?;
    let store = s
        .task_store
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    tasks::update_task(&store, &task_id, req).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: deletes a task by id.
pub fn bridge_delete_task(task_id: String) -> napi::Result<bool> {
    let s = state()?;
    let store = s
        .task_store
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    tasks::delete_task(&store, &task_id).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: persists a new ordering for a task list.
pub fn bridge_reorder_tasks(status: String, ids: Vec<String>) -> napi::Result<()> {
    let s = state()?;
    let store = s
        .task_store
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    tasks::reorder_tasks(&store, &status, &ids).map_err(|e| napi::Error::from_reason(e.to_string()))
}

// --- Automations ---

#[napi]
/// N-API entry point: creates an automation rule and returns it.
pub fn bridge_create_automation(req_json: String) -> napi::Result<automations::AutomationInfo> {
    let req: automations::CreateAutomationRequest =
        serde_json::from_str(&req_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let s = state()?;
    let store = s
        .automation_store
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    automations::create_automation(&store, req).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: lists all automation rules.
pub fn bridge_list_automations() -> napi::Result<Vec<automations::AutomationInfo>> {
    let s = state()?;
    let store = s
        .automation_store
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    automations::list_automations(&store).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: fetches a single automation by id.
pub fn bridge_get_automation(
    automation_id: String,
) -> napi::Result<Option<automations::AutomationInfo>> {
    let s = state()?;
    let store = s
        .automation_store
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    automations::get_automation(&store, &automation_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: enables or disables an automation rule.
pub fn bridge_set_automation_enabled(automation_id: String, enabled: bool) -> napi::Result<()> {
    let s = state()?;
    let store = s
        .automation_store
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    automations::set_automation_enabled(&store, &automation_id, enabled)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
/// N-API entry point: deletes an automation by id.
pub fn bridge_delete_automation(automation_id: String) -> napi::Result<bool> {
    let s = state()?;
    let store = s
        .automation_store
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    automations::delete_automation(&store, &automation_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Return enabled `Schedule` automations whose `next_scheduled_at` is
/// at or before "now". Called every tick by the Electron-side
/// `scheduler.ts` service.
#[napi]
pub fn bridge_due_scheduled_automations() -> napi::Result<Vec<automations::AutomationInfo>> {
    let s = state()?;
    let store = s
        .automation_store
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    automations::due_scheduled_automations(&store, chrono::Utc::now())
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Return enabled `OnGenerate` automations tied to a template (by its
/// stable string id, e.g. `"prd-v1"`). Used by the artifact-generation
/// IPC handler to dispatch downstream automations immediately after a
/// successful generation, without waiting for the next scheduler tick.
#[napi]
pub fn bridge_matching_on_generate_automations(
    template_id: String,
) -> napi::Result<Vec<automations::AutomationInfo>> {
    let s = state()?;
    let store = s
        .automation_store
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    automations::matching_on_generate_automations(&store, &template_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Return enabled `OnKchatMessageMatch` automations whose channel
/// equals `channel_id` and whose regex matches `message`. Called from
/// the KChat event forwarder on every `posted` WebSocket event so the
/// scheduler can dispatch the matching automations' actions.
#[napi]
pub fn bridge_matching_kchat_message_automations(
    channel_id: String,
    message: String,
) -> napi::Result<Vec<automations::AutomationInfo>> {
    let s = state()?;
    let store = s
        .automation_store
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    automations::matching_kchat_message_automations(&store, &channel_id, &message)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Persist the result of an automation run. `status` is rendered
/// verbatim in the UI (e.g. `"ok"` or `"failed: <reason>"`). Updates
/// `last_run_at = now()` so subsequent `bridge_due_scheduled_automations`
/// calls won't re-fire the same schedule until `interval_seconds`
/// elapses.
#[napi]
pub fn bridge_record_automation_run(automation_id: String, status: String) -> napi::Result<()> {
    let s = state()?;
    let store = s
        .automation_store
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    automations::record_automation_run(&store, &automation_id, &status)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

// --- Audit pass-throughs (the audit code) ---
//
// Most audit events are emitted directly by other bridge methods on
// behalf of the JS caller (see `bridge_add_local_folder`,
// `bridge_create_artifact`, etc.). The events below originate
// entirely on the JS side — the local model sidecar lifecycle,
// settings writes, and the connector OAuth + sync + disconnect
// lifecycle all live in `apps/desktop/electron/ipc/`. To get
// those events into the same `tessera_audit` store as everything
// else (and therefore into the same audit reports), we expose thin
// pass-throughs here.
//
// Each pass-through swallows `Err(audit-store-write-failure)` the
// same way the inline audit calls above do: the audit log is
// best-effort and must never propagate failure back to the JS
// caller (a transient SQLite contention causing the renderer to
// see a "model failed to start" error would be a far worse user
// experience than a missing audit row).

/// JS-facing pass-through for [`AuditLogger::log_settings_changed`].
/// Called by `apps/desktop/electron/ipc/settings.ts` whenever a
/// persisted config field changes via the `settings:update` /
/// `externalProvider:set` IPC handlers.
#[napi]
pub fn bridge_log_settings_changed(setting: String, value: String) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_settings_changed(&setting, &value);
    }
    Ok(())
}

/// JS-facing pass-through for [`AuditLogger::log_model_started`].
/// Called by `apps/desktop/electron/ipc/model.ts` when the
/// `model:start` IPC handler successfully starts the local sidecar.
#[napi]
pub fn bridge_log_model_started(model_id: String) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_model_started(&model_id);
    }
    Ok(())
}

/// JS-facing pass-through for [`AuditLogger::log_model_stopped`].
/// Called by `apps/desktop/electron/ipc/model.ts` when the
/// `model:stop` IPC handler shuts the local sidecar down. `reason`
/// is rendered verbatim — pass `"user-requested"` for explicit
/// shutdowns, `"app-shutdown"` for window-close, etc.
#[napi]
pub fn bridge_log_model_stopped(reason: String) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_model_stopped(&reason);
    }
    Ok(())
}

/// JS-facing pass-through for [`AuditLogger::log_connector_connected`].
/// Called by `apps/desktop/electron/ipc/connectors/handlers.ts`
/// after a successful OAuth flow has completed and the access /
/// refresh tokens have been written to the `tokenVault`.
#[napi]
pub fn bridge_log_connector_connected(provider: String) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_connector_connected(&provider);
    }
    Ok(())
}

/// JS-facing pass-through for [`AuditLogger::log_connector_synced`].
/// Called by `apps/desktop/electron/ipc/connectors/handlers.ts`
/// after a connector sync completes with the per-run delta counts.
/// The `status` field of the `ConnectorSyncResult` is intentionally
/// NOT logged here — `"offline"` is a transient transport error,
/// not a user-meaningful audit event.
#[napi]
pub fn bridge_log_connector_synced(
    provider: String,
    added: u32,
    updated: u32,
    removed: u32,
) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_connector_synced(
            &provider,
            added as usize,
            updated as usize,
            removed as usize,
        );
    }
    Ok(())
}

/// JS-facing pass-through for [`AuditLogger::log_connector_disconnected`].
/// Called by `apps/desktop/electron/ipc/connectors/handlers.ts`
/// after the connector's tokens have been revoked and the local
/// sync directory has been purged. `files_removed` is the
/// per-provider disconnect-result count of files that were
/// removed from the indexed-sources set as part of the cleanup.
#[napi]
pub fn bridge_log_connector_disconnected(provider: String, files_removed: u32) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_connector_disconnected(&provider, files_removed as usize);
    }
    Ok(())
}

/// JS-facing pass-through for [`AuditLogger::log_kchat_connected`].
/// Called by `apps/desktop/electron/ipc/kchat.ts` after the KChat
/// personal access token has been stored in the OS keychain and a
/// `/users/me` probe returned the KChat user identity.
#[napi]
pub fn bridge_log_kchat_connected(server_url: String, kchat_user_id: String) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_kchat_connected(&server_url, &kchat_user_id);
    }
    Ok(())
}

/// JS-facing pass-through for [`AuditLogger::log_kchat_disconnected`].
/// Called by `apps/desktop/electron/ipc/kchat.ts` after the KChat
/// token has been removed from the keychain and the WebSocket has
/// been closed.
#[napi]
pub fn bridge_log_kchat_disconnected(kchat_user_id: String) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_kchat_disconnected(&kchat_user_id);
    }
    Ok(())
}

/// JS-facing pass-through for [`AuditLogger::log_kchat_artifact_shared`].
/// Called by `kchat:shareArtifact` after the export has been
/// uploaded into the channel's file store.
#[napi]
pub fn bridge_log_kchat_artifact_shared(
    artifact_id: String,
    channel_id: String,
    format: String,
    include_citations: bool,
    include_evidence_pack: bool,
) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_kchat_artifact_shared(
            &artifact_id,
            &channel_id,
            &format,
            include_citations,
            include_evidence_pack,
        );
    }
    Ok(())
}

/// JS-facing pass-through for [`AuditLogger::log_kchat_channel_linked`].
/// Called by `sources:addKchatChannel` after the cache directory
/// has been registered as a `SourceType::Kchat` source.
#[napi]
pub fn bridge_log_kchat_channel_linked(
    channel_id: String,
    channel_name: String,
    cache_dir: String,
) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_kchat_channel_linked(&channel_id, &channel_name, &cache_dir);
    }
    Ok(())
}

/// JS-facing pass-through for [`AuditLogger::log_kchat_channel_unlinked`].
/// Called when a KChat-channel source is removed from the Sources
/// list (the `sources:remove` IPC handler dispatches to this for
/// `kchat`-tagged sources).
#[napi]
pub fn bridge_log_kchat_channel_unlinked(
    channel_id: String,
    files_removed: u32,
) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_kchat_channel_unlinked(&channel_id, files_removed as usize);
    }
    Ok(())
}

/// JS-facing pass-through for [`AuditLogger::log_kchat_file_downloaded`].
/// Called for every file the Node-side KChat client downloads from
/// a channel's file store into the local cache directory.
#[napi]
pub fn bridge_log_kchat_file_downloaded(
    channel_id: String,
    file_name: String,
    bytes: i64,
) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        // i64 → u64 conversion is safe: the JS side passes a file
        // size that is never negative; saturating-cast pins the
        // floor to 0 to keep the audit row well-formed even if a
        // mis-coded caller passes a sentinel negative value.
        let bytes_u64 = if bytes < 0 { 0_u64 } else { bytes as u64 };
        let _ = logger.log_kchat_file_downloaded(&channel_id, &file_name, bytes_u64);
    }
    Ok(())
}

/// JS-facing pass-through for
/// [`AuditLogger::log_kchat_file_event_received`]. Called by the
/// Node-side `KchatEventForwarder` when a WebSocket event is
/// received in the main process and surfaced to renderers.
/// Payload bodies are NOT passed in — only the event name,
/// originating channel id, optional file id, and a
/// `triggered_reindex` flag.
///
/// `triggered_reindex` is currently always `false` from the Node
/// side: the previous draft of `KchatEventForwarder.handleFileAdded`
/// called `bridge_reindex_source` for linked channels, but a
/// `file_added` event arrives BEFORE the file has been downloaded
/// into the channel's local cache directory, so the reindex was
/// a guaranteed no-op (walking an empty diff under the source-
/// manager mutex). The flag is preserved on the napi boundary and
/// audit row so the auto-sync iteration that wires
/// `runAddKchatChannel` into the WS forwarder can repopulate it
/// without breaking the audit row text format. See the second-
/// pass Devin Review on PR #43 (`BUG_pr-review-job-...0001`).
///
/// The optional fields use `Option<String>` rather than empty
/// strings so the napi bridge faithfully carries the "not present"
/// signal across the FFI boundary; the logger collapses both to
/// `""` in the audit row text, but downstream filters that ever
/// want to scan for "events on a specific channel" can rely on
/// the empty-string convention in the audit `details` payload.
#[napi]
pub fn bridge_log_kchat_file_event_received(
    event_name: String,
    channel_id: Option<String>,
    file_id: Option<String>,
    triggered_reindex: bool,
) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_kchat_file_event_received(
            &event_name,
            channel_id.as_deref(),
            file_id.as_deref(),
            triggered_reindex,
        );
    }
    Ok(())
}

/// Append a `KchatAclRefreshed` audit row. Called by the Node-side
/// `KchatEventForwarder` after every `bridge_refresh_kchat_acl`
/// call so an operator can see the
/// projection outcome (`granted` / `regranted` / `revoked` /
/// `unlinked` / `no_principal`) in the audit trail without
/// re-querying the substrate.
///
/// Member ids + roles are NOT logged — only the roster size and
/// the projection outcome. This keeps the audit row cheap and
/// avoids duplicating data already in `kchat_source_acl`.
#[napi]
pub fn bridge_log_kchat_acl_refreshed(
    channel_id: String,
    member_count: u32,
    principal_present: bool,
    outcome: String,
) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_kchat_acl_refreshed(
            &channel_id,
            member_count as usize,
            principal_present,
            &outcome,
        );
    }
    Ok(())
}

/// Append a `KchatChannelAccessRevoked` audit row. Called by the Node-side `KchatEventForwarder`
/// whenever a KChat-channel source transitions to
/// `SourceStatus::AccessRevoked` — either via an ACL refresh
/// where the principal was missing from the roster, or via an
/// explicit `bridge_revoke_kchat_source` call from a
/// `channel_archived` / `channel_deleted` / self-`user_removed`
/// event. The `reason` short-code documented on
/// `AuditLogger::log_kchat_channel_access_revoked` is the
/// operator-visible explanation for the revocation.
#[napi]
pub fn bridge_log_kchat_channel_access_revoked(
    channel_id: String,
    reason: String,
) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_kchat_channel_access_revoked(&channel_id, &reason);
    }
    Ok(())
}

/// Append a `KchatSourceCryptoshredded` audit row. Called by the Node-side `KchatEventForwarder` /
/// `kchat:disconnect` IPC handler whenever a revoke transition
/// triggers the substrate's inline cryptoshred. The `reason`
/// matches the sibling `KchatChannelAccessRevoked` row so the two
/// can be correlated by an operator's grep; `chunks_dropped` /
/// `files_dropped` are the counts returned by the bridge's
/// `bridge_revoke_kchat_source` / `bridge_refresh_kchat_acl`
/// outcome structs.
///
/// The row is emitted on EVERY revoke outcome (including
/// `already_revoked` and the refresh-driven `revoked` path) so
/// the audit trail shows both "we scrubbed N rows just now" and
/// "the source was already empty when we re-scrubbed it" — the
/// latter being the operator-visible signal that the Task-4
/// backfill ran on a previously soft-revoked source.
///
/// `fs_scrub_succeeded` / `fs_scrub_error` come from the Node-side
/// `secureDeleteChannelArtifacts` helper — they record whether the
/// filesystem scrub (cache dir + manifest sidecar removal) ran
/// cleanly. `fs_scrub_error` is `None` when the scrub succeeded and
/// `Some(reason)` when at least one `fs.rm` call failed (e.g. file
/// locked by another process on Windows). Operators grep the audit
/// log for `fs_scrub_succeeded=false` to find revokes whose on-disk
/// plaintext survived the scrub.
///
/// `vacuum_succeeded` / `vacuum_error` come from the substrate's
/// Phase 5 `VACUUM` (forwarded through
/// `KchatRevokeOutcomeInfo` / `KchatAclRefreshOutcomeInfo`). Fifth-pass
/// Devin Review fix (ANALYSIS_pr-review-job-ef3c7d6c..._0001): a
/// `VACUUM` failure after the DELETE + UPDATE transaction commits
/// is non-fatal — the row-level scrub already ran under
/// `secure_delete = ON` so the cryptographic guarantee holds — but
/// the audit row records `vacuum_succeeded=false` so operators can
/// re-run `VACUUM` manually once the underlying issue resolves.
#[napi]
#[allow(clippy::too_many_arguments)]
pub fn bridge_log_kchat_source_cryptoshredded(
    channel_id: String,
    reason: String,
    chunks_dropped: u32,
    files_dropped: u32,
    posts_dropped: u32,
    dek_dropped: bool,
    fs_scrub_succeeded: bool,
    fs_scrub_error: Option<String>,
    vacuum_succeeded: bool,
    vacuum_error: Option<String>,
) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_kchat_source_cryptoshredded(
            &channel_id,
            &reason,
            chunks_dropped,
            files_dropped,
            posts_dropped,
            dek_dropped,
            fs_scrub_succeeded,
            fs_scrub_error.as_deref(),
            vacuum_succeeded,
            vacuum_error.as_deref(),
        );
    }
    Ok(())
}

/// JS-facing outcome of [`bridge_ingest_kchat_post`] /
/// [`bridge_edit_kchat_post`]. `outcome` is one of
/// `ingested`/`unchanged`/`unlinked`/`access_revoked`. When the
/// outcome is `ingested` or `unchanged`, the substrate also
/// returns the resolved `source_id` so the Node side can correlate
/// audit rows with the in-memory channel-to-source mapping
/// without an extra lookup. `indexed_file_id` + `chunk_count`
/// surface the chunk-count the audit logger records (zero on
/// every non-success outcome).
///
/// Block C Task 1.
#[derive(Debug)]
#[napi(object)]
pub struct KchatPostIngestOutcomeInfo {
    /// Ingest result (`ingested` / `unchanged` / `unlinked` /
    /// `access_revoked`).
    pub outcome: String,
    /// Resolved source id on success outcomes; `None` otherwise.
    pub source_id: Option<String>,
    /// Row id of the indexed_files entry, on success outcomes.
    pub indexed_file_id: Option<i64>,
    /// Number of chunks sealed for this post (0 on non-success).
    pub chunk_count: u32,
    /// `chunk_ids` populated only for `outcome == "ingested"`. The
    /// Node side records this on the audit row so a search hit
    /// the renderer surfaces can be traced back to the substrate
    /// chunk row (without exposing the post body itself).
    pub chunk_ids: Vec<i64>,
}

/// JS-facing outcome of [`bridge_delete_kchat_post`]. `outcome`
/// is one of `deleted`/`not_found`/`unlinked`/`access_revoked`.
/// `chunks_dropped` carries the count surfaced on the audit row.
///
/// Block C Task 1.
#[derive(Debug)]
#[napi(object)]
pub struct KchatPostDeleteOutcomeInfo {
    /// Delete result (`deleted` / `not_found` / `unlinked` /
    /// `access_revoked`).
    pub outcome: String,
    /// Resolved source id on success outcomes; `None` otherwise.
    pub source_id: Option<String>,
    /// Number of chunk rows scrubbed for the deleted post.
    pub chunks_dropped: u32,
}

/// JS-facing input wire-shape for [`bridge_ingest_kchat_post`] /
/// [`bridge_edit_kchat_post`]. Mirrors
/// `tessera_sources::manager::KchatPostIngestInput`. Built by the
/// Node-side `KchatEventForwarder` from a `posted` /
/// `post_edited` WS event after `withChannelSyncLock` serialises
/// it.
///
/// Block C Task 1.
#[derive(Debug)]
#[napi(object)]
pub struct KchatPostIngestInputInfo {
    /// Channel cache dir (equals the channel id) the post belongs to.
    pub cache_dir: String,
    /// KChat post id being ingested.
    pub post_id: String,
    /// KChat channel id the post was sent in.
    pub channel_id: String,
    /// Thread root post id, or `None` if the post is a root.
    pub root_id: Option<String>,
    /// User id of the post's author.
    pub sender_user_id: String,
    /// Raw post body to chunk and index.
    pub body: String,
    /// Post creation time, Unix epoch milliseconds.
    pub created_at_ms: i64,
    /// Last-edit time, Unix epoch milliseconds.
    pub edited_at_ms: i64,
}

fn ingest_post_outcome_to_info(
    outcome: tessera_sources::manager::KchatPostIngestOutcome,
) -> KchatPostIngestOutcomeInfo {
    use tessera_sources::manager::KchatPostIngestOutcome;
    match outcome {
        KchatPostIngestOutcome::Ingested {
            source_id,
            indexed_file_id,
            chunk_ids,
            sealed_count,
        } => KchatPostIngestOutcomeInfo {
            outcome: "ingested".to_string(),
            source_id: Some(source_id.to_string()),
            indexed_file_id: Some(indexed_file_id),
            chunk_count: sealed_count,
            chunk_ids,
        },
        KchatPostIngestOutcome::Unchanged {
            source_id,
            indexed_file_id,
            chunk_count,
        } => KchatPostIngestOutcomeInfo {
            outcome: "unchanged".to_string(),
            source_id: Some(source_id.to_string()),
            indexed_file_id: Some(indexed_file_id),
            chunk_count,
            chunk_ids: Vec::new(),
        },
        KchatPostIngestOutcome::Unlinked => KchatPostIngestOutcomeInfo {
            outcome: "unlinked".to_string(),
            source_id: None,
            indexed_file_id: None,
            chunk_count: 0,
            chunk_ids: Vec::new(),
        },
        KchatPostIngestOutcome::AccessRevoked => KchatPostIngestOutcomeInfo {
            outcome: "access_revoked".to_string(),
            source_id: None,
            indexed_file_id: None,
            chunk_count: 0,
            chunk_ids: Vec::new(),
        },
    }
}

fn build_post_ingest_input(
    info: &KchatPostIngestInputInfo,
) -> tessera_sources::manager::KchatPostIngestInput {
    tessera_sources::manager::KchatPostIngestInput {
        cache_dir: info.cache_dir.clone(),
        post_id: info.post_id.clone(),
        channel_id: info.channel_id.clone(),
        root_id: info.root_id.clone(),
        sender_user_id: info.sender_user_id.clone(),
        body: info.body.clone(),
        created_at_ms: info.created_at_ms,
        edited_at_ms: info.edited_at_ms,
    }
}

/// ingest a KChat post body via the
/// substrate's `ingest_kchat_post`. Called by the Node-side
/// `KchatEventForwarder` on a `posted` WS event. Returns the
/// outcome shape the audit logger forwards to
/// `bridge_log_kchat_post_ingested`.
#[napi]
pub fn bridge_ingest_kchat_post(
    input: KchatPostIngestInputInfo,
) -> napi::Result<KchatPostIngestOutcomeInfo> {
    let s = state()?;
    let manager = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("source manager poisoned: {e}")))?;
    let internal = build_post_ingest_input(&input);
    let outcome = manager
        .ingest_kchat_post(&internal)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(ingest_post_outcome_to_info(outcome))
}

/// re-ingest a KChat post body after a
/// `post_edited` WS event. Delegates to
/// `SourceManager::edit_kchat_post` which currently shares the
/// same code path as ingest but is surfaced as a distinct bridge
/// export so the forwarder can write to the correct audit
/// variant (`KchatPostEdited`).
#[napi]
pub fn bridge_edit_kchat_post(
    input: KchatPostIngestInputInfo,
) -> napi::Result<KchatPostIngestOutcomeInfo> {
    let s = state()?;
    let manager = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("source manager poisoned: {e}")))?;
    let internal = build_post_ingest_input(&input);
    let outcome = manager
        .edit_kchat_post(&internal)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(ingest_post_outcome_to_info(outcome))
}

/// drop the substrate evidence for a
/// KChat post after a `post_deleted` WS event.
#[napi]
pub fn bridge_delete_kchat_post(
    cache_dir: String,
    post_id: String,
) -> napi::Result<KchatPostDeleteOutcomeInfo> {
    use tessera_sources::manager::KchatPostDeleteOutcome;
    let s = state()?;
    let manager = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("source manager poisoned: {e}")))?;
    let outcome = manager
        .delete_kchat_post(&cache_dir, &post_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(match outcome {
        KchatPostDeleteOutcome::Deleted {
            source_id,
            chunks_dropped,
        } => KchatPostDeleteOutcomeInfo {
            outcome: "deleted".to_string(),
            source_id: Some(source_id.to_string()),
            chunks_dropped,
        },
        KchatPostDeleteOutcome::NotFound { source_id } => KchatPostDeleteOutcomeInfo {
            outcome: "not_found".to_string(),
            source_id: Some(source_id.to_string()),
            chunks_dropped: 0,
        },
        KchatPostDeleteOutcome::Unlinked => KchatPostDeleteOutcomeInfo {
            outcome: "unlinked".to_string(),
            source_id: None,
            chunks_dropped: 0,
        },
        KchatPostDeleteOutcome::AccessRevoked => KchatPostDeleteOutcomeInfo {
            outcome: "access_revoked".to_string(),
            source_id: None,
            chunks_dropped: 0,
        },
    })
}

/// record a KChat post-body ingest
/// outcome on the audit log. The Node-side forwarder calls this
/// after `bridge_ingest_kchat_post` returns.
#[napi]
pub fn bridge_log_kchat_post_ingested(
    channel_id: String,
    post_id: String,
    outcome: String,
    chunk_count: u32,
) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_kchat_post_ingested(&channel_id, &post_id, &outcome, chunk_count);
    }
    Ok(())
}

/// record a KChat post-body edit
/// outcome on the audit log.
#[napi]
pub fn bridge_log_kchat_post_edited(
    channel_id: String,
    post_id: String,
    outcome: String,
    chunk_count: u32,
) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_kchat_post_edited(&channel_id, &post_id, &outcome, chunk_count);
    }
    Ok(())
}

/// record a KChat post-body delete
/// outcome on the audit log.
#[napi]
pub fn bridge_log_kchat_post_deleted(
    channel_id: String,
    post_id: String,
    outcome: String,
    chunks_dropped: u32,
) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_kchat_post_deleted(&channel_id, &post_id, &outcome, chunks_dropped);
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Block C Task 4 — KChat historical backfill bridge surface
// ─────────────────────────────────────────────────────────────────────────────

/// JS-facing view of [`SourceManager::kchat_backfill_state`].
///
/// `outcome` is one of `idle` / `unlinked` / `access_revoked` and
/// determines which other fields are meaningful:
///
/// - `idle`: `source_id` is populated. `oldest_post_id` is the
///   persisted cursor (NULL on first call) and `completed_at` is
///   the RFC3339 completion sentinel (NULL when the walk needs
///   more pages). The orchestrator uses `completed_at != null`
///   to short-circuit an already-completed walk.
/// - `unlinked`: the cache_dir does not correspond to a registered
///   KChat source. The orchestrator treats this as a no-op.
/// - `access_revoked`: the source exists but is revoked. The
///   orchestrator must NOT walk it — doing so would re-create the
///   chunks the cryptoshred destroyed.
#[derive(Debug)]
#[napi(object)]
pub struct KchatBackfillStateInfo {
    /// Backfill state (`idle` / `unlinked` / `access_revoked`).
    pub outcome: String,
    /// Resolved source id when `outcome == "idle"`.
    pub source_id: Option<String>,
    /// Persisted walk cursor (oldest post seen), or `None` on the
    /// first call.
    pub oldest_post_id: Option<String>,
    /// RFC 3339 completion sentinel; `None` while more pages
    /// remain.
    pub completed_at: Option<String>,
}

/// JS-facing view of [`SourceManager::ingest_kchat_backfill_page`].
///
/// `outcome` is one of `ingested` / `unlinked` / `access_revoked`.
/// On `ingested`, the per-page counters break down what the page
/// did at the substrate (newly-indexed vs. already-known vs.
/// skipped due to mid-walk revocation). `oldest_post_id_in_page`
/// is the cursor the substrate advanced to (None on empty pages).
#[derive(Debug)]
#[napi(object)]
pub struct KchatBackfillIngestOutcomeInfo {
    /// Page result (`ingested` / `unlinked` / `access_revoked`).
    pub outcome: String,
    /// Resolved source id when `outcome == "ingested"`.
    pub source_id: Option<String>,
    /// Posts newly indexed by this page.
    pub posts_ingested: u32,
    /// Posts already known (content hash matched).
    pub posts_unchanged: u32,
    /// Posts skipped because access was revoked mid-walk.
    pub posts_skipped_revoked: u32,
    /// Cursor the substrate advanced to; `None` on an empty page.
    pub oldest_post_id_in_page: Option<String>,
}

/// JS-facing view of
/// [`SourceManager::mark_kchat_backfill_complete`].
#[derive(Debug)]
#[napi(object)]
pub struct KchatBackfillCompletionOutcomeInfo {
    /// Completion result (`completed` / `unlinked` /
    /// `access_revoked`).
    pub outcome: String,
    /// Resolved source id on success.
    pub source_id: Option<String>,
}

/// read the persisted backfill state
/// for a KChat channel. The renderer / orchestrator uses this to
/// decide whether to start, resume, or skip the walk.
#[napi]
pub fn bridge_get_kchat_backfill_state(cache_dir: String) -> napi::Result<KchatBackfillStateInfo> {
    use tessera_sources::manager::KchatBackfillState;
    let s = state()?;
    let manager = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("source manager poisoned: {e}")))?;
    let state = manager
        .kchat_backfill_state(&cache_dir)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(match state {
        KchatBackfillState::Idle {
            source_id,
            oldest_post_id,
            completed_at,
        } => KchatBackfillStateInfo {
            outcome: "idle".to_string(),
            source_id: Some(source_id.to_string()),
            oldest_post_id,
            completed_at,
        },
        KchatBackfillState::Unlinked => KchatBackfillStateInfo {
            outcome: "unlinked".to_string(),
            source_id: None,
            oldest_post_id: None,
            completed_at: None,
        },
        KchatBackfillState::AccessRevoked { source_id } => KchatBackfillStateInfo {
            outcome: "access_revoked".to_string(),
            source_id: Some(source_id.to_string()),
            oldest_post_id: None,
            completed_at: None,
        },
    })
}

/// ingest one page of historical KChat
/// posts. Each input in `page` must be in REST-returned order
/// (newest-first); the substrate advances the persisted cursor to
/// the OLDEST post id in the page.
///
/// The orchestrator calls this once per `getPostsForChannel(...)`
/// response. The page must already be size-bounded by the
/// orchestrator (KChat's `per_page` cap of 200) — this bridge does
/// NOT impose its own per-page cap so a test that drives the
/// substrate directly with a synthetic 1k-row page still works.
/// The cumulative-row safety cap (50_000 posts/walk) lives in the
/// orchestrator where the REST loop runs.
#[napi]
pub fn bridge_ingest_kchat_backfill_page(
    cache_dir: String,
    page: Vec<KchatPostIngestInputInfo>,
) -> napi::Result<KchatBackfillIngestOutcomeInfo> {
    use tessera_sources::manager::KchatBackfillIngestOutcome;
    let s = state()?;
    let manager = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("source manager poisoned: {e}")))?;
    let inputs: Vec<_> = page.iter().map(build_post_ingest_input).collect();
    let outcome = manager
        .ingest_kchat_backfill_page(&cache_dir, &inputs)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(match outcome {
        KchatBackfillIngestOutcome::Ingested {
            source_id,
            posts_ingested,
            posts_unchanged,
            posts_skipped_revoked,
            oldest_post_id_in_page,
        } => KchatBackfillIngestOutcomeInfo {
            outcome: "ingested".to_string(),
            source_id: Some(source_id.to_string()),
            posts_ingested,
            posts_unchanged,
            posts_skipped_revoked,
            oldest_post_id_in_page,
        },
        KchatBackfillIngestOutcome::Unlinked => KchatBackfillIngestOutcomeInfo {
            outcome: "unlinked".to_string(),
            source_id: None,
            posts_ingested: 0,
            posts_unchanged: 0,
            posts_skipped_revoked: 0,
            oldest_post_id_in_page: None,
        },
        KchatBackfillIngestOutcome::AccessRevoked { source_id } => KchatBackfillIngestOutcomeInfo {
            outcome: "access_revoked".to_string(),
            source_id: Some(source_id.to_string()),
            posts_ingested: 0,
            posts_unchanged: 0,
            posts_skipped_revoked: 0,
            oldest_post_id_in_page: None,
        },
    })
}

/// mark the backfill walk complete.
/// Called by the orchestrator when the REST page returns
/// `prev_post_id == null` (the server says "there are no posts
/// older than the current cursor").
#[napi]
pub fn bridge_mark_kchat_backfill_complete(
    cache_dir: String,
) -> napi::Result<KchatBackfillCompletionOutcomeInfo> {
    use tessera_sources::manager::KchatBackfillCompletionOutcome;
    let s = state()?;
    let manager = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("source manager poisoned: {e}")))?;
    let outcome = manager
        .mark_kchat_backfill_complete(&cache_dir)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(match outcome {
        KchatBackfillCompletionOutcome::Completed { source_id } => {
            KchatBackfillCompletionOutcomeInfo {
                outcome: "completed".to_string(),
                source_id: Some(source_id.to_string()),
            }
        }
        KchatBackfillCompletionOutcome::Unlinked => KchatBackfillCompletionOutcomeInfo {
            outcome: "unlinked".to_string(),
            source_id: None,
        },
        KchatBackfillCompletionOutcome::AccessRevoked { source_id } => {
            KchatBackfillCompletionOutcomeInfo {
                outcome: "access_revoked".to_string(),
                source_id: Some(source_id.to_string()),
            }
        }
    })
}

/// record a `KchatBackfillStarted`
/// audit row when the orchestrator kicks off (or resumes) a walk.
/// `resume_from_post_id` is the persisted cursor at start time
/// (NULL on a fresh walk) so the audit timeline shows whether the
/// run was a resume.
#[napi]
pub fn bridge_log_kchat_backfill_started(
    channel_id: String,
    source_id: String,
    resume_from_post_id: Option<String>,
) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_kchat_backfill_started(
            &channel_id,
            &source_id,
            resume_from_post_id.as_deref(),
        );
    }
    Ok(())
}

/// record a `KchatBackfillPageIngested`
/// audit row after each page the orchestrator processes. The page
/// number is 1-based so the audit timeline reads "page 1, page 2…"
/// rather than "page 0, page 1…".
#[napi]
#[allow(clippy::too_many_arguments)]
pub fn bridge_log_kchat_backfill_page_ingested(
    channel_id: String,
    source_id: String,
    page_number: u32,
    posts_ingested: u32,
    posts_unchanged: u32,
    posts_skipped_revoked: u32,
    oldest_post_id_in_page: Option<String>,
) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_kchat_backfill_page_ingested(
            &channel_id,
            &source_id,
            page_number,
            posts_ingested,
            posts_unchanged,
            posts_skipped_revoked,
            oldest_post_id_in_page.as_deref(),
        );
    }
    Ok(())
}

/// record a `KchatBackfillCompleted`
/// audit row when the orchestrator observes the end-of-history
/// signal (REST page returns `prev_post_id == null`).
#[napi]
pub fn bridge_log_kchat_backfill_completed(
    channel_id: String,
    source_id: String,
    pages_walked: u32,
    total_posts_ingested: u32,
    total_posts_unchanged: u32,
) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_kchat_backfill_completed(
            &channel_id,
            &source_id,
            pages_walked,
            total_posts_ingested,
            total_posts_unchanged,
        );
    }
    Ok(())
}

/// record a `KchatBackfillAborted`
/// audit row when the orchestrator stops the walk early (mid-walk
/// revocation, safety-cap hit, network error, or unlinked
/// source). `reason` is a short machine-readable tag:
///
/// - `"access_revoked"`: source flipped to revoked between pages
/// - `"safety_cap"`: cumulative posts-walked hit the orchestrator's
///   per-channel cap (50_000)
/// - `"unlinked"`: source row disappeared between pages
/// - `"error"`: REST or substrate error
#[napi]
pub fn bridge_log_kchat_backfill_aborted(
    channel_id: String,
    source_id: String,
    reason: String,
    pages_walked: u32,
    total_posts_ingested: u32,
) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_kchat_backfill_aborted(
            &channel_id,
            &source_id,
            &reason,
            pages_walked,
            total_posts_ingested,
        );
    }
    Ok(())
}

/// record a `KchatPostSearchExecuted`
/// audit row when the renderer's evidence search calls into the
/// KChat-content retrieval bridge. The IPC handler computes
/// `query_hash` (SHA-256 over the normalised query, hex-encoded
/// + truncated to 16 chars) and `latency_ms` (end-to-end IPC
/// duration) before calling — the substrate intentionally does
/// not log the raw query (privacy property).
///
/// Mirrors `bridge_log_kchat_backfill_aborted`'s
/// best-effort-not-fatal failure shape: a poisoned audit-logger
/// mutex does NOT crash the search path, just drops the audit
/// row (the search itself already succeeded by the time this
/// is called, and breaking observability on a degraded mutex
/// would block the user's actual retrieval flow).
#[napi]
pub fn bridge_log_kchat_post_search_executed(
    query_hash: String,
    hits: u32,
    sources_touched: u32,
    latency_ms: u32,
) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ =
            logger.log_kchat_post_search_executed(&query_hash, hits, sources_touched, latency_ms);
    }
    Ok(())
}

/// Renderer-facing audit row. The Rust `AuditEvent` carries a
/// strongly-typed `AuditEventType` enum and a `DateTime<Utc>`;
/// neither survives the napi boundary cleanly, so we serialise the
/// event type as a `serde_json`-style string ("KchatConnected",
/// "ArtifactShared", …) and the timestamp as RFC 3339 / ISO 8601.
#[napi(object)]
pub struct AuditEventView {
    /// UUID string assigned at append time. The audit table uses
    /// TEXT-typed UUIDs, not autoincrement integers, so two
    /// processes appending concurrently can't collide.
    pub id: String,
    /// Event type as a snake_case string (matches the serde form
    /// of `AuditEventType`).
    pub event_type: String,
    /// When the event was recorded, RFC 3339.
    pub timestamp: String,
    /// Event-specific detail payload (JSON-encoded string).
    pub details: String,
}

/// rotate the audit log if it has grown above
/// the threshold. Returns the archive path and rotated-row count
/// when a rotation occurred; returns `null` when the table is at
/// or below the threshold.
///
/// `archive_dir` is the absolute path of the user-data directory
/// where the renderer wants archives to live (typically
/// `<userData>/audit-archives/`). The bridge does NOT pick this
/// path itself — the Electron process owns the userData location,
/// so it must pass an explicit path so a rotation kicked off via
/// IPC always agrees with one kicked off via the scheduled
/// background task.
#[napi(object)]
pub struct AuditRotationResultView {
    /// Absolute path of the gzip archive the rotation wrote.
    pub archive_path: String,
    /// `u32` rather than `u64` because napi-rs does not support
    /// JS BigInt return types on every platform we ship to, and
    /// `u32::MAX` (~4 billion rows) is well above any realistic
    /// audit-log size.
    pub rotated_count: u32,
}

#[napi]
/// N-API entry point: rotates the audit log, archiving the current
/// segment.
pub fn bridge_audit_rotate(archive_dir: String) -> napi::Result<Option<AuditRotationResultView>> {
    let s = state()?;
    // Do NOT go through the outer `Mutex<AuditLogger>` for the
    // rotation path. Inside
    // `AuditStore::rotate`, the code intentionally releases the
    // `SharedConnection` mutex between Phase 1 (SELECT) and Phase
    // 2 (gzip compression) so concurrent `log_*` IPC calls can
    // continue appending audit events while a large rotation
    // compresses tens of thousands of rows. If we acquired
    // `s.audit_logger` here, that outer mutex would block every
    // other audit IPC for the full duration of the gzip — hundreds
    // of milliseconds for a >50k-row rotation — negating the
    // internal release entirely.
    //
    // Instead, we construct a transient `AuditStore` on top of the
    // already-open `shared_conn`. `with_shared_conn` runs
    // `init_schema` which is idempotent (all `CREATE TABLE / INDEX
    // / TRIGGER IF NOT EXISTS`), so the transient construction is
    // cheap and safe.
    //
    // Concurrent rotations across the IPC entry point and any
    // future scheduled-rotation entry point are still serialized
    // by the process-wide `AUDIT_ROTATION_SERIALIZER` inside
    // `AuditStore::rotate`, so dropping the outer
    // mutex does not introduce a duplicate-archive race.
    let store = AuditStore::with_shared_conn(s.shared_conn.clone())
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let outcome = store
        .rotate(std::path::Path::new(&archive_dir))
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(outcome.map(|o| AuditRotationResultView {
        archive_path: o.archive_path.display().to_string(),
        rotated_count: o.rotated_count.min(u32::MAX as u64) as u32,
    }))
}

/// list the audit-archive files in
/// `archive_dir`, newest-first. The Settings page renders this
/// list with download links. Returns `[]` when the directory does
/// not yet exist (no rotations have happened).
#[napi]
pub fn bridge_audit_list_archives(archive_dir: String) -> napi::Result<Vec<String>> {
    let paths = AuditLogger::list_archives(std::path::Path::new(&archive_dir))
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(paths.into_iter().map(|p| p.display().to_string()).collect())
}

/// Return the `limit` most recent audit rows, newest first.
/// `limit` is clamped to `[1, 500]` so a renderer bug requesting
/// millions of rows can't OOM the main process. `offset` lets the
/// renderer page backwards.
#[napi]
pub fn bridge_recent_audit_events(limit: u32, offset: u32) -> napi::Result<Vec<AuditEventView>> {
    let clamped = limit.clamp(1, 500);
    let s = state()?;
    let logger = s
        .audit_logger
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("audit logger poisoned: {e}")))?;
    let events = logger
        .recent_events(clamped, offset)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(events
        .into_iter()
        .map(|ev| AuditEventView {
            id: ev.id,
            // `AuditEventType` exposes the canonical snake_case
            // identifier via {@link AuditEventType::as_snake_case},
            // which is the same value emitted by the serde
            // `rename_all = "snake_case"` derive but without the
            // JSON-string + quote-trim round-trip the bridge
            // previously used. The serde form remains the
            // authoritative on-disk representation in SQLite; this
            // helper just keeps the napi → JS conversion direct.
            // A unit test in `tessera_audit::event::tests`
            // (`as_snake_case_matches_serde_form`) asserts the two
            // representations stay in lockstep across enum changes.
            event_type: ev.event_type.as_snake_case().to_string(),
            timestamp: ev.timestamp.to_rfc3339(),
            details: ev.details,
        })
        .collect())
}

// --- Vision + image-generation bridges -------------------------------------
//
// Both call HTTP sidecars (llama-server with `--mmproj` for vision,
// sd-server for image gen). The underlying `tessera_runtime`
// functions are async (`reqwest::Client::send().await`), so each
// bridge spins up a private current-thread tokio runtime inside the
// napi `Task::compute` worker. That keeps the bridge crate
// runtime-agnostic (we don't pull in a global #[tokio::main]) and
// avoids contention with any future async work running on the
// Electron main thread.
//
// We use `AsyncTask` so the JS side gets a Promise — vision and
// image generation are 10-30 second calls; blocking the napi
// callback thread would freeze every other IPC handler in the
// Electron main process for the duration.

/// JS-facing response shape for [`tessera_runtime::vision::VisionResponse`].
/// Kept in napi-friendly form (no `Option`, no nested generics).
#[napi(object)]
pub struct VisionDescribeResult {
    /// Generated completion text from the vision model.
    pub content: String,
    /// Whether generation stopped naturally (vs. hitting the token
    /// budget).
    pub stop: bool,
    /// Number of tokens the model generated.
    pub tokens_predicted: u32,
    /// Number of prompt/image tokens the model evaluated.
    pub tokens_evaluated: u32,
}

/// One of the three pre-baked vision-completion modes. Mirrors the
/// `vision_describe` / `vision_ocr` / `vision_describe_chart`
/// convenience wrappers in `crates/tessera_runtime/src/vision.rs`.
/// String enum on the JS side (`"describe"`, `"ocr"`, `"chart"`) so
/// the renderer can statically discriminate without smuggling
/// magic numbers.
///
/// **Casing**: napi-rs's `string_enum` serialises variant
/// identifiers VERBATIM by default (i.e. `Describe`, `Ocr`,
/// `Chart`), which would mismatch the lowercase strings the
/// TypeScript side sends (`VisionDescribeSchema` in
/// `ipc/schemas.ts` validates `"describe" | "ocr" | "chart"`).
/// The explicit `= "lowercase"` casing override forces napi-rs to
/// emit / accept the lowercase form, so the FFI contract aligns
/// with the renderer schema without forcing every TS caller to
/// PascalCase its argument.
#[napi(string_enum = "lowercase")]
pub enum VisionMode {
    /// Free-form natural-language description of the image.
    Describe,
    /// Verbatim transcription of every visible character.
    Ocr,
    /// Structured chart/diagram summary (axes, data points,
    /// conclusion).
    Chart,
}

/// Task wrapper for the vision-completion bridge. Holds the
/// endpoint URL, the on-disk image path, the prompt mode, and the
/// max-tokens budget; the worker thread builds its own tokio
/// runtime and calls into `tessera_runtime::vision`.
pub struct VisionDescribeTask {
    endpoint: String,
    image_path: String,
    mode: VisionMode,
    max_tokens: u32,
}

impl Task for VisionDescribeTask {
    type Output = tessera_runtime::vision::VisionResponse;
    type JsValue = VisionDescribeResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let endpoint = self.endpoint.clone();
        let image_path = self.image_path.clone();
        let max_tokens = self.max_tokens;
        let mode = self.mode;

        // Per-call current-thread runtime. Cheap to construct (it's
        // a thin wrapper around mio); the alternative — sharing a
        // single global runtime — would risk a deadlock if a future
        // sync bridge call ever lands on the same worker thread and
        // tries to acquire a tokio resource the previous async call
        // dropped. Keeping each call self-contained avoids that.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| napi::Error::from_reason(format!("tokio runtime: {e}")))?;

        rt.block_on(async move {
            match mode {
                VisionMode::Describe => {
                    tessera_runtime::vision::vision_describe(&endpoint, &image_path, max_tokens)
                        .await
                }
                VisionMode::Ocr => {
                    tessera_runtime::vision::vision_ocr(&endpoint, &image_path, max_tokens).await
                }
                VisionMode::Chart => {
                    tessera_runtime::vision::vision_describe_chart(
                        &endpoint,
                        &image_path,
                        max_tokens,
                    )
                    .await
                }
            }
        })
        .map_err(napi::Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(VisionDescribeResult {
            content: output.content,
            stop: output.stop,
            // Default to 0 if the sidecar omitted the field —
            // matches the TS-side `VisionResult` declaration where
            // these are `number` (not `number | undefined`).
            tokens_predicted: output.tokens_predicted.unwrap_or(0),
            tokens_evaluated: output.tokens_evaluated.unwrap_or(0),
        })
    }
}

/// Run a vision completion against a `llama-server --mmproj` sidecar.
///
/// `endpoint` is the sidecar base URL (e.g.
/// `http://127.0.0.1:8385`). `image_path` is an absolute path to
/// the image file on the user's disk — the bridge reads it,
/// base64-encodes it, and posts it to the sidecar's `/completion`
/// endpoint with the `[img-1]` placeholder substituted in.
///
/// The `mode` argument selects one of three pre-tuned prompts:
///   - `"describe"`: searchable natural-language description of
///     the image. Used by the indexing pipeline for image sources.
///   - `"ocr"`: verbatim transcription of every visible character.
///     Used for scanned PDFs and whiteboard captures.
///   - `"chart"`: structured chart / diagram summary including
///     axes, key data points, and conclusion.
///
/// Returns a Promise resolving to `{ content, stop, tokensPredicted,
/// tokensEvaluated }`. Rejects with the sidecar's status line and
/// body on HTTP failure, or with the underlying I/O error if the
/// image file can't be read.
#[napi]
pub fn bridge_vision_describe(
    endpoint: String,
    image_path: String,
    mode: VisionMode,
    max_tokens: u32,
) -> napi::Result<AsyncTask<VisionDescribeTask>> {
    Ok(AsyncTask::new(VisionDescribeTask {
        endpoint,
        image_path,
        mode,
        max_tokens,
    }))
}

/// JS-facing response shape for
/// [`tessera_runtime::imagegen::ImageGenResponse`]. PNG bytes are
/// returned as a `Buffer` on the JS side; the renderer / main
/// process writes them to disk before showing the image in the
/// editor preview.
#[napi(object)]
pub struct GenerateImageResult {
    /// Rendered image as PNG bytes.
    pub png_bytes: napi::bindgen_prelude::Buffer,
    /// Sampler seed actually used (echoed so the renderer can
    /// reproduce the result).
    pub seed: napi::bindgen_prelude::BigInt,
}

/// JS-facing request shape for `bridge_generate_image`. Bundling
/// the sampling knobs into a single struct keeps the napi
/// signature ergonomic (one `request` object on the TS side
/// instead of seven positional `null`s for omitted overrides)
/// AND under clippy's `too_many_arguments` threshold. The struct
/// maps to a plain JS object — every `Option<T>` becomes
/// `T | null | undefined` on the renderer side.
#[napi(object)]
pub struct GenerateImageInput {
    /// Text prompt describing the desired image.
    pub prompt: String,
    /// Output width in pixels.
    pub width: u32,
    /// Output height in pixels.
    pub height: u32,
    /// Number of diffusion denoising steps. `None` defers to the
    /// `ImageGenRequest` default (20 for FLUX.2-klein).
    pub steps: Option<u32>,
    /// Classifier-free guidance scale. `None` defers to the
    /// `ImageGenRequest` default (3.5 for FLUX.2-klein). f64 on
    /// the wire because JS Numbers are doubles; the bridge casts
    /// to f32 for the Rust side, which is the diffusion-domain
    /// precision.
    pub cfg_scale: Option<f64>,
    /// Sampler seed. `None` → sd-server picks one. The Rust side
    /// is u64 to match sd-server's full range; the wire type is
    /// i64 because that's what napi-rs exposes by default —
    /// negative values are clamped to 0 defensively (the
    /// renderer pre-validates positive).
    pub seed: Option<i64>,
    /// Optional negative prompt. `None` / empty string both
    /// disable negative conditioning.
    pub negative_prompt: Option<String>,
}

/// Task wrapper for the image-generation bridge. Carries the
/// endpoint URL plus every diffusion sampling knob the renderer
/// might want to control. Defaults that aren't covered here come
/// from `ImageGenRequest::new`'s FLUX.2-klein presets — the
/// `Option<u32>` / `Option<f32>` shape means the renderer can
/// pass `null` from JS to fall back to the model's recommended
/// values.
pub struct GenerateImageTask {
    endpoint: String,
    prompt: String,
    width: u32,
    height: u32,
    steps: Option<u32>,
    cfg_scale: Option<f64>,
    seed: Option<i64>,
    negative_prompt: Option<String>,
}

impl Task for GenerateImageTask {
    type Output = tessera_runtime::imagegen::ImageGenResponse;
    type JsValue = GenerateImageResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let endpoint = self.endpoint.clone();
        let mut req = tessera_runtime::imagegen::ImageGenRequest::new(
            self.prompt.clone(),
            self.width,
            self.height,
        );
        if let Some(steps) = self.steps {
            req = req.with_steps(steps);
        }
        if let Some(cfg) = self.cfg_scale {
            // ImageGenRequest stores cfg_scale as f32; the napi
            // bridge surfaces it as f64 because JS Numbers are
            // doubles. The lossy cast here is safe — diffusion
            // CFG values fit in f32 (typically 1.0-15.0) and the
            // FLUX.2-klein recommended range is 2.0-5.0.
            req = req.with_cfg_scale(cfg as f32);
        }
        if let Some(seed) = self.seed {
            // The renderer pre-validates seed >= 0; clamp to 0
            // here as a defense-in-depth so a stray negative
            // value can't break the unsigned cast.
            let seed_u64 = if seed < 0 { 0 } else { seed as u64 };
            req = req.with_seed(seed_u64);
        }
        if let Some(neg) = &self.negative_prompt {
            req = req.with_negative_prompt(neg.clone());
        }

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| napi::Error::from_reason(format!("tokio runtime: {e}")))?;

        rt.block_on(async move { tessera_runtime::imagegen::generate_image(&endpoint, &req).await })
            .map_err(napi::Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(GenerateImageResult {
            png_bytes: output.png_bytes.into(),
            // Seed is u64 → JS BigInt. Using a plain Number would
            // truncate at 2^53, and seeds from sd-server are
            // legitimately full u64 values (uniform random).
            seed: napi::bindgen_prelude::BigInt {
                sign_bit: false,
                words: vec![output.seed],
            },
        })
    }
}

/// Generate an image via the sd-server (stable-diffusion.cpp)
/// sidecar.
///
/// `endpoint` is the sidecar base URL (e.g.
/// `http://127.0.0.1:8386`). The diffusion sidecar is only started
/// by the Electron main process on explicit user action (the
/// "Generate image" button) — see
/// `apps/desktop/electron/diffusionSidecar.ts` — so this bridge
/// will reject if the sidecar isn't running.
///
/// Optional `steps` / `cfg_scale` / `seed` / `negative_prompt`
/// override the FLUX.2-klein presets baked into `ImageGenRequest`.
/// Pass `null` / `undefined` to keep the defaults.
///
/// Returns a Promise resolving to `{ pngBytes: Buffer, seed:
/// BigInt }`. `pngBytes` is the raw PNG payload, ready to be
/// written to `<userData>/generated-images/<artifactId>/<n>.png`
/// by the IPC handler. The `seed` is the value sd-server actually
/// used (caller-supplied or server-chosen) so the artifact can
/// persist it for reproducibility.
#[napi]
pub fn bridge_generate_image(
    endpoint: String,
    request: GenerateImageInput,
) -> napi::Result<AsyncTask<GenerateImageTask>> {
    Ok(AsyncTask::new(GenerateImageTask {
        endpoint,
        prompt: request.prompt,
        width: request.width,
        height: request.height,
        steps: request.steps,
        cfg_scale: request.cfg_scale,
        seed: request.seed,
        negative_prompt: request.negative_prompt,
    }))
}
