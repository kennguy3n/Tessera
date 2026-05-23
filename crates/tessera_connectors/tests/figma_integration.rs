//! End-to-end wiremock integration tests for the Figma connector.
//!
//! Figma's listing surface differs from the other connectors: there is
//! no flat workspace search. Files are scoped to a project, projects
//! are scoped to a team, and the team-id must be set out-of-band via
//! `set_team_id()` (typically by the desktop app after the user picks
//! a team in the settings UI). These tests pin:
//!
//! * OAuth code exchange against `/v1/oauth/token` (Figma uses
//!   `application/x-www-form-urlencoded`, not JSON).
//! * The walk: `set_team_id(t)` → list /teams/{t}/projects → for each
//!   project, list /projects/{p}/files → flatten.
//! * The folder-scoped shortcut: `list_files(Some(project_id))` skips
//!   the team-projects fetch.
//! * `download_file` extracts `texts` and `components` from the file
//!   tree into a compact JSON payload (the indexer-friendly shape).
//! * `handle_common_errors` mapping (`401 → TokenExpired`,
//!   `403 → PermissionDenied`, `429 → RateLimited`, `404 →
//!   FileNotFound`).

use std::collections::HashSet;

use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use tessera_connectors::figma::FigmaConnector;
use tessera_connectors::types::{AuthConfig, ConnectorStatus};

fn auth_config() -> AuthConfig {
    AuthConfig::new(
        "figma-client-id".into(),
        "figma-client-secret".into(),
        "http://localhost:9876/callback".into(),
    )
    .with_auth_code("figma-auth-code".into())
}

