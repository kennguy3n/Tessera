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

// --- Artifact Generation ---

#[napi]
pub fn bridge_generate_from_template(
    template_id: String,
    source_ids: Vec<String>,
) -> napi::Result<artifacts::ArtifactInfo> {
    let s = state()?;
    let audit = s
        .audit_logger
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
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

    let selected_source_set: std::collections::HashSet<String> =
        source_ids.into_iter().collect();

    let mut section_contents = Vec::new();
    for section in &template.sections {
        let hits = src_mgr
            .search(&section.prompt, 20)
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
            format!("## {}\n\n*No source material found for this section.*\n", section.title)
        } else {
            format!("## {}\n\n{}\n", section.title, context)
        };
        section_contents.push(content);
    }

    let full_content = section_contents.join("\n");
    let atype = template.artifact_type;
    let tid = tessera_core::TemplateId::from_string(&template_id);
    let art = art_mgr
        .create(template.name.clone(), atype, Some(tid))
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    art_mgr
        .update_content(&art.id, full_content)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let updated = art_mgr
        .get(&art.id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let _ = audit.log_artifact_created(&template.name);
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

    let chunks = src_mgr
        .get_chunks_for_source(&sid)
        .unwrap_or_default();

    let mut items: Vec<serde_json::Value> = Vec::new();
    let task_patterns = [
        "action item", "todo", "must", "should", "need to", "will",
        "responsible for", "assigned to", "deadline", "by end of",
    ];
    let decision_patterns = [
        "decided", "agreed", "approved", "resolved", "conclusion",
        "recommendation", "determined", "we will", "going forward",
    ];

    for chunk in &chunks {
        let lower = chunk.to_lowercase();
        for sentence in lower.split('.') {
            let trimmed = sentence.trim();
            if trimmed.len() < 10 { continue; }
            let is_task = task_patterns.iter().any(|p| trimmed.contains(p));
            let is_decision = decision_patterns.iter().any(|p| trimmed.contains(p));
            if is_task {
                items.push(serde_json::json!({
                    "itemType": "task",
                    "text": trimmed,
                    "sourceCitation": source_id,
                    "confidence": 0.7
                }));
            } else if is_decision {
                items.push(serde_json::json!({
                    "itemType": "decision",
                    "text": trimmed,
                    "sourceCitation": source_id,
                    "confidence": 0.7
                }));
            }
        }
    }

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

    let text_a = chunks_a.join("\n");
    let text_b = chunks_b.join("\n");

    let words_a: std::collections::HashSet<&str> = text_a.split_whitespace().collect();
    let words_b: std::collections::HashSet<&str> = text_b.split_whitespace().collect();
    let common: Vec<&&str> = words_a.intersection(&words_b).take(50).collect();
    let only_a: Vec<&&str> = words_a.difference(&words_b).take(20).collect();
    let only_b: Vec<&&str> = words_b.difference(&words_a).take(20).collect();

    let content = format!(
        "# Source Comparison\n\n## Common Themes\n{}\n\n## Unique to Source A\n{}\n\n## Unique to Source B\n{}\n",
        common.iter().map(|w| format!("- {w}")).collect::<Vec<_>>().join("\n"),
        only_a.iter().map(|w| format!("- {w}")).collect::<Vec<_>>().join("\n"),
        only_b.iter().map(|w| format!("- {w}")).collect::<Vec<_>>().join("\n"),
    );

    let art = art_mgr
        .create("Source Comparison".to_string(), tessera_core::ArtifactType::Document, None)
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

    let citation_list = tracker
        .list_for_artifact(&aid)
        .unwrap_or_default();

    let file = std::fs::File::create(&output_path)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("artifact.md", options)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    std::io::Write::write_all(&mut zip, artifact.content.as_bytes())
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let citations_json = serde_json::to_string_pretty(&citation_list)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    zip.start_file("citations.json", options)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    std::io::Write::write_all(&mut zip, citations_json.as_bytes())
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    zip.finish()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    Ok(output_path)
}
