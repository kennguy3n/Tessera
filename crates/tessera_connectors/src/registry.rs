use std::collections::HashMap;

use crate::error::{ConnectorError, ConnectorResult};
use crate::gdrive::GoogleDriveConnector;
use crate::types::{ConnectorInfo, ConnectorStatus};

/// Manages multiple connector instances, keyed by provider name.
pub struct ConnectorRegistry {
    connectors: HashMap<String, ConnectorEntry>,
}

enum ConnectorEntry {
    GoogleDrive(GoogleDriveConnector),
}

impl ConnectorEntry {
    fn status(&self) -> ConnectorStatus {
        match self {
            Self::GoogleDrive(c) => c.status(),
        }
    }

    fn info(&self) -> ConnectorInfo {
        match self {
            Self::GoogleDrive(c) => ConnectorInfo {
                provider: c.provider_name().to_string(),
                status: c.status(),
                last_sync: c.last_sync_time(),
                file_count: c.file_count(),
                error_message: None,
                connected_at: None,
            },
        }
    }
}

impl ConnectorRegistry {
    pub fn new() -> Self {
        Self {
            connectors: HashMap::new(),
        }
    }

    pub fn register_google_drive(&mut self, connector: GoogleDriveConnector) {
        self.connectors.insert(
            connector.provider_name().to_string(),
            ConnectorEntry::GoogleDrive(connector),
        );
    }

    pub fn get_google_drive(&self) -> Option<&GoogleDriveConnector> {
        self.connectors.get("google_drive").map(|e| match e {
            ConnectorEntry::GoogleDrive(c) => c,
        })
    }

    pub fn get_google_drive_mut(&mut self) -> Option<&mut GoogleDriveConnector> {
        self.connectors.get_mut("google_drive").map(|e| match e {
            ConnectorEntry::GoogleDrive(c) => c,
        })
    }

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
        let connector = GoogleDriveConnector::new();
        reg.register_google_drive(connector);

        assert_eq!(reg.provider_count(), 1);
        assert!(reg.has_provider("google_drive"));
        assert!(!reg.is_connected("google_drive"));

        let info = reg.get_info("google_drive").unwrap();
        assert_eq!(info.provider, "google_drive");
        assert_eq!(info.status, ConnectorStatus::Disconnected);
        assert_eq!(info.file_count, 0);
    }

    #[test]
    fn remove_provider() {
        let mut reg = ConnectorRegistry::new();
        reg.register_google_drive(GoogleDriveConnector::new());
        assert!(reg.has_provider("google_drive"));

        assert!(reg.remove("google_drive"));
        assert!(!reg.has_provider("google_drive"));
        assert!(!reg.remove("google_drive"));
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
        reg.register_google_drive(GoogleDriveConnector::new());
        let providers = reg.list_providers();
        assert_eq!(providers.len(), 1);
        assert!(providers.contains(&"google_drive".to_string()));
    }

    #[test]
    fn get_google_drive_mut() {
        let mut reg = ConnectorRegistry::new();
        reg.register_google_drive(GoogleDriveConnector::new());
        let c = reg.get_google_drive_mut().unwrap();
        assert_eq!(c.provider_name(), "google_drive");
    }
}
