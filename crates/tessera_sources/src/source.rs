//! The `Source` model describing an ingested file or remote item and
//! its indexing status.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tessera_core::{SourceId, SourceStatus, SourceType};

#[derive(Debug, Clone, Serialize, Deserialize)]
/// An ingested source (local folder/file or remote channel) together
/// with its indexing state. Persisted in the `sources` table and
/// referenced by chunks and citations via [`SourceId`].
pub struct Source {
    /// Stable identity, used as the foreign key for chunks/citations.
    pub id: SourceId,
    /// What kind of source this is (local folder/file, KChat, …).
    pub source_type: SourceType,
    /// Absolute filesystem path (or cache dir) the indexer reads from.
    pub path: String,
    /// Current indexing/connection status.
    pub status: SourceStatus,
    /// When the source was first added.
    pub created_at: DateTime<Utc>,
    /// When indexing last completed, or `None` if never indexed.
    pub last_indexed: Option<DateTime<Utc>>,
    /// Number of files indexed from this source.
    pub file_count: u64,
}

impl Source {
    /// Creates a [`SourceType::LocalFolder`] source rooted at `path`,
    /// with a fresh id and `Connected` status.
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

    /// Creates a [`SourceType::LocalFile`] source for a single file
    /// at `path`, with a fresh id and `Connected` status.
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
