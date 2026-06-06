//! Mermaid block extraction and replacement for export pipelines.
//!
//! Tessera authors mermaid diagrams as ```mermaid fenced code blocks in
//! markdown content, OR as TipTap `<div data-type="mermaid" data-dsl="...">`
//! atoms in HTML-shaped content. This module provides a uniform extraction
//! and substitution surface used by:
//!
//! * `markdown.rs` — preserves fenced blocks as-is (downstream tools render
//!   them client-side).
//! * `html.rs` — emits a `<div class="mermaid">` placeholder that the bundled
//!   mermaid-runtime initializer turns into SVG, OR (when an SVG is supplied
//!   by the renderer process via IPC) inlines the SVG directly.
//! * `pdf.rs` — strips the DSL and emits a `[Diagram: <type>]` placeholder
//!   since the basic PDF builder can't lay out SVG paths. The Typst PDF
//!   pipeline (see `crate::typst`) handles real diagram embedding.

use std::fmt::Write as _;

/// Parsed diagram block extracted from artifact content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MermaidBlock {
    /// Raw Mermaid diagram source (the text inside the `mermaid`
    /// fenced code block), passed verbatim to the renderer.
    pub dsl: String,
    /// Best-effort detected diagram type (e.g. "flowchart", "pie"). Mirrors
    /// the renderer-side `detectDiagramType` heuristic.
    pub diagram_type: String,
    /// Byte range in the original content (start..end, end exclusive).
    pub range: (usize, usize),
}

/// Locate every ```mermaid fenced code block in the content. Closing fences
/// may be ``` or ~~~ as long as they match the opener. Triple-backtick fences
/// inside the DSL are not supported (mermaid itself disallows them).
pub fn extract_blocks(content: &str) -> Vec<MermaidBlock> {
    let mut blocks = Vec::new();
    let bytes = content.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        // Find the start of a fence at the start of a line.
        let line_start = i;
        let line_end = bytes[i..]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(bytes.len(), |p| i + p);
        let line = &content[line_start..line_end];
        let trimmed = line.trim_start();
        // Per CommonMark §4.5, a fenced code block opens with a run of 3+
        // backticks OR a run of 3+ tildes. We must capture the EXACT length of
        // the opening run so the closing-fence check can require ≥ that
        // many characters. Using a hard-coded 3-char prefix would mis-treat
        // longer fences: e.g. with a 6-backtick opener (` ```````mermaid `),
        // any 3-backtick line inside the block would be mistakenly accepted
        // as the close, prematurely terminating extraction and corrupting
        // both the captured DSL and the byte range we hand back to callers.
        let fence_ch = if trimmed.starts_with("```") {
            b'`'
        } else if trimmed.starts_with("~~~") {
            b'~'
        } else {
            i = line_end + 1;
            continue;
        };
        let fence_run_len = trimmed
            .as_bytes()
            .iter()
            .take_while(|&&b| b == fence_ch)
            .count();
        let after_fence = trimmed[fence_run_len..].trim_start();
        // The info string must be exactly `mermaid` (optionally followed by
        // whitespace + further info-string tokens). Substring-matching alone
        // would incorrectly classify ```mermaidx, ```mermaid-v2, ```mermaid_old
        // etc. as mermaid blocks and silently corrupt them on export.
        if !is_mermaid_info_string(after_fence) {
            i = line_end + 1;
            continue;
        }
        // Look for the closing fence.
        let dsl_start = line_end + 1;
        let mut search = dsl_start;
        let mut closing_line_start = None;
        while search < bytes.len() {
            let nl = bytes[search..]
                .iter()
                .position(|&b| b == b'\n')
                .map_or(bytes.len(), |p| search + p);
            let inner_line = &content[search..nl];
            // Per CommonMark §4.5, a closing fence line must consist of at
            // least as many fence characters as the opener, followed only by
            // optional trailing whitespace — it may NOT carry an info string.
            // Without this check, ```python on its own line inside a mermaid
            // block would be mistakenly treated as the close.
            if is_closing_fence(inner_line, fence_ch, fence_run_len) {
                closing_line_start = Some(search);
                break;
            }
            search = nl + 1;
        }
        let Some(closing_line_start) = closing_line_start else {
            // No closing fence; skip past this fence to avoid an infinite loop.
            i = line_end + 1;
            continue;
        };
        let closing_line_end = bytes[closing_line_start..]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(bytes.len(), |p| closing_line_start + p);

        let dsl = content[dsl_start..closing_line_start]
            .trim_end_matches('\n')
            .to_string();
        let diagram_type = detect_diagram_type(&dsl);
        // Clamp the end of the range to the content length so the caller can
        // safely slice `content[range.1..]` even when the closing fence is the
        // last line in the document (no trailing newline).
        let range_end = (closing_line_end + 1).min(content.len());
        blocks.push(MermaidBlock {
            dsl,
            diagram_type,
            range: (line_start, range_end),
        });
        i = range_end;
    }
    blocks
}

