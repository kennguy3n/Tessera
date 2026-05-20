use std::collections::HashMap;

use crate::confluence::ConfluenceConnector;
use crate::error::{ConnectorError, ConnectorResult};
use crate::figma::FigmaConnector;
use crate::gdrive::GoogleDriveConnector;
use crate::jira::JiraConnector;
use crate::notion::NotionConnector;
use crate::onedrive::OneDriveConnector;
use crate::types::{ConnectorInfo, ConnectorStatus};

/// Manages multiple connector instances, keyed by provider name.
///
/// Each connector type lives in its own variant of [`ConnectorEntry`]
/// because their public surfaces differ (e.g. Jira knows about a
/// `cloud_id`, Figma knows about a `team_id`). The registry stays
/// strongly typed by exposing per-provider accessors instead of a
/// `dyn Connector` trait — this matches the gdrive precedent and lets
/// callers reach for provider-specific affordances without runtime
/// downcasting.
pub struct ConnectorRegistry {
    connectors: HashMap<String, ConnectorEntry>,
}

enum ConnectorEntry {
    GoogleDrive(GoogleDriveConnector),
    OneDrive(OneDriveConnector),
    Notion(NotionConnector),
    Jira(JiraConnector),
    Confluence(ConfluenceConnector),
    Figma(FigmaConnector),
}

impl ConnectorEntry {
    fn status(&self) -> ConnectorStatus {
        match self {
            Self::GoogleDrive(c) => c.status(),
            Self::OneDrive(c) => c.status(),
            Self::Notion(c) => c.status(),
            Self::Jira(c) => c.status(),
            Self::Confluence(c) => c.status(),
            Self::Figma(c) => c.status(),
        }
    }

    fn info(&self) -> ConnectorInfo {
        let (provider, last_sync, file_count) = match self {
            Self::GoogleDrive(c) => (
                c.provider_name().to_string(),
                c.last_sync_time(),
                c.file_count(),
            ),
            Self::OneDrive(c) => (
                c.provider_name().to_string(),
                c.last_sync_time(),
                c.file_count(),
            ),
            Self::Notion(c) => (
                c.provider_name().to_string(),
                c.last_sync_time(),
                c.file_count(),
            ),
            Self::Jira(c) => (
                c.provider_name().to_string(),
                c.last_sync_time(),
                c.file_count(),
            ),
            Self::Confluence(c) => (
                c.provider_name().to_string(),
                c.last_sync_time(),
                c.file_count(),
            ),
            Self::Figma(c) => (
                c.provider_name().to_string(),
                c.last_sync_time(),
                c.file_count(),
            ),
        };
        ConnectorInfo {
            provider,
            status: self.status(),
            last_sync,
            file_count,
            error_message: None,
            connected_at: None,
        }
    }
}

impl ConnectorRegistry {
    pub fn new() -> Self {
        Self {
            connectors: HashMap::new(),
        }
    }

    // --- Google Drive --------------------------------------------------------

    pub fn register_google_drive(&mut self, connector: GoogleDriveConnector) {
        self.connectors.insert(
            connector.provider_name().to_string(),
            ConnectorEntry::GoogleDrive(connector),
        );
    }

    pub fn get_google_drive(&self) -> Option<&GoogleDriveConnector> {
        self.connectors.get("google_drive").map(|e| match e {
            ConnectorEntry::GoogleDrive(c) => c,
            _ => unreachable!("google_drive key always maps to GoogleDrive variant"),
        })
    }

    pub fn get_google_drive_mut(&mut self) -> Option<&mut GoogleDriveConnector> {
        self.connectors.get_mut("google_drive").map(|e| match e {
            ConnectorEntry::GoogleDrive(c) => c,
            _ => unreachable!("google_drive key always maps to GoogleDrive variant"),
        })
    }

    // --- OneDrive ------------------------------------------------------------

    pub fn register_onedrive(&mut self, connector: OneDriveConnector) {
        self.connectors.insert(
            connector.provider_name().to_string(),
            ConnectorEntry::OneDrive(connector),
        );
    }

