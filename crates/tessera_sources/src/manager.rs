use std::path::Path;
use std::sync::{Arc, Mutex};
use tessera_core::error::{Error, Result};
use tessera_core::{SharedConnection, SourceId};

use crate::embedding::{EmbeddingProvider, HashTrickEmbedding};
use crate::hybrid::{HybridSearchConfig, HybridSearchConfigInput};
use crate::indexer::Indexer;
use crate::progress::{
    finish_embedding, mark_embedding_failed, EmbeddingProgressSnapshot, EmbeddingProgressTracker,
    ProgressSnapshot, ProgressTracker,
};
use crate::search::{SearchEngine, SearchResult};
use crate::source::Source;
use crate::store::{IndexedFile, SourceStore};

pub struct SourceManager {
    store: SourceStore,
    indexer: Indexer,
    progress: Arc<ProgressTracker>,
    embedding_progress: Arc<EmbeddingProgressTracker>,
    embedder: Option<Arc<dyn EmbeddingProvider>>,
    /// Live hybrid retrieval config. Behind a [`Mutex`] so the
    /// renderer's Settings page can update half-life / weights at
    /// runtime without rebuilding the manager. The `search` /
    /// `search_broad` hot path clones the snapshot under the lock
    /// and drops the guard before doing any I/O, so config updates
    /// never block in-flight searches and an in-flight search never
    /// holds the lock across a SQLite call.
    hybrid_config: Mutex<HybridSearchConfig>,
}

impl SourceManager {
    pub fn new(db_path: &str, ignore_patterns: &[String]) -> Result<Self> {
        let store = SourceStore::open(db_path)?;
        let (indexer, embedder, hybrid_config) = build_default_hybrid_pipeline(ignore_patterns);
        Ok(Self {
            store,
            indexer,
            progress: Arc::new(ProgressTracker::new()),
            embedding_progress: Arc::new(EmbeddingProgressTracker::new()),
            embedder,
            hybrid_config: Mutex::new(hybrid_config),
        })
    }

    pub fn new_in_memory(ignore_patterns: &[String]) -> Result<Self> {
        let store = SourceStore::open_in_memory()?;
        let (indexer, embedder, hybrid_config) = build_default_hybrid_pipeline(ignore_patterns);
        Ok(Self {
            store,
            indexer,
            progress: Arc::new(ProgressTracker::new()),
            embedding_progress: Arc::new(EmbeddingProgressTracker::new()),
            embedder,
            hybrid_config: Mutex::new(hybrid_config),
        })
    }

    /// Build a manager backed by a [`SharedConnection`] that is also
    /// used by other stores. Used by the napi bridge.
    pub fn with_shared_conn(conn: SharedConnection, ignore_patterns: &[String]) -> Result<Self> {
        let store = SourceStore::with_shared_conn(conn)?;
        let (indexer, embedder, hybrid_config) = build_default_hybrid_pipeline(ignore_patterns);
        Ok(Self {
            store,
            indexer,
            progress: Arc::new(ProgressTracker::new()),
            embedding_progress: Arc::new(EmbeddingProgressTracker::new()),
            embedder,
            hybrid_config: Mutex::new(hybrid_config),
        })
    }

    /// Returns a clone of the current hybrid retrieval config. Used
    /// by the renderer's Settings page to populate the initial form
    /// state (half-life slider, hybrid-on/off toggle, …).
    pub fn get_hybrid_config(&self) -> HybridSearchConfig {
        self.hybrid_config
            .lock()
            .expect("hybrid_config mutex poisoned")
            .clone()
    }

    /// Apply a partial-update patch to the hybrid retrieval config.
    /// Validation lives in [`HybridSearchConfig::apply_patch`]; this
    /// method holds the mutex for the whole patch-and-commit so a
    /// concurrent reader never sees the half-applied state. Returns
    /// the new effective config so the renderer can echo it back
    /// to the user.
    pub fn update_hybrid_config(
        &self,
        patch: &HybridSearchConfigInput,
    ) -> Result<HybridSearchConfig> {
        let mut guard = self
            .hybrid_config
            .lock()
            .expect("hybrid_config mutex poisoned");
        guard.apply_patch(patch)?;
        Ok(guard.clone())
    }

    /// Backfill embeddings for every chunk that doesn't yet have one
    /// for the current embedder. Idempotent. The bridge layer
    /// invokes this after attaching a new embedder so existing
    /// corpora benefit from hybrid retrieval without a full reindex.
    pub fn backfill_embeddings(&self, batch_size: usize) -> Result<usize> {
        self.indexer.backfill_embeddings(&self.store, batch_size)
    }

