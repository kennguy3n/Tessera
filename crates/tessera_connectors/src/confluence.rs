//! Confluence connector — Atlassian Cloud Confluence REST API v2,
//! sharing the 3LO OAuth surface with Jira.
//!
//! ## OAuth
//!
//! Same flow as Jira: consent at `auth.atlassian.com/authorize`,
//! exchange at `auth.atlassian.com/oauth/token`, discover cloud sites
//! via `api.atlassian.com/oauth/token/accessible-resources`. We
//! deliberately do not share state with [`crate::jira`] — connectors
//! are isolated per-provider so users can connect Confluence without
//! consenting to Jira scopes (and vice versa). Tessera ships a
//! separate Atlassian developer app for each.
//!
//! ## Sync
//!
//! Confluence's content-search endpoint
//! (`/wiki/api/v2/spaces/{spaceId}/pages?status=current&sort=-modified-date`)
//! lets us walk pages in reverse-modified order with cursor pagination.
//! The change token is the highest `version.createdAt` we saw — on
//! next sync we stop walking when items drop below that boundary.
//!
//! ## What Confluence surfaces as a "file"
//!
//! Pages, blog posts. Mime type
//! `application/vnd.confluence.page`. `download_file` returns the
//! page body as `storage` HTML.

use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashSet;

use crate::error::{ConnectorError, ConnectorResult};
use crate::types::{AuthConfig, ConnectorStatus, RemoteFile, StoredTokens, SyncResult};
use crate::url_encode;

const DEFAULT_AUTH_BASE: &str = "https://auth.atlassian.com";
const DEFAULT_API_BASE: &str = "https://api.atlassian.com";

pub struct ConfluenceConnector {
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

impl ConfluenceConnector {
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
        "confluence"
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
    pub fn cloud_id(&self) -> Option<&str> {
        self.cloud_id.as_deref()
    }
    pub fn site_url(&self) -> Option<&str> {
        self.site_url.as_deref()
    }

