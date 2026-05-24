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

    /// Phase 10 / Task 17: pin each newly added helper to its
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

    /// Phase 10 / Task 28: `log_template_validation_failed` must
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
}
