//! Microsoft OneDrive / SharePoint connector — Microsoft Graph v1.0.
//!
//! ## OAuth
//!
//! Uses the Microsoft identity platform v2.0 endpoint
//! `https://login.microsoftonline.com/common/oauth2/v2.0`. We support both
//! personal Microsoft accounts and work/school accounts via the `common`
//! tenant; callers can override this via [`OneDriveConnector::with_tenant`].
//!
//! Refresh tokens require the `offline_access` scope and are returned by the
//! token endpoint just like any other OAuth 2.0 confidential client.
//!
//! ## Sync
//!
//! Incremental sync uses the [Graph delta query][delta] on
//! `/me/drive/root/delta`. The response includes a `@odata.deltaLink` once
//! the current change feed has been drained; we store that URL as the
//! opaque change token. The next sync call hits the delta URL directly
//! instead of re-running the listing from scratch.
//!
//! Removed items are signaled by a `deleted` property on each driveItem,
//! per the Graph contract.
//!
//! [delta]: https://learn.microsoft.com/graph/api/driveitem-delta
//!
//! ## SharePoint
//!
//! SharePoint document libraries are exposed by Graph as the same
//! `driveItem` shape — we read from `/sites/{id}/drive/root` when the
//! user opts into a SharePoint site instead of a personal OneDrive. The
//! [`OneDriveConnector::with_drive_root`] override lets the IPC layer
//! point the connector at any drive root URL.

use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashSet;

use crate::error::{ConnectorError, ConnectorResult};
use crate::types::{
    AuthConfig, ConnectorStatus, FilePermission, RemoteFile, StoredTokens, SyncResult,
};
use crate::url_encode;

const DEFAULT_AUTHORITY: &str = "https://login.microsoftonline.com";
const DEFAULT_GRAPH_BASE: &str = "https://graph.microsoft.com/v1.0";
const DEFAULT_TENANT: &str = "common";

/// Selected `$select` fields on driveItem responses — kept tight to
/// minimise payload size on the Graph endpoint, which is one of the
/// more bandwidth-sensitive APIs we talk to.
const DRIVE_ITEM_FIELDS: &str = "id,name,size,file,folder,deleted,parentReference,webUrl,createdDateTime,lastModifiedDateTime";

pub struct OneDriveConnector {
    client: Client,
    status: ConnectorStatus,
    access_token: Option<String>,
    refresh_token: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    token_expiry: Option<DateTime<Utc>>,
    last_sync: Option<DateTime<Utc>>,
    file_count: u64,
    tenant: String,
    authority: String,
    graph_base: String,
    /// Optional explicit drive root URL. Defaults to `/me/drive/root` for
    /// personal OneDrive; set to `/sites/{site-id}/drive/root` for
    /// SharePoint.
    drive_root: String,
}

