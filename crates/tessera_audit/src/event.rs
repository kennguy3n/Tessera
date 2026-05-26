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
    /// The Node-side `KchatEventForwarder` refreshed a KChat
    /// channel's ACL roster against the substrate (Block B Task 3,
    /// Phase 11). Details carry the originating channel id, the
    /// number of members in the refreshed roster, the boolean
    /// `principal_present` projection (was the locally-authenticated
    /// principal in the roster), and the projection outcome
    /// (`granted` / `regranted` / `revoked` / `unlinked` /
    /// `no_principal`). Member ids and roles are NOT logged — the
    /// substrate stores them in the `kchat_source_acl` table and
    /// the audit row's count is the operator-visible summary.
    KchatAclRefreshed,
    /// A KChat-channel source transitioned to
    /// `SourceStatus::AccessRevoked` — either because
    /// `refresh_kchat_acl` did not find the principal in the new
    /// roster, or because the forwarder dispatched an explicit
    /// revoke on `channel_archived` / `channel_deleted` / self-
    /// `user_removed`. Details carry the originating channel id
    /// and the reason string so an operator can answer "when did I
    /// lose access to this channel, and why" without consulting
    /// the KChat server log.
    KchatChannelAccessRevoked,
    /// A KChat-channel source's indexed evidence (chunks +
    /// indexed_files + their FTS5 / embedding rows) was scrubbed
    /// inline as part of a revoke transition (Block B Task 4,
    /// Phase 11). Details carry the channel id, the reason
    /// (`channel_archived` / `channel_deleted` /
    /// `principal_missing_from_roster` / explicit operator
    /// revoke), and the counts of chunks + files scrubbed. This
    /// row is the operator-visible signal that the cryptoshred
    /// step succeeded — the prior `KchatChannelAccessRevoked` row
    /// only records the status transition.
    KchatSourceCryptoshredded,
    /// Block C Task 1 (Phase 12): a KChat post body was ingested
    /// into the substrate. Details carry the channel id, the
    /// post id, the number of chunks AEAD-sealed under the
    /// per-source DEK, and the bookkeeping outcome
    /// (`ingested` / `unchanged` / `unlinked` / `access_revoked`).
    /// Post bodies are NEVER logged — only the structural
    /// observability fields the operator needs to confirm the
    /// ingest pipeline is running.
    KchatPostIngested,
    /// Block C Task 1 (Phase 12): an existing KChat post was
    /// re-indexed after a `post_edited` event. Details mirror
    /// `KchatPostIngested` (same outcome catalogue: the re-index
    /// drops the previous chunks and indexes the new body).
    KchatPostEdited,
    /// Block C Task 1 (Phase 12): a KChat post was removed from
    /// the substrate after a `post_deleted` event. Details carry
    /// the channel id, the post id, the chunk count that was
    /// dropped, and the outcome (`deleted` / `not_found` /
    /// `unlinked` / `access_revoked`). The DEK row is NOT
    /// deleted on per-post delete — it is only retired on the
    /// source-level revoke / cryptoshred path.
    KchatPostDeleted,
    /// Block C Task 4 (Phase 13): an orchestrator-driven
    /// historical-backfill walk started (or resumed) for a KChat
    /// channel. Details include `resume_from=<post_id>` or
    /// `(fresh)` when the walk begins at the newest post. Pairs
    /// 1:1 with [`KchatBackfillCompleted`] or
    /// [`KchatBackfillAborted`] on the same `(channel,source)`.
    KchatBackfillStarted,
    /// Block C Task 4 (Phase 13): one page of the historical
    /// backfill walk was processed. Details carry the 1-based
    /// page number, per-page substrate counters
    /// (`posts_ingested`, `posts_unchanged`,
    /// `posts_skipped_revoked`), and the cursor the substrate
    /// advanced to (`cursor=<post_id>` or `(none)` on an empty
    /// page). Operators can grep these rows to reconstruct the
    /// progression of a long-running walk.
    KchatBackfillPageIngested,
    /// Block C Task 4 (Phase 13): the backfill walk finished
    /// successfully — the KChat REST server returned
    /// `prev_post_id == null`, signalling no posts older than
    /// the cursor exist. Details carry the cumulative
    /// `pages_walked`, `total_posts_ingested`, and
    /// `total_posts_unchanged` (the dedupe count).
    KchatBackfillCompleted,
    /// Block C Task 4 (Phase 13): the backfill walk stopped
    /// early. Details carry a machine-readable `reason` tag:
    /// `access_revoked` (source flipped to revoked mid-walk),
    /// `safety_cap` (per-channel cumulative cap hit),
    /// `unlinked` (source row disappeared between pages),
    /// `error` (REST or substrate error). The cursor remains
    /// at the last successfully-acknowledged post id so a
    /// later retrigger resumes from there.
    KchatBackfillAborted,
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
            Self::KchatAclRefreshed => "kchat_acl_refreshed",
            Self::KchatChannelAccessRevoked => "kchat_channel_access_revoked",
            Self::KchatSourceCryptoshredded => "kchat_source_cryptoshredded",
            Self::KchatPostIngested => "kchat_post_ingested",
            Self::KchatPostEdited => "kchat_post_edited",
            Self::KchatPostDeleted => "kchat_post_deleted",
            Self::KchatBackfillStarted => "kchat_backfill_started",
            Self::KchatBackfillPageIngested => "kchat_backfill_page_ingested",
            Self::KchatBackfillCompleted => "kchat_backfill_completed",
            Self::KchatBackfillAborted => "kchat_backfill_aborted",
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
            AuditEventType::KchatAclRefreshed,
            AuditEventType::KchatChannelAccessRevoked,
            AuditEventType::KchatSourceCryptoshredded,
            AuditEventType::KchatPostIngested,
            AuditEventType::KchatPostEdited,
            AuditEventType::KchatPostDeleted,
            AuditEventType::KchatBackfillStarted,
            AuditEventType::KchatBackfillPageIngested,
            AuditEventType::KchatBackfillCompleted,
            AuditEventType::KchatBackfillAborted,
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
