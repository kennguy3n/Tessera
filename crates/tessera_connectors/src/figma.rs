//! Figma connector — Figma REST API with OAuth 2.0.
//!
//! ## OAuth
//!
//! Figma's flow consents at `https://www.figma.com/oauth` and exchanges
//! at `https://api.figma.com/v1/oauth/token`. The exchange returns a
//! short-lived access token plus a refresh token; both rotate on
//! refresh.
//!
//! ## Sync
//!
//! Figma has no project-wide change feed. We walk the user's projects
//! via the team-projects endpoints (when a team id is known) and rank
//! by `last_modified` (descending) — same boundary trick as Notion/Jira.
//!
//! ## What Figma surfaces as a "file"
//!
//! A Figma file (`.fig` document). Mime type
//! `application/vnd.figma.file`. The `download_file` call returns the
//! file's flattened metadata (component names, text-layer strings,
//! comments) as a JSON blob; the indexer parses out the text for FTS.

use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashSet;

use crate::error::{ConnectorError, ConnectorResult};
use crate::types::{AuthConfig, ConnectorStatus, RemoteFile, StoredTokens, SyncResult};
use crate::url_encode;

const DEFAULT_AUTH_URL: &str = "https://www.figma.com/oauth";
const DEFAULT_TOKEN_URL: &str = "https://api.figma.com/v1/oauth/token";
const DEFAULT_REFRESH_URL: &str = "https://api.figma.com/v1/oauth/refresh";
const DEFAULT_API_BASE: &str = "https://api.figma.com/v1";

pub struct FigmaConnector {
    client: Client,
    status: ConnectorStatus,
    access_token: Option<String>,
    refresh_token: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    token_expiry: Option<DateTime<Utc>>,
    team_id: Option<String>,
    last_sync: Option<DateTime<Utc>>,
    file_count: u64,
    auth_url: String,
    token_url: String,
    refresh_url: String,
    api_base: String,
}

