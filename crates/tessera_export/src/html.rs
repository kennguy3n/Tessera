use std::fmt::Write;
use tessera_artifacts::Artifact;
use tessera_citations::citation::Citation;
use tessera_core::ArtifactType;

use crate::mermaid;

/// Artifact types whose content is a pre-rendered HTML fragment (produced by
/// the renderer-side preview builders in `InfographicEditor.tsx` /
/// `LandingPageEditor.tsx`) rather than markdown-like prose.
///
/// For these types the renderer is expected to ship the rich HTML through
/// `content_override` on the export IPC; we then inline it verbatim instead
/// of running it through the line-oriented `content_to_html` converter
/// (which would HTML-escape every `<` and `>` and chop the layout into
/// pseudo-paragraphs). If no override is passed and `artifact.content` is
/// still the raw JSON model, we wrap it in `<pre>` as a legible fallback
/// rather than producing a broken page.
fn is_visual_artifact_type(t: ArtifactType) -> bool {
    matches!(t, ArtifactType::Infographic | ArtifactType::LandingPage)
}

pub fn export_html(artifact: &Artifact, citations: &[Citation]) -> String {
    let mut output = String::new();

    // Mermaid runtime is only meaningful when the content is markdown that
    // can carry ```mermaid``` fences. Pre-rendered HTML from visual artifact
    // types doesn't go through `mermaid::extract_blocks` (the layout uses
    // inline `<svg>` from `embedIcons` instead), so we skip the detection
    // and avoid emitting an unused CDN <script> for those exports.
    let has_mermaid = !is_visual_artifact_type(artifact.artifact_type)
        && !mermaid::extract_blocks(&artifact.content).is_empty();

    output.push_str("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n");
    output.push_str("  <meta charset=\"UTF-8\">\n");
    output
        .push_str("  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n");
    let _ = writeln!(output, "  <title>{}</title>", escape_html(&artifact.title));
    output.push_str("  <style>\n");
    output.push_str("    body { font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; color: #4B5563; }\n");
    output.push_str("    h1 { color: #111827; }\n");
    output.push_str("    .citation { background: #F5F3FF; border-radius: 8px; padding: 1rem; margin: 0.5rem 0; }\n");
    output.push_str("    .citation-title { font-weight: 600; color: #7C3AED; }\n");
    output.push_str("    .citation-meta { font-size: 0.875rem; color: #6B7280; }\n");
    output.push_str("    .footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #E5E7EB; font-size: 0.875rem; color: #9CA3AF; }\n");
    output.push_str("    .mermaid { background: #FAFAFA; border-radius: 8px; padding: 1rem; margin: 1rem 0; }\n");
    output.push_str("  </style>\n</head>\n<body>\n");

    let _ = writeln!(output, "  <h1>{}</h1>", escape_html(&artifact.title));

    if !artifact.content.is_empty() {
        let html_content = if is_visual_artifact_type(artifact.artifact_type) {
            render_visual_artifact_content(&artifact.content)
        } else {
            content_to_html(&artifact.content)
        };
        let _ = write!(
            output,
            "  <div class=\"content\">\n{html_content}  </div>\n"
        );
    }

    if has_mermaid {
        // Load mermaid from a CDN as a one-shot client-side initializer.
        //
        // Intended audience: a user who runs "Save as HTML" and opens the
        // resulting `.html` file in a normal browser. Browsers have no CSP
        // by default, so the module import resolves and the diagrams render.
        //
        // Inside the desktop app's webview, the strict CSP from
        // `apps/desktop/electron/main.ts` (`script-src 'self'`) blocks this
        // CDN import — by design. The Electron renderer pre-renders the
        // mermaid SVG via the in-process `mermaidRenderer.ts` service and
        // inlines it directly through IPC, so when a Tessera HTML export is
        // viewed from inside the app the placeholder `<div class="mermaid">`
        // is replaced with inline `<svg>` content before paint. The CDN
        // script in this branch is therefore a redundant secondary path
        // that only activates outside the Electron shell.
        output.push_str("  <script type=\"module\">\n");
        output.push_str(
            "    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';\n",
        );
        output.push_str("    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: { primaryColor: '#7C3AED', primaryBorderColor: '#5B21B6', lineColor: '#6B7280' } });\n");
        output.push_str("    for (const el of document.querySelectorAll('div.mermaid')) {\n");
        output.push_str("      const dsl = el.textContent.trim();\n");
        output.push_str("      try {\n");
        output.push_str(
            "        const { svg } = await mermaid.render('tessera-mermaid-' + Math.random().toString(36).slice(2), dsl);\n",
        );
        output.push_str("        el.innerHTML = svg;\n");
        output.push_str("      } catch (err) { el.innerHTML = '<pre>Mermaid render error: ' + (err && err.message) + '</pre>'; }\n");
        output.push_str("    }\n");
        output.push_str("  </script>\n");
    }

    if !citations.is_empty() {
        output.push_str("  <hr>\n  <h2>Sources</h2>\n");
        for citation in citations {
            output.push_str("  <div class=\"citation\">\n");
            let _ = writeln!(
                output,
                "    <div class=\"citation-title\">{}</div>",
                escape_html(&citation.source_title)
            );
            let _ = write!(
                output,
                "    <div class=\"citation-meta\">Used for: {} | Confidence: {:.0}%",
                escape_html(&citation.used_for),
                citation.confidence * 100.0
            );
            if let Some(page) = citation.page {
                let _ = write!(output, " | Page: {page}");
            }
            output.push_str("</div>\n");
            let _ = writeln!(
                output,
                "    <div class=\"citation-meta\">{}</div>",
                escape_html(&citation.source_uri)
            );
            output.push_str("  </div>\n");
        }
    }

    let _ = writeln!(
        output,
        "  <div class=\"footer\">Generated by Tessera — {}</div>",
        artifact.updated_at.format("%Y-%m-%d %H:%M UTC")
    );

    output.push_str("</body>\n</html>\n");
    output
}

