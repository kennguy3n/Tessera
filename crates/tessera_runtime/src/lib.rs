//! Hardware-aware local model runtime: sidecar orchestration, model
//! download/management, and text/vision/image generation adapters.
#![warn(missing_docs)]

pub mod adapters;
/// The `config` module.
pub mod config;
pub mod download;
pub mod external_provider;
/// The `generation` module.
pub mod generation;
/// The `grammar` module.
pub mod grammar;
/// The `health` module.
pub mod health;
pub mod imagegen;
/// The `manager` module.
pub mod manager;
pub mod vision;

pub use adapters::{plan_chain, AdapterAvailability, AdapterKind, ChainInputs, ChainResult};
pub use external_provider::{ExternalGenerateInputs, ExternalProviderConfig, ExternalProviderType};
