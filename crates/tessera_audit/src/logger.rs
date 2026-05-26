use tessera_core::error::Result;
use tessera_core::SharedConnection;

use crate::event::{AuditEvent, AuditEventType};
use crate::store::AuditStore;

pub struct AuditLogger {
    store: AuditStore,
}

impl AuditLogger {
    pub fn new(db_path: &str) -> Result<Self> {
        let store = AuditStore::open(db_path)?;
        Ok(Self { store })
    }

    pub fn new_in_memory() -> Result<Self> {
        let store = AuditStore::open_in_memory()?;
        Ok(Self { store })
    }

    /// Build a logger backed by a [`SharedConnection`] that is also
    /// used by other stores. Used by the napi bridge.
    pub fn with_shared_conn(conn: SharedConnection) -> Result<Self> {
        let store = AuditStore::with_shared_conn(conn)?;
        Ok(Self { store })
    }

    pub fn log(&self, event_type: AuditEventType, details: String) -> Result<()> {
        let event = AuditEvent::new(event_type, details);
        self.store.append(&event)
    }

    pub fn log_source_added(&self, path: &str) -> Result<()> {
        self.log(AuditEventType::SourceAdded, format!("Source added: {path}"))
    }

    pub fn log_source_removed(&self, source_id: &str) -> Result<()> {
        self.log(
            AuditEventType::SourceRemoved,
            format!("Source removed: {source_id}"),
        )
    }

    /// Record that a source was manually re-indexed. Distinct from
    /// `SourceAdded` because re-index does not change the on-disk
    /// path; it only invalidates the chunk + embedding cache.
    pub fn log_source_reindexed(&self, source_id: &str) -> Result<()> {
        self.log(
            AuditEventType::SourceReindexed,
            format!("Source reindexed: {source_id}"),
        )
    }

    pub fn log_artifact_created(&self, title: &str) -> Result<()> {
        self.log(
            AuditEventType::ArtifactCreated,
            format!("Artifact created: {title}"),
        )
    }

    /// Record that an artifact's content changed. Caller passes the
    /// artifact id (UUID string) rather than the title so downstream
    /// reports can correlate updates to the original create event
    /// without depending on a stable title.
    pub fn log_artifact_updated(&self, artifact_id: &str) -> Result<()> {
        self.log(
            AuditEventType::ArtifactUpdated,
            format!("Artifact updated: {artifact_id}"),
        )
    }

    /// Record that an artifact was hard-deleted. Caller passes the
    /// artifact id rather than the title because the title is not
    /// guaranteed to be retrievable after the delete commits.
    pub fn log_artifact_deleted(&self, artifact_id: &str) -> Result<()> {
        self.log(
            AuditEventType::ArtifactDeleted,
            format!("Artifact deleted: {artifact_id}"),
        )
    }

    pub fn log_artifact_exported(&self, title: &str, format: &str) -> Result<()> {
        self.log(
            AuditEventType::ArtifactExported,
            format!("Artifact exported: {title} as {format}"),
        )
    }

    /// Record that the local model sidecar started. `model_id` is
    /// the absolute path or model identifier so an auditor can
    /// correlate the start event with the model file actually
    /// loaded.
    pub fn log_model_started(&self, model_id: &str) -> Result<()> {
        self.log(
            AuditEventType::ModelStarted,
            format!("Model started: {model_id}"),
        )
    }

    /// Record that the local model sidecar stopped. `reason` is
    /// rendered verbatim (e.g. `"user-requested"`, `"app-shutdown"`,
    /// `"crash: <message>"`) so the audit trail captures intentional
    /// vs. unintentional terminations.
    pub fn log_model_stopped(&self, reason: &str) -> Result<()> {
        self.log(
            AuditEventType::ModelStopped,
            format!("Model stopped: {reason}"),
        )
    }

    pub fn log_settings_changed(&self, setting: &str, value: &str) -> Result<()> {
        self.log(
            AuditEventType::SettingsChanged,
            format!("Setting changed: {setting} = {value}"),
        )
    }

    pub fn log_connector_connected(&self, provider: &str) -> Result<()> {
        self.log(
            AuditEventType::ConnectorConnected,
            format!("Connector connected: {provider}"),
        )
    }

