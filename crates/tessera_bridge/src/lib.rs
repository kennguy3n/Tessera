//! N-API bridge exposing the Tessera Rust core to the Electron desktop
//! application.
#![warn(missing_docs)]

/// The `artifacts` module.
pub mod artifacts;
pub mod automations;
/// The `citations` module.
pub mod citations;
/// The `exporter` module.
pub mod exporter;
/// The `napi_exports` module.
pub mod napi_exports;
/// The `settings` module.
pub mod settings;
/// The `sources` module.
pub mod sources;
pub mod tasks;
/// The `templates` module.
pub mod templates;

use serde::{Deserialize, Serialize};
use tessera_core::error::Error;

#[derive(Debug, thiserror::Error)]
/// Bridge Error.
pub enum BridgeError {
    #[error("Core error: {0}")]
    /// Core error.
    Core(#[from] Error),

    #[error("Invalid arguments: {0}")]
    /// Invalid arguments.
    InvalidArgs(String),

    #[error("Serialization error: {0}")]
    /// Serialization error.
    Serialization(String),

    #[error("Not initialized")]
    /// Not initialized.
    NotInitialized,
}

/// Bridge Result type alias.
pub type BridgeResult<T> = std::result::Result<T, BridgeError>;

#[derive(Debug, Serialize, Deserialize)]
/// Bridge Response.
pub struct BridgeResponse<T: Serialize> {
    /// Success.
    pub success: bool,
    /// Data.
    pub data: Option<T>,
    /// Error.
    pub error: Option<String>,
}

impl<T: Serialize> BridgeResponse<T> {
    /// Ok.
    pub fn ok(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }

    /// Err.
    pub fn err(message: String) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(message),
        }
    }
}
