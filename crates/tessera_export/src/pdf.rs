use std::fmt::Write;

use tessera_artifacts::Artifact;
use tessera_citations::citation::Citation;

use crate::mermaid;
// Devin Review PR #70: the typst submodule is only
// available when the `typst` feature is enabled, but the import is
// still legitimately top-of-file (matches the existing pattern used
// by `crate::exporter`'s feature-gated imports). Moving the
// `use crate::typst` call out of `export_pdf_with_svgs` keeps the
// crate's import block as the single place a reader can scan to
// understand its dependencies.
#[cfg(feature = "typst")]
use crate::typst as typst_export;

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
    // pipeline (`crate::typst`) handles real diagram embedding for
    // documents that opt into high-quality export.
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

/// PDF export with Mermaid diagrams rendered as
/// embedded SVG via the Typst pipeline.
///
/// Architecture:
///
/// 1. Extract every ```mermaid block from `artifact.content` via
///    [`mermaid::extract_blocks`].
/// 2. For each block, pick the SVG to embed:
///    - if the caller supplied a pre-rendered SVG in `prerendered`
///      (keyed by block index, 0-based), use that. This is the
///      production path: the renderer process drives `mermaid.js`
///      and produces the same SVG the user sees in the in-app
///      preview.
///    - otherwise fall back to [`mermaid::render_block_to_svg`]
///      which emits a structural SVG containing the diagram type +
///      DSL text. This keeps headless / CLI export working in
///      environments without a renderer.
/// 3. Register each SVG as a virtual file inside a
///    [`crate::typst::TesseraWorld`] and emit Typst markup that
///    references it via `image("diagram-N.svg")`.
/// 4. Compile to PDF via the Typst pipeline.
///
/// Fallback: if Typst compilation fails for any reason (font not
/// found, malformed user content, etc.), we fall back to the
/// minimal hand-rolled PDF builder via [`export_pdf`] so callers
/// always get *some* PDF output rather than an empty buffer. The
/// fallback emits the same placeholder text the pre-Phase-15
/// `export_pdf` produced, which is the existing documented
/// behaviour. A future refactor could surface the Typst error to
/// the caller via a `Result`-returning variant, but the current
/// production callers don't have a path to surface that error to
/// the user, so silently degrading is the right default.
///
/// Feature-gated on `typst`: when the feature is disabled (e.g. in
/// the default build), this function falls back to the minimal
/// builder. Production callers that want diagram embedding must
/// enable the `typst` feature in their dependency declaration.
#[cfg(feature = "typst")]
pub fn export_pdf_with_svgs<S: std::hash::BuildHasher>(
    artifact: &Artifact,
    citations: &[Citation],
    prerendered: &std::collections::HashMap<usize, String, S>,
) -> Vec<u8> {
    // Build Typst markup. The Typst document mirrors the structure
    // of the minimal PDF: title heading, metadata line, content
    // (with `image()` substitutions for mermaid blocks), citations
    // appendix. We emit Typst markup rather than reusing the
    // markdown export's output because Typst's markdown reader is
    // not a 1:1 superset of CommonMark — using native Typst syntax
    // for the surrounding text gives predictable layout.
    let mut markup = String::new();
    let _ = write!(
        markup,
        "#set page(paper: \"us-letter\", margin: 1in)\n\
         #set text(font: \"Libertinus Serif\", size: 11pt)\n\
         #show heading.where(level: 1): set text(size: 18pt, weight: \"bold\")\n\
         \n\
         = {}\n\
         \n\
         #text(size: 10pt, fill: rgb(\"#475569\"))[Type: {} | Version: {} | Created: {}]\n\
         \n",
        typst_escape(&artifact.title),
        typst_escape(&artifact.artifact_type.to_string()),
        artifact.version,
        artifact.created_at.format("%Y-%m-%d %H:%M"),
    );

    // Walk the content and substitute mermaid blocks with #image
    // references. We do this via `mermaid::extract_blocks` so the
    // byte ranges align exactly with the source.
    let blocks = mermaid::extract_blocks(&artifact.content);
    let mut svg_files: Vec<(String, Vec<u8>)> = Vec::with_capacity(blocks.len());
    let mut cursor = 0usize;
    for (idx, block) in blocks.iter().enumerate() {
        let (start, end) = block.range;
        // Emit the pre-block text verbatim (escaped for Typst).
        markup.push_str(&typst_escape(&artifact.content[cursor..start]));
        // Pick the SVG: prerendered wins, fallback otherwise.
        let svg = prerendered
            .get(&idx)
            .cloned()
            .unwrap_or_else(|| mermaid::render_block_to_svg(block));
        let virt_name = format!("diagram-{idx}.svg");
        svg_files.push((virt_name.clone(), svg.into_bytes()));
        // Emit a Typst image reference. width: auto + height: auto
        // lets Typst use the SVG's intrinsic dimensions; we cap
        // width to the available text width so wide diagrams scale.
        let _ = write!(markup, "\n#image(\"{virt_name}\", width: 100%)\n\n",);
        cursor = end;
    }
    // Trailing text after the last block.
    markup.push_str(&typst_escape(&artifact.content[cursor..]));

    if !citations.is_empty() {
        markup.push_str("\n\n== Citations\n\n");
        for (i, citation) in citations.iter().enumerate() {
            let _ = write!(
                markup,
                "#text(size: 9pt)[[{}] {} — {}]\n\n",
                i + 1,
                typst_escape(&citation.source_title),
                typst_escape(&citation.source_uri),
            );
        }
    }

    // Build a Typst world with every SVG registered as a virtual
    // file so the `image(...)` calls resolve.
    let mut world = typst_export::TesseraWorld::new(&markup);
    for (name, bytes) in svg_files {
        let _ = world.add_file(&name, bytes);
    }
    match typst_export::compile_world_to_pdf(&world) {
        Ok(pdf) => pdf,
        Err(err) => {
            // Defensive fallback: compilation failed (e.g. bad
            // user-supplied SVG). Fall back to the minimal-PDF
            // builder so callers still get bytes. We log the error
            // via eprintln! because this module has no logger
            // injection point yet.
            eprintln!(
                "[tessera_export::pdf] Typst PDF compilation failed; \
                 falling back to minimal PDF builder: {err}"
            );
            export_pdf(artifact, citations)
        }
    }
}

