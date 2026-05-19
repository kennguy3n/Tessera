use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tessera_artifacts::manager::ArtifactManager;
use tessera_citations::citation::Citation;
use tessera_citations::tracker::CitationTracker;
use tessera_core::{ArtifactId, ExportFormat};
use tessera_export::exporter;

use crate::{BridgeError, BridgeResult};

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct ExportResult {
    pub content: String,
    pub format: String,
}

pub fn export_artifact(
    artifact_manager: &ArtifactManager,
    citation_tracker: &CitationTracker,
    artifact_id: &str,
    format: &str,
) -> BridgeResult<ExportResult> {
    let uuid = uuid::Uuid::parse_str(artifact_id)
        .map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let artifact = artifact_manager
        .get(&ArtifactId(uuid))
        .map_err(BridgeError::Core)?;

    let export_format: ExportFormat = serde_json::from_str(&format!("\"{format}\""))
        .map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;

    let citations: Vec<Citation> = citation_tracker
        .list_for_artifact(&ArtifactId(uuid))
        .into_iter()
        .cloned()
        .collect();

    let content =
        exporter::export(&artifact, &citations, export_format).map_err(BridgeError::Core)?;

    Ok(ExportResult {
        content,
        format: format.to_string(),
    })
}

pub fn export_artifact_to_file(
    artifact_manager: &ArtifactManager,
    citation_tracker: &CitationTracker,
    artifact_id: &str,
    format: &str,
    path: &str,
) -> BridgeResult<()> {
    let uuid = uuid::Uuid::parse_str(artifact_id)
        .map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let artifact = artifact_manager
        .get(&ArtifactId(uuid))
        .map_err(BridgeError::Core)?;

    let export_format: ExportFormat = serde_json::from_str(&format!("\"{format}\""))
        .map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;

    let citations: Vec<Citation> = citation_tracker
        .list_for_artifact(&ArtifactId(uuid))
        .into_iter()
        .cloned()
        .collect();

    exporter::export_to_file(
        &artifact,
        &citations,
        export_format,
        std::path::Path::new(path),
    )
    .map_err(BridgeError::Core)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::ArtifactType;

    #[test]
    fn bridge_export_markdown() {
        let manager = ArtifactManager::new_in_memory().unwrap();
        let tracker = CitationTracker::new();
        let artifact = manager
            .create("Test Document".to_string(), ArtifactType::Document, None)
            .unwrap();

        let result =
            export_artifact(&manager, &tracker, &artifact.id.to_string(), "markdown").unwrap();
        assert!(result.content.contains("# Test Document"));
        assert_eq!(result.format, "markdown");
    }

    #[test]
    fn bridge_export_html() {
        let manager = ArtifactManager::new_in_memory().unwrap();
        let tracker = CitationTracker::new();
        let artifact = manager
            .create("Test".to_string(), ArtifactType::Document, None)
            .unwrap();

        let result =
            export_artifact(&manager, &tracker, &artifact.id.to_string(), "html").unwrap();
        assert!(result.content.contains("<html"));
    }

    #[test]
    fn bridge_export_to_file() {
        let dir = tempfile::tempdir().unwrap();
        let manager = ArtifactManager::new_in_memory().unwrap();
        let tracker = CitationTracker::new();
        let artifact = manager
            .create("Test".to_string(), ArtifactType::Document, None)
            .unwrap();

        let path = dir.path().join("output.md");
        export_artifact_to_file(
            &manager,
            &tracker,
            &artifact.id.to_string(),
            "markdown",
            path.to_str().unwrap(),
        )
        .unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("# Test"));
    }
}
