use std::path::Path;
use std::sync::{Arc, Mutex};
use tessera_core::error::Result;
use tessera_core::{SourceId, SourceStatus};
use walkdir::WalkDir;

use crate::chunker::{chunk_text, ChunkerConfig};
use crate::embedding::{encode_vec, EmbeddingProvider};
use crate::extractor::{extract_text, is_supported_extension};
use crate::ignore::IgnoreRules;
use crate::progress::{self, ProgressSnapshot};
use crate::store::SourceStore;

pub struct Indexer {
    chunker_config: ChunkerConfig,
    ignore_rules: IgnoreRules,
    /// Optional embedding provider. When set, every newly indexed
    /// chunk is immediately embedded and the vector stored in
    /// `chunk_embeddings` so hybrid retrieval can score it. When
    /// `None`, the table stays empty and retrieval falls back to
    /// BM25 + recency only.
    embedder: Option<Arc<dyn EmbeddingProvider>>,
}

impl Indexer {
    pub fn new(ignore_patterns: &[String]) -> Self {
        // Always layer user patterns on TOP of the curated defaults
        // (binary files, VCS metadata, OS junk, …) so users get
        // sensible behaviour out of the box and can extend — or
        // negate with a leading `!` — without losing the defaults.
        let ignore_rules = IgnoreRules::with_defaults(ignore_patterns);
        Self {
            chunker_config: ChunkerConfig::default(),
            ignore_rules,
            embedder: None,
        }
    }

    pub fn with_chunker_config(mut self, config: ChunkerConfig) -> Self {
        self.chunker_config = config;
        self
    }

    /// Attach an embedding provider to the indexer. Subsequent calls
    /// to `index_file` / `index_folder` will compute and persist a
    /// vector for every newly inserted chunk.
    pub fn with_embedder(mut self, embedder: Arc<dyn EmbeddingProvider>) -> Self {
        self.embedder = Some(embedder);
        self
    }

    pub fn index_folder(
        &self,
        source_id: &SourceId,
        folder_path: &Path,
        store: &SourceStore,
    ) -> Result<IndexResult> {
        self.index_folder_with_progress(source_id, folder_path, store, None)
    }

    /// Same as [`Indexer::index_folder`] but updates an optional
    /// [`ProgressSnapshot`] slot every time a file is scanned /
    /// indexed / skipped. The bridge layer wires this in so the UI
    /// can poll progress without blocking the indexing thread.
    pub fn index_folder_with_progress(
        &self,
        source_id: &SourceId,
        folder_path: &Path,
        store: &SourceStore,
        progress_slot: Option<&Arc<Mutex<ProgressSnapshot>>>,
    ) -> Result<IndexResult> {
        store.update_source_status(source_id, SourceStatus::Indexing, None)?;

        let mut result = IndexResult::default();

        for entry in WalkDir::new(folder_path)
            .follow_links(false)
            .into_iter()
            .filter_map(std::result::Result::ok)
        {
            let path = entry.path();

            if self.ignore_rules.is_ignored(path) {
                result.skipped += 1;
                if let Some(slot) = progress_slot {
                    progress::record_skipped(slot);
                }
                continue;
            }

            if !path.is_file() {
                continue;
            }

            if let Some(slot) = progress_slot {
                progress::record_scanned(slot, &path.display().to_string());
            }

            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or_default();

            if !is_supported_extension(ext) {
                result.skipped += 1;
                if let Some(slot) = progress_slot {
                    progress::record_skipped(slot);
                }
                continue;
            }

            match self.index_file(source_id, path, store) {
                Ok(indexed) => {
                    if indexed {
                        result.indexed += 1;
                        if let Some(slot) = progress_slot {
                            progress::record_indexed(slot);
                        }
                    } else {
                        result.unchanged += 1;
                        if let Some(slot) = progress_slot {
                            progress::record_unchanged(slot);
                        }
                    }
                }
                Err(e) => {
                    result.errors.push(format!("{}: {e}", path.display()));
                    if let Some(slot) = progress_slot {
                        progress::record_error(slot);
                    }
                }
            }
        }

        let file_count = store.file_count_for_source(source_id)?;
        store.update_source_status(source_id, SourceStatus::Indexed, Some(file_count))?;

        if let Some(slot) = progress_slot {
            progress::finish(slot, file_count);
        }

        result.total_files = file_count;
        Ok(result)
    }

