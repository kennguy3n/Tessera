use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::Deserialize;

use crate::error::{ConnectorError, ConnectorResult};
use crate::types::{
    AuthConfig, ConnectorStatus, FilePermission, RemoteFile, StoredTokens, SyncResult,
};

const DEFAULT_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const DEFAULT_REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_DRIVE_FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";
const DEFAULT_DRIVE_CHANGES_URL: &str = "https://www.googleapis.com/drive/v3/changes";
const DEFAULT_START_PAGE_TOKEN_URL: &str =
    "https://www.googleapis.com/drive/v3/changes/startPageToken";

const FILE_FIELDS: &str =
    "id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink,md5Checksum,permissions(role,type,emailAddress)";

pub struct GoogleDriveConnector {
    client: Client,
    status: ConnectorStatus,
    access_token: Option<String>,
    refresh_token: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    token_expiry: Option<DateTime<Utc>>,
    last_sync: Option<DateTime<Utc>>,
    file_count: u64,
    token_url: String,
    revoke_url: String,
    files_url: String,
    changes_url: String,
    start_page_token_url: String,
}

impl GoogleDriveConnector {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            status: ConnectorStatus::Disconnected,
            access_token: None,
            refresh_token: None,
            client_id: None,
            client_secret: None,
            token_expiry: None,
            last_sync: None,
            file_count: 0,
            token_url: DEFAULT_TOKEN_URL.to_string(),
            revoke_url: DEFAULT_REVOKE_URL.to_string(),
            files_url: DEFAULT_DRIVE_FILES_URL.to_string(),
            changes_url: DEFAULT_DRIVE_CHANGES_URL.to_string(),
            start_page_token_url: DEFAULT_START_PAGE_TOKEN_URL.to_string(),
        }
    }

    /// Create a connector with custom base URLs (for testing against wiremock).
    pub fn with_base_url(base_url: &str) -> Self {
        Self {
            client: Client::new(),
            status: ConnectorStatus::Disconnected,
            access_token: None,
            refresh_token: None,
            client_id: None,
            client_secret: None,
            token_expiry: None,
            last_sync: None,
            file_count: 0,
            token_url: format!("{base_url}/token"),
            revoke_url: format!("{base_url}/revoke"),
            files_url: format!("{base_url}/drive/v3/files"),
            changes_url: format!("{base_url}/drive/v3/changes"),
            start_page_token_url: format!("{base_url}/drive/v3/changes/startPageToken"),
        }
    }

    /// Set the access token and expiry for restoring a session or testing.
    pub fn set_access_token(&mut self, token: &str, expires_in_secs: i64) {
        self.access_token = Some(token.to_string());
        self.token_expiry = Some(Utc::now() + chrono::Duration::seconds(expires_in_secs));
        self.status = ConnectorStatus::Connected;
    }

    pub fn provider_name(&self) -> &'static str {
        "google_drive"
    }

    pub fn status(&self) -> ConnectorStatus {
        self.status
    }

    pub fn last_sync_time(&self) -> Option<DateTime<Utc>> {
        self.last_sync
    }

    pub fn file_count(&self) -> u64 {
        self.file_count
    }

    /// Build the Google OAuth 2.0 consent URL for the user to visit.
    pub fn build_auth_url(config: &AuthConfig) -> String {
        let scopes = if config.scopes.is_empty() {
            "https://www.googleapis.com/auth/drive.readonly".to_string()
        } else {
            config.scopes.join(" ")
        };

        format!(
            "{GOOGLE_AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent",
            urlencoding::encode(&config.client_id),
            urlencoding::encode(&config.redirect_uri),
            urlencoding::encode(&scopes),
        )
    }

    /// Exchange an authorization code for access + refresh tokens.
    pub async fn authenticate(&mut self, config: &AuthConfig) -> ConnectorResult<StoredTokens> {
        self.status = ConnectorStatus::Connecting;
        self.client_id = Some(config.client_id.clone());
        self.client_secret = Some(config.client_secret.clone());

        let auth_code = config
            .auth_code
            .as_ref()
            .ok_or_else(|| ConnectorError::InvalidConfig("Missing auth_code".into()))?;

        let resp = self
            .client
            .post(&self.token_url)
            .form(&[
                ("code", auth_code.as_str()),
                ("client_id", &config.client_id),
                ("client_secret", &config.client_secret),
                ("redirect_uri", &config.redirect_uri),
                ("grant_type", "authorization_code"),
            ])
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            self.status = ConnectorStatus::Error;
            return Err(ConnectorError::AuthenticationFailed(format!(
                "HTTP {status}: {body}"
            )));
        }

        let token_resp: GoogleTokenResponse = resp
            .json()
            .await
            .map_err(|e| ConnectorError::AuthenticationFailed(e.to_string()))?;

        let expiry = token_resp
            .expires_in
            .map(|secs| Utc::now() + chrono::Duration::seconds(secs));

        self.access_token = Some(token_resp.access_token.clone());
        self.refresh_token.clone_from(&token_resp.refresh_token);
        self.token_expiry = expiry;
        self.status = ConnectorStatus::Connected;

        Ok(StoredTokens {
            access_token: token_resp.access_token,
            refresh_token: token_resp.refresh_token,
            expiry,
            scopes: config.scopes.clone(),
            provider_metadata: None,
        })
    }

    /// Restore a session from previously stored tokens.
    pub fn restore_tokens(&mut self, tokens: &StoredTokens, client_id: &str, client_secret: &str) {
        self.access_token = Some(tokens.access_token.clone());
        self.refresh_token.clone_from(&tokens.refresh_token);
        self.token_expiry = tokens.expiry;
        self.client_id = Some(client_id.to_string());
        self.client_secret = Some(client_secret.to_string());
        self.status = ConnectorStatus::Connected;
    }

    /// Refresh the access token using the stored refresh token.
    pub async fn refresh_access_token(&mut self) -> ConnectorResult<StoredTokens> {
        let refresh_token = self
            .refresh_token
            .as_ref()
            .ok_or(ConnectorError::TokenExpired)?;
        let client_id = self
            .client_id
            .as_ref()
            .ok_or_else(|| ConnectorError::InvalidConfig("Missing client_id".into()))?;
        let client_secret = self
            .client_secret
            .as_ref()
            .ok_or_else(|| ConnectorError::InvalidConfig("Missing client_secret".into()))?;

        let resp = self
            .client
            .post(&self.token_url)
            .form(&[
                ("refresh_token", refresh_token.as_str()),
                ("client_id", client_id.as_str()),
                ("client_secret", client_secret.as_str()),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if status.as_u16() == 400 || status.as_u16() == 401 {
                self.status = ConnectorStatus::Error;
                return Err(ConnectorError::TokenRevoked);
            }
            return Err(ConnectorError::AuthenticationFailed(format!(
                "Refresh failed HTTP {status}: {body}"
            )));
        }

        let token_resp: GoogleTokenResponse = resp
            .json()
            .await
            .map_err(|e| ConnectorError::AuthenticationFailed(e.to_string()))?;

        let expiry = token_resp
            .expires_in
            .map(|secs| Utc::now() + chrono::Duration::seconds(secs));

        self.access_token = Some(token_resp.access_token.clone());
        self.token_expiry = expiry;
        if let Some(new_refresh) = &token_resp.refresh_token {
            self.refresh_token = Some(new_refresh.clone());
        }

        Ok(StoredTokens {
            access_token: token_resp.access_token,
            refresh_token: self.refresh_token.clone(),
            expiry,
            scopes: Vec::new(),
            provider_metadata: None,
        })
    }

    /// Ensure the access token is valid, refreshing if needed.
    async fn ensure_valid_token(&mut self) -> ConnectorResult<String> {
        if let Some(expiry) = self.token_expiry {
            if Utc::now() >= expiry - chrono::Duration::seconds(60) {
                let refreshed = self.refresh_access_token().await?;
                return Ok(refreshed.access_token);
            }
        }
        self.access_token
            .clone()
            .ok_or(ConnectorError::TokenExpired)
    }

    /// List files in a folder (or root if `folder_id` is None).
    pub async fn list_files(
        &mut self,
        folder_id: Option<&str>,
    ) -> ConnectorResult<Vec<RemoteFile>> {
        let token = self.ensure_valid_token().await?;
        let parent = folder_id.unwrap_or("root");
        let escaped = parent.replace('\\', "\\\\").replace('\'', "\\'");
        let query = format!("'{escaped}' in parents and trashed = false");

        let mut all_files = Vec::new();
        let mut page_token: Option<String> = None;

        loop {
            let mut request = self
                .client
                .get(&self.files_url)
                .bearer_auth(&token)
                .query(&[
                    ("q", query.as_str()),
                    ("fields", &format!("nextPageToken,files({FILE_FIELDS})")),
                    ("pageSize", "100"),
                    ("orderBy", "name"),
                ]);

            if let Some(pt) = &page_token {
                request = request.query(&[("pageToken", pt.as_str())]);
            }

            let resp = request.send().await?;
            let status = resp.status();

            if status.as_u16() == 401 {
                return Err(ConnectorError::TokenExpired);
            }
            if status.as_u16() == 403 {
                let body = resp.text().await.unwrap_or_default();
                return Err(ConnectorError::PermissionDenied(body));
            }
            if status.as_u16() == 429 {
                return Err(ConnectorError::RateLimited {
                    retry_after_secs: 60,
                });
            }
            if !status.is_success() {
                let body = resp.text().await.unwrap_or_default();
                return Err(ConnectorError::ProviderError {
                    provider: "Google Drive".into(),
                    message: format!("HTTP {status}: {body}"),
                });
            }

            let list_resp: DriveFileListResponse = resp
                .json()
                .await
                .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;

            for gf in list_resp.files {
                all_files.push(google_file_to_remote(&gf));
            }

            if let Some(next) = list_resp.next_page_token {
                page_token = Some(next);
            } else {
                break;
            }
        }

        Ok(all_files)
    }

    /// Download a file's content by its Google Drive file ID.
    pub async fn download_file(&mut self, file_id: &str) -> ConnectorResult<Vec<u8>> {
        let token = self.ensure_valid_token().await?;

        let url = format!(
            "{}/{}?alt=media",
            self.files_url,
            urlencoding::encode(file_id)
        );
        let resp = self.client.get(&url).bearer_auth(&token).send().await?;

        let status = resp.status();
        if status.as_u16() == 404 {
            return Err(ConnectorError::FileNotFound(file_id.to_string()));
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ConnectorError::ProviderError {
                provider: "Google Drive".into(),
                message: format!("Download HTTP {status}: {body}"),
            });
        }

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;
        Ok(bytes.to_vec())
    }

    /// Get the initial changes start page token for incremental sync.
    pub async fn get_start_page_token(&mut self) -> ConnectorResult<String> {
        let token = self.ensure_valid_token().await?;

        let resp = self
            .client
            .get(&self.start_page_token_url)
            .bearer_auth(&token)
            .send()
            .await?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ConnectorError::ProviderError {
                provider: "Google Drive".into(),
                message: format!("Start page token error: {body}"),
            });
        }

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;

        body.get("startPageToken")
            .and_then(|v| v.as_str())
            .map(String::from)
            .ok_or_else(|| ConnectorError::ProviderError {
                provider: "Google Drive".into(),
                message: "Missing startPageToken in response".into(),
            })
    }

    /// Perform an incremental sync using the Google Drive Changes API.
    ///
    /// Pass `known_file_ids` to distinguish new files from modifications.
    /// Files whose ID is already in `known_file_ids` go into `result.modified`;
    /// truly new files go into `result.added`.
    pub async fn sync_changes(
        &mut self,
        change_token: Option<&str>,
        known_file_ids: &std::collections::HashSet<String>,
    ) -> ConnectorResult<SyncResult> {
        let page_token = match change_token {
            Some(t) => t.to_string(),
            None => self.get_start_page_token().await?,
        };

        self.status = ConnectorStatus::Syncing;
        let token = match self.ensure_valid_token().await {
            Ok(t) => t,
            Err(e) => {
                self.status = ConnectorStatus::Error;
                return Err(e);
            }
        };

        let resp = match self
            .client
            .get(&self.changes_url)
            .bearer_auth(&token)
            .query(&[
                ("pageToken", page_token.as_str()),
                (
                    "fields",
                    &format!(
                        "nextPageToken,newStartPageToken,changes(removed,fileId,file({FILE_FIELDS}))"
                    ),
                ),
                ("pageSize", "100"),
                ("includeRemoved", "true"),
            ])
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                self.status = ConnectorStatus::Error;
                return Err(e.into());
            }
        };

        if !resp.status().is_success() {
            self.status = ConnectorStatus::Error;
            let body = resp.text().await.unwrap_or_default();
            return Err(ConnectorError::ProviderError {
                provider: "Google Drive".into(),
                message: format!("Changes API error: {body}"),
            });
        }

        let changes_resp: DriveChangesResponse = resp
            .json()
            .await
            .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;

        let mut result = SyncResult::empty();
        result.new_change_token = changes_resp
            .new_start_page_token
            .or(changes_resp.next_page_token.clone());
        result.has_more = changes_resp.next_page_token.is_some();

        for change in changes_resp.changes {
            if change.removed {
                result.removed.push(change.file_id);
            } else if let Some(file) = change.file {
                let remote = google_file_to_remote(&file);
                if known_file_ids.contains(&remote.id) {
                    result.modified.push(remote);
                } else {
                    result.added.push(remote);
                }
            }
        }

        self.last_sync = Some(Utc::now());
        // Only count truly new files (added), not modifications
        self.file_count = if result.added.len() >= result.removed.len() {
            self.file_count
                .saturating_add((result.added.len() - result.removed.len()) as u64)
        } else {
            self.file_count
                .saturating_sub((result.removed.len() - result.added.len()) as u64)
        };
        self.status = ConnectorStatus::Connected;

        Ok(result)
    }

    /// Revoke the OAuth tokens and disconnect.
    pub async fn revoke(&mut self) -> ConnectorResult<()> {
        // Prefer revoking the refresh token: it doesn't expire and Google
        // cascades revocation to all associated access tokens.
        let token_to_revoke = self
            .refresh_token
            .as_deref()
            .or(self.access_token.as_deref());
        if let Some(token) = token_to_revoke {
            let _ = self
                .client
                .post(&self.revoke_url)
                .form(&[("token", token)])
                .send()
                .await;
        }

        self.access_token = None;
        self.refresh_token = None;
        self.client_id = None;
        self.client_secret = None;
        self.token_expiry = None;
        self.last_sync = None;
        self.file_count = 0;
        self.status = ConnectorStatus::Disconnected;

        Ok(())
    }
}

