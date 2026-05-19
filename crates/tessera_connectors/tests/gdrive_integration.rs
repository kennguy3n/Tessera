use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

use tessera_connectors::gdrive::GoogleDriveConnector;
use tessera_connectors::types::{AuthConfig, ConnectorStatus};

fn auth_config(redirect: &str) -> AuthConfig {
    AuthConfig::new(
        "test-client-id".into(),
        "test-client-secret".into(),
        redirect.into(),
    )
    .with_auth_code("test-auth-code".into())
}

#[tokio::test]
async fn authenticate_exchanges_code_for_tokens() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "ya29.mock-access-token",
            "refresh_token": "1//mock-refresh-token",
            "expires_in": 3600,
            "token_type": "Bearer"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = GoogleDriveConnector::with_base_url(&server.uri());
    let config = auth_config("http://localhost:9876/callback");

    let tokens = connector.authenticate(&config).await.unwrap();
    assert_eq!(tokens.access_token, "ya29.mock-access-token");
    assert_eq!(tokens.refresh_token.as_deref(), Some("1//mock-refresh-token"));
    assert_eq!(connector.status(), ConnectorStatus::Connected);
}

#[tokio::test]
async fn authenticate_fails_on_bad_response() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(401).set_body_string("invalid_grant"))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = GoogleDriveConnector::with_base_url(&server.uri());
    let config = auth_config("http://localhost/callback");

    let result = connector.authenticate(&config).await;
    assert!(result.is_err());
    assert_eq!(connector.status(), ConnectorStatus::Error);
}

#[tokio::test]
async fn list_files_returns_files_and_folders() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/drive/v3/files"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "files": [
                {
                    "id": "folder-1",
                    "name": "Reports",
                    "mimeType": "application/vnd.google-apps.folder",
                    "modifiedTime": "2024-01-15T10:00:00.000Z",
                    "parents": ["root"]
                },
                {
                    "id": "file-abc",
                    "name": "Q4-report.pdf",
                    "mimeType": "application/pdf",
                    "size": "204800",
                    "modifiedTime": "2024-06-01T12:00:00.000Z",
                    "parents": ["folder-1"]
                }
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = GoogleDriveConnector::with_base_url(&server.uri());
    connector.set_access_token("test-token", 3600);
    

    let files = connector.list_files(None).await.unwrap();
    assert_eq!(files.len(), 2);
    assert!(files[0].is_folder);
    assert_eq!(files[0].name, "Reports");
    assert!(!files[1].is_folder);
    assert_eq!(files[1].name, "Q4-report.pdf");
    assert_eq!(files[1].size_bytes, 204_800);
}

#[tokio::test]
async fn list_files_handles_pagination() {
    let server = MockServer::start().await;

    // First page
    Mock::given(method("GET"))
        .and(path("/drive/v3/files"))
        .and(query_param("pageSize", "100"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "nextPageToken": "page2-token",
            "files": [
                {
                    "id": "file-1",
                    "name": "doc1.txt",
                    "mimeType": "text/plain",
                    "modifiedTime": "2024-01-01T00:00:00.000Z"
                }
            ]
        })))
        .up_to_n_times(1)
        .mount(&server)
        .await;

    // Second page
    Mock::given(method("GET"))
        .and(path("/drive/v3/files"))
        .and(query_param("pageToken", "page2-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "files": [
                {
                    "id": "file-2",
                    "name": "doc2.txt",
                    "mimeType": "text/plain",
                    "modifiedTime": "2024-01-02T00:00:00.000Z"
                }
            ]
        })))
        .up_to_n_times(1)
        .mount(&server)
        .await;

    let mut connector = GoogleDriveConnector::with_base_url(&server.uri());
    connector.set_access_token("test-token", 3600);
    

    let files = connector.list_files(None).await.unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].name, "doc1.txt");
    assert_eq!(files[1].name, "doc2.txt");
}

#[tokio::test]
async fn download_file_returns_bytes() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/drive/v3/files/file-123"))
        .and(query_param("alt", "media"))
        .respond_with(
            ResponseTemplate::new(200).set_body_bytes(b"PDF file content here".to_vec()),
        )
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = GoogleDriveConnector::with_base_url(&server.uri());
    connector.set_access_token("test-token", 3600);
    

    let bytes = connector.download_file("file-123").await.unwrap();
    assert_eq!(bytes, b"PDF file content here");
}

#[tokio::test]
async fn download_file_not_found() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/drive/v3/files/missing-id"))
        .respond_with(ResponseTemplate::new(404))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = GoogleDriveConnector::with_base_url(&server.uri());
    connector.set_access_token("test-token", 3600);
    

    let result = connector.download_file("missing-id").await;
    assert!(result.is_err());
    let err_str = format!("{:?}", result.unwrap_err());
    assert!(err_str.contains("FileNotFound") || err_str.contains("not found"), "unexpected error: {err_str}");
}

#[tokio::test]
async fn sync_changes_processes_additions_and_removals() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/drive/v3/changes"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "newStartPageToken": "new-token-456",
            "changes": [
                {
                    "removed": false,
                    "fileId": "new-file-1",
                    "file": {
                        "id": "new-file-1",
                        "name": "new-report.docx",
                        "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        "size": "51200",
                        "modifiedTime": "2024-06-15T08:00:00.000Z"
                    }
                },
                {
                    "removed": true,
                    "fileId": "deleted-file-2"
                }
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = GoogleDriveConnector::with_base_url(&server.uri());
    connector.set_access_token("test-token", 3600);
    

    let result = connector.sync_changes(Some("old-token-123")).await.unwrap();
    assert_eq!(result.added.len(), 1);
    assert_eq!(result.removed.len(), 1);
    assert_eq!(result.added[0].name, "new-report.docx");
    assert_eq!(result.removed[0], "deleted-file-2");
    assert_eq!(result.new_change_token.as_deref(), Some("new-token-456"));
    assert_eq!(connector.status(), ConnectorStatus::Connected);
}

#[tokio::test]
async fn list_files_handles_rate_limit() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/drive/v3/files"))
        .respond_with(ResponseTemplate::new(429))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = GoogleDriveConnector::with_base_url(&server.uri());
    connector.set_access_token("test-token", 3600);
    

    let result = connector.list_files(None).await;
    assert!(result.is_err());
    let err_str = format!("{:?}", result.unwrap_err());
    assert!(err_str.contains("RateLimited"), "unexpected error: {err_str}");
}

#[tokio::test]
async fn revoke_clears_state_and_disconnects() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/revoke"))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = GoogleDriveConnector::with_base_url(&server.uri());
    connector.set_access_token("ya29.test", 3600);

    connector.revoke().await.unwrap();
    assert_eq!(connector.status(), ConnectorStatus::Disconnected);
    assert!(connector.last_sync_time().is_none());
    assert_eq!(connector.file_count(), 0);
}

#[tokio::test]
async fn list_files_token_expired_returns_error() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/drive/v3/files"))
        .respond_with(ResponseTemplate::new(401))
        .expect(1)
        .mount(&server)
        .await;

    let mut connector = GoogleDriveConnector::with_base_url(&server.uri());
    connector.set_access_token("expired-token", 3600);

    let result = connector.list_files(None).await;
    assert!(result.is_err());
    let err_str = format!("{:?}", result.unwrap_err());
    assert!(err_str.contains("TokenExpired"), "unexpected error: {err_str}");
}
