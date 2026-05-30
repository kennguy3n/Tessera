//! Phase 15 Task 2 — indexing throughput benchmarks.
//!
//! Three workload profiles cover the three regimes the indexer
//! actually hits in production:
//!
//!   1. **100 small Markdown files** — the "fresh source pointing at
//!      a doc folder" hot path. Tests per-file overhead; the
//!      extractor is doing trivial work per file so the win from
//!      parallelism comes from amortising the per-file dispatch
//!      cost.
//!   2. **10 medium synthetic "PDFs"** — emulated as 100 KB plain
//!      text bodies (real PDF binaries would inflate the bench
//!      fixture and add lopdf-specific noise; the goal here is to
//!      measure the parallel pass, not the PDF parser). Tests the
//!      large-file regime where each extraction is wallclock-heavy.
//!   3. **Mixed 50 files** — half small Markdown, half medium plain
//!      text. Tests the realistic regime; the parallel pass has to
//!      handle uneven per-file cost without one slow file stalling
//!      the whole batch.
//!
//! Each profile is benchmarked twice — serial loop over
//! [`extract_text`] and parallel via [`extract_files_parallel`] —
//! so the bench report shows the speedup directly.
//!
//! Run with `cargo bench -p tessera_sources --bench indexing_bench`.

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use std::path::{Path, PathBuf};

use tessera_sources::extractor::{extract_files_parallel, extract_text};

const SMALL_MD: &str = "# Heading\n\nSome paragraph body with a few words.\n\n- bullet one\n- bullet two\n";
const MEDIUM_BODY_LINE: &str =
    "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.\n";

fn write_corpus_md(dir: &Path, count: usize) -> Vec<PathBuf> {
    let mut paths = Vec::with_capacity(count);
    for i in 0..count {
        let p = dir.join(format!("doc-{i:04}.md"));
        std::fs::write(&p, SMALL_MD).unwrap();
        paths.push(p);
    }
    paths
}

fn write_corpus_medium(dir: &Path, count: usize, kb: usize) -> Vec<PathBuf> {
    // Each file is roughly `kb` KB of text built from the medium
    // line. We use `.txt` extension so the dispatch hits the
    // plain-text branch — same cost as a Markdown pass but without
    // pulling in the pulldown-cmark parser, which would skew the
    // bench toward parser cost rather than I/O / dispatch cost.
    let bytes_per_kb = 1024;
    let lines_per_file = (kb * bytes_per_kb) / MEDIUM_BODY_LINE.len();
    let body: String = MEDIUM_BODY_LINE.repeat(lines_per_file);
    let mut paths = Vec::with_capacity(count);
    for i in 0..count {
        let p = dir.join(format!("medium-{i:03}.txt"));
        std::fs::write(&p, &body).unwrap();
        paths.push(p);
    }
    paths
}

fn bench_workload(c: &mut Criterion, label: &str, paths: &[PathBuf]) {
    let mut group = c.benchmark_group(format!("extract:{label}"));
    group.throughput(Throughput::Elements(paths.len() as u64));

    group.bench_function(BenchmarkId::new("serial", paths.len()), |b| {
        b.iter(|| {
            for p in paths {
                let _ = black_box(extract_text(p));
            }
        });
    });

    group.bench_function(BenchmarkId::new("parallel", paths.len()), |b| {
        b.iter(|| {
            let _ = black_box(extract_files_parallel(paths));
        });
    });

    group.finish();
}

fn indexing_bench(c: &mut Criterion) {
    let small_dir = tempfile::tempdir().unwrap();
    let small_paths = write_corpus_md(small_dir.path(), 100);
    bench_workload(c, "100-small-md", &small_paths);

    let medium_dir = tempfile::tempdir().unwrap();
    let medium_paths = write_corpus_medium(medium_dir.path(), 10, 100);
    bench_workload(c, "10-medium-txt-100kb", &medium_paths);

    let mixed_dir = tempfile::tempdir().unwrap();
    let mut mixed_paths = write_corpus_md(mixed_dir.path(), 25);
    mixed_paths.extend(write_corpus_medium(mixed_dir.path(), 25, 20));
    bench_workload(c, "mixed-50", &mixed_paths);
}

criterion_group!(benches, indexing_bench);
criterion_main!(benches);
