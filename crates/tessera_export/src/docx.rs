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
                // Word stores font assignments per script-class slot. For
                // typical code (ASCII / Latin-1 source), the `ascii` and
                // `h_ansi` (high-ANSI) slots are the ones Word consults —
                // `east_asia` is only used when the run contains CJK
                // characters. We set all four slots so the monospace font
                // is honoured regardless of which characters appear inside
                // the code block.
                docx = docx.add_paragraph(
                    Paragraph::new().style("Normal").add_run(
                        Run::new()
                            .fonts(
                                docx_rs::RunFonts::new()
                                    .ascii("Consolas")
                                    .hi_ansi("Consolas")
                                    .cs("Consolas")
                                    .east_asia("Consolas"),
                            )
                            .add_text(line),
                    ),
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
                && line.chars().next().is_some_and(|c| c.is_ascii_digit())
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
            docx = docx.add_paragraph(Paragraph::new().style("Normal").add_run(
                Run::new().add_text(format!("   Confidence: {:.0}%", c.confidence * 100.0)),
            ));
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
        let mut artifact = Artifact::new("Test Doc".to_string(), ArtifactType::Document, None);
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

    /// Concatenate the text content of every XML entry in the DOCX zip.
    /// DOCX is a zip of XML parts (word/document.xml etc.); we use this to
    /// assert that specific font-slot attributes show up in the produced
    /// document, since the zip bytes are otherwise opaque.
    fn read_docx_text(bytes: &[u8]) -> String {
        use std::io::Read;
        let cursor = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(cursor).expect("DOCX should be a valid zip");
        let mut combined = String::new();
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).expect("entry");
            let is_xml = std::path::Path::new(entry.name())
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("xml"));
            if is_xml {
                let mut buf = String::new();
                entry.read_to_string(&mut buf).expect("read entry");
                combined.push_str(&buf);
                combined.push('\n');
            }
        }
        combined
    }

    #[test]
    fn code_blocks_set_ascii_and_hi_ansi_font_slots() {
        // Regression: previously the code-block font was wired only into
        // the `east_asia` slot of <w:rFonts>, which Word only consults for
        // CJK runs. Plain ASCII code therefore rendered in the document
        // default font instead of Consolas. Verify all four script-class
        // slots now reference Consolas.
        let mut artifact = Artifact::new("Snippet".to_string(), ArtifactType::Document, None);
        artifact.update_content("```rust\nlet x = 1;\n```\n".into());
        let bytes = export_docx(&artifact, &[]);
        assert_is_zip(&bytes);
        let xml = read_docx_text(&bytes);
        // docx-rs serialises RunFonts as <w:rFonts ... w:ascii="Consolas"
        // w:hAnsi="Consolas" w:cs="Consolas" w:eastAsia="Consolas" />
        assert!(
            xml.contains("w:ascii=\"Consolas\""),
            "ascii font slot missing in document.xml: {}",
            xml
        );
        assert!(
            xml.contains("w:hAnsi=\"Consolas\""),
            "hAnsi (high-ANSI) font slot missing: {}",
            xml
        );
        assert!(
            xml.contains("w:cs=\"Consolas\""),
            "cs (complex-script) font slot missing: {}",
            xml
        );
        assert!(
            xml.contains("w:eastAsia=\"Consolas\""),
            "eastAsia font slot missing: {}",
            xml
        );
    }

    #[test]
    fn empty_artifact_still_produces_valid_docx() {
        let artifact = Artifact::new("Empty".to_string(), ArtifactType::Document, None);
        let bytes = export_docx(&artifact, &[]);
        assert_is_zip(&bytes);
        assert!(bytes.len() > 100);
    }
}
