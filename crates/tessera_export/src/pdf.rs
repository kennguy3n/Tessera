use std::fmt::Write;

use tessera_artifacts::Artifact;
use tessera_citations::citation::Citation;

use crate::mermaid;

/// Generate a minimal but valid PDF document from an artifact.
/// Uses the PDF 1.4 specification with built-in Helvetica font (no external font files needed).
pub fn export_pdf(artifact: &Artifact, citations: &[Citation]) -> Vec<u8> {
    let mut builder = PdfBuilder::new();

    // Title
    builder.add_line(&artifact.title, 18.0, true);
    builder.add_spacing(12.0);

    // Type and metadata line
    let meta = format!(
        "Type: {} | Version: {} | Created: {}",
        artifact.artifact_type,
        artifact.version,
        artifact.created_at.format("%Y-%m-%d %H:%M"),
    );
    builder.add_line(&meta, 10.0, false);
    builder.add_spacing(20.0);

    // Content — mermaid fenced blocks get reduced to a one-line placeholder
    // because the minimal PDF builder cannot rasterize SVG. The Typst PDF
    // pipeline (`crate::typst`, Phase 7 Task 14) handles real diagram
    // embedding for documents that opt into high-quality export.
    if !artifact.content.is_empty() {
        let content_for_pdf =
            mermaid::replace_blocks(&artifact.content, mermaid::to_pdf_placeholder);
        for line in content_for_pdf.lines() {
            if line.is_empty() {
                builder.add_spacing(8.0);
            } else {
                builder.add_line(line, 11.0, false);
            }
        }
    }

    // Citations appendix
    if !citations.is_empty() {
        builder.add_spacing(24.0);
        builder.add_line("Citations", 14.0, true);
        builder.add_spacing(8.0);

        for (i, citation) in citations.iter().enumerate() {
            let entry = format!(
                "[{}] {} — {}",
                i + 1,
                citation.source_title,
                citation.source_uri,
            );
            builder.add_line(&entry, 9.0, false);
        }
    }

    builder.build()
}

struct PdfBuilder {
    lines: Vec<PdfLine>,
}

struct PdfLine {
    text: String,
    font_size: f32,
    bold: bool,
}

impl PdfBuilder {
    fn new() -> Self {
        Self { lines: Vec::new() }
    }

    fn add_line(&mut self, text: &str, font_size: f32, bold: bool) {
        self.lines.push(PdfLine {
            text: pdf_escape(text),
            font_size,
            bold,
        });
    }

    fn add_spacing(&mut self, points: f32) {
        self.lines.push(PdfLine {
            text: String::new(),
            font_size: points,
            bold: false,
        });
    }

