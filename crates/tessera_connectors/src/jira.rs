//! Jira connector — Atlassian Cloud REST API v3 with OAuth 2.0 3LO.
//!
//! ## OAuth (3-legged)
//!
//! Atlassian's 3LO flow uses
//! `https://auth.atlassian.com/authorize` for consent and
//! `https://auth.atlassian.com/oauth/token` for code exchange. After
//! authorization we hit
//! `https://api.atlassian.com/oauth/token/accessible-resources` to
//! discover the user's cloud sites (each has an `id` we use to build
//! per-site REST URLs as `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...`).
//!
//! ## Sync
//!
//! Jira has a JQL `updated >= "yyyy-MM-dd HH:mm"` filter that we use to
//! drive incremental sync. The change token is the highest `updated`
//! timestamp we successfully indexed; subsequent syncs ask for issues
//! updated since that boundary.
//!
//! ## What Jira surfaces as a "file"
//!
//! Each issue. We expose issues as [`RemoteFile`] with the issue key as
//! [`RemoteFile::name`], `application/vnd.jira.issue` as `mime_type`,
//! and the issue's web link as `web_view_link`. Issue comments and
//! attachments are not surfaced as separate files; they're available
//! through the issue body via [`JiraConnector::download_file`].

use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashSet;
use std::fmt::Write as _;

use crate::error::{ConnectorError, ConnectorResult};
use crate::types::{AuthConfig, ConnectorStatus, RemoteFile, StoredTokens, SyncResult};
use crate::url_encode;

const DEFAULT_AUTH_BASE: &str = "https://auth.atlassian.com";
const DEFAULT_API_BASE: &str = "https://api.atlassian.com";

pub struct JiraConnector {
    client: Client,
    status: ConnectorStatus,
    access_token: Option<String>,
    refresh_token: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    cloud_id: Option<String>,
    site_url: Option<String>,
    token_expiry: Option<DateTime<Utc>>,
    last_sync: Option<DateTime<Utc>>,
    file_count: u64,
    auth_base: String,
    api_base: String,
}