impl FigmaConnector {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            status: ConnectorStatus::Disconnected,
            access_token: None,
            refresh_token: None,
            client_id: None,
            client_secret: None,
            token_expiry: None,
            team_id: None,
            last_sync: None,
            file_count: 0,
            auth_url: DEFAULT_AUTH_URL.to_string(),
            token_url: DEFAULT_TOKEN_URL.to_string(),
            refresh_url: DEFAULT_REFRESH_URL.to_string(),
            api_base: DEFAULT_API_BASE.to_string(),
        }
    }

    pub fn with_base_url(base_url: &str) -> Self {
        Self {
            client: Client::new(),
            status: ConnectorStatus::Disconnected,
            access_token: None,
            refresh_token: None,
            client_id: None,
            client_secret: None,
            token_expiry: None,
            team_id: None,
            last_sync: None,
            file_count: 0,
            auth_url: format!("{base_url}/oauth"),
            token_url: format!("{base_url}/v1/oauth/token"),
            refresh_url: format!("{base_url}/v1/oauth/refresh"),
            api_base: format!("{base_url}/v1"),
        }
    }

    pub fn set_access_token(&mut self, token: &str, expires_in_secs: i64) {
        self.access_token = Some(token.to_string());
        self.token_expiry = Some(Utc::now() + chrono::Duration::seconds(expires_in_secs));
        self.status = ConnectorStatus::Connected;
    }

    pub fn set_team_id(&mut self, team_id: &str) {
        self.team_id = Some(team_id.to_string());
    }

    pub fn provider_name(&self) -> &'static str {
        "figma"
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
    pub fn team_id(&self) -> Option<&str> {
        self.team_id.as_deref()
    }

    pub fn build_auth_url(&self, config: &AuthConfig) -> String {
        let scopes = if config.scopes.is_empty() {
            "files:read".to_string()
        } else {
            config.scopes.join(",")
        };
        // Figma accepts the OAuth `state` param via the caller's
        // redirect-URL handling, so we just include client_id+scope+
        // response_type here.
        format!(
            "{}?client_id={}&redirect_uri={}&scope={}&response_type=code&state=figma",
            self.auth_url,
            url_encode::encode(&config.client_id),
            url_encode::encode(&config.redirect_uri),
            url_encode::encode(&scopes),
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
            .post(&self.token_url)
            .form(&[
                ("client_id", config.client_id.as_str()),
                ("client_secret", config.client_secret.as_str()),
                ("redirect_uri", config.redirect_uri.as_str()),
                ("code", code.as_str()),
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

        let token: FigmaTokenResponse = resp
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
            provider_metadata: self.team_id.clone(),
        })
    }

    pub fn restore_tokens(&mut self, tokens: &StoredTokens, client_id: &str, client_secret: &str) {
        self.access_token = Some(tokens.access_token.clone());
        self.refresh_token.clone_from(&tokens.refresh_token);
        self.token_expiry = tokens.expiry;
        // The team id lives in `provider_metadata`. This connector is
        // new in this PR, so we don't carry a back-compat fallback that
        // might misinterpret an OAuth scope string as a team id.
        if tokens.provider_metadata.is_some() {
            self.team_id.clone_from(&tokens.provider_metadata);
        }
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
            .post(&self.refresh_url)
            .form(&[
                ("client_id", client_id.as_str()),
                ("client_secret", client_secret.as_str()),
                ("refresh_token", refresh_token.as_str()),
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

        let token: FigmaTokenResponse = resp
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
            provider_metadata: self.team_id.clone(),
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

    /// Fetch every project id under the configured team. Pulled out
    /// of `list_files` so the top-level routing stays an `if let`
    /// over a single short branch.
    async fn fetch_team_project_ids(&mut self) -> ConnectorResult<Vec<String>> {
        let team_id = self.team_id.clone().ok_or_else(|| {
            ConnectorError::InvalidConfig(
                "Missing team_id — call set_team_id() before list_files()".into(),
            )
        })?;
        // Refresh the token immediately before each network call so
        // a slow walk over many projects doesn't fail with 401 after
        // the access token crosses its expiry buffer.
        let token = self.ensure_valid_token().await?;
        let url = format!(
            "{}/teams/{}/projects",
            self.api_base,
            url_encode::encode(&team_id)
        );
        let resp = self.client.get(&url).bearer_auth(&token).send().await?;
        handle_common_errors(resp.status())?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(ConnectorError::ProviderError {
                provider: "Figma".into(),
                message: format!("Projects HTTP {status}: {body}"),
            });
        }
        let page: FigmaProjectsResponse = resp
            .json()
            .await
            .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;
        Ok(page.projects.into_iter().map(|p| p.id).collect())
    }

    /// List files. `folder_id` is interpreted as a Figma project id.
    /// When `None`, we walk all projects in the configured team and
    /// flatten their files.
    pub async fn list_files(
        &mut self,
        folder_id: Option<&str>,
    ) -> ConnectorResult<Vec<RemoteFile>> {
        let project_ids: Vec<String> = if let Some(p) = folder_id {
            vec![p.to_string()]
        } else {
            self.fetch_team_project_ids().await?
        };

        let mut all = Vec::new();
        for pid in project_ids {
            // Re-check the token between projects; walking a team with
            // dozens of projects can take long enough to outlive the
            // current access token.
            let token = self.ensure_valid_token().await?;
            let url = format!(
                "{}/projects/{}/files",
                self.api_base,
                url_encode::encode(&pid)
            );
            let resp = self.client.get(&url).bearer_auth(&token).send().await?;
            handle_common_errors(resp.status())?;
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(ConnectorError::ProviderError {
                    provider: "Figma".into(),
                    message: format!("Files HTTP {status}: {body}"),
                });
            }
            let page: FigmaFilesResponse = resp
                .json()
                .await
                .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;
            for f in page.files {
                all.push(figma_file_to_remote(&f, &pid));
            }
        }

        Ok(all)
    }

    /// Fetch a file's metadata + flattened text-layer strings as JSON
    /// — sufficient for the indexer's text-extraction step.
    pub async fn download_file(&mut self, file_key: &str) -> ConnectorResult<Vec<u8>> {
        let token = self.ensure_valid_token().await?;
        let url = format!("{}/files/{}", self.api_base, url_encode::encode(file_key));
        let resp = self.client.get(&url).bearer_auth(&token).send().await?;
        if resp.status().as_u16() == 404 {
            return Err(ConnectorError::FileNotFound(file_key.into()));
        }
        handle_common_errors(resp.status())?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(ConnectorError::ProviderError {
                provider: "Figma".into(),
                message: format!("File HTTP {status}: {body}"),
            });
        }

        let value: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;

        // Pull text layers and component names out of the document tree
        // and emit them as a compact JSON payload.
        let mut texts: Vec<String> = Vec::new();
        let mut components: Vec<String> = Vec::new();
        walk_figma_node(
            &value.get("document").cloned().unwrap_or_default(),
            &mut texts,
        );
        if let Some(comp_map) = value.get("components").and_then(|c| c.as_object()) {
            for (_, comp) in comp_map {
                if let Some(name) = comp.get("name").and_then(|n| n.as_str()) {
                    components.push(name.to_string());
                }
            }
        }

        let extract = serde_json::json!({
            "name": value.get("name"),
            "lastModified": value.get("lastModified"),
            "texts": texts,
            "components": components
        });
        serde_json::to_vec(&extract).map_err(|e| ConnectorError::ProviderError {
            provider: "Figma".into(),
            message: format!("JSON encode: {e}"),
        })
    }

    pub async fn sync_changes(
        &mut self,
        change_token: Option<&str>,
        known_file_ids: &HashSet<String>,
    ) -> ConnectorResult<SyncResult> {
        let boundary: Option<DateTime<Utc>> = change_token
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Utc));

        self.status = ConnectorStatus::Syncing;
        let files = match self.list_files(None).await {
            Ok(f) => f,
            Err(e) => {
                self.status = ConnectorStatus::Error;
                return Err(e);
            }
        };

        let mut result = SyncResult::empty();
        let mut newest_seen: Option<DateTime<Utc>> = None;
        // Track every file we saw in the fresh listing so we can detect
        // deletions by set-differencing against the caller's known
        // ids. Figma exposes no native deletion feed.
        let mut seen_ids: HashSet<String> = HashSet::with_capacity(files.len());
        for remote in files {
            seen_ids.insert(remote.id.clone());
            if remote.modified_time > newest_seen.unwrap_or(DateTime::<Utc>::MIN_UTC) {
                newest_seen = Some(remote.modified_time);
            }
            let is_known = known_file_ids.contains(&remote.id);
            // Boundary-skip only applies to *known* ids — a file newly
            // shared with the integration may carry an old
            // `last_modified` (Figma stamps it at the last edit, not at
            // share-time), and we still need to surface it as `added`
            // on the first sweep after it appears.
            if is_known {
                if let Some(bound) = boundary {
                    if remote.modified_time <= bound {
                        continue;
                    }
                }
                result.modified.push(remote);
            } else {
                result.added.push(remote);
            }
        }
        // Anything the caller previously knew about that's no longer
        // listed has been deleted, moved out of the team, or had its
        // permissions revoked — drop it locally.
        for known in known_file_ids {
            if !seen_ids.contains(known) {
                result.removed.push(known.clone());
            }
        }

        result.new_change_token = newest_seen
            .map(|dt| dt.to_rfc3339())
            .or_else(|| boundary.map(|dt| dt.to_rfc3339()));
        result.has_more = false;

        self.last_sync = Some(Utc::now());
        // NET file-count via the shared `SyncResult::apply_to_file_count`
        // helper — see its docstring for the rationale.
        self.file_count = result.apply_to_file_count(self.file_count);
        self.status = ConnectorStatus::Connected;
        Ok(result)
    }

    /// Revoke local OAuth state.
    ///
    /// Figma exposes no token-revocation endpoint, so this is
    /// logically synchronous.  We keep the `async` signature so the
    /// desktop disconnect flow can `.await` every provider through
    /// one uniform path (Google Drive's `revoke()` does hit network).
    #[allow(clippy::unused_async)]
    pub async fn revoke(&mut self) -> ConnectorResult<()> {
        // Figma exposes no token-revocation endpoint; the user removes
        // the app via Figma → Settings → Connected apps. Clear local
        // state so we present as Disconnected.
        self.access_token = None;
        self.refresh_token = None;
        self.client_id = None;
        self.client_secret = None;
        self.team_id = None;
        self.token_expiry = None;
        self.last_sync = None;
        self.file_count = 0;
        self.status = ConnectorStatus::Disconnected;
        Ok(())
    }
}

