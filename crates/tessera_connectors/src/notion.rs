//! Notion connector — uses Notion's public REST API (`https://api.notion.com/v1`).
//!
//! ## OAuth
//!
//! Public integrations use the standard OAuth 2.0 code flow against
//! `https://api.notion.com/v1/oauth/token`. Notion uses HTTP Basic with
//! the integration's client id / secret on the token endpoint, plus a
//! JSON body containing the auth code and redirect URI. The access
//! token Notion returns has no expiry (it's a long-lived bot token
//! attached to a workspace), so we record `expires_in = 0` and treat
//! the value as permanent for refresh purposes — there is no refresh
//! token to rotate, and revocation happens out-of-band via the
//! workspace owner.
//!
//! ## Sync
//!
//! Notion lacks a true delta API. The closest thing is the [search][s]
//! endpoint with `last_edited_time` as the sort key — we walk results
//! in descending order and stop the first time we see an item whose
//! `last_edited_time` is older than the previous sync's high-water mark.
//!
//! We store the most recent `last_edited_time` we successfully indexed
//! as the change token; on the next sync that becomes the boundary.
//!
//! [s]: https://developers.notion.com/reference/post-search
//!
//! ## What Notion calls "files"
//!
//! Notion's primitives are pages and databases. We surface both as
//! [`RemoteFile`] entries with `mime_type` set to either
//! `application/vnd.notion.page` or `application/vnd.notion.database`.

use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::error::{ConnectorError, ConnectorResult};
use crate::types::{AuthConfig, ConnectorStatus, RemoteFile, StoredTokens, SyncResult};
use crate::url_encode;

const DEFAULT_AUTH_URL: &str = "https://api.notion.com/v1/oauth/authorize";
const DEFAULT_TOKEN_URL: &str = "https://api.notion.com/v1/oauth/token";
const DEFAULT_API_BASE: &str = "https://api.notion.com/v1";
const NOTION_VERSION: &str = "2022-06-28";

pub struct NotionConnector {
    client: Client,
    status: ConnectorStatus,
    access_token: Option<String>,
    workspace_id: Option<String>,
    bot_id: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    last_sync: Option<DateTime<Utc>>,
    file_count: u64,
    auth_url: String,
    token_url: String,
    api_base: String,
}

