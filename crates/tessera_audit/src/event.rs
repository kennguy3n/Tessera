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
    /// A KChat WebSocket event was received in the main process and
    /// surfaced to the renderer / source-refresh pipeline. Details
    /// carry the WS event name (`posted`, `file_added`, …) and the
    /// originating channel id when present; payload bodies are
    /// NOT logged so the audit trail does not leak message text or
    /// file contents. The audit row gives operators a way to
    /// correlate WS-driven indexer activity (auto-reindex of a
    /// channel source on `file_added`) with the originating
    /// channel event without needing access to the KChat server
    /// audit log itself.
    KchatFileEventReceived,
}

impl AuditEventType {
    /// Return the canonical snake_case identifier for this variant,
    /// matching the `#[serde(rename_all = "snake_case")]` JSON form
    /// but without the JSON-string round-trip + quote-trim that the
    /// napi bridge previously used (fourteenth-pass Devin Review
    /// ANALYSIS_0007). Centralising the mapping here also gives a
    /// single place to look when adding a new variant.
    pub fn as_snake_case(&self) -> &'static str {
        match self {
            Self::SourceAdded => "source_added",
            Self::SourceRemoved => "source_removed",
            Self::SourceReindexed => "source_reindexed",
            Self::ArtifactCreated => "artifact_created",
            Self::ArtifactUpdated => "artifact_updated",
            Self::ArtifactDeleted => "artifact_deleted",
            Self::ArtifactExported => "artifact_exported",
            Self::SettingsChanged => "settings_changed",
            Self::ModelStarted => "model_started",
            Self::ModelStopped => "model_stopped",
            Self::SearchPerformed => "search_performed",
            Self::ConnectorConnected => "connector_connected",
            Self::ConnectorSynced => "connector_synced",
            Self::ConnectorDisconnected => "connector_disconnected",
            Self::CitationAdded => "citation_added",
            Self::CitationReplaced => "citation_replaced",
            Self::CitationRemoved => "citation_removed",
            Self::TemplateValidationFailed => "template_validation_failed",
            Self::KchatConnected => "kchat_connected",
            Self::KchatDisconnected => "kchat_disconnected",
            Self::KchatArtifactShared => "kchat_artifact_shared",
            Self::KchatChannelLinked => "kchat_channel_linked",
            Self::KchatChannelUnlinked => "kchat_channel_unlinked",
            Self::KchatFileDownloaded => "kchat_file_downloaded",
            Self::KchatFileEventReceived => "kchat_file_event_received",
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Cross-check `AuditEventType::as_snake_case` against the
    /// serde-derived JSON form so a future variant added to the
    /// enum without a matching `as_snake_case` arm cannot silently
    /// diverge. If this test fails, add the new variant to the
    /// match in `as_snake_case` (and confirm the renderer's audit
    /// activity filter knows about the new snake_case name).
    #[test]
    fn as_snake_case_matches_serde_form() {
        let all = [
            AuditEventType::SourceAdded,
            AuditEventType::SourceRemoved,
            AuditEventType::SourceReindexed,
            AuditEventType::ArtifactCreated,
            AuditEventType::ArtifactUpdated,
            AuditEventType::ArtifactDeleted,
            AuditEventType::ArtifactExported,
            AuditEventType::SettingsChanged,
            AuditEventType::ModelStarted,
            AuditEventType::ModelStopped,
            AuditEventType::SearchPerformed,
            AuditEventType::ConnectorConnected,
            AuditEventType::ConnectorSynced,
            AuditEventType::ConnectorDisconnected,
            AuditEventType::CitationAdded,
            AuditEventType::CitationReplaced,
            AuditEventType::CitationRemoved,
            AuditEventType::TemplateValidationFailed,
            AuditEventType::KchatConnected,
            AuditEventType::KchatDisconnected,
            AuditEventType::KchatArtifactShared,
            AuditEventType::KchatChannelLinked,
            AuditEventType::KchatChannelUnlinked,
            AuditEventType::KchatFileDownloaded,
            AuditEventType::KchatFileEventReceived,
        ];
        for ev in all.iter() {
            let serde_form = serde_json::to_string(ev).unwrap();
            let unquoted = serde_form.trim_matches('"');
            assert_eq!(
                ev.as_snake_case(),
                unquoted,
                "as_snake_case() out of sync with serde form for {:?}",
                ev,
            );
        }
    }
}