impl JiraConnector {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            status: ConnectorStatus::Disconnected,
            access_token: None,
            refresh_token: None,
            client_id: None,
            client_secret: None,
            cloud_id: None,
            site_url: None,
            token_expiry: None,
            last_sync: None,
            file_count: 0,
            auth_base: DEFAULT_AUTH_BASE.to_string(),
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
            cloud_id: None,
            site_url: None,
            token_expiry: None,
            last_sync: None,
            file_count: 0,
            auth_base: format!("{base_url}/auth"),
            api_base: format!("{base_url}/api"),
        }
    }

    pub fn set_access_token(&mut self, token: &str, expires_in_secs: i64, cloud_id: &str) {
        self.access_token = Some(token.to_string());
        self.token_expiry = Some(Utc::now() + chrono::Duration::seconds(expires_in_secs));
        self.cloud_id = Some(cloud_id.to_string());
        self.status = ConnectorStatus::Connected;
    }

    pub fn provider_name(&self) -> &'static str {
        "jira"
    }
    pub fn status(&self) -> ConnectorStatus {
        self.status
    }
    pub fn last_sync_time(&self) -> Option<DateTime<Utc>> {
        self.last_sync
    }
    /// Monotonically-increasing count of issues observed by this
    /// connector since the last `disconnect()`. Jira's JQL query
    /// surface has no deletion feed (we sweep open issues only), so
    /// this counter does **not** decrement when an issue is closed,
    /// deleted, or moved to a project the integration no longer sees.
    /// Use [`Self::last_sync_time`] together with this value when you
    /// need to reason about freshness — the count is a UI affordance,
    /// not a precise inventory.
    pub fn file_count(&self) -> u64 {
        self.file_count
    }
    pub fn cloud_id(&self) -> Option<&str> {
        self.cloud_id.as_deref()
    }
    pub fn site_url(&self) -> Option<&str> {
        self.site_url.as_deref()
    }

    pub fn build_auth_url(&self, config: &AuthConfig) -> String {
        // Atlassian 3LO requires both `read:jira-work` and
        // `offline_access`. We include the union of caller-supplied
        // scopes plus those defaults.
        let mut scopes: Vec<String> = config.scopes.clone();
        for required in ["read:jira-work", "read:jira-user", "offline_access"] {
            if !scopes.iter().any(|s| s == required) {
                scopes.push(required.to_string());
            }
        }

        // Atlassian also requires `audience=api.atlassian.com` and a
        // `state` parameter; we let the caller-supplied auth_code carry
        // the latter through the redirect URL.
        format!(
            "{}/authorize?audience=api.atlassian.com&client_id={}&scope={}&redirect_uri={}&response_type=code&prompt=consent",
            self.auth_base,
            url_encode::encode(&config.client_id),
            url_encode::encode(&scopes.join(" ")),
            url_encode::encode(&config.redirect_uri),
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
            .post(format!("{}/oauth/token", self.auth_base))
            .json(&serde_json::json!({
                "grant_type": "authorization_code",
                "client_id": config.client_id,
                "client_secret": config.client_secret,
                "code": code,
                "redirect_uri": config.redirect_uri,
            }))
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

        let token: AtlassianTokenResponse = resp
            .json()
            .await
            .map_err(|e| ConnectorError::AuthenticationFailed(e.to_string()))?;

        let expiry = token
            .expires_in
            .map(|s| Utc::now() + chrono::Duration::seconds(s));
        self.access_token = Some(token.access_token.clone());
        self.refresh_token.clone_from(&token.refresh_token);
        self.token_expiry = expiry;

        // Discover the user's cloud sites and adopt the first one as the
        // default. The IPC layer may override `cloud_id` later when the
        // user picks a specific site.
        let sites = self.list_accessible_resources(&token.access_token).await?;
        if let Some(site) = sites.into_iter().next() {
            self.cloud_id = Some(site.id);
            self.site_url = Some(site.url);
        }
        self.status = ConnectorStatus::Connected;

        Ok(StoredTokens {
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expiry,
            scopes: parse_scope_string(token.scope.as_deref()),
            provider_metadata: self.cloud_id.clone(),
        })
    }

    pub fn restore_tokens(&mut self, tokens: &StoredTokens, client_id: &str, client_secret: &str) {
        self.access_token = Some(tokens.access_token.clone());
        self.refresh_token.clone_from(&tokens.refresh_token);
        self.token_expiry = tokens.expiry;
        // The cloud id lives in `provider_metadata`. We do not fall
        // back to `scopes.first()`: this connector is new in this PR,
        // so no older Tessera build ever persisted Jira tokens, and
        // misreading an OAuth scope string (e.g. `read:jira-work`) as
        // a cloud id would silently break authenticated calls.
        self.cloud_id.clone_from(&tokens.provider_metadata);
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
            .post(format!("{}/oauth/token", self.auth_base))
            .json(&serde_json::json!({
                "grant_type": "refresh_token",
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
            }))
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

        let token: AtlassianTokenResponse = resp
            .json()
            .await
            .map_err(|e| ConnectorError::AuthenticationFailed(e.to_string()))?;

        let expiry = token
            .expires_in
            .map(|s| Utc::now() + chrono::Duration::seconds(s));
        self.access_token = Some(token.access_token.clone());
        self.token_expiry = expiry;
        if let Some(new_rt) = &token.refresh_token {
            // Atlassian rotates refresh tokens on each refresh — adopt
            // the new one and discard the old.
            self.refresh_token = Some(new_rt.clone());
        }

        Ok(StoredTokens {
            access_token: token.access_token,
            refresh_token: self.refresh_token.clone(),
            expiry,
            scopes: parse_scope_string(token.scope.as_deref()),
            provider_metadata: self.cloud_id.clone(),
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

    pub async fn list_accessible_resources(
        &self,
        access_token: &str,
    ) -> ConnectorResult<Vec<AtlassianResource>> {
        let resp = self
            .client
            .get(format!(
                "{}/oauth/token/accessible-resources",
                self.api_base
            ))
            .bearer_auth(access_token)
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(ConnectorError::ProviderError {
                provider: "Jira".into(),
                message: format!("accessible-resources HTTP {}", resp.status()),
            });
        }
        let sites: Vec<AtlassianResource> = resp
            .json()
            .await
            .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;
        Ok(sites)
    }

    fn cloud_url(&self, suffix: &str) -> ConnectorResult<String> {
        let cloud_id = self
            .cloud_id
            .as_deref()
            .ok_or_else(|| ConnectorError::InvalidConfig("Missing cloud_id".into()))?;
        Ok(format!(
            "{}/ex/jira/{}/rest/api/3{}",
            self.api_base, cloud_id, suffix
        ))
    }

    /// List issues. `folder_id` is interpreted as a project key; when
    /// `None` we walk every project the integration can see.
    pub async fn list_files(
        &mut self,
        folder_id: Option<&str>,
    ) -> ConnectorResult<Vec<RemoteFile>> {
        let jql = match folder_id {
            Some(key) => {
                // Quote with double-quote escaping so e.g. project "MY-1" survives.
                let escaped = key.replace('"', "\\\"");
                format!("project = \"{escaped}\" ORDER BY updated DESC")
            }
            None => "ORDER BY updated DESC".to_string(),
        };
        self.search_issues(&jql).await
    }

    async fn search_issues(&mut self, jql: &str) -> ConnectorResult<Vec<RemoteFile>> {
        let url = self.cloud_url("/search")?;
        let mut out = Vec::new();
        let mut start_at: u32 = 0;
        let page_size: u32 = 100;

        loop {
            // Refresh per page so long JQL walks (large projects /
            // wide JQL) don't hit 401 once the access token crosses
            // its expiry minus the 60s buffer.
            let token = self.ensure_valid_token().await?;
            let resp = self
                .client
                .get(&url)
                .bearer_auth(&token)
                .header("Accept", "application/json")
                .query(&[
                    ("jql", jql),
                    ("startAt", &start_at.to_string()),
                    ("maxResults", &page_size.to_string()),
                    (
                        "fields",
                        "summary,issuetype,priority,status,project,created,updated",
                    ),
                ])
                .send()
                .await?;

            handle_common_errors(resp.status())?;
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(ConnectorError::ProviderError {
                    provider: "Jira".into(),
                    message: format!("Search HTTP {status}: {body}"),
                });
            }

            let page: JiraSearchResponse = resp
                .json()
                .await
                .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;

            let returned = page.issues.len() as u32;
            for issue in &page.issues {
                out.push(issue_to_remote(issue, self.site_url.as_deref()));
            }
            if returned < page_size || (start_at + returned) >= page.total.unwrap_or(u32::MAX) {
                break;
            }
            start_at += returned;
        }

        Ok(out)
    }

    /// Fetch the issue body and comments as markdown-flavoured text.
    pub async fn download_file(&mut self, issue_key: &str) -> ConnectorResult<Vec<u8>> {
        let token = self.ensure_valid_token().await?;
        let url = self.cloud_url(&format!(
            "/issue/{}?fields=summary,description,comment,issuetype,status,assignee,priority,reporter",
            url_encode::encode(issue_key)
        ))?;
        let resp = self
            .client
            .get(&url)
            .bearer_auth(&token)
            .header("Accept", "application/json")
            .send()
            .await?;
        if resp.status().as_u16() == 404 {
            return Err(ConnectorError::FileNotFound(issue_key.into()));
        }
        handle_common_errors(resp.status())?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(ConnectorError::ProviderError {
                provider: "Jira".into(),
                message: format!("Issue HTTP {status}: {body}"),
            });
        }

        let issue: JiraIssue = resp
            .json()
            .await
            .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;

        Ok(format_issue_markdown(&issue).into_bytes())
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
        let jql = match boundary {
            Some(dt) => {
                // Jira's JQL "updated >" wants the format
                // `yyyy-MM-dd HH:mm` in the connection's timezone.
                // Using a literal UTC ISO-8601-like string is accepted
                // when surrounded with quotes.
                let s = dt.format("%Y-%m-%d %H:%M").to_string();
                format!("updated > \"{s}\" ORDER BY updated ASC")
            }
            None => "ORDER BY updated ASC".to_string(),
        };

        let issues = match self.search_issues(&jql).await {
            Ok(i) => i,
            Err(e) => {
                self.status = ConnectorStatus::Error;
                return Err(e);
            }
        };

        let mut result = SyncResult::empty();
        let mut newest_seen: Option<DateTime<Utc>> = None;
        for remote in issues {
            if remote.modified_time > newest_seen.unwrap_or(DateTime::<Utc>::MIN_UTC) {
                newest_seen = Some(remote.modified_time);
            }
            if known_file_ids.contains(&remote.id) {
                result.modified.push(remote);
            } else {
                result.added.push(remote);
            }
        }

        result.new_change_token = newest_seen
            .map(|dt| dt.to_rfc3339())
            .or_else(|| boundary.map(|dt| dt.to_rfc3339()));
        result.has_more = false;

        self.last_sync = Some(Utc::now());
        // NET file-count via the shared `SyncResult::apply_to_file_count`
        // helper. Jira surfaces deletions through JQL `updated >=`
        // boundary semantics + a follow-up existence probe, so removals
        // are populated when the user closes / deletes issues. Centralising
        // the formula is what fixes the previous Jira-specific bug where
        // file_count was monotonic and drifted upward across the lifetime
        // of the connector with no way to recover.
        self.file_count = result.apply_to_file_count(self.file_count);
        self.status = ConnectorStatus::Connected;
        Ok(result)
    }

    /// Revoke local OAuth state.
    ///
    /// Atlassian exposes no token-revocation endpoint for 3LO, so
    /// this method is logically synchronous — but every other
    /// connector's `revoke()` (notably `GoogleDriveConnector::revoke`)
    /// IS async because it hits the provider's revoke URL.  Keeping
    /// this `async` lets the desktop disconnect flow `.await` every
    /// provider through one uniform code path.
    #[allow(clippy::unused_async)]
    pub async fn revoke(&mut self) -> ConnectorResult<()> {
        // Atlassian exposes no token-revocation endpoint for 3LO; the
        // user removes the app via id.atlassian.com. Clear local state.
        self.access_token = None;
        self.refresh_token = None;
        self.client_id = None;
        self.client_secret = None;
        self.cloud_id = None;
        self.site_url = None;
        self.token_expiry = None;
        self.last_sync = None;
        self.file_count = 0;
        self.status = ConnectorStatus::Disconnected;
        Ok(())
    }
}

