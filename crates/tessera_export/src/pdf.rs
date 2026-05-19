use tessera_artifacts::Artifact;
use tessera_citations::citation::Citation;

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

    // Content
    if !artifact.content.is_empty() {
        for line in artifact.content.lines() {
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

    fn add_spacing(&mut self, _points: f32) {
        self.lines.push(PdfLine {
            text: String::new(),
            font_size: _points,
            bold: false,
        });
    }

    fn build(self) -> Vec<u8> {
        let page_width = 612.0_f32; // Letter
        let page_height = 792.0_f32;
        let margin = 72.0_f32;
        let _usable_width = page_width - 2.0 * margin;

        // Build text stream
        let mut stream_content = String::new();
        stream_content.push_str("BT\n");

        let mut y = page_height - margin;

        for line in &self.lines {
            if line.text.is_empty() {
                y -= line.font_size;
                if y < margin {
                    // Would need new page, but for simplicity wrap to top
                    y = page_height - margin;
                }
                continue;
            }

            let font = if line.bold { "/F2" } else { "/F1" };
            let line_height = line.font_size * 1.4;
            y -= line_height;

            if y < margin {
                y = page_height - margin - line_height;
            }

            stream_content.push_str(&format!(
                "{} {} Tf\n{} {} Td\n({}) Tj\n",
                font, line.font_size, margin, y, line.text
            ));
        }

        stream_content.push_str("ET\n");

        // Build PDF structure
        let mut pdf = Vec::new();
        let mut offsets: Vec<usize> = Vec::new();

        // Header
        pdf.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

        // Object 1: Catalog
        offsets.push(pdf.len());
        pdf.extend_from_slice(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

        // Object 2: Pages
        offsets.push(pdf.len());
        pdf.extend_from_slice(b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");

        // Object 3: Page
        offsets.push(pdf.len());
        let page_obj = format!(
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>\nendobj\n",
            page_width as i32,
            page_height as i32
        );
        pdf.extend_from_slice(page_obj.as_bytes());

        // Object 4: Content stream
        offsets.push(pdf.len());
        let stream_bytes = stream_content.as_bytes();
        let content_obj = format!(
            "4 0 obj\n<< /Length {} >>\nstream\n",
            stream_bytes.len()
        );
        pdf.extend_from_slice(content_obj.as_bytes());
        pdf.extend_from_slice(stream_bytes);
        pdf.extend_from_slice(b"\nendstream\nendobj\n");

        // Object 5: Font (Helvetica)
        offsets.push(pdf.len());
        pdf.extend_from_slice(
            b"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
        );

        // Object 6: Font (Helvetica-Bold)
        offsets.push(pdf.len());
        pdf.extend_from_slice(
            b"6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n",
        );

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
}
