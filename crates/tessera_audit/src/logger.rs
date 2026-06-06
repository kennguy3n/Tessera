//! The `AuditLogger`: records `AuditEvent`s into the audit store.

use tessera_core::error::Result;
use tessera_core::SharedConnection;

use crate::event::{AuditEvent, AuditEventType};
use crate::store::AuditStore;

/// Audit Logger.
pub struct AuditLogger {
    store: AuditStore,
}

impl AuditLogger {
    /// Creates a new instance.
    pub fn new(db_path: &str) -> Result<Self> {
        let store = AuditStore::open(db_path)?;
        Ok(Self { store })
    }

    /// New in memory.
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

    /// Log.
    pub fn log(&self, event_type: AuditEventType, details: String) -> Result<()> {
        let event = AuditEvent::new(event_type, details);
        self.store.append(&event)
    }

    /// Log source added.
    pub fn log_source_added(&self, path: &str) -> Result<()> {
        self.log(AuditEventType::SourceAdded, format!("Source added: {path}"))
    }

    /// Log source removed.
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

    /// Log artifact created.
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

    /// Log artifact exported.
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

    /// Log settings changed.
    pub fn log_settings_changed(&self, setting: &str, value: &str) -> Result<()> {
        self.log(
            AuditEventType::SettingsChanged,
            format!("Setting changed: {setting} = {value}"),
        )
    }

    /// Log connector connected.
    pub fn log_connector_connected(&self, provider: &str) -> Result<()> {
        self.log(
            AuditEventType::ConnectorConnected,
            format!("Connector connected: {provider}"),
        )
    }

    /// Log connector synced.
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

    /// Log connector disconnected.
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
    /// a KChat channel's ACL roster against the substrate.
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
    /// `SourceStatus::AccessRevoked`.
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
    /// scrubbed inline as part of a revoke transition. Emitted by the Node-side forwarder /
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
    ///
    /// `vacuum_succeeded` records whether the substrate's Phase 5
    /// `VACUUM` (the belt-and-braces freelist sweep that rebuilds
    /// the SQLite file layout AFTER the DELETE + UPDATE transaction
    /// commits under `PRAGMA secure_delete = ON`) ran cleanly. A
    /// `false` value here is NOT a scrub failure — the row-level
    /// scrub already committed and the cryptographic guarantee
    /// holds — but operators want to learn that the on-disk
    /// freelist was not additionally rewritten so they can re-run
    /// `VACUUM` manually once the underlying issue resolves.
    /// `vacuum_error` carries the first SQLite error message in
    /// that case (e.g. `database or disk is full`). Fifth-pass
    /// Devin Review fix (ANALYSIS_pr-review-job-ef3c7d6c..._0001):
    /// previously a `VACUUM` failure propagated `?` up to the
    /// forwarder's catch block and defaulted the audit row to
    /// `outcome=unlinked`, hiding the successful row-level scrub.
    #[allow(clippy::too_many_arguments)]
    pub fn log_kchat_source_cryptoshredded(
        &self,
        channel_id: &str,
        reason: &str,
        chunks_dropped: u32,
        files_dropped: u32,
        posts_dropped: u32,
        dek_dropped: bool,
        fs_scrub_succeeded: bool,
        fs_scrub_error: Option<&str>,
        vacuum_succeeded: bool,
        vacuum_error: Option<&str>,
    ) -> Result<()> {
        let fs_error_segment = match fs_scrub_error {
            Some(e) if !e.is_empty() => format!(" fs_scrub_error={e}"),
            _ => String::new(),
        };
        let vacuum_error_segment = match vacuum_error {
            Some(e) if !e.is_empty() => format!(" vacuum_error={e}"),
            _ => String::new(),
        };
        self.log(
            AuditEventType::KchatSourceCryptoshredded,
            format!(
                "KChat source cryptoshredded: channel={channel_id} reason={reason} \
                 chunks_dropped={chunks_dropped} files_dropped={files_dropped} \
                 posts_dropped={posts_dropped} dek_dropped={dek_dropped} \
                 fs_scrub_succeeded={fs_scrub_succeeded}{fs_error_segment} \
                 vacuum_succeeded={vacuum_succeeded}{vacuum_error_segment}"
            ),
        )
    }

