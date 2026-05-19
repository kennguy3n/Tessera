use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tessera_core::{SourceId, SourceStatus, SourceType};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Source {
    pub id: SourceId,
    pub source_type: SourceType,
    pub path: String,
    pub status: SourceStatus,
    pub created_at: DateTime<Utc>,
    pub last_indexed: Option<DateTime<Utc>>,
    pub file_count: u64,
}

impl Source {
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
}