    fn build(self) -> Vec<u8> {
        let page_width = 612.0_f32; // Letter
        let page_height = 792.0_f32;
        let margin = 72.0_f32;

        // Split lines into pages based on available vertical space
        let mut pages: Vec<String> = Vec::new();
        let mut stream_content = String::new();
        stream_content.push_str("BT\n");
        let mut y = page_height - margin;

        for line in &self.lines {
            if line.text.is_empty() {
                y -= line.font_size;
                if y < margin {
                    stream_content.push_str("ET\n");
                    pages.push(stream_content);
                    stream_content = String::new();
                    stream_content.push_str("BT\n");
                    y = page_height - margin;
                }
                continue;
            }

            let font = if line.bold { "/F2" } else { "/F1" };
            let line_height = line.font_size * 1.4;
            y -= line_height;

            if y < margin {
                stream_content.push_str("ET\n");
                pages.push(stream_content);
                stream_content = String::new();
                stream_content.push_str("BT\n");
                y = page_height - margin - line_height;
            }

            let _ = write!(
                stream_content,
                "{} {} Tf\n1 0 0 1 {} {} Tm\n({}) Tj\n",
                font, line.font_size, margin, y, line.text
            );
        }

        stream_content.push_str("ET\n");
        pages.push(stream_content);

        let page_count = pages.len();

        // Build PDF structure with multiple pages.
        // Object layout:
        //   1: Catalog
        //   2: Pages
        //   3..3+N-1: Page objects (each referencing its content stream)
        //   3+N..3+2N-1: Content stream objects
        //   3+2N: Font (Helvetica)
        //   3+2N+1: Font (Helvetica-Bold)
        let font_obj_1 = 3 + 2 * page_count;
        let font_obj_2 = font_obj_1 + 1;

        let mut pdf = Vec::new();
        let mut offsets: Vec<usize> = Vec::new();

        // Header
        pdf.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

        // Object 1: Catalog
        offsets.push(pdf.len());
        pdf.extend_from_slice(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

        // Object 2: Pages
        offsets.push(pdf.len());
        let kids: Vec<String> = (0..page_count).map(|i| format!("{} 0 R", 3 + i)).collect();
        let pages_obj = format!(
            "2 0 obj\n<< /Type /Pages /Kids [{}] /Count {} >>\nendobj\n",
            kids.join(" "),
            page_count
        );
        pdf.extend_from_slice(pages_obj.as_bytes());

        // Page objects (3..3+N-1)
        for i in 0..page_count {
            offsets.push(pdf.len());
            let content_obj_num = 3 + page_count + i;
            let page_obj = format!(
                "{} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] /Contents {} 0 R /Resources << /Font << /F1 {} 0 R /F2 {} 0 R >> >> >>\nendobj\n",
                3 + i,
                page_width as i32,
                page_height as i32,
                content_obj_num,
                font_obj_1,
                font_obj_2
            );
            pdf.extend_from_slice(page_obj.as_bytes());
        }

        // Content stream objects (3+N..3+2N-1)
        for (i, page_stream) in pages.iter().enumerate() {
            offsets.push(pdf.len());
            let obj_num = 3 + page_count + i;
            let stream_bytes = page_stream.as_bytes();
            let content_obj = format!(
                "{} 0 obj\n<< /Length {} >>\nstream\n",
                obj_num,
                stream_bytes.len()
            );
            pdf.extend_from_slice(content_obj.as_bytes());
            pdf.extend_from_slice(stream_bytes);
            pdf.extend_from_slice(b"\nendstream\nendobj\n");
        }

        // Font objects
        offsets.push(pdf.len());
        let font1 = format!(
            "{} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
            font_obj_1
        );
        pdf.extend_from_slice(font1.as_bytes());

        offsets.push(pdf.len());
        let font2 = format!(
            "{} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n",
            font_obj_2
        );
        pdf.extend_from_slice(font2.as_bytes());

        // Cross-reference table
        let xref_offset = pdf.len();
        pdf.extend_from_slice(b"xref\n");
        pdf.extend_from_slice(format!("0 {}\n", offsets.len() + 1).as_bytes());
        pdf.extend_from_slice(b"0000000000 65535 f \n");
        for offset in &offsets {
            pdf.extend_from_slice(format!("{:010} 00000 n \n", offset).as_bytes());
        }

        // Trailer
        pdf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
                offsets.len() + 1,
                xref_offset
            )
            .as_bytes(),
        );

        pdf
    }
}

