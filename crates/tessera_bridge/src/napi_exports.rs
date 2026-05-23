use std::sync::Mutex;

use napi_derive::napi;

use tessera_artifacts::automations::AutomationStore;
use tessera_artifacts::manager::ArtifactManager;
use tessera_artifacts::tasks::TaskStore;
use tessera_audit::logger::AuditLogger;
use tessera_citations::tracker::CitationTracker;
use tessera_core::open_shared_with_key;
use tessera_sources::manager::SourceManager;

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
// If async work is added in the future, acquire locks in this order:
// 1. audit_logger → 2. source_manager → 3. artifact_manager → 4. citation_tracker
// → 5. task_store → 6. automation_store
// (audit_logger first so every other path can log under its lock; task_store
// and automation_store are leaf locks — nothing else acquires them.)
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

    APP_STATE
        .set(AppState {
            source_manager: Mutex::new(source_manager),
            artifact_manager: Mutex::new(artifact_manager),
            audit_logger: Mutex::new(audit_logger),
            citation_tracker: Mutex::new(citation_tracker),
            task_store: Mutex::new(task_store),
            automation_store: Mutex::new(automation_store),
            template_dir,
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
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_source_added(&path);
    }
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::add_local_folder(&mgr, &path).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn bridge_add_local_file(path: String) -> napi::Result<sources::SourceInfo> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_source_added(&path);
    }
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::add_local_file(&mgr, &path).map_err(|e| napi::Error::from_reason(e.to_string()))
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
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_source_removed(&source_id);
    }
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::remove_source(&mgr, &source_id).map_err(|e| napi::Error::from_reason(e.to_string()))
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
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_source_reindexed(&source_id);
    }
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::reindex_source(&mgr, &source_id).map_err(|e| napi::Error::from_reason(e.to_string()))
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

// --- Artifacts ---

#[napi]
pub fn bridge_create_artifact(
    title: String,
    artifact_type: String,
    template_id: Option<String>,
) -> napi::Result<artifacts::ArtifactInfo> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_artifact_created(&title);
    }
    let mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    artifacts::create_artifact(&mgr, &title, &artifact_type, template_id.as_deref())
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn bridge_update_artifact_content(
    artifact_id: String,
    content: String,
) -> napi::Result<artifacts::ArtifactInfo> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_artifact_updated(&artifact_id);
    }
    let mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    artifacts::update_artifact_content(&mgr, &artifact_id, &content)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
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
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_artifact_deleted(&artifact_id);
    }
    let mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    artifacts::delete_artifact(&mgr, &artifact_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

// --- Export ---

#[napi]
pub fn bridge_export_artifact(
    artifact_id: String,
    format: String,
    content_override: Option<String>,
) -> napi::Result<exporter::ExportResult> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_artifact_exported(&artifact_id, &format);
    }
    let art_mgr = s
        .artifact_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let tracker = s
        .citation_tracker
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    exporter::export_artifact(
        &art_mgr,
        &tracker,
        &artifact_id,
        &format,
        content_override.as_deref(),
    )
    .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn bridge_export_artifact_to_file(
    artifact_id: String,
    format: String,
    path: String,
    content_override: Option<String>,
) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_artifact_exported(&artifact_id, &format);
    }
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
    .map_err(|e| napi::Error::from_reason(e.to_string()))
}

// --- Templates ---

#[napi]
pub fn bridge_list_templates() -> napi::Result<Vec<templates::TemplateInfo>> {
    let s = state()?;
    templates::list_templates(&s.template_dir).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn bridge_get_template(template_id: String) -> napi::Result<Option<templates::TemplateInfo>> {
    let s = state()?;
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
    // Drop the per-store locks before acquiring the audit logger to
    // keep the documented lock-acquisition order one-way (logger →
    // source → artifact → citation). Logging after the citation has
    // been persisted means a failed audit append never rolls back
    // the user-visible citation.
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
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_citation_removed(&artifact_id, &citation_id);
    }
    let mut tracker = s
        .citation_tracker
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    citations::remove_citation(&mut tracker, &artifact_id, &citation_id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
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
    // Version restore is semantically an artifact update — the
    // content snapshot at `version_number` is rewritten into the
    // canonical artifact row. Audit it as `ArtifactUpdated` so a
    // future compliance review sees the lineage ("this artifact was
    // rolled back at <time>") rather than a silent overwrite.
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_artifact_updated(&artifact_id);
    }
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
    Ok(artifacts::artifact_to_info(&restored))
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

    let uuid_a =
        uuid::Uuid::parse_str(&source_id_a).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let uuid_b =
        uuid::Uuid::parse_str(&source_id_b).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let sid_a = tessera_core::SourceId(uuid_a);
    let sid_b = tessera_core::SourceId(uuid_b);

    let chunks_a = src_mgr.get_chunks_for_source(&sid_a).unwrap_or_default();
    let chunks_b = src_mgr.get_chunks_for_source(&sid_b).unwrap_or_default();

    let result = tessera_artifacts::comparison::compare_sources(&chunks_a, &chunks_b);
    let content = result.to_markdown("Source A", "Source B");

    // Audit the comparison-artifact creation under the same
    // `ArtifactCreated` event type used by `bridge_create_artifact`
    // so reports counting created artifacts don't undercount
    // comparison results.
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_artifact_created("Source Comparison");
    }
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
    Ok(artifacts::artifact_to_info(&updated))
}

#[napi]
pub fn bridge_export_evidence_pack(
    artifact_id: String,
    output_path: String,
) -> napi::Result<String> {
    let s = state()?;
    // The evidence pack is a ZIP export — record it under the
    // shared `ArtifactExported` event type so an auditor sees every
    // form of export (file format + evidence pack) in one query.
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_artifact_exported(&artifact_id, "evidence_pack");
    }
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

    tessera_export::evidence_pack::build_evidence_pack(&artifact, &citation_list, &output_path)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
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
pub fn bridge_log_connector_disconnected(
    provider: String,
    files_removed: u32,
) -> napi::Result<()> {
    let s = state()?;
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_connector_disconnected(&provider, files_removed as usize);
    }
    Ok(())
}