fn escape_html(text: &str) -> String {
    // Escape both `"` and `'` so this helper is safe to drop into either
    // single- or double-quoted HTML attribute contexts. The Rust HTML export
    // currently uses only double-quoted attributes, so escaping `'` is purely
    // defensive — but it keeps us aligned with the TypeScript `escapeHtml`
    // helpers in InfographicEditor.tsx / LandingPageEditor.tsx (which both
    // emit `&#39;`), so future callers can copy text between exporters
    // without risk of attribute escapes drifting out of sync.
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Render the content of a visual artifact (infographic / landing_page) for
/// HTML export. The renderer-side preview builders
/// (`buildPreviewHtml` / `buildLandingPreviewHtml`) emit a complete,
/// self-contained HTML fragment with user data already HTML-escaped, CSS
/// colors sanitised, and icon SVGs inlined. We inline that fragment
/// verbatim. If the content is *not* HTML — the override pipeline never
/// fired, so we still hold the raw JSON model — we wrap it in `<pre>` so
/// the user can at least read their data instead of seeing the line parser
/// chop the JSON braces into paragraphs.
fn render_visual_artifact_content(content: &str) -> String {
    if content.trim_start().starts_with('<') {
        let mut out = String::new();
        out.push_str("    ");
        out.push_str(content);
        if !content.ends_with('\n') {
            out.push('\n');
        }
        out
    } else {
        format!("    <pre>{}</pre>\n", escape_html(content))
    }
}

fn content_to_html(content: &str) -> String {
    // Process content as a sequence of (text_segment, optional_mermaid_block)
    // pairs. The line-oriented converter only sees real prose; mermaid blocks
    // are emitted as raw `<div class="mermaid">…</div>` between segments. This
    // is structurally safe — earlier versions used a sentinel-token round-trip
    // (`\u{1F4CC}TESSERA_MERMAID_TOKEN_N\u{1F4CC}`), but any artifact that
    // happened to contain the sentinel literally would be silently rewritten.
    let blocks = mermaid::extract_blocks(content);

    let mut html = String::new();
    let mut in_paragraph = false;
    let mut cursor = 0usize;
    for block in &blocks {
        let (start, end) = block.range;
        emit_text_segment(&content[cursor..start], &mut html, &mut in_paragraph);
        if in_paragraph {
            html.push_str("    </p>\n");
            in_paragraph = false;
        }
        html.push_str("    ");
        html.push_str(&mermaid::to_html_div(block));
        html.push('\n');
        cursor = end;
    }
    emit_text_segment(&content[cursor..], &mut html, &mut in_paragraph);

    if in_paragraph {
        html.push_str("</p>\n");
    }

    html
}

/// Process a contiguous run of text (no mermaid blocks) into the in-progress
/// HTML buffer. Tracks `in_paragraph` across calls so a paragraph split by a
/// mermaid block still closes its `<p>` correctly.
fn emit_text_segment(segment: &str, html: &mut String, in_paragraph: &mut bool) {
    for line in segment.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if *in_paragraph {
                html.push_str("    </p>\n");
                *in_paragraph = false;
            }
            continue;
        }

        if let Some(heading) = trimmed.strip_prefix("## ") {
            if *in_paragraph {
                html.push_str("    </p>\n");
                *in_paragraph = false;
            }
            let _ = writeln!(html, "    <h2>{}</h2>", escape_html(heading));
        } else if let Some(heading) = trimmed.strip_prefix("### ") {
            if *in_paragraph {
                html.push_str("    </p>\n");
                *in_paragraph = false;
            }
            let _ = writeln!(html, "    <h3>{}</h3>", escape_html(heading));
        } else if let Some(item) = trimmed.strip_prefix("- ") {
            if *in_paragraph {
                html.push_str("    </p>\n");
                *in_paragraph = false;
            }
            let _ = writeln!(html, "    <li>{}</li>", escape_html(item));
        } else if *in_paragraph {
            html.push(' ');
            html.push_str(&escape_html(trimmed));
        } else {
            html.push_str("    <p>");
            *in_paragraph = true;
            html.push_str(&escape_html(trimmed));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_artifacts::Artifact;
    use tessera_citations::citation::Citation;
    use tessera_core::{ArtifactType, SourceId, SourceType};

    #[test]
    fn export_basic_html() {
        let mut artifact = Artifact::new("Test PRD".to_string(), ArtifactType::Document, None);
        artifact.update_content("## Problem\n\nThe problem is X.".to_string());

        let html = export_html(&artifact, &[]);
        assert!(html.contains("<!DOCTYPE html>"));
        assert!(html.contains("<title>Test PRD</title>"));
        assert!(html.contains("<h1>Test PRD</h1>"));
        assert!(html.contains("<h2>Problem</h2>"));
        assert!(html.contains("The problem is X."));
    }

    #[test]
    fn export_html_with_citations() {
        let artifact = Artifact::new("Report".to_string(), ArtifactType::Document, None);
        let citations = vec![Citation::new(
            SourceId::new(),
            SourceType::LocalFile,
            "quarterly.pdf".to_string(),
            "file:///quarterly.pdf".to_string(),
            "hash1".to_string(),
            "file_hash1".to_string(),
            "Revenue figures".to_string(),
            0.88,
        )];

        let html = export_html(&artifact, &citations);
        assert!(html.contains("quarterly.pdf"));
        assert!(html.contains("Revenue figures"));
        assert!(html.contains("88%"));
    }

    #[test]
    fn export_html_with_mermaid_block() {
        let mut artifact = Artifact::new("Arch".to_string(), ArtifactType::Document, None);
        artifact.update_content(
            "## Overview\n\n```mermaid\nflowchart LR\nClient-->Server\n```\n\nText after."
                .to_string(),
        );
        let html = export_html(&artifact, &[]);
        assert!(html.contains(r#"<div class="mermaid""#));
        assert!(html.contains(r#"data-diagram-type="flowchart""#));
        assert!(html.contains("Client--&gt;Server"));
        // The runtime initializer should be present when content has a diagram.
        assert!(html.contains("mermaid.initialize"));
        // Text around the block should still be rendered as paragraphs.
        assert!(html.contains("<h2>Overview</h2>"));
        assert!(html.contains("Text after."));
    }

    #[test]
    fn export_html_does_not_treat_legacy_sentinel_token_specially() {
        // Earlier versions of `content_to_html` substituted mermaid blocks for
        // a sentinel token of the form `\u{1F4CC}TESSERA_MERMAID_TOKEN_N\u{1F4CC}`.
        // If a user happened to type the sentinel literally into prose, it
        // would have been silently rewritten. The refactored converter no
        // longer uses tokens, so the literal string round-trips unchanged
        // (modulo HTML escaping).
        let sentinel = "\u{1F4CC}TESSERA_MERMAID_TOKEN_0\u{1F4CC}";
        let mut artifact = Artifact::new("Notes".to_string(), ArtifactType::Document, None);
        artifact.update_content(format!("## Heading\n\n{sentinel} should appear as text."));
        let html = export_html(&artifact, &[]);
        assert!(
            html.contains(sentinel),
            "sentinel token must survive HTML conversion, got:\n{html}",
        );
        assert!(!html.contains(r#"class="mermaid""#));
    }

    #[test]
    fn export_html_omits_mermaid_runtime_when_no_diagrams() {
        let mut artifact = Artifact::new("Plain".to_string(), ArtifactType::Document, None);
        artifact.update_content("## Section\n\nJust prose.".to_string());
        let html = export_html(&artifact, &[]);
        assert!(!html.contains("mermaid.initialize"));
    }

    #[test]
    fn html_escapes_special_chars() {
        let artifact = Artifact::new(
            "<script>alert('xss')</script>".to_string(),
            ArtifactType::Document,
            None,
        );
        let html = export_html(&artifact, &[]);
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
        // Single quotes are also escaped (aligns with the TypeScript
        // escapeHtml helpers in InfographicEditor/LandingPageEditor, both of
        // which emit &#39;). This means the literal `'` from the title above
        // must not appear in the output.
        assert!(
            !html.contains("alert('xss')"),
            "single quotes should be escaped, but raw `'` is still present in:\n{html}",
        );
        assert!(html.contains("&#39;xss&#39;"));
    }

    // Regression for ANALYSIS_pr-review-job-944bd22719314f15b61523f7c7574bc6_0001:
    // Infographic HTML export used to round-trip the artifact's JSON content
    // through `content_to_html`, which chopped `{"title":...}` into pseudo-
    // paragraphs with HTML-escaped braces, completely losing the visual
    // layout. The fix is two-sided — the renderer pre-renders via
    // `buildPreviewHtml` and hands the resulting HTML through
    // `content_override`, and the Rust exporter (this branch) inlines that
    // HTML verbatim instead of treating it as markdown-like prose.
    #[test]
    fn export_html_inlines_pre_rendered_infographic_content_verbatim() {
        let mut artifact = Artifact::new(
            "Stats Overview".to_string(),
            ArtifactType::Infographic,
            None,
        );
        let pre_rendered = "<div class=\"infographic infographic-preview-vertical\" \
                            style=\"--igc-primary:#7C3AED;\">\
                            <header class=\"infographic-header\"><h1>Q4 KPIs</h1></header>\
                            <div class=\"infographic-grid\">\
                            <section class=\"infographic-section\">\
                            <div class=\"infographic-section-icon\">\
                            <svg viewBox=\"0 0 24 24\"><path d=\"M3 3h18\"/></svg>\
                            </div><h3>Growth</h3><p>+42% YoY</p>\
                            </section></div></div>";
        artifact.update_content(pre_rendered.to_string());

        let html = export_html(&artifact, &[]);
        // The rich HTML fragment must reach the body inline, *not* HTML-escaped.
        assert!(
            html.contains(pre_rendered),
            "pre-rendered infographic HTML must be inlined verbatim, got:\n{html}",
        );
        // Specifically, the inline <svg> must not have been turned into
        // `&lt;svg ...&gt;` by `content_to_html`.
        assert!(!html.contains("&lt;svg"));
        // No mermaid CDN script is appended for visual artifact types.
        assert!(!html.contains("mermaid.initialize"));
    }

    #[test]
    fn export_html_wraps_raw_json_infographic_in_pre_as_fallback() {
        // If the renderer fails to send a pre-rendered override (e.g. the
        // JSON model is corrupted and `parseInfographicContent` threw), the
        // Rust exporter still produces a legible page by wrapping the raw
        // JSON in <pre>, rather than mis-parsing it into broken paragraphs.
        let mut artifact = Artifact::new("Stats".to_string(), ArtifactType::Infographic, None);
        let raw_json = "{\"title\":\"Q4\",\"sections\":[]}";
        artifact.update_content(raw_json.to_string());

        let html = export_html(&artifact, &[]);
        assert!(html.contains("<pre>"));
        // The JSON braces must be HTML-escaped inside the <pre> wrapper.
        assert!(html.contains("&quot;title&quot;"));
        // And NOT chopped into <p> blocks with stripped braces.
        assert!(!html.contains("<p>{"));
    }

    #[test]
    fn export_html_inlines_pre_rendered_landing_page_content_verbatim() {
        let mut artifact = Artifact::new(
            "Product Landing".to_string(),
            ArtifactType::LandingPage,
            None,
        );
        let pre_rendered = "<div class=\"landing\" style=\"--lp-primary:#7C3AED;\">\
                            <header class=\"landing-hero\"><h1>Ship Faster</h1>\
                            <p>The fastest static-site generator.</p>\
                            <a class=\"landing-hero-cta\" href=\"#\">Get started</a>\
                            </header></div>";
        artifact.update_content(pre_rendered.to_string());

        let html = export_html(&artifact, &[]);
        assert!(
            html.contains(pre_rendered),
            "pre-rendered landing-page HTML must be inlined verbatim, got:\n{html}",
        );
        assert!(!html.contains("&lt;header"));
        assert!(!html.contains("mermaid.initialize"));
    }

    #[test]
    fn export_html_wraps_raw_json_landing_page_in_pre_as_fallback() {
        let mut artifact = Artifact::new("Landing".to_string(), ArtifactType::LandingPage, None);
        artifact.update_content("{\"hero\":{\"headline\":\"x\"},\"features\":[]}".to_string());
        let html = export_html(&artifact, &[]);
        assert!(html.contains("<pre>"));
        assert!(html.contains("&quot;headline&quot;"));
        assert!(!html.contains("<p>{"));
    }
}