fn pdf_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('(', "\\(")
        .replace(')', "\\)")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_artifacts::Artifact;
    use tessera_core::ArtifactType;

    #[test]
    fn generates_valid_pdf_header() {
        let artifact = Artifact::new("Test Doc".to_string(), ArtifactType::Document, None);
        let pdf = export_pdf(&artifact, &[]);
        assert!(!pdf.is_empty());
        assert!(pdf.starts_with(b"%PDF-1.4"));
        // Check trailer is present
        let pdf_str = String::from_utf8_lossy(&pdf);
        assert!(pdf_str.contains("%%EOF"));
        assert!(pdf_str.contains("/Type /Catalog"));
    }

    #[test]
    fn pdf_contains_title() {
        let artifact = Artifact::new("My Report".to_string(), ArtifactType::Document, None);
        let pdf = export_pdf(&artifact, &[]);
        let pdf_str = String::from_utf8_lossy(&pdf);
        assert!(pdf_str.contains("My Report"));
    }

    #[test]
    fn pdf_with_content() {
        let mut artifact = Artifact::new("Test".to_string(), ArtifactType::Document, None);
        artifact.update_content("Hello world\n\nSecond paragraph".to_string());
        let pdf = export_pdf(&artifact, &[]);
        let pdf_str = String::from_utf8_lossy(&pdf);
        assert!(pdf_str.contains("Hello world"));
        assert!(pdf_str.contains("Second paragraph"));
    }

    #[test]
    fn pdf_escapes_special_chars() {
        let mut artifact = Artifact::new("Test".to_string(), ArtifactType::Document, None);
        artifact.update_content("Has (parens) and \\backslash".to_string());
        let pdf = export_pdf(&artifact, &[]);
        let pdf_str = String::from_utf8_lossy(&pdf);
        assert!(pdf_str.contains("\\(parens\\)"));
        assert!(pdf_str.contains("\\\\backslash"));
    }

    #[test]
    fn pdf_with_citations() {
        let artifact = Artifact::new("Test".to_string(), ArtifactType::Document, None);
        let citation = Citation {
            citation_id: tessera_core::CitationId::new(),
            source_id: tessera_core::SourceId::new(),
            source_type: tessera_core::SourceType::LocalFile,
            source_title: "reference.pdf".to_string(),
            source_uri: "/path/to/reference.pdf".to_string(),
            chunk_hash: "abc123".to_string(),
            source_file_hash: "file_hash_abc".to_string(),
            page: Some(5),
            confidence: 0.95,
            used_for: "introduction".to_string(),
            created_at: chrono::Utc::now(),
        };
        let pdf = export_pdf(&artifact, &[citation]);
        let pdf_str = String::from_utf8_lossy(&pdf);
        assert!(pdf_str.contains("Citations"));
        assert!(pdf_str.contains("reference.pdf"));
    }

    #[test]
    fn pdf_replaces_mermaid_blocks_with_placeholder() {
        let mut artifact = Artifact::new("Arch".to_string(), ArtifactType::Document, None);
        artifact.update_content(
            "Intro line\n\n```mermaid\nflowchart TD\nA-->B\n```\n\nOutro".to_string(),
        );
        let pdf = export_pdf(&artifact, &[]);
        let pdf_str = String::from_utf8_lossy(&pdf);
        // Original DSL must not leak through.
        assert!(!pdf_str.contains("flowchart TD"));
        // The placeholder must mention the diagram type.
        assert!(pdf_str.contains("Diagram"));
        assert!(pdf_str.contains("flowchart"));
        // Surrounding content stays.
        assert!(pdf_str.contains("Intro line"));
        assert!(pdf_str.contains("Outro"));
    }

    #[test]
    fn pdf_multipage_long_content() {
        let mut artifact = Artifact::new("Long Doc".to_string(), ArtifactType::Document, None);
        // ~60 lines per page at 11pt * 1.4 line height on Letter (648pt usable)
        // Generate enough lines to require at least 2 pages
        let lines: Vec<String> = (0..80).map(|i| format!("Line number {i}")).collect();
        artifact.update_content(lines.join("\n"));
        let pdf = export_pdf(&artifact, &[]);
        let pdf_str = String::from_utf8_lossy(&pdf);
        // Multi-page: Pages object should list multiple kids
        assert!(pdf_str.contains("/Count 2") || pdf_str.contains("/Count 3"));
        // Content from both pages should be present
        assert!(pdf_str.contains("Line number 0"));
        assert!(pdf_str.contains("Line number 79"));
    }
}
