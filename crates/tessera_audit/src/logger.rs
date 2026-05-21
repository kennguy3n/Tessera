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

    pub fn log_artifact_created(&self, title: &str) -> Result<()> {
        self.log(
            AuditEventType::ArtifactCreated,
            format!("Artifact created: {title}"),
        )
    }

    pub fn log_artifact_exported(&self, title: &str, format: &str) -> Result<()> {
        self.log(
            AuditEventType::ArtifactExported,
            format!("Artifact exported: {title} as {format}"),
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
}
