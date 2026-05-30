//! Phase 15 Task 2 — parallel-vs-serial extraction parity tests.
//!
//! These tests guard the invariant that
//! [`extract_files_parallel`] returns byte-identical output to a
//! serial loop of [`extract_text`] for the same input slice. They
//! cover three realistic corpora:
//!
//!   1. 100 small Markdown files (the small-file-heavy regime the
//!      indexer hits on a fresh source pointing at a documentation
//!      folder).
//!   2. A mixed batch of plain text, JSON, CSV, and HTML files (the
//!      heterogenous regime the indexer hits on a typical user
//!      "Documents" folder).
//!   3. A batch including a forced-error path (unsupported
//!      extension) so the parallel pass's per-input `Result` slot
//!      is exercised — a future refactor that swallows errors in
//!      the parallel path would fail this test immediately.
//!
//! Each test computes the serial result and the parallel result
//! against the same file set and asserts they match position-for-
//! position. The serial result is the ground truth; the parallel
//! pass is the optimisation we have to keep honest.

use std::path::{Path, PathBuf};

use tessera_sources::extractor::{extract_files_parallel, extract_text};

/// Tiny in-test `ResultExt` trait so the per-result comparison reads
/// naturally. Keeping it local to the test file avoids adding a
/// helper export to the production crate surface.
trait ResultExt<T, E> {
    fn ok_or_err_msg(self) -> std::result::Result<T, String>;
}

impl<T, E: std::fmt::Display> ResultExt<T, E> for std::result::Result<T, E> {
    fn ok_or_err_msg(self) -> std::result::Result<T, String> {
        self.map_err(|e| e.to_string())
    }
}

fn write_md(dir: &Path, name: &str, body: &str) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, body).unwrap();
    p
}

fn assert_parity(paths: &[PathBuf]) {
    let parallel = extract_files_parallel(paths);

    assert_eq!(
        parallel.len(),
        paths.len(),
        "parallel output length must equal input length",
    );

    for (i, (parallel_path, parallel_result)) in parallel.iter().enumerate() {
        let input_path = &paths[i];
        assert_eq!(
            parallel_path, input_path,
            "parallel output preserves input order (index {i})",
        );

        let serial_result = extract_text(input_path).ok_or_err_msg();
        let parallel_normalised = parallel_result.as_ref().map_err(|e| e.to_string()).cloned();

        assert_eq!(
            serial_result,
            parallel_normalised
                .as_ref()
                .map(|s| s.clone())
                .map_err(std::clone::Clone::clone),
            "parallel result differs from serial for {} (index {i})",
            input_path.display(),
        );
    }
}

#[test]
fn parallel_matches_serial_on_100_small_markdown_files() {
    let dir = tempfile::tempdir().unwrap();
    let mut paths = Vec::with_capacity(100);
    for i in 0..100 {
        let body = format!(
            "# Document {i}\n\nThis is markdown file number {i}.\n\n- Item A {i}\n- Item B {i}\n",
        );
        paths.push(write_md(dir.path(), &format!("doc-{i:03}.md"), &body));
    }
    assert_parity(&paths);
}

#[test]
fn parallel_matches_serial_on_mixed_corpus() {
    let dir = tempfile::tempdir().unwrap();

    // Plain text + Markdown + JSON + CSV + HTML cover every
    // dispatch arm in `extract_text` except PDF / image (which
    // would require fixture binaries; they have dedicated tests in
    // `pdf_integration.rs` / `image_integration.rs`).
    let mut paths = Vec::new();
    for i in 0..10 {
        paths.push(write_md(
            dir.path(),
            &format!("a-{i}.txt"),
            &format!("plain {i}\nbody\n"),
        ));
        paths.push(write_md(
            dir.path(),
            &format!("b-{i}.md"),
            &format!("# H{i}\n\ntext {i}\n"),
        ));
        paths.push(write_md(
            dir.path(),
            &format!("c-{i}.json"),
            &format!(r#"{{"id": {i}, "name": "doc-{i}"}}"#),
        ));
        paths.push(write_md(
            dir.path(),
            &format!("d-{i}.csv"),
            &format!("col1,col2\nv1-{i},v2-{i}\n"),
        ));
        paths.push(write_md(
            dir.path(),
            &format!("e-{i}.html"),
            &format!("<html><body><p>para {i}</p></body></html>"),
        ));
    }
    assert_parity(&paths);
}

#[test]
fn parallel_preserves_per_file_error_results() {
    let dir = tempfile::tempdir().unwrap();
    let ok_path = write_md(dir.path(), "ok.md", "# Title\n\nBody.\n");
    // `.bin` is rejected by `extract_text`'s extension dispatch.
    let bad_path = dir.path().join("not-supported.bin");
    std::fs::write(&bad_path, b"opaque payload").unwrap();
    let ok_path_2 = write_md(dir.path(), "ok-2.md", "second");

    let inputs = vec![ok_path.clone(), bad_path.clone(), ok_path_2.clone()];
    let results = extract_files_parallel(&inputs);

    assert_eq!(results.len(), 3);
    assert_eq!(results[0].0, ok_path);
    assert!(results[0].1.is_ok());
    assert_eq!(results[1].0, bad_path);
    assert!(
        results[1].1.is_err(),
        "unsupported extension must surface as Err in the parallel output",
    );
    assert_eq!(results[2].0, ok_path_2);
    assert!(results[2].1.is_ok());
}

#[test]
fn parallel_pass_is_safe_for_empty_input() {
    let empty: Vec<PathBuf> = Vec::new();
    let results = extract_files_parallel(&empty);
    assert!(results.is_empty());
}