    pub fn index_single_file(
        &self,
        source_id: &SourceId,
        file_path: &Path,
        store: &SourceStore,
    ) -> Result<bool> {
        self.index_file(source_id, file_path, store)
    }

    fn index_file(&self, source_id: &SourceId, path: &Path, store: &SourceStore) -> Result<bool> {
        let content_bytes = std::fs::read(path)?;
        let file_hash = blake3::hash(&content_bytes).to_hex().to_string();
        let path_str = path.to_string_lossy().to_string();

        if let Ok(Some(existing_hash)) = store.get_file_hash(&path_str) {
            if existing_hash == file_hash {
                return Ok(false);
            }
        }

        let metadata = std::fs::metadata(path)?;
        let last_modified = metadata.modified().map_or_else(
            |_| chrono::Utc::now().to_rfc3339(),
            |t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339(),
        );

        let file_id =
            store.upsert_indexed_file(source_id, &path_str, &file_hash, &last_modified)?;

        let text = extract_text(path)?;
        let chunks = chunk_text(&path_str, &text, &self.chunker_config);

        if !chunks.is_empty() {
            let ids = store.insert_chunks_returning_ids(file_id, &chunks)?;
            if let Some(embedder) = &self.embedder {
                let model_id = embedder.model_id().to_string();
                let dim = embedder.dim();
                for (id, chunk) in ids.iter().zip(chunks.iter()) {
                    // Embedding failure on a single chunk should not
                    // tank the whole indexing pass — log internally
                    // and continue. The retrieval pipeline already
                    // handles missing-embedding rows by falling back
                    // to BM25 + recency for that chunk.
                    match embedder.embed(&chunk.content) {
                        Ok(vec) => {
                            let bytes = encode_vec(&vec);
                            if let Err(e) =
                                store.upsert_chunk_embedding(*id, &model_id, dim, &bytes)
                            {
                                eprintln!(
                                    "[tessera_sources] failed to persist embedding for chunk {id}: {e}"
                                );
                            }
                        }
                        Err(e) => {
                            eprintln!("[tessera_sources] embedding failed for chunk {id}: {e}");
                        }
                    }
                }
            }
        }

        Ok(true)
    }

    /// Compute and persist embeddings for chunks that don't yet have
    /// one for the current model. Returns the number of chunks
    /// processed. Safe to call repeatedly — idempotent.
    ///
    /// Used to back-fill embeddings after the user enables hybrid
    /// retrieval on a corpus that was indexed before the embedder
    /// was attached, or after switching to a different embedding
    /// model (chunks with stale `model_id` rows are NOT touched;
    /// callers must explicitly clear them first).
    pub fn backfill_embeddings(&self, store: &SourceStore, batch_size: usize) -> Result<usize> {
        let Some(embedder) = &self.embedder else {
            return Ok(0);
        };
        let model_id = embedder.model_id().to_string();
        let dim = embedder.dim();
        let mut total = 0usize;
        // Guard against an infinite loop when `embedder.embed()`
        // returns `Err` for the same chunks on every iteration (e.g.
        // a network-backed provider whose backend is down, or a
        // chunk whose contents trip a deterministic parser bug in
        // the embedder). Without progress accounting, the
        // `chunks_missing_embedding` query would return the same
        // failing chunks each pass and `backfill_embeddings` would
        // never return. `HashTrickEmbedding` cannot hit this path
        // (pure math, infallible), but the trait is explicitly
        // designed for pluggable providers including network ones
        // (see the module-level comment in `embedding.rs`).
        loop {
            let batch = store.chunks_missing_embedding(&model_id, batch_size)?;
            if batch.is_empty() {
                break;
            }
            let mut batch_progress = 0usize;
            for (id, content) in &batch {
                match embedder.embed(content) {
                    Ok(vec) => {
                        let bytes = encode_vec(&vec);
                        store.upsert_chunk_embedding(*id, &model_id, dim, &bytes)?;
                        total += 1;
                        batch_progress += 1;
                    }
                    Err(e) => {
                        eprintln!("[tessera_sources] backfill embed failed for chunk {id}: {e}");
                    }
                }
            }
            if batch_progress == 0 {
                // Every chunk in this batch failed. Re-querying
                // would return the exact same chunk IDs (the
                // failure path doesn't insert an embedding row) and
                // we'd loop forever. Bail out and let the caller
                // surface the failure — the chunks stay flagged
                // as missing, so a subsequent backfill call (after
                // the embedder is restored) will pick them up.
                eprintln!(
                    "[tessera_sources] backfill stalled: {} chunks failed to embed in a single batch, aborting to avoid infinite loop",
                    batch.len()
                );
                break;
            }
            if batch.len() < batch_size {
                break;
            }
        }
        Ok(total)
    }
}

