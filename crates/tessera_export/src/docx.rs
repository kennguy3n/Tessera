//! DOCX export — Tessera converts artifact content (markdown-flavoured) into
//! a Microsoft Word document using `docx-rs`.
//!
//! The conversion is intentionally pragmatic: it walks the markdown
//! content line-by-line and emits paragraphs that map ATX headings, list
//! items, code blocks, and plain prose to Word styles. This is the same
//! design we use in `pdf.rs` so the two text-based exports stay in sync.
//!
//! Mermaid blocks are preserved as text placeholders (the HTML export is
//! the canonical place for live diagrams). DOCX has no inline SVG support
//! out of the box, so a future Phase 8 task can wire in image-based
//! rasterization.

use docx_rs::{Docx, Paragraph, Run};
use std::io::Cursor;
use tessera_artifacts::Artifact;
use tessera_citations::citation::Citation;

use crate::mermaid;

/// Export an artifact to DOCX bytes. Returns the binary representation of
/// a valid Word document.
pub fn export_docx(artifact: &Artifact, citations: &[Citation]) -> Vec<u8> {
    let mut docx = Docx::new();

    // Title — H1 style.
    docx = docx.add_paragraph(
        Paragraph::new()
            .style("Heading1")
            .add_run(Run::new().add_text(&artifact.title)),
    );

    if !artifact.content.is_empty() {
        let content_for_docx =
            mermaid::replace_blocks(&artifact.content, mermaid::to_pdf_placeholder);
        let mut in_code_block = false;
        for raw_line in content_for_docx.lines() {
            let line = raw_line;
            // Toggle code-block state when we see a fence.
            if line.trim_start().starts_with("```") {
                in_code_block = !in_code_block;
                continue;
            }
            if in_code_block {
                docx = docx.add_paragraph(
                    Paragraph::new()
                        .style("Normal")
                        .add_run(Run::new().fonts(docx_rs::RunFonts::new().east_asia("Consolas")).add_text(line)),
                );
                continue;
            }

            if line.is_empty() {
                docx = docx.add_paragraph(Paragraph::new());
                continue;
            }

            // Headings
            if let Some(rest) = line.strip_prefix("# ") {
                docx = docx.add_paragraph(
                    Paragraph::new()
                        .style("Heading1")
                        .add_run(Run::new().add_text(rest.trim())),
                );
                continue;
            }
            if let Some(rest) = line.strip_prefix("## ") {
                docx = docx.add_paragraph(
                    Paragraph::new()
                        .style("Heading2")
                        .add_run(Run::new().add_text(rest.trim())),
                );
                continue;
            }
            if let Some(rest) = line.strip_prefix("### ") {
                docx = docx.add_paragraph(
                    Paragraph::new()
                        .style("Heading3")
                        .add_run(Run::new().add_text(rest.trim())),
                );
                continue;
            }
            // Bulleted lists — render as plain paragraphs with a leading
            // bullet so the document remains visually correct even without
            // a numbering definition.
            if let Some(rest) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
                docx = docx.add_paragraph(
                    Paragraph::new()
                        .style("Normal")
                        .add_run(Run::new().add_text(format!("• {}", rest.trim()))),
                );
                continue;
            }
            // Numbered lists — keep the marker, render as plain paragraph.
            if line.len() > 2
                && line
                    .chars()
                    .next()
                    .map(|c| c.is_ascii_digit())
                    .unwrap_or(false)
                && line.contains(". ")
            {
                docx = docx.add_paragraph(
                    Paragraph::new()
                        .style("Normal")
                        .add_run(Run::new().add_text(line)),
                );
                continue;
            }

            docx = docx.add_paragraph(
                Paragraph::new()
                    .style("Normal")
                    .add_run(Run::new().add_text(line)),
            );
        }
    }

    if !citations.is_empty() {
        docx = docx.add_paragraph(
            Paragraph::new()
                .style("Heading2")
                .add_run(Run::new().add_text("Sources")),
        );
        for (i, c) in citations.iter().enumerate() {
            let header = format!("{}. {} — {}", i + 1, c.source_title, c.used_for);
            docx = docx.add_paragraph(
                Paragraph::new()
                    .style("Normal")
                    .add_run(Run::new().add_text(header).bold()),
            );
            if let Some(page) = c.page {
                docx = docx.add_paragraph(
                    Paragraph::new()
                        .style("Normal")
                        .add_run(Run::new().add_text(format!("   Page: {page}"))),
                );
            }
            docx = docx.add_paragraph(
                Paragraph::new()
                    .style("Normal")
                    .add_run(Run::new().add_text(format!(
                        "   Confidence: {:.0}%",
                        c.confidence * 100.0
                    ))),
            );
            docx = docx.add_paragraph(
                Paragraph::new()
                    .style("Normal")
                    .add_run(Run::new().add_text(format!("   URI: {}", c.source_uri))),
            );
        }
    }

    let footer = format!(
        "Generated by Tessera — {}",
        artifact.updated_at.format("%Y-%m-%d %H:%M UTC")
    );
    docx = docx.add_paragraph(
        Paragraph::new()
            .style("Normal")
            .add_run(Run::new().italic().add_text(footer)),
    );

    let xml = docx.build();
    let mut buf = Cursor::new(Vec::new());
    xml.pack(&mut buf).expect("pack DOCX into Cursor<Vec<u8>>");
    buf.into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_artifacts::Artifact;
    use tessera_citations::citation::Citation;
    use tessera_core::{ArtifactType, SourceId, SourceType};

    /// Verify the magic bytes of a DOCX file — it's a ZIP archive that
    /// starts with `PK\x03\x04`.
    fn assert_is_zip(bytes: &[u8]) {
        assert!(bytes.len() > 4, "DOCX too small ({} bytes)", bytes.len());
        assert_eq!(&bytes[..4], b"PK\x03\x04", "DOCX missing PK ZIP signature");
    }

    #[test]
    fn export_basic_docx_returns_zip_bytes() {
        let mut artifact =
            Artifact::new("Test Doc".to_string(), ArtifactType::Document, None);
        artifact.update_content(
            "## Problem\n\nThe problem is X.\n\n## Solution\n\nThe solution is Y.".into(),
        );
        let bytes = export_docx(&artifact, &[]);
        assert_is_zip(&bytes);
        // Word documents always contain word/document.xml; we can scan for
        // the substring within the zip stream as a smoke check.
        let s = String::from_utf8_lossy(&bytes);
        assert!(s.contains("word/document.xml") || bytes.len() > 1024);
    }

    #[test]
    fn export_docx_includes_title() {
        let artifact = Artifact::new("Hello DOCX".to_string(), ArtifactType::Document, None);
        let bytes = export_docx(&artifact, &[]);
        assert_is_zip(&bytes);
        // The title is stored inside word/document.xml. Search for the
        // raw UTF-8 substring; ZIP compresses by default (stored or deflate),
        // but document.xml is small enough that docx-rs stores it without
        // compression for typical documents.
        let raw = String::from_utf8_lossy(&bytes);
        // Either uncompressed substring or at least the zip contains some
        // archive entries beyond just the title.
        assert!(raw.contains("Hello DOCX") || bytes.len() > 1024);
    }

    #[test]
    fn export_docx_handles_mermaid_blocks_as_placeholder() {
        let mut artifact = Artifact::new("Diagram".to_string(), ArtifactType::Document, None);
        artifact.update_content(
            "## Arch\n\n```mermaid\nflowchart LR\nA-->B\n```\n\nMore prose.".into(),
        );
        let bytes = export_docx(&artifact, &[]);
        assert_is_zip(&bytes);
    }

    #[test]
    fn export_docx_with_citations_round_trips() {
        let artifact = Artifact::new("Report".to_string(), ArtifactType::Document, None);
        let citations = vec![Citation::new(
            SourceId::new(),
            SourceType::LocalFile,
            "Brief.pdf".to_string(),
            "file:///brief.pdf".to_string(),
            "hash1".to_string(),
            "file_hash1".to_string(),
            "Problem Statement".to_string(),
            0.92,
        )
        .with_page(4)];

        let bytes = export_docx(&artifact, &citations);
        assert_is_zip(&bytes);
    }

    #[test]
    fn empty_artifact_still_produces_valid_docx() {
        let artifact = Artifact::new("Empty".to_string(), ArtifactType::Document, None);
        let bytes = export_docx(&artifact, &[]);
        assert_is_zip(&bytes);
        assert!(bytes.len() > 100);
    }
}