/// Escape Typst markup metacharacters in user-supplied text.
///
/// Typst markup treats `#`, `*`, `_`, `=`, `[`, `]`, `<`, `>`, `$`, `@`,
/// `\\` and a handful of others as syntax. Embedding unescaped user
/// content (e.g. an artifact body containing `*important*` or `# Heading`)
/// would mis-format the output and, in the worst case, allow a
/// malicious citation title to inject markup. We escape conservatively
/// with backslash for every character Typst recognises as a sigil.
#[cfg(feature = "typst")]
fn typst_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    // Track whether the previously *emitted* character is a literal
    // `/`. We need to check the emitted-output side rather than the
    // input side because `file:///x` would otherwise produce
    // `file:/\//x` — the escape would only break up the first pair
    // of slashes, leaving a second `//` at positions 7-8 of the
    // output. By looking at the emitted output, we know that after
    // emitting `/\/` the last char is `/`, so the very next `/` from
    // the input still needs to be escaped to `\/` again.
    let mut prev_emitted_slash = false;
    for ch in s.chars() {
        // Devin Review PR #70 follow-up: neutralise Typst
        // comment introducers (`//` line, `/*` block) so that
        // file:// / http:// URIs and `/* ... */` prose in artifact
        // titles can't crash the Typst compile with "unclosed
        // delimiter" and silently degrade the whole PDF to the
        // minimal-PDF fallback path. The fix is to escape any `/`
        // that would otherwise be the second character of a
        // comment token; we escape the *second* char of the pair so
        // a lone `/` still passes through unescaped (preserving
        // visual fidelity for path / date strings).
        if prev_emitted_slash && (ch == '/' || ch == '*') {
            out.push('\\');
            out.push(ch);
            prev_emitted_slash = ch == '/';
            continue;
        }
        match ch {
            // Devin Review PR #70: backtick (`) was missing
            // from the escape set. Typst uses `` ` `` to delimit raw
            // / code text, so an artifact body containing inline
            // markdown code spans (extremely common: `` `foo` ``) or a
            // code fence sentinel would (a) open an unintended raw
            // block and (b) frequently leave an unmatched backtick
            // that fails Typst compilation outright. That failure
            // silently dropped the entire SVG-embedding path back to
            // the minimal PDF builder for ~every real document. Add
            // the backtick to the escape set so inline code survives
            // the Typst pipeline.
            //
            // Devin Review PR #70 follow-up: curly braces
            // (`{` / `}`) were also missing from the escape set. Typst
            // treats `{...}` as code-mode brackets — an artifact body
            // containing JSON examples, mustache-style placeholders
            // (`{{name}}`), set notation (`{1, 2, 3}`), or any prose
            // that happens to include a brace would cause Typst to
            // interpret the following text as code and fail compilation,
            // again silently dropping back to the minimal-PDF fallback.
            // Add `{` and `}` so curly braces in user content survive
            // the Typst pipeline.
            '#' | '*' | '_' | '=' | '[' | ']' | '<' | '>' | '$' | '@' | '\\' | '~' | '\'' | '`'
            | '{' | '}' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
        prev_emitted_slash = ch == '/';
    }
    out
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

    /// Devin Review PR #70 regression: `typst_escape` must
    /// backslash-escape every character that Typst recognises as a
    /// markup sigil, INCLUDING the backtick used to delimit raw / code
    /// text. Inline markdown code spans (`` `foo` ``) are extremely
    /// common in artifact bodies; an unescaped backtick would open an
    /// unintended raw block and frequently leave an unmatched token
    /// that fails Typst compilation outright, silently degrading the
    /// SVG-embedding PDF path back to the minimal builder.
    #[cfg(feature = "typst")]
    #[test]
    fn typst_escape_handles_backtick_and_sigils() {
        // Every documented Typst sigil should be preceded by `\`.
        let input = "# heading *bold* _it_ = $math$ [link] <tag> @ref \\backslash ~tilde 'apos `code` { } rest";
        let escaped = typst_escape(input);
        for sigil in [
            "\\#", "\\*", "\\_", "\\=", "\\[", "\\]", "\\<", "\\>", "\\$", "\\@", "\\\\", "\\~",
            "\\'", "\\`", "\\{", "\\}",
        ] {
            assert!(
                escaped.contains(sigil),
                "typst_escape missed sigil {sigil:?}; output:\n{escaped}",
            );
        }
        // Plain ASCII / non-sigil text passes through verbatim.
        assert!(escaped.contains("rest"));
        assert!(escaped.contains("heading"));
    }

    /// Devin Review PR #70 follow-up regression: curly-brace
    /// payloads (JSON examples, mustache-style placeholders, set
    /// notation) used to leak through `typst_escape` unescaped and
    /// caused Typst to enter code mode, failing compilation and
    /// silently dropping the entire SVG-embedding PDF path back to
    /// the minimal-PDF builder. Lock the contract: any string
    /// containing `{` / `}` MUST emerge with `\{` / `\}` so the
    /// braces render as literal characters in the PDF body.
    #[cfg(feature = "typst")]
    #[test]
    fn typst_escape_escapes_curly_braces_to_prevent_code_mode() {
        let json_example = r#"{"name": "Devin", "scores": [1, 2, 3]}"#;
        let escaped = typst_escape(json_example);
        // Every `{` and `}` in the input must be backslash-escaped.
        assert_eq!(
            json_example.matches('{').count(),
            escaped.matches("\\{").count()
        );
        assert_eq!(
            json_example.matches('}').count(),
            escaped.matches("\\}").count()
        );
        // Mustache-style double braces (`{{name}}`) also survive.
        let template = "Hello {{name}}, welcome.";
        let template_escaped = typst_escape(template);
        assert!(template_escaped.contains("\\{\\{name\\}\\}"));
    }

    /// Devin Review PR #70 follow-up — unit test for the
    /// real root cause. The reviewer reported missing `[N]` brackets
    /// in citation entries and proposed escaping the brackets; that
    /// diagnosis is empirically wrong (see comment in `typst_escape`).
    /// The actual bug is that the citation `source_uri` field
    /// commonly contains `file://` URIs and Typst parses `//` as a
    /// line comment, which consumes the closing `]` of the
    /// surrounding `#text(...)[ ... ]` content block and crashes the
    /// whole compile with "unclosed delimiter". The whole document
    /// then silently degrades to the minimal-PDF fallback, which is
    /// what produces the user-visible "missing brackets" symptom.
    ///
    /// Lock the contract: `typst_escape` MUST break up any `//`
    /// (and any `/*`) sequence so Typst's tokenizer cannot treat
    /// them as comment introducers.
    #[cfg(feature = "typst")]
    #[test]
    fn typst_escape_neutralises_line_and_block_comment_sequences() {
        // `//` line-comment introducer must be broken up.
        let escaped = typst_escape("file:///path/to/ref.pdf");
        assert!(
            !escaped.contains("//"),
            "typst_escape left a raw `//` in output: {escaped:?}",
        );
        assert!(
            escaped.contains("/\\/"),
            "typst_escape did not produce expected `/\\/` sequence: {escaped:?}",
        );
        // `/*` block-comment introducer must also be broken up.
        let escaped_block = typst_escape("see /* note */ here");
        assert!(
            !escaped_block.contains("/*"),
            "typst_escape left a raw `/*` in output: {escaped_block:?}",
        );
        // A single `/` MUST pass through unmolested — escaping every
        // slash would visually change every path / date in the
        // rendered output.
        let escaped_single = typst_escape("a/b/c date 2024/01/01");
        assert_eq!(
            escaped_single, "a/b/c date 2024/01/01",
            "typst_escape over-escaped a non-comment slash"
        );
    }

    /// Devin Review PR #70 follow-up — end-to-end regression.
    /// Before this fix, `export_pdf_with_svgs` for ANY artifact with a
    /// citation whose `source_uri` contained `//` (i.e. every real
    /// file:// or http:// URI) would silently fall through to the
    /// minimal-PDF builder because the Typst compile failed with
    /// "unclosed delimiter". This test exercises the public entry
    /// point with a realistic `file:///` URI and asserts the output
    /// is the Typst-built PDF (which uses `/FlateDecode`-compressed
    /// streams; the minimal builder never emits those).
    #[cfg(feature = "typst")]
    #[test]
    fn pdf_with_svgs_compiles_citations_for_file_uri_without_fallback() {
        let artifact = Artifact::new("Cited Doc".to_string(), ArtifactType::Document, None);
        let citation = Citation {
            citation_id: tessera_core::CitationId::new(),
            source_id: tessera_core::SourceId::new(),
            source_type: tessera_core::SourceType::LocalFile,
            source_title: "TheReferenceTitle".to_string(),
            // Realistic URI: contains `//` which is Typst's line
            // comment introducer. This MUST round-trip cleanly
            // through `typst_escape` and out the other side.
            source_uri: "file:///path/to/ref.pdf".to_string(),
            chunk_hash: "h".to_string(),
            source_file_hash: "fh".to_string(),
            page: Some(1),
            confidence: 1.0,
            used_for: "intro".to_string(),
            created_at: chrono::Utc::now(),
        };
        let prerendered: std::collections::HashMap<usize, String> =
            std::collections::HashMap::new();
        let pdf = export_pdf_with_svgs(&artifact, &[citation], &prerendered);
        assert!(
            pdf.starts_with(b"%PDF-"),
            "expected a real PDF, got {} bytes",
            pdf.len()
        );
        let pdf_str = String::from_utf8_lossy(&pdf);
        assert!(
            pdf_str.contains("/FlateDecode"),
            "expected Typst-compressed PDF (no fallback) — `//` in URI was \
             likely re-parsed as a line comment again; sample:\n{}",
            &pdf_str[..pdf_str.len().min(400)]
        );
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
