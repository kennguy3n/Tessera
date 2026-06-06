//! Hardware-aware local model runtime: sidecar orchestration, model
//! download/management, and text/vision/image generation adapters.
#![warn(missing_docs)]

pub mod adapters;
pub mod config;
pub mod download;
pub mod external_provider;
pub mod generation;
pub mod grammar;
pub mod health;
pub mod imagegen;
pub mod manager;
pub mod vision;

pub use adapters::{plan_chain, AdapterAvailability, AdapterKind, ChainInputs, ChainResult};
pub use external_provider::{ExternalGenerateInputs, ExternalProviderConfig, ExternalProviderType};
