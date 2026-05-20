use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Configuration for authenticating a connector.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthConfig {
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    pub auth_code: Option<String>,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub scopes: Vec<String>,
    pub token_expiry: Option<DateTime<Utc>>,
}

impl AuthConfig {
    pub fn new(client_id: String, client_secret: String, redirect_uri: String) -> Self {
        Self {
            client_id,
            client_secret,
            redirect_uri,
            auth_code: None,
            access_token: None,
            refresh_token: None,
            scopes: Vec::new(),
            token_expiry: None,
        }
    }

    pub fn with_scopes(mut self, scopes: Vec<String>) -> Self {
        self.scopes = scopes;
        self
    }

    pub fn with_auth_code(mut self, code: String) -> Self {
        self.auth_code = Some(code);
        self
    }

    pub fn is_token_expired(&self) -> bool {
        self.token_expiry.is_none_or(|expiry| Utc::now() >= expiry)
    }
}

/// Metadata for a remote file from a connector.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteFile {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub modified_time: DateTime<Utc>,
    pub created_time: Option<DateTime<Utc>>,
    pub parent_id: Option<String>,
    pub web_view_link: Option<String>,
    pub is_folder: bool,
    pub md5_checksum: Option<String>,
    pub permissions: Vec<FilePermission>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilePermission {
    pub role: String,
    pub permission_type: String,
    pub email: Option<String>,
}

/// Result of a sync operation from a connector.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub new_change_token: Option<String>,
    pub added: Vec<RemoteFile>,
    pub modified: Vec<RemoteFile>,
    pub removed: Vec<String>,
    pub has_more: bool,
}

impl SyncResult {
    pub fn empty() -> Self {
        Self {
            new_change_token: None,
            added: Vec::new(),
            modified: Vec::new(),
            removed: Vec::new(),
            has_more: false,
        }
    }

    pub fn total_changes(&self) -> usize {
        self.added.len() + self.modified.len() + self.removed.len()
    }
}

/// Status of a connector instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorStatus {
    Disconnected,
    Connecting,
    Connected,
    Syncing,
    Error,
}

impl std::fmt::Display for ConnectorStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disconnected => write!(f, "disconnected"),
            Self::Connecting => write!(f, "connecting"),
            Self::Connected => write!(f, "connected"),
            Self::Syncing => write!(f, "syncing"),
            Self::Error => write!(f, "error"),
        }
    }
}

/// Summary information about a connector for UI display.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorInfo {
    pub provider: String,
    pub status: ConnectorStatus,
    pub last_sync: Option<DateTime<Utc>>,
    pub file_count: u64,
    pub error_message: Option<String>,
    pub connected_at: Option<DateTime<Utc>>,
}

/// Stored token pair for a connector.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expiry: Option<DateTime<Utc>>,
    pub scopes: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_config_builder() {
        let config = AuthConfig::new(
            "client-id".into(),
            "client-secret".into(),
            "http://localhost:9876/callback".into(),
        )
        .with_scopes(vec!["https://www.googleapis.com/auth/drive.readonly".into()])
        .with_auth_code("code123".into());

        assert_eq!(config.client_id, "client-id");
        assert_eq!(config.scopes.len(), 1);
        assert_eq!(config.auth_code.as_deref(), Some("code123"));
        assert!(config.is_token_expired());
    }

    #[test]
    fn sync_result_empty() {
        let result = SyncResult::empty();
        assert_eq!(result.total_changes(), 0);
        assert!(!result.has_more);
    }

    #[test]
    fn connector_status_display() {
        assert_eq!(ConnectorStatus::Connected.to_string(), "connected");
        assert_eq!(ConnectorStatus::Syncing.to_string(), "syncing");
        assert_eq!(ConnectorStatus::Error.to_string(), "error");
    }

    #[test]
    fn remote_file_serialization() {
        let file = RemoteFile {
            id: "file-1".into(),
            name: "report.pdf".into(),
            mime_type: "application/pdf".into(),
            size_bytes: 1024,
            modified_time: Utc::now(),
            created_time: None,
            parent_id: Some("folder-1".into()),
            web_view_link: Some("https://drive.google.com/file/d/file-1/view".into()),
            is_folder: false,
            md5_checksum: Some("d41d8cd98f00b204e9800998ecf8427e".into()),
            permissions: vec![FilePermission {
                role: "reader".into(),
                permission_type: "user".into(),
                email: Some("user@example.com".into()),
            }],
        };
        let json = serde_json::to_string(&file).unwrap();
        let deserialized: RemoteFile = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "file-1");
        assert_eq!(deserialized.name, "report.pdf");
        assert_eq!(deserialized.permissions.len(), 1);
    }

    #[test]
    fn stored_tokens_serialization() {
        let tokens = StoredTokens {
            access_token: "ya29.abc".into(),
            refresh_token: Some("1//refresh".into()),
            expiry: Some(Utc::now()),
            scopes: vec!["drive.readonly".into()],
        };
        let json = serde_json::to_string(&tokens).unwrap();
        let deserialized: StoredTokens = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.access_token, "ya29.abc");
    }
}