    pub fn get_onedrive(&self) -> Option<&OneDriveConnector> {
        self.connectors.get("onedrive").map(|e| match e {
            ConnectorEntry::OneDrive(c) => c,
            _ => unreachable!("onedrive key always maps to OneDrive variant"),
        })
    }

    pub fn get_onedrive_mut(&mut self) -> Option<&mut OneDriveConnector> {
        self.connectors.get_mut("onedrive").map(|e| match e {
            ConnectorEntry::OneDrive(c) => c,
            _ => unreachable!("onedrive key always maps to OneDrive variant"),
        })
    }

    // --- Notion --------------------------------------------------------------

    pub fn register_notion(&mut self, connector: NotionConnector) {
        self.connectors.insert(
            connector.provider_name().to_string(),
            ConnectorEntry::Notion(connector),
        );
    }

    pub fn get_notion(&self) -> Option<&NotionConnector> {
        self.connectors.get("notion").map(|e| match e {
            ConnectorEntry::Notion(c) => c,
            _ => unreachable!("notion key always maps to Notion variant"),
        })
    }

    pub fn get_notion_mut(&mut self) -> Option<&mut NotionConnector> {
        self.connectors.get_mut("notion").map(|e| match e {
            ConnectorEntry::Notion(c) => c,
            _ => unreachable!("notion key always maps to Notion variant"),
        })
    }

    // --- Jira ----------------------------------------------------------------

    pub fn register_jira(&mut self, connector: JiraConnector) {
        self.connectors.insert(
            connector.provider_name().to_string(),
            ConnectorEntry::Jira(connector),
        );
    }

    pub fn get_jira(&self) -> Option<&JiraConnector> {
        self.connectors.get("jira").map(|e| match e {
            ConnectorEntry::Jira(c) => c,
            _ => unreachable!("jira key always maps to Jira variant"),
        })
    }

    pub fn get_jira_mut(&mut self) -> Option<&mut JiraConnector> {
        self.connectors.get_mut("jira").map(|e| match e {
            ConnectorEntry::Jira(c) => c,
            _ => unreachable!("jira key always maps to Jira variant"),
        })
    }

    // --- Confluence ----------------------------------------------------------

    pub fn register_confluence(&mut self, connector: ConfluenceConnector) {
        self.connectors.insert(
            connector.provider_name().to_string(),
            ConnectorEntry::Confluence(connector),
        );
    }

    pub fn get_confluence(&self) -> Option<&ConfluenceConnector> {
        self.connectors.get("confluence").map(|e| match e {
            ConnectorEntry::Confluence(c) => c,
            _ => unreachable!("confluence key always maps to Confluence variant"),
        })
    }

    pub fn get_confluence_mut(&mut self) -> Option<&mut ConfluenceConnector> {
        self.connectors.get_mut("confluence").map(|e| match e {
            ConnectorEntry::Confluence(c) => c,
            _ => unreachable!("confluence key always maps to Confluence variant"),
        })
    }

    // --- Figma ---------------------------------------------------------------

    pub fn register_figma(&mut self, connector: FigmaConnector) {
        self.connectors.insert(
            connector.provider_name().to_string(),
            ConnectorEntry::Figma(connector),
        );
    }

    pub fn get_figma(&self) -> Option<&FigmaConnector> {
        self.connectors.get("figma").map(|e| match e {
            ConnectorEntry::Figma(c) => c,
            _ => unreachable!("figma key always maps to Figma variant"),
        })
    }

    pub fn get_figma_mut(&mut self) -> Option<&mut FigmaConnector> {
        self.connectors.get_mut("figma").map(|e| match e {
            ConnectorEntry::Figma(c) => c,
            _ => unreachable!("figma key always maps to Figma variant"),
        })
    }

    // --- Generic --------------------------------------------------------------

    pub fn remove(&mut self, provider: &str) -> bool {
        self.connectors.remove(provider).is_some()
    }

    pub fn is_connected(&self, provider: &str) -> bool {
        self.connectors
            .get(provider)
            .is_some_and(|e| e.status() == ConnectorStatus::Connected)
    }

    pub fn list_providers(&self) -> Vec<String> {
        self.connectors.keys().cloned().collect()
    }

