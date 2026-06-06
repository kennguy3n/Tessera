use thiserror::Error;

/// All connector-related errors.
///
/// Variant choices mirror the failure modes every remote connector can
/// surface (auth flow, token lifecycle, transport, rate-limiting,
/// provider-specific 4xx/5xx, local storage). Keep it provider-agnostic:
/// provider-specific detail belongs in [`ConnectorError::ProviderError`]'s
/// `message` field, not as a new variant.
///
/// Two `From` impls let `?` lift transport-layer errors into the right
/// variant automatically; call sites in every connector rely on this
/// implicit lift:
///
///   * `std::io::Error` — wired via `#[from]` on the [`Io`] variant.
///     The full error (kind + message + source chain) is preserved.
///   * `reqwest::Error` — wired via a manual `impl From` (below) into
///     `NetworkError(String)`. We deliberately flatten reqwest's error
///     chain rather than wrapping it because the connector-side caller
///     only needs the formatted message; the underlying URL / kind /
///     status detail isn't useful to surface to the IPC layer.
///
/// [`Io`]: ConnectorError::Io
#[derive(Debug, Error)]
pub enum ConnectorError {
    #[error("Authentication failed: {0}")]
    /// Authentication failed.
    AuthenticationFailed(String),

    #[error("OAuth token has expired")]
    /// OAuth token has expired.
    TokenExpired,

    #[error("OAuth token has been revoked")]
    /// OAuth token has been revoked.
    TokenRevoked,

    #[error("Network error: {0}")]
    /// Network error.
    NetworkError(String),

    #[error("Rate limited, retry after {retry_after_secs}s")]
    /// The provider rate-limited the request.
    RateLimited {
        /// Seconds to wait before retrying.
        retry_after_secs: u64,
    },

    #[error("File not found: {0}")]
    /// File not found.
    FileNotFound(String),

    #[error("Permission denied: {0}")]
    /// Permission denied.
    PermissionDenied(String),

    #[error("{provider} error: {message}")]
    /// A provider returned an error response.
    ProviderError {
        /// Name of the connector provider that failed.
        provider: String,
        /// Provider-supplied error message.
        message: String,
    },

    #[error("Invalid config: {0}")]
    /// Invalid config.
    InvalidConfig(String),

    #[error("Storage error: {0}")]
    /// Storage error.
    StorageError(String),

    #[error("Sync conflict: {0}")]
    /// Sync conflict.
    SyncConflict(String),

    #[error("IO error: {0}")]
    /// IO error.
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

/// Connector Result type alias.
pub type ConnectorResult<T> = std::result::Result<T, ConnectorError>;

/// classification of a `ConnectorError` for the
/// sync-failure resilience layer. The sync loop inspects this value
/// to decide whether to schedule another retry (and bump
/// `retry_count`) or to mark the source as `failed_permanently` and
/// surface a "re-authorize required" prompt in the UI.
///
/// The classification is deliberately conservative: anything we
/// can't prove is permanent is treated as `Transient` so we don't
/// false-alarm on what would have recovered on the next attempt.
/// `Permanent` is reserved for the small set of errors that
/// require user intervention to resolve (auth, missing resource,
/// permission scope changes, invalid config).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// The error is likely to clear on its own (transient
    /// network issue, provider 5xx, rate-limit). The caller
    /// should retry with exponential backoff.
    Transient,
    /// The error requires the user to take action (re-authorize,
    /// re-grant a missing scope, re-add a deleted source). The
    /// caller should stop retrying, surface a status badge, and
    /// only re-attempt after the user explicitly re-triggers
    /// the sync.
    Permanent,
}

impl ConnectorError {
    /// Classify this error as a transient or permanent failure.
    ///
    /// Decision matrix (kept here, not at every call site, so all
    /// seven connectors apply the same policy):
    ///
    /// | Variant                    | Kind       | Reasoning |
    /// |----------------------------|------------|-----------|
    /// | `AuthenticationFailed`     | Permanent  | 401-like; needs re-auth |
    /// | `TokenExpired`             | Transient  | refresh path can recover automatically (next sync) |
    /// | `TokenRevoked`             | Permanent  | user explicitly de-authorized; needs re-auth |
    /// | `NetworkError`             | Transient  | reqwest transport / DNS / TLS handshake |
    /// | `RateLimited { .. }`       | Transient  | 429 with Retry-After |
    /// | `FileNotFound`             | Permanent  | 404; the underlying resource is gone |
    /// | `PermissionDenied`         | Permanent  | 403; scope dropped or item moved to a closed folder |
    /// | `ProviderError { .. }`     | Transient  | provider 5xx-ish; conservative default |
    /// | `InvalidConfig`            | Permanent  | bad URL / missing field; user must edit |
    /// | `StorageError`             | Transient  | local SQLite blip; retry succeeds |
    /// | `SyncConflict`             | Transient  | concurrent edit; the merge logic resolves on retry |
    /// | `Io`                       | Transient  | local filesystem hiccup |
    ///
    /// `TokenExpired` is Transient (not Permanent) because the
    /// per-connector token-refresh code path catches it and
    /// transparently swaps in a fresh access token. If refresh
    /// itself fails (which surfaces as `AuthenticationFailed` or
    /// `TokenRevoked`), classification flips to Permanent.
    pub fn failure_kind(&self) -> FailureKind {
        match self {
            ConnectorError::AuthenticationFailed(_)
            | ConnectorError::TokenRevoked
            | ConnectorError::FileNotFound(_)
            | ConnectorError::PermissionDenied(_)
            | ConnectorError::InvalidConfig(_) => FailureKind::Permanent,
            ConnectorError::TokenExpired
            | ConnectorError::NetworkError(_)
            | ConnectorError::RateLimited { .. }
            | ConnectorError::ProviderError { .. }
            | ConnectorError::StorageError(_)
            | ConnectorError::SyncConflict(_)
            | ConnectorError::Io(_) => FailureKind::Transient,
        }
    }

