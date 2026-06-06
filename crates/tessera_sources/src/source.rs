use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tessera_core::{SourceId, SourceStatus, SourceType};

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Source.
pub struct Source {
    /// Id.
    pub id: SourceId,
    /// Source type.
    pub source_type: SourceType,
    /// Path.
    pub path: String,
    /// Status.
    pub status: SourceStatus,
    /// Created at.
    pub created_at: DateTime<Utc>,
    /// Last indexed.
    pub last_indexed: Option<DateTime<Utc>>,
    /// File count.
    pub file_count: u64,
}

impl Source {
    /// New local folder.
    pub fn new_local_folder(path: String) -> Self {
        Self {
            id: SourceId::new(),
            source_type: SourceType::LocalFolder,
            path,
            status: SourceStatus::Connected,
            created_at: Utc::now(),
            last_indexed: None,
            file_count: 0,
        }
    }

    /// New local file.
    pub fn new_local_file(path: String) -> Self {
        Self {
            id: SourceId::new(),
            source_type: SourceType::LocalFile,
            path,
            status: SourceStatus::Connected,
            created_at: Utc::now(),
            last_indexed: None,
            file_count: 0,
        }
    }

    /// Construct a source backed by the local cache directory the
    /// Node-side KChat client populates from a channel's file store.
    /// The `path` must be the absolute directory where downloaded
    /// files live; the indexer treats it like any other local folder.
    pub fn new_kchat_channel(cache_dir: String) -> Self {
        Self {
            id: SourceId::new(),
            source_type: SourceType::Kchat,
            path: cache_dir,
            status: SourceStatus::Connected,
            created_at: Utc::now(),
            last_indexed: None,
            file_count: 0,
        }
    }
}
