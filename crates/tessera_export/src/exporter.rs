use tessera_artifacts::Artifact;
use tessera_citations::citation::Citation;
use tessera_core::error::{Error, Result};
use tessera_core::ExportFormat;

use crate::csv::export_csv;
use crate::html::export_html;
use crate::markdown::export_markdown;

pub fn export(artifact: &Artifact, citations: &[Citation], format: ExportFormat) -> Result<String> {
    match format {
        ExportFormat::Markdown => Ok(export_markdown(artifact, citations)),
        ExportFormat::Html => Ok(export_html(artifact, citations)),
        ExportFormat::Csv => Ok(export_csv(artifact, citations)),
        ExportFormat::Json => {
            serde_json::to_string_pretty(artifact).map_err(|e| Error::Export(e.to_string()))
        }
        other => Err(Error::Export(format!(
            "export format {other:?} not yet implemented"
        ))),
    }
}

pub fn export_to_file(
    artifact: &Artifact,
    citations: &[Citation],
    format: ExportFormat,
    path: &std::path::Path,
) -> Result<()> {
    let content = export(artifact, citations, format)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_artifacts::Artifact;
    use tessera_core::ArtifactType;

    #[test]
    fn export_markdown_format() {
        let artifact = Artifact::new("Test".to_string(), ArtifactType::Document, None);
        let result = export(&artifact, &[], ExportFormat::Markdown).unwrap();
        assert!(result.contains("# Test"));
    }

    #[test]
    fn export_html_format() {
        let artifact = Artifact::new("Test".to_string(), ArtifactType::Document, None);
        let result = export(&artifact, &[], ExportFormat::Html).unwrap();
        assert!(result.contains("<html"));
    }

    #[test]
    fn export_csv_format() {
        let artifact = Artifact::new("Test".to_string(), ArtifactType::Sheet, None);
        let result = export(&artifact, &[], ExportFormat::Csv).unwrap();
        assert!(result.contains("title,type"));
    }

    #[test]
    fn export_json_format() {
        let artifact = Artifact::new("Test".to_string(), ArtifactType::Document, None);
        let result = export(&artifact, &[], ExportFormat::Json).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["title"], "Test");
    }

    #[test]
    fn export_to_file_works() {
        let dir = tempfile::tempdir().unwrap();
        let artifact = Artifact::new("Test".to_string(), ArtifactType::Document, None);
        let path = dir.path().join("output.md");
        export_to_file(&artifact, &[], ExportFormat::Markdown, &path).unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("# Test"));
    }

    #[test]
    fn unsupported_format_returns_error() {
        let artifact = Artifact::new("Test".to_string(), ArtifactType::Document, None);
        let result = export(&artifact, &[], ExportFormat::Pdf);
        assert!(result.is_err());
    }
}