impl Default for Indexer {
    fn default() -> Self {
        Self::new(&[])
    }
}

#[derive(Debug, Default)]
pub struct IndexResult {
    pub indexed: u64,
    pub unchanged: u64,
    pub skipped: u64,
    pub total_files: u64,
    pub errors: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Source;

    fn setup_test_folder(dir: &Path) {
        std::fs::write(dir.join("readme.md"), "# Test Project\n\nThis is a test.").unwrap();
        std::fs::write(dir.join("data.csv"), "name,value\nalpha,1\nbeta,2").unwrap();
        std::fs::write(
            dir.join("notes.txt"),
            "Meeting notes:\n- Discussed Tessera\n- Reviewed progress",
        )
        .unwrap();
        std::fs::write(
            dir.join("config.json"),
            r#"{"app": "tessera", "version": "0.1.0"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/nested.txt"), "Nested file content.").unwrap();
    }

    #[test]
    fn index_folder_indexes_supported_files() {
        let dir = tempfile::tempdir().unwrap();
        setup_test_folder(dir.path());

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
        store.add_source(&source).unwrap();

        let indexer = Indexer::default();
        let result = indexer
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();

        assert_eq!(result.indexed, 5);
        assert!(result.errors.is_empty());
    }

    #[test]
    fn index_folder_skips_ignored_files() {
        let dir = tempfile::tempdir().unwrap();
        setup_test_folder(dir.path());
        std::fs::write(dir.path().join("binary.exe"), b"MZ fake exe").unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git/config"), "git config").unwrap();

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
        store.add_source(&source).unwrap();

        let indexer = Indexer::default();
        let result = indexer
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();

        assert_eq!(result.indexed, 5);
        assert!(result.skipped > 0);
    }

    #[test]
    fn reindex_unchanged_files_not_reprocessed() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("test.txt"), "Hello, world!").unwrap();

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
        store.add_source(&source).unwrap();

        let indexer = Indexer::default();
        let r1 = indexer
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();
        assert_eq!(r1.indexed, 1);

