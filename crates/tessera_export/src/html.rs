//! HTML export of an artifact and its citations.

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

/// Renders `artifact` as a self-contained HTML document, appending a
/// citations section for `citations`. Markdown-based artifacts may
/// include `mermaid` fenced blocks that the renderer turns into
/// diagrams; pre-rendered visual artifacts are emitted as-is. Returns
/// the HTML as a `String`.
pub fn export_html(artifact: &Artifact, citations: &[Citation]) -> String {
    let mut output = String::new();

    // Mermaid runtime is only meaningful for markdown-shaped content that can
    // carry ```mermaid``` fences. We skip the scan entirely for:
    //   (a) pre-rendered visual artifacts — their layout inlines <svg> from
    //       `embedIcons`, never a fence; and
    //   (b) HTML documents from the TipTap editor — there a diagram is a
    //       `<div data-type="mermaid">` node, NOT a fence, so scanning the
    //       HTML can only ever false-positive on a literal "```mermaid" typed
    //       inside a code block, which would inject an inert external CDN
    //       <script> (a needless network dependency for local-first tenants)
    //       and still wouldn't render those nodes.
    // `looks_like_html` is a cheap leading-byte check placed before the O(n)
    // fence scan, so HTML docs short-circuit before doing the scan at all.
    // Genuine markdown exports start with markdown (so `looks_like_html` is
    // false) and keep their mermaid runtime.
    let has_mermaid = !is_visual_artifact_type(artifact.artifact_type)
        && !looks_like_html(&artifact.content)
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
    // Rich document blocks (callout / toggle / table-of-contents) exported
    // from the TipTap editor. The renderer persists `editor.getHTML()`, so the
    // exported HTML carries the real block markup; these rules mirror the
    // in-app token palette so a standalone `.html` file renders them legibly
    // without the application stylesheet. The callout icon is stored only as
    // the `data-icon` attribute (the in-app button is a node-view affordance,
    // not serialised content), so we surface it via a `::before` pseudo.
    output.push_str("    [data-type=\"callout\"] { display: flex; gap: 0.75rem; padding: 0.875rem 1rem; margin: 1rem 0; border-radius: 8px; border-left: 4px solid #6B7280; background: #F3F4F6; }\n");
    output.push_str("    [data-type=\"callout\"]::before { content: attr(data-icon); flex: 0 0 auto; line-height: 1.5; }\n");
    output.push_str("    [data-type=\"callout\"] > :first-child { margin-top: 0; }\n");
    output.push_str("    [data-type=\"callout\"] > :last-child { margin-bottom: 0; }\n");
    output.push_str("    [data-type=\"callout\"][data-variant=\"info\"] { border-left-color: #2563EB; background: #EFF6FF; }\n");
    output.push_str("    [data-type=\"callout\"][data-variant=\"success\"] { border-left-color: #16A34A; background: #F0FDF4; }\n");
    output.push_str("    [data-type=\"callout\"][data-variant=\"warning\"] { border-left-color: #D97706; background: #FFFBEB; }\n");
    output.push_str("    [data-type=\"callout\"][data-variant=\"danger\"] { border-left-color: #DC2626; background: #FEF2F2; }\n");
    output.push_str("    [data-type=\"callout\"][data-variant=\"note\"] { border-left-color: #7C3AED; background: #F5F3FF; }\n");
    output.push_str("    details[data-type=\"toggle\"] { margin: 1rem 0; padding: 0.5rem 0.75rem; border: 1px solid #E5E7EB; border-radius: 8px; }\n");
    output.push_str("    details[data-type=\"toggle\"] > summary { cursor: pointer; font-weight: 600; color: #111827; }\n");
    output.push_str("    details[data-type=\"toggle\"] > div[data-type=\"toggle-body\"] { margin-top: 0.5rem; padding-left: 0.75rem; border-left: 2px solid #E5E7EB; }\n");
    output.push_str("    nav.doc-toc { margin: 1rem 0; padding: 0.875rem 1rem; border: 1px solid #E5E7EB; border-radius: 8px; background: #FAFAFA; }\n");
    output.push_str("    nav.doc-toc .doc-toc-title { font-weight: 600; color: #111827; margin: 0 0 0.5rem; }\n");
    output.push_str("    nav.doc-toc ul { list-style: none; margin: 0; padding: 0; }\n");
    output.push_str("    nav.doc-toc li { margin: 0.125rem 0; }\n");
    output.push_str("    nav.doc-toc li.doc-toc-l2 { padding-left: 1rem; }\n");
    output.push_str("    nav.doc-toc li.doc-toc-l3 { padding-left: 2rem; }\n");
    output.push_str("    nav.doc-toc a { color: #4B5563; text-decoration: none; }\n");
    output.push_str("    nav.doc-toc a:hover { text-decoration: underline; }\n");
    output.push_str("  </style>\n</head>\n<body>\n");

    let _ = writeln!(output, "  <h1>{}</h1>", escape_html(&artifact.title));

    if !artifact.content.is_empty() {
        let html_content = if is_visual_artifact_type(artifact.artifact_type) {
            render_visual_artifact_content(&artifact.content)
        } else if looks_like_html(&artifact.content) {
            // An edited Document persists `editor.getHTML()`, so its content is
            // already an HTML fragment carrying rich blocks (callout, toggle,
            // tables, the table-of-contents marker, …). The line-oriented
            // `content_to_html` converter would HTML-escape every tag and
            // flatten that structure to plain text. Inline it verbatim instead
            // (mirroring `render_visual_artifact_content`) after regenerating
            // the TOC and assigning heading anchors, so the new blocks survive
            // HTML export with full fidelity.
            render_document_html(&artifact.content)
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
        // Render every diagram concurrently via `Promise.all` rather than a
        // serial `for ... of await`. Mermaid's `render()` is asynchronous
        // (it walks the DSL through its parser and lays the diagram out in
        // an offscreen DOM), so a sequential loop would block each diagram
        // on the previous one — meaningfully slow for documents with many
        // architecture / sequence diagrams. Each iteration carries its own
        // try/catch so a single broken DSL block produces an inline error
        // panel without aborting the rest of the batch.
        output.push_str("  <script type=\"module\">\n");
        output.push_str(
            "    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';\n",
        );
        output.push_str("    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: { primaryColor: '#7C3AED', primaryBorderColor: '#5B21B6', lineColor: '#6B7280' } });\n");
        output.push_str("    await Promise.all([...document.querySelectorAll('div.mermaid')].map(async (el) => {\n");
        output.push_str("      const dsl = el.textContent.trim();\n");
        output.push_str("      try {\n");
        output.push_str(
            "        const { svg } = await mermaid.render('tessera-mermaid-' + Math.random().toString(36).slice(2), dsl);\n",
        );
        output.push_str("        el.innerHTML = svg;\n");
        output.push_str("      } catch (err) { el.innerHTML = '<pre>Mermaid render error: ' + (err && err.message) + '</pre>'; }\n");
        output.push_str("    }));\n");
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

/// Exact serialised form of the table-of-contents block (`TableOfContentsNode`
/// emits a bare marker `<div>`; the live heading list is a node-view-only
/// affordance and is therefore absent from `getHTML()`). We expand this marker
/// into a real `<nav>` at export time so a static HTML file carries a usable,
/// linked outline rather than an empty div.
const TOC_MARKER: &str = "<div data-type=\"table-of-contents\"></div>";

/// A heading discovered while scanning a document's HTML, used both to build
/// the regenerated TOC and to anchor it via injected `id`s.
struct TocEntry {
    level: u8,
    /// HTML-escaped, tag-stripped heading text (safe to drop into the nav).
    label: String,
    /// URL-fragment slug, unique within the document.
    slug: String,
}

/// True when `content` already looks like an HTML fragment — the normal shape
/// for an edited Document, since the renderer persists `editor.getHTML()`. We
/// require a leading `<tag`/`</`/`<!` so markdown-shaped content (`## Heading`,
/// prose, `- item`) still flows through the line-oriented `content_to_html`
/// converter and the existing markdown-document exports keep their behaviour.
fn looks_like_html(content: &str) -> bool {
    let trimmed = content.trim_start();
    let bytes = trimmed.as_bytes();
    bytes.first() == Some(&b'<')
        && bytes
            .get(1)
            .is_some_and(|&b| b.is_ascii_alphabetic() || b == b'!' || b == b'/')
}

/// Strip every HTML tag from `html`, returning only the text nodes. Used to
/// derive a heading's plain-text label from its (possibly mark-wrapped) inner
/// HTML, e.g. `Plan <strong>B</strong>` → `Plan B`.
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

/// Decode the small set of HTML entities the editor emits, so slugs and TOC
/// labels read naturally. `&amp;` is decoded last so an input like
/// `&amp;lt;` round-trips to `&lt;` rather than being double-decoded to `<`.
fn decode_entities(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// Build a URL-fragment slug from heading text. Mirrors the renderer-side
/// `slugifyHeading` (`documentOutlineHelpers.ts`) character-for-character:
/// lowercase, every run of non-alphanumeric characters collapsed to a single
/// `-`, no leading/trailing `-`. Both sides keep UNICODE alphanumerics
/// (`char::is_alphanumeric` here, `\p{L}\p{N}` there) so a heading like
/// "Café Crème" or "概述" slugs identically in-app and in the export — keep
/// the two in lockstep if you touch either.
fn slugify(text: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in text.trim().to_lowercase().chars() {
        if ch.is_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch);
        } else {
            pending_dash = true;
        }
    }
    out
}

/// Extract the value of an `id` attribute from a tag's opening markup, if one
/// is present. Handles both double- and single-quoted forms
/// (`id="x"` / `id='x'`). Returns `None` when the tag carries no `id`.
fn extract_id_value(open_tag: &str) -> Option<String> {
    for pat in [" id=\"", " id='"] {
        if let Some(start) = open_tag.find(pat) {
            let quote = pat.chars().last().unwrap();
            let rest = &open_tag[start + pat.len()..];
            if let Some(end) = rest.find(quote) {
                return Some(rest[..end].to_string());
            }
        }
    }
    None
}

/// If `content[start..]` opens an `<h1>`–`<h3>` tag, return its level and the
/// byte index of the closing `>` of the open tag. Heading levels h4–h6 are
/// intentionally excluded to match the in-app outline (which tracks h1–h3).
///
/// Only lowercase `<hN>` is matched: the `looks_like_html` gate guarantees this
/// path only sees editor-produced HTML (`editor.getHTML()`), which always emits
/// lowercase tag names. Keeping the open matcher lowercase-only stays in lockstep
/// with the lowercase `</hN>` close tag built in `collect_and_anchor_headings`.
fn match_heading_open(content: &str, start: usize) -> Option<(u8, usize)> {
    let bytes = content.as_bytes();
    if bytes.get(start) != Some(&b'<') {
        return None;
    }
    let tag = *bytes.get(start + 1)?;
    if tag != b'h' {
        return None;
    }
    let level = *bytes.get(start + 2)?;
    if !(b'1'..=b'3').contains(&level) {
        return None;
    }
    let after = *bytes.get(start + 3)?;
    if after != b'>' && !after.is_ascii_whitespace() {
        return None;
    }
    let gt = content[start..].find('>')? + start;
    Some((level - b'0', gt))
}

/// Pre-scan headings and seed the `used` slug map with every author-supplied
/// `id`, so the main pass can reserve them before assigning computed slugs.
///
/// This makes computed-vs-explicit de-duplication order-independent: without
/// it, a *computed* slug (e.g. `intro`) injected on an earlier heading could
/// collide with an *explicit* `id="intro"` on a later heading, emitting two
/// elements with the same id. Reserving every explicit id up front means the
/// computed heading is disambiguated to `intro-2` instead, regardless of which
/// heading appears first. Each reserved id starts at count `1` so the first
/// colliding computed slug bumps straight to a `-2` suffix.
fn reserve_existing_heading_ids(content: &str) -> std::collections::HashMap<String, u32> {
    let mut used: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    let mut i = 0usize;
    while i < content.len() {
        if content.as_bytes()[i] != b'<' {
            let next = content[i..].find('<').map_or(content.len(), |p| i + p);
            i = next;
            continue;
        }
        if let Some((_level, open_end)) = match_heading_open(content, i) {
            let open_tag = &content[i..=open_end];
            if let Some(existing) = extract_id_value(open_tag) {
                used.entry(existing).or_insert(1);
            }
            i = open_end + 1;
            continue;
        }
        i += 1;
    }
    used
}

/// Walk a document's HTML once, copying it through while (a) collecting h1–h3
/// headings for the TOC and (b) injecting a unique `id` anchor into each
/// heading that lacks one. Returns the rewritten HTML and the heading list.
///
/// The scan is linear: non-`<` runs are copied wholesale, and headings are
/// matched against `<hN`. All slicing happens on byte offsets of ASCII `<`/`>`
/// characters, so UTF-8 content (e.g. accented headings) is preserved intact.
fn collect_and_anchor_headings(content: &str) -> (String, Vec<TocEntry>) {
    let mut out = String::with_capacity(content.len() + 64);
    let mut entries: Vec<TocEntry> = Vec::new();
    // Seed with every author-supplied heading id (see
    // `reserve_existing_heading_ids`) so a computed slug can never collide with
    // an explicit id that appears on a *later* heading.
    let mut used = reserve_existing_heading_ids(content);
    let mut i = 0usize;

    while i < content.len() {
        if content.as_bytes()[i] != b'<' {
            let next = content[i..].find('<').map_or(content.len(), |p| i + p);
            out.push_str(&content[i..next]);
            i = next;
            continue;
        }

        if let Some((level, open_end)) = match_heading_open(content, i) {
            let close_tag = format!("</h{level}>");
            if let Some(close_rel) = content[open_end + 1..].find(&close_tag) {
                let inner_start = open_end + 1;
                let inner_end = inner_start + close_rel;
                let inner = &content[inner_start..inner_end];
                let text = decode_entities(&strip_tags(inner));
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    let open_tag = &content[i..=open_end];
                    // The TOC link must point at the heading's *actual* anchor.
                    // If the author already set an `id`, preserve it verbatim and
                    // use it as the slug; only compute (and inject) a slug when the
                    // heading has none. Existing ids were already reserved in
                    // `reserve_existing_heading_ids`, so a computed slug below
                    // can't collide with one — regardless of heading order.
                    let slug = if let Some(existing) = extract_id_value(open_tag) {
                        out.push_str(open_tag);
                        existing
                    } else {
                        let base = {
                            let s = slugify(trimmed);
                            if s.is_empty() {
                                "section".to_string()
                            } else {
                                s
                            }
                        };
                        let count = used.entry(base.clone()).or_insert(0);
                        *count += 1;
                        let slug = if *count == 1 {
                            base.clone()
                        } else {
                            format!("{base}-{count}")
                        };
                        // Insert the id immediately after `<hN`.
                        out.push_str(&content[i..i + 3]);
                        let _ = write!(out, " id=\"{slug}\"");
                        out.push_str(&content[i + 3..=open_end]);
                        slug
                    };

                    out.push_str(inner);
                    out.push_str(&close_tag);

                    entries.push(TocEntry {
                        level,
                        label: escape_html(trimmed),
                        slug,
                    });
                    i = inner_end + close_tag.len();
                    continue;
                }
            }
        }

        // Not a heading we expand: copy the single `<` and advance (ASCII, so
        // a 1-byte step stays on a char boundary) — the next iteration's
        // non-`<` fast path copies the rest of the tag in one shot.
        out.push('<');
        i += 1;
    }

    (out, entries)
}

/// Render an HTML `<nav>` outline from collected headings. Always emits the
/// titled container (even when empty) so the marker never leaves a dangling
/// empty `<div>` in the export.
fn build_toc_nav(entries: &[TocEntry]) -> String {
    let mut nav = String::from(
        "<nav class=\"doc-toc\" aria-label=\"Table of contents\">\
<p class=\"doc-toc-title\">Table of contents</p>",
    );
    if !entries.is_empty() {
        nav.push_str("<ul>");
        for entry in entries {
            // Both the slug and the label are HTML-escaped. Computed slugs are
            // already `[a-z0-9-]` so escaping is a no-op for them, but a slug
            // taken verbatim from an author-supplied heading `id`
            // (`extract_id_value`) can contain `"`/`<`/`&`; escaping stops it
            // from breaking out of the double-quoted `href` attribute. The
            // browser attribute-decodes `&quot;` back to `"` on click, so the
            // fragment still matches the (verbatim) heading `id`.
            let _ = write!(
                nav,
                "<li class=\"doc-toc-l{}\"><a href=\"#{}\">{}</a></li>",
                entry.level,
                escape_html(&entry.slug),
                entry.label
            );
        }
        nav.push_str("</ul>");
    }
    nav.push_str("</nav>");
    nav
}

/// Case-insensitive ASCII substring search over raw bytes. Used to locate
/// `</tag>` close markers regardless of their casing, without allocating a
/// lowercased copy of the haystack (which could shift byte offsets for
/// non-ASCII input and desync them from the original string).
fn find_ascii_ci(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (0..=haystack.len() - needle.len())
        .find(|&k| haystack[k..k + needle.len()].eq_ignore_ascii_case(needle))
}

/// Defense-in-depth: strip executable / embedding elements (and their content)
/// from document HTML before it is inlined verbatim into an export.
///
/// TipTap's schema never emits these — `editor.getHTML()` yields only the
/// editor's whitelisted nodes and marks — so for well-formed content this is a
/// no-op. It exists purely so that if artifact content were ever populated from
/// a source that bypassed the editor, no `<script>`/`<iframe>`/`<object>`/
/// `<embed>`/`<applet>`/`<noscript>` can survive into the static HTML file. The
/// scan is byte-oriented and ASCII-case-insensitive; non-`<` runs are copied
/// wholesale so UTF-8 content is preserved intact.
fn strip_unsafe_elements(html: &str) -> String {
    const BLOCK_TAGS: [&str; 6] = ["script", "iframe", "object", "embed", "applet", "noscript"];
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len());
    let mut i = 0usize;

    while i < html.len() {
        if bytes[i] != b'<' {
            let next = html[i..].find('<').map_or(html.len(), |p| i + p);
            out.push_str(&html[i..next]);
            i = next;
            continue;
        }

        let mut matched = false;
        for tag in BLOCK_TAGS {
            let rest = &bytes[i + 1..];
            if rest.len() >= tag.len() && rest[..tag.len()].eq_ignore_ascii_case(tag.as_bytes()) {
                // Require a tag-name boundary so `<embedded>` doesn't match `embed`.
                let boundary = bytes.get(i + 1 + tag.len()).copied();
                let ok = boundary.is_none()
                    || matches!(boundary, Some(b) if b == b'>' || b == b'/' || b.is_ascii_whitespace());
                if ok {
                    let close = format!("</{tag}>");
                    let search_from = i + 1 + tag.len();
                    if let Some(rel) = find_ascii_ci(&bytes[search_from..], close.as_bytes()) {
                        i = search_from + rel + close.len();
                    } else if let Some(gt) = html[i..].find('>') {
                        // Unclosed / void form: drop just the opening tag.
                        i += gt + 1;
                    } else {
                        i = html.len();
                    }
                    matched = true;
                    break;
                }
            }
        }
        if matched {
            continue;
        }

        out.push('<');
        i += 1;
    }

    out
}

