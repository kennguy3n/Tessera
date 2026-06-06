use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),

    /// A low-level SQLite failure surfaced by `rusqlite`. The underlying
    /// error is wrapped (not stringified) so callers can still match on the
    /// concrete `rusqlite::Error` variant — e.g. distinguishing
    /// `QueryReturnedNoRows` from a constraint violation — instead of
    /// pattern-matching against a message substring.
    #[error("Database error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    /// A database-layer invariant that does not correspond to a bare
    /// `rusqlite::Error`: schema/version validation, integrity-check
    /// failures, a poisoned connection mutex, or an at-rest crypto
    /// (DEK/AEAD) failure surfaced by a store. Carries a human-readable
    /// message because there is no single underlying error type to wrap.
    #[error("Database error: {0}")]
    DatabaseState(String),

    #[error("Source not found: {0}")]
    SourceNotFound(String),

    #[error("Artifact not found: {0}")]
    ArtifactNotFound(String),

    #[error("Template not found: {0}")]
    TemplateNotFound(String),

    #[error("Invalid path: {}", .0.display())]
    InvalidPath(PathBuf),

    #[error("Invalid configuration: {0}")]
    InvalidConfig(String),

    #[error("Extraction error for {path}: {message}")]
    Extraction { path: String, message: String },

    #[error("Template validation error: {0}")]
    TemplateValidation(String),

    #[error("Export error: {0}")]
    Export(String),

    #[error("Audit error: {0}")]
    Audit(String),

    #[error("Not found: {0}")]
    NotFound(String),
}

pub type Result<T> = std::result::Result<T, Error>;
