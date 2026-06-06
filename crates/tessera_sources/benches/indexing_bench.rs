//! indexing throughput benchmarks.
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
//! A fourth, **large-corpus chunking** profile measures the
//! [`chunk_text`] splitter at 100K and 500K chunk scale — the regime
//! a bulk re-index or a freshly-pointed large source folder hits.
//! It is gated behind `TESSERA_BENCH_100K` / `TESSERA_BENCH_500K`
//! because synthesising a corpus that large costs hundreds of MB of
//! text and seconds per sample, which would bloat the default
//! `cargo bench` run:
//!   TESSERA_BENCH_100K=1 cargo bench -p tessera_sources --bench indexing_bench
//!   TESSERA_BENCH_500K=1 cargo bench -p tessera_sources --bench indexing_bench
//!
//! Each profile is benchmarked twice — serial loop over
//! [`extract_text`] and parallel via [`extract_files_parallel`] —
//! so the bench report shows the speedup directly.
//!
//! Run with `cargo bench -p tessera_sources --bench indexing_bench`.

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use std::path::{Path, PathBuf};

use tessera_sources::chunker::{chunk_text, ChunkerConfig};
use tessera_sources::extractor::{extract_files_parallel, extract_text};

const SMALL_MD: &str =
    "# Heading\n\nSome paragraph body with a few words.\n\n- bullet one\n- bullet two\n";
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

/// Build a single synthetic document sized to chunk into roughly
/// `target_chunks` chunks under `cfg`. Each chunk advances the
/// window by `chunk_size - chunk_overlap` bytes, so the body needs
/// `target_chunks * stride + chunk_size` bytes of text.
fn synth_text_for_chunks(target_chunks: usize, cfg: &ChunkerConfig) -> String {
    let stride = cfg.chunk_size.saturating_sub(cfg.chunk_overlap).max(1);
    let needed_bytes = target_chunks * stride + cfg.chunk_size;
    let reps = needed_bytes / MEDIUM_BODY_LINE.len() + 1;
    MEDIUM_BODY_LINE.repeat(reps)
}

/// Benchmark the chunker over a corpus that splits into ~`target_chunks`
/// chunks. Throughput is reported in chunks/s so the 100K vs 500K
/// numbers are directly comparable.
fn bench_chunking(c: &mut Criterion, label: &str, target_chunks: usize) {
    let cfg = ChunkerConfig::default();
    let text = synth_text_for_chunks(target_chunks, &cfg);
    let actual = chunk_text("bench://corpus", &text, &cfg).len();

    let mut group = c.benchmark_group(format!("chunk:{label}"));
    // Large inputs are slow per iteration; keep the sample count low
    // so a gated large-corpus run still finishes in reasonable time.
    group.sample_size(10);
    group.throughput(Throughput::Elements(actual as u64));
    group.bench_function(BenchmarkId::new("chunk_text", actual), |b| {
        b.iter(|| {
            let chunks = chunk_text("bench://corpus", black_box(&text), &cfg);
            let _ = black_box(chunks.len());
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

    // Large-corpus chunking — gated (see the module doc comment).
    if std::env::var("TESSERA_BENCH_100K").is_ok() {
        bench_chunking(c, "100k", 100_000);
    }
    if std::env::var("TESSERA_BENCH_500K").is_ok() {
        bench_chunking(c, "500k", 500_000);
    }
}

criterion_group!(benches, indexing_bench);
criterion_main!(benches);
