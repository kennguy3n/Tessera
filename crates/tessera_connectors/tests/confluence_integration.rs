//! End-to-end wiremock integration tests for the Confluence connector.
//!
//! Confluence Cloud shares Atlassian's OAuth2 + accessible-resources
//! discovery flow with Jira but routes API calls through a different
//! gateway path (`/ex/confluence/{cloud_id}/wiki/api/v2/...`). These
//! tests pin:
//!
//! * Two-step OAuth + cloud-id discovery (same shape as Jira but
//!   independently exercised in case the wiring drifts).
//! * Pages listing scoped to a space id vs workspace-wide.
//! * Cursor-based pagination via the `_links.next` field — and the
//!   `build_cursor_url` invariant that the v2 cursor path is NOT
//!   double-prefixed with `/wiki/api/v2/`.
//! * `download_file` returns the `body.storage.value` HTML payload
//!   verbatim.
//! * `handle_common_errors` mapping (`401 → TokenExpired`,
//!   `403 → PermissionDenied`, `429 → RateLimited`, `404 →
//!   FileNotFound` on download).

use std::collections::HashSet;

use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use tessera_connectors::confluence::ConfluenceConnector;
use tessera_connectors::types::{AuthConfig, ConnectorStatus};

fn auth_config() -> AuthConfig {
    AuthConfig::new(
        "conf-client-id".into(),
        "conf-client-secret".into(),
        "http://localhost:9876/callback".into(),
    )
    .with_auth_code("conf-auth-code".into())
}

#[tokio::test]
async fn full_lifecycle_authenticate_discovers_cloud_id_then_lists_pages() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/auth/oauth/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "confluence-access-token",
            "refresh_token": "confluence-refresh-token",
            "expires_in": 3600,
            "scope": "read:confluence-content.all offline_access"
        })))
        .expect(1)
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/api/oauth/token/accessible-resources"))
        .and(header("Authorization", "Bearer confluence-access-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            {
                "id": "cloud-c1",
                "url": "https://acme.atlassian.net",
                "name": "Acme",
                "scopes": ["read:confluence-content.all"]
            }
        ])))
        .expect(1)
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/api/ex/confluence/cloud-c1/wiki/api/v2/pages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "results": [
                {
                    "id": "111",
                    "title": "Onboarding",
                    "spaceId": "space-1",
                    "version": { "createdAt": "2024-06-01T12:00:00.000Z", "number": 4 }
                },
                {
                    "id": "222",
                    "title": "Architecture",
                    "spaceId": "space-1",
                    "version": { "createdAt": "2024-06-02T12:00:00.000Z", "number": 7 }
                }
            ],
            "_links": {}
        })))
        .expect(1)
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/api/ex/confluence/cloud-c1/wiki/api/v2/pages/111"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "111",
            "title": "Onboarding",
            "body": {
                "storage": {
                    "value": "<p>Welcome to the team!</p>"
                }
            }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = ConfluenceConnector::with_base_url(&server.uri());
    let tokens = connector.authenticate(&auth_config()).await.expect("auth");
    assert_eq!(tokens.access_token, "confluence-access-token");
    assert_eq!(
        tokens.refresh_token.as_deref(),
        Some("confluence-refresh-token"),
    );
    assert_eq!(tokens.provider_metadata.as_deref(), Some("cloud-c1"));
    assert_eq!(connector.status(), ConnectorStatus::Connected);

    let files = connector.list_files(None).await.expect("list");
    assert_eq!(files.len(), 2);
    assert!(files.iter().any(|f| f.id == "111"));
    assert!(files.iter().any(|f| f.id == "222"));

    let bytes = connector.download_file("111").await.expect("download");
    let body = String::from_utf8(bytes).unwrap();
    assert!(
        body.contains("Welcome to the team!"),
        "expected body html in download, got {body:?}",
    );
}

#[tokio::test]
async fn list_files_with_space_id_targets_space_scoped_endpoint() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path(
            "/api/ex/confluence/cloud-1/wiki/api/v2/spaces/SPACE-42/pages",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "results": [
                {
                    "id": "p-1",
                    "title": "Space-scoped page",
                    "spaceId": "SPACE-42"
                }
            ],
            "_links": {}
        })))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = ConfluenceConnector::with_base_url(&server.uri());
    connector.set_access_token("AT", 3600, "cloud-1");

    let files = connector
        .list_files(Some("SPACE-42"))
        .await
        .expect("list in space");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].id, "p-1");
}

