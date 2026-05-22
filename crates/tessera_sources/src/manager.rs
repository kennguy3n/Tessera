use std::path::Path;
use std::sync::Arc;
use tessera_core::error::{Error, Result};
use tessera_core::{SharedConnection, SourceId};

use crate::embedding::{EmbeddingProvider, HashTrickEmbedding};
use crate::hybrid::HybridSearchConfig;
use crate::indexer::Indexer;
use crate::progress::{ProgressSnapshot, ProgressTracker};
use crate::search::{SearchEngine, SearchResult};
use crate::source::Source;
use crate::store::{IndexedFile, SourceStore};

pub struct SourceManager {
    store: SourceStore,
    indexer: Indexer,
    progress: Arc<ProgressTracker>,
    embedder: Option<Arc<dyn EmbeddingProvider>>,
    hybrid_config: HybridSearchConfig,
}

impl SourceManager {
    pub fn new(db_path: &str, ignore_patterns: &[String]) -> Result<Self> {
        let store = SourceStore::open(db_path)?;
        let (indexer, embedder, hybrid_config) = build_default_hybrid_pipeline(ignore_patterns);
        Ok(Self {
            store,
            indexer,
            progress: Arc::new(ProgressTracker::new()),
            embedder,
            hybrid_config,
        })
    }

    pub fn new_in_memory(ignore_patterns: &[String]) -> Result<Self> {
        let store = SourceStore::open_in_memory()?;
        let (indexer, embedder, hybrid_config) = build_default_hybrid_pipeline(ignore_patterns);
        Ok(Self {
            store,
            indexer,
            progress: Arc::new(ProgressTracker::new()),
            embedder,
            hybrid_config,
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
            embedder,
            hybrid_config,
        })
    }

    /// Backfill embeddings for every chunk that doesn't yet have one
    /// for the current embedder. Idempotent. The bridge layer
    /// invokes this after attaching a new embedder so existing
    /// corpora benefit from hybrid retrieval without a full reindex.
    pub fn backfill_embeddings(&self, batch_size: usize) -> Result<usize> {
        self.indexer.backfill_embeddings(&self.store, batch_size)
    }

    /// Returns the latest indexing progress snapshot for a source.
    /// Idle by default if no index pass has been observed.
    pub fn indexing_progress(&self, source_id: &SourceId) -> ProgressSnapshot {
        self.progress.snapshot(source_id)
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
        let engine = SearchEngine::hybrid(
            &self.store,
            self.embedder.as_deref(),
            self.hybrid_config.clone(),
        );
        engine.search(query, limit)
    }

    pub fn search_broad(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let engine = SearchEngine::hybrid(
            &self.store,
            self.embedder.as_deref(),
            self.hybrid_config.clone(),
        );
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
}