    pub fn log_connector_synced(
        &self,
        provider: &str,
        added: usize,
        updated: usize,
        removed: usize,
    ) -> Result<()> {
        self.log(
            AuditEventType::ConnectorSynced,
            format!(
                "Connector synced: {provider} (added={added}, updated={updated}, removed={removed})"
            ),
        )
    }

    pub fn log_connector_disconnected(&self, provider: &str, files_removed: usize) -> Result<()> {
        self.log(
            AuditEventType::ConnectorDisconnected,
            format!("Connector disconnected: {provider} (files_removed={files_removed})"),
        )
    }

    /// Record that KChat was connected — the user's personal access
    /// token landed in the OS keychain and the `/users/me` probe
    /// returned a `user_id`. Token bytes are never logged.
    pub fn log_kchat_connected(&self, server_url: &str, kchat_user_id: &str) -> Result<()> {
        self.log(
            AuditEventType::KchatConnected,
            format!("KChat connected: server={server_url} user_id={kchat_user_id}"),
        )
    }

    /// Record that KChat was disconnected. We deliberately log the
    /// outgoing `kchat_user_id` so the audit trail makes the
    /// identity change visible across a re-connect under a
    /// different account.
    pub fn log_kchat_disconnected(&self, kchat_user_id: &str) -> Result<()> {
        self.log(
            AuditEventType::KchatDisconnected,
            format!("KChat disconnected: user_id={kchat_user_id}"),
        )
    }

    /// Record that an artifact was uploaded into a KChat channel.
    /// `format` is the export format (`pdf`, `docx`, …), the boolean
    /// flags reflect whether citations and an evidence pack were
    /// attached.
    pub fn log_kchat_artifact_shared(
        &self,
        artifact_id: &str,
        channel_id: &str,
        format: &str,
        include_citations: bool,
        include_evidence_pack: bool,
    ) -> Result<()> {
        self.log(
            AuditEventType::KchatArtifactShared,
            format!(
                "Artifact shared to KChat: artifact={artifact_id} channel={channel_id} \
                 format={format} citations={include_citations} \
                 evidence_pack={include_evidence_pack}"
            ),
        )
    }

    /// Record that a KChat channel was linked as a Tessera source.
    /// `cache_dir` is the local directory the channel's files
    /// download into so the indexer can treat them as local files.
    pub fn log_kchat_channel_linked(
        &self,
        channel_id: &str,
        channel_name: &str,
        cache_dir: &str,
    ) -> Result<()> {
        self.log(
            AuditEventType::KchatChannelLinked,
            format!(
                "KChat channel linked: channel={channel_id} name={channel_name} \
                 cache_dir={cache_dir}"
            ),
        )
    }

    /// Record that a previously linked KChat channel was unlinked.
    pub fn log_kchat_channel_unlinked(&self, channel_id: &str, files_removed: usize) -> Result<()> {
        self.log(
            AuditEventType::KchatChannelUnlinked,
            format!("KChat channel unlinked: channel={channel_id} files_removed={files_removed}"),
        )
    }

    /// Record that a file was downloaded from a KChat channel into
    /// the local cache. File contents are not logged.
    pub fn log_kchat_file_downloaded(
        &self,
        channel_id: &str,
        file_name: &str,
        bytes: u64,
    ) -> Result<()> {
        self.log(
            AuditEventType::KchatFileDownloaded,
            format!("KChat file downloaded: channel={channel_id} name={file_name} bytes={bytes}"),
        )
    }

    /// Record that a KChat WebSocket event was received in the main
    /// process and acted on. Payload bodies are NOT logged so the
    /// audit row never contains message text or file contents — only
    /// the event name, the originating `channel_id` when present,
    /// and an optional `file_id` for `file_added` events so an
    /// operator can correlate the audit row with the KChat server's
    /// file metadata.
    ///
    /// The `triggered_reindex` flag is a reserved slot for the
    /// future iteration that wires the WS forwarder into
    /// `runAddKchatChannel` so a `file_added` event triggers a
    /// download+reindex of the referenced file. The current Node-
    /// side forwarder always passes `false` — see the second-pass
    /// Devin Review on PR #43 (`BUG_pr-review-job-...0001`) and the
    /// top-of-file doc block in
    /// `apps/desktop/electron/kchat/kchatEventForwarder.ts` for the
    /// rationale (file isn't on disk at `file_added` time, so the
    /// previous-draft `bridgeReindexSource` call was a blocking
    /// no-op under the source-manager mutex). The field is retained
    /// on the audit row text so the auto-sync iteration can
    /// repopulate it without a back-compat break in row-text
    /// parsing.
    pub fn log_kchat_file_event_received(
        &self,
        event_name: &str,
        channel_id: Option<&str>,
        file_id: Option<&str>,
        triggered_reindex: bool,
    ) -> Result<()> {
        let channel = channel_id.unwrap_or("");
        let file = file_id.unwrap_or("");
        self.log(
            AuditEventType::KchatFileEventReceived,
            format!(
                "KChat WS event: event={event_name} channel={channel} file={file} \
                 triggered_reindex={triggered_reindex}"
            ),
        )
    }