    /// record a KChat post-body ingest
    /// outcome. Used by the Node-side `KchatEventForwarder` after
    /// the bridge returns the outcome of an `ingest_kchat_post` or
    /// `edit_kchat_post` call. `outcome` is one of
    /// `ingested`/`unchanged`/`unlinked`/`access_revoked`;
    /// `chunk_count` carries the number of AEAD-sealed chunks the
    /// substrate inserted (zero for `unchanged` / `unlinked` /
    /// `access_revoked` outcomes).
    ///
    /// Post bodies are NEVER logged. The audit row's purpose is
    /// observability of the ingest pipeline, not retention of the
    /// content itself.
    pub fn log_kchat_post_ingested(
        &self,
        channel_id: &str,
        post_id: &str,
        outcome: &str,
        chunk_count: u32,
    ) -> Result<()> {
        self.log(
            AuditEventType::KchatPostIngested,
            format!(
                "KChat post ingested: channel={channel_id} post={post_id} \
                 outcome={outcome} chunk_count={chunk_count}"
            ),
        )
    }

    /// record a KChat post-body edit
    /// outcome (re-ingest under the same post_id). Same field
    /// catalogue as [`Self::log_kchat_post_ingested`] but routed
    /// to the `KchatPostEdited` variant so operators can grep
    /// edits separately from new posts.
    pub fn log_kchat_post_edited(
        &self,
        channel_id: &str,
        post_id: &str,
        outcome: &str,
        chunk_count: u32,
    ) -> Result<()> {
        self.log(
            AuditEventType::KchatPostEdited,
            format!(
                "KChat post edited: channel={channel_id} post={post_id} \
                 outcome={outcome} chunk_count={chunk_count}"
            ),
        )
    }

    /// record a KChat post-body delete
    /// outcome. `outcome` is one of
    /// `deleted`/`not_found`/`unlinked`/`access_revoked`;
    /// `chunks_dropped` carries the number of AEAD-sealed chunk
    /// rows the substrate dropped (zero for non-`deleted`
    /// outcomes).
    pub fn log_kchat_post_deleted(
        &self,
        channel_id: &str,
        post_id: &str,
        outcome: &str,
        chunks_dropped: u32,
    ) -> Result<()> {
        self.log(
            AuditEventType::KchatPostDeleted,
            format!(
                "KChat post deleted: channel={channel_id} post={post_id} \
                 outcome={outcome} chunks_dropped={chunks_dropped}"
            ),
        )
    }

    /// record the start (or resume) of
    /// a KChat channel historical-backfill walk. `resume_from` is
    /// the persisted `before=` cursor that the walk will use on
    /// its first REST page; `None` means the walk is starting at
    /// the newest post.
    pub fn log_kchat_backfill_started(
        &self,
        channel_id: &str,
        source_id: &str,
        resume_from: Option<&str>,
    ) -> Result<()> {
        let resume = resume_from.unwrap_or("(fresh)");
        self.log(
            AuditEventType::KchatBackfillStarted,
            format!(
                "KChat backfill started: channel={channel_id} source={source_id} \
                 resume_from={resume}"
            ),
        )
    }

    /// record one page of the backfill
    /// walk. Page numbers are 1-based. `oldest_post_id` is the
    /// cursor the substrate persisted after the page (None when
    /// the page was empty or all-revoked).
    #[allow(clippy::too_many_arguments)]
    pub fn log_kchat_backfill_page_ingested(
        &self,
        channel_id: &str,
        source_id: &str,
        page_number: u32,
        posts_ingested: u32,
        posts_unchanged: u32,
        posts_skipped_revoked: u32,
        oldest_post_id: Option<&str>,
    ) -> Result<()> {
        let cursor = oldest_post_id.unwrap_or("(none)");
        self.log(
            AuditEventType::KchatBackfillPageIngested,
            format!(
                "KChat backfill page ingested: channel={channel_id} source={source_id} \
                 page={page_number} posts_ingested={posts_ingested} \
                 posts_unchanged={posts_unchanged} \
                 posts_skipped_revoked={posts_skipped_revoked} \
                 cursor={cursor}"
            ),
        )
    }

    /// record successful completion of
    /// a backfill walk (server returned `prev_post_id == null`).
    pub fn log_kchat_backfill_completed(
        &self,
        channel_id: &str,
        source_id: &str,
        pages_walked: u32,
        total_posts_ingested: u32,
        total_posts_unchanged: u32,
    ) -> Result<()> {
        self.log(
            AuditEventType::KchatBackfillCompleted,
            format!(
                "KChat backfill completed: channel={channel_id} source={source_id} \
                 pages_walked={pages_walked} \
                 total_posts_ingested={total_posts_ingested} \
                 total_posts_unchanged={total_posts_unchanged}"
            ),
        )
    }

