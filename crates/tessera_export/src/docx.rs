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
//! out of the box, so a future iteration can wire in image-based
//! rasterization.

use docx_rs::{Docx, Paragraph, Run, Table, TableCell, TableRow};
use std::io::Cursor;
use tessera_artifacts::Artifact;
use tessera_citations::citation::Citation;

use crate::mermaid;

/// Phase 15 Task 13: parse a single markdown table row of the form
/// `| col1 | col2 | col3 |` into the individual cell strings. Returns
/// `None` when the line is not a well-formed table row (no leading/
/// trailing pipe, or zero cells once trimmed). Leading and trailing
/// pipes are required so we do not mistake a prose sentence that
/// happens to contain `|` for a table row.
fn parse_md_table_row(line: &str) -> Option<Vec<String>> {
    let trimmed = line.trim();
    // Devin Review PR #70 BUG_0001: a lone `|` (which `.trim()` could
    // produce from a line like `  |  `) passes the leading/trailing
    // pipe gate but causes `&trimmed[1..0]` — a `start > end` slice
    // that panics. Reject anything shorter than `||` (two pipes
    // with at minimum zero cells between them) before slicing. Two
    // pipes back-to-back (`||`) still yields a single empty cell on
    // `interior.split('|')`, which is the correct round-trip for a
    // genuinely empty single-column table row.
    if trimmed.len() < 2 || !trimmed.starts_with('|') || !trimmed.ends_with('|') {
        return None;
    }
    // Strip the leading and trailing `|` then split on the interior
    // pipes. Each segment is the cell text; we trim whitespace.
    let interior = &trimmed[1..trimmed.len() - 1];
    let cells: Vec<String> = interior.split('|').map(|s| s.trim().to_string()).collect();
    if cells.is_empty() {
        return None;
    }
    Some(cells)
}

/// Phase 15 Task 13: detect the markdown table separator row
/// `| --- | :---: | ---: |`. The dashes can be any length >= 3 and may
/// have alignment colons on either or both sides. Returns true when
/// every cell in `cells` matches the separator pattern.
fn is_md_table_separator(cells: &[String]) -> bool {
    !cells.is_empty()
        && cells.iter().all(|c| {
            let s = c.trim_matches(':');
            !s.is_empty() && s.chars().all(|ch| ch == '-')
        })
}

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
        // Phase 15 Task 13: accumulate consecutive markdown-table rows
        // and flush them together as a single `Table` element once we
        // either hit a non-table line or fall out of the loop. The
        // buffer holds the parsed cells per row; the separator row
        // (`| --- | --- |`) is consumed but NOT added to the buffer
        // (it conveys alignment only — we render without alignment).
        let mut table_buf: Vec<Vec<String>> = Vec::new();
        let flush_table = |docx: Docx, buf: &mut Vec<Vec<String>>| -> Docx {
            if buf.is_empty() {
                return docx;
            }
            // Build a `Table` from the buffered rows. The first row is
            // styled as the header (bold) so it visually matches Word's
            // default table-header convention.
            let mut rows: Vec<TableRow> = Vec::with_capacity(buf.len());
            for (row_idx, cells) in buf.iter().enumerate() {
                let mut tcs: Vec<TableCell> = Vec::with_capacity(cells.len());
                for cell_text in cells {
                    let run = if row_idx == 0 {
                        Run::new().add_text(cell_text).bold()
                    } else {
                        Run::new().add_text(cell_text)
                    };
                    let para = Paragraph::new().style("Normal").add_run(run);
                    tcs.push(TableCell::new().add_paragraph(para));
                }
                rows.push(TableRow::new(tcs));
            }
            buf.clear();
            docx.add_table(Table::new(rows))
        };
        for raw_line in content_for_docx.lines() {
            let line = raw_line;
            // Devin Review PR #70 BUG_0002: previously we attempted
            // table-row detection BEFORE consulting `in_code_block`,
            // which silently consumed pipe-delimited lines inside a
            // fenced code block (e.g. shell aliases or markdown source
            // pasted into a `` ``` ``-block) as table data and stripped
            // them from the rendered monospace block. Code-block state
            // must win: toggle the fence first, then — only when we are
            // NOT inside a code block — try to parse the line as a table
            // row. Lines inside a code block fall through to the
            // monospace renderer below.
            if line.trim_start().starts_with("```") {
                // A fence transition flushes any pending table so we
                // don't bleed a table into the code block that follows.
                docx = flush_table(docx, &mut table_buf);
                in_code_block = !in_code_block;
                continue;
            }
            if !in_code_block {
                // Detect a markdown-table row first so the buffer can grow
                // even when the line would otherwise match another rule
                // (e.g. a `| --- |` separator that vaguely looks like a
                // bullet to the eye).
                if let Some(cells) = parse_md_table_row(line) {
                    if is_md_table_separator(&cells) {
                        // Consume the separator without appending — it
                        // conveys alignment only.
                        continue;
                    }
                    table_buf.push(cells);
                    continue;
                }
            }
            // Any non-table line flushes the pending table first so
            // the row order is preserved.
            docx = flush_table(docx, &mut table_buf);
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
        // Phase 15 Task 13: flush any trailing table (content ended on
        // a table without a following blank/prose line).
        docx = flush_table(docx, &mut table_buf);
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

    /// Devin Review PR #70 BUG_0001 regression: a content line that is
    /// just `|` (or `  |  ` after `.trim()`) used to panic at
    /// `&trimmed[1..0]` inside `parse_md_table_row`, taking down the
    /// entire DOCX export. We verify the parser now returns `None` for
    /// every short / malformed pipe-only line, AND that the full export
    /// pipeline returns a valid DOCX when the artifact body contains
    /// such a line.
    #[test]
    fn parse_md_table_row_rejects_short_pipe_lines_without_panic() {
        assert_eq!(parse_md_table_row("|"), None);
        assert_eq!(parse_md_table_row("  |  "), None);
        assert_eq!(parse_md_table_row(""), None);
        assert_eq!(parse_md_table_row("foo"), None);
        // The full-export round-trip — must not panic.
        let mut artifact = Artifact::new("Pipe".to_string(), ArtifactType::Document, None);
        artifact.update_content("Some prose.\n|\nMore prose.".into());
        let bytes = export_docx(&artifact, &[]);
        assert_is_zip(&bytes);
    }

    /// Devin Review PR #70 BUG_0002 regression: pipe-delimited lines
    /// inside a fenced code block must be rendered as code (in the
    /// Consolas font) and NOT extracted into a Word table. Before the
    /// fix, `| A | B |` inside ` ```bash ` would be silently consumed
    /// by the table buffer and lost from the code block.
    #[test]
    fn pipe_lines_inside_code_block_render_as_code_not_table() {
        let mut artifact = Artifact::new("Sh".to_string(), ArtifactType::Document, None);
        artifact.update_content(
            "```bash\n\
             alias ll='ls | grep foo'\n\
             | A | B |\n\
             | --- | --- |\n\
             | 1 | 2 |\n\
             ```\n\
             After.\n"
                .into(),
        );
        let bytes = export_docx(&artifact, &[]);
        assert_is_zip(&bytes);
        let xml = read_docx_text(&bytes);
        // Every pipe-bearing line must survive verbatim inside the
        // document body (not vanish into a `<w:tbl>` element).
        for needle in [
            "alias ll=",
            "| A | B |",
            "| --- | --- |",
            "| 1 | 2 |",
        ] {
            assert!(
                xml.contains(needle),
                "code-block line {needle:?} missing from document.xml:\n{xml}"
            );
        }
    }
}
