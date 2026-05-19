use std::fmt;

#[derive(Debug)]
pub enum ConnectorError {
    AuthenticationFailed(String),
    TokenExpired,
    TokenRevoked,
    NetworkError(String),
    RateLimited { retry_after_secs: u64 },
    FileNotFound(String),
    PermissionDenied(String),
    ProviderError { provider: String, message: String },
    InvalidConfig(String),
    StorageError(String),
    SyncConflict(String),
    Io(std::io::Error),
}

impl fmt::Display for ConnectorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AuthenticationFailed(msg) => write!(f, "Authentication failed: {msg}"),
            Self::TokenExpired => write!(f, "OAuth token has expired"),
            Self::TokenRevoked => write!(f, "OAuth token has been revoked"),
            Self::NetworkError(msg) => write!(f, "Network error: {msg}"),
            Self::RateLimited { retry_after_secs } => {
                write!(f, "Rate limited, retry after {retry_after_secs}s")
            }
            Self::FileNotFound(id) => write!(f, "File not found: {id}"),
            Self::PermissionDenied(msg) => write!(f, "Permission denied: {msg}"),
            Self::ProviderError { provider, message } => {
                write!(f, "{provider} error: {message}")
            }
            Self::InvalidConfig(msg) => write!(f, "Invalid config: {msg}"),
            Self::StorageError(msg) => write!(f, "Storage error: {msg}"),
            Self::SyncConflict(msg) => write!(f, "Sync conflict: {msg}"),
            Self::Io(e) => write!(f, "IO error: {e}"),
        }
    }
}

impl std::error::Error for ConnectorError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for ConnectorError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<reqwest::Error> for ConnectorError {
    fn from(e: reqwest::Error) -> Self {
        Self::NetworkError(e.to_string())
    }
}

pub type ConnectorResult<T> = std::result::Result<T, ConnectorError>;