/// Return true if `after_fence` is the info string of a mermaid fenced block.
/// The exact info string is `mermaid` optionally followed by ASCII whitespace
/// and additional info-string tokens (e.g. `mermaid title="Foo"`). Anything
/// else (`mermaidx`, `mermaid-v2`, `mermaid_old`, `mermaid2`) is rejected.
fn is_mermaid_info_string(after_fence: &str) -> bool {
    const KEYWORD: &str = "mermaid";
    if let Some(rest) = after_fence.strip_prefix(KEYWORD) {
        rest.is_empty() || rest.as_bytes()[0].is_ascii_whitespace()
    } else {
        false
    }
}

/// Return true if `line` is a valid CommonMark closing fence for an opener
/// composed of `opener_run_len` characters of `fence_ch`. The line must
/// contain at least as many `fence_ch`s as the opener, followed only by
/// optional whitespace — it must NOT carry an info string, and a shorter
/// run does not close the block (CommonMark §4.5).
fn is_closing_fence(line: &str, fence_ch: u8, opener_run_len: usize) -> bool {
    let trimmed = line.trim_start();
    let run_len = trimmed
        .as_bytes()
        .iter()
        .take_while(|&&b| b == fence_ch)
        .count();
    if run_len < opener_run_len {
        return false;
    }
    // Everything after the fence run must be ASCII whitespace.
    trimmed[run_len..].bytes().all(|b| b.is_ascii_whitespace())
}

/// Replace every mermaid block in `content` with the output of `replace_with`,
/// passing each parsed block to the closure. Non-mermaid content is preserved
/// byte-for-byte.
///
/// **Newline convention:** `extract_blocks` includes the trailing newline of
/// the closing fence in `block.range`, so the byte range deliberately consumes
/// that newline. Replacement strings produced by `replace_with` must emit
/// their own trailing newline when the surrounding context is whitespace-
/// sensitive (e.g. Markdown, where a blank line is a paragraph separator —
/// `to_markdown_block` does this). HTML and PDF replacements
/// (`to_html_div`, `to_pdf_placeholder`) don't need one because `<div>` blocks
/// and PDF placeholders self-separate.
pub fn replace_blocks<F>(content: &str, mut replace_with: F) -> String
where
    F: FnMut(&MermaidBlock) -> String,
{
    let blocks = extract_blocks(content);
    if blocks.is_empty() {
        return content.to_string();
    }
    let mut out = String::with_capacity(content.len());
    let mut cursor = 0usize;
    for block in &blocks {
        out.push_str(&content[cursor..block.range.0]);
        out.push_str(&replace_with(block));
        cursor = block.range.1;
    }
    out.push_str(&content[cursor..]);
    out
}