    /// Record that the Node-side `KchatEventForwarder` refreshed
    /// a KChat channel's ACL roster against the substrate (Block
    /// B Task 3, Phase 11).
    ///
    /// `channel_id` is the originating WS-event channel id (NOT
    /// the cache_dir — operators correlate against KChat-server
    /// activity by channel id); `member_count` is the size of the
    /// refreshed roster as the substrate persisted it;
    /// `principal_present` is the projection outcome from the
    /// substrate's `refresh_kchat_acl`; `outcome` is one of
    /// `granted` / `regranted` / `revoked` / `unlinked` /
    /// `no_principal` so the audit trail shows the exact status
    /// transition the refresh produced.
    pub fn log_kchat_acl_refreshed(
        &self,
        channel_id: &str,
        member_count: usize,
        principal_present: bool,
        outcome: &str,
    ) -> Result<()> {
        self.log(
            AuditEventType::KchatAclRefreshed,
            format!(
                "KChat ACL refreshed: channel={channel_id} members={member_count} \
                 principal_present={principal_present} outcome={outcome}"
            ),
        )
    }

    /// Record that a KChat-channel source was transitioned to
    /// `SourceStatus::AccessRevoked` (Block B Task 3, Phase 11).
    /// `reason` is a free-form short code identifying the
    /// triggering event: `principal_removed` (an explicit
    /// `user_removed` for the principal), `channel_archived`
    /// (the channel was archived server-side), `channel_deleted`
    /// (the channel was deleted server-side), or
    /// `principal_missing_from_roster` (a routine `refresh_kchat_acl`
    /// returned `Revoked`).
    pub fn log_kchat_channel_access_revoked(&self, channel_id: &str, reason: &str) -> Result<()> {
        self.log(
            AuditEventType::KchatChannelAccessRevoked,
            format!("KChat channel access revoked: channel={channel_id} reason={reason}"),
        )
    }

    /// Record that a KChat-channel source's indexed evidence was
    /// scrubbed inline as part of a revoke transition (Block B
    /// Task 4, Phase 11). Emitted by the Node-side forwarder /
    /// IPC handler immediately after the bridge revoke call
    /// returns a `Revoked` outcome, so operators see both the
    /// `KchatChannelAccessRevoked` row (status transition) and
    /// this row (chunks + files scrubbed) in the trail.
    ///
    /// `chunks_dropped` / `files_dropped` are the substrate-side
    /// counts returned by `cryptoshred_kchat_source_evidence`. A
    /// future `KchatChannelAccessRevoked` without a corresponding
    /// `KchatSourceCryptoshredded` row would be the signal that
    /// the shred step failed — useful for incident-response
    /// queries.
    ///
    /// `fs_scrub_succeeded` records whether the Node-side
    /// filesystem scrub (`secureDeleteChannelArtifacts` removing the
    /// per-channel cache dir + manifest sidecar) ran cleanly. The
    /// substrate counts only describe the database scrub; the
    /// filesystem holds the downloaded plaintext until this scrub
    /// completes. An operator grep-ing for `fs_scrub_succeeded=false`
    /// finds revokes where on-disk plaintext survived the scrub
    /// (e.g. `fs.rm` blocked by another process on Windows) and
    /// must be re-run by hand. `fs_scrub_error` carries the first
    /// `fs.rm` error message in that case.
    pub fn log_kchat_source_cryptoshredded(
        &self,
        channel_id: &str,
        reason: &str,
        chunks_dropped: u32,
        files_dropped: u32,
        fs_scrub_succeeded: bool,
        fs_scrub_error: Option<&str>,
    ) -> Result<()> {
        let fs_error_segment = match fs_scrub_error {
            Some(e) if !e.is_empty() => format!(" fs_scrub_error={e}"),
            _ => String::new(),
        };
        self.log(
            AuditEventType::KchatSourceCryptoshredded,
            format!(
                "KChat source cryptoshredded: channel={channel_id} reason={reason} \
                 chunks_dropped={chunks_dropped} files_dropped={files_dropped} \
                 fs_scrub_succeeded={fs_scrub_succeeded}{fs_error_segment}"
            ),
        )
    }

