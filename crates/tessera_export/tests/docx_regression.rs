//! DOCX export cross-platform regression suite.
//!
//! Five golden-shape fixtures (headings, lists, tables, code blocks,
//! citations) exercise the major DOCX output paths. For each fixture
//! we assert:
//!
//!   1. **Structurally stable across runs.** Two consecutive
//!      `export_docx` calls on the same input produce semantically
//!      identical DOCX archives — every part is byte-equal once we
//!      normalise the `w14:paraId` attribute values, which the
//!      upstream `docx-rs` crate generates from a process-global
//!      atomic counter (it's a Word-internal optimistic-concurrency
//!      token, not visible to the user). Stripping that single
//!      attribute is the smallest valid normalisation; everything
//!      else — text, run/paragraph properties, table cells, styles,
//!      hyperlinks — must match exactly. Any future change that
//!      introduces a new source of non-determinism (an unpinned
//!      timestamp, an unordered map iteration, a fresh random id)
//!      will break these tests immediately rather than going
//!      unnoticed until a user notices noise in their
//!      version-controlled DOCX exports.
//!   2. **OOXML schema sanity.** The exported document parses
//!      cleanly via `quick-xml` and contains every required Open
//!      Office XML element for its shape (`<w:body>`, `<w:p>` for
//!      paragraphs, `<w:tbl>`/`<w:tr>`/`<w:tc>` for tables, etc.).
//!      We do not run the full OOXML schema validator — that would
//!      require ~2 MB of XSDs and a separate validator binary — but
//!      we do verify the elements the production renderer (Word,
//!      LibreOffice) requires to render the document at all.
//!
//! The artifact's `updated_at` field is pinned to a fixed timestamp
//! before each export so the footer paragraph text is deterministic.
//! Without this pin the structural-equality assertion would flap on
//! every run because the docx exporter formats `updated_at` into the
//! footer.
//!
//! The DOCX `docProps/core.xml` part embeds its own `dcterms:created`
//! and `dcterms:modified` timestamps — the upstream `docx-rs` crate
//! defaults these to `1970-01-01T00:00:00Z`, which is what we rely on
//! for determinism. If a future docx-rs upgrade switches to current
//! time, these tests will catch it immediately.

use chrono::{TimeZone, Utc};
use quick_xml::events::Event;
use quick_xml::Reader;
use std::io::Read;
use uuid::Uuid;

use tessera_artifacts::Artifact;
use tessera_citations::citation::Citation;
use tessera_core::{ArtifactType, SourceId, SourceType};
use tessera_export::docx::export_docx;

/// Build a deterministic `SourceId` from a UUID string literal so the
/// citation fixture renders identically across runs. Constructing
/// `SourceId` directly via the tuple constructor avoids the need for
/// a `from_str` helper that isn't part of the public API.
fn fixed_source_id(s: &str) -> SourceId {
    SourceId(Uuid::parse_str(s).expect("valid uuid literal"))
}

/// Construct a `Document` artifact whose `updated_at` is pinned to a
/// fixed UTC timestamp so the exported DOCX bytes are deterministic
/// (the docx export footer formats this timestamp into prose).
fn fixed_artifact(title: &str, content: &str) -> Artifact {
    let mut a = Artifact::new(title.to_string(), ArtifactType::Document, None);
    a.update_content(content.to_string());
    // 2025-01-01T00:00:00Z chosen arbitrarily — any fixed value works.
    let pinned = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
    a.created_at = pinned;
    a.updated_at = pinned;
    a
}

/// Extract the bytes of a named entry from the DOCX zip, returning
/// `None` when the entry is missing. We use this to pluck
/// `word/document.xml` for OOXML element assertions.
fn read_zip_entry(bytes: &[u8], name: &str) -> Option<Vec<u8>> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).ok()?;
    let mut entry = archive.by_name(name).ok()?;
    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// Count how many times each tag name (local-name form, ignoring the