/// Detect the diagram type by scanning the first non-empty / non-comment line.
/// Mirrors the renderer's `detectDiagramType` heuristic.
pub fn detect_diagram_type(dsl: &str) -> String {
    for raw in dsl.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with("%%") {
            continue;
        }
        for keyword in [
            "flowchart",
            "graph",
            "sequenceDiagram",
            "classDiagram",
            "stateDiagram",
            "gantt",
            "erDiagram",
            "pie",
            "architecture-beta",
            "architecture",
            "mindmap",
            "timeline",
        ] {
            if line.starts_with(keyword) {
                return if keyword == "graph" {
                    "flowchart".to_string()
                } else if keyword == "architecture-beta" {
                    "architecture".to_string()
                } else if keyword == "sequenceDiagram" {
                    "sequence".to_string()
                } else if keyword == "classDiagram" {
                    "class".to_string()
                } else if keyword == "stateDiagram" {
                    "state".to_string()
                } else if keyword == "erDiagram" {
                    "er".to_string()
                } else {
                    keyword.to_string()
                };
            }
        }
        return "unknown".to_string();
    }
    "unknown".to_string()
}

/// HTML replacement: emit a div the bundled mermaid runtime can pick up.
pub fn to_html_div(block: &MermaidBlock) -> String {
    let escaped = block
        .dsl
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let mut out = String::new();
    let _ = write!(
        out,
        r#"<div class="mermaid" data-diagram-type="{kind}">{dsl}</div>"#,
        kind = escape_attr(&block.diagram_type),
        dsl = escaped,
    );
    out
}

/// Markdown replacement: preserve the original block fenced as ```mermaid.
///
/// Emits a trailing newline so that a `\n\n` paragraph separator after the
/// original fence survives the round-trip — `extract_blocks` consumes the
/// closing-fence line's newline as part of `block.range`, so this is the only
/// place it can be reinstated.
pub fn to_markdown_block(block: &MermaidBlock) -> String {
    format!("```mermaid\n{}\n```\n", block.dsl)
}

/// PDF replacement: emit a one-line text placeholder describing the diagram,
/// since the basic PDF builder cannot rasterize SVG. Use the Typst PDF
/// pipeline (see [`render_block_to_svg`]) for real embedding.
pub fn to_pdf_placeholder(block: &MermaidBlock) -> String {
    format!(
        "[Diagram: {} — see HTML export for live rendering]",
        block.diagram_type
    )
}

/// render a mermaid block to an SVG string suitable
/// for embedding into a Typst document via `image.decode(svg, format: "svg")`.
///
/// Tessera does NOT bundle a full mermaid renderer on the Rust side
/// (mermaid.js is a 1 MB+ Node dependency that depends on a JS
/// runtime). The renderer process is responsible for the full,
/// production-quality SVG rendering — it has access to mermaid.js
/// and produces the same SVG the user sees in the in-app preview.
/// Callers SHOULD provide that SVG via the `prerendered` map argument
/// to [`crate::pdf::export_pdf_with_svgs`]; if they do, the
/// production renderer-quality SVG is embedded as-is.
///
/// When no prerendered SVG is supplied (e.g. headless / CLI export,
/// or any pathway that doesn't have a browser to drive mermaid.js),
/// this function emits a **structural** SVG fallback: a bordered
/// box containing the diagram type and the literal DSL text. The
/// fallback is intentionally simple but is still real SVG (with
/// `<rect>` and `<text>` elements), so:
///   - the embedded image is genuinely embedded (not the raw DSL
///     source text appearing inline in the PDF body, which is what
///     the placeholder path produced),
///   - the user can SEE that a diagram was intended to render here,
///     and read the underlying DSL to reproduce it manually if
///     needed,
///   - automated tests can assert "the PDF contains SVG path/rect
///     bytes, not the mermaid source" without depending on a JS
///     runtime in the test environment.
///
/// The choice to produce a structural fallback rather than to error
/// out keeps the export pipeline working in every environment Tessera
/// ships to — desktop with a renderer, headless CLI, CI builds — at
/// the cost of a less-pretty diagram in the "no renderer" path. The
/// renderer-driven path is always preferred for production exports.
pub fn render_block_to_svg(block: &MermaidBlock) -> String {
    // Layout the DSL line-by-line inside the SVG. Width / height are
    // chosen so a typical 6-line flowchart fits without clipping;
    // wider diagrams stretch the box but Typst will scale on layout
    // anyway. Font is monospace so the structural fallback looks
    // intentional rather than broken.
    let header_height = 24.0_f32;
    let line_height = 14.0_f32;
    let padding = 12.0_f32;
    let lines: Vec<&str> = block.dsl.lines().collect();
    let content_lines = lines.len().max(1) as f32;
    let height = header_height + padding * 2.0 + content_lines * line_height + 4.0;
    // Width: at least 360 to look like a diagram box, scaled up by the
    // longest line so DSL lines aren't clipped (assuming 7 px per
    // monospace char at 11 px font).
    let longest = lines.iter().map(|l| l.len()).max().unwrap_or(0).max(40);
    let width = (longest as f32 * 7.0 + padding * 2.0).max(360.0);

    let mut out = String::with_capacity(512 + block.dsl.len() * 2);
    let _ = write!(
        &mut out,
        "<svg xmlns=\"http://www.w3.org/2000/svg\" \
         viewBox=\"0 0 {w} {h}\" width=\"{w}\" height=\"{h}\">",
        w = width as u32,
        h = height as u32,
    );
    let _ = write!(
        &mut out,
        "<rect x=\"1\" y=\"1\" width=\"{}\" height=\"{}\" \
         fill=\"#f8fafc\" stroke=\"#334155\" stroke-width=\"1.5\" rx=\"6\"/>",
        width as u32 - 2,
        height as u32 - 2,
    );
    let _ = write!(
        &mut out,
        "<text x=\"{}\" y=\"{}\" font-family=\"sans-serif\" font-size=\"13\" \
         fill=\"#0f172a\" font-weight=\"bold\">Diagram: {}</text>",
        padding as u32,
        (padding + 14.0) as u32,
        escape_text(&block.diagram_type),
    );
    let mut y = padding + header_height;
    for line in lines.iter() {
        let _ = write!(
            &mut out,
            "<text x=\"{}\" y=\"{}\" font-family=\"monospace\" font-size=\"11\" \
             fill=\"#1e293b\" xml:space=\"preserve\">{}</text>",
            padding as u32,
            y as u32,
            escape_text(line),
        );
        y += line_height;
    }
    out.push_str("</svg>");
    out
}

