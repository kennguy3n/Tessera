//! End-to-end wiremock integration tests for the OneDrive connector.
//!
//! These complement the inline `#[tokio::test]` cases in `src/onedrive.rs`
//! by exercising the connector at its public-API surface — the same way
//! a downstream Tessera caller (`runConnectorSync` in
//! `apps/desktop/electron/ipc/connectors/handlers.ts`) would. The inline
//! tests target individual helpers (delta parsing, drive-item shape, the
//! authorise URL builder); these tests pin the orchestration of
//! authenticate → list → download → sync → revoke and the four error
//! paths the production code routes for the user (`TokenExpired`,
//! `RateLimited`, `FileNotFound`, `PermissionDenied`).
//!
//! Devin Review note: the wiremock servers run on `localhost:0` and are
//! torn down at the end of each test. They share no global state.

use std::collections::HashSet;

use wiremock::matchers::{body_string_contains, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use tessera_connectors::onedrive::OneDriveConnector;
use tessera_connectors::types::{AuthConfig, ConnectorStatus};

fn auth_config() -> AuthConfig {
    AuthConfig::new(
        "test-client-id".into(),
        "test-client-secret".into(),
        "http://localhost:9876/callback".into(),
    )
    .with_scopes(vec!["Files.Read.All".into()])
    .with_auth_code("the-code".into())
}

#[tokio::test]
async fn full_lifecycle_authenticate_list_download_revoke() {
    let server = MockServer::start().await;

    // 1. OAuth token exchange — Microsoft Graph hits `/common/oauth2/v2.0/token`.
    Mock::given(method("POST"))
        .and(path("/common/oauth2/v2.0/token"))
        .and(body_string_contains("grant_type=authorization_code"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "graph-access-token",
            "refresh_token": "graph-refresh-token",
            "expires_in": 3600,
            "token_type": "Bearer",
        })))
        .expect(1)
        .mount(&server)
        .await;

    // 2. List the root — return a folder + a file.
    Mock::given(method("GET"))
        .and(path("/graph/me/drive/root/children"))
        .and(header("Authorization", "Bearer graph-access-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "value": [
                {
                    "id": "folder-1",
                    "name": "Projects",
                    "folder": { "childCount": 3 },
                    "lastModifiedDateTime": "2024-01-15T10:00:00Z"
                },
                {
                    "id": "file-abc",
                    "name": "Quarterly-Plan.docx",
                    "size": 51_200,
                    "file": { "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
                    "lastModifiedDateTime": "2024-06-01T12:00:00Z"
                }
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    // 3. Download the file's bytes.
    Mock::given(method("GET"))
        .and(path("/graph/me/drive/items/file-abc/content"))
        .and(header("Authorization", "Bearer graph-access-token"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(b"DOCX BODY".to_vec()))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = OneDriveConnector::with_base_url(&server.uri());
    let tokens = connector.authenticate(&auth_config()).await.expect("auth");
    assert_eq!(tokens.access_token, "graph-access-token");
    assert_eq!(connector.status(), ConnectorStatus::Connected);

    let files = connector.list_files(None).await.expect("list");
    assert_eq!(files.len(), 2);
    assert!(files[0].is_folder);
    assert_eq!(files[0].name, "Projects");
    assert!(!files[1].is_folder);
    assert_eq!(files[1].name, "Quarterly-Plan.docx");
    assert_eq!(files[1].size_bytes, 51_200);

    let bytes = connector.download_file("file-abc").await.expect("download");
    assert_eq!(bytes, b"DOCX BODY");

    // Revoke — OneDrive's `revoke()` clears local state; Microsoft Graph
    // does not expose a server-side revocation endpoint, so the call is
    // local-only and must NOT hit the mock server.
    connector.revoke().await.expect("revoke");
    assert_eq!(connector.status(), ConnectorStatus::Disconnected);
    assert_eq!(connector.file_count(), 0);
}

#[tokio::test]
async fn list_files_in_folder_targets_items_endpoint() {
    // The list_files implementation switches the URL when given a
    // non-root folder id: `/me/drive/items/{id}/children` instead of
    // `/me/drive/root/children`. Pin this routing so a future refactor
    // doesn't accidentally collapse them.
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/graph/me/drive/items/folder-77/children"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "value": [
                {
                    "id": "nested-file",
                    "name": "Inside.txt",
                    "size": 12,
                    "file": { "mimeType": "text/plain" },
                    "lastModifiedDateTime": "2024-06-02T10:00:00Z"
                }
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = OneDriveConnector::with_base_url(&server.uri());
    connector.set_access_token("AT", 3600);

    let files = connector
        .list_files(Some("folder-77"))
        .await
        .expect("list in folder");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].name, "Inside.txt");
}

#[tokio::test]
async fn list_files_rate_limited_with_retry_after_header() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/graph/me/drive/root/children"))
        .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "42"))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = OneDriveConnector::with_base_url(&server.uri());
    connector.set_access_token("AT", 3600);

    let err = connector.list_files(None).await.unwrap_err();
    let s = format!("{:?}", err);
    assert!(s.contains("RateLimited"), "expected RateLimited, got {s}");
    assert!(
        s.contains("retry_after_secs: 42"),
        "expected the Retry-After header to be parsed, got {s}",
    );
}

