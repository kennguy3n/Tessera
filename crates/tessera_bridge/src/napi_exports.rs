use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;

use tessera_artifacts::automations::AutomationStore;
use tessera_artifacts::manager::ArtifactManager;
use tessera_artifacts::tasks::TaskStore;
use tessera_audit::logger::AuditLogger;
use tessera_citations::tracker::CitationTracker;
use tessera_core::open_shared_with_key;
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
}

/// Initialise the bridge. `db_key`, when non-empty, is a 64-character
/// hex string holding the raw SQLCipher key derived by
/// `apps/desktop/electron/dbKey.ts` (random 32 bytes, persisted on disk
/// wrapped by `safeStorage`). When `db_key` is empty or `None`, the
/// database is opened unencrypted — this path exists for testing and
/// for headless environments where Electron's `safeStorage` is
/// unavailable and the renderer chose not to prompt for a fallback
/// password (see WS10).
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

    let source_manager = SourceManager::with_shared_conn(conn.clone(), &[])
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let artifact_manager = ArtifactManager::with_shared_conn(conn.clone())
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let audit_logger = AuditLogger::with_shared_conn(conn.clone())
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let citation_tracker = CitationTracker::with_shared_conn(conn.clone())
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let task_store = TaskStore::with_shared_conn(conn.clone())
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let automation_store = AutomationStore::with_shared_conn(conn)
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
        })
        .map_err(|_| napi::Error::from_reason("Bridge already initialized"))?;

    Ok(())
}

fn state() -> napi::Result<&'static AppState> {
    APP_STATE
        .get()
        .ok_or_else(|| napi::Error::from_reason("Bridge not initialized. Call init_bridge first."))
}

// --- Sources ---

#[napi]
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

#[napi]
pub fn bridge_list_sources() -> napi::Result<Vec<sources::SourceInfo>> {
    let s = state()?;
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::list_sources(&mgr).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
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

#[napi]
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

#[napi]
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

// --- Artifacts ---

#[napi]
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
pub fn bridge_get_artifact(artifact_id: String) -> napi::Result<artifacts::ArtifactInfo> {
    let s = state()?;
    let mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    artifacts::get_artifact(&mgr, &artifact_id).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn bridge_list_artifacts() -> napi::Result<Vec<artifacts::ArtifactInfo>> {
    let s = state()?;
    let mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    artifacts::list_artifacts(&mgr).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
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

#[napi]
pub fn bridge_export_artifact(
    artifact_id: String,
    format: String,
    content_override: Option<String>,
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

#[napi]
pub fn bridge_export_artifact_to_file(
    artifact_id: String,
    format: String,
    path: String,
    content_override: Option<String>,
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
pub fn bridge_list_templates() -> napi::Result<Vec<templates::TemplateInfo>> {
    let s = state()?;
    // Phase 10 / Task 28: route every parse / validation failure
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
        // Devin Review ANALYSIS_0003: two sources sharing the same
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

// --- Tasks ---

#[napi]
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
pub fn bridge_list_tasks() -> napi::Result<Vec<tasks::TaskInfo>> {
    let s = state()?;
    let store = s
        .task_store
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    tasks::list_tasks(&store).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn bridge_get_task(task_id: String) -> napi::Result<Option<tasks::TaskInfo>> {
    let s = state()?;
    let store = s
        .task_store
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    tasks::get_task(&store, &task_id).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
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
pub fn bridge_delete_task(task_id: String) -> napi::Result<bool> {
    let s = state()?;
    let store = s
        .task_store
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    tasks::delete_task(&store, &task_id).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
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
pub fn bridge_list_automations() -> napi::Result<Vec<automations::AutomationInfo>> {
    let s = state()?;
    let store = s
        .automation_store
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    automations::list_automations(&store).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
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

// --- Audit pass-throughs (Phase 10 / Task 17) ---
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
