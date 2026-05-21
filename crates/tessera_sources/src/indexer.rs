use std::path::Path;
use tessera_core::error::Result;
use tessera_core::{SourceId, SourceStatus};
use walkdir::WalkDir;

use crate::chunker::{chunk_text, ChunkerConfig};
use crate::extractor::{extract_text, is_supported_extension};
use crate::ignore::IgnoreRules;
use crate::store::SourceStore;

pub struct Indexer {
    chunker_config: ChunkerConfig,
    ignore_rules: IgnoreRules,
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
        }
    }

    pub fn with_chunker_config(mut self, config: ChunkerConfig) -> Self {
        self.chunker_config = config;
        self
    }

    pub fn index_folder(
        &self,
        source_id: &SourceId,
        folder_path: &Path,
        store: &SourceStore,
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
                continue;
            }

            if !path.is_file() {
                continue;
            }

            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or_default();

            if !is_supported_extension(ext) {
                result.skipped += 1;
                continue;
            }

            match self.index_file(source_id, path, store) {
                Ok(indexed) => {
                    if indexed {
                        result.indexed += 1;
                    } else {
                        result.unchanged += 1;
                    }
                }
                Err(e) => {
                    result.errors.push(format!("{}: {e}", path.display()));
                }
            }
        }

        let file_count = store.file_count_for_source(source_id)?;
        store.update_source_status(source_id, SourceStatus::Indexed, Some(file_count))?;

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
            store.insert_chunks(file_id, &chunks)?;
        }

        Ok(true)
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
}