impl Default for FigmaConnector {
    fn default() -> Self {
        Self::new()
    }
}

impl crate::traits::RemoteConnector for FigmaConnector {
    fn provider_name(&self) -> &'static str {
        FigmaConnector::provider_name(self)
    }
    fn status(&self) -> ConnectorStatus {
        FigmaConnector::status(self)
    }
    fn last_sync_time(&self) -> Option<DateTime<Utc>> {
        FigmaConnector::last_sync_time(self)
    }
    fn file_count(&self) -> u64 {
        FigmaConnector::file_count(self)
    }
}

// `StatusCode` is a 2-byte newtype around `u16` — cheaper to pass by
// value (Clippy: `trivially_copy_pass_by_ref`).
fn handle_common_errors(status: reqwest::StatusCode) -> ConnectorResult<()> {
    match status.as_u16() {
        401 => Err(ConnectorError::TokenExpired),
        403 => Err(ConnectorError::PermissionDenied(
            "Figma returned 403".to_string(),
        )),
        429 => Err(ConnectorError::RateLimited {
            retry_after_secs: 60,
        }),
        _ => Ok(()),
    }
}

fn parse_rfc3339_or_now(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).map_or_else(|_| Utc::now(), |dt| dt.with_timezone(&Utc))
}

fn figma_file_to_remote(f: &FigmaFile, project_id: &str) -> RemoteFile {
    let modified = f
        .last_modified
        .as_deref()
        .map_or_else(Utc::now, parse_rfc3339_or_now);
    RemoteFile {
        id: f.key.clone(),
        name: f.name.clone().unwrap_or_else(|| f.key.clone()),
        mime_type: "application/vnd.figma.file".to_string(),
        size_bytes: 0,
        modified_time: modified,
        created_time: None,
        parent_id: Some(project_id.to_string()),
        web_view_link: Some(format!("https://www.figma.com/file/{}", f.key)),
        is_folder: false,
        md5_checksum: None,
        permissions: Vec::new(),
    }
}