impl NotionConnector {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            status: ConnectorStatus::Disconnected,
            access_token: None,
            workspace_id: None,
            bot_id: None,
            client_id: None,
            client_secret: None,
            last_sync: None,
            file_count: 0,
            auth_url: DEFAULT_AUTH_URL.to_string(),
            token_url: DEFAULT_TOKEN_URL.to_string(),
            api_base: DEFAULT_API_BASE.to_string(),
        }
    }

    pub fn with_base_url(base_url: &str) -> Self {
        Self {
            client: Client::new(),
            status: ConnectorStatus::Disconnected,
            access_token: None,
            workspace_id: None,
            bot_id: None,
            client_id: None,
            client_secret: None,
            last_sync: None,
            file_count: 0,
            auth_url: format!("{base_url}/v1/oauth/authorize"),
            token_url: format!("{base_url}/v1/oauth/token"),
            api_base: format!("{base_url}/v1"),
        }
    }

    pub fn set_access_token(&mut self, token: &str) {
        self.access_token = Some(token.to_string());
        self.status = ConnectorStatus::Connected;
    }

    pub fn provider_name(&self) -> &'static str {
        "notion"
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
    pub fn workspace_id(&self) -> Option<&str> {
        self.workspace_id.as_deref()
    }
    pub fn bot_id(&self) -> Option<&str> {
        self.bot_id.as_deref()
    }

    pub fn build_auth_url(&self, config: &AuthConfig) -> String {
        // Notion has no scope concept — integrations declare capabilities
        // up-front in the integration settings page. The auth URL just
        // carries client_id + redirect_uri.
        format!(
            "{}?client_id={}&redirect_uri={}&response_type=code&owner=user",
            self.auth_url,
            url_encode::encode(&config.client_id),
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
            .post(&self.token_url)
            .basic_auth(&config.client_id, Some(&config.client_secret))
            .json(&serde_json::json!({
                "grant_type": "authorization_code",
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

        let token: NotionTokenResponse = resp
            .json()
            .await
            .map_err(|e| ConnectorError::AuthenticationFailed(e.to_string()))?;

        self.access_token = Some(token.access_token.clone());
        self.workspace_id.clone_from(&token.workspace_id);
        self.bot_id.clone_from(&token.bot_id);
        self.status = ConnectorStatus::Connected;

        Ok(StoredTokens {
            access_token: token.access_token,
            // Notion bot tokens don't rotate — refresh_token stays None.
            refresh_token: None,
            expiry: None,
            scopes: Vec::new(),
            provider_metadata: token.workspace_id,
        })
    }

    pub fn restore_tokens(&mut self, tokens: &StoredTokens, client_id: &str, client_secret: &str) {
        self.access_token = Some(tokens.access_token.clone());
        // Prefer the dedicated `provider_metadata` slot. Fall back to
        // `scopes.first()` only for tokens written by older Tessera
        // builds that overloaded `scopes` to store the workspace id.
        self.workspace_id = tokens
            .provider_metadata
            .clone()
            .or_else(|| tokens.scopes.first().cloned());
        self.client_id = Some(client_id.to_string());
        self.client_secret = Some(client_secret.to_string());
        self.status = ConnectorStatus::Connected;
    }

    fn token(&self) -> ConnectorResult<&str> {
        self.access_token
            .as_deref()
            .ok_or(ConnectorError::TokenExpired)
    }

    fn request_get(&self, url: &str) -> ConnectorResult<reqwest::RequestBuilder> {
        let token = self.token()?;
        Ok(self
            .client
            .get(url)
            .bearer_auth(token)
            .header("Notion-Version", NOTION_VERSION))
    }

    fn request_post(
        &self,
        url: &str,
        body: serde_json::Value,
    ) -> ConnectorResult<reqwest::RequestBuilder> {
        let token = self.token()?;
        Ok(self
            .client
            .post(url)
            .bearer_auth(token)
            .header("Notion-Version", NOTION_VERSION)
            .json(&body))
    }

    /// List the pages and databases shared with this integration.
    ///
    /// `folder_id` is interpreted as a Notion database id. When given,
    /// we query that database's children via `/databases/{id}/query`.
    /// When `None`, we walk the workspace-level `/search` endpoint with
    /// no filter and surface every page and database the integration
    /// has been shared with.
    pub async fn list_files(
        &mut self,
        folder_id: Option<&str>,
    ) -> ConnectorResult<Vec<RemoteFile>> {
        match folder_id {
            Some(db) if !db.is_empty() => self.list_database_children(db).await,
            _ => self.list_search(None).await,
        }
    }

    /// Walk the workspace-level `/search` endpoint. `query_text` is a
    /// genuine free-text search (passed straight through to Notion's
    /// `query` parameter); pass `None` to list everything shared with
    /// the integration.
    async fn list_search(&mut self, query_text: Option<&str>) -> ConnectorResult<Vec<RemoteFile>> {
        let mut out = Vec::new();
        let mut start_cursor: Option<String> = None;

        loop {
            let body = build_search_body(query_text, start_cursor.as_deref(), None);
            let resp = self
                .request_post(&format!("{}/search", self.api_base), body)?
                .send()
                .await?;
            handle_common_errors(resp.status())?;
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(ConnectorError::ProviderError {
                    provider: "Notion".into(),
                    message: format!("HTTP {status}: {body}"),
                });
            }

            let page: NotionSearchResponse = resp
                .json()
                .await
                .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;

            for obj in page.results {
                out.push(notion_object_to_remote(&obj));
            }

            if page.has_more.unwrap_or(false) {
                start_cursor = page.next_cursor;
                if start_cursor.is_none() {
                    break;
                }
            } else {
                break;
            }
        }

        Ok(out)
    }

    /// Query a specific database's pages via `/v1/databases/{id}/query`.
    /// This is the right endpoint for "list everything under this
    /// database" — the workspace-level `/search` `query` parameter is a
    /// free-text search, not a database-id filter.
    async fn list_database_children(
        &mut self,
        database_id: &str,
    ) -> ConnectorResult<Vec<RemoteFile>> {
        let mut out = Vec::new();
        let mut start_cursor: Option<String> = None;

        let url = format!(
            "{}/databases/{}/query",
            self.api_base,
            url_encode::encode(database_id)
        );

        loop {
            let mut body = serde_json::Map::new();
            if let Some(cursor) = &start_cursor {
                body.insert(
                    "start_cursor".to_string(),
                    serde_json::Value::String(cursor.clone()),
                );
            }
            let resp = self
                .request_post(&url, serde_json::Value::Object(body))?
                .send()
                .await?;
            handle_common_errors(resp.status())?;
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(ConnectorError::ProviderError {
                    provider: "Notion".into(),
                    message: format!("databases/query HTTP {status}: {body}"),
                });
            }

            let page: NotionSearchResponse = resp
                .json()
                .await
                .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;

            for obj in page.results {
                out.push(notion_object_to_remote(&obj));
            }

            if page.has_more.unwrap_or(false) {
                start_cursor = page.next_cursor;
                if start_cursor.is_none() {
                    break;
                }
            } else {
                break;
            }
        }

        Ok(out)
    }

    /// Download a page's body as markdown-flavoured text.
    ///
    /// The Notion API doesn't expose pages as opaque file content — we
    /// fetch the page's children blocks and emit a markdown
    /// approximation (headings, paragraphs, lists, code blocks). This is
    /// good enough for the indexer's text-extraction stage; rich layouts
    /// (toggles, callouts, equations) are flattened to their plain text.
    pub async fn download_file(&mut self, page_id: &str) -> ConnectorResult<Vec<u8>> {
        let mut out = String::new();
        let mut start_cursor: Option<String> = None;
        loop {
            let url = format!(
                "{}/blocks/{}/children",
                self.api_base,
                url_encode::encode(page_id)
            );
            let mut req = self.request_get(&url)?;
            if let Some(cursor) = &start_cursor {
                req = req.query(&[("start_cursor", cursor.as_str())]);
            }
            let resp = req.send().await?;
            if resp.status().as_u16() == 404 {
                return Err(ConnectorError::FileNotFound(page_id.into()));
            }
            handle_common_errors(resp.status())?;
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(ConnectorError::ProviderError {
                    provider: "Notion".into(),
                    message: format!("Blocks HTTP {status}: {body}"),
                });
            }

            let page: NotionBlocksResponse = resp
                .json()
                .await
                .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;
            for block in &page.results {
                out.push_str(&block_to_markdown(block));
                out.push('\n');
            }

            if page.has_more.unwrap_or(false) && page.next_cursor.is_some() {
                start_cursor = page.next_cursor;
            } else {
                break;
            }
        }

        Ok(out.into_bytes())
    }

    /// Incremental sync — Notion has no delta endpoint, so we use
    /// `search` sorted by `last_edited_time` descending and stop when
    /// we walk past the boundary.
    pub async fn sync_changes(
        &mut self,
        change_token: Option<&str>,
        known_file_ids: &HashSet<String>,
    ) -> ConnectorResult<SyncResult> {
        let boundary: Option<DateTime<Utc>> = change_token
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Utc));

        self.status = ConnectorStatus::Syncing;
        let mut result = SyncResult::empty();
        let mut start_cursor: Option<String> = None;
        let mut newest_seen: Option<DateTime<Utc>> = None;

        'outer: loop {
            let body = build_search_body(None, start_cursor.as_deref(), Some("descending"));
            let resp = match self.request_post(&format!("{}/search", self.api_base), body) {
                Ok(req) => req.send().await,
                Err(e) => {
                    self.status = ConnectorStatus::Error;
                    return Err(e);
                }
            };

            let resp = resp.map_err(|e| ConnectorError::NetworkError(e.to_string()))?;
            if !resp.status().is_success() {
                self.status = ConnectorStatus::Error;
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(ConnectorError::ProviderError {
                    provider: "Notion".into(),
                    message: format!("Sync HTTP {status}: {body}"),
                });
            }

            let page: NotionSearchResponse = resp
                .json()
                .await
                .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;

            for obj in page.results {
                let last_edit = parse_rfc3339_or_now(&obj.last_edited_time);
                if newest_seen.is_none_or(|cur| last_edit > cur) {
                    newest_seen = Some(last_edit);
                }
                if let Some(bound) = boundary {
                    if last_edit <= bound {
                        // We've reached items older than our last sync —
                        // because results are descending, everything past
                        // this point is also old.
                        break 'outer;
                    }
                }
                let remote = notion_object_to_remote(&obj);
                if known_file_ids.contains(&remote.id) {
                    result.modified.push(remote);
                } else {
                    result.added.push(remote);
                }
            }

            if page.has_more.unwrap_or(false) && page.next_cursor.is_some() {
                start_cursor = page.next_cursor;
            } else {
                break;
            }
        }

        // The new change token is the newest last_edited_time we saw, or
        // (if no items at all) the previous boundary so we don't
        // accidentally re-fetch the whole workspace next time.
        result.new_change_token = newest_seen
            .map(|dt| dt.to_rfc3339())
            .or_else(|| boundary.map(|dt| dt.to_rfc3339()));
        result.has_more = false;

        self.last_sync = Some(Utc::now());
        self.file_count = self.file_count.saturating_add(result.added.len() as u64);
        self.status = ConnectorStatus::Connected;
        Ok(result)
    }

    /// Revoke local OAuth state.
    ///
    /// Notion has no public token-revocation endpoint, so this is
    /// logically synchronous.  We keep the `async` signature so the
    /// desktop disconnect flow can `.await` every provider through
    /// one uniform path.
    #[allow(clippy::unused_async)]
    pub async fn revoke(&mut self) -> ConnectorResult<()> {
        // Notion has no public token-revocation endpoint — the workspace
        // owner removes the integration via Notion's UI. We clear local
        // state so the connector is fully disconnected from Tessera's
        // perspective.
        self.access_token = None;
        self.workspace_id = None;
        self.bot_id = None;
        self.client_id = None;
        self.client_secret = None;
        self.last_sync = None;
        self.file_count = 0;
        self.status = ConnectorStatus::Disconnected;
        Ok(())
    }
}

