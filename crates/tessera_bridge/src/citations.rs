use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tessera_citations::citation::Citation;
use tessera_citations::tracker::CitationTracker;
use tessera_core::{ArtifactId, CitationId, SourceId, SourceType};
use tessera_sources::manager::SourceManager;

use crate::{BridgeError, BridgeResult};

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct CitationInfo {
    pub citation_id: String,
    pub source_id: String,
    pub source_type: String,
    pub source_title: String,
    pub source_uri: String,
    pub chunk_hash: String,
    pub page: Option<u32>,
    pub confidence: f64,
    pub used_for: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[napi(object)]
pub struct AddCitationRequest {
    pub artifact_id: String,
    pub source_id: String,
    pub source_type: String,
    pub source_title: String,
    pub source_uri: String,
    pub chunk_hash: String,
    pub page: Option<u32>,
    pub confidence: f64,
    pub used_for: String,
}

impl From<&Citation> for CitationInfo {
    fn from(c: &Citation) -> Self {
        Self {
            citation_id: c.citation_id.to_string(),
            source_id: c.source_id.to_string(),
            source_type: c.source_type.to_string(),
            source_title: c.source_title.clone(),
            source_uri: c.source_uri.clone(),
            chunk_hash: c.chunk_hash.clone(),
            page: c.page,
            confidence: c.confidence,
            used_for: c.used_for.clone(),
            created_at: c.created_at.to_rfc3339(),
        }
    }
}

pub fn list_citations(
    tracker: &CitationTracker,
    artifact_id: &str,
) -> BridgeResult<Vec<CitationInfo>> {
    let uuid =
        uuid::Uuid::parse_str(artifact_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let citations = tracker.list_for_artifact(&ArtifactId(uuid));
    Ok(citations.iter().map(|c| CitationInfo::from(*c)).collect())
}

pub fn add_citation(
    tracker: &mut CitationTracker,
    source_manager: &SourceManager,
    req: AddCitationRequest,
) -> BridgeResult<CitationInfo> {
    let artifact_uuid = uuid::Uuid::parse_str(&req.artifact_id)
        .map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let source_uuid = uuid::Uuid::parse_str(&req.source_id)
        .map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let source_type: SourceType = serde_json::from_str(&format!("\"{}\"", req.source_type))
        .map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;

    // Look up the file-level hash at citation creation time for change detection
    let source_file_hash = source_manager
        .get_current_file_hash(&req.source_uri)
        .map_err(BridgeError::Core)?
        .unwrap_or_default();

    let mut citation = Citation::new(
        SourceId(source_uuid),
        source_type,
        req.source_title,
        req.source_uri,
        req.chunk_hash,
        source_file_hash,
        req.used_for,
        req.confidence,
    );
    if let Some(page) = req.page {
        citation = citation.with_page(page);
    }

    let cid = tracker.add(ArtifactId(artifact_uuid), citation.clone());
    let stored = tracker.get(&cid).unwrap();
    Ok(CitationInfo::from(stored))
}

pub fn remove_citation(
    tracker: &mut CitationTracker,
    artifact_id: &str,
    citation_id: &str,
) -> BridgeResult<()> {
    let artifact_uuid =
        uuid::Uuid::parse_str(artifact_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let citation_uuid =
        uuid::Uuid::parse_str(citation_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    tracker.remove(&ArtifactId(artifact_uuid), &CitationId(citation_uuid));
    Ok(())
}

pub fn check_source_changed(
    tracker: &CitationTracker,
    source_manager: &SourceManager,
    citation_id: &str,
) -> BridgeResult<bool> {
    let citation_uuid =
        uuid::Uuid::parse_str(citation_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let citation = tracker
        .get(&CitationId(citation_uuid))
        .ok_or_else(|| BridgeError::InvalidArgs("Citation not found".to_string()))?;

    let current_hash = source_manager
        .get_current_file_hash(&citation.source_uri)
        .map_err(BridgeError::Core)?;

    match current_hash {
        Some(hash) => Ok(citation.source_changed(&hash)),
        None => Ok(true), // file no longer indexed = treat as changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_add_and_list_citations() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let source_mgr = SourceManager::new(db_path.to_str().unwrap(), &[]).unwrap();

        let mut tracker = CitationTracker::new();
        let aid = ArtifactId::new();

        let req = AddCitationRequest {
            artifact_id: aid.to_string(),
            source_id: SourceId::new().to_string(),
            source_type: "local_file".to_string(),
            source_title: "test.pdf".to_string(),
            source_uri: "file:///test.pdf".to_string(),
            chunk_hash: "hash123".to_string(),
            page: Some(1),
            confidence: 0.9,
            used_for: "Problem Statement".to_string(),
        };

        let info = add_citation(&mut tracker, &source_mgr, req).unwrap();
        assert_eq!(info.source_title, "test.pdf");
        assert_eq!(info.page, Some(1));

        let citations = list_citations(&tracker, &aid.to_string()).unwrap();
        assert_eq!(citations.len(), 1);
    }

    #[test]
    fn bridge_remove_citation() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let source_mgr = SourceManager::new(db_path.to_str().unwrap(), &[]).unwrap();

        let mut tracker = CitationTracker::new();
        let aid = ArtifactId::new();

        let req = AddCitationRequest {
            artifact_id: aid.to_string(),
            source_id: SourceId::new().to_string(),
            source_type: "local_file".to_string(),
            source_title: "test.pdf".to_string(),
            source_uri: "file:///test.pdf".to_string(),
            chunk_hash: "hash123".to_string(),
            page: None,
            confidence: 0.85,
            used_for: "Test".to_string(),
        };

        let info = add_citation(&mut tracker, &source_mgr, req).unwrap();
        remove_citation(&mut tracker, &aid.to_string(), &info.citation_id).unwrap();

        let citations = list_citations(&tracker, &aid.to_string()).unwrap();
        assert!(citations.is_empty());
    }

    #[test]
    fn bridge_check_source_changed() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let test_file = dir.path().join("test.txt");
        std::fs::write(&test_file, "test content").unwrap();

        let source_mgr = SourceManager::new(db_path.to_str().unwrap(), &[]).unwrap();
        let source = source_mgr
            .add_local_file(test_file.to_str().unwrap())
            .unwrap();

        let mut tracker = CitationTracker::new();
        let aid = ArtifactId::new();

        // The indexed file hash is the hash stored by the source manager
        let files = source_mgr.list_indexed_files(&source.id).unwrap();
        let file_hash = &files[0].hash;

        let req = AddCitationRequest {
            artifact_id: aid.to_string(),
            source_id: source.id.to_string(),
            source_type: "local_file".to_string(),
            source_title: "test.pdf".to_string(),
            source_uri: test_file.to_str().unwrap().to_string(),
            chunk_hash: file_hash.clone(),
            page: None,
            confidence: 0.85,
            used_for: "Test".to_string(),
        };

        let info = add_citation(&mut tracker, &source_mgr, req).unwrap();
        // File hash matches indexed file — not changed
        assert!(!check_source_changed(&tracker, &source_mgr, &info.citation_id).unwrap());

        // Change the file and reindex so hash differs
        std::fs::write(&test_file, "modified content").unwrap();
        source_mgr.reindex_source(&source.id).unwrap();
        assert!(check_source_changed(&tracker, &source_mgr, &info.citation_id).unwrap());
    }
}