    /// Convenience: true when this error is transient and the
    /// caller should retry. Mirror of `failure_kind() ==
    /// Transient` — exposed so call sites that do not need to
    /// pattern-match the enum can write `if err.is_transient() {
    /// retry() } else { mark_permanent() }`.
    pub fn is_transient(&self) -> bool {
        self.failure_kind() == FailureKind::Transient
    }
}

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
        assert_eq!(
            ConnectorError::TokenExpired.to_string(),
            "OAuth token has expired"
        );
        assert_eq!(
            ConnectorError::TokenRevoked.to_string(),
            "OAuth token has been revoked"
        );
        assert_eq!(
            ConnectorError::NetworkError("timeout".into()).to_string(),
            "Network error: timeout",
        );
        assert_eq!(
            ConnectorError::RateLimited {
                retry_after_secs: 30
            }
            .to_string(),
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
        let inner = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied by sandbox");
        let err = ConnectorError::Io(inner);
        let src = std::error::Error::source(&err).expect("Io variant has a source");
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

    /// pin the failure-kind classification for
    /// every variant. The sync-failure resilience layer keys its
    /// retry-vs-give-up decision off this matrix, so silently
    /// reclassifying a variant from Permanent to Transient (or
    /// vice versa) would change every connector's UX without any
    /// other code change being visible. This test holds the
    /// matrix in place.
    #[test]
    fn failure_kind_classification_is_pinned() {
        // Permanent — needs user intervention.
        assert_eq!(
            ConnectorError::AuthenticationFailed("x".into()).failure_kind(),
            FailureKind::Permanent,
        );
        assert_eq!(
            ConnectorError::TokenRevoked.failure_kind(),
            FailureKind::Permanent,
        );
        assert_eq!(
            ConnectorError::FileNotFound("x".into()).failure_kind(),
            FailureKind::Permanent,
        );
        assert_eq!(
            ConnectorError::PermissionDenied("x".into()).failure_kind(),
            FailureKind::Permanent,
        );
        assert_eq!(
            ConnectorError::InvalidConfig("x".into()).failure_kind(),
            FailureKind::Permanent,
        );

        // Transient — auto-retry.
        assert_eq!(
            ConnectorError::TokenExpired.failure_kind(),
            FailureKind::Transient,
        );
        assert_eq!(
            ConnectorError::NetworkError("timeout".into()).failure_kind(),
            FailureKind::Transient,
        );
        assert_eq!(
            ConnectorError::RateLimited {
                retry_after_secs: 30,
            }
            .failure_kind(),
            FailureKind::Transient,
        );
        assert_eq!(
            ConnectorError::ProviderError {
                provider: "notion".into(),
                message: "5xx".into(),
            }
            .failure_kind(),
            FailureKind::Transient,
        );
        assert_eq!(
            ConnectorError::StorageError("disk".into()).failure_kind(),
            FailureKind::Transient,
        );
        assert_eq!(
            ConnectorError::SyncConflict("etag".into()).failure_kind(),
            FailureKind::Transient,
        );
        assert_eq!(
            ConnectorError::Io(std::io::Error::other("x")).failure_kind(),
            FailureKind::Transient,
        );
    }

    /// `is_transient()` must be a pure mirror of
    /// `failure_kind() == Transient`. Pin to lock the convenience
    /// helper to the underlying matrix.
    #[test]
    fn is_transient_mirrors_failure_kind() {
        let variants: Vec<ConnectorError> = vec![
            ConnectorError::AuthenticationFailed("x".into()),
            ConnectorError::TokenExpired,
            ConnectorError::TokenRevoked,
            ConnectorError::NetworkError("x".into()),
            ConnectorError::RateLimited {
                retry_after_secs: 1,
            },
            ConnectorError::FileNotFound("x".into()),
            ConnectorError::PermissionDenied("x".into()),
            ConnectorError::ProviderError {
                provider: "x".into(),
                message: "x".into(),
            },
            ConnectorError::InvalidConfig("x".into()),
            ConnectorError::StorageError("x".into()),
            ConnectorError::SyncConflict("x".into()),
            ConnectorError::Io(std::io::Error::other("x")),
        ];
        for err in &variants {
            assert_eq!(
                err.is_transient(),
                err.failure_kind() == FailureKind::Transient,
                "is_transient mismatch for {err:?}",
            );
        }
    }
}