    pub fn list_info(&self) -> Vec<ConnectorInfo> {
        self.connectors.values().map(ConnectorEntry::info).collect()
    }

    pub fn get_info(&self, provider: &str) -> ConnectorResult<ConnectorInfo> {
        self.connectors
            .get(provider)
            .map(ConnectorEntry::info)
            .ok_or_else(|| {
                ConnectorError::InvalidConfig(format!("No connector registered for {provider}"))
            })
    }

    pub fn has_provider(&self, provider: &str) -> bool {
        self.connectors.contains_key(provider)
    }

    pub fn provider_count(&self) -> usize {
        self.connectors.len()
    }

    /// Names of every provider Tessera currently knows how to talk to.
    /// Used by the UI to render the "available connectors" picker
    /// without needing each provider to be already registered.
    pub fn available_providers() -> Vec<&'static str> {
        vec![
            "google_drive",
            "onedrive",
            "notion",
            "jira",
            "confluence",
            "figma",
        ]
    }
}

impl Default for ConnectorRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_starts_empty() {
        let reg = ConnectorRegistry::new();
        assert_eq!(reg.provider_count(), 0);
        assert!(reg.list_providers().is_empty());
        assert!(reg.list_info().is_empty());
    }

    #[test]
    fn register_and_retrieve_google_drive() {
        let mut reg = ConnectorRegistry::new();
        reg.register_google_drive(GoogleDriveConnector::new());
        assert_eq!(reg.provider_count(), 1);
        assert!(reg.has_provider("google_drive"));
        let info = reg.get_info("google_drive").unwrap();
        assert_eq!(info.provider, "google_drive");
        assert_eq!(info.status, ConnectorStatus::Disconnected);
    }

    #[test]
    fn register_all_six_providers() {
        let mut reg = ConnectorRegistry::new();
        reg.register_google_drive(GoogleDriveConnector::new());
        reg.register_onedrive(OneDriveConnector::new());
        reg.register_notion(NotionConnector::new());
        reg.register_jira(JiraConnector::new());
        reg.register_confluence(ConfluenceConnector::new());
        reg.register_figma(FigmaConnector::new());

        assert_eq!(reg.provider_count(), 6);
        for p in ConnectorRegistry::available_providers() {
            assert!(reg.has_provider(p), "missing {p}");
            assert!(!reg.is_connected(p));
            let info = reg.get_info(p).unwrap();
            assert_eq!(info.provider, p);
        }
    }

    #[test]
    fn remove_provider() {
        let mut reg = ConnectorRegistry::new();
        reg.register_notion(NotionConnector::new());
        assert!(reg.has_provider("notion"));
        assert!(reg.remove("notion"));
        assert!(!reg.has_provider("notion"));
        assert!(!reg.remove("notion"));
    }

    #[test]
    fn get_info_unknown_provider() {
        let reg = ConnectorRegistry::new();
        let result = reg.get_info("nonexistent");
        assert!(result.is_err());
    }

    #[test]
    fn list_providers_returns_registered() {
        let mut reg = ConnectorRegistry::new();
        reg.register_jira(JiraConnector::new());
        reg.register_figma(FigmaConnector::new());
        let providers = reg.list_providers();
        assert_eq!(providers.len(), 2);
        assert!(providers.iter().any(|p| p == "jira"));
        assert!(providers.iter().any(|p| p == "figma"));
    }

    #[test]
    fn get_typed_accessors_return_correct_variant() {
        let mut reg = ConnectorRegistry::new();
        reg.register_onedrive(OneDriveConnector::new());
        assert!(reg.get_onedrive().is_some());
        // After mut access we should still be able to read back the status.
        let connector = reg.get_onedrive_mut().expect("onedrive present");
        assert_eq!(connector.status(), ConnectorStatus::Disconnected);
    }

    #[test]
    fn available_providers_lists_all_six() {
        let providers = ConnectorRegistry::available_providers();
        assert_eq!(providers.len(), 6);
        for p in [
            "google_drive",
            "onedrive",
            "notion",
            "jira",
            "confluence",
            "figma",
        ] {
            assert!(providers.contains(&p), "missing {p}");
        }
    }
}