fn walk_figma_node(node: &serde_json::Value, out: &mut Vec<String>) {
    if let Some(node_type) = node.get("type").and_then(|t| t.as_str()) {
        if node_type == "TEXT" {
            if let Some(chars) = node.get("characters").and_then(|c| c.as_str()) {
                out.push(chars.to_string());
            }
        }
    }
    if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
        for child in children {
            walk_figma_node(child, out);
        }
    }
}

// --- Wire types ------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct FigmaTokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[allow(dead_code)]
    #[serde(default)]
    user_id: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct FigmaProjectsResponse {
    #[serde(default)]
    projects: Vec<FigmaProject>,
}

#[derive(Debug, Deserialize)]
struct FigmaProject {
    id: String,
    #[allow(dead_code)]
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FigmaFilesResponse {
    #[serde(default)]
    files: Vec<FigmaFile>,
}

#[derive(Debug, Deserialize)]
struct FigmaFile {
    key: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    last_modified: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn connector_starts_disconnected() {
        let c = FigmaConnector::new();
        assert_eq!(c.status(), ConnectorStatus::Disconnected);
        assert_eq!(c.provider_name(), "figma");
    }

    #[test]
    fn build_auth_url_default_scope_is_files_read() {
        let c = FigmaConnector::new();
        let cfg = AuthConfig::new("cid".into(), "sec".into(), "http://localhost/cb".into());
        let url = c.build_auth_url(&cfg);
        assert!(url.contains("client_id=cid"));
        assert!(url.contains("scope=files%3Aread"));
        assert!(url.contains("response_type=code"));
    }

    #[test]
    fn walk_figma_node_collects_text() {
        let doc = serde_json::json!({
            "type": "DOCUMENT",
            "children": [
                {"type": "CANVAS", "children": [
                    {"type": "TEXT", "characters": "Hello"},
                    {"type": "TEXT", "characters": "World"}
                ]}
            ]
        });
        let mut texts: Vec<String> = Vec::new();
        walk_figma_node(&doc, &mut texts);
        assert_eq!(texts, vec!["Hello", "World"]);
    }

    #[tokio::test]
    async fn list_files_lists_projects_then_files() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/teams/team-1/projects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "projects": [
                    {"id": "proj-1", "name": "Designs"}
                ]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/projects/proj-1/files"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "files": [
                    {"key": "abc123", "name": "Wireframes", "last_modified": "2024-06-01T10:00:00Z"}
                ]
            })))
            .mount(&server)
            .await;

        let mut c = FigmaConnector::with_base_url(&server.uri());
        c.set_access_token("AT", 3600);
        c.set_team_id("team-1");
        let files = c.list_files(None).await.expect("ok");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].id, "abc123");
        assert_eq!(files[0].parent_id.as_deref(), Some("proj-1"));
    }

    #[tokio::test]
    async fn refresh_returns_token_revoked_on_400() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/oauth/refresh"))
            .respond_with(
                ResponseTemplate::new(400)
                    .set_body_json(serde_json::json!({"error": "invalid_grant"})),
            )
            .mount(&server)
            .await;
        let mut c = FigmaConnector::with_base_url(&server.uri());
        c.client_id = Some("cid".into());
        c.client_secret = Some("sec".into());
        c.refresh_token = Some("stale".into());
        let err = c.refresh_access_token().await.unwrap_err();
        assert!(matches!(err, ConnectorError::TokenRevoked));
    }
}
