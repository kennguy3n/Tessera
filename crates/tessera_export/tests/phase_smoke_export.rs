//! Phase-verification smoke test for the export engine.
//!
//! Part of the Phase 7/8 tracking-integrity guarantee: every export
//! format PROGRESS.md claims must be backed by a real, importable
//! top-level function (not a TODO marker or `unimplemented!()`).
//!
//! Companion suites:
//!   * Renderer side — `apps/desktop/renderer/src/__tests__/smoke/
//!     phaseVerification.test.ts`
//!   * Connectors — `crates/tessera_connectors/tests/
//!     phase_smoke_connectors.rs`
//!   * Templates — `crates/tessera_templates/tests/
//!     phase_smoke_templates.rs`
//!
//! `cargo test --all` picks this up automatically; the root-level
//! `npm run test:smoke` script invokes
//! `cargo test -p tessera_export --test phase_smoke_export` for
//! focused fast feedback.
//!
//! Each test in this file verifies one of the eight shipping export
//! formats. The body never panics — it builds a minimal artifact,
//! invokes the export function, and asserts a small property that
//! requires the real code path to have executed (e.g. for the CSV
//! exporter, that at least one comma appears in the rendered output).
//! A TODO stub returning `Default::default()` would fail these.

use tessera_artifacts::Artifact;
use tessera_citations::citation::Citation;
use tessera_core::{ArtifactType, SourceId, SourceType};

/// Build a small but realistic document artifact for the exporters
/// that take an `Artifact + &[Citation]`. The body uses a heading
/// and a paragraph plus a fenced mermaid block so the mermaid /
/// markdown / html exporters all exercise non-trivial code paths.
/// A stub exporter that ignored its input would fail the assertions
/// below.
fn sample_document() -> Artifact {
    let mut artifact = Artifact::new("Phase smoke document".to_string(), ArtifactType::Document, None);
    artifact.update_content(
        "# Phase smoke heading\n\
         \n\
         Phase smoke paragraph body — must appear in output.\n\
         \n\
         ```mermaid\n\
         flowchart LR\n\
         A-->B\n\
         ```\n"
            .to_string(),
    );
    artifact
}

/// Build a sheet-shaped artifact. CSV export emits the artifact's
/// metadata as a header row plus its content as data rows; the body
/// here uses a short markdown table so the CSV exporter's escaping
/// path runs.
fn sample_sheet() -> Artifact {
    let mut artifact = Artifact::new("Phase smoke sheet".to_string(), ArtifactType::Sheet, None);
    artifact.update_content(
        "| Owner | Status | Risk |\n\
         |-------|--------|------|\n\
         | Alpha | Open   | High |\n\
         | Beta  | Closed | Low  |\n"
            .to_string(),
    );
    artifact
}

/// Build a single citation. Used to exercise the "citations are
/// rendered" branch of the markdown / html / csv exporters.
fn sample_citation() -> Citation {
    Citation::new(
        SourceId::new(),
        SourceType::LocalFile,
        "Phase smoke source".to_string(),
        "https://example.invalid/phase-smoke".to_string(),
        "chunk-hash-placeholder".to_string(),
        "file-hash-placeholder".to_string(),
        "Phase smoke citation use".to_string(),
        0.92,
    )
}

#[test]
fn markdown_export_renders_title_and_body() {
    let artifact = sample_document();
    let out = tessera_export::markdown::export_markdown(&artifact, &[sample_citation()]);
    assert!(
        out.contains("Phase smoke document"),
        "markdown exporter must render the artifact title, got:\n{out}"
    );
    assert!(
        out.contains("Phase smoke paragraph body"),
        "markdown exporter must render body text, got:\n{out}"
    );
    assert!(
        out.contains("Phase smoke source"),
        "markdown exporter must render citation source titles, got:\n{out}"
    );
}

#[test]
fn html_export_renders_tags_and_body() {
    let artifact = sample_document();
    let out = tessera_export::html::export_html(&artifact, &[sample_citation()]);
    assert!(out.contains('<'), "html exporter must emit HTML tags");
    assert!(
        out.contains("Phase smoke paragraph body"),
        "html exporter must render body text, got:\n{out}"
    );
    assert!(
        out.contains("Phase smoke source"),
        "html exporter must render citation source titles, got:\n{out}"
    );
}

#[test]
fn csv_export_emits_a_comma_separated_table() {
    let artifact = sample_sheet();
    let out = tessera_export::csv::export_csv(&artifact, &[sample_citation()]);
    assert!(
        out.contains(','),
        "csv exporter must emit a comma-separated table, got:\n{out}"
    );
    // The metadata header row is documented at the top of csv.rs.
    assert!(
        out.contains("title,type,version,created_at,updated_at"),
        "csv exporter must emit the documented metadata header row, got:\n{out}"
    );
    assert!(
        out.contains("Phase smoke sheet"),
        "csv exporter must render the artifact title, got:\n{out}"
    );
    assert!(
        out.contains("Phase smoke source"),
        "csv exporter must render the citation source title, got:\n{out}"
    );
}