#[tokio::test]
async fn list_files_permission_denied_surfaces_403_body() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/graph/me/drive/root/children"))
        .respond_with(
            ResponseTemplate::new(403).set_body_string("insufficient scope: Files.Read.All"),
        )
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = OneDriveConnector::with_base_url(&server.uri());
    connector.set_access_token("AT", 3600);

    let err = connector.list_files(None).await.unwrap_err();
    let s = format!("{:?}", err);
    assert!(
        s.contains("PermissionDenied"),
        "expected PermissionDenied, got {s}",
    );
    assert!(
        s.contains("insufficient scope"),
        "expected upstream body in the error, got {s}",
    );
}

#[tokio::test]
async fn download_file_not_found_maps_to_file_not_found() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/graph/me/drive/items/missing/content"))
        .respond_with(ResponseTemplate::new(404))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = OneDriveConnector::with_base_url(&server.uri());
    connector.set_access_token("AT", 3600);

    let err = connector.download_file("missing").await.unwrap_err();
    let s = format!("{:?}", err);
    assert!(s.contains("FileNotFound"), "expected FileNotFound, got {s}");
}

#[tokio::test]
async fn sync_changes_distinguishes_added_known_and_removed() {
    let server = MockServer::start().await;

    let delta_link = format!("{}/graph/me/drive/root/delta?token=DELTA-2", server.uri());
    Mock::given(method("GET"))
        .and(path("/graph/me/drive/root/delta"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "value": [
                {
                    "id": "added-1",
                    "name": "Added.txt",
                    "size": 4,
                    "file": { "mimeType": "text/plain" },
                    "lastModifiedDateTime": "2024-06-01T00:00:00Z"
                },
                {
                    "id": "known-1",
                    "name": "Known.txt",
                    "size": 4,
                    "file": { "mimeType": "text/plain" },
                    "lastModifiedDateTime": "2024-06-01T00:00:00Z"
                },
                {
                    "id": "deleted-1",
                    "name": "Deleted.txt",
                    "deleted": { "state": "deleted" }
                }
            ],
            "@odata.deltaLink": delta_link
        })))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = OneDriveConnector::with_base_url(&server.uri());
    connector.set_access_token("AT", 3600);

    let mut known = HashSet::new();
    known.insert("known-1".to_string());

    let result = connector.sync_changes(None, &known).await.expect("sync");
    assert_eq!(result.added.len(), 1);
    assert_eq!(result.added[0].id, "added-1");
    assert_eq!(result.removed.len(), 1);
    assert_eq!(result.removed[0], "deleted-1");
    assert!(
        result
            .new_change_token
            .as_deref()
            .is_some_and(|t| t.contains("DELTA-2")),
        "expected new delta token to surface, got {:?}",
        result.new_change_token,
    );
}

#[tokio::test]
async fn list_files_token_expired_returns_token_expired_error() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/graph/me/drive/root/children"))
        .respond_with(ResponseTemplate::new(401))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = OneDriveConnector::with_base_url(&server.uri());
    connector.set_access_token("expired-token", 3600);

    let err = connector.list_files(None).await.unwrap_err();
    let s = format!("{:?}", err);
    assert!(s.contains("TokenExpired"), "expected TokenExpired, got {s}");
}