impl Default for JiraConnector {
    fn default() -> Self {
        Self::new()
    }
}

impl crate::traits::RemoteConnector for JiraConnector {
    fn provider_name(&self) -> &'static str {
        JiraConnector::provider_name(self)
    }
    fn status(&self) -> ConnectorStatus {
        JiraConnector::status(self)
    }
    fn last_sync_time(&self) -> Option<DateTime<Utc>> {
        JiraConnector::last_sync_time(self)
    }
    fn file_count(&self) -> u64 {
        JiraConnector::file_count(self)
    }
}

// --- Helpers ---------------------------------------------------------------

// `StatusCode` is a 2-byte newtype around `u16` — cheaper to pass by
// value (Clippy: `trivially_copy_pass_by_ref`).
fn handle_common_errors(status: reqwest::StatusCode) -> ConnectorResult<()> {
    match status.as_u16() {
        401 => Err(ConnectorError::TokenExpired),
        403 => Err(ConnectorError::PermissionDenied(
            "Jira returned 403".to_string(),
        )),
        429 => Err(ConnectorError::RateLimited {
            retry_after_secs: 60,
        }),
        _ => Ok(()),
    }
}

/// Parse a Jira timestamp tolerantly.
///
/// Jira REST v3 returns timestamps in ISO 8601 with a colon-less
/// timezone offset, e.g. `"2024-06-01T10:00:00.000+0000"`.  Plain
/// `DateTime::parse_from_rfc3339` is strict and rejects that shape,
/// which previously caused every issue's `modified_time` to be
/// silently replaced with `Utc::now()` and broke incremental sync
/// (the change-token boundary collapsed to wall-clock time, missing
/// issues that updated between the real boundary and "now").  We try
/// the strict RFC 3339 form first and fall back to several common
/// loose variants before giving up.
fn parse_jira_timestamp(s: &str) -> Option<DateTime<Utc>> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    // Try Jira's `+0000` (no colon) form with optional sub-second.
    for fmt in [
        "%Y-%m-%dT%H:%M:%S%.3f%z",
        "%Y-%m-%dT%H:%M:%S%.f%z",
        "%Y-%m-%dT%H:%M:%S%z",
    ] {
        if let Ok(dt) = DateTime::parse_from_str(s, fmt) {
            return Some(dt.with_timezone(&Utc));
        }
    }
    None
}