        let r2 = indexer
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();
        assert_eq!(r2.indexed, 0);
        assert_eq!(r2.unchanged, 1);
    }

    #[test]
    fn index_single_file_works() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("doc.txt");
        std::fs::write(&file_path, "Single file content for indexing.").unwrap();

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_file(file_path.to_string_lossy().to_string());
        store.add_source(&source).unwrap();

        let indexer = Indexer::default();
        let indexed = indexer
            .index_single_file(&source.id, &file_path, &store)
            .unwrap();
        assert!(indexed);

        let results = store.search_fts("Single file content", 10).unwrap();
        assert!(!results.is_empty());
    }

    /// Embedding provider that fails on every call. Used to verify
    /// `backfill_embeddings` terminates instead of looping forever
    /// when every chunk in a batch fails.
    struct AlwaysFailEmbedder {
        model_id: String,
        dim: usize,
        calls: Arc<Mutex<usize>>,
    }

    impl AlwaysFailEmbedder {
        fn new() -> Self {
            Self {
                model_id: "always-fail-v1-8d".to_string(),
                dim: 8,
                calls: Arc::new(Mutex::new(0)),
            }
        }
    }

    impl crate::embedding::EmbeddingProvider for AlwaysFailEmbedder {
        fn model_id(&self) -> &str {
            &self.model_id
        }
        fn dim(&self) -> usize {
            self.dim
        }
        fn embed(&self, _text: &str) -> tessera_core::error::Result<Vec<f32>> {
            *self.calls.lock().unwrap() += 1;
            Err(tessera_core::error::Error::Database(
                "synthetic embed failure (test fixture)".to_string(),
            ))
        }
    }

    #[test]
    fn backfill_terminates_when_every_chunk_in_batch_fails() {
        // Regression for the original BUG where `backfill_embeddings`
        // would loop forever if every chunk in a batch failed to
        // embed — the inner failure path never inserts an embedding
        // row, so `chunks_missing_embedding` returned the same chunks
        // on every iteration and the outer loop never terminated.
        //
        // Construct: index a folder with multiple chunks WITHOUT an
        // embedder attached, then run backfill with an embedder that
        // returns Err every time. The fix should cap the embed-call
        // count at exactly the batch size (one full failing pass)
        // and return Ok(0) rather than spinning.
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5 {
            std::fs::write(
                dir.path().join(format!("file_{i}.txt")),
                format!("content for file {i}"),
            )
            .unwrap();
        }

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
        store.add_source(&source).unwrap();

        // Index without an embedder so chunks land but `chunk_embeddings` stays empty.
        Indexer::default()
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();

        // Attach the always-failing embedder and try to backfill.
        let embedder = Arc::new(AlwaysFailEmbedder::new());
        let calls = Arc::clone(&embedder.calls);
        let indexer = Indexer::default().with_embedder(embedder);

        let total = indexer.backfill_embeddings(&store, 3).expect(
            "backfill should return Ok with the chunks-stalled diagnostic, not loop forever",
        );
        assert_eq!(total, 0, "no chunks should have been embedded");

        // The embedder should have been invoked exactly `batch_size`
        // times (one full pass before the stall detector fires) —
        // NOT thousands of times (which would indicate the loop was
        // still spinning before some other guard kicked in).
        let n_calls = *calls.lock().unwrap();
        assert!(
            n_calls <= 3,
            "backfill should call embed at most once per chunk in the first failing batch (batch_size=3); got {n_calls} calls — the stall detector likely failed"
        );
        assert!(
            n_calls > 0,
            "backfill should have attempted at least one embed before bailing; got {n_calls}"
        );
    }

    #[test]
    fn backfill_makes_progress_when_only_some_chunks_fail() {
        // Counterpart to the stall test: as long as SOME chunks
        // succeed in a batch, the loop must keep going and embed
        // every remaining chunk. The stall detector must not fire
        // on partial-failure batches.
        struct FailEvenOddEmbedder {
            model_id: String,
            dim: usize,
            calls: Arc<Mutex<usize>>,
        }
        impl crate::embedding::EmbeddingProvider for FailEvenOddEmbedder {
            fn model_id(&self) -> &str {
                &self.model_id
            }
            fn dim(&self) -> usize {
                self.dim
            }
            fn embed(&self, _text: &str) -> tessera_core::error::Result<Vec<f32>> {
                let mut c = self.calls.lock().unwrap();
                *c += 1;
                if (*c).is_multiple_of(2) {
                    Err(tessera_core::error::Error::Database(
                        "flaky failure".to_string(),
                    ))
                } else {
                    Ok(vec![0.1f32; 8])
                }
            }
        }

        let dir = tempfile::tempdir().unwrap();
        for i in 0..6 {
            std::fs::write(
                dir.path().join(format!("file_{i}.txt")),
                format!("content for file {i}"),
            )
            .unwrap();
        }

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
        store.add_source(&source).unwrap();
        Indexer::default()
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();

        let embedder = Arc::new(FailEvenOddEmbedder {
            model_id: "flaky-v1-8d".to_string(),
            dim: 8,
            calls: Arc::new(Mutex::new(0)),
        });
        let indexer = Indexer::default().with_embedder(embedder);
        let total = indexer.backfill_embeddings(&store, 3).unwrap();
        // 6 chunks, every other call fails. The successful calls
        // persist embeddings, so subsequent iterations see fewer
        // missing chunks. The loop should make at least *some*
        // progress, not stall at zero.
        assert!(
            total > 0,
            "backfill should embed at least one chunk on flaky failures; got total={total}"
        );
    }
}