    /// Backfill embeddings with a tracked progress snapshot exposed
    /// via [`embedding_progress`]. The renderer polls
    /// `bridge_get_embedding_progress` during the call and shows a
    /// determinate `embedded / total_chunks` bar.
    ///
    /// Semantics relative to [`backfill_embeddings`]:
    ///   * Same idempotence guarantees (`chunks_missing_embedding`
    ///     is the canonical work-set query).
    ///   * Same termination guarantees (per-session failure exclude
    ///     list + stall-detector backstop).
    ///   * Additionally seeds `total_chunks` *before* the embed loop
    ///     starts via a single `COUNT(*)` index-only scan, so the
    ///     denominator is visible to the renderer on the very first
    ///     poll instead of being unknown until the first batch lands.
    ///   * Flips status to `Done` on normal completion (including the
    ///     empty-corpus / no-embedder cases), and `Failed` with the
    ///     error message on whole-pass failure (e.g. the DB connection
    ///     died). Per-chunk failures continue to be non-fatal and only
    ///     increment the `failed` counter so the corpus's other
    ///     chunks still get embedded.
    pub fn backfill_embeddings_tracked(&self, batch_size: usize) -> Result<usize> {
        let Some(embedder) = &self.embedder else {
            // No embedder attached → nothing to do, but flip the
            // status so a renderer that polled while idle sees a
            // clean Done state rather than a stuck Running.
            let slot = self.embedding_progress.start(0, "none");
            finish_embedding(slot);
            return Ok(0);
        };
        let model_id = embedder.model_id().to_string();
        let total_chunks = self.store.count_chunks_missing_embedding(&model_id)?;
        let slot = self.embedding_progress.start(total_chunks, &model_id);
        match self
            .indexer
            .backfill_embeddings_with_progress(&self.store, batch_size, slot)
        {
            Ok(total) => {
                finish_embedding(slot);
                Ok(total)
            }
            Err(e) => {
                mark_embedding_failed(slot, &e.to_string());
                Err(e)
            }
        }
    }

    /// Returns the latest indexing progress snapshot for a source.
    /// Idle by default if no index pass has been observed.
    pub fn indexing_progress(&self, source_id: &SourceId) -> ProgressSnapshot {
        self.progress.snapshot(source_id)
    }

    /// Returns the latest embedding-backfill progress snapshot. Idle
    /// by default if no backfill pass has been observed since the
    /// bridge process came up.
    pub fn embedding_progress(&self) -> EmbeddingProgressSnapshot {
        self.embedding_progress.snapshot()
    }

    pub fn add_local_folder(&self, path: &str) -> Result<Source> {
        let folder_path = Path::new(path);
        if !folder_path.is_dir() {
            return Err(Error::InvalidPath(folder_path.to_path_buf()));
        }

        let source = Source::new_local_folder(path.to_string());
        self.store.add_source(&source)?;
        self.indexer
            .index_folder(&source.id, folder_path, &self.store)?;

        self.store.get_source(&source.id)
    }

    pub fn add_local_file(&self, path: &str) -> Result<Source> {
        let file_path = Path::new(path);
        if !file_path.is_file() {
            return Err(Error::InvalidPath(file_path.to_path_buf()));
        }

        let source = Source::new_local_file(path.to_string());
        self.store.add_source(&source)?;
        self.indexer
            .index_single_file(&source.id, file_path, &self.store)?;

        let file_count = self.store.file_count_for_source(&source.id)?;
        self.store.update_source_status(
            &source.id,
            tessera_core::SourceStatus::Indexed,
            Some(file_count),
        )?;

        self.store.get_source(&source.id)
    }

    pub fn remove_source(&self, source_id: &SourceId) -> Result<()> {
        self.store.remove_source(source_id)
    }

    pub fn list_sources(&self) -> Result<Vec<Source>> {
        self.store.list_sources()
    }

    pub fn get_source(&self, source_id: &SourceId) -> Result<Source> {
        self.store.get_source(source_id)
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        // Clone the snapshot under the lock and drop the guard
        // before any I/O so concurrent `update_hybrid_config` calls
        // never block on a slow SQLite query, and an in-flight
        // search uses a coherent config even if the user toggles
        // hybrid-off mid-flight.
        let cfg = self
            .hybrid_config
            .lock()
            .expect("hybrid_config mutex poisoned")
            .clone();
        let engine = SearchEngine::hybrid(&self.store, self.embedder.as_deref(), cfg);
        engine.search(query, limit)
    }