/// If `html[start..]` begins an *empty* table-of-contents marker element,
/// return the byte index just past its closing `</div>`.
///
/// The exact serialised form (`TOC_MARKER`) is matched as a fast path, but we
/// also tolerate attribute-order changes and extra attributes (e.g. a future
/// TipTap version emitting `<div class="x" data-type="table-of-contents">`):
/// any empty `<div>` whose opening tag carries a `data-type="table-of-contents"`
/// attribute counts. Relying on a byte-exact match alone would silently leave
/// an empty `<div>` in the export if serialization ever changed. Only *empty*
/// markers match (open tag immediately followed by `</div>`, modulo
/// whitespace) so an authored div that happens to carry the attribute and has
/// real content is never clobbered.
fn match_toc_marker(html: &str, start: usize) -> Option<usize> {
    let rest = &html[start..];
    // Fast path: the exact marker the editor currently emits.
    if let Some(stripped) = rest.strip_prefix(TOC_MARKER) {
        return Some(html.len() - stripped.len());
    }

    let bytes = html.as_bytes();
    // Must open with `<div` followed by a tag-name boundary.
    let after_div = bytes.get(start + 1..start + 4)?;
    if !after_div.eq_ignore_ascii_case(b"div") {
        return None;
    }
    match bytes.get(start + 4) {
        Some(&b) if b == b'>' || b == b'/' || b.is_ascii_whitespace() => {}
        _ => return None,
    }

    let open_end = html[start..].find('>')? + start;
    let open_tag = &html[start..=open_end];
    let has_toc = open_tag.contains("data-type=\"table-of-contents\"")
        || open_tag.contains("data-type='table-of-contents'");
    if !has_toc {
        return None;
    }
    // `<div ... />` self-closing form (unlikely from TipTap) is already empty.
    if open_tag.ends_with("/>") {
        return Some(open_end + 1);
    }
    // Otherwise require an immediately-following `</div>` (only whitespace
    // allowed between) so we only ever replace the empty marker element.
    let after = html[open_end + 1..].trim_start();
    let remainder = after.strip_prefix("</div>")?;
    Some(html.len() - remainder.len())
}

