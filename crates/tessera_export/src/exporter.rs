use tessera_artifacts::Artifact;
use tessera_citations::citation::Citation;
use tessera_core::error::{Error, Result};
use tessera_core::ExportFormat;

use crate::csv::export_csv;
use crate::html::export_html;
use crate::markdown::export_markdown;
use crate::pdf::export_pdf;

#[cfg(feature = "docx")]
use crate::docx::export_docx;
#[cfg(feature = "xlsx")]
use crate::xlsx::export_xlsx;

pub fn export(artifact: &Artifact, citations: &[Citation], format: ExportFormat) -> Result<String> {
    match format {
        ExportFormat::Markdown => Ok(export_markdown(artifact, citations)),
        ExportFormat::Html => Ok(export_html(artifact, citations)),
        ExportFormat::Csv => Ok(export_csv(artifact, citations)),
        ExportFormat::Json => {
            serde_json::to_string_pretty(artifact).map_err(|e| Error::Export(e.to_string()))
        }
        ExportFormat::Pdf | ExportFormat::Docx | ExportFormat::Xlsx | ExportFormat::Pptx => {
            Err(Error::Export(format!(
                "{format:?} export produces binary output; use export_to_file() instead"
            )))
        }
    }
}

pub fn export_to_file(
    artifact: &Artifact,
    citations: &[Citation],
    format: ExportFormat,
    path: &std::path::Path,
) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match format {
        ExportFormat::Pdf => {
            std::fs::write(path, export_pdf(artifact, citations))?;
        }
        #[cfg(feature = "docx")]
        ExportFormat::Docx => {
            std::fs::write(path, export_docx(artifact, citations))?;
        }
        #[cfg(not(feature = "docx"))]
        ExportFormat::Docx => {
            return Err(Error::Export(
                "DOCX export requires the `docx` feature".to_string(),
            ));
        }
        #[cfg(feature = "xlsx")]
        ExportFormat::Xlsx => {
            std::fs::write(path, export_xlsx(artifact))?;
        }
        #[cfg(not(feature = "xlsx"))]
        ExportFormat::Xlsx => {
            return Err(Error::Export(
                "XLSX export requires the `xlsx` feature".to_string(),
            ));
        }
        ExportFormat::Pptx => {
            return Err(Error::Export(
                "PPTX export is handled by the Marp CLI in the desktop app (electron/marpExport.ts), not the Rust core"
                    .to_string(),
            ));
        }
        other => {
            let content = export(artifact, citations, other)?;
            std::fs::write(path, content)?;
        }
    }
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
    fn pdf_string_export_returns_error_directing_to_file() {
        let artifact = Artifact::new("Test".to_string(), ArtifactType::Document, None);
        let result = export(&artifact, &[], ExportFormat::Pdf);
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(err_msg.contains("export_to_file"));
    }

    #[test]
    fn pdf_export_to_file_works() {
        let dir = tempfile::tempdir().unwrap();
        let artifact = Artifact::new("PDF Test".to_string(), ArtifactType::Document, None);
        let path = dir.path().join("output.pdf");
        export_to_file(&artifact, &[], ExportFormat::Pdf, &path).unwrap();
        let content = std::fs::read(&path).unwrap();
        assert!(content.starts_with(b"%PDF-1.4"));
    }

    #[cfg(feature = "docx")]
    #[test]
    fn docx_export_to_file_works() {
        let dir = tempfile::tempdir().unwrap();
        let artifact = Artifact::new("DOCX Test".to_string(), ArtifactType::Document, None);
        let path = dir.path().join("output.docx");
        export_to_file(&artifact, &[], ExportFormat::Docx, &path).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..4], b"PK\x03\x04");
    }

    #[cfg(feature = "xlsx")]
    #[test]
    fn xlsx_export_to_file_works() {
        let dir = tempfile::tempdir().unwrap();
        let artifact = Artifact::new("XLSX Test".to_string(), ArtifactType::Sheet, None);
        let path = dir.path().join("output.xlsx");
        export_to_file(&artifact, &[], ExportFormat::Xlsx, &path).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..4], b"PK\x03\x04");
    }

    #[test]
    fn pptx_export_to_file_returns_helpful_error() {
        let dir = tempfile::tempdir().unwrap();
        let artifact = Artifact::new("PPTX".to_string(), ArtifactType::Slides, None);
        let path = dir.path().join("output.pptx");
        let err = export_to_file(&artifact, &[], ExportFormat::Pptx, &path).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("Marp"));
    }
}