    pub fn search_broad(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let cfg = self
            .hybrid_config
            .lock()
            .expect("hybrid_config mutex poisoned")
            .clone();
        let engine = SearchEngine::hybrid(&self.store, self.embedder.as_deref(), cfg);
        engine.search_broad(query, limit)
    }

    pub fn list_indexed_files(&self, source_id: &SourceId) -> Result<Vec<IndexedFile>> {
        self.store.list_indexed_files(source_id)
    }

    pub fn get_current_file_hash(&self, file_path: &str) -> Result<Option<String>> {
        self.store.get_current_file_hash(file_path)
    }

    pub fn get_detail(&self, source_id: &SourceId) -> Result<(Source, Vec<IndexedFile>)> {
        let source = self.store.get_source(source_id)?;
        let files = self.store.list_indexed_files(source_id)?;
        Ok((source, files))
    }

    pub fn get_chunks_for_source(&self, source_id: &SourceId) -> Result<Vec<String>> {
        self.store.get_chunk_contents_for_source(source_id)
    }

    pub fn reindex_source(&self, source_id: &SourceId) -> Result<()> {
        let source = self.store.get_source(source_id)?;
        let path = Path::new(&source.path);

        // Always allocate a fresh progress slot — the UI polls
        // `bridge_get_indexing_progress` and expects `Running`
        // status during the call.
        let slot = self.progress.start(source_id);

        let outcome = match source.source_type {
            tessera_core::SourceType::LocalFolder => self
                .indexer
                .index_folder_with_progress(source_id, path, &self.store, Some(&slot))
                .map(|_| ()),
            tessera_core::SourceType::LocalFile => self
                .indexer
                .index_single_file(source_id, path, &self.store)
                .and_then(|_| self.store.file_count_for_source(source_id))
                .and_then(|file_count| {
                    self.store.update_source_status(
                        source_id,
                        tessera_core::SourceStatus::Indexed,
                        Some(file_count),
                    )?;
                    crate::progress::finish(&slot, file_count);
                    Ok(())
                }),
            _ => Ok(()),
        };

        if let Err(ref e) = outcome {
            crate::progress::mark_failed(&slot, &e.to_string());
        }
        outcome
    }
}