/// Replace every table-of-contents marker element in `html` with `nav`.
/// Scans linearly, copying non-marker content through unchanged.
fn expand_toc_markers(html: &str, nav: &str) -> String {
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len() + nav.len());
    let mut i = 0usize;
    while i < html.len() {
        if bytes[i] != b'<' {
            let next = html[i..].find('<').map_or(html.len(), |p| i + p);
            out.push_str(&html[i..next]);
            i = next;
            continue;
        }
        if let Some(end) = match_toc_marker(html, i) {
            out.push_str(nav);
            i = end;
            continue;
        }
        out.push('<');
        i += 1;
    }
    out
}

/// Render an edited Document (HTML content) for HTML export. Inlines the
/// fragment verbatim after stripping any unsafe elements (defense-in-depth),
/// anchoring headings, and expanding the table-of-contents marker into a
/// generated `<nav>`.
fn render_document_html(content: &str) -> String {
    let sanitized = strip_unsafe_elements(content);
    let (anchored, entries) = collect_and_anchor_headings(&sanitized);
    let nav = build_toc_nav(&entries);
    let body = expand_toc_markers(&anchored, &nav);

    let mut out = String::with_capacity(body.len() + 8);
    out.push_str("    ");
    out.push_str(&body);
    if !body.ends_with('\n') {
        out.push('\n');
    }
    out
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
    fn looks_like_html_detects_fragments_not_markdown() {
        assert!(looks_like_html("<p>hi</p>"));
        assert!(looks_like_html("  \n<h1>Title</h1>"));
        assert!(looks_like_html("<!-- comment --><div></div>"));
        assert!(looks_like_html("</p>"));
        assert!(!looks_like_html("## Heading"));
        assert!(!looks_like_html("- bullet"));
        assert!(!looks_like_html("plain prose < not a tag"));
        assert!(!looks_like_html(""));
    }

    #[test]
    fn slugify_matches_outline_heuristic() {
        assert_eq!(slugify("Hello World"), "hello-world");
        assert_eq!(slugify("  Trim — Me!  "), "trim-me");
        assert_eq!(slugify("Multiple   spaces"), "multiple-spaces");
        assert_eq!(slugify("!!!"), "");
        assert_eq!(slugify("Café Crème"), "café-crème");
    }

    #[test]
    fn strip_tags_and_decode_entities() {
        assert_eq!(strip_tags("Plan <strong>B</strong>"), "Plan B");
        assert_eq!(decode_entities("a &amp;lt; b"), "a &lt; b");
        assert_eq!(
            decode_entities("&lt;tag&gt; &quot;x&quot; &#39;y&#39;"),
            "<tag> \"x\" 'y'"
        );
    }

    #[test]
    fn export_document_html_inlines_callout_verbatim() {
        // A callout serialises to `<div data-type="callout" ...>` with a content
        // hole. The HTML exporter must inline it verbatim (not escape it) so the
        // block survives, and the export stylesheet must target it.
        let mut artifact = Artifact::new("Notes".to_string(), ArtifactType::Document, None);
        artifact.update_content(
            "<div data-variant=\"warning\" data-icon=\"⚠️\" data-type=\"callout\"><p>Heads up</p></div>"
                .to_string(),
        );

        let html = export_html(&artifact, &[]);
        // Verbatim block markup (not HTML-escaped).
        assert!(
            html.contains("<div data-variant=\"warning\" data-icon=\"⚠️\" data-type=\"callout\">")
        );
        assert!(html.contains("<p>Heads up</p>"));
        assert!(!html.contains("&lt;div data-variant"));
        // Stylesheet carries the callout rules + icon pseudo.
        assert!(html.contains("[data-type=\"callout\"][data-variant=\"warning\"]"));
        assert!(html.contains("content: attr(data-icon)"));
    }

    #[test]
    fn export_document_html_preserves_toggle_disclosure() {
        let mut artifact = Artifact::new("FAQ".to_string(), ArtifactType::Document, None);
        artifact.update_content(
            "<details data-type=\"toggle\" open><summary>Q?</summary><div data-type=\"toggle-body\"><p>A.</p></div></details>"
                .to_string(),
        );

        let html = export_html(&artifact, &[]);
        assert!(html.contains("<details data-type=\"toggle\" open>"));
        assert!(html.contains("<summary>Q?</summary>"));
        assert!(html.contains("<div data-type=\"toggle-body\">"));
        assert!(html.contains("details[data-type=\"toggle\"] > summary"));
    }

    #[test]
    fn export_document_html_regenerates_toc_and_anchors_headings() {
        let mut artifact = Artifact::new("Guide".to_string(), ArtifactType::Document, None);
        artifact.update_content(
            "<div data-type=\"table-of-contents\"></div>\
<h1>Getting Started</h1><p>x</p>\
<h2>Install &amp; Setup</h2><p>y</p>\
<h2>Getting Started</h2>"
                .to_string(),
        );

        let html = export_html(&artifact, &[]);
        // The empty marker is gone; a real nav replaces it.
        assert!(!html.contains(TOC_MARKER));
        assert!(html.contains("<nav class=\"doc-toc\" aria-label=\"Table of contents\">"));
        // Headings get unique slug ids; the duplicate gets a numeric suffix.
        assert!(html.contains("<h1 id=\"getting-started\">Getting Started</h1>"));
        assert!(html.contains("<h2 id=\"getting-started-2\">Getting Started</h2>"));
        // TOC links resolve to those anchors; the entity label is preserved.
        assert!(html.contains("<a href=\"#getting-started\">Getting Started</a>"));
        assert!(html.contains("<a href=\"#install-setup\">Install &amp; Setup</a>"));
        assert!(html.contains("class=\"doc-toc-l2\""));
    }

    #[test]
    fn export_document_html_does_not_double_anchor_existing_ids() {
        let mut artifact = Artifact::new("Doc".to_string(), ArtifactType::Document, None);
        artifact.update_content("<h1 id=\"intro\">Intro</h1><p>body</p>".to_string());

        let html = export_html(&artifact, &[]);
        assert!(html.contains("<h1 id=\"intro\">Intro</h1>"));
        // No second id attribute injected.
        assert!(!html.contains("id=\"intro\" id="));
    }

    #[test]
    fn export_document_html_toc_link_targets_existing_heading_id() {
        // Regression for BUG-0001: when a heading already carries an `id`, the
        // generated TOC entry must link to that *actual* id, not a freshly
        // computed slug derived from the heading text.
        let mut artifact = Artifact::new("Doc".to_string(), ArtifactType::Document, None);
        artifact.update_content(
            "<div data-type=\"table-of-contents\"></div>\
<h1 id=\"my-intro\">Intro</h1><p>body</p>"
                .to_string(),
        );

        let html = export_html(&artifact, &[]);
        // The heading keeps its author-supplied id…
        assert!(html.contains("<h1 id=\"my-intro\">Intro</h1>"));
        // …and the TOC anchor points at it (not at the computed "#intro").
        assert!(html.contains("<a href=\"#my-intro\">Intro</a>"));
        assert!(!html.contains("href=\"#intro\""));
    }

    #[test]
    fn export_document_html_existing_id_is_reserved_against_computed_collision() {
        // A later heading whose text slugifies to an already-used explicit id
        // must be disambiguated rather than producing a duplicate anchor.
        let mut artifact = Artifact::new("Doc".to_string(), ArtifactType::Document, None);
        artifact.update_content(
            "<h1 id=\"intro\">Preface</h1><p>a</p><h2>Intro</h2><p>b</p>".to_string(),
        );

        let html = export_html(&artifact, &[]);
        assert!(html.contains("<h1 id=\"intro\">Preface</h1>"));
        // The second heading slugifies to "intro" but that id is taken, so it
        // gets a numeric suffix.
        assert!(html.contains("<h2 id=\"intro-2\">Intro</h2>"));
    }

    #[test]
    fn export_document_html_toc_href_escapes_slug_from_singlequoted_id() {
        // Security regression: a single-quoted heading `id` can legally contain
        // a double-quote. That value flows into the TOC slug verbatim; the
        // generated `href="#..."` must escape it so it cannot break out of the
        // double-quoted attribute and inject markup into the static export.
        let mut artifact = Artifact::new("Doc".to_string(), ArtifactType::Document, None);
        artifact.update_content(
            "<div data-type=\"table-of-contents\"></div>\
<h1 id='a\"onclick=alert(1)//'>Intro</h1><p>body</p>"
                .to_string(),
        );

        let html = export_html(&artifact, &[]);
        // The raw `"` must NOT appear inside the href — it would terminate the
        // attribute and turn the rest into stray markup.
        assert!(!html.contains("href=\"#a\"onclick"));
        // It is emitted as an HTML entity instead, keeping the anchor intact.
        assert!(html.contains("href=\"#a&quot;onclick=alert(1)//\""));
        // No bare `onclick` attribute leaks into the generated <a> tag.
        assert!(!html.contains("<a href=\"#a\" onclick"));
    }

    #[test]
    fn export_document_html_computed_slug_yields_to_later_explicit_id() {
        // ANALYSIS-0002: a computed slug for an *earlier* heading must not
        // collide with an *explicit* id on a *later* heading. Here the first
        // heading slugifies to "intro" and the second carries id="intro"; the
        // computed one must be disambiguated so the export has no duplicate id.
        let mut artifact = Artifact::new("Doc".to_string(), ArtifactType::Document, None);
        artifact.update_content(
            "<h1>Intro</h1><p>a</p><h2 id=\"intro\">Preface</h2><p>b</p>".to_string(),
        );

        let html = export_html(&artifact, &[]);
        // The explicit id is preserved verbatim…
        assert!(html.contains("<h2 id=\"intro\">Preface</h2>"));
        // …and the earlier computed heading is pushed to a suffixed slug.
        assert!(html.contains("<h1 id=\"intro-2\">Intro</h1>"));
        // Exactly one element carries the bare id="intro" (no duplicates).
        assert_eq!(html.matches("id=\"intro\"").count(), 1);
    }

    #[test]
    fn export_document_html_expands_toc_marker_with_extra_attributes() {
        // ANALYSIS-0001: the marker must still expand if TipTap ever serialises
        // it with extra attributes or a different attribute order, instead of
        // silently leaving an empty <div> in the export.
        let mut artifact = Artifact::new("Guide".to_string(), ArtifactType::Document, None);
        artifact.update_content(
            "<div class=\"foo\" data-type=\"table-of-contents\"></div>\
<h1>Start</h1><p>x</p>"
                .to_string(),
        );

        let html = export_html(&artifact, &[]);
        // The marker (regardless of its extra attribute) is replaced by a nav…
        assert!(html.contains("<nav class=\"doc-toc\" aria-label=\"Table of contents\">"));
        assert!(html.contains("<a href=\"#start\">Start</a>"));
        // …and no empty table-of-contents div survives.
        assert!(!html.contains("data-type=\"table-of-contents\"></div>"));
    }

    #[test]
    fn export_document_html_leaves_nonempty_toc_lookalike_div_intact() {
        // Only the *empty* marker element is expanded; an authored div that
        // happens to carry the attribute but has real content is preserved.
        let mut artifact = Artifact::new("Doc".to_string(), ArtifactType::Document, None);
        artifact.update_content(
            "<div data-type=\"table-of-contents\">hand-written</div><h1>Start</h1>".to_string(),
        );

        let html = export_html(&artifact, &[]);
        assert!(html.contains("<div data-type=\"table-of-contents\">hand-written</div>"));
    }

    #[test]
    fn export_document_html_strips_unsafe_elements() {
        // Defense-in-depth: even if a <script>/<iframe> ever reached an HTML
        // document artifact, it must not survive into the static export.
        let mut artifact = Artifact::new("Doc".to_string(), ArtifactType::Document, None);
        artifact.update_content(
            "<p>Safe</p><script>alert('xss')</script>\
<p>More</p><IFRAME src=\"evil\"></IFRAME><embed src=\"x\">\
<p>End</p>"
                .to_string(),
        );

        let html = export_html(&artifact, &[]);
        // Legitimate paragraphs survive verbatim.
        assert!(html.contains("<p>Safe</p>"));
        assert!(html.contains("<p>More</p>"));
        assert!(html.contains("<p>End</p>"));
        // Executable / embedding constructs are gone (case-insensitive).
        assert!(!html.contains("alert('xss')"));
        assert!(!html.to_lowercase().contains("<script"));
        assert!(!html.to_lowercase().contains("<iframe"));
        assert!(!html.to_lowercase().contains("<embed"));
    }

    #[test]
    fn strip_unsafe_elements_keeps_lookalike_tags_and_unicode() {
        // `<embedded>` must not be mistaken for `<embed>`, and UTF-8 content is
        // preserved intact.
        let input = "<p>Café — 概要</p><embedded data=\"1\">keep</embedded>";
        assert_eq!(strip_unsafe_elements(input), input);
    }

    #[test]
    fn export_markdown_content_still_uses_line_converter() {
        // Regression guard: legacy markdown-shaped documents must NOT be treated
        // as HTML — they keep flowing through `content_to_html`.
        let mut artifact = Artifact::new("Legacy".to_string(), ArtifactType::Document, None);
        artifact.update_content("## Problem\n\nThe problem is X.".to_string());
        let html = export_html(&artifact, &[]);
        assert!(html.contains("<h2>Problem</h2>"));
        assert!(html.contains("<p>The problem is X.</p>"));
    }

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
    fn export_html_does_not_inject_mermaid_runtime_for_html_documents() {
        // An edited Document persists `editor.getHTML()`, so its content is an
        // HTML fragment. A real diagram is a `<div data-type="mermaid">` node
        // (no markdown fence), and a user can legitimately type the literal
        // text "```mermaid" inside a code block. Neither should drag in the
        // external mermaid CDN <script>: the node renderer doesn't use it and
        // the code-block text is just prose. Gating the scan on
        // `!looks_like_html` keeps local-first exports free of needless
        // network dependencies.
        let mut artifact = Artifact::new("Doc".to_string(), ArtifactType::Document, None);
        artifact.update_content(
            "<p>Here is an example fence:</p>\
<pre><code class=\"language-text\">```mermaid\nflowchart LR\nA--&gt;B\n```</code></pre>\
<div data-type=\"mermaid\" data-dsl=\"flowchart LR\nA--&gt;B\"></div>"
                .to_string(),
        );
        let html = export_html(&artifact, &[]);
        // No external CDN runtime is injected for HTML documents.
        assert!(!html.contains("mermaid.initialize"));
        assert!(!html.contains("cdn.jsdelivr.net"));
        // The document body itself is still inlined verbatim.
        assert!(html.contains("<div data-type=\"mermaid\""));
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

    // Regression test:
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
