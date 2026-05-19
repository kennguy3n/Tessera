use std::sync::Mutex;

use napi_derive::napi;

use tessera_artifacts::manager::ArtifactManager;
use tessera_audit::logger::AuditLogger;
use tessera_citations::tracker::CitationTracker;
use tessera_sources::manager::SourceManager;

use crate::artifacts;
use crate::citations;
use crate::exporter;
use crate::sources;
use crate::templates;

static APP_STATE: std::sync::OnceLock<AppState> = std::sync::OnceLock::new();

// N-API callbacks are single-threaded (main thread only), so deadlocks from
// concurrent lock acquisition cannot occur. Mutexes provide interior mutability.
// If async work is added in the future, acquire locks in this order:
// 1. audit_logger → 2. source_manager → 3. artifact_manager → 4. citation_tracker
struct AppState {
    source_manager: Mutex<SourceManager>,
    artifact_manager: Mutex<ArtifactManager>,
    audit_logger: Mutex<AuditLogger>,
    citation_tracker: Mutex<CitationTracker>,
    template_dir: String,
}

#[napi]
pub fn init_bridge(db_path: String, template_dir: String) -> napi::Result<()> {
    let source_manager =
        SourceManager::new(&db_path, &[]).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let artifact_manager =
        ArtifactManager::new(&db_path).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let audit_logger =
        AuditLogger::new(&db_path).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let citation_tracker =
        CitationTracker::new(&db_path).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let citation_tracker = Mutex::new(citation_tracker);

    APP_STATE
        .set(AppState {
            source_manager: Mutex::new(source_manager),
            artifact_manager: Mutex::new(artifact_manager),
            audit_logger: Mutex::new(audit_logger),
            citation_tracker,
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
    let mgr = s
        .source_manager
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    sources::reindex_source(&mgr, &source_id).map_err(|e| napi::Error::from_reason(e.to_string()))
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
    if let Ok(logger) = s.audit_logger.lock() {
        let _ = logger.log_artifact_exported(&artifact_id, &format);
    }
    exporter::export_artifact(&art_mgr, &tracker, &artifact_id, &format)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn bridge_export_artifact_to_file(
    artifact_id: String,
    format: String,
    path: String,
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
    exporter::export_artifact_to_file(&art_mgr, &tracker, &artifact_id, &format, &path)
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
    Ok(artifacts::artifact_to_info(&restored))
}
