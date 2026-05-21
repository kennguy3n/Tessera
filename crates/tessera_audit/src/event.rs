use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEvent {
    pub id: String,
    pub event_type: AuditEventType,
    pub timestamp: DateTime<Utc>,
    pub details: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditEventType {
    SourceAdded,
    SourceRemoved,
    SourceReindexed,
    ArtifactCreated,
    ArtifactUpdated,
    ArtifactDeleted,
    ArtifactExported,
    SettingsChanged,
    ModelStarted,
    ModelStopped,
    SearchPerformed,
    ConnectorConnected,
    ConnectorSynced,
    ConnectorDisconnected,
    CitationAdded,
    CitationReplaced,
    CitationRemoved,
}

impl AuditEvent {
    pub fn new(event_type: AuditEventType, details: String) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            event_type,
            timestamp: Utc::now(),
            details,
        }
    }
}