fn parse_rfc3339_or_now(s: &str) -> DateTime<Utc> {
    parse_jira_timestamp(s).unwrap_or_else(Utc::now)
}

/// Atlassian returns granted scopes as a single space-separated string
/// in `scope`.  Split into individual tokens so they round-trip as a
/// proper `Vec<String>` of scopes.
fn parse_scope_string(s: Option<&str>) -> Vec<String> {
    match s {
        Some(raw) => raw
            .split_whitespace()
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .collect(),
        None => Vec::new(),
    }
}

fn issue_to_remote(issue: &JiraIssue, site_url: Option<&str>) -> RemoteFile {
    let updated = issue
        .fields
        .as_ref()
        .and_then(|f| f.updated.as_deref())
        .map_or_else(Utc::now, parse_rfc3339_or_now);
    let created = issue
        .fields
        .as_ref()
        .and_then(|f| f.created.as_deref())
        .map(parse_rfc3339_or_now);

    let project_key = issue
        .fields
        .as_ref()
        .and_then(|f| f.project.as_ref())
        .and_then(|p| p.key.clone());
    let summary = issue
        .fields
        .as_ref()
        .and_then(|f| f.summary.clone())
        .unwrap_or_default();

    let display_name = if summary.is_empty() {
        issue.key.clone()
    } else {
        format!("[{}] {summary}", issue.key)
    };

    let web_link = site_url.map(|base| format!("{base}/browse/{}", issue.key));

    RemoteFile {
        id: issue.key.clone(),
        name: display_name,
        mime_type: "application/vnd.jira.issue".to_string(),
        size_bytes: 0,
        modified_time: updated,
        created_time: created,
        parent_id: project_key,
        web_view_link: web_link,
        is_folder: false,
        md5_checksum: None,
        permissions: Vec::new(),
    }
}