impl OneDriveConnector {
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
            tenant: DEFAULT_TENANT.to_string(),
            authority: DEFAULT_AUTHORITY.to_string(),
            graph_base: DEFAULT_GRAPH_BASE.to_string(),
            drive_root: format!("{DEFAULT_GRAPH_BASE}/me/drive/root"),
        }
    }

    /// Create a connector that talks to a custom base URL — used in tests
    /// with `wiremock` and by IPC tests that swap in a mock server.
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
            tenant: DEFAULT_TENANT.to_string(),
            authority: base_url.to_string(),
            graph_base: format!("{base_url}/graph"),
            drive_root: format!("{base_url}/graph/me/drive/root"),
        }
    }

    /// Switch the OAuth tenant (default: `common`). Use a specific tenant
    /// GUID for work/school-only accounts.
    pub fn with_tenant(mut self, tenant: &str) -> Self {
        self.tenant = tenant.to_string();
        self
    }

    /// Point the connector at a specific drive root — for SharePoint
    /// document libraries, pass e.g. `/sites/{site-id}/drive/root` (the
    /// connector will prefix it with the configured graph base).
    pub fn with_drive_root(mut self, drive_root_path: &str) -> Self {
        self.drive_root = if drive_root_path.starts_with("http") {
            drive_root_path.to_string()
        } else {
            format!("{}{}", self.graph_base, drive_root_path)
        };
        self
    }

    pub fn set_access_token(&mut self, token: &str, expires_in_secs: i64) {
        self.access_token = Some(token.to_string());
        self.token_expiry = Some(Utc::now() + chrono::Duration::seconds(expires_in_secs));
        self.status = ConnectorStatus::Connected;
    }

    pub fn provider_name(&self) -> &'static str {
        "onedrive"
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

    fn token_url(&self) -> String {
        format!("{}/{}/oauth2/v2.0/token", self.authority, self.tenant)
    }

    fn authorize_url(&self) -> String {
        format!("{}/{}/oauth2/v2.0/authorize", self.authority, self.tenant)
    }

    pub fn build_auth_url(&self, config: &AuthConfig) -> String {
        // Microsoft requires `offline_access` for refresh tokens; we
        // always include it alongside the caller's scopes so the user
        // doesn't have to re-consent on every token refresh.
        let mut scopes: Vec<String> = config.scopes.clone();
        if !scopes.iter().any(|s| s == "offline_access") {
            scopes.push("offline_access".to_string());
        }
        if scopes.is_empty()
            || scopes.iter().all(|s| s == "offline_access")
        {
            scopes.insert(0, "Files.Read.All".to_string());
        }

        format!(
            "{}?client_id={}&redirect_uri={}&response_type=code&response_mode=query&scope={}&prompt=select_account",
            self.authorize_url(),
            url_encode::encode(&config.client_id),
            url_encode::encode(&config.redirect_uri),
            url_encode::encode(&scopes.join(" ")),
        )
    }

    pub async fn authenticate(&mut self, config: &AuthConfig) -> ConnectorResult<StoredTokens> {
        self.status = ConnectorStatus::Connecting;
        self.client_id = Some(config.client_id.clone());
        self.client_secret = Some(config.client_secret.clone());

        let code = config
            .auth_code
            .as_ref()
            .ok_or_else(|| ConnectorError::InvalidConfig("Missing auth_code".into()))?;

        let resp = self
            .client
            .post(self.token_url())
            .form(&[
                ("client_id", config.client_id.as_str()),
                ("client_secret", config.client_secret.as_str()),
                ("code", code.as_str()),
                ("redirect_uri", config.redirect_uri.as_str()),
                ("grant_type", "authorization_code"),
                // Graph requires the scope on token exchange too.
                ("scope", &config.scopes.join(" ")),
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

        let token: MsTokenResponse = resp
            .json()
            .await
            .map_err(|e| ConnectorError::AuthenticationFailed(e.to_string()))?;

        let expiry = token
            .expires_in
            .map(|s| Utc::now() + chrono::Duration::seconds(s));
        self.access_token = Some(token.access_token.clone());
        self.refresh_token.clone_from(&token.refresh_token);
        self.token_expiry = expiry;
        self.status = ConnectorStatus::Connected;

        Ok(StoredTokens {
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expiry,
            scopes: config.scopes.clone(),
        })
    }

    pub fn restore_tokens(&mut self, tokens: &StoredTokens, client_id: &str, client_secret: &str) {
        self.access_token = Some(tokens.access_token.clone());
        self.refresh_token.clone_from(&tokens.refresh_token);
        self.token_expiry = tokens.expiry;
        self.client_id = Some(client_id.to_string());
        self.client_secret = Some(client_secret.to_string());
        self.status = ConnectorStatus::Connected;
    }

    pub async fn refresh_access_token(&mut self) -> ConnectorResult<StoredTokens> {
        let refresh_token = self
            .refresh_token
            .as_ref()
            .ok_or(ConnectorError::TokenExpired)?
            .clone();
        let client_id = self
            .client_id
            .as_ref()
            .ok_or_else(|| ConnectorError::InvalidConfig("Missing client_id".into()))?
            .clone();
        let client_secret = self
            .client_secret
            .as_ref()
            .ok_or_else(|| ConnectorError::InvalidConfig("Missing client_secret".into()))?
            .clone();

        let resp = self
            .client
            .post(self.token_url())
            .form(&[
                ("client_id", client_id.as_str()),
                ("client_secret", client_secret.as_str()),
                ("refresh_token", refresh_token.as_str()),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            // Microsoft returns 400 with error="invalid_grant" once the
            // refresh token is revoked or beyond its absolute lifetime.
            if status.as_u16() == 400 || status.as_u16() == 401 {
                self.status = ConnectorStatus::Error;
                return Err(ConnectorError::TokenRevoked);
            }
            return Err(ConnectorError::AuthenticationFailed(format!(
                "Refresh failed HTTP {status}: {body}"
            )));
        }

        let token: MsTokenResponse = resp
            .json()
            .await
            .map_err(|e| ConnectorError::AuthenticationFailed(e.to_string()))?;

        let expiry = token
            .expires_in
            .map(|s| Utc::now() + chrono::Duration::seconds(s));
        self.access_token = Some(token.access_token.clone());
        self.token_expiry = expiry;
        if let Some(new_rt) = &token.refresh_token {
            self.refresh_token = Some(new_rt.clone());
        }

        Ok(StoredTokens {
            access_token: token.access_token,
            refresh_token: self.refresh_token.clone(),
            expiry,
            scopes: Vec::new(),
        })
    }

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

    /// List the children of a folder. `None` lists the configured drive
    /// root (personal OneDrive root or a SharePoint document library).
    pub async fn list_files(
        &mut self,
        folder_id: Option<&str>,
    ) -> ConnectorResult<Vec<RemoteFile>> {
        let token = self.ensure_valid_token().await?;

        let url = match folder_id {
            Some(id) if !id.is_empty() && id != "root" => format!(
                "{}/items/{}/children",
                self.drive_root.trim_end_matches("/root"),
                url_encode::encode(id),
            ),
            _ => format!("{}/children", self.drive_root),
        };

        let mut all = Vec::new();
        let mut next: Option<String> = Some(url);

        while let Some(page_url) = next.take() {
            let mut req = self.client.get(&page_url).bearer_auth(&token);
            if !page_url.contains("$select=") {
                req = req.query(&[("$select", DRIVE_ITEM_FIELDS)]);
            }
            let resp = req.send().await?;
            let status = resp.status();

            if status.as_u16() == 401 {
                return Err(ConnectorError::TokenExpired);
            }
            if status.as_u16() == 403 {
                let body = resp.text().await.unwrap_or_default();
                return Err(ConnectorError::PermissionDenied(body));
            }
            if status.as_u16() == 429 {
                let retry = resp
                    .headers()
                    .get("Retry-After")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(60);
                return Err(ConnectorError::RateLimited {
                    retry_after_secs: retry,
                });
            }
            if !status.is_success() {
                let body = resp.text().await.unwrap_or_default();
                return Err(ConnectorError::ProviderError {
                    provider: "OneDrive".into(),
                    message: format!("HTTP {status}: {body}"),
                });
            }

            let page: GraphCollection = resp
                .json()
                .await
                .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;

            for item in page.value {
                all.push(drive_item_to_remote(&item));
            }
            next = page.next_link;
        }

        Ok(all)
    }

    /// Download an item by id from the configured drive.
    pub async fn download_file(&mut self, file_id: &str) -> ConnectorResult<Vec<u8>> {
        let token = self.ensure_valid_token().await?;
        let url = format!(
            "{}/items/{}/content",
            self.drive_root.trim_end_matches("/root"),
            url_encode::encode(file_id),
        );
        let resp = self.client.get(&url).bearer_auth(&token).send().await?;
        let status = resp.status();
        if status.as_u16() == 404 {
            return Err(ConnectorError::FileNotFound(file_id.into()));
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ConnectorError::ProviderError {
                provider: "OneDrive".into(),
                message: format!("Download HTTP {status}: {body}"),
            });
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;
        Ok(bytes.to_vec())
    }

    /// Incremental sync via the Graph delta query.
    ///
    /// `change_token` is the `@odata.deltaLink` returned by the previous
    /// successful sync. Pass `None` to start a fresh delta from the
    /// current root.
    pub async fn sync_changes(
        &mut self,
        change_token: Option<&str>,
        known_file_ids: &HashSet<String>,
    ) -> ConnectorResult<SyncResult> {
        let token = self.ensure_valid_token().await?;
        self.status = ConnectorStatus::Syncing;

        let mut next_url = match change_token {
            Some(t) if t.starts_with("http") => t.to_string(),
            _ => format!("{}/delta", self.drive_root),
        };
        let mut result = SyncResult::empty();
        let mut delta_link: Option<String> = None;

        loop {
            let resp = match self
                .client
                .get(&next_url)
                .bearer_auth(&token)
                .query(&[("$select", DRIVE_ITEM_FIELDS)])
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
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(ConnectorError::ProviderError {
                    provider: "OneDrive".into(),
                    message: format!("Delta HTTP {status}: {body}"),
                });
            }

            let page: GraphCollection = resp
                .json()
                .await
                .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;

            for item in page.value {
                if item.deleted.is_some() {
                    result.removed.push(item.id.clone());
                    continue;
                }
                let remote = drive_item_to_remote(&item);
                if known_file_ids.contains(&remote.id) {
                    result.modified.push(remote);
                } else {
                    result.added.push(remote);
                }
            }

            if let Some(link) = page.delta_link {
                delta_link = Some(link);
                break;
            }
            if let Some(next) = page.next_link {
                next_url = next;
                continue;
            }
            break;
        }

        result.new_change_token = delta_link;
        result.has_more = false;
        self.last_sync = Some(Utc::now());
        // Net file delta — same accounting model as gdrive.
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

    pub async fn revoke(&mut self) -> ConnectorResult<()> {
        // Microsoft Graph has no public revoke endpoint analogous to
        // Google's `oauth2/revoke` — the user must revoke consent in the
        // account portal. We still clear local state and surface
        // Disconnected so the UI reflects the user's intent.
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

impl Default for OneDriveConnector {
    fn default() -> Self {
        Self::new()
    }
}

// --- Graph response shapes -------------------------------------------------

#[derive(Debug, Deserialize)]
struct MsTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    #[allow(dead_code)]
    token_type: Option<String>,
    #[allow(dead_code)]
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphCollection {
    #[serde(default)]
    value: Vec<DriveItem>,
    #[serde(rename = "@odata.nextLink")]
    next_link: Option<String>,
    #[serde(rename = "@odata.deltaLink")]
    delta_link: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DriveItem {
    id: String,
    name: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    file: Option<FileFacet>,
    #[serde(default)]
    folder: Option<FolderFacet>,
    #[serde(default)]
    deleted: Option<DeletedFacet>,
    #[serde(rename = "parentReference", default)]
    parent_reference: Option<ParentReference>,
    #[serde(rename = "webUrl", default)]
    web_url: Option<String>,
    #[serde(rename = "createdDateTime", default)]
    created_date_time: Option<String>,
    #[serde(rename = "lastModifiedDateTime", default)]
    last_modified_date_time: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FileFacet {
    #[serde(rename = "mimeType", default)]
    mime_type: Option<String>,
    #[serde(default)]
    hashes: Option<FileHashes>,
}

#[derive(Debug, Deserialize)]
struct FileHashes {
    #[serde(rename = "quickXorHash", default)]
    quick_xor_hash: Option<String>,
    #[serde(rename = "sha1Hash", default)]
    sha1_hash: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FolderFacet {}

#[derive(Debug, Deserialize)]
struct DeletedFacet {
    #[allow(dead_code)]
    #[serde(default)]
    state: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ParentReference {
    #[serde(default)]
    id: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    path: Option<String>,
}

fn parse_rfc3339_or_now(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).map_or_else(|_| Utc::now(), |dt| dt.with_timezone(&Utc))
}

fn drive_item_to_remote(item: &DriveItem) -> RemoteFile {
    let is_folder = item.folder.is_some();
    let mime_type = if is_folder {
        "application/vnd.onedrive.folder".to_string()
    } else {
        item.file
            .as_ref()
            .and_then(|f| f.mime_type.clone())
            .unwrap_or_else(|| "application/octet-stream".to_string())
    };

    let md5_or_sha = item
        .file
        .as_ref()
        .and_then(|f| f.hashes.as_ref())
        // Microsoft Graph exposes quickXorHash on personal OneDrive and
        // sha1Hash on SharePoint document libraries. Either provides
        // change-detection without re-hashing the body locally.
        .and_then(|h| h.quick_xor_hash.clone().or_else(|| h.sha1_hash.clone()));

    let modified_time = item
        .last_modified_date_time
        .as_deref()
        .map_or_else(Utc::now, parse_rfc3339_or_now);
    let created_time = item.created_date_time.as_deref().map(parse_rfc3339_or_now);

    RemoteFile {
        id: item.id.clone(),
        name: item.name.clone(),
        mime_type,
        size_bytes: item.size.unwrap_or(0),
        modified_time,
        created_time,
        parent_id: item
            .parent_reference
            .as_ref()
            .and_then(|p| p.id.clone()),
        web_view_link: item.web_url.clone(),
        is_folder,
        md5_checksum: md5_or_sha,
        // Graph permissions are a separate API call (`/items/{id}/permissions`),
        // so we leave this empty at listing time — consumers that need
        // ACL data can fetch permissions on demand.
        permissions: Vec::<FilePermission>::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn connector_starts_disconnected() {
        let c = OneDriveConnector::new();
        assert_eq!(c.status(), ConnectorStatus::Disconnected);
        assert_eq!(c.provider_name(), "onedrive");
        assert_eq!(c.file_count(), 0);
    }

    #[test]
    fn build_auth_url_adds_offline_access() {
        let c = OneDriveConnector::new();
        let config = AuthConfig::new("cid".into(), "sec".into(), "http://localhost/cb".into())
            .with_scopes(vec!["Files.Read.All".into()]);
        let url = c.build_auth_url(&config);
        assert!(url.contains("client_id=cid"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("offline_access"), "url was {url}");
        assert!(url.contains("Files.Read.All"));
    }

    #[test]
    fn build_auth_url_default_scope() {
        let c = OneDriveConnector::new();
        let config = AuthConfig::new("cid".into(), "sec".into(), "http://localhost/cb".into());
        let url = c.build_auth_url(&config);
        // offline_access is always present; with no caller scopes we
        // also default to Files.Read.All so the consent dialog isn't
        // empty.
        assert!(url.contains("Files.Read.All"));
        assert!(url.contains("offline_access"));
    }

    #[test]
    fn drive_item_folder_to_remote() {
        let it = DriveItem {
            id: "f1".into(),
            name: "Docs".into(),
            size: Some(0),
            file: None,
            folder: Some(FolderFacet {}),
            deleted: None,
            parent_reference: Some(ParentReference {
                id: Some("root".into()),
                path: None,
            }),
            web_url: Some("https://onedrive.live.com/?cid=...".into()),
            created_date_time: Some("2024-01-01T00:00:00Z".into()),
            last_modified_date_time: Some("2024-02-01T00:00:00Z".into()),
        };
        let r = drive_item_to_remote(&it);
        assert!(r.is_folder);
        assert_eq!(r.mime_type, "application/vnd.onedrive.folder");
        assert_eq!(r.parent_id.as_deref(), Some("root"));
    }

    #[test]
    fn drive_item_file_picks_quick_xor_then_sha1() {
        let it = DriveItem {
            id: "f1".into(),
            name: "report.docx".into(),
            size: Some(2048),
            file: Some(FileFacet {
                mime_type: Some(
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        .into(),
                ),
                hashes: Some(FileHashes {
                    quick_xor_hash: Some("QXH=".into()),
                    sha1_hash: Some("sha1".into()),
                }),
            }),
            folder: None,
            deleted: None,
            parent_reference: None,
            web_url: None,
            created_date_time: None,
            last_modified_date_time: None,
        };
        let r = drive_item_to_remote(&it);
        assert!(!r.is_folder);
        assert_eq!(r.size_bytes, 2048);
        // quickXorHash wins (personal-OneDrive case).
        assert_eq!(r.md5_checksum.as_deref(), Some("QXH="));

        let it2 = DriveItem {
            id: "f2".into(),
            name: "report.docx".into(),
            size: Some(2048),
            file: Some(FileFacet {
                mime_type: None,
                hashes: Some(FileHashes {
                    quick_xor_hash: None,
                    sha1_hash: Some("sha-only".into()),
                }),
            }),
            folder: None,
            deleted: None,
            parent_reference: None,
            web_url: None,
            created_date_time: None,
            last_modified_date_time: None,
        };
        // SharePoint case: only sha1 available.
        let r2 = drive_item_to_remote(&it2);
        assert_eq!(r2.md5_checksum.as_deref(), Some("sha-only"));
    }

    #[tokio::test]
    async fn authenticate_with_mock_token_endpoint() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/common/oauth2/v2.0/token"))
            .and(body_string_contains("grant_type=authorization_code"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "AT",
                "refresh_token": "RT",
                "expires_in": 3600,
                "token_type": "Bearer",
            })))
            .mount(&server)
            .await;

        let mut c = OneDriveConnector::with_base_url(&server.uri());
        let config = AuthConfig::new("cid".into(), "sec".into(), "http://localhost/cb".into())
            .with_scopes(vec!["Files.Read.All".into()])
            .with_auth_code("the-code".into());

        let tokens = c.authenticate(&config).await.expect("auth ok");
        assert_eq!(tokens.access_token, "AT");
        assert_eq!(tokens.refresh_token.as_deref(), Some("RT"));
        assert_eq!(c.status(), ConnectorStatus::Connected);
    }

    #[tokio::test]
    async fn refresh_token_revoked_returns_token_revoked() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/common/oauth2/v2.0/token"))
            .respond_with(
                ResponseTemplate::new(400)
                    .set_body_json(serde_json::json!({"error": "invalid_grant"})),
            )
            .mount(&server)
            .await;

        let mut c = OneDriveConnector::with_base_url(&server.uri());
        c.client_id = Some("cid".into());
        c.client_secret = Some("sec".into());
        c.refresh_token = Some("stale-rt".into());

        let err = c.refresh_access_token().await.unwrap_err();
        assert!(matches!(err, ConnectorError::TokenRevoked));
    }

    #[tokio::test]
    async fn list_files_parses_graph_response_and_pages() {
        let server = MockServer::start().await;

        // Page 1 — yields a nextLink that hits the same server again.
        let next_link = format!("{}/graph/me/drive/root/children?page=2", server.uri());
        Mock::given(method("GET"))
            .and(path("/graph/me/drive/root/children"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "value": [
                    {
                        "id": "abc",
                        "name": "Notes.txt",
                        "size": 16,
                        "file": {"mimeType": "text/plain"},
                        "lastModifiedDateTime": "2024-05-01T10:00:00Z"
                    }
                ],
                "@odata.nextLink": next_link,
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;

        // Page 2 — terminates the loop.
        Mock::given(method("GET"))
            .and(path("/graph/me/drive/root/children"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "value": [
                    {
                        "id": "def",
                        "name": "Memo.txt",
                        "size": 8,
                        "file": {"mimeType": "text/plain"},
                        "lastModifiedDateTime": "2024-05-02T10:00:00Z"
                    }
                ]
            })))
            .mount(&server)
            .await;

        let mut c = OneDriveConnector::with_base_url(&server.uri());
        c.set_access_token("AT", 3600);

        let files = c.list_files(None).await.expect("list ok");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].name, "Notes.txt");
        assert_eq!(files[1].name, "Memo.txt");
    }

    #[tokio::test]
    async fn sync_changes_tracks_added_modified_removed_via_delta() {
        let server = MockServer::start().await;
        let delta_link = format!(
            "{}/graph/me/drive/root/delta?token=ABC",
            server.uri()
        );

        Mock::given(method("GET"))
            .and(path("/graph/me/drive/root/delta"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "value": [
                    {"id": "new-1", "name": "A.txt", "size": 1, "file": {"mimeType": "text/plain"}},
                    {"id": "known-1", "name": "B.txt", "size": 2, "file": {"mimeType": "text/plain"}},
                    {"id": "gone-1", "name": "C.txt", "deleted": {"state": "deleted"}},
                ],
                "@odata.deltaLink": delta_link,
            })))
            .mount(&server)
            .await;

        let mut c = OneDriveConnector::with_base_url(&server.uri());
        c.set_access_token("AT", 3600);

        let mut known = HashSet::new();
        known.insert("known-1".to_string());
        let result = c.sync_changes(None, &known).await.expect("sync ok");
        assert_eq!(result.added.len(), 1);
        assert_eq!(result.added[0].id, "new-1");
        assert_eq!(result.modified.len(), 1);
        assert_eq!(result.modified[0].id, "known-1");
        assert_eq!(result.removed, vec!["gone-1"]);
        assert!(result
            .new_change_token
            .as_deref()
            .is_some_and(|s| s.contains("delta")));
    }

    #[tokio::test]
    async fn list_files_rate_limited_propagates_retry_after() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/graph/me/drive/root/children"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "42"))
            .mount(&server)
            .await;

        let mut c = OneDriveConnector::with_base_url(&server.uri());
        c.set_access_token("AT", 3600);

        let err = c.list_files(None).await.unwrap_err();
        match err {
            ConnectorError::RateLimited { retry_after_secs } => {
                assert_eq!(retry_after_secs, 42);
            }
            other => panic!("expected RateLimited, got {other:?}"),
        }
    }
}
