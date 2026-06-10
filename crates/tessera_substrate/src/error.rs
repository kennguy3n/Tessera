//! Error type for the substrate adapter.

use thiserror::Error;

/// Errors surfaced by [`crate::SubstrateManager`].
///
/// Wraps the underlying knowledge-crate errors behind a single
/// Tessera-facing type so the bridge layer can map every failure to a
/// stable N-API error string without depending on the substrate's
/// internal error enums.
#[derive(Debug, Error)]
pub enum SubstrateError {
    /// A `master_key` / `db_key` hex string was not 64 lower/upper-case
    /// hex characters (32 bytes).
    #[error("substrate db key must be 64 hex characters, got {0}")]
    InvalidKeyLength(usize),

    /// A `db_key` hex string contained a non-hex character.
    #[error("substrate db key is not valid hex: {0}")]
    InvalidKeyHex(String),

    /// A caller passed an id string that is not a valid UUID.
    #[error("invalid uuid: {0}")]
    InvalidUuid(String),

    /// The evidence store rejected an operation.
    #[error("evidence store error: {0}")]
    Evidence(#[from] evidence_store::EvidenceError),

    /// The concept graph rejected an operation.
    #[error("concept graph error: {0}")]
    Graph(#[from] concept_graph::GraphError),

    /// The observation pipeline failed to extract from text.
    #[error("observation engine error: {0}")]
    Observation(#[from] observation_engine::ObservationError),

    /// Key derivation failed.
    #[error("crypto error: {0}")]
    Crypto(#[from] knowledge_crypto::CryptoError),

    /// (De)serialization of a persisted substrate payload failed.
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    /// A memory object referenced by id was not found.
    #[error("memory not found: {0}")]
    MemoryNotFound(String),
}

/// Convenience result alias for substrate operations.
pub type Result<T> = std::result::Result<T, SubstrateError>;
