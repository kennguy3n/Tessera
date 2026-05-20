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
//!   pipeline (Task 14) handles real diagram embedding.

use std::fmt::Write as _;

/// Parsed diagram block extracted from artifact content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MermaidBlock {
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
        let fence = if trimmed.starts_with("```") {
            "```"
        } else if trimmed.starts_with("~~~") {
            "~~~"
        } else {
            i = line_end + 1;
            continue;
        };
        let after_fence = trimmed.trim_start_matches(fence).trim_start();
        if !after_fence.starts_with("mermaid") {
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
            if inner_line.trim_start().starts_with(fence) {
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

/// Replace every mermaid block in `content` with the output of `replace_with`,
/// passing each parsed block to the closure. Non-mermaid content is preserved
/// byte-for-byte.
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
pub fn to_markdown_block(block: &MermaidBlock) -> String {
    format!("```mermaid\n{}\n```", block.dsl)
}

/// PDF replacement: emit a one-line text placeholder describing the diagram,
/// since the basic PDF builder cannot rasterize SVG. Use the Typst PDF
/// pipeline for real embedding.
pub fn to_pdf_placeholder(block: &MermaidBlock) -> String {
    format!(
        "[Diagram: {} — see HTML export for live rendering]",
        block.diagram_type
    )
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
