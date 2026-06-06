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

    #[error("Database error: {0}")]
    /// Database error.
    Database(String),

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