    pub fn log_citation_added(
        &self,
        artifact_id: &str,
        citation_id: &str,
        source_uri: &str,
    ) -> Result<()> {
        self.log(
            AuditEventType::CitationAdded,
            format!(
                "Citation added: artifact={artifact_id} citation={citation_id} source={source_uri}"
            ),
        )
    }

    pub fn log_citation_replaced(
        &self,
        artifact_id: &str,
        citation_id: &str,
        old_source_uri: &str,
        new_source_uri: &str,
    ) -> Result<()> {
        self.log(
            AuditEventType::CitationReplaced,
            format!(
                "Citation replaced: artifact={artifact_id} citation={citation_id} \
                 old_source={old_source_uri} new_source={new_source_uri}"
            ),
        )
    }

    pub fn log_citation_removed(&self, artifact_id: &str, citation_id: &str) -> Result<()> {
        self.log(
            AuditEventType::CitationRemoved,
            format!("Citation removed: artifact={artifact_id} citation={citation_id}"),
        )
    }

    /// Record that a template YAML failed parse or semantic
    /// validation when the registry was loaded. Distinct from a
    /// runtime IPC error because the failure happens at load time
    /// (Tessera startup or `templates:list` IPC) and the affected
    /// file is silently dropped from the registry — without an
    /// audit row the operator has no surfaced way to learn that a
    /// template went missing from the list. The `kind` ("parse" or
    /// "validation") and `error` are folded into the details
    /// payload so an auditor's grep can filter by either dimension.
    pub fn log_template_validation_failed(
        &self,
        template_path: &str,
        kind: &str,
        error: &str,
    ) -> Result<()> {
        self.log(
            AuditEventType::TemplateValidationFailed,
            format!("Template load failure: kind={kind} path={template_path} error={error}"),
        )
    }

    pub fn query_by_type(&self, event_type: &AuditEventType) -> Result<Vec<AuditEvent>> {
        self.store.query_by_type(event_type)
    }

    pub fn query_by_date_range(
        &self,
        from: &chrono::DateTime<chrono::Utc>,
        to: &chrono::DateTime<chrono::Utc>,
    ) -> Result<Vec<AuditEvent>> {
        self.store.query_by_date_range(from, to)
    }

    pub fn event_count(&self) -> Result<u64> {
        self.store.count()
    }

