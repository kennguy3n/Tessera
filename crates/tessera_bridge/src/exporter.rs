//! N-API surface for exporting artifacts to the supported formats.

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
/// In-memory result of an artifact export.
pub struct ExportResult {
    /// Exported document body in the requested format.
    pub content: String,
    /// Format the content was rendered in (`"pdf"`, `"docx"`, …).
    pub format: String,
}

/// Run an in-memory export for `artifact_id`.
///
/// `include_citations` controls whether the artifact's citations are
/// rendered into the export output. The flag is the authoritative
/// switch — every format exporter sees an empty citation slice when
/// it is `false`, so the export bytes and any caller-side audit row
/// recording "citations included? false" stay consistent.
pub fn export_artifact(
    artifact_manager: &ArtifactManager,
    citation_tracker: &CitationTracker,
    artifact_id: &str,
    format: &str,
    content_override: Option<&str>,
    include_citations: bool,
) -> BridgeResult<ExportResult> {
    let uuid =
        uuid::Uuid::parse_str(artifact_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let mut artifact = artifact_manager
        .get(&ArtifactId(uuid))
        .map_err(BridgeError::Core)?;

    // Apply an in-memory content override (used by the renderer to feed
    // pre-processed content — e.g. icons resolved into inline SVG — into the
    // export pipeline without ever persisting the rewrite into the store).
    if let Some(override_content) = content_override {
        artifact.content = override_content.to_string();
    }

    let export_format: ExportFormat = serde_json::from_str(&format!("\"{format}\""))
        .map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;

    let citations: Vec<Citation> = citation_tracker
        .list_for_artifact(&ArtifactId(uuid))
        .map_err(BridgeError::Core)?;

    let content = exporter::export(&artifact, &citations, export_format, include_citations)
        .map_err(BridgeError::Core)?;

    Ok(ExportResult {
        content,
        format: format.to_string(),
    })
}

/// Binary-aware variant of [`export_artifact`]. Same
/// `include_citations` semantics — the flag is propagated through to
/// the format exporter so the citation list is suppressed at the
/// dispatch layer when the caller opts out.
pub fn export_artifact_to_file(
    artifact_manager: &ArtifactManager,
    citation_tracker: &CitationTracker,
    artifact_id: &str,
    format: &str,
    path: &str,
    content_override: Option<&str>,
    include_citations: bool,
) -> BridgeResult<()> {
    let uuid =
        uuid::Uuid::parse_str(artifact_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let mut artifact = artifact_manager
        .get(&ArtifactId(uuid))
        .map_err(BridgeError::Core)?;

    if let Some(override_content) = content_override {
        artifact.content = override_content.to_string();
    }

    let export_format: ExportFormat = serde_json::from_str(&format!("\"{format}\""))
        .map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;

    let citations: Vec<Citation> = citation_tracker
        .list_for_artifact(&ArtifactId(uuid))
        .map_err(BridgeError::Core)?;

    exporter::export_to_file(
        &artifact,
        &citations,
        export_format,
        std::path::Path::new(path),
        include_citations,
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
        let tracker = CitationTracker::new_in_memory().unwrap();
        let artifact = manager
            .create("Test Document".to_string(), ArtifactType::Document, None)
            .unwrap();

        let result = export_artifact(
            &manager,
            &tracker,
            &artifact.id.to_string(),
            "markdown",
            None,
            true,
        )
        .unwrap();
        assert!(result.content.contains("# Test Document"));
        assert_eq!(result.format, "markdown");
    }

    #[test]
    fn bridge_export_with_content_override_does_not_mutate_store() {
        let manager = ArtifactManager::new_in_memory().unwrap();
        let tracker = CitationTracker::new_in_memory().unwrap();
        let artifact = manager
            .create("Original".to_string(), ArtifactType::Document, None)
            .unwrap();
        manager
            .update_content(
                &artifact.id,
                "Original body with {{icon:lucide:home}} token.".to_string(),
            )
            .unwrap();

        let override_body = "Pre-rendered body with <svg>...</svg>.";
        let exported = export_artifact(
            &manager,
            &tracker,
            &artifact.id.to_string(),
            "markdown",
            Some(override_body),
            true,
        )
        .unwrap();
        assert!(exported.content.contains("<svg>"));

        // Stored content must be untouched after the override-driven export.
        let still = manager.get(&artifact.id).unwrap();
        assert!(still.content.contains("{{icon:lucide:home}}"));
        assert!(!still.content.contains("<svg>"));
    }

    #[test]
    fn bridge_export_html() {
        let manager = ArtifactManager::new_in_memory().unwrap();
        let tracker = CitationTracker::new_in_memory().unwrap();
        let artifact = manager
            .create("Test".to_string(), ArtifactType::Document, None)
            .unwrap();

        let result = export_artifact(
            &manager,
            &tracker,
            &artifact.id.to_string(),
            "html",
            None,
            true,
        )
        .unwrap();
        assert!(result.content.contains("<html"));
    }

    #[test]
    fn bridge_export_to_file() {
        let dir = tempfile::tempdir().unwrap();
        let manager = ArtifactManager::new_in_memory().unwrap();
        let tracker = CitationTracker::new_in_memory().unwrap();
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
            None,
            true,
        )
        .unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("# Test"));
    }

    #[test]
    fn bridge_export_docx_to_file() {
        let dir = tempfile::tempdir().unwrap();
        let manager = ArtifactManager::new_in_memory().unwrap();
        let tracker = CitationTracker::new_in_memory().unwrap();
        let artifact = manager
            .create("Docx Test".to_string(), ArtifactType::Document, None)
            .unwrap();

        let path = dir.path().join("output.docx");
        export_artifact_to_file(
            &manager,
            &tracker,
            &artifact.id.to_string(),
            "docx",
            path.to_str().unwrap(),
            None,
            true,
        )
        .unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..4], b"PK\x03\x04", "DOCX missing PK header");
    }

    #[test]
    fn bridge_export_xlsx_to_file() {
        let dir = tempfile::tempdir().unwrap();
        let manager = ArtifactManager::new_in_memory().unwrap();
        let tracker = CitationTracker::new_in_memory().unwrap();
        let artifact = manager
            .create("Xlsx Test".to_string(), ArtifactType::Sheet, None)
            .unwrap();

        let path = dir.path().join("output.xlsx");
        export_artifact_to_file(
            &manager,
            &tracker,
            &artifact.id.to_string(),
            "xlsx",
            path.to_str().unwrap(),
            None,
            true,
        )
        .unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..4], b"PK\x03\x04", "XLSX missing PK header");
    }
}
