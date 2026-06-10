//! N-API bridge exposing the Tessera Rust core to the Electron desktop
//! application.
#![warn(missing_docs)]

pub mod artifacts;
pub mod automations;
pub mod backup;
pub mod citations;
pub mod exporter;
pub mod napi_exports;
pub mod settings;
pub mod sources;
pub mod tasks;
pub mod templates;

use serde::{Deserialize, Serialize};
use tessera_core::error::Error;

#[derive(Debug, thiserror::Error)]
/// Error type for bridge operations, surfaced to JS as the
/// rejection message of the calling promise.
pub enum BridgeError {
    #[error("Core error: {0}")]
    /// An error propagated from the Tessera core layer.
    Core(#[from] Error),

    #[error("Invalid arguments: {0}")]
    /// Caller passed malformed input (e.g. an unparseable id).
    InvalidArgs(String),

    #[error("Serialization error: {0}")]
    /// A value failed to (de)serialize across the bridge.
    Serialization(String),

    #[error("Not initialized")]
    /// The global bridge state was used before initialization.
    NotInitialized,
}

/// Convenience `Result` alias for bridge operations.
pub type BridgeResult<T> = std::result::Result<T, BridgeError>;

#[derive(Debug, Serialize, Deserialize)]
/// Envelope wrapping a bridge result for the JS side: exactly one
/// of `data` / `error` is populated depending on `success`.
pub struct BridgeResponse<T: Serialize> {
    /// `true` when the operation succeeded (`data` is populated).
    pub success: bool,
    /// Payload on success; `None` on failure.
    pub data: Option<T>,
    /// Error message on failure; `None` on success.
    pub error: Option<String>,
}

impl<T: Serialize> BridgeResponse<T> {
    /// Builds a success envelope carrying `data`.
    pub fn ok(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }

    /// Builds a failure envelope carrying `message`.
    pub fn err(message: String) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(message),
        }
    }
}