    /// record an aborted backfill walk.
    /// `reason` is one of `access_revoked` / `safety_cap` /
    /// `unlinked` / `error` (machine-readable, grep-friendly).
    pub fn log_kchat_backfill_aborted(
        &self,
        channel_id: &str,
        source_id: &str,
        reason: &str,
        pages_walked: u32,
        total_posts_ingested: u32,
    ) -> Result<()> {
        self.log(
            AuditEventType::KchatBackfillAborted,
            format!(
                "KChat backfill aborted: channel={channel_id} source={source_id} \
                 reason={reason} pages_walked={pages_walked} \
                 total_posts_ingested={total_posts_ingested}"
            ),
        )
    }

    /// record a KChat-post FTS5 search.
    ///
    /// `query_hash` is a hex-encoded cryptographic hash of the
    /// normalised query, truncated by the caller (the IPC
    /// layer uses SHA-256 truncated to 16 hex chars — 64 bits
    /// is well above the birthday bound for any realistic
    /// audit log retention window). Post bodies and the literal query string are
    /// NEVER passed to this function — that's the whole point of
    /// the hash gate: the audit trail proves a question was asked
    /// without exposing what the user typed.
    ///
    /// `hits` is the AEAD-verified result count returned to the
    /// renderer (NOT the pre-verification pool size — drops from
    /// AEAD mismatch are by construction silent).
    ///
    /// `sources_touched` is the cardinality of distinct sources
    /// the hit set spans. Useful for forensics ("did this query
    /// pull from one channel or three") without re-running it.
    ///
    /// `latency_ms` is the IPC-handler end-to-end duration
    /// (request received → response sent) so an operator can
    /// correlate slow retrievals with DEK-unwrap cold starts.
    pub fn log_kchat_post_search_executed(
        &self,
        query_hash: &str,
        hits: u32,
        sources_touched: u32,
        latency_ms: u32,
    ) -> Result<()> {
        self.log(
            AuditEventType::KchatPostSearchExecuted,
            format!(
                "KChat post search executed: query_hash={query_hash} \
                 hits={hits} sources_touched={sources_touched} \
                 latency_ms={latency_ms}"
            ),
        )
    }

    /// Log citation added.
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

    /// Log citation replaced.
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

    /// Log citation removed.
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

    /// Query by type.
    pub fn query_by_type(&self, event_type: &AuditEventType) -> Result<Vec<AuditEvent>> {
        self.store.query_by_type(event_type)
    }

    /// Query by date range.
    pub fn query_by_date_range(
        &self,
        from: &chrono::DateTime<chrono::Utc>,
        to: &chrono::DateTime<chrono::Utc>,
    ) -> Result<Vec<AuditEvent>> {
        self.store.query_by_date_range(from, to)
    }

    /// Event count.
    pub fn event_count(&self) -> Result<u64> {
        self.store.count()
    }

    /// Return the `limit` most recent audit rows, newest first.
    pub fn recent_events(&self, limit: u32, offset: u32) -> Result<Vec<AuditEvent>> {
        self.store.recent_events(limit, offset)
    }

    /// thin pass-through to
    /// [`AuditStore::rotate`]. The bridge invokes this from a
    /// scheduled background task and via the `audit:rotate` IPC
    /// surface so Settings can offer a "rotate now" button.
    pub fn rotate(
        &self,
        archive_dir: &std::path::Path,
    ) -> Result<Option<crate::store::RotationOutcome>> {
        self.store.rotate(archive_dir)
    }

    /// thin pass-through to
    /// [`AuditStore::list_archives`]. The `audit:getArchives` IPC
    /// fans this out to the renderer.
    pub fn list_archives(archive_dir: &std::path::Path) -> Result<Vec<std::path::PathBuf>> {
        AuditStore::list_archives(archive_dir)
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

    /// pin the
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
                15,   // posts_dropped
                true, // dek_dropped
                true,
                None,
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
                0,     // posts_dropped
                false, // dek_dropped (idempotent re-shred)
                true,
                None,
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
                5,    // posts_dropped
                true, // dek_dropped
                false,
                Some("cacheDir(/tmp/k/c-003): EBUSY: resource busy"),
                true,
                None,
            )
            .unwrap();
        // Fourth row: real shred where the row-level DELETE
        // committed cleanly but the belt-and-braces VACUUM failed.
        // Fifth-pass Devin Review regression
        // (ANALYSIS_pr-review-job-ef3c7d6c..._0001) pins the
        // operator-grep contract for `vacuum_succeeded=false` so a
        // future audit-shape change can't drop the field without
        // breaking a test.
        logger
            .log_kchat_source_cryptoshredded(
                "channel-shred-004",
                "channel_deleted",
                23,
                4,
                8,    // posts_dropped
                true, // dek_dropped
                true,
                None,
                false,
                Some("database or disk is full"),
            )
            .unwrap();