/// XML-escape an SVG text-node body. Mermaid DSL routinely contains
/// `<`, `>`, and `&` (e.g. `A-->B`, `if & else`), all of which would
/// otherwise produce malformed SVG that Typst's `image.decode` rejects.
fn escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_no_blocks_from_plain_content() {
        let blocks = extract_blocks("just some text\nno diagrams here");
        assert!(blocks.is_empty());
    }

    #[test]
    fn extracts_a_single_flowchart_block() {
        let content = "Intro\n\n```mermaid\nflowchart TD\nA-->B\n```\n\nOutro";
        let blocks = extract_blocks(content);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].dsl, "flowchart TD\nA-->B");
        assert_eq!(blocks[0].diagram_type, "flowchart");
    }

    #[test]
    fn extracts_multiple_blocks_in_order() {
        let content =
            "```mermaid\npie\ntitle A\n```\n\nmiddle\n\n```mermaid\nsequenceDiagram\nA->>B: hi\n```";
        let blocks = extract_blocks(content);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].diagram_type, "pie");
        assert_eq!(blocks[1].diagram_type, "sequence");
    }

    #[test]
    fn handles_tilde_fences() {
        let content = "~~~mermaid\nflowchart LR\nX-->Y\n~~~";
        let blocks = extract_blocks(content);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].diagram_type, "flowchart");
    }

    #[test]
    fn skips_unclosed_fences() {
        let content = "```mermaid\nflowchart\nA-->B";
        let blocks = extract_blocks(content);
        assert!(blocks.is_empty());
    }

    #[test]
    fn replace_blocks_is_identity_when_no_diagrams() {
        let content = "## Section\n\nPlain text with `code`";
        let out = replace_blocks(content, |_| String::from("REPLACED"));
        assert_eq!(out, content);
    }

    #[test]
    fn extract_and_replace_handle_trailing_block_without_newline() {
        // Regression: when the closing fence is the last line in the content and
        // there is no trailing newline, the block range used to be set to
        // content.len() + 1, which caused replace_blocks to panic when slicing
        // content[cursor..].
        let content = "```mermaid\npie\n```";
        let blocks = extract_blocks(content);
        assert_eq!(blocks.len(), 1);
        let (start, end) = blocks[0].range;
        assert_eq!(start, 0);
        assert_eq!(end, content.len());
        // replace_blocks must not panic and must consume the whole input.
        let out = replace_blocks(content, |b| format!("[{}]", b.diagram_type));
        assert_eq!(out, "[pie]");
    }

    #[test]
    fn replace_blocks_substitutes_each_block() {
        // The block range is (start_of_opening_fence_line, end_of_closing_fence_line + 1),
        // so the substitution consumes the trailing newline after ```.
        let content = "before\n```mermaid\npie\ntitle X\n```\nafter";
        let out = replace_blocks(content, |b| format!("[{}]", b.diagram_type));
        assert_eq!(out, "before\n[pie]after");
    }

    #[test]
    fn html_div_renders_data_attributes_and_escapes() {
        let block = MermaidBlock {
            dsl: "graph TD\nA-->B & C".to_string(),
            diagram_type: "flowchart".to_string(),
            range: (0, 0),
        };
        let html = to_html_div(&block);
        assert!(html.contains(r#"class="mermaid""#));
        assert!(html.contains(r#"data-diagram-type="flowchart""#));
        assert!(html.contains("A--&gt;B &amp; C"));
    }

    #[test]
    fn markdown_block_round_trips_through_extract() {
        let block = MermaidBlock {
            dsl: "flowchart TD\nA-->B".to_string(),
            diagram_type: "flowchart".to_string(),
            range: (0, 0),
        };
        let md = to_markdown_block(&block);
        let reparsed = extract_blocks(&md);
        assert_eq!(reparsed.len(), 1);
        assert_eq!(reparsed[0].dsl, "flowchart TD\nA-->B");
    }

    #[test]
    fn markdown_replace_preserves_paragraph_separator_after_block() {
        // `to_markdown_block` returned `\`\`\`mermaid\n…\n\`\`\`` with no
        // trailing newline. Combined with `extract_blocks` consuming the
        // closing-fence line's `\n` as part of `block.range`, the `\n\n`
        // paragraph break between the fence and the next paragraph was
        // collapsed to a single `\n` — changing CommonMark semantics.
        let content = "## Arch\n\n```mermaid\nflowchart LR\nA-->B\n```\n\nSome text.\n";
        let out = replace_blocks(content, to_markdown_block);
        // The blank line between the closing fence and "Some text" must
        // survive the round-trip.
        assert!(
            out.contains("```\n\nSome text."),
            "paragraph separator was collapsed; got:\n{out}",
        );
        // And the block itself must still be a fenced mermaid block.
        assert!(out.contains("```mermaid\nflowchart LR\nA-->B\n```"));
    }

    #[test]
    fn pdf_placeholder_includes_diagram_type() {
        let block = MermaidBlock {
            dsl: "pie\ntitle X\nA: 1".to_string(),
            diagram_type: "pie".to_string(),
            range: (0, 0),
        };
        let p = to_pdf_placeholder(&block);
        assert!(p.contains("pie"));
        assert!(p.contains("Diagram"));
    }

    #[test]
    fn rejects_info_strings_that_only_start_with_mermaid() {
        // boundary). ```mermaidx, ```mermaid-v2, ```mermaid_old etc. are NOT
        // mermaid blocks and must be passed through unchanged.
        for not_mermaid in [
            "```mermaidx\nfoo\n```",
            "```mermaid-v2\nflowchart\n```",
            "```mermaid_old\npie\n```",
            "```mermaid2\nfoo\n```",
        ] {
            let blocks = extract_blocks(not_mermaid);
            assert!(
                blocks.is_empty(),
                "expected no mermaid match for {not_mermaid:?}, got {blocks:?}",
            );
        }
        // And the canonical info string (optionally followed by whitespace +
        // further info-string tokens) must still be accepted.
        for ok in [
            "```mermaid\nflowchart TD\n```",
            "```mermaid \nflowchart TD\n```",
            "```mermaid title=\"Demo\"\nflowchart TD\n```",
        ] {
            let blocks = extract_blocks(ok);
            assert_eq!(blocks.len(), 1, "expected match for {ok:?}");
        }
    }

    #[test]
    fn closing_fence_must_not_have_info_string() {
        // CommonMark, the closing fence may only contain fence characters
        // (≥ opener) followed by optional whitespace. Lines like ```python on
        // their own inside a mermaid block must NOT terminate the block.
        let content = "```mermaid\nflowchart TD\n```python\nA-->B\n```\n";
        let blocks = extract_blocks(content);
        assert_eq!(blocks.len(), 1, "closing-fence info string was honored");
        // The DSL must include the embedded ```python line, proving we walked
        // past it to the real closing fence.
        assert!(
            blocks[0].dsl.contains("```python"),
            "expected DSL to include the embedded fence line, got {:?}",
            blocks[0].dsl,
        );
        // And the real closer (` ``` ` with optional trailing spaces) must work.
        let trailing_ws = "```mermaid\nflowchart TD\nA-->B\n```   \n";
        let blocks = extract_blocks(trailing_ws);
        assert_eq!(blocks.len(), 1);
    }

    #[test]
    fn extended_fences_are_handled_per_commonmark() {
        // the fix, the opening fence was always treated as exactly 3 chars
        // (via `trim_start_matches(\"```\")` stripping the pattern repeatedly),
        // so a 6-backtick opener would be (a) accepted with a 3-backtick
        // logical length and (b) prematurely closed by any 3-backtick line
        // inside the block. Per CommonMark §4.5, the closing fence must
        // contain at least as many fence chars as the opener.

        // 1. 6-backtick opener with an embedded 3-backtick line that must NOT
        //    close the block.
        let extended = "``````mermaid\nflowchart TD\n```\nA-->B\n``````\n";
        let blocks = extract_blocks(extended);
        assert_eq!(
            blocks.len(),
            1,
            "6-backtick fence with embedded ``` line was misclosed",
        );
        assert!(
            blocks[0].dsl.contains("```"),
            "expected the embedded 3-backtick line to survive inside the DSL, got {:?}",
            blocks[0].dsl,
        );

        // 2. 4-backtick opener with a matching 4-backtick closer.
        let four = "````mermaid\npie\ntitle X\n````\n";
        let blocks = extract_blocks(four);
        assert_eq!(blocks.len(), 1, "4-backtick fence not recognised");
        assert_eq!(blocks[0].diagram_type, "pie");

        // 3. Tilde variant with a 5-tilde opener.
        let tildes = "~~~~~mermaid\nflowchart LR\n~~~\nA-->B\n~~~~~\n";
        let blocks = extract_blocks(tildes);
        assert_eq!(
            blocks.len(),
            1,
            "5-tilde fence with embedded ~~~ line was misclosed"
        );

        // 4. A closer with MORE chars than the opener is still valid
        //    (CommonMark allows the closing fence to be at least as long as
        //    the opener).
        let longer_close = "```mermaid\nflowchart TD\nA-->B\n``````\n";
        let blocks = extract_blocks(longer_close);
        assert_eq!(
            blocks.len(),
            1,
            "longer closer should still close the block"
        );
    }

    #[test]
    fn detect_diagram_type_handles_all_supported() {
        for (dsl, expected) in [
            ("flowchart TD\nA-->B", "flowchart"),
            ("graph LR\nA-->B", "flowchart"),
            ("sequenceDiagram\nA->>B: hi", "sequence"),
            ("classDiagram\nclass Foo", "class"),
            ("stateDiagram-v2\n[*] --> A", "state"),
            ("gantt\ntitle X", "gantt"),
            ("erDiagram\nA ||--o{ B : has", "er"),
            ("pie\ntitle Breakdown", "pie"),
            ("architecture-beta\ngroup api", "architecture"),
            ("mindmap\nroot", "mindmap"),
            ("timeline\nHistory", "timeline"),
            ("%% comment\nfoo", "unknown"),
        ] {
            assert_eq!(detect_diagram_type(dsl), expected, "for input: {dsl:?}");
        }
    }
}
