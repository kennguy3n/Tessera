//! End-to-end wiremock integration tests for the Notion connector.
//!
//! These complement the inline tests in `src/notion.rs` (which target
//! individual helpers like the `/search` body builder, the
//! workspace-walk filter, and the periodic full-walk cadence) by
//! exercising the connector at its public-API surface — the same
//! `authenticate → list → download → sync → revoke` surface a
//! downstream Tessera caller would use.
//!
//! Notion has a few quirks worth pinning in integration form rather
//! than as unit tests:
//!
//! * The `/search` and `/databases/{id}/query` routes are POST + JSON
//!   body (cursor-based pagination via `start_cursor` / `next_cursor`).
//! * The `/blocks/{id}/children` route is GET + query-string
//!   pagination (`start_cursor` / `next_cursor`); 404 short-circuits to
//!   `FileNotFound`.
//! * Notion access tokens are bot tokens — they never rotate, so the
//!   `refresh_token` slot on `StoredTokens` is intentionally `None`.
//! * 401/403/429 share a common handler (`handle_common_errors`); pin
//!   each so a future refactor of the handler can't silently drop a
//!   code.

use std::collections::HashSet;

use wiremock::matchers::{header, header_exists, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use tessera_connectors::notion::NotionConnector;
use tessera_connectors::types::{AuthConfig, ConnectorStatus};

fn auth_config() -> AuthConfig {
    AuthConfig::new(
        "notion-client-id".into(),
        "notion-client-secret".into(),
        "http://localhost:9876/callback".into(),
    )
    .with_auth_code("notion-auth-code".into())
}

#[tokio::test]
async fn full_lifecycle_authenticate_list_download_revoke() {
    let server = MockServer::start().await;

    // 1. OAuth code exchange (HTTP Basic + JSON body).
    Mock::given(method("POST"))
        .and(path("/v1/oauth/token"))
        .and(header_exists("Authorization"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "ntn-secret-access-token",
            "workspace_id": "ws-1234",
            "bot_id": "bot-5678",
            "workspace_name": "Tessera Test Workspace"
        })))
        .expect(1)
        .mount(&server)
        .await;

    // 2. List via /v1/search (workspace walk).
    Mock::given(method("POST"))
        .and(path("/v1/search"))
        .and(header("Authorization", "Bearer ntn-secret-access-token"))
        .and(header("Notion-Version", "2022-06-28"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "results": [
                {
                    "object": "page",
                    "id": "page-001",
                    "last_edited_time": "2024-06-01T12:00:00.000Z",
                    "properties": {
                        "title": {
                            "title": [ { "plain_text": "Quarterly Plan" } ]
                        }
                    }
                },
                {
                    "object": "database",
                    "id": "db-002",
                    "last_edited_time": "2024-06-02T08:30:00.000Z",
                    "title": [ { "plain_text": "Project Tracker" } ]
                }
            ],
            "has_more": false,
            "next_cursor": null
        })))
        .expect(1)
        .mount(&server)
        .await;

    // 3. Download via /v1/blocks/{id}/children (single page).
    Mock::given(method("GET"))
        .and(path("/v1/blocks/page-001/children"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "results": [
                {
                    "id": "block-aaa",
                    "type": "heading_1",
                    "heading_1": {
                        "rich_text": [ { "plain_text": "Overview" } ]
                    }
                },
                {
                    "id": "block-bbb",
                    "type": "paragraph",
                    "paragraph": {
                        "rich_text": [ { "plain_text": "First paragraph body." } ]
                    }
                }
            ],
            "has_more": false,
            "next_cursor": null
        })))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = NotionConnector::with_base_url(&server.uri());
    let tokens = connector.authenticate(&auth_config()).await.expect("auth");
    assert_eq!(tokens.access_token, "ntn-secret-access-token");
    // Notion bot tokens never refresh — refresh_token must stay None to
    // signal "no rotation path".
    assert!(tokens.refresh_token.is_none());
    assert_eq!(tokens.provider_metadata.as_deref(), Some("ws-1234"));
    assert_eq!(connector.status(), ConnectorStatus::Connected);

    let files = connector.list_files(None).await.expect("list");
    assert_eq!(files.len(), 2);
    assert!(
        files.iter().any(|f| f.id == "page-001"),
        "expected page-001 in {files:?}",
    );
    assert!(
        files.iter().any(|f| f.id == "db-002"),
        "expected db-002 in {files:?}",
    );

    let bytes = connector.download_file("page-001").await.expect("download");
    let body = String::from_utf8(bytes).unwrap();
    assert!(
        body.contains("Overview"),
        "expected heading text in body, got {body:?}",
    );
    assert!(
        body.contains("First paragraph body"),
        "expected paragraph text in body, got {body:?}",
    );

    // Revoke is local-only for Notion (no public revoke endpoint).
    connector.revoke().await.expect("revoke");
    assert_eq!(connector.status(), ConnectorStatus::Disconnected);
}