#[cfg(feature = "pdf")]
#[test]
fn pdf_export_emits_a_non_empty_payload() {
    let artifact = sample_document();
    let out = tessera_export::pdf::export_pdf(&artifact, &[]);
    // The bundled PDF backend produces a real PDF byte sequence when
    // the typst feature is enabled, and a printable plain-text
    // fallback otherwise. Either way the output must be non-empty
    // and recognisably contain the artifact title.
    assert!(
        !out.is_empty(),
        "pdf exporter must produce a non-empty payload"
    );
    let preview = String::from_utf8_lossy(&out).chars().take(2048).collect::<String>();
    assert!(
        preview.contains("%PDF") || preview.contains("Phase smoke"),
        "pdf exporter must emit either a PDF magic header or fallback text containing the document title; first 2048 bytes were: {preview:?}"
    );
}

#[cfg(feature = "docx")]
#[test]
fn docx_export_emits_a_docx_zip_envelope() {
    let artifact = sample_document();
    let out = tessera_export::docx::export_docx(&artifact, &[]);
    // .docx is a ZIP envelope, which always starts with the PKZip
    // magic bytes "PK\x03\x04". A stub returning an empty Vec or a
    // text payload would fail this check.
    assert!(
        out.len() >= 4 && &out[0..4] == b"PK\x03\x04",
        "docx exporter must emit a ZIP envelope (PK\\x03\\x04), got first 4 bytes: {:?}",
        out.iter().take(4).collect::<Vec<_>>()
    );
}

#[cfg(feature = "xlsx")]
#[test]
fn xlsx_export_emits_an_xlsx_zip_envelope() {
    let artifact = sample_sheet();
    let out = tessera_export::xlsx::export_xlsx(&artifact);
    // Same PKZip envelope check as docx — .xlsx is also a ZIP.
    assert!(
        out.len() >= 4 && &out[0..4] == b"PK\x03\x04",
        "xlsx exporter must emit a ZIP envelope (PK\\x03\\x04), got first 4 bytes: {:?}",
        out.iter().take(4).collect::<Vec<_>>()
    );
}

#[test]
fn mermaid_module_extracts_and_replaces_blocks() {
    // The mermaid exporter is not a single `export_*` function; it
    // exposes block extraction + replacement utilities used by the
    // higher-level markdown/html exporters. Each utility is part of
    // the documented surface, so we exercise the round-trip.
    let body = "intro\n\n```mermaid\nflowchart LR\nA-->B\n```\n\nouter";
    let blocks = tessera_export::mermaid::extract_blocks(body);
    assert_eq!(
        blocks.len(),
        1,
        "mermaid::extract_blocks must find the fenced mermaid block, got: {blocks:?}"
    );
    let replaced = tessera_export::mermaid::replace_blocks(body, |b| {
        format!(
            "[diagram:{}]",
            tessera_export::mermaid::detect_diagram_type(&b.dsl)
        )
    });
    assert!(
        replaced.contains("[diagram:"),
        "mermaid::replace_blocks must apply the replacement callback, got:\n{replaced}"
    );
    assert!(
        !replaced.contains("```mermaid"),
        "mermaid::replace_blocks must remove the original fenced block, got:\n{replaced}"
    );
}

#[test]
fn evidence_pack_builds_a_zip_envelope_with_provided_artifact() {
    use std::io::Read;

    let artifact = sample_document();
    let citations = vec![sample_citation()];
    let tmpdir = tempfile::tempdir().expect("create tempdir");
    let output_path = tmpdir.path().join("pack.zip");
    let path_str = output_path
        .to_str()
        .expect("tempdir paths are utf-8 on supported platforms")
        .to_string();

    let res = tessera_export::evidence_pack::build_evidence_pack(
        &artifact,
        &citations,
        &path_str,
    );
    assert!(
        res.is_ok(),
        "evidence_pack::build_evidence_pack returned an error: {res:?}"
    );
    // The function writes a ZIP to disk — verify the envelope magic
    // and that the file is non-empty.
    let mut f = std::fs::File::open(&output_path).expect("open evidence pack");
    let mut head = [0u8; 4];
    let read = f.read(&mut head).expect("read pack magic");
    assert_eq!(read, 4, "evidence pack must be at least 4 bytes long");
    assert_eq!(
        &head,
        b"PK\x03\x04",
        "evidence_pack::build_evidence_pack must emit a ZIP envelope (PK\\x03\\x04), got: {head:?}"
    );
}