#[tokio::test]
async fn full_lifecycle_authenticate_list_via_team_then_download() {
    let server = MockServer::start().await;

    // 1. OAuth code exchange (form-encoded, not JSON).
    Mock::given(method("POST"))
        .and(path("/v1/oauth/token"))
        .and(body_string_contains("grant_type=authorization_code"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "figma-access-token",
            "refresh_token": "figma-refresh-token",
            "expires_in": 7776000,
            "user_id": 42
        })))
        .expect(1)
        .mount(&server)
        .await;

    // 2. List projects for the team.
    Mock::given(method("GET"))
        .and(path("/v1/teams/team-77/projects"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "Acme Team",
            "projects": [
                { "id": "proj-1", "name": "Product Design" },
                { "id": "proj-2", "name": "Marketing" }
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    // 3. List files for each project.
    Mock::given(method("GET"))
        .and(path("/v1/projects/proj-1/files"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "Product Design",
            "files": [
                {
                    "key": "FILE_AAA",
                    "name": "Home Mocks",
                    "thumbnail_url": "https://figma.example/thumb.png",
                    "last_modified": "2024-06-01T12:00:00Z"
                }
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/projects/proj-2/files"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "Marketing",
            "files": [
                {
                    "key": "FILE_BBB",
                    "name": "Launch Banners",
                    "thumbnail_url": "https://figma.example/banner.png",
                    "last_modified": "2024-06-02T08:00:00Z"
                }
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    // 4. Download a file — return a document tree with TEXT nodes and
    // a components map. Pin that the connector emits the compact
    // text+components extract.
    Mock::given(method("GET"))
        .and(path("/v1/files/FILE_AAA"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "Home Mocks",
            "lastModified": "2024-06-01T12:00:00Z",
            "document": {
                "id": "0:0",
                "type": "DOCUMENT",
                "children": [
                    {
                        "id": "1:1",
                        "type": "CANVAS",
                        "name": "Page 1",
                        "children": [
                            {
                                "id": "1:2",
                                "type": "TEXT",
                                "characters": "Welcome to Acme",
                                "name": "Heading"
                            },
                            {
                                "id": "1:3",
                                "type": "TEXT",
                                "characters": "Get started in seconds",
                                "name": "Subhead"
                            }
                        ]
                    }
                ]
            },
            "components": {
                "C:1": { "name": "PrimaryButton", "description": "" },
                "C:2": { "name": "Card", "description": "" }
            }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = FigmaConnector::with_base_url(&server.uri());
    let tokens = connector.authenticate(&auth_config()).await.expect("auth");
    assert_eq!(tokens.access_token, "figma-access-token");
    assert_eq!(
        tokens.refresh_token.as_deref(),
        Some("figma-refresh-token"),
    );
    assert_eq!(connector.status(), ConnectorStatus::Connected);

    // Set the team id and walk.
    connector.set_team_id("team-77");
    let files = connector.list_files(None).await.expect("list");
    assert_eq!(files.len(), 2, "expected one file per project, got {files:?}");
    assert!(files.iter().any(|f| f.id == "FILE_AAA"));
    assert!(files.iter().any(|f| f.id == "FILE_BBB"));

    let bytes = connector.download_file("FILE_AAA").await.expect("download");
    let body: serde_json::Value = serde_json::from_slice(&bytes).expect("download json");
    let texts = body.get("texts").and_then(|t| t.as_array()).expect("texts");
    assert!(
        texts.iter().any(|t| t == "Welcome to Acme"),
        "expected heading text in extract, got {texts:?}",
    );
    assert!(
        texts.iter().any(|t| t == "Get started in seconds"),
        "expected subhead text in extract, got {texts:?}",
    );
    let components = body
        .get("components")
        .and_then(|c| c.as_array())
        .expect("components");
    assert!(
        components.iter().any(|c| c == "PrimaryButton"),
        "expected PrimaryButton in components, got {components:?}",
    );
}

#[tokio::test]
async fn list_files_with_project_id_skips_team_projects_fetch() {
    // Pin the optimisation: when the caller already knows the project
    // id, we must NOT call /teams/{t}/projects.
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/v1/projects/proj-direct/files"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "Direct Project",
            "files": [
                {
                    "key": "FILE_DIRECT",
                    "name": "Direct File"
                }
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    // Mount a tripwire on /teams/*/projects — the test fails if it
    // gets hit.
    Mock::given(method("GET"))
        .and(path("/v1/teams/team-tripwire/projects"))
        .respond_with(ResponseTemplate::new(500).set_body_string(
            "TRIPWIRE: list_files(Some(...)) must skip the team-projects fetch",
        ))
        .expect(0)
        .mount(&server)
        .await;

    let mut connector = FigmaConnector::with_base_url(&server.uri());
    connector.set_access_token("AT", 3600);
    connector.set_team_id("team-tripwire");

    let files = connector
        .list_files(Some("proj-direct"))
        .await
        .expect("direct list");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].id, "FILE_DIRECT");
}

#[tokio::test]
async fn list_files_team_projects_token_expired_returns_token_expired() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/teams/team-x/projects"))
        .respond_with(ResponseTemplate::new(401))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = FigmaConnector::with_base_url(&server.uri());
    connector.set_access_token("expired", 3600);
    connector.set_team_id("team-x");

    let err = connector.list_files(None).await.unwrap_err();
    let s = format!("{:?}", err);
    assert!(s.contains("TokenExpired"), "expected TokenExpired, got {s}");
}

#[tokio::test]
async fn list_files_permission_denied_when_figma_returns_403() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/teams/team-x/projects"))
        .respond_with(ResponseTemplate::new(403))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = FigmaConnector::with_base_url(&server.uri());
    connector.set_access_token("AT", 3600);
    connector.set_team_id("team-x");

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
        .and(path("/v1/teams/team-x/projects"))
        .respond_with(ResponseTemplate::new(429))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = FigmaConnector::with_base_url(&server.uri());
    connector.set_access_token("AT", 3600);
    connector.set_team_id("team-x");

    let err = connector.list_files(None).await.unwrap_err();
    let s = format!("{:?}", err);
    assert!(s.contains("RateLimited"), "expected RateLimited, got {s}");
    assert!(
        s.contains("retry_after_secs: 60"),
        "Figma handler hard-codes 60s; got {s}",
    );
}

#[tokio::test]
async fn list_files_without_team_id_is_invalid_config() {
    // Pin the precondition: `list_files(None)` requires a team_id set.
    // The mock server is unused — the error fires before any HTTP call.
    let server = MockServer::start().await;
    let mut connector = FigmaConnector::with_base_url(&server.uri());
    connector.set_access_token("AT", 3600);
    // intentionally NOT calling set_team_id

    let err = connector.list_files(None).await.unwrap_err();
    let s = format!("{:?}", err);
    assert!(
        s.contains("InvalidConfig"),
        "expected InvalidConfig when no team_id, got {s}",
    );
    assert!(
        s.contains("team_id"),
        "expected error to name team_id, got {s}",
    );
}

#[tokio::test]
async fn download_file_404_maps_to_file_not_found() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/files/MISSING_KEY"))
        .respond_with(ResponseTemplate::new(404))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = FigmaConnector::with_base_url(&server.uri());
    connector.set_access_token("AT", 3600);

    let err = connector.download_file("MISSING_KEY").await.unwrap_err();
    let s = format!("{:?}", err);
    assert!(s.contains("FileNotFound"), "expected FileNotFound, got {s}");
}

#[tokio::test]
async fn sync_changes_partitions_files_against_known_set() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/v1/teams/team-x/projects"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "projects": [
                { "id": "proj-1", "name": "P1" }
            ]
        })))
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/v1/projects/proj-1/files"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "files": [
                {
                    "key": "FILE_NEW",
                    "name": "New File",
                    "last_modified": "2024-06-15T12:00:00Z"
                },
                {
                    "key": "FILE_KNOWN",
                    "name": "Touched File",
                    "last_modified": "2024-06-14T12:00:00Z"
                }
            ]
        })))
        .mount(&server)
        .await;

    let mut connector = FigmaConnector::with_base_url(&server.uri());
    connector.set_access_token("AT", 3600);
    connector.set_team_id("team-x");

    let mut known = HashSet::new();
    known.insert("FILE_KNOWN".to_string());

    let result = connector
        .sync_changes(None, &known)
        .await
        .expect("sync_changes");
    assert!(
        result.added.iter().any(|f| f.id == "FILE_NEW"),
        "expected FILE_NEW in added, got {:?}",
        result.added,
    );
    assert!(
        result.modified.iter().any(|f| f.id == "FILE_KNOWN"),
        "expected FILE_KNOWN in modified, got {:?}",
        result.modified,
    );
}