#[tokio::test]
async fn list_files_search_paginates_via_start_cursor() {
    let server = MockServer::start().await;

    // Page 1 — has_more=true and next_cursor=p2.
    Mock::given(method("POST"))
        .and(path("/v1/search"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "results": [
                {
                    "object": "page",
                    "id": "page-1",
                    "last_edited_time": "2024-06-01T12:00:00.000Z",
                    "properties": {
                        "title": { "title": [ { "plain_text": "P1" } ] }
                    }
                }
            ],
            "has_more": true,
            "next_cursor": "p2"
        })))
        .up_to_n_times(1)
        .mount(&server)
        .await;

    // Page 2 — terminates the loop.
    Mock::given(method("POST"))
        .and(path("/v1/search"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "results": [
                {
                    "object": "page",
                    "id": "page-2",
                    "last_edited_time": "2024-06-02T12:00:00.000Z",
                    "properties": {
                        "title": { "title": [ { "plain_text": "P2" } ] }
                    }
                }
            ],
            "has_more": false,
            "next_cursor": null
        })))
        .mount(&server)
        .await;

    let mut connector = NotionConnector::with_base_url(&server.uri());
    connector.set_access_token("AT");

    let files = connector.list_files(None).await.expect("list");
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].id, "page-1");
    assert_eq!(files[1].id, "page-2");
}

#[tokio::test]
async fn list_files_with_database_id_routes_to_query_endpoint() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/v1/databases/db-42/query"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "results": [
                {
                    "object": "page",
                    "id": "row-1",
                    "last_edited_time": "2024-06-01T12:00:00.000Z",
                    "properties": {
                        "Name": { "title": [ { "plain_text": "Row 1" } ] }
                    }
                }
            ],
            "has_more": false,
            "next_cursor": null
        })))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = NotionConnector::with_base_url(&server.uri());
    connector.set_access_token("AT");

    let files = connector.list_files(Some("db-42")).await.expect("list");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].id, "row-1");
}

#[tokio::test]
async fn list_files_token_expired_maps_to_token_expired() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/search"))
        .respond_with(ResponseTemplate::new(401))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = NotionConnector::with_base_url(&server.uri());
    connector.set_access_token("expired");

    let err = connector.list_files(None).await.unwrap_err();
    let s = format!("{:?}", err);
    assert!(s.contains("TokenExpired"), "expected TokenExpired, got {s}");
}

#[tokio::test]
async fn list_files_permission_denied_when_not_shared() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/search"))
        .respond_with(ResponseTemplate::new(403))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = NotionConnector::with_base_url(&server.uri());
    connector.set_access_token("AT");

    let err = connector.list_files(None).await.unwrap_err();
    let s = format!("{:?}", err);
    assert!(
        s.contains("PermissionDenied"),
        "expected PermissionDenied, got {s}",
    );
}

#[tokio::test]
async fn list_files_rate_limit_returns_60s_retry_after() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/search"))
        .respond_with(ResponseTemplate::new(429))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = NotionConnector::with_base_url(&server.uri());
    connector.set_access_token("AT");

    let err = connector.list_files(None).await.unwrap_err();
    let s = format!("{:?}", err);
    assert!(s.contains("RateLimited"), "expected RateLimited, got {s}");
    assert!(
        s.contains("retry_after_secs: 60"),
        "Notion's handler hard-codes 60s; got {s}",
    );
}

#[tokio::test]
async fn download_file_404_maps_to_file_not_found() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/blocks/missing-page/children"))
        .respond_with(ResponseTemplate::new(404))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = NotionConnector::with_base_url(&server.uri());
    connector.set_access_token("AT");

    let err = connector.download_file("missing-page").await.unwrap_err();
    let s = format!("{:?}", err);
    assert!(s.contains("FileNotFound"), "expected FileNotFound, got {s}");
}

#[tokio::test]
async fn sync_changes_full_walk_surfaces_deletions_via_set_diff() {
    let server = MockServer::start().await;

    // First-sync triggers the full walk regardless of change_token, so
    // we only mock /search. Return a single page-1 that's still extant.
    // The caller's known-set contains page-1 AND page-99; page-99 must
    // surface as removed (set diff: known − seen).
    Mock::given(method("POST"))
        .and(path("/v1/search"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "results": [
                {
                    "object": "page",
                    "id": "page-1",
                    "last_edited_time": "2024-06-15T12:00:00.000Z",
                    "properties": {
                        "title": { "title": [ { "plain_text": "Still Here" } ] }
                    }
                }
            ],
            "has_more": false,
            "next_cursor": null
        })))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = NotionConnector::with_base_url(&server.uri());
    connector.set_access_token("AT");

    let mut known = HashSet::new();
    known.insert("page-1".to_string());
    known.insert("page-99".to_string());

    let result = connector
        .sync_changes(None, &known)
        .await
        .expect("sync_changes");
    assert!(
        result.removed.iter().any(|id| id == "page-99"),
        "expected page-99 in removed list, got {:?}",
        result.removed,
    );
}
