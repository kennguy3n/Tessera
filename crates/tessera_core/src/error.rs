//! The crate-wide `Error` type and `Result` alias.

use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
/// The error type returned by the Tessera core crate.
pub enum Error {
    #[error("IO error: {0}")]
    /// IO error.
    Io(#[from] std::io::Error),

    #[error("JSON serialization error: {0}")]
    /// JSON serialization error.
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
    /// Source not found.
    SourceNotFound(String),

    #[error("Artifact not found: {0}")]
    /// Artifact not found.
    ArtifactNotFound(String),

    #[error("Template not found: {0}")]
    /// Template not found.
    TemplateNotFound(String),

    #[error("Invalid path: {}", .0.display())]
    /// Invalid path.
    InvalidPath(PathBuf),

    #[error("Invalid configuration: {0}")]
    /// Invalid configuration.
    InvalidConfig(String),

    #[error("Extraction error for {path}: {message}")]
    /// Text extraction failed for a source file.
    Extraction {
        /// Path of the file whose extraction failed.
        path: String,
        /// Human-readable description of the failure.
        message: String,
    },

    #[error("Template validation error: {0}")]
    /// Template validation error.
    TemplateValidation(String),

    #[error("Export error: {0}")]
    /// Export error.
    Export(String),

    #[error("Audit error: {0}")]
    /// Audit error.
    Audit(String),

    #[error("Not found: {0}")]
    /// Not found.
    NotFound(String),
}

/// Result type alias.
pub type Result<T> = std::result::Result<T, Error>;