impl Default for GoogleDriveConnector {
    fn default() -> Self {
        Self::new()
    }
}

// --- Google API response types ---

#[derive(Debug, Deserialize)]
struct GoogleTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    #[allow(dead_code)]
    token_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DriveFileListResponse {
    files: Vec<GoogleDriveFile>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DriveChangesResponse {
    changes: Vec<DriveChange>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
    #[serde(rename = "newStartPageToken")]
    new_start_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DriveChange {
    removed: bool,
    #[serde(rename = "fileId")]
    file_id: String,
    file: Option<GoogleDriveFile>,
}

#[derive(Debug, Deserialize)]
struct GoogleDriveFile {
    id: String,
    name: String,
    #[serde(rename = "mimeType")]
    mime_type: String,
    #[serde(default)]
    size: Option<String>,
    #[serde(rename = "modifiedTime")]
    modified_time: Option<String>,
    #[serde(rename = "createdTime")]
    created_time: Option<String>,
    parents: Option<Vec<String>>,
    #[serde(rename = "webViewLink")]
    web_view_link: Option<String>,
    #[serde(rename = "md5Checksum")]
    md5_checksum: Option<String>,
    permissions: Option<Vec<GooglePermission>>,
}

#[derive(Debug, Deserialize)]
struct GooglePermission {
    role: String,
    #[serde(rename = "type")]
    permission_type: String,
    #[serde(rename = "emailAddress")]
    email_address: Option<String>,
}

fn parse_rfc3339_or_now(s: &str) -> DateTime<Utc> {
    chrono::DateTime::parse_from_rfc3339(s).map_or_else(|_| Utc::now(), |dt| dt.with_timezone(&Utc))
}

fn google_file_to_remote(gf: &GoogleDriveFile) -> RemoteFile {
    let size_bytes = gf
        .size
        .as_deref()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    let modified_time = gf
        .modified_time
        .as_deref()
        .map_or_else(Utc::now, parse_rfc3339_or_now);

    let created_time = gf.created_time.as_deref().map(parse_rfc3339_or_now);

    let permissions = gf
        .permissions
        .as_ref()
        .map(|perms| {
            perms
                .iter()
                .map(|p| FilePermission {
                    role: p.role.clone(),
                    permission_type: p.permission_type.clone(),
                    email: p.email_address.clone(),
                })
                .collect()
        })
        .unwrap_or_default();

    let is_folder = gf.mime_type == "application/vnd.google-apps.folder";

    RemoteFile {
        id: gf.id.clone(),
        name: gf.name.clone(),
        mime_type: gf.mime_type.clone(),
        size_bytes,
        modified_time,
        created_time,
        parent_id: gf.parents.as_ref().and_then(|p| p.first().cloned()),
        web_view_link: gf.web_view_link.clone(),
        is_folder,
        md5_checksum: gf.md5_checksum.clone(),
        permissions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connector_starts_disconnected() {
        let c = GoogleDriveConnector::new();
        assert_eq!(c.status(), ConnectorStatus::Disconnected);
        assert_eq!(c.provider_name(), "google_drive");
        assert_eq!(c.file_count(), 0);
        assert!(c.last_sync_time().is_none());
    }

    #[test]
    fn build_auth_url_includes_params() {
        let config = AuthConfig::new(
            "my-client-id".into(),
            "secret".into(),
            "http://localhost:9876/callback".into(),
        )
        .with_scopes(vec!["https://www.googleapis.com/auth/drive.readonly".into()]);

        let url = GoogleDriveConnector::build_auth_url(&config);
        assert!(url.contains("client_id=my-client-id"));
        assert!(url.contains("redirect_uri="));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("prompt=consent"));
        assert!(url.contains("scope="));
    }

    #[test]
    fn build_auth_url_default_scope() {
        let config = AuthConfig::new("cid".into(), "sec".into(), "http://localhost/cb".into());
        let url = GoogleDriveConnector::build_auth_url(&config);
        assert!(url.contains("drive.readonly"));
    }

    #[test]
    fn google_file_to_remote_folder() {
        let gf = GoogleDriveFile {
            id: "folder-1".into(),
            name: "My Folder".into(),
            mime_type: "application/vnd.google-apps.folder".into(),
            size: None,
            modified_time: Some("2024-01-15T10:30:00.000Z".into()),
            created_time: Some("2024-01-10T08:00:00.000Z".into()),
            parents: Some(vec!["root".into()]),
            web_view_link: Some("https://drive.google.com/drive/folders/folder-1".into()),
            md5_checksum: None,
            permissions: None,
        };
        let remote = google_file_to_remote(&gf);
        assert!(remote.is_folder);
        assert_eq!(remote.size_bytes, 0);
        assert_eq!(remote.parent_id.as_deref(), Some("root"));
    }

    #[test]
    fn google_file_to_remote_file() {
        let gf = GoogleDriveFile {
            id: "file-abc".into(),
            name: "report.pdf".into(),
            mime_type: "application/pdf".into(),
            size: Some("102400".into()),
            modified_time: Some("2024-06-01T12:00:00.000Z".into()),
            created_time: None,
            parents: Some(vec!["folder-1".into()]),
            web_view_link: None,
            md5_checksum: Some("abc123".into()),
            permissions: Some(vec![GooglePermission {
                role: "reader".into(),
                permission_type: "user".into(),
                email_address: Some("user@example.com".into()),
            }]),
        };
        let remote = google_file_to_remote(&gf);
        assert!(!remote.is_folder);
        assert_eq!(remote.size_bytes, 102_400);
        assert_eq!(remote.md5_checksum.as_deref(), Some("abc123"));
        assert_eq!(remote.permissions.len(), 1);
        assert_eq!(remote.permissions[0].role, "reader");
    }

    #[test]
    fn restore_tokens_sets_connected() {
        let mut c = GoogleDriveConnector::new();
        let tokens = StoredTokens {
            access_token: "ya29.test".into(),
            refresh_token: Some("1//ref".into()),
            expiry: Some(Utc::now() + chrono::Duration::hours(1)),
            scopes: vec!["drive.readonly".into()],
            provider_metadata: None,
        };
        c.restore_tokens(&tokens, "cid", "csec");
        assert_eq!(c.status(), ConnectorStatus::Connected);
        assert_eq!(c.access_token.as_deref(), Some("ya29.test"));
    }

    #[tokio::test]
    async fn revoke_clears_state() {
        let mut c = GoogleDriveConnector::new();
        c.access_token = Some("token".into());
        c.status = ConnectorStatus::Connected;
        c.file_count = 42;
        // revoke will fail to reach Google but should still clear local state
        let _ = c.revoke().await;
        assert_eq!(c.status(), ConnectorStatus::Disconnected);
        assert!(c.access_token.is_none());
        assert_eq!(c.file_count(), 0);
    }

    #[test]
    fn build_auth_url_percent_encodes_drive_inputs() {
        // Drive client IDs end in `.apps.googleusercontent.com`, redirect
        // URIs carry `://`, `/`, and `?`, and the scope value is a
        // space-separated list of URLs. All of those characters must be
        // percent-encoded so the resulting query string remains a single
        // well-formed URL — the previous hand-rolled `urlencoding` module
        // was the only place this contract was exercised, so when we
        // switched to the `urlencoding` crate we keep the contract under
        // test by exercising the actual call site.
        let config = AuthConfig {
            client_id: "123-abc.apps.googleusercontent.com".into(),
            client_secret: "GOCSPX-secret".into(),
            redirect_uri: "http://localhost:9876/callback".into(),
            scopes: vec![
                "https://www.googleapis.com/auth/drive.readonly".into(),
                "https://www.googleapis.com/auth/userinfo.email".into(),
            ],
            auth_code: None,
            access_token: None,
            refresh_token: None,
            token_expiry: None,
        };

        let url = GoogleDriveConnector::build_auth_url(&config);

        // `://`, `/`, `?`, `:`, and ` ` (space joining scopes) must all be
        // percent-encoded so the URL parses as a single query string. The
        // `redirect_uri` value is the most fragile site since OAuth
        // providers reject any mismatch with the registered URI, so we
        // assert its encoded form explicitly.
        assert!(
            url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A9876%2Fcallback"),
            "redirect_uri not properly percent-encoded in: {url}",
        );
        // Scope-list space separator must become `%20`, not `+`, since
        // Google's OAuth endpoint treats `+` literally inside scope names.
        assert!(
            url.contains("auth%2Fdrive.readonly%20https"),
            "scope-separator space not percent-encoded as %20 in: {url}",
        );
        // Client ID must round-trip unchanged through the encoder for the
        // characters Google actually uses (`-`, `.`).
        assert!(
            url.contains("client_id=123-abc.apps.googleusercontent.com"),
            "client_id encoding lost dots/hyphens in: {url}",
        );
        // The whole result must remain a valid absolute URL.
        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
    }
}