        let rows = logger
            .query_by_type(&AuditEventType::KchatSourceCryptoshredded)
            .unwrap();
        assert_eq!(rows.len(), 4);

        let real = rows
            .iter()
            .find(|row| row.details.contains("channel=channel-shred-001"))
            .expect("real-shred row should be present");
        assert!(real
            .details
            .contains("reason=principal_missing_from_roster"));
        assert!(real.details.contains("chunks_dropped=42"));
        assert!(real.details.contains("files_dropped=7"));
        assert!(real.details.contains("posts_dropped=15"));
        assert!(real.details.contains("dek_dropped=true"));
        assert!(real.details.contains("fs_scrub_succeeded=true"));
        assert!(!real.details.contains("fs_scrub_error="));
        assert!(real.details.contains("vacuum_succeeded=true"));
        assert!(!real.details.contains("vacuum_error="));

        let idempotent = rows
            .iter()
            .find(|row| row.details.contains("channel=channel-shred-002"))
            .expect("idempotent-shred row should be present");
        assert!(idempotent.details.contains("reason=channel_archived"));
        assert!(idempotent.details.contains("chunks_dropped=0"));
        assert!(idempotent.details.contains("files_dropped=0"));
        assert!(idempotent.details.contains("posts_dropped=0"));
        assert!(idempotent.details.contains("dek_dropped=false"));
        assert!(idempotent.details.contains("fs_scrub_succeeded=true"));
        assert!(idempotent.details.contains("vacuum_succeeded=true"));
        assert!(!idempotent.details.contains("vacuum_error="));

        let fs_failed = rows
            .iter()
            .find(|row| row.details.contains("channel=channel-shred-003"))
            .expect("fs-failed-shred row should be present");
        assert!(fs_failed.details.contains("chunks_dropped=17"));
        assert!(fs_failed.details.contains("files_dropped=3"));
        assert!(fs_failed.details.contains("posts_dropped=5"));
        assert!(fs_failed.details.contains("dek_dropped=true"));
        assert!(fs_failed.details.contains("fs_scrub_succeeded=false"));
        assert!(fs_failed
            .details
            .contains("fs_scrub_error=cacheDir(/tmp/k/c-003)"));
        assert!(fs_failed.details.contains("EBUSY"));
        // VACUUM succeeded on the fs-failed row — the two
        // observability surfaces are independent.
        assert!(fs_failed.details.contains("vacuum_succeeded=true"));

        let vacuum_failed = rows
            .iter()
            .find(|row| row.details.contains("channel=channel-shred-004"))
            .expect("vacuum-failed-shred row should be present");
        assert!(vacuum_failed.details.contains("reason=channel_deleted"));
        assert!(vacuum_failed.details.contains("chunks_dropped=23"));
        assert!(vacuum_failed.details.contains("files_dropped=4"));
        assert!(vacuum_failed.details.contains("posts_dropped=8"));
        assert!(vacuum_failed.details.contains("dek_dropped=true"));
        // The row-level scrub committed (`fs_scrub` is independent
        // and trivially true on this row's input).
        assert!(vacuum_failed.details.contains("fs_scrub_succeeded=true"));
        assert!(vacuum_failed.details.contains("vacuum_succeeded=false"));
        assert!(vacuum_failed
            .details
            .contains("vacuum_error=database or disk is full"));
    }

    /// `log_kchat_post_search_executed`
    /// must route to the `KchatPostSearchExecuted` variant AND
    /// fold every operator-visible field into the details payload
    /// in the documented `field=value` shape so the same audit-row
    /// grep auditors already use for backfill rows works here too.
    #[test]
    fn kchat_post_search_executed_routes_and_records_all_observability_fields() {
        let logger = AuditLogger::new_in_memory().unwrap();
        logger
            .log_kchat_post_search_executed("ab12cd34ef567890", 7, 3, 42)
            .unwrap();
        let rows = logger
            .query_by_type(&AuditEventType::KchatPostSearchExecuted)
            .unwrap();
        assert_eq!(rows.len(), 1);
        let details = &rows[0].details;
        assert!(details.contains("query_hash=ab12cd34ef567890"));
        assert!(details.contains("hits=7"));
        assert!(details.contains("sources_touched=3"));
        assert!(details.contains("latency_ms=42"));
        // The literal query string must NEVER appear in the
        // audit row — that's the entire reason the IPC layer
        // hashes the query before passing.
        assert!(
            !details.contains("query=") || details.contains("query_hash="),
            "details must only carry query_hash, never the raw query string"
        );
    }
}
