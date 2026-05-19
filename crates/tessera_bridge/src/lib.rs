pub mod artifacts;
pub mod citations;
pub mod exporter;
pub mod napi_exports;
pub mod settings;
pub mod sources;
pub mod templates;

use serde::{Deserialize, Serialize};
use tessera_core::error::Error;

#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("Core error: {0}")]
    Core(#[from] Error),

    #[error("Invalid arguments: {0}")]
    InvalidArgs(String),

    #[error("Serialization error: {0}")]
    Serialization(String),

    #[error("Not initialized")]
    NotInitialized,
}

pub type BridgeResult<T> = std::result::Result<T, BridgeError>;

#[derive(Debug, Serialize, Deserialize)]
pub struct BridgeResponse<T: Serialize> {
    pub success: bool,
    pub data: Option<T>,
    pub error: Option<String>,
}

impl<T: Serialize> BridgeResponse<T> {
    pub fn ok(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn err(message: String) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(message),
        }
    }
}
