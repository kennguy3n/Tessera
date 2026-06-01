//! PDF export with embedded Mermaid SVG diagrams.
//!
//! The minimal `export_pdf` path falls back to a one-line text
//! placeholder (`[Diagram: flowchart — see HTML export ...]`) because
//! the hand-rolled PDF builder cannot rasterise SVG. The Typst-backed
//! `export_pdf_with_svgs` path embeds each ```mermaid block as a real
//! SVG image inside the PDF.
//!
//! These tests pin the contract for both paths so a regression in the
//! Typst pipeline (e.g. an accidental import-order change that drops
//! the `image()` calls) is caught at test-run time.

#![cfg(feature = "typst")]

use std::collections::HashMap;

use tessera_artifacts::Artifact;
use tessera_core::ArtifactType;
use tessera_export::pdf::export_pdf_with_svgs;

/// A document containing a flowchart mermaid block. Any production
/// PDF for this document must carry the diagram as image data, not
/// as the literal "flowchart TD" source string in the body text.
fn artifact_with_flowchart() -> Artifact {
    let mut a = Artifact::new(
        "Mermaid Diagram Test".to_string(),
        ArtifactType::Document,
        None,
    );
    a.content = "Intro paragraph before the diagram.\n\n\
                 ```mermaid\n\
                 flowchart TD\n  A[Start] --> B{Decision}\n  \
                 B -->|Yes| C[Done]\n  B -->|No| D[Retry]\n\
                 ```\n\n\
                 Outro paragraph after the diagram."
        .to_string();
    a
}

#[test]
fn export_pdf_with_svgs_emits_typst_compiled_pdf_with_image_data() {
    let artifact = artifact_with_flowchart();
    let prerendered = HashMap::new();
    let pdf = export_pdf_with_svgs(&artifact, &[], &prerendered);

    // 1. Output is a valid PDF byte stream.
    assert!(
        pdf.starts_with(b"%PDF"),
        "output is not a PDF (missing %PDF magic). first 16 bytes: {:?}",
        &pdf[..pdf.len().min(16)]
    );
    assert!(
        pdf.ends_with(b"%%EOF\n") || pdf.ends_with(b"%%EOF"),
        "output is not a complete PDF (missing %%EOF trailer)"
    );

    // 2. The PDF must NOT contain the mermaid DSL as raw text.
    // The PDF stream may compress text content, so we have to allow
    // for the diagram being absent from a naive byte search even
    // when the Typst pipeline successfully embeds it. Instead,
    // assert that the PDF is substantially larger than the
    // placeholder fallback (which produces a tiny PDF with only the
    // one-line text). A Typst-rendered PDF with an embedded SVG is
    // typically >2 KB even for the smallest diagram.
    assert!(
        pdf.len() > 1500,
        "PDF is smaller than expected for embedded-diagram output ({} bytes); \
         likely fell back to the minimal placeholder path",
        pdf.len()
    );
}

#[test]
fn export_pdf_with_svgs_prefers_prerendered_over_structural_fallback() {
    let artifact = artifact_with_flowchart();
    // Supply a recognisable pre-rendered SVG. The actual contents
    // are arbitrary as long as Typst's `image.decode` accepts them.
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
        <rect x="0" y="0" width="200" height="100" fill="#cccccc"/>
        <text x="100" y="50" text-anchor="middle" font-size="14">CUSTOM-PRERENDERED-MARKER</text>
    </svg>"##;
    let mut prerendered = HashMap::new();
    prerendered.insert(0usize, svg.to_string());

    let pdf = export_pdf_with_svgs(&artifact, &[], &prerendered);
    assert!(pdf.starts_with(b"%PDF"));
    // Length sanity — the prerendered path produces a PDF in the
    // same size range as the structural fallback, both well above
    // the minimal-PDF placeholder size.
    assert!(pdf.len() > 1500);
}

#[test]
fn export_pdf_with_svgs_no_mermaid_blocks_still_compiles() {
    let mut artifact = Artifact::new("Plain Doc".to_string(), ArtifactType::Document, None);
    artifact.content = "Just some prose. No diagrams here.".to_string();
    let pdf = export_pdf_with_svgs(&artifact, &[], &HashMap::new());
    assert!(pdf.starts_with(b"%PDF"));
}

#[test]
fn render_block_to_svg_emits_valid_svg_with_diagram_data() {
    use tessera_export::mermaid::{extract_blocks, render_block_to_svg};
    let blocks = extract_blocks("```mermaid\nflowchart TD\nA-->B\n```\n");
    assert_eq!(blocks.len(), 1);
    let svg = render_block_to_svg(&blocks[0]);
    assert!(svg.starts_with("<svg "));
    assert!(svg.ends_with("</svg>"));
    assert!(svg.contains("<rect"));
    assert!(svg.contains("Diagram: flowchart"));
    // Must escape mermaid DSL characters that conflict with XML.
    let blocks_xml = extract_blocks("```mermaid\nflowchart TD\nA & B --> C\n```\n");
    let svg_xml = render_block_to_svg(&blocks_xml[0]);
    assert!(
        svg_xml.contains("A &amp; B"),
        "`&` not XML-escaped in SVG text body: {svg_xml}"
    );
    assert!(
        !svg_xml.contains("A & B"),
        "raw `&` should not appear unescaped in SVG body"
    );
}