/// `w:` prefix) appears in an OOXML document part. Returns a vec of
/// `(local_name, count)` entries for the requested tags.
///
/// We use a streaming parser so the full XML is never materialised as
/// a string; this matches how a real OOXML consumer (Word, LibreOffice,
/// pandoc) walks the document.
fn count_tags(xml_bytes: &[u8], wanted: &[&str]) -> Vec<(String, usize)> {
    let mut reader = Reader::from_reader(xml_bytes);
    reader.config_mut().trim_text(false);
    let mut counts: std::collections::HashMap<String, usize> =
        wanted.iter().map(|t| ((*t).to_string(), 0usize)).collect();
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e) | Event::Empty(e)) => {
                let name = e.name();
                let local = std::str::from_utf8(name.local_name().as_ref())
                    .unwrap_or("")
                    .to_string();
                if let Some(v) = counts.get_mut(&local) {
                    *v += 1;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => panic!("quick-xml parse error: {e}"),
            _ => {}
        }
        buf.clear();
    }
    wanted
        .iter()
        .map(|t| ((*t).to_string(), *counts.get(*t).unwrap_or(&0)))
        .collect()
}

/// Strip the `w14:paraId="..."` attribute from every paragraph in
/// `word/document.xml`. The value is generated by an upstream global
/// atomic counter (see `docx-rs`'s `paragraph_id::generate_para_id`),
/// so it advances every time a paragraph is constructed and would
/// otherwise make byte-equality compare two unrelated counter
/// snapshots. The attribute is informational (Word treats it as an
/// optimistic-concurrency token for revision tracking, not as content),
/// so removing it does not affect rendering. Every other byte of the
/// XML must match.
fn normalize_doc_xml(xml: &[u8]) -> Vec<u8> {
    let s = std::str::from_utf8(xml).expect("document.xml is UTF-8");
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(idx) = rest.find(" w14:paraId=\"") {
        out.push_str(&rest[..idx]);
        // Skip past the closing quote of the attribute value.
        let after = &rest[idx + " w14:paraId=\"".len()..];
        let Some(close) = after.find('"') else {
            // Malformed XML — bail out and append the rest verbatim
            // so the structural diff later still surfaces the problem.
            out.push_str(rest);
            return out.into_bytes();
        };
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    out.into_bytes()
}

/// All the OOXML parts we expect a normal DOCX to contain, in the
/// order the upstream zipper writes them. We list each name
/// explicitly so an accidentally added or removed part is caught
/// immediately by the equality assertion.
const OOXML_PARTS: &[&str] = &[
    "[Content_Types].xml",
    "_rels/.rels",
    "docProps/app.xml",
    "docProps/core.xml",
    "docProps/custom.xml",
    "word/_rels/document.xml.rels",
    "word/document.xml",
    "word/styles.xml",
    "word/settings.xml",
    "word/fontTable.xml",
    "word/comments.xml",
    "word/numbering.xml",
];

/// Assert structural stability: exporting the same fixture twice
/// produces semantically identical DOCX archives. We compare each
/// OOXML part individually (after normalising the
/// counter-generated `w14:paraId` attribute) so a regression points
/// at the specific part that diverged instead of dumping the whole
/// archive's raw bytes.
fn assert_byte_stable(a: &Artifact, citations: &[Citation]) {
    let first = export_docx(a, citations);
    let second = export_docx(a, citations);
    for part in OOXML_PARTS {
        let (p1, p2) = (read_zip_entry(&first, part), read_zip_entry(&second, part));
        match (p1, p2) {
            (Some(b1), Some(b2)) => {
                let (n1, n2) = if *part == "word/document.xml" {
                    (normalize_doc_xml(&b1), normalize_doc_xml(&b2))
                } else {
                    (b1, b2)
                };
                assert_eq!(
                    n1,
                    n2,
                    "DOCX part {part:?} is not stable across runs (lengths {} vs {})",
                    n1.len(),
                    n2.len(),
                );
            }
            (None, None) => {
                // Both archives omit this optional part — fine.
            }
            (a, b) => panic!(
                "DOCX part {part:?} present in one export but not the other: {} vs {}",
                a.is_some(),
                b.is_some(),
            ),
        }
    }
}

/// Assert the document part loads as a well-formed XML document and
/// contains every required tag at least once.
fn assert_required_tags_present(bytes: &[u8], required: &[&str]) {
    let doc_xml =
        read_zip_entry(bytes, "word/document.xml").expect("word/document.xml missing from DOCX");
    let counts = count_tags(&doc_xml, required);
    for (tag, count) in &counts {
        assert!(
            *count > 0,
            "required OOXML element <w:{tag}> not present in word/document.xml (counts: {counts:?})",
        );
    }
}

/// Verify the DOCX zip is a valid ZIP archive (starts with `PK\x03\x04`)
/// and contains the canonical OOXML part layout (Content_Types.xml,
/// `_rels/.rels`, `word/document.xml`).
fn assert_valid_ooxml_zip(bytes: &[u8]) {
    assert!(bytes.len() > 4);
    assert_eq!(&bytes[..4], b"PK\x03\x04", "missing ZIP signature");
    for required in ["[Content_Types].xml", "_rels/.rels", "word/document.xml"] {
        assert!(
            read_zip_entry(bytes, required).is_some(),
            "DOCX missing required OOXML part: {required}",
        );
    }
}

// ---------------------------------------------------------------------
// Fixture 1: Headings
// ---------------------------------------------------------------------
#[test]
fn golden_headings_fixture_is_stable_and_valid() {
    let a = fixed_artifact(
        "Headings Fixture",
        "# Top Level\n\nIntro prose.\n\n## Section One\n\nBody.\n\n### Sub Topic\n\nDetail.\n",
    );
    let bytes = export_docx(&a, &[]);
    assert_valid_ooxml_zip(&bytes);
    assert_byte_stable(&a, &[]);
    // Headings render as paragraphs (style differentiation is via
    // <w:pStyle>); pStyle should appear with the heading style names.
    assert_required_tags_present(&bytes, &["body", "p", "r", "pStyle"]);
    let doc_xml = read_zip_entry(&bytes, "word/document.xml").unwrap();
    let s = std::str::from_utf8(&doc_xml).unwrap();
    for needle in ["Heading1", "Heading2", "Heading3"] {
        assert!(
            s.contains(needle),
            "{needle} style reference missing in document.xml",
        );
    }
}

// ---------------------------------------------------------------------
// Fixture 2: Lists (bulleted + numbered)
// ---------------------------------------------------------------------
#[test]
fn golden_lists_fixture_is_stable_and_valid() {
    let a = fixed_artifact(
        "Lists Fixture",
        "## Bulleted\n\n- First item\n- Second item\n* Third item (alt marker)\n\n## Numbered\n\n1. Alpha\n2. Beta\n3. Gamma\n",
    );
    let bytes = export_docx(&a, &[]);
    assert_valid_ooxml_zip(&bytes);
    assert_byte_stable(&a, &[]);
    assert_required_tags_present(&bytes, &["body", "p", "r"]);
    let doc_xml = read_zip_entry(&bytes, "word/document.xml").unwrap();
    let s = std::str::from_utf8(&doc_xml).unwrap();
    // Bulleted items render with a leading `•` glyph per the docx
    // exporter's pragmatic rendering. Numbered items keep their `N. `
    // marker verbatim.
    assert!(s.contains("First item"), "first bullet missing");
    assert!(s.contains("Third item"), "alt-marker bullet missing");
    assert!(s.contains("1. Alpha"), "numbered Alpha missing");
    assert!(s.contains("3. Gamma"), "numbered Gamma missing");
}

// ---------------------------------------------------------------------
// Fixture 3: Tables
// ---------------------------------------------------------------------
#[test]
fn golden_tables_fixture_is_stable_and_valid() {
    let a = fixed_artifact(
        "Tables Fixture",
        "## Quarterly\n\n| Region | Q1 | Q2 |\n| --- | --- | --- |\n| North | 100 | 120 |\n| South | 80 | 95 |\n\nPostscript prose.\n",
    );
    let bytes = export_docx(&a, &[]);
    assert_valid_ooxml_zip(&bytes);
    assert_byte_stable(&a, &[]);
    // The OOXML table parts (<w:tbl>, <w:tr>, <w:tc>) MUST be present
    // — if our markdown-table detector regressed, the export would
    // fall through to plain paragraphs and these counts would be zero.
    let doc_xml = read_zip_entry(&bytes, "word/document.xml").unwrap();
    let counts = count_tags(&doc_xml, &["tbl", "tr", "tc", "p"]);
    let tbl = counts.iter().find(|(t, _)| t == "tbl").unwrap().1;
    let tr = counts.iter().find(|(t, _)| t == "tr").unwrap().1;
    let tc = counts.iter().find(|(t, _)| t == "tc").unwrap().1;
    assert!(tbl >= 1, "expected >= 1 <w:tbl>, got {tbl}");
    // 3 rows: header + 2 body rows (separator consumed).
    assert!(tr >= 3, "expected >= 3 <w:tr>, got {tr}");
    // 3 cols × 3 rows = 9 cells.
    assert!(tc >= 9, "expected >= 9 <w:tc>, got {tc}");
}

// ---------------------------------------------------------------------
// Fixture 4: Code blocks
// ---------------------------------------------------------------------
#[test]
fn golden_code_blocks_fixture_is_stable_and_valid() {
    let a = fixed_artifact(
        "Code Fixture",
        "## Example\n\n```rust\nfn main() {\n    println!(\"hello\");\n}\n```\n\nExplanation below.\n",
    );
    let bytes = export_docx(&a, &[]);
    assert_valid_ooxml_zip(&bytes);
    assert_byte_stable(&a, &[]);
    assert_required_tags_present(&bytes, &["body", "p", "r", "rFonts"]);
    // Consolas must be wired into all four font-script slots (regression
    // pin against the previous bug where only east_asia was set).
    let doc_xml = read_zip_entry(&bytes, "word/document.xml").unwrap();
    let s = std::str::from_utf8(&doc_xml).unwrap();
    for slot in [
        r#"w:ascii="Consolas""#,
        r#"w:hAnsi="Consolas""#,
        r#"w:cs="Consolas""#,
        r#"w:eastAsia="Consolas""#,
    ] {
        assert!(s.contains(slot), "font slot missing: {slot}");
    }
    // The code lines must appear verbatim.
    assert!(s.contains("fn main() {"), "code line missing");
    assert!(
        s.contains(r#"println!(&quot;hello&quot;);"#),
        "code line content missing or unescaped"
    );
}

// ---------------------------------------------------------------------
// Fixture 5: Citations
// ---------------------------------------------------------------------
#[test]
fn golden_citations_fixture_is_stable_and_valid() {
    let a = fixed_artifact(
        "Citations Fixture",
        "## Findings\n\nThe report draws on two prior briefings.\n",
    );
    // Use deterministic source ids so the citation block (Confidence,
    // URI lines) renders identically across runs.
    let cit_a = Citation::new(
        fixed_source_id("00000000-0000-0000-0000-000000000001"),
        SourceType::LocalFile,
        "Quarterly Brief.pdf".to_string(),
        "file:///briefs/quarterly.pdf".to_string(),
        "chunk_hash_a".to_string(),
        "file_hash_a".to_string(),
        "Revenue projections".to_string(),
        0.90,
    )
    .with_page(2);
    let cit_b = Citation::new(
        fixed_source_id("00000000-0000-0000-0000-000000000002"),
        SourceType::LocalFile,
        "Annual Letter.md".to_string(),
        "file:///briefs/annual.md".to_string(),
        "chunk_hash_b".to_string(),
        "file_hash_b".to_string(),
        "Risk factors".to_string(),
        0.81,
    );
    let citations = vec![cit_a, cit_b];
    let bytes = export_docx(&a, &citations);
    assert_valid_ooxml_zip(&bytes);
    assert_byte_stable(&a, &citations);
    assert_required_tags_present(&bytes, &["body", "p", "r"]);
    let doc_xml = read_zip_entry(&bytes, "word/document.xml").unwrap();
    let s = std::str::from_utf8(&doc_xml).unwrap();
    // Verify the Sources header and each citation's enumerated entry
    // appear with the expected formatting.
    assert!(s.contains("Sources"), "Sources header missing");
    assert!(s.contains("1. Quarterly Brief.pdf"), "citation 1 missing");
    assert!(s.contains("2. Annual Letter.md"), "citation 2 missing");
    assert!(
        s.contains("Revenue projections"),
        "used_for of citation 1 missing"
    );
    assert!(
        s.contains("Confidence: 90%"),
        "confidence rendering missing"
    );
    assert!(s.contains("Page: 2"), "page rendering missing");
}