#[tokio::test]
async fn list_files_paginates_via_links_next_cursor() {
    let server = MockServer::start().await;

    // Page 1: returns _links.next pointing at the cursor endpoint.
    // The cursor path is host-rooted (`/wiki/api/v2/...`) — pin that
    // build_cursor_url doesn't double the `/wiki/api/v2/` segment.
    Mock::given(method("GET"))
        .and(path("/api/ex/confluence/cloud-1/wiki/api/v2/pages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "results": [
                {
                    "id": "p-1",
                    "title": "first",
                    "spaceId": "s",
                    "version": { "createdAt": "2024-06-01T12:00:00.000Z" }
                }
            ],
            "_links": {
                "next": "/wiki/api/v2/pages?cursor=CURSOR_A"
            }
        })))
        .up_to_n_times(1)
        .mount(&server)
        .await;

    // Page 2: cursor URL, terminates the loop.
    Mock::given(method("GET"))
        .and(path("/api/ex/confluence/cloud-1/wiki/api/v2/pages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "results": [
                {
                    "id": "p-2",
                    "title": "second",
                    "spaceId": "s",
                    "version": { "createdAt": "2024-06-02T12:00:00.000Z" }
                }
            ],
            "_links": {}
        })))
        .mount(&server)
        .await;

    let mut connector = ConfluenceConnector::with_base_url(&server.uri());
    connector.set_access_token("AT", 3600, "cloud-1");

    let files = connector.list_files(None).await.expect("list");
    assert_eq!(
        files.len(),
        2,
        "expected both pages to surface, got {files:?}"
    );
    assert_eq!(files[0].id, "p-1");
    assert_eq!(files[1].id, "p-2");
}

#[tokio::test]
async fn list_files_token_expired_returns_token_expired() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/ex/confluence/cloud-1/wiki/api/v2/pages"))
        .respond_with(ResponseTemplate::new(401))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = ConfluenceConnector::with_base_url(&server.uri());
    connector.set_access_token("expired", 3600, "cloud-1");
    let err = connector.list_files(None).await.unwrap_err();
    let s = format!("{:?}", err);
    assert!(s.contains("TokenExpired"), "expected TokenExpired, got {s}");
}

#[tokio::test]
async fn list_files_permission_denied_when_confluence_returns_403() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/ex/confluence/cloud-1/wiki/api/v2/pages"))
        .respond_with(ResponseTemplate::new(403))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = ConfluenceConnector::with_base_url(&server.uri());
    connector.set_access_token("AT", 3600, "cloud-1");
    let err = connector.list_files(None).await.unwrap_err();
    let s = format!("{:?}", err);
    assert!(
        s.contains("PermissionDenied"),
        "expected PermissionDenied, got {s}",
    );
}

#[tokio::test]
async fn list_files_rate_limited_returns_60s_retry_after() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/ex/confluence/cloud-1/wiki/api/v2/pages"))
        .respond_with(ResponseTemplate::new(429))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = ConfluenceConnector::with_base_url(&server.uri());
    connector.set_access_token("AT", 3600, "cloud-1");
    let err = connector.list_files(None).await.unwrap_err();
    let s = format!("{:?}", err);
    assert!(s.contains("RateLimited"), "expected RateLimited, got {s}");
    assert!(
        s.contains("retry_after_secs: 60"),
        "Confluence handler hard-codes 60s; got {s}",
    );
}

#[tokio::test]
async fn download_file_404_maps_to_file_not_found() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/ex/confluence/cloud-1/wiki/api/v2/pages/missing"))
        .respond_with(ResponseTemplate::new(404))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = ConfluenceConnector::with_base_url(&server.uri());
    connector.set_access_token("AT", 3600, "cloud-1");
    let err = connector.download_file("missing").await.unwrap_err();
    let s = format!("{:?}", err);
    assert!(s.contains("FileNotFound"), "expected FileNotFound, got {s}");
}

#[tokio::test]
async fn sync_changes_partitions_pages_against_known_set() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/api/ex/confluence/cloud-1/wiki/api/v2/pages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "results": [
                {
                    "id": "p-100",
                    "title": "New",
                    "spaceId": "s",
                    "version": { "createdAt": "2024-06-15T12:00:00.000Z" }
                },
                {
                    "id": "p-101",
                    "title": "Known",
                    "spaceId": "s",
                    "version": { "createdAt": "2024-06-14T12:00:00.000Z" }
                }
            ],
            "_links": {}
        })))
        .mount(&server)
        .await;

    let mut connector = ConfluenceConnector::with_base_url(&server.uri());
    connector.set_access_token("AT", 3600, "cloud-1");

    let mut known = HashSet::new();
    known.insert("p-101".to_string());

    let result = connector
        .sync_changes(None, &known)
        .await
        .expect("sync_changes");
    assert!(
        result.added.iter().any(|f| f.id == "p-100"),
        "expected p-100 in added, got {:?}",
        result.added,
    );
    assert!(
        result.modified.iter().any(|f| f.id == "p-101"),
        "expected p-101 in modified, got {:?}",
        result.modified,
    );
}
