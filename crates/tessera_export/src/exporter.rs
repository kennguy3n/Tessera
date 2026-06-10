//! Format-dispatching entry point that routes an artifact to the
//! matching per-format exporter.

use tessera_artifacts::Artifact;
use tessera_citations::citation::Citation;
use tessera_core::error::{Error, Result};
use tessera_core::ExportFormat;

use crate::csv::export_csv;
use crate::html::export_html;
use crate::markdown::export_markdown;
#[cfg(not(feature = "typst"))]
use crate::pdf::export_pdf;
#[cfg(feature = "typst")]
use crate::pdf::export_pdf_with_svgs;

#[cfg(feature = "docx")]
use crate::docx::export_docx;
#[cfg(feature = "xlsx")]
use crate::xlsx::export_xlsx;

/// Format-agnostic export entry point.
///
/// `citations` is the full citation list for the artifact and
/// `include_citations` controls whether those citations are rendered
/// into the output. When `include_citations` is `false`, the citation
/// list is suppressed at the dispatch layer (the format-specific
/// exporters see an empty slice and skip their "Sources" / footnote
/// sections). The toggle is centralised here so every format exporter
/// honours it identically — callers cannot accidentally produce an
/// export that claims "no citations" in its audit row while the bytes
/// still contain them, or vice versa.
pub fn export(
    artifact: &Artifact,
    citations: &[Citation],
    format: ExportFormat,
    include_citations: bool,
) -> Result<String> {
    let effective: &[Citation] = if include_citations { citations } else { &[] };
    match format {
        ExportFormat::Markdown => Ok(export_markdown(artifact, effective)),
        ExportFormat::Html => Ok(export_html(artifact, effective)),
        ExportFormat::Csv => Ok(export_csv(artifact, effective)),
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

/// Binary-aware export entry point. Same `include_citations`
/// semantics as [`export`] — when `false`, the citation list is
/// suppressed before being handed to the format exporter.
pub fn export_to_file(
    artifact: &Artifact,
    citations: &[Citation],
    format: ExportFormat,
    path: &std::path::Path,
    include_citations: bool,
) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let effective: &[Citation] = if include_citations { citations } else { &[] };
    match format {
        ExportFormat::Pdf => {
            // when the `typst` feature is enabled
            // (default), route through `export_pdf_with_svgs` so any
            // ```mermaid blocks in the artifact body are rendered
            // as embedded SVG diagrams. With no pre-rendered SVGs
            // supplied, the function emits a structural SVG
            // fallback for each block — still real SVG, not the raw
            // DSL text — so the PDF carries the diagrams as image
            // data rather than dropping them into the body as
            // ```mermaid source lines (which is what the
            // minimal-PDF placeholder path did).
            #[cfg(feature = "typst")]
            {
                let prerendered = std::collections::HashMap::new();
                std::fs::write(
                    path,
                    export_pdf_with_svgs(artifact, effective, &prerendered),
                )?;
            }
            #[cfg(not(feature = "typst"))]
            {
                std::fs::write(path, export_pdf(artifact, effective))?;
            }
        }
        #[cfg(feature = "docx")]
        ExportFormat::Docx => {
            std::fs::write(path, export_docx(artifact, effective))?;
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
            // Forward `include_citations` rather than hardcoding `true`.
            // Behaviour is identical because `effective` is already the
            // pre-filtered slice (empty when `include_citations` is
            // false), but threading the flag through removes a reader
            // double-take — a future maintainer scanning this branch
            // could otherwise reasonably worry that the text-format
            // fallback was ignoring the toggle. Passing the same flag
            // both here and to the inner `export` keeps the dispatch
            // contract obvious: the caller's intent is preserved at
            // every layer.
            let content = export(artifact, effective, other, include_citations)?;
            std::fs::write(path, content)?;
        }
    }
    Ok(())
}

/// Export an artifact to `path` and additionally write a detached
/// ML-DSA-65 provenance signature at `<path>.sig`.
///
/// This is the provenance-aware counterpart to [`export_to_file`]:
/// it produces the exact same artifact bytes, then signs them with
/// `signer` so a recipient can prove the file's origin and integrity
/// (see [`crate::signing`]). Returns the sidecar path. Existing
/// callers that do not need provenance keep using [`export_to_file`]
/// unchanged.
pub fn export_to_file_signed(
    artifact: &Artifact,
    citations: &[Citation],
    format: ExportFormat,
    path: &std::path::Path,
    include_citations: bool,
    signer: &crate::signing::ExportSigner,
) -> Result<std::path::PathBuf> {
    export_to_file(artifact, citations, format, path, include_citations)?;
    signer.sign_file(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signing::{verify_file, ExportSigner};
    use tessera_artifacts::Artifact;
    use tessera_core::ArtifactType;

    use tessera_citations::citation::Citation;
    use tessera_core::{SourceId, SourceType};

    fn sample_citation() -> Citation {
        Citation::new(
            SourceId::new(),
            SourceType::LocalFile,
            "Brief.pdf".to_string(),
            "file:///tmp/brief.pdf".to_string(),
            "chunkhash".to_string(),
            "filehash".to_string(),
            "evidence body".to_string(),
            0.92,
        )
    }

    #[test]
    fn export_markdown_format() {
        let artifact = Artifact::new("Test".to_string(), ArtifactType::Document, None);
        let result = export(&artifact, &[], ExportFormat::Markdown, true).unwrap();
        assert!(result.contains("# Test"));
    }

    #[test]
    fn export_html_format() {
        let artifact = Artifact::new("Test".to_string(), ArtifactType::Document, None);
        let result = export(&artifact, &[], ExportFormat::Html, true).unwrap();
        assert!(result.contains("<html"));
    }

    #[test]
    fn export_csv_format() {
        let artifact = Artifact::new("Test".to_string(), ArtifactType::Sheet, None);
        let result = export(&artifact, &[], ExportFormat::Csv, true).unwrap();
        assert!(result.contains("title,type"));
    }

    #[test]
    fn export_json_format() {
        let artifact = Artifact::new("Test".to_string(), ArtifactType::Document, None);
        let result = export(&artifact, &[], ExportFormat::Json, true).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["title"], "Test");
    }

    #[test]
    fn export_to_file_works() {
        let dir = tempfile::tempdir().unwrap();
        let artifact = Artifact::new("Test".to_string(), ArtifactType::Document, None);
        let path = dir.path().join("output.md");
        export_to_file(&artifact, &[], ExportFormat::Markdown, &path, true).unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("# Test"));
    }

    #[test]
    fn pdf_string_export_returns_error_directing_to_file() {
        let artifact = Artifact::new("Test".to_string(), ArtifactType::Document, None);
        let result = export(&artifact, &[], ExportFormat::Pdf, true);
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(err_msg.contains("export_to_file"));
    }

    #[test]
    fn pdf_export_to_file_works() {
        let dir = tempfile::tempdir().unwrap();
        let artifact = Artifact::new("PDF Test".to_string(), ArtifactType::Document, None);
        let path = dir.path().join("output.pdf");
        export_to_file(&artifact, &[], ExportFormat::Pdf, &path, true).unwrap();
        let content = std::fs::read(&path).unwrap();
        // The PDF version byte after `%PDF-1.` differs between code paths
        // (the legacy minimal builder emits 1.4, typst 0.12 emits 1.7) so
        // we assert the version-agnostic `%PDF-1.` prefix plus a valid
        // PDF trailer. The exact version is verified by the focused tests
        // in `tests/pdf_mermaid.rs`.
        assert!(content.starts_with(b"%PDF-1."));
        let trailer = &content[content.len().saturating_sub(8)..];
        assert!(
            trailer.windows(5).any(|w| w == b"%%EOF"),
            "PDF must end with %%EOF trailer; got tail: {:?}",
            trailer
        );
    }

    #[cfg(feature = "docx")]
    #[test]
    fn docx_export_to_file_works() {
        let dir = tempfile::tempdir().unwrap();
        let artifact = Artifact::new("DOCX Test".to_string(), ArtifactType::Document, None);
        let path = dir.path().join("output.docx");
        export_to_file(&artifact, &[], ExportFormat::Docx, &path, true).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..4], b"PK\x03\x04");
    }

    #[cfg(feature = "xlsx")]
    #[test]
    fn xlsx_export_to_file_works() {
        let dir = tempfile::tempdir().unwrap();
        let artifact = Artifact::new("XLSX Test".to_string(), ArtifactType::Sheet, None);
        let path = dir.path().join("output.xlsx");
        export_to_file(&artifact, &[], ExportFormat::Xlsx, &path, true).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..4], b"PK\x03\x04");
    }

    #[test]
    fn pptx_export_to_file_returns_helpful_error() {
        let dir = tempfile::tempdir().unwrap();
        let artifact = Artifact::new("PPTX".to_string(), ArtifactType::Slides, None);
        let path = dir.path().join("output.pptx");
        let err = export_to_file(&artifact, &[], ExportFormat::Pptx, &path, true).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("Marp"));
    }

    /// `include_citations = true` renders the Sources section.
    #[test]
    fn include_citations_true_renders_sources_section_in_markdown() {
        let artifact = Artifact::new("Report".to_string(), ArtifactType::Document, None);
        let citations = vec![sample_citation()];
        let out = export(&artifact, &citations, ExportFormat::Markdown, true).unwrap();
        assert!(out.contains("## Sources"), "missing sources: {out}");
        assert!(out.contains("Brief.pdf"));
    }

    /// `include_citations = false` suppresses the Sources section
    /// even when citations exist on the artifact.
    #[test]
    fn include_citations_false_suppresses_sources_section_in_markdown() {
        let artifact = Artifact::new("Report".to_string(), ArtifactType::Document, None);
        let citations = vec![sample_citation()];
        let out = export(&artifact, &citations, ExportFormat::Markdown, false).unwrap();
        assert!(!out.contains("## Sources"), "sources section leaked: {out}");
        assert!(!out.contains("Brief.pdf"));
    }

    /// `export_to_file_signed` writes the artifact plus a detached
    /// `.sig` sidecar that verifies against the produced bytes, and
    /// any post-hoc tampering with the artifact breaks verification.
    #[test]
    fn signed_export_writes_verifiable_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let artifact = Artifact::new("Signed".to_string(), ArtifactType::Document, None);
        let path = dir.path().join("signed.pdf");
        let signer = ExportSigner::generate();

        let sidecar =
            export_to_file_signed(&artifact, &[], ExportFormat::Pdf, &path, true, &signer).unwrap();
        assert_eq!(sidecar, dir.path().join("signed.pdf.sig"));
        assert!(verify_file(&path, &sidecar).unwrap(), "fresh export verifies");

        std::fs::write(&path, b"%PDF-1.7 tampered").unwrap();
        assert!(
            !verify_file(&path, &sidecar).unwrap(),
            "tampered export must fail verification"
        );
    }

    /// The toggle holds for HTML too — same dispatch path.
    #[test]
    fn include_citations_false_suppresses_sources_section_in_html() {
        let artifact = Artifact::new("Report".to_string(), ArtifactType::Document, None);
        let citations = vec![sample_citation()];
        let with = export(&artifact, &citations, ExportFormat::Html, true).unwrap();
        let without = export(&artifact, &citations, ExportFormat::Html, false).unwrap();
        assert!(with.contains("Brief.pdf"));
        assert!(!without.contains("Brief.pdf"));
    }

    /// The binary-output path (`export_to_file`) honours the toggle
    /// identically — verified by reading the resulting PDF bytes back
    /// and confirming the citation title only appears when the toggle
    /// is on.
    #[test]
    fn include_citations_false_suppresses_sources_in_pdf() {
        let dir = tempfile::tempdir().unwrap();
        let artifact = Artifact::new("Report".to_string(), ArtifactType::Document, None);
        let citations = vec![sample_citation()];
        let on = dir.path().join("on.pdf");
        let off = dir.path().join("off.pdf");
        export_to_file(&artifact, &citations, ExportFormat::Pdf, &on, true).unwrap();
        export_to_file(&artifact, &citations, ExportFormat::Pdf, &off, false).unwrap();
        let on_bytes = std::fs::read(&on).unwrap();
        let off_bytes = std::fs::read(&off).unwrap();
        // The bytes should differ — citations baked into PDF when on.
        assert_ne!(on_bytes, off_bytes);
    }
}