impl Default for NotionConnector {
    fn default() -> Self {
        Self::new()
    }
}

// --- Helpers ---------------------------------------------------------------

// `StatusCode` is a 2-byte newtype around `u16` — cheaper to pass by
// value than by reference (Clippy: `trivially_copy_pass_by_ref`).
fn handle_common_errors(status: reqwest::StatusCode) -> ConnectorResult<()> {
    match status.as_u16() {
        401 => Err(ConnectorError::TokenExpired),
        403 => Err(ConnectorError::PermissionDenied(
            "Notion returned 403 — check that the integration is shared with the target page"
                .to_string(),
        )),
        429 => Err(ConnectorError::RateLimited {
            retry_after_secs: 60,
        }),
        _ => Ok(()),
    }
}

/// Build a body for Notion's workspace-level `/search` endpoint.
///
/// `query` is a genuine free-text search string — use `None` to list
/// every accessible object.  Notion has no database-id filter on this
/// endpoint; for "list pages under database X" call
/// `/databases/{id}/query` instead (see `list_database_children`).
fn build_search_body(
    query: Option<&str>,
    start_cursor: Option<&str>,
    direction: Option<&str>,
) -> serde_json::Value {
    let mut body = serde_json::Map::new();
    if let Some(q) = query {
        body.insert(
            "query".to_string(),
            serde_json::Value::String(q.to_string()),
        );
    }
    if let Some(cursor) = start_cursor {
        body.insert(
            "start_cursor".to_string(),
            serde_json::Value::String(cursor.to_string()),
        );
    }
    body.insert(
        "sort".to_string(),
        serde_json::json!({
            "direction": direction.unwrap_or("descending"),
            "timestamp": "last_edited_time"
        }),
    );
    body.insert(
        "page_size".to_string(),
        serde_json::Value::Number(serde_json::Number::from(50_u32)),
    );
    serde_json::Value::Object(body)
}

