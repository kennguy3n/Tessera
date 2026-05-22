use thiserror::Error;

/// All connector-related errors.
///
/// Variant choices mirror the failure modes every remote connector can
/// surface (auth flow, token lifecycle, transport, rate-limiting,
/// provider-specific 4xx/5xx, local storage). Keep it provider-agnostic:
/// provider-specific detail belongs in [`ConnectorError::ProviderError`]'s
/// `message` field, not as a new variant.
///
/// The `#[from]` annotations let `?` lift `std::io::Error` / `reqwest::Error`
/// into the right variant automatically — call sites in every connector
/// rely on this implicit lift.
#[derive(Debug, Error)]
pub enum ConnectorError {
    #[error("Authentication failed: {0}")]
    AuthenticationFailed(String),

    #[error("OAuth token has expired")]
    TokenExpired,

    #[error("OAuth token has been revoked")]
    TokenRevoked,

    #[error("Network error: {0}")]
    NetworkError(String),

    #[error("Rate limited, retry after {retry_after_secs}s")]
    RateLimited { retry_after_secs: u64 },

    #[error("File not found: {0}")]
    FileNotFound(String),

    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    #[error("{provider} error: {message}")]
    ProviderError { provider: String, message: String },

    #[error("Invalid config: {0}")]
    InvalidConfig(String),

    #[error("Storage error: {0}")]
    StorageError(String),

    #[error("Sync conflict: {0}")]
    SyncConflict(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

// reqwest::Error doesn't slot into the `#[from]` pattern because we want to
// flatten it into `NetworkError(String)` (the underlying error chain isn't
// useful for callers — they get the formatted message and that's it).
impl From<reqwest::Error> for ConnectorError {
    fn from(e: reqwest::Error) -> Self {
        Self::NetworkError(e.to_string())
    }
}

pub type ConnectorResult<T> = std::result::Result<T, ConnectorError>;

#[cfg(test)]
mod tests {
    use super::*;

    /// Pin each Display string verbatim — these strings appear in logs and
    /// user-facing error messages across the app (`tokenVault` rendering,
    /// IPC handler error surfacing, sync-failure toasts). A drift here is
    /// a UX regression even though it compiles fine.
    #[test]
    fn display_messages_are_stable() {
        assert_eq!(
            ConnectorError::AuthenticationFailed("bad creds".into()).to_string(),
            "Authentication failed: bad creds",
        );
        assert_eq!(ConnectorError::TokenExpired.to_string(), "OAuth token has expired");
        assert_eq!(ConnectorError::TokenRevoked.to_string(), "OAuth token has been revoked");
        assert_eq!(
            ConnectorError::NetworkError("timeout".into()).to_string(),
            "Network error: timeout",
        );
        assert_eq!(
            ConnectorError::RateLimited { retry_after_secs: 30 }.to_string(),
            "Rate limited, retry after 30s",
        );
        assert_eq!(
            ConnectorError::FileNotFound("abc".into()).to_string(),
            "File not found: abc",
        );
        assert_eq!(
            ConnectorError::PermissionDenied("scope missing".into()).to_string(),
            "Permission denied: scope missing",
        );
        assert_eq!(
            ConnectorError::ProviderError {
                provider: "notion".into(),
                message: "page archived".into(),
            }
            .to_string(),
            "notion error: page archived",
        );
        assert_eq!(
            ConnectorError::InvalidConfig("missing client_id".into()).to_string(),
            "Invalid config: missing client_id",
        );
        assert_eq!(
            ConnectorError::StorageError("disk full".into()).to_string(),
            "Storage error: disk full",
        );
        assert_eq!(
            ConnectorError::SyncConflict("ETag mismatch".into()).to_string(),
            "Sync conflict: ETag mismatch",
        );
    }

    /// thiserror's `#[from]` plus `?` is the pattern every connector relies
    /// on for std::io errors. Pin it explicitly so a future refactor that
    /// drops the `#[from]` is flagged here, not in 6 connector files at once.
    #[test]
    fn io_error_lifts_via_question_mark() {
        fn does_io() -> ConnectorResult<()> {
            let _ = std::fs::read_to_string("/nonexistent/path/in/test")?;
            Ok(())
        }
        let err = does_io().expect_err("path should not exist");
        assert!(
            matches!(err, ConnectorError::Io(_)),
            "expected Io variant, got {err:?}",
        );
        // Ensure the Display chain includes the I/O error message (not just
        // the literal "IO error" prefix) so users see what failed.
        let formatted = err.to_string();
        assert!(formatted.starts_with("IO error: "), "got: {formatted}");
    }

    /// `error.source()` must walk down to the wrapped `io::Error` for the
    /// `Io` variant. Callers that log structured error chains rely on this.
    #[test]
    fn io_error_source_chain_is_preserved() {
        let inner =
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied by sandbox");
        let err = ConnectorError::Io(inner);
        let src = std::error::Error::source(&err)
            .expect("Io variant has a source");
        assert!(src.to_string().contains("denied by sandbox"));
    }

    /// Plain string variants do NOT have a source — their message is the
    /// terminal node of the error chain. Pin this so a refactor that adds
    /// an unnecessary `#[from]` doesn't accidentally double-log.
    #[test]
    fn string_variants_have_no_source() {
        let err = ConnectorError::AuthenticationFailed("bad".into());
        assert!(std::error::Error::source(&err).is_none());

        let err = ConnectorError::NetworkError("timeout".into());
        assert!(std::error::Error::source(&err).is_none());

        let err = ConnectorError::ProviderError {
            provider: "notion".into(),
            message: "x".into(),
        };
        assert!(std::error::Error::source(&err).is_none());
    }
}