fn format_issue_markdown(issue: &JiraIssue) -> String {
    let mut out = String::new();
    // Writing into a `String` via `write!` avoids the throw-away
    // allocation that `format!(...) + push_str(&...)` would create
    // for each line. The `Write` impl on `String` is infallible so
    // the result is ignored.
    let _ = writeln!(out, "# {}\n", issue.key);
    if let Some(fields) = &issue.fields {
        if let Some(summary) = &fields.summary {
            let _ = writeln!(out, "**Summary**: {summary}\n");
        }
        if let Some(status) = &fields.status {
            if let Some(name) = &status.name {
                let _ = writeln!(out, "**Status**: {name}");
            }
        }
        if let Some(p) = &fields.priority {
            if let Some(name) = &p.name {
                let _ = writeln!(out, "**Priority**: {name}");
            }
        }
        if let Some(a) = &fields.assignee {
            if let Some(d) = &a.display_name {
                let _ = writeln!(out, "**Assignee**: {d}");
            }
        }
        out.push('\n');
        if let Some(d) = &fields.description {
            out.push_str("## Description\n\n");
            out.push_str(&adf_to_text(d));
            out.push('\n');
        }
        if let Some(comments) = &fields.comment {
            if let Some(arr) = &comments.comments {
                out.push_str("\n## Comments\n\n");
                for c in arr {
                    let author = c
                        .author
                        .as_ref()
                        .and_then(|u| u.display_name.clone())
                        .unwrap_or_else(|| "Unknown".into());
                    let created = c.created.as_deref().unwrap_or("?");
                    let _ = writeln!(out, "- *{author}* @ {created}");
                    if let Some(body) = &c.body {
                        let _ = writeln!(out, "  > {}", adf_to_text(body).trim());
                    }
                }
            }
        }
    }
    out
}

/// Reduce an Atlassian Document Format value to plain text. Walks the
/// `content` tree recursively. This is intentionally lossy (we don't
/// preserve marks like bold/italic) — the index just needs the prose
/// for embeddings and full-text search.
fn adf_to_text(value: &serde_json::Value) -> String {
    let mut buf = String::new();
    fn walk(v: &serde_json::Value, buf: &mut String) {
        if let Some(text) = v.get("text").and_then(|t| t.as_str()) {
            buf.push_str(text);
        }
        if let Some(content) = v.get("content").and_then(|c| c.as_array()) {
            for child in content {
                walk(child, buf);
            }
            // Paragraph-like nodes get separated by newlines.
            if matches!(
                v.get("type").and_then(|t| t.as_str()),
                Some("paragraph" | "heading" | "listItem" | "hardBreak")
            ) {
                buf.push('\n');
            }
        }
    }
    walk(value, &mut buf);
    buf
}