/// Construct the default hybrid retrieval pipeline used by every
/// `SourceManager` constructor.
///
/// The default uses [`HashTrickEmbedding::default_config()`] as the
/// embedder. This is the offline, zero-dependency option: it doesn't
/// need a running model server, doesn't make network calls, and
/// produces a meaningful vector signal for short queries / typos /
/// substring matches over the BM25 baseline.
///
/// Production deployments that want transformer-quality embeddings
/// can build their own `SourceManager` with `SourceStore` + `Indexer`
/// directly and pass in a different `EmbeddingProvider` (e.g. one
/// that calls llama-server's `/embedding` endpoint, or an external
/// API). The trait surface is stable across providers — the only
/// migration cost is re-embedding existing chunks because each
/// provider's `model_id` is distinct and cross-model cosines are
/// filtered out at query time.
fn build_default_hybrid_pipeline(
    ignore_patterns: &[String],
) -> (
    Indexer,
    Option<Arc<dyn EmbeddingProvider>>,
    HybridSearchConfig,
) {
    let embedder: Arc<dyn EmbeddingProvider> = Arc::new(HashTrickEmbedding::default_config());
    let indexer = Indexer::new(ignore_patterns).with_embedder(Arc::clone(&embedder));
    let hybrid_config = HybridSearchConfig::default();
    (indexer, Some(embedder), hybrid_config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manager_add_folder_and_search() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("readme.txt"),
            "Tessera productivity workspace documentation",
        )
        .unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let source = manager
            .add_local_folder(dir.path().to_str().unwrap())
            .unwrap();

        assert_eq!(source.file_count, 1);

        let results = manager.search("productivity", 10).unwrap();
        assert!(!results.is_empty());
    }

    #[test]
    fn manager_add_file() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("doc.txt");
        std::fs::write(&file_path, "Single document for testing search").unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let source = manager.add_local_file(file_path.to_str().unwrap()).unwrap();

        assert_eq!(source.file_count, 1);
    }

    #[test]
    fn manager_remove_source() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("test.txt"), "content").unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let source = manager
            .add_local_folder(dir.path().to_str().unwrap())
            .unwrap();

        manager.remove_source(&source.id).unwrap();
        let sources = manager.list_sources().unwrap();
        assert!(sources.is_empty());
    }

    #[test]
    fn manager_list_sources() {
        let dir1 = tempfile::tempdir().unwrap();
        let dir2 = tempfile::tempdir().unwrap();
        std::fs::write(dir1.path().join("a.txt"), "a").unwrap();
        std::fs::write(dir2.path().join("b.txt"), "b").unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager
            .add_local_folder(dir1.path().to_str().unwrap())
            .unwrap();
        manager
            .add_local_folder(dir2.path().to_str().unwrap())
            .unwrap();

        let sources = manager.list_sources().unwrap();
        assert_eq!(sources.len(), 2);
    }

    #[test]
    fn manager_hybrid_populates_embeddings_on_index() {
        // After indexing a folder via the default constructor, every
        // chunk should have an embedding stored — hybrid retrieval
        // is on by default and the indexer is wired to populate
        // `chunk_embeddings` inline with chunk insertion.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("readme.txt"),
            "Tessera uses SQLite FTS5 with hybrid retrieval for full-text search.",
        )
        .unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager
            .add_local_folder(dir.path().to_str().unwrap())
            .unwrap();

        // The default embedder model id is hash-trick-v1; load every
        // embedding and verify the chunk got persisted.
        let rows = manager
            .store
            .load_embeddings_for_model("hash-trick-v1-256d-char3-5")
            .unwrap();
        assert!(
            !rows.is_empty(),
            "embeddings should be populated by default after indexing"
        );
        assert_eq!(
            rows[0].vector.len(),
            256,
            "vector dim should match embedder"
        );
    }

    #[test]
    fn manager_backfill_embeddings_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha bravo charlie").unwrap();
        std::fs::write(dir.path().join("b.txt"), "delta echo foxtrot").unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager
            .add_local_folder(dir.path().to_str().unwrap())
            .unwrap();

        // First backfill should find nothing missing (indexer already
        // embedded inline), but the call must succeed.
        let first = manager.backfill_embeddings(100).unwrap();
        assert_eq!(first, 0, "no missing embeddings after fresh indexing");

        // Second backfill is a no-op.
        let second = manager.backfill_embeddings(100).unwrap();
        assert_eq!(second, 0);
    }

    #[test]
    fn manager_hybrid_search_returns_results_for_typo_query() {
        // Hybrid retrieval should be more forgiving of typos than
        // BM25 alone because the hash-trick embedding shares
        // character n-grams between the typo'd query and the
        // correctly-spelled chunk content. We probe this by indexing
        // a chunk and querying with a one-character substitution.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("doc.txt"),
            "Tessera implements hybrid retrieval combining BM25, vector cosine, and recency decay.",
        )
        .unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager
            .add_local_folder(dir.path().to_str().unwrap())
            .unwrap();

        // Multi-word query so BM25 has terms to anchor on; the
        // "Tesserae" typo is the failure case that pure BM25 misses
        // (no exact match). Hybrid finds it via the embedding signal.
        let results = manager.search("Tesserae hybrid retrieval", 5).unwrap();
        assert!(
            !results.is_empty(),
            "hybrid search should find typo'd query"
        );
    }

    #[test]
    fn manager_invalid_path_returns_error() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let result = manager.add_local_folder("/nonexistent/path/12345");
        assert!(result.is_err());
    }

    // ----------------------------------------------------------------
    // backfill_embeddings_tracked + embedding_progress tests
    // ----------------------------------------------------------------

    use crate::progress::EmbeddingStatus;

    #[test]
    fn embedding_progress_default_state_is_idle() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let snap = manager.embedding_progress();
        assert_eq!(snap.status, EmbeddingStatus::Idle);
        assert_eq!(snap.total_chunks, 0);
        assert_eq!(snap.embedded, 0);
        assert_eq!(snap.failed, 0);
        assert!(snap.model_id.is_none());
        assert!(snap.last_error.is_none());
    }

    #[test]
    fn tracked_backfill_on_fresh_index_reports_zero_missing() {
        // Indexer already embedded inline during add_local_folder, so
        // count_chunks_missing_embedding returns 0 and the tracker
        // ends in Done with embedded=0 / total_chunks=0.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.txt"),
            "alpha bravo charlie delta echo foxtrot",
        )
        .unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager
            .add_local_folder(dir.path().to_str().unwrap())
            .unwrap();

        let total = manager.backfill_embeddings_tracked(64).unwrap();
        assert_eq!(total, 0, "fresh index should leave zero chunks missing");

        let snap = manager.embedding_progress();
        assert_eq!(snap.status, EmbeddingStatus::Done);
        assert_eq!(snap.total_chunks, 0);
        assert_eq!(snap.embedded, 0);
        assert_eq!(snap.failed, 0);
        assert_eq!(
            snap.model_id.as_deref(),
            Some("hash-trick-v1-256d-char3-5"),
            "tracker should record the active model id"
        );
    }

    #[test]
    fn tracked_backfill_fills_chunks_indexed_without_embedder() {
        // Hand-build a SourceManager whose indexer has no embedder,
        // index a folder, then attach an embedder and confirm
        // backfill_embeddings_tracked walks the corpus and reports
        // accurate progress.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.txt"),
            "alpha bravo charlie delta echo foxtrot",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("b.txt"),
            "golf hotel india juliet kilo lima",
        )
        .unwrap();

        // Build a manager with NO embedder so the index pass leaves
        // chunk_embeddings empty.
        let store = SourceStore::open_in_memory().unwrap();
        let indexer = Indexer::new(&[]); // no .with_embedder(...)
        let mut manager = SourceManager {
            store,
            indexer,
            progress: Arc::new(ProgressTracker::new()),
            embedding_progress: Arc::new(EmbeddingProgressTracker::new()),
            embedder: None,
            hybrid_config: Mutex::new(HybridSearchConfig::default()),
        };

        manager
            .add_local_folder(dir.path().to_str().unwrap())
            .unwrap();

        // Now attach the default embedder so backfill has something to
        // populate. We rebuild only the indexer + embedder; the store
        // stays the same so the chunks survive.
        let embedder: Arc<dyn EmbeddingProvider> = Arc::new(HashTrickEmbedding::default_config());
        manager.indexer = Indexer::new(&[]).with_embedder(Arc::clone(&embedder));
        manager.embedder = Some(Arc::clone(&embedder));

        // Pre-flight: the count of missing chunks should be the total
        // number of chunks (zero have been embedded).
        let model_id = embedder.model_id();
        let pre_count = manager
            .store
            .count_chunks_missing_embedding(model_id)
            .unwrap();
        assert!(
            pre_count > 0,
            "indexing without embedder should leave chunks missing embeddings"
        );

        // Run the tracked backfill. Use a small batch size so the
        // loop iterates multiple times — tests the per-chunk progress
        // reporting end-to-end.
        let total = manager.backfill_embeddings_tracked(2).unwrap();
        assert_eq!(
            total, pre_count as usize,
            "backfill should embed every previously-missing chunk"
        );

        let snap = manager.embedding_progress();
        assert_eq!(snap.status, EmbeddingStatus::Done);
        assert_eq!(snap.total_chunks, pre_count);
        assert_eq!(snap.embedded, pre_count);
        assert_eq!(snap.failed, 0);

        // Post-condition: count is now zero (every chunk has an
        // embedding) so a second tracked backfill is a no-op.
        let post_count = manager
            .store
            .count_chunks_missing_embedding(model_id)
            .unwrap();
        assert_eq!(post_count, 0);
        let second = manager.backfill_embeddings_tracked(2).unwrap();
        assert_eq!(second, 0);
        let snap = manager.embedding_progress();
        assert_eq!(snap.status, EmbeddingStatus::Done);
        assert_eq!(snap.total_chunks, 0);
        assert_eq!(snap.embedded, 0);
    }

    #[test]
    fn update_hybrid_config_returns_new_effective_config() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let before = manager.get_hybrid_config();
        assert!((before.vector_weight - 1.0).abs() < 1e-9);

        let new_cfg = manager
            .update_hybrid_config(&HybridSearchConfigInput {
                vector_weight: Some(0.0),
                recency_halflife_secs: Some(14.0 * 24.0 * 60.0 * 60.0),
                ..HybridSearchConfigInput::default()
            })
            .unwrap();
        assert!(new_cfg.vector_weight.abs() < 1e-9);
        assert!((new_cfg.recency_halflife_secs - 14.0 * 24.0 * 60.0 * 60.0).abs() < 1.0);

        // A subsequent get must reflect the updated state — i.e. the
        // mutex was actually written, not just the returned clone.
        let after = manager.get_hybrid_config();
        assert!(after.vector_weight.abs() < 1e-9);
    }

    #[test]
    fn update_hybrid_config_rejects_invalid_patch_without_mutating_state() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let before = manager.get_hybrid_config();
        let err = manager
            .update_hybrid_config(&HybridSearchConfigInput {
                vector_weight: Some(2.0),
                recency_halflife_secs: Some(-1.0),
                ..HybridSearchConfigInput::default()
            })
            .unwrap_err();
        assert!(err.to_string().contains("recency_halflife_secs"));
        let after = manager.get_hybrid_config();
        // Even though vector_weight=2.0 was valid, the whole patch
        // must be rejected together — `apply_patch` is transactional.
        assert!((after.vector_weight - before.vector_weight).abs() < 1e-9);
        assert!((after.recency_halflife_secs - before.recency_halflife_secs).abs() < 1e-9);
    }

    #[test]
    fn update_hybrid_config_disables_vector_signal_for_subsequent_searches() {
        // Set vector_weight=0 and verify search still works (BM25
        // only) without panicking. We can't easily black-box assert
        // "BM25-only ordering" without instrumenting the engine, so
        // this test focuses on the end-to-end "config flows through
        // to the search" contract: a search after the update
        // succeeds and returns results that match the BM25 path.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("doc.txt"),
            "Hybrid retrieval combines BM25 with vector similarity for robust ranking.",
        )
        .unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager
            .add_local_folder(dir.path().to_str().unwrap())
            .unwrap();
        manager
            .update_hybrid_config(&HybridSearchConfigInput {
                vector_weight: Some(0.0),
                ..HybridSearchConfigInput::default()
            })
            .unwrap();
        let results = manager.search("BM25 ranking", 5).unwrap();
        assert!(
            !results.is_empty(),
            "BM25-only search must still find an exact-term query"
        );
    }

    #[test]
    fn update_hybrid_config_is_thread_safe() {
        // Pound the Mutex from multiple threads — concurrent updates
        // must serialize cleanly (no panic from a poisoned mutex,
        // every successful patch is visible to the final reader).
        // We use the manager-level get_hybrid_config() as the
        // observation point because that's exactly what the IPC
        // bridge will call.
        use std::sync::Arc;
        use std::thread;
        let manager = Arc::new(SourceManager::new_in_memory(&[]).unwrap());
        let mut handles = Vec::new();
        for tid in 0..4 {
            let mgr = Arc::clone(&manager);
            handles.push(thread::spawn(move || {
                for i in 0..50 {
                    let weight = ((tid * 50 + i) as f64) / 1000.0;
                    mgr.update_hybrid_config(&HybridSearchConfigInput {
                        vector_weight: Some(weight),
                        ..HybridSearchConfigInput::default()
                    })
                    .unwrap();
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        // Final state must be one of the values the threads set
        // (i.e. in [0.0, 0.199]) — the assertion proves the mutex
        // didn't get poisoned and the final write landed cleanly.
        let final_cfg = manager.get_hybrid_config();
        assert!(
            (0.0..=0.2).contains(&final_cfg.vector_weight),
            "final vector_weight must reflect one of the concurrent writes: {}",
            final_cfg.vector_weight
        );
    }

    #[test]
    fn tracked_backfill_with_no_embedder_flips_status_to_done() {
        // A SourceManager whose embedder is None should flip status
        // to Done immediately (with total_chunks=0) so the renderer
        // sees a clean idle->done transition rather than getting
        // stuck on Running forever.
        let store = SourceStore::open_in_memory().unwrap();
        let manager = SourceManager {
            store,
            indexer: Indexer::new(&[]),
            progress: Arc::new(ProgressTracker::new()),
            embedding_progress: Arc::new(EmbeddingProgressTracker::new()),
            embedder: None,
            hybrid_config: Mutex::new(HybridSearchConfig::default()),
        };

        let total = manager.backfill_embeddings_tracked(64).unwrap();
        assert_eq!(total, 0);
        let snap = manager.embedding_progress();
        assert_eq!(snap.status, EmbeddingStatus::Done);
        assert_eq!(snap.total_chunks, 0);
        assert_eq!(snap.embedded, 0);
        assert_eq!(snap.failed, 0);
        // model_id is recorded as "none" so the UI can distinguish
        // the no-embedder case from a real run.
        assert_eq!(snap.model_id.as_deref(), Some("none"));
    }
}
