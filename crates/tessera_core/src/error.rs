use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Database error: {0}")]
    Database(String),

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
}

pub type Result<T> = std::result::Result<T, Error>;