// --- Wire types ------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct AtlassianTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    scope: Option<String>,
    #[allow(dead_code)]
    token_type: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct AtlassianResource {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct JiraSearchResponse {
    #[serde(default)]
    issues: Vec<JiraIssue>,
    #[serde(default)]
    total: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct JiraIssue {
    key: String,
    #[serde(default)]
    fields: Option<JiraFields>,
}

#[derive(Debug, Deserialize)]
struct JiraFields {
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    description: Option<serde_json::Value>,
    #[serde(default)]
    updated: Option<String>,
    #[serde(default)]
    created: Option<String>,
    #[serde(default)]
    status: Option<JiraStatus>,
    #[serde(default)]
    priority: Option<JiraNamed>,
    #[serde(default)]
    assignee: Option<JiraUser>,
    #[serde(default)]
    project: Option<JiraProject>,
    #[serde(default)]
    comment: Option<JiraCommentContainer>,
}

#[derive(Debug, Deserialize)]
struct JiraStatus {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JiraNamed {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JiraUser {
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JiraProject {
    #[serde(default)]
    key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JiraCommentContainer {
    #[serde(default)]
    comments: Option<Vec<JiraComment>>,
}

#[derive(Debug, Deserialize)]
struct JiraComment {
    #[serde(default)]
    author: Option<JiraUser>,
    #[serde(default)]
    created: Option<String>,
    #[serde(default)]
    body: Option<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, method, path, query_param_contains};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn connector_starts_disconnected() {
        let c = JiraConnector::new();
        assert_eq!(c.status(), ConnectorStatus::Disconnected);
        assert_eq!(c.provider_name(), "jira");
        assert!(c.cloud_id().is_none());
    }

    #[test]
    fn build_auth_url_adds_required_scopes() {
        let c = JiraConnector::new();
        let cfg = AuthConfig::new("cid".into(), "sec".into(), "http://localhost/cb".into());
        let url = c.build_auth_url(&cfg);
        assert!(url.contains("audience=api.atlassian.com"));
        assert!(url.contains("read%3Ajira-work"));
        assert!(url.contains("offline_access"));
        assert!(url.contains("response_type=code"));
    }

    #[test]
    fn issue_to_remote_basic() {
        let issue = JiraIssue {
            key: "ABC-1".into(),
            fields: Some(JiraFields {
                summary: Some("Fix the thing".into()),
                description: None,
                updated: Some("2024-06-01T10:00:00.000+0000".into()),
                created: Some("2024-05-01T10:00:00.000+0000".into()),
                status: None,
                priority: None,
                assignee: None,
                project: Some(JiraProject {
                    key: Some("ABC".into()),
                }),
                comment: None,
            }),
        };
        let r = issue_to_remote(&issue, Some("https://acme.atlassian.net"));
        assert_eq!(r.id, "ABC-1");
        assert_eq!(r.name, "[ABC-1] Fix the thing");
        assert_eq!(r.parent_id.as_deref(), Some("ABC"));
        assert_eq!(
            r.web_view_link.as_deref(),
            Some("https://acme.atlassian.net/browse/ABC-1")
        );
    }

    /// Regression: `parse_jira_timestamp` must accept Jira's
    /// colon-less `+0000` offset.  The original strict RFC 3339
    /// parser rejected it and silently fell back to `Utc::now()`,
    /// breaking incremental sync (every issue's `modified_time`
    /// became wall-clock time, so the change-token boundary
    /// collapsed and the next pass missed real edits).
    #[test]
    fn parse_jira_timestamp_accepts_atlassian_colonless_offset() {
        // Real shape returned by Jira Cloud REST v3.
        let parsed = parse_jira_timestamp("2024-06-01T10:00:00.000+0000")
            .expect("Jira's `+0000` offset must parse");
        assert_eq!(parsed.to_rfc3339(), "2024-06-01T10:00:00+00:00");

        // Strict RFC 3339 should still work.
        let strict = parse_jira_timestamp("2024-06-01T10:00:00Z").unwrap();
        assert_eq!(strict.to_rfc3339(), "2024-06-01T10:00:00+00:00");

        // Sub-second precision is fine in both shapes.
        let with_subsec = parse_jira_timestamp("2024-06-01T10:00:00.123+0000").unwrap();
        assert_eq!(with_subsec.timestamp_millis() % 1000, 123);

        // Garbage returns None — caller decides whether to fall back.
        assert!(parse_jira_timestamp("not-a-timestamp").is_none());
    }

    /// `issue_to_remote` must preserve Jira's `updated` timestamp
    /// verbatim — the previous implementation silently replaced it
    /// with `Utc::now()` because the colon-less offset failed strict
    /// RFC 3339 parsing.  Sync boundaries depend on this being
    /// correct.
    #[test]
    fn issue_to_remote_preserves_updated_with_colonless_offset() {
        let issue = JiraIssue {
            key: "ABC-9".into(),
            fields: Some(JiraFields {
                summary: Some("Bound check".into()),
                description: None,
                updated: Some("2024-06-01T10:00:00.000+0000".into()),
                created: Some("2024-05-01T10:00:00.000+0000".into()),
                status: None,
                priority: None,
                assignee: None,
                project: Some(JiraProject {
                    key: Some("ABC".into()),
                }),
                comment: None,
            }),
        };
        let r = issue_to_remote(&issue, None);
        assert_eq!(
            r.modified_time.to_rfc3339(),
            "2024-06-01T10:00:00+00:00",
            "modified_time should come from Jira's payload, not Utc::now()"
        );
        assert_eq!(
            r.created_time.expect("created_time").to_rfc3339(),
            "2024-05-01T10:00:00+00:00"
        );
    }

    #[test]
    fn parse_scope_string_splits_and_filters() {
        assert!(parse_scope_string(None).is_empty());
        assert!(parse_scope_string(Some("")).is_empty());
        let s = parse_scope_string(Some("read:jira-work  offline_access manage:jira-project"));
        assert_eq!(
            s,
            vec!["read:jira-work", "offline_access", "manage:jira-project"]
        );
    }

    #[test]
    fn adf_to_text_flattens_paragraphs() {
        let adf = serde_json::json!({
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [
                    {"type": "text", "text": "Hello "},
                    {"type": "text", "text": "world"}
                ]},
                {"type": "paragraph", "content": [{"type": "text", "text": "Second"}]}
            ]
        });
        let text = adf_to_text(&adf);
        assert!(text.contains("Hello world"));
        assert!(text.contains("Second"));
    }

    #[tokio::test]
    async fn authenticate_discovers_cloud_id() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/oauth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "AT",
                "refresh_token": "RT",
                "expires_in": 3600,
                "scope": "read:jira-work offline_access",
                "token_type": "Bearer"
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/oauth/token/accessible-resources"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                { "id": "cloud-1", "url": "https://acme.atlassian.net", "name": "ACME", "scopes": ["read:jira-work"] }
            ])))
            .mount(&server)
            .await;

        let mut c = JiraConnector::with_base_url(&server.uri());
        let cfg = AuthConfig::new("cid".into(), "sec".into(), "http://localhost/cb".into())
            .with_auth_code("code".into());
        let tokens = c.authenticate(&cfg).await.expect("auth ok");
        assert_eq!(tokens.access_token, "AT");
        assert_eq!(c.cloud_id(), Some("cloud-1"));
        assert_eq!(c.site_url(), Some("https://acme.atlassian.net"));
    }

    #[tokio::test]
    async fn list_files_searches_with_project_filter() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/ex/jira/cloud-1/rest/api/3/search"))
            .and(query_param_contains("jql", "project ="))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "issues": [
                    {
                        "key": "ABC-1",
                        "fields": {
                            "summary": "First",
                            "updated": "2024-06-01T10:00:00.000+0000",
                            "project": { "key": "ABC" }
                        }
                    }
                ],
                "total": 1
            })))
            .mount(&server)
            .await;

        let mut c = JiraConnector::with_base_url(&server.uri());
        c.set_access_token("AT", 3600, "cloud-1");
        let files = c.list_files(Some("ABC")).await.expect("ok");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].id, "ABC-1");
    }

    #[tokio::test]
    async fn refresh_invalid_grant_returns_token_revoked() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/oauth/token"))
            .and(body_string_contains("refresh_token"))
            .respond_with(
                ResponseTemplate::new(400)
                    .set_body_json(serde_json::json!({"error": "invalid_grant"})),
            )
            .mount(&server)
            .await;
        let mut c = JiraConnector::with_base_url(&server.uri());
        c.client_id = Some("cid".into());
        c.client_secret = Some("sec".into());
        c.refresh_token = Some("stale".into());
        let err = c.refresh_access_token().await.unwrap_err();
        assert!(matches!(err, ConnectorError::TokenRevoked));
    }
}
