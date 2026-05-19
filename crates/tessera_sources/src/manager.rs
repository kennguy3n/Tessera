use std::path::Path;
use tessera_core::error::{Error, Result};
use tessera_core::SourceId;

use crate::indexer::Indexer;
use crate::search::{SearchEngine, SearchResult};
use crate::source::Source;
use crate::store::{IndexedFile, SourceStore};

pub struct SourceManager {
    store: SourceStore,
    indexer: Indexer,
}

impl SourceManager {
    pub fn new(db_path: &str, ignore_patterns: &[String]) -> Result<Self> {
        let store = SourceStore::open(db_path)?;
        let indexer = Indexer::new(ignore_patterns);
        Ok(Self { store, indexer })
    }

    pub fn new_in_memory(ignore_patterns: &[String]) -> Result<Self> {
        let store = SourceStore::open_in_memory()?;
        let indexer = Indexer::new(ignore_patterns);
        Ok(Self { store, indexer })
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
        let engine = SearchEngine::new(&self.store);
        engine.search(query, limit)
    }

    pub fn search_broad(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let engine = SearchEngine::new(&self.store);
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

        match source.source_type {
            tessera_core::SourceType::LocalFolder => {
                self.indexer.index_folder(source_id, path, &self.store)?;
            }
            tessera_core::SourceType::LocalFile => {
                self.indexer
                    .index_single_file(source_id, path, &self.store)?;
                let file_count = self.store.file_count_for_source(source_id)?;
                self.store.update_source_status(
                    source_id,
                    tessera_core::SourceStatus::Indexed,
                    Some(file_count),
                )?;
            }
            _ => {}
        }
        Ok(())
    }
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
    fn manager_invalid_path_returns_error() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let result = manager.add_local_folder("/nonexistent/path/12345");
        assert!(result.is_err());
    }
}