fn parse_rfc3339_or_now(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).map_or_else(|_| Utc::now(), |dt| dt.with_timezone(&Utc))
}

fn notion_object_to_remote(o: &NotionObject) -> RemoteFile {
    let is_database = o.object == "database";
    let mime_type = if is_database {
        "application/vnd.notion.database".to_string()
    } else {
        "application/vnd.notion.page".to_string()
    };

    // Title extraction: pages put a `title` property in `properties`;
    // databases put their title array at the top level. We walk both
    // shapes generously.
    let title = extract_title(o);

    let parent_id = o.parent.as_ref().and_then(|p| {
        p.page_id
            .clone()
            .or_else(|| p.database_id.clone())
            .or_else(|| p.block_id.clone())
            .or_else(|| {
                if p.parent_type.as_deref() == Some("workspace") {
                    Some("workspace".to_string())
                } else {
                    None
                }
            })
    });

    RemoteFile {
        id: o.id.clone(),
        name: title.unwrap_or_else(|| format!("Untitled {}", o.object)),
        mime_type,
        size_bytes: 0,
        modified_time: parse_rfc3339_or_now(&o.last_edited_time),
        created_time: o.created_time.as_deref().map(parse_rfc3339_or_now),
        parent_id,
        web_view_link: o.url.clone(),
        is_folder: is_database,
        md5_checksum: None,
        permissions: Vec::new(),
    }
}