    /// Return the `limit` most recent audit rows, newest first.
    pub fn recent_events(&self, limit: u32, offset: u32) -> Result<Vec<AuditEvent>> {
        self.store.recent_events(limit, offset)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logger_records_events() {
        let logger = AuditLogger::new_in_memory().unwrap();
        logger.log_source_added("/home/user/docs").unwrap();
        logger.log_artifact_created("Q4 PRD").unwrap();
        logger.log_artifact_exported("Q4 PRD", "markdown").unwrap();
        logger.log_settings_changed("theme", "dark").unwrap();

        assert_eq!(logger.event_count().unwrap(), 4);

        let source_events = logger.query_by_type(&AuditEventType::SourceAdded).unwrap();
        assert_eq!(source_events.len(), 1);
    }

    /// pin each newly added helper to its
    /// `AuditEventType`. The matrix tests both the routing (helper →
    /// event-type) and the detail-string contract so a future
    /// refactor of the underlying format strings cannot silently
    /// regress an auditor's grep query.
    #[test]
    fn newly_added_helpers_route_to_correct_event_types() {
        let logger = AuditLogger::new_in_memory().unwrap();

        logger.log_source_reindexed("source-abc123").unwrap();
        logger
            .log_artifact_updated("11111111-2222-3333-4444-555555555555")
            .unwrap();
        logger
            .log_artifact_deleted("66666666-7777-8888-9999-aaaaaaaaaaaa")
            .unwrap();
        logger.log_model_started("/models/llama-3.gguf").unwrap();
        logger.log_model_stopped("user-requested").unwrap();

        assert_eq!(logger.event_count().unwrap(), 5);

        let reindexed = logger
            .query_by_type(&AuditEventType::SourceReindexed)
            .unwrap();
        assert_eq!(reindexed.len(), 1);
        assert!(reindexed[0].details.contains("source-abc123"));

        let updated = logger
            .query_by_type(&AuditEventType::ArtifactUpdated)
            .unwrap();
        assert_eq!(updated.len(), 1);
        assert!(updated[0]
            .details
            .contains("11111111-2222-3333-4444-555555555555"));

        let deleted = logger
            .query_by_type(&AuditEventType::ArtifactDeleted)
            .unwrap();
        assert_eq!(deleted.len(), 1);
        assert!(deleted[0]
            .details
            .contains("66666666-7777-8888-9999-aaaaaaaaaaaa"));

        let started = logger.query_by_type(&AuditEventType::ModelStarted).unwrap();
        assert_eq!(started.len(), 1);
        assert!(started[0].details.contains("/models/llama-3.gguf"));

        let stopped = logger.query_by_type(&AuditEventType::ModelStopped).unwrap();
        assert_eq!(stopped.len(), 1);
        assert!(stopped[0].details.contains("user-requested"));
    }

    /// `log_template_validation_failed` must
    /// route to the new `TemplateValidationFailed` event type and
    /// fold the file path, the failure kind, and the underlying
    /// error message into the details payload so an auditor's grep
    /// can filter by any of those three dimensions.
    #[test]
    fn template_validation_failure_helper_routes_to_correct_event_type() {
        let logger = AuditLogger::new_in_memory().unwrap();

        logger
            .log_template_validation_failed(
                "templates/documents/missing-sections.yaml",
                "validation",
                "template must have at least one section",
            )
            .unwrap();
        logger
            .log_template_validation_failed(
                "templates/slides/broken.yaml",
                "parse",
                "missing field `id` at line 1",
            )
            .unwrap();

        assert_eq!(logger.event_count().unwrap(), 2);

        let rows = logger
            .query_by_type(&AuditEventType::TemplateValidationFailed)
            .unwrap();
        assert_eq!(rows.len(), 2);

        // The validation-kind row.
        let validation = rows
            .iter()
            .find(|row| row.details.contains("missing-sections.yaml"))
            .expect("validation row should be present");
        assert!(validation.details.contains("kind="));
        assert!(validation.details.contains("validation"));
        assert!(validation
            .details
            .contains("template must have at least one section"));

        // The parse-kind row.
        let parse = rows
            .iter()
            .find(|row| row.details.contains("broken.yaml"))
            .expect("parse row should be present");
        assert!(parse.details.contains("parse"));
        assert!(parse.details.contains("missing field `id`"));
    }

    /// `log_kchat_file_event_received` must route to the new
    /// `KchatFileEventReceived` variant and surface the event name,
    /// channel id, optional file id, and the `triggered_reindex`
    /// flag in the details payload. Block B Task 1 introduces this
    /// helper so the Node-side `KchatEventForwarder` can audit
    /// every WS event it surfaces without leaking message bodies.
    ///
    /// The test exercises both boolean states of `triggered_reindex`
    /// to pin the audit-row text format. As of the second-pass Devin
    /// Review on PR #43, the Node side always passes `false` (the
    /// reserved-slot semantic — see the helper's doc comment). The
    /// `true` case below is preserved so the audit row format stays
    /// covered for the future auto-sync iteration.
    #[test]
    fn kchat_file_event_received_helper_routes_to_correct_event_type() {
        let logger = AuditLogger::new_in_memory().unwrap();

        // A `file_added` event with the reserved flag set to `true`.
        // Today no caller passes `true` here; the Rust API still
        // accepts it for the future auto-sync iteration and we pin
        // the row text format in both states.
        logger
            .log_kchat_file_event_received(
                "file_added",
                Some("channel-abc123"),
                Some("file-xyz789"),
                true,
            )
            .unwrap();

        // A `posted` event with no file id; the Node-side forwarder
        // never reaches this path (only `file_added` is audited),
        // but the helper accepts any event name so we pin the
        // format for non-file events too.
        logger
            .log_kchat_file_event_received("posted", Some("channel-def456"), None, false)
            .unwrap();

        // A `channel_created` event with no channel id in scope —
        // exercises the `None` path on the channel parameter so
        // both Option arms are pinned.
        logger
            .log_kchat_file_event_received("channel_created", None, None, false)
            .unwrap();

        assert_eq!(logger.event_count().unwrap(), 3);

        let rows = logger
            .query_by_type(&AuditEventType::KchatFileEventReceived)
            .unwrap();
        assert_eq!(rows.len(), 3);

        let file_added = rows
            .iter()
            .find(|row| row.details.contains("file=file-xyz789"))
            .expect("file_added row should be present");
        assert!(file_added.details.contains("event=file_added"));
        assert!(file_added.details.contains("channel=channel-abc123"));
        assert!(file_added.details.contains("triggered_reindex=true"));

        let posted = rows
            .iter()
            .find(|row| row.details.contains("event=posted"))
            .expect("posted row should be present");
        assert!(posted.details.contains("channel=channel-def456"));
        // Empty file id renders as `file=` per the
        // `unwrap_or("")` convention documented on the bridge.
        assert!(posted.details.contains("file="));
        assert!(posted.details.contains("triggered_reindex=false"));

        let channel_created = rows
            .iter()
            .find(|row| row.details.contains("event=channel_created"))
            .expect("channel_created row should be present");
        // Both Option arms collapse to empty strings.
        assert!(channel_created.details.contains("channel="));
        assert!(channel_created.details.contains("file="));
    }

    /// Block B Task 4 (Phase 11): pin the
    /// `log_kchat_source_cryptoshredded` helper's row shape so
    /// operator grep queries (`grep "chunks_dropped="`) and the
    /// renderer's audit-activity filter stay aligned. Two rows:
    /// one with non-zero counts (a real shred), one with
    /// zero counts (an idempotent re-shred or already-empty
    /// channel) so both number formats are covered.
    #[test]
    fn kchat_source_cryptoshredded_helper_routes_to_correct_event_type() {
        let logger = AuditLogger::new_in_memory().unwrap();

        logger
            .log_kchat_source_cryptoshredded(
                "channel-shred-001",
                "principal_missing_from_roster",
                42,
                7,
                true,
                None,
            )
            .unwrap();
        logger
            .log_kchat_source_cryptoshredded(
                "channel-shred-002",
                "channel_archived",
                0,
                0,
                true,
                None,
            )
            .unwrap();
        // Third row: real shred where the filesystem scrub failed
        // (e.g. `fs.rm` blocked by another process on Windows). Pins
        // the operator-grep contract for `fs_scrub_succeeded=false`.
        logger
            .log_kchat_source_cryptoshredded(
                "channel-shred-003",
                "channel_archived",
                17,
                3,
                false,
                Some("cacheDir(/tmp/k/c-003): EBUSY: resource busy"),
            )
            .unwrap();

        let rows = logger
            .query_by_type(&AuditEventType::KchatSourceCryptoshredded)
            .unwrap();
        assert_eq!(rows.len(), 3);

        let real = rows
            .iter()
            .find(|row| row.details.contains("channel=channel-shred-001"))
            .expect("real-shred row should be present");
        assert!(real
            .details
            .contains("reason=principal_missing_from_roster"));
        assert!(real.details.contains("chunks_dropped=42"));
        assert!(real.details.contains("files_dropped=7"));
        assert!(real.details.contains("fs_scrub_succeeded=true"));
        assert!(!real.details.contains("fs_scrub_error="));

        let idempotent = rows
            .iter()
            .find(|row| row.details.contains("channel=channel-shred-002"))
            .expect("idempotent-shred row should be present");
        assert!(idempotent.details.contains("reason=channel_archived"));
        assert!(idempotent.details.contains("chunks_dropped=0"));
        assert!(idempotent.details.contains("files_dropped=0"));
        assert!(idempotent.details.contains("fs_scrub_succeeded=true"));

        let fs_failed = rows
            .iter()
            .find(|row| row.details.contains("channel=channel-shred-003"))
            .expect("fs-failed-shred row should be present");
        assert!(fs_failed.details.contains("chunks_dropped=17"));
        assert!(fs_failed.details.contains("files_dropped=3"));
        assert!(fs_failed.details.contains("fs_scrub_succeeded=false"));
        assert!(fs_failed
            .details
            .contains("fs_scrub_error=cacheDir(/tmp/k/c-003)"));
        assert!(fs_failed.details.contains("EBUSY"));
    }
}
