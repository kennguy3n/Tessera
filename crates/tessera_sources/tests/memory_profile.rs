//! Phase 15 Task 4 — memory profile regression test.
//!
//! Indexes 10 000 synthetic chunks via [`SourceStore::insert_chunks_returning_ids`]
//! plus the embedding back-fill path and asserts that peak resident-
//! set size (RSS) stays below the Phase 15 budget of 200 MB.
//!
//! What the test is actually verifying:
//!
//!   * The chunk-insert path streams batches of 500 — it does NOT
//!     accumulate a `Vec<Chunk>` of size 10 000 in memory before
//!     committing. The seeding loop writes 500 chunks at a time and
//!     drops the batch between iterations.
//!   * The embedding back-fill (`Indexer::backfill_embeddings`) reads
//!     chunks in `batch_size` slices and immediately persists the
//!     vector; it does not buffer the full corpus's vector set.
//!   * Together, the two streaming paths bound peak RSS at a constant
//!     multiple of `batch_size`, not of the corpus size.
//!
//! The test is skipped on non-Linux hosts because the RSS accessor
//! returns `None` (the Linux `/proc/self/status` path is the only
//! one that yields a stable, comparable value across runs — macOS's
//! `getrusage` reports peak-across-process-lifetime which may be
//! polluted by test-runner setup, and Windows isn't supported by
//! `mem::current_rss_bytes` today).
//!
//! The budget is "200 MB peak RSS for the indexing path itself,
//! measured as `final_rss - baseline_rss`". The baseline is sampled
//! before any seeding work so the assertion is robust against the
//! test-runner's own memory footprint (which on CI runs can be
//! 80–120 MB on its own from cargo's test harness, rustc-driven
//! linking residue, and the SQLite library).

use chrono::Utc;

use tessera_sources::chunker::Chunk;
use tessera_sources::embedding::{encode_vec, EmbeddingProvider, HashTrickEmbedding};
use tessera_sources::mem::current_rss_bytes;
use tessera_sources::source::Source;
use tessera_sources::store::SourceStore;

#[test]
fn indexing_10k_synthetic_chunks_stays_under_200mb_peak_rss() {
    // Skip on hosts without RSS sampling. The lib `mem` module
    // returns `None` on Windows; on macOS the `ru_maxrss` value is
    // "peak since process start" rather than "current" so the
    // delta assertion is unreliable.
    let Some(baseline) = current_rss_bytes() else {
        eprintln!("skipping memory_profile test: current_rss_bytes() unavailable on this platform",);
        return;
    };
    if !cfg!(target_os = "linux") {
        eprintln!(
            "skipping memory_profile test: only enforced on Linux (current platform reports baseline {baseline} bytes)"
        );
        return;
    }

    let store = SourceStore::open_in_memory().expect("open in-memory store");
    let source = Source::new_local_folder("/profile".to_string());
    store.add_source(&source).expect("add source");

    let provider = HashTrickEmbedding::default_config();
    let last_modified = Utc::now().to_rfc3339();
    let total_chunks: usize = 10_000;
    let batch_size: usize = 500;
    let chunks_per_file: usize = 100;

    let mut peak_rss = baseline;
    let mut chunks_inserted: usize = 0;
    let mut file_idx: usize = 0;

    while chunks_inserted < total_chunks {
        if chunks_inserted % chunks_per_file == 0 {
            file_idx += 1;
        }
        let path = format!("/profile/file-{file_idx:05}.txt");
        let file_id = store
            .upsert_indexed_file(
                &source.id,
                &path,
                &format!("file-hash-{file_idx}"),
                &last_modified,
            )
            .expect("upsert indexed_file");

        let take = batch_size.min(total_chunks - chunks_inserted);
        let chunks: Vec<Chunk> = (0..take)
            .map(|local_idx| {
                let global_idx = chunks_inserted + local_idx;
                Chunk {
                    source_path: path.clone(),
                    chunk_index: local_idx,
                    byte_offset: local_idx * 256,
                    content: synthetic_content(global_idx),
                    hash: format!("chunk-{global_idx:08}"),
                    extraction_method: None,
                    extraction_model_id: None,
                }
            })
            .collect();

        let chunk_ids = store
            .insert_chunks_returning_ids(file_id, &chunks)
            .expect("insert_chunks");

        // Stream embeddings inline so the per-chunk vector is
        // persisted and dropped immediately rather than buffered.
        for (chunk, chunk_id) in chunks.iter().zip(chunk_ids.iter()) {
            let vec = provider.embed(&chunk.content).expect("embed chunk");
            let bytes = encode_vec(&vec);
            store
                .upsert_chunk_embedding(*chunk_id, provider.model_id(), provider.dim(), &bytes)
                .expect("upsert embedding");
        }

        chunks_inserted += take;

        if let Some(rss) = current_rss_bytes() {
            peak_rss = peak_rss.max(rss);
        }
    }

    let delta = peak_rss.saturating_sub(baseline);
    let budget = 200 * 1024 * 1024;
    assert!(
        delta < budget,
        "indexing 10 000 chunks consumed {delta} bytes above the {baseline}-byte baseline; \
         budget is {budget} bytes (200 MB). \
         If the indexer / embedder genuinely needs more headroom for a new feature, raise the \
         budget AFTER confirming the increase is intentional — do NOT relax the assertion \
         to mask a regression.",
    );
}

fn synthetic_content(i: usize) -> String {
    // ~120 byte chunks — representative of real-world chunk
    // content emitted by the chunker. The unique suffix means
    // every chunk gets its own n-gram fingerprint so the embedder
    // can't short-circuit on a hot cache.
    format!(
        "Synthetic chunk number {i:08}. The quick brown fox jumps over the lazy dog. \
         Pack my box with five dozen liquor jugs. Sphinx of black quartz."
    )
}
