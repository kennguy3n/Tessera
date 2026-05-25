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
    /// A bundled or user-supplied template YAML failed parse or
    /// semantic validation when the registry was loaded. Distinct
    /// from a runtime IPC error because the failure happens at
    /// load time (Tessera startup or `templates:list` IPC) and the
    /// affected file is silently dropped from the registry. The
    /// `details` payload includes the file path, the failure kind
    /// (parse vs. validation), and the underlying error message so
    /// operators reviewing the audit log can tell exactly which
    /// template needs fixing.
    TemplateValidationFailed,
    /// KChat connection established — the user's personal access
    /// token was stored in the OS keychain and a `/users/me` probe
    /// succeeded. Details carry the KChat server URL + KChat
    /// `user_id` so auditors can correlate channel events with a
    /// specific KChat identity without exposing the token itself.
    KchatConnected,
    /// KChat connection torn down. Details carry the KChat
    /// `user_id` of the disconnected account so the audit trail
    /// reflects which identity left the workspace.
    KchatDisconnected,
    /// An artifact was exported and uploaded into a KChat channel's
    /// file store. Details carry artifact id, channel id, export
    /// format, and whether citations + evidence pack were attached
    /// so operators can answer "who shared this artifact" without
    /// needing access to the KChat audit log itself.
    KchatArtifactShared,
    /// A KChat channel was linked as an indexed source. Details
    /// carry channel id, channel name, and the local cache
    /// directory the Node-side client populates with downloaded
    /// files.
    KchatChannelLinked,
    /// A previously linked KChat channel was unlinked from the
    /// Sources surface. Details carry channel id and the number
    /// of cached files removed from disk.
    KchatChannelUnlinked,
    /// A file was downloaded from a KChat channel into the local
    /// cache so the indexer could pick it up. Details carry channel
    /// id and the file name; bytes are not logged so the audit
    /// trail stays cheap.
    KchatFileDownloaded,
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
