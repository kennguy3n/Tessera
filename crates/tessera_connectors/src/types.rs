//! Shared data types for connector auth, status and remote files.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Configuration for authenticating a connector.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthConfig {
    /// OAuth client identifier issued by the provider.
    pub client_id: String,
    /// OAuth client secret paired with `client_id`.
    pub client_secret: String,
    /// Redirect URI the provider calls back after authorization;
    /// must match the one registered with the provider.
    pub redirect_uri: String,
    /// One-time authorization code from the redirect, exchanged for
    /// tokens. Cleared once exchanged.
    pub auth_code: Option<String>,
    /// Current OAuth access token, if the flow has completed.
    pub access_token: Option<String>,
    /// Long-lived refresh token used to mint new access tokens.
    pub refresh_token: Option<String>,
    /// OAuth scopes requested/granted for this connection.
    pub scopes: Vec<String>,
    /// When `access_token` expires; `None` means unknown/never set
    /// and is treated as already expired.
    pub token_expiry: Option<DateTime<Utc>>,
}

impl AuthConfig {
    /// Builds a config with the OAuth client credentials and redirect
    /// URI; tokens, scopes, and expiry start empty.
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

    /// Builder setter for the requested OAuth scopes.
    pub fn with_scopes(mut self, scopes: Vec<String>) -> Self {
        self.scopes = scopes;
        self
    }

    /// Builder setter for the one-time authorization code.
    pub fn with_auth_code(mut self, code: String) -> Self {
        self.auth_code = Some(code);
        self
    }

    /// True if the access token is expired or its expiry is unknown
    /// (`token_expiry` is `None`), signalling a refresh is needed.
    pub fn is_token_expired(&self) -> bool {
        self.token_expiry.is_none_or(|expiry| Utc::now() >= expiry)
    }
}

/// Metadata for a remote file from a connector.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteFile {
    /// Provider-assigned file identifier (opaque, provider-scoped).
    pub id: String,
    /// Display name of the file as shown by the provider.
    pub name: String,
    /// MIME type reported by the provider.
    pub mime_type: String,
    /// File size in bytes (0 for folders or when unknown).
    pub size_bytes: u64,
    /// Last-modified timestamp reported by the provider.
    pub modified_time: DateTime<Utc>,
    /// Creation timestamp, when the provider exposes one.
    pub created_time: Option<DateTime<Utc>>,
    /// Id of the containing folder, if any (root items have none).
    pub parent_id: Option<String>,
    /// URL to open the file in the provider's web UI.
    pub web_view_link: Option<String>,
    /// Whether this entry is a folder rather than a file.
    pub is_folder: bool,
    /// MD5 content checksum, used to detect changes when available.
    pub md5_checksum: Option<String>,
    /// Access-control entries for the file.
    pub permissions: Vec<FilePermission>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// A single access-control entry on a [`RemoteFile`].
pub struct FilePermission {
    /// Role granted (e.g. `owner`, `writer`, `reader`).
    pub role: String,
    /// Grantee type (e.g. `user`, `group`, `domain`, `anyone`).
    pub permission_type: String,
    /// Grantee email address, when the type is a specific user.
    pub email: Option<String>,
}

/// Result of a sync operation from a connector.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    /// Opaque cursor to resume the next incremental sync from this
    /// point; `None` when the provider gave no new token.
    pub new_change_token: Option<String>,
    /// Files newly created since the last sync.
    pub added: Vec<RemoteFile>,
    /// Files whose content/metadata changed since the last sync.
    pub modified: Vec<RemoteFile>,
    /// Ids of files deleted since the last sync.
    pub removed: Vec<String>,
    /// Whether more changes remain to be fetched in another page.
    pub has_more: bool,
}

impl SyncResult {
    /// An empty result: no changes, no token, no more pages.
    pub fn empty() -> Self {
        Self {
            new_change_token: None,
            added: Vec::new(),
            modified: Vec::new(),
            removed: Vec::new(),
            has_more: false,
        }
    }

    /// Count of added + modified + removed entries in this result.
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
    /// No active connection; not authenticated.
    Disconnected,
    /// OAuth/handshake in progress.
    Connecting,
    /// Authenticated and idle, ready to sync.
    Connected,
    /// A sync is currently running.
    Syncing,
    /// The connector is in a failed state; see the recorded error.
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
    /// Provider key (e.g. `gdrive`, `notion`, `jira`).
    pub provider: String,
    /// Current connection status.
    pub status: ConnectorStatus,
    /// When the last successful sync completed, if ever.
    pub last_sync: Option<DateTime<Utc>>,
    /// Number of files currently indexed from this connector.
    pub file_count: u64,
    /// Human-readable error from the last failure, when in
    /// [`ConnectorStatus::Error`].
    pub error_message: Option<String>,
    /// When the connector was first connected.
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
    /// OAuth access token used to authorize API calls.
    pub access_token: String,
    /// Refresh token to mint new access tokens, if the provider
    /// issued one.
    pub refresh_token: Option<String>,
    /// When `access_token` expires, if known.
    pub expiry: Option<DateTime<Utc>>,
    /// OAuth scopes the provider granted with these tokens.
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
