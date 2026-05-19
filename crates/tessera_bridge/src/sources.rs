use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tessera_core::SourceId;
use tessera_sources::manager::SourceManager;
use tessera_sources::search::SearchResult;
use tessera_sources::source::Source;

use crate::{BridgeError, BridgeResult};

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct SourceInfo {
    pub id: String,
    pub source_type: String,
    pub path: String,
    pub status: String,
    pub created_at: String,
    pub last_indexed: Option<String>,
    pub file_count: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct SearchHitInfo {
    pub content: String,
    pub excerpt: String,
    pub source_path: String,
    pub chunk_index: i32,
    pub relevance: f64,
}

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct IndexedFileInfo {
    pub path: String,
    pub hash: String,
    pub last_modified: String,
    pub chunk_count: i32,
}

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct SourceDetailInfo {
    pub source: SourceInfo,
    pub files: Vec<IndexedFileInfo>,
}

impl From<&Source> for SourceInfo {
    fn from(s: &Source) -> Self {
        Self {
            id: s.id.to_string(),
            source_type: serde_json::to_string(&s.source_type).unwrap_or_default(),
            path: s.path.clone(),
            status: serde_json::to_string(&s.status).unwrap_or_default(),
            created_at: s.created_at.to_rfc3339(),
            last_indexed: s.last_indexed.map(|t| t.to_rfc3339()),
            file_count: s.file_count as i64,
        }
    }
}

impl From<&SearchResult> for SearchHitInfo {
    fn from(r: &SearchResult) -> Self {
        Self {
            content: r.content.clone(),
            excerpt: r.excerpt.clone(),
            source_path: r.source_path.clone(),
            chunk_index: r.chunk_index as i32,
            relevance: r.relevance,
        }
    }
}

pub fn add_local_folder(manager: &SourceManager, path: &str) -> BridgeResult<SourceInfo> {
    let source = manager.add_local_folder(path).map_err(BridgeError::Core)?;
    Ok(SourceInfo::from(&source))
}

pub fn add_local_file(manager: &SourceManager, path: &str) -> BridgeResult<SourceInfo> {
    let source = manager.add_local_file(path).map_err(BridgeError::Core)?;
    Ok(SourceInfo::from(&source))
}

pub fn list_sources(manager: &SourceManager) -> BridgeResult<Vec<SourceInfo>> {
    let sources = manager.list_sources().map_err(BridgeError::Core)?;
    Ok(sources.iter().map(SourceInfo::from).collect())
}

pub fn remove_source(manager: &SourceManager, source_id: &str) -> BridgeResult<()> {
    let uuid =
        uuid::Uuid::parse_str(source_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    manager
        .remove_source(&SourceId(uuid))
        .map_err(BridgeError::Core)
}

pub fn search_sources(
    manager: &SourceManager,
    query: &str,
    limit: usize,
) -> BridgeResult<Vec<SearchHitInfo>> {
    let results = manager.search(query, limit).map_err(BridgeError::Core)?;
    Ok(results.iter().map(SearchHitInfo::from).collect())
}

pub fn get_source_detail(
    manager: &SourceManager,
    source_id: &str,
) -> BridgeResult<SourceDetailInfo> {
    let uuid =
        uuid::Uuid::parse_str(source_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let source = manager
        .get_source(&SourceId(uuid))
        .map_err(BridgeError::Core)?;
    let files = manager
        .list_indexed_files(&SourceId(uuid))
        .map_err(BridgeError::Core)?;
    let file_infos: Vec<IndexedFileInfo> = files
        .iter()
        .map(|f| IndexedFileInfo {
            path: f.path.clone(),
            hash: f.hash.clone(),
            last_modified: f.last_modified.clone(),
            chunk_count: f.chunk_count as i32,
        })
        .collect();
    Ok(SourceDetailInfo {
        source: SourceInfo::from(&source),
        files: file_infos,
    })
}

pub fn reindex_source(manager: &SourceManager, source_id: &str) -> BridgeResult<SourceInfo> {
    let uuid =
        uuid::Uuid::parse_str(source_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    manager
        .reindex_source(&SourceId(uuid))
        .map_err(BridgeError::Core)?;
    let source = manager
        .get_source(&SourceId(uuid))
        .map_err(BridgeError::Core)?;
    Ok(SourceInfo::from(&source))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_add_folder_and_search() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("notes.txt"),
            "Important meeting notes about the project roadmap",
        )
        .unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let info = add_local_folder(&manager, dir.path().to_str().unwrap()).unwrap();
        assert_eq!(info.file_count, 1);

        let sources = list_sources(&manager).unwrap();
        assert_eq!(sources.len(), 1);

        let results = search_sources(&manager, "meeting notes", 10).unwrap();
        assert!(!results.is_empty());
    }

    #[test]
    fn bridge_remove_source() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("test.txt"), "content").unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let info = add_local_folder(&manager, dir.path().to_str().unwrap()).unwrap();

        remove_source(&manager, &info.id).unwrap();
        let sources = list_sources(&manager).unwrap();
        assert!(sources.is_empty());
    }

    #[test]
    fn bridge_reindex_source() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("test.txt"), "initial content").unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let info = add_local_folder(&manager, dir.path().to_str().unwrap()).unwrap();

        std::fs::write(dir.path().join("new.txt"), "new content").unwrap();
        let updated = reindex_source(&manager, &info.id).unwrap();
        assert!(updated.file_count >= 1);
    }
}