    pub fn build_auth_url(&self, config: &AuthConfig) -> String {
        let mut scopes: Vec<String> = config.scopes.clone();
        for required in [
            "read:confluence-content.summary",
            "read:confluence-content.all",
            "read:confluence-space.summary",
            "offline_access",
        ] {
            if !scopes.iter().any(|s| s == required) {
                scopes.push(required.to_string());
            }
        }

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
            scopes: self.cloud_id.iter().cloned().collect(),
        })
    }

    pub fn restore_tokens(&mut self, tokens: &StoredTokens, client_id: &str, client_secret: &str) {
        self.access_token = Some(tokens.access_token.clone());
        self.refresh_token.clone_from(&tokens.refresh_token);
        self.token_expiry = tokens.expiry;
        self.cloud_id = tokens.scopes.first().cloned();
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
            self.refresh_token = Some(new_rt.clone());
        }

        Ok(StoredTokens {
            access_token: token.access_token,
            refresh_token: self.refresh_token.clone(),
            expiry,
            scopes: self.cloud_id.iter().cloned().collect(),
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
                provider: "Confluence".into(),
                message: format!("accessible-resources HTTP {}", resp.status()),
            });
        }
        let sites: Vec<AtlassianResource> = resp
            .json()
            .await
            .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;
        Ok(sites)
    }

    fn wiki_url(&self, suffix: &str) -> ConnectorResult<String> {
        let cloud_id = self
            .cloud_id
            .as_deref()
            .ok_or_else(|| ConnectorError::InvalidConfig("Missing cloud_id".into()))?;
        Ok(format!(
            "{}/ex/confluence/{}/wiki/api/v2{}",
            self.api_base, cloud_id, suffix
        ))
    }

    /// List pages. `folder_id` is the Confluence space id; when `None`
    /// we walk pages across all spaces the user has access to.
    pub async fn list_files(
        &mut self,
        folder_id: Option<&str>,
    ) -> ConnectorResult<Vec<RemoteFile>> {
        let suffix = match folder_id {
            Some(space) if !space.is_empty() => format!(
                "/spaces/{}/pages?limit=100&sort=-modified-date",
                url_encode::encode(space)
            ),
            _ => "/pages?limit=100&sort=-modified-date".to_string(),
        };

        let token = self.ensure_valid_token().await?;
        let mut next_url = Some(self.wiki_url(&suffix)?);
        let mut all = Vec::new();

        while let Some(url) = next_url.take() {
            let resp = self
                .client
                .get(&url)
                .bearer_auth(&token)
                .header("Accept", "application/json")
                .send()
                .await?;
            handle_common_errors(&resp.status())?;
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(ConnectorError::ProviderError {
                    provider: "Confluence".into(),
                    message: format!("Pages HTTP {status}: {body}"),
                });
            }
            let page: ConfluencePagesPage = resp
                .json()
                .await
                .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;

            for raw in &page.results {
                all.push(page_to_remote(raw, self.site_url.as_deref()));
            }

            // v2 uses Link header *or* a `_links.next` cursor.
            if let Some(links) = page.links {
                if let Some(next) = links.next {
                    next_url = Some(self.build_cursor_url(&next)?);
                }
            }
        }

        Ok(all)
    }

    fn build_cursor_url(&self, link: &str) -> ConnectorResult<String> {
        if link.starts_with("http") {
            Ok(link.to_string())
        } else if link.starts_with("/wiki") {
            // Strip the `/wiki` prefix so we can re-prefix with the
            // cloud-id-aware URL builder.
            let suffix = link.trim_start_matches("/wiki");
            self.wiki_url(suffix)
        } else {
            self.wiki_url(link)
        }
    }

    /// Fetch a page's body in `storage` format (Confluence's
    /// HTML-flavoured XML).
    pub async fn download_file(&mut self, page_id: &str) -> ConnectorResult<Vec<u8>> {
        let token = self.ensure_valid_token().await?;
        let url = self.wiki_url(&format!(
            "/pages/{}?body-format=storage",
            url_encode::encode(page_id)
        ))?;
        let resp = self
            .client
            .get(&url)
            .bearer_auth(&token)
            .header("Accept", "application/json")
            .send()
            .await?;
        if resp.status().as_u16() == 404 {
            return Err(ConnectorError::FileNotFound(page_id.into()));
        }
        handle_common_errors(&resp.status())?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(ConnectorError::ProviderError {
                provider: "Confluence".into(),
                message: format!("Page HTTP {status}: {body}"),
            });
        }
        let page: ConfluencePage = resp
            .json()
            .await
            .map_err(|e| ConnectorError::NetworkError(e.to_string()))?;
        let body = page
            .body
            .as_ref()
            .and_then(|b| b.storage.as_ref())
            .and_then(|s| s.value.clone())
            .unwrap_or_default();
        Ok(body.into_bytes())
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
        let pages = match self.list_files(None).await {
            Ok(p) => p,
            Err(e) => {
                self.status = ConnectorStatus::Error;
                return Err(e);
            }
        };

        let mut result = SyncResult::empty();
        let mut newest_seen: Option<DateTime<Utc>> = None;
        for remote in pages {
            if remote.modified_time > newest_seen.unwrap_or(DateTime::<Utc>::MIN_UTC) {
                newest_seen = Some(remote.modified_time);
            }
            if let Some(bound) = boundary {
                if remote.modified_time <= bound {
                    continue;
                }
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
        self.file_count = self
            .file_count
            .saturating_add(result.added.len() as u64);
        self.status = ConnectorStatus::Connected;
        Ok(result)
    }

    pub async fn revoke(&mut self) -> ConnectorResult<()> {
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

impl Default for ConfluenceConnector {
    fn default() -> Self {
        Self::new()
    }
}

fn handle_common_errors(status: &reqwest::StatusCode) -> ConnectorResult<()> {
    match status.as_u16() {
        401 => Err(ConnectorError::TokenExpired),
        403 => Err(ConnectorError::PermissionDenied(
            "Confluence returned 403".to_string(),
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

fn page_to_remote(p: &ConfluencePage, site_url: Option<&str>) -> RemoteFile {
    let modified = p
        .version
        .as_ref()
        .and_then(|v| v.created_at.as_deref())
        .or(p.created_at.as_deref())
        .map_or_else(Utc::now, parse_rfc3339_or_now);
    let created_at = p.created_at.as_deref().map(parse_rfc3339_or_now);

    // v2 returns the page's relative link in `_links.webui`; we
    // concatenate against the cloud site URL to produce a working
    // browser URL.
    let web_link = p
        .links
        .as_ref()
        .and_then(|l| l.webui.clone())
        .map(|rel| match site_url {
            Some(base) => format!("{base}/wiki{rel}"),
            None => rel,
        });

    let title = p.title.clone().unwrap_or_else(|| format!("Page {}", p.id));

    RemoteFile {
        id: p.id.clone(),
        name: title,
        mime_type: "application/vnd.confluence.page".to_string(),
        size_bytes: 0,
        modified_time: modified,
        created_time: created_at,
        parent_id: p.space_id.clone(),
        web_view_link: web_link,
        is_folder: false,
        md5_checksum: None,
        permissions: Vec::new(),
    }
}

// --- Wire types ------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct AtlassianTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    #[allow(dead_code)]
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
struct ConfluencePagesPage {
    results: Vec<ConfluencePage>,
    #[serde(rename = "_links", default)]
    links: Option<PagesPageLinks>,
}

#[derive(Debug, Deserialize)]
struct PagesPageLinks {
    #[serde(default)]
    next: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ConfluencePage {
    id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(rename = "spaceId", default)]
    space_id: Option<String>,
    #[serde(rename = "createdAt", default)]
    created_at: Option<String>,
    #[serde(default)]
    version: Option<ConfluencePageVersion>,
    #[serde(default)]
    body: Option<ConfluencePageBody>,
    #[serde(rename = "_links", default)]
    links: Option<ConfluencePageLinks>,
}

#[derive(Debug, Deserialize)]
struct ConfluencePageVersion {
    #[serde(rename = "createdAt", default)]
    created_at: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    number: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct ConfluencePageBody {
    #[serde(default)]
    storage: Option<ConfluenceStorage>,
}

#[derive(Debug, Deserialize)]
struct ConfluenceStorage {
    #[serde(default)]
    value: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ConfluencePageLinks {
    #[serde(default)]
    webui: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn connector_starts_disconnected() {
        let c = ConfluenceConnector::new();
        assert_eq!(c.status(), ConnectorStatus::Disconnected);
        assert_eq!(c.provider_name(), "confluence");
    }

    #[test]
    fn build_auth_url_adds_required_scopes() {
        let c = ConfluenceConnector::new();
        let cfg = AuthConfig::new("cid".into(), "sec".into(), "http://localhost/cb".into());
        let url = c.build_auth_url(&cfg);
        assert!(url.contains("read%3Aconfluence-content.summary"));
        assert!(url.contains("offline_access"));
        assert!(url.contains("audience=api.atlassian.com"));
    }

    #[test]
    fn page_to_remote_uses_version_modified_when_available() {
        let p = ConfluencePage {
            id: "1234".into(),
            title: Some("Hi".into()),
            space_id: Some("S1".into()),
            created_at: Some("2024-01-01T00:00:00Z".into()),
            version: Some(ConfluencePageVersion {
                created_at: Some("2024-06-01T10:00:00Z".into()),
                number: Some(5),
            }),
            body: None,
            links: Some(ConfluencePageLinks {
                webui: Some("/spaces/S1/pages/1234/Hi".into()),
            }),
        };
        let r = page_to_remote(&p, Some("https://acme.atlassian.net"));
        assert_eq!(r.id, "1234");
        assert_eq!(r.name, "Hi");
        assert_eq!(r.parent_id.as_deref(), Some("S1"));
        assert_eq!(
            r.web_view_link.as_deref(),
            Some("https://acme.atlassian.net/wiki/spaces/S1/pages/1234/Hi")
        );
        // Modified should be from the version, not created_at.
        assert_eq!(
            r.modified_time.to_rfc3339(),
            "2024-06-01T10:00:00+00:00"
        );
    }

    #[tokio::test]
    async fn list_files_paginates_via_links_next() {
        let server = MockServer::start().await;
        let next_url = format!(
            "{}/api/ex/confluence/cloud-1/wiki/api/v2/pages?limit=100&cursor=NEXT",
            server.uri()
        );
        Mock::given(method("GET"))
            .and(path("/api/ex/confluence/cloud-1/wiki/api/v2/pages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    {
                        "id": "1",
                        "title": "First",
                        "spaceId": "S1",
                        "createdAt": "2024-06-01T10:00:00Z",
                        "version": {"createdAt": "2024-06-02T10:00:00Z", "number": 2}
                    }
                ],
                "_links": { "next": next_url }
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/ex/confluence/cloud-1/wiki/api/v2/pages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    {
                        "id": "2",
                        "title": "Second",
                        "spaceId": "S1",
                        "createdAt": "2024-06-03T10:00:00Z"
                    }
                ],
                "_links": {}
            })))
            .mount(&server)
            .await;

        let mut c = ConfluenceConnector::with_base_url(&server.uri());
        c.set_access_token("AT", 3600, "cloud-1");
        let files = c.list_files(None).await.expect("ok");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].id, "1");
        assert_eq!(files[1].id, "2");
    }
}
