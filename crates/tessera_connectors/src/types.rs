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

    /// Apply this result's added/removed counts to a running `file_count`
    /// using the NET accounting model documented on `RemoteConnector::file_count`.
    ///
    /// Why centralised: all six connectors used to inline this formula,
    /// half with `if/else` branches and half with chained `saturating_*`,
    /// and at least two diverged into monotonic-add-only (Jira, Notion's
    /// incremental path) — which meant their file_count counters drifted
    /// upward indefinitely. Centralising the formula here:
    ///
    ///   1. Guarantees every connector has identical accounting.
    ///   2. Gives us one testable function (`apply_to_file_count_net_semantics`)
    ///      instead of six.
    ///   3. Makes a future contract change (e.g. count `modified` too) a
    ///      one-line edit, not a six-file edit.
    ///
    /// The saturating ops on `u64` are intentional — `added` and `removed`
    /// can each be billions in pathological cases (provider returning a
    /// huge delta after a long offline period), and a plain `+`/`-` would
    /// panic on overflow / underflow. The chained `saturating_add` then
    /// `saturating_sub` semantics:
    ///
    ///   - Net positive (added >= removed): grows by `added - removed`.
    ///   - Net negative (added < removed): shrinks by `removed - added`,
    ///     bottoming out at 0 (never underflows).
    ///
    /// **Saturation boundary edge-case (unreachable in practice).** At
    /// `current + added >= u64::MAX`, the chained form differs from a
    /// `net = added - removed` shortcut: chained gives `MAX - removed`
    /// (saturates, then subtracts), shortcut gives `MAX` (net is
    /// smaller, saturation never triggers). The chained form is the
    /// honest one — we observed `added` adds and `removed` removes,
    /// the bookkeeping reflects both — but it requires `current` to
    /// be within `removed` of `u64::MAX` to differ, which means the
    /// connector is tracking ~18 quintillion files. Not reachable.
    pub fn apply_to_file_count(&self, current: u64) -> u64 {
        let added = self.added.len() as u64;
        let removed = self.removed.len() as u64;
        current.saturating_add(added).saturating_sub(removed)
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
///
/// `scopes` holds the OAuth scopes granted by the provider — strings
/// that came back in the token response (or were requested in the
/// consent URL).  It is **not** a free-form bag for provider-specific
/// identifiers.  When a connector needs to round-trip a piece of
/// provider state alongside the tokens (e.g. Atlassian `cloud_id`,
/// Notion `workspace_id`), it uses [`StoredTokens::provider_metadata`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expiry: Option<DateTime<Utc>>,
    pub scopes: Vec<String>,
    /// Opaque provider-specific metadata that needs to be persisted
    /// alongside the tokens — for example the Atlassian
    /// `cloud_id`, the Notion `workspace_id`, or a Figma team id.
    /// `None` for connectors that don't need a per-installation handle.
    ///
    /// `#[serde(default)]` so existing on-disk token blobs written
    /// before this field existed continue to deserialize cleanly.
    #[serde(default)]
    pub provider_metadata: Option<String>,
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

    fn mk_remote(id: &str) -> RemoteFile {
        RemoteFile {
            id: id.into(),
            name: id.into(),
            mime_type: "text/plain".into(),
            size_bytes: 0,
            modified_time: Utc::now(),
            created_time: None,
            parent_id: None,
            web_view_link: None,
            is_folder: false,
            md5_checksum: None,
            permissions: vec![],
        }
    }

    /// Pin the NET semantics — adds bump up, removes bump down, modifies
    /// do nothing.
    #[test]
    fn apply_to_file_count_net_semantics_positive_delta() {
        let mut result = SyncResult::empty();
        result.added.push(mk_remote("a"));
        result.added.push(mk_remote("b"));
        result.added.push(mk_remote("c"));
        result.removed.push("d".into());
        // current = 5, +3 adds -1 remove -> 7
        assert_eq!(result.apply_to_file_count(5), 7);
    }

    #[test]
    fn apply_to_file_count_net_semantics_negative_delta_does_not_underflow() {
        let mut result = SyncResult::empty();
        result.added.push(mk_remote("a"));
        result.removed.push("b".into());
        result.removed.push("c".into());
        result.removed.push("d".into());
        // current = 1, +1 -3 -> 0 (saturating, not negative)
        assert_eq!(result.apply_to_file_count(1), 0);
    }

    #[test]
    fn apply_to_file_count_modified_does_not_change_count() {
        let mut result = SyncResult::empty();
        result.modified.push(mk_remote("a"));
        result.modified.push(mk_remote("b"));
        result.modified.push(mk_remote("c"));
        // No adds, no removes — modifications don't move the count.
        assert_eq!(result.apply_to_file_count(42), 42);
    }

    #[test]
    fn apply_to_file_count_handles_saturating_add_at_u64_max() {
        let mut result = SyncResult::empty();
        result.added.push(mk_remote("a"));
        // (u64::MAX, +1, -0) -> saturates at u64::MAX (no panic).
        assert_eq!(result.apply_to_file_count(u64::MAX), u64::MAX);
    }

    #[test]
    fn apply_to_file_count_empty_result_is_identity() {
        let result = SyncResult::empty();
        for cur in &[0u64, 1, 100, u64::MAX] {
            assert_eq!(result.apply_to_file_count(*cur), *cur);
        }
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
            provider_metadata: None,
        };
        let json = serde_json::to_string(&tokens).unwrap();
        let deserialized: StoredTokens = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.access_token, "ya29.abc");
        assert!(deserialized.provider_metadata.is_none());
    }

    #[test]
    fn stored_tokens_backward_compat_missing_provider_metadata() {
        // On-disk JSON written before `provider_metadata` existed must
        // continue to deserialize — `#[serde(default)]` on the new
        // field is what makes that safe.
        let legacy = r#"{
            "access_token": "AT",
            "refresh_token": "RT",
            "expiry": null,
            "scopes": ["read:foo"]
        }"#;
        let tokens: StoredTokens = serde_json::from_str(legacy).unwrap();
        assert_eq!(tokens.access_token, "AT");
        assert_eq!(tokens.scopes, vec!["read:foo".to_string()]);
        assert!(tokens.provider_metadata.is_none());
    }

    #[test]
    fn stored_tokens_provider_metadata_round_trips() {
        let tokens = StoredTokens {
            access_token: "AT".into(),
            refresh_token: None,
            expiry: None,
            scopes: vec![
                "read:confluence-content.all".into(),
                "offline_access".into(),
            ],
            provider_metadata: Some("cloud-abc-123".into()),
        };
        let json = serde_json::to_string(&tokens).unwrap();
        let deserialized: StoredTokens = serde_json::from_str(&json).unwrap();
        assert_eq!(
            deserialized.provider_metadata.as_deref(),
            Some("cloud-abc-123")
        );
        assert_eq!(deserialized.scopes.len(), 2);
    }
}