fn extract_title(o: &NotionObject) -> Option<String> {
    if let Some(props) = &o.properties {
        // We only need the property values, not the property keys —
        // iterate `.values()` directly (Clippy: `for_kv_map`).
        for prop in props.values() {
            if prop.prop_type.as_deref() == Some("title") {
                if let Some(arr) = &prop.title {
                    return Some(flatten_rich_text(arr));
                }
            }
        }
    }
    if let Some(arr) = &o.title {
        return Some(flatten_rich_text(arr));
    }
    None
}

fn flatten_rich_text(arr: &[NotionRichText]) -> String {
    // Collecting directly into a `String` avoids the intermediate
    // `Vec<String>` that `.collect::<Vec<_>>().join("")` would build
    // (Clippy: `unnecessary_join`).
    arr.iter()
        .filter_map(|t| t.plain_text.clone())
        .collect::<String>()
}

fn block_to_markdown(b: &NotionBlock) -> String {
    let kind = b.block_type.as_deref().unwrap_or("");
    // Notion nests each block kind's body under a key matching its
    // `type` field. Look that up in the captured `extra` map and parse
    // out the bits the markdown converter needs.
    let body = b.extra.get(kind);
    let text = body
        .and_then(|v| v.get("rich_text"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    item.get("plain_text")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                })
                .collect::<String>()
        })
        .unwrap_or_default();

    match kind {
        "heading_1" => format!("# {text}"),
        "heading_2" => format!("## {text}"),
        "heading_3" => format!("### {text}"),
        "bulleted_list_item" => format!("- {text}"),
        "numbered_list_item" => format!("1. {text}"),
        "to_do" => {
            let checked = body
                .and_then(|v| v.get("checked"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            format!("- [{}] {text}", if checked { "x" } else { " " })
        }
        "code" => {
            let lang = body
                .and_then(|v| v.get("language"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            format!("```{lang}\n{text}\n```")
        }
        "quote" => format!("> {text}"),
        "divider" => "---".to_string(),
        _ => text,
    }
}

// --- Wire types ------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct NotionTokenResponse {
    access_token: String,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    bot_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NotionSearchResponse {
    results: Vec<NotionObject>,
    next_cursor: Option<String>,
    has_more: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
struct NotionObject {
    object: String,
    id: String,
    #[serde(default)]
    created_time: Option<String>,
    last_edited_time: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    parent: Option<NotionParent>,
    #[serde(default)]
    properties: Option<std::collections::BTreeMap<String, NotionProperty>>,
    #[serde(default)]
    title: Option<Vec<NotionRichText>>,
}

#[derive(Debug, Deserialize, Serialize)]
struct NotionParent {
    #[serde(rename = "type")]
    parent_type: Option<String>,
    #[serde(default)]
    page_id: Option<String>,
    #[serde(default)]
    database_id: Option<String>,
    #[serde(default)]
    block_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct NotionProperty {
    #[serde(rename = "type", default)]
    prop_type: Option<String>,
    #[serde(default)]
    title: Option<Vec<NotionRichText>>,
}

#[derive(Debug, Deserialize, Serialize)]
struct NotionRichText {
    #[serde(default)]
    plain_text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NotionBlocksResponse {
    results: Vec<NotionBlock>,
    next_cursor: Option<String>,
    has_more: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct NotionBlock {
    #[serde(rename = "type")]
    block_type: Option<String>,
    // Notion's block response nests each kind's body under a key that
    // matches the block's `type` field (e.g. `paragraph`, `heading_1`,
    // `to_do`). Plus a handful of metadata fields (`id`, `parent`,
    // `created_time`, …) that we don't read here. Capture everything
    // else as a JSON map so we can pluck out the body lazily — typed
    // wrappers are brittle against Notion's growing block-type set.
    #[serde(flatten)]
    extra: std::collections::BTreeMap<String, serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn connector_starts_disconnected() {
        let c = NotionConnector::new();
        assert_eq!(c.status(), ConnectorStatus::Disconnected);
        assert_eq!(c.provider_name(), "notion");
        assert!(c.workspace_id().is_none());
    }

    #[test]
    fn build_auth_url_owner_user() {
        let c = NotionConnector::new();
        let cfg = AuthConfig::new("cid".into(), "sec".into(), "http://localhost/cb".into());
        let url = c.build_auth_url(&cfg);
        assert!(url.contains("client_id=cid"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("owner=user"));
    }

    #[test]
    fn notion_object_to_remote_database_is_folder() {
        let o = NotionObject {
            object: "database".into(),
            id: "db-1".into(),
            created_time: Some("2024-01-01T00:00:00.000Z".into()),
            last_edited_time: "2024-02-01T00:00:00.000Z".into(),
            url: Some("https://notion.so/db-1".into()),
            parent: Some(NotionParent {
                parent_type: Some("workspace".into()),
                page_id: None,
                database_id: None,
                block_id: None,
            }),
            properties: None,
            title: Some(vec![NotionRichText {
                plain_text: Some("My DB".into()),
            }]),
        };
        let r = notion_object_to_remote(&o);
        assert!(r.is_folder);
        assert_eq!(r.mime_type, "application/vnd.notion.database");
        assert_eq!(r.name, "My DB");
        assert_eq!(r.parent_id.as_deref(), Some("workspace"));
    }

    #[test]
    fn notion_object_to_remote_page_uses_title_property() {
        let mut props = std::collections::BTreeMap::new();
        props.insert(
            "Name".into(),
            NotionProperty {
                prop_type: Some("title".into()),
                title: Some(vec![NotionRichText {
                    plain_text: Some("Hello".into()),
                }]),
            },
        );
        let o = NotionObject {
            object: "page".into(),
            id: "p-1".into(),
            created_time: None,
            last_edited_time: "2024-02-01T00:00:00.000Z".into(),
            url: None,
            parent: Some(NotionParent {
                parent_type: Some("page_id".into()),
                page_id: Some("parent-page".into()),
                database_id: None,
                block_id: None,
            }),
            properties: Some(props),
            title: None,
        };
        let r = notion_object_to_remote(&o);
        assert!(!r.is_folder);
        assert_eq!(r.name, "Hello");
        assert_eq!(r.parent_id.as_deref(), Some("parent-page"));
    }

    #[tokio::test]
    async fn authenticate_against_mock_token_endpoint() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/oauth/token"))
            .and(header("authorization", "Basic Y2lkOnNlYw=="))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "secret_AT",
                "workspace_id": "ws-1",
                "bot_id": "bot-1",
            })))
            .mount(&server)
            .await;

        let mut c = NotionConnector::with_base_url(&server.uri());
        let cfg = AuthConfig::new("cid".into(), "sec".into(), "http://localhost/cb".into())
            .with_auth_code("auth-code".into());
        let tokens = c.authenticate(&cfg).await.expect("auth ok");
        assert_eq!(tokens.access_token, "secret_AT");
        assert_eq!(c.workspace_id(), Some("ws-1"));
        assert_eq!(c.bot_id(), Some("bot-1"));
    }

    #[tokio::test]
    async fn list_files_paginates_search() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/search"))
            .and(header("notion-version", NOTION_VERSION))
            .and(body_string_contains("\"page_size\":50"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    {
                        "object": "page",
                        "id": "p-1",
                        "last_edited_time": "2024-02-01T00:00:00.000Z",
                        "url": "https://notion.so/p-1",
                        "properties": {
                            "Name": {
                                "type": "title",
                                "title": [{ "plain_text": "Alpha" }]
                            }
                        }
                    }
                ],
                "has_more": true,
                "next_cursor": "CURSOR-2"
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/v1/search"))
            .and(body_string_contains("CURSOR-2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    {
                        "object": "database",
                        "id": "db-1",
                        "last_edited_time": "2024-02-02T00:00:00.000Z",
                        "title": [{ "plain_text": "Catalog" }]
                    }
                ],
                "has_more": false
            })))
            .mount(&server)
            .await;

        let mut c = NotionConnector::with_base_url(&server.uri());
        c.set_access_token("secret_AT");

        let files = c.list_files(None).await.expect("list ok");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].name, "Alpha");
        assert!(files[1].is_folder);
    }

    /// Regression: when a `folder_id` is supplied, `list_files` must
    /// hit the database-specific `/v1/databases/{id}/query` endpoint
    /// instead of misusing the workspace `/v1/search` endpoint's
    /// `query` parameter (which is a free-text search, not a
    /// database-id filter — passing a UUID there returns nothing).
    #[tokio::test]
    async fn list_files_with_folder_id_queries_database_endpoint() {
        let server = MockServer::start().await;
        // The fix routes to /v1/databases/{id}/query, NOT /v1/search.
        // We mount only the database endpoint; a request to /v1/search
        // would 404 and fail the test.
        Mock::given(method("POST"))
            .and(path("/v1/databases/db-abc/query"))
            .and(header("notion-version", NOTION_VERSION))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    {
                        "object": "page",
                        "id": "row-1",
                        "last_edited_time": "2024-02-01T00:00:00.000Z",
                        "url": "https://notion.so/row-1",
                        "properties": {
                            "Name": {
                                "type": "title",
                                "title": [{ "plain_text": "Row One" }]
                            }
                        }
                    }
                ],
                "has_more": false
            })))
            .mount(&server)
            .await;

        let mut c = NotionConnector::with_base_url(&server.uri());
        c.set_access_token("secret_AT");

        let files = c
            .list_files(Some("db-abc"))
            .await
            .expect("database query ok");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].id, "row-1");
        assert_eq!(files[0].name, "Row One");
    }

    /// Pagination cursor must round-trip through the database-query
    /// endpoint just like through `/search`.
    #[tokio::test]
    async fn list_files_database_query_paginates_with_start_cursor() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/databases/db-paged/query"))
            .and(body_string_contains("\"start_cursor\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    {
                        "object": "page",
                        "id": "row-2",
                        "last_edited_time": "2024-02-02T00:00:00.000Z",
                        "properties": {
                            "Name": { "type": "title", "title": [{ "plain_text": "Row Two" }] }
                        }
                    }
                ],
                "has_more": false
            })))
            .mount(&server)
            .await;
        // First page (no start_cursor) returns has_more=true so the
        // second call must include start_cursor. We match it with
        // `body_string_contains` above.
        Mock::given(method("POST"))
            .and(path("/v1/databases/db-paged/query"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    {
                        "object": "page",
                        "id": "row-1",
                        "last_edited_time": "2024-02-01T00:00:00.000Z",
                        "properties": {
                            "Name": { "type": "title", "title": [{ "plain_text": "Row One" }] }
                        }
                    }
                ],
                "has_more": true,
                "next_cursor": "PAGE-2"
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;

        let mut c = NotionConnector::with_base_url(&server.uri());
        c.set_access_token("secret_AT");

        let files = c.list_files(Some("db-paged")).await.expect("paginated ok");
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert!(
            names.contains(&"Row One"),
            "missing first-page row: {names:?}"
        );
        assert!(
            names.contains(&"Row Two"),
            "missing second-page row: {names:?}"
        );
    }

    #[tokio::test]
    async fn sync_changes_stops_at_boundary() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    { "object": "page", "id": "p-new",     "last_edited_time": "2024-06-02T00:00:00.000Z" },
                    { "object": "page", "id": "p-known",   "last_edited_time": "2024-06-01T12:00:00.000Z" },
                    { "object": "page", "id": "p-too-old", "last_edited_time": "2024-05-01T00:00:00.000Z" }
                ],
                "has_more": false
            })))
            .mount(&server)
            .await;

        let mut c = NotionConnector::with_base_url(&server.uri());
        c.set_access_token("secret_AT");
        let mut known = HashSet::new();
        known.insert("p-known".to_string());

        // Boundary right between the second and third item — only
        // p-new (added) and p-known (modified) should fall through.
        let result = c
            .sync_changes(Some("2024-05-15T00:00:00.000Z"), &known)
            .await
            .expect("sync ok");
        assert_eq!(result.added.len(), 1);
        assert_eq!(result.added[0].id, "p-new");
        assert_eq!(result.modified.len(), 1);
        assert_eq!(result.modified[0].id, "p-known");
        assert!(result.removed.is_empty());
        assert!(result.new_change_token.as_deref().is_some());
    }
}
