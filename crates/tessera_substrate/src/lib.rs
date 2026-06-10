//! `tessera_substrate` — a thin adapter that wraps the
//! `kennguy3n/knowledge` substrate (evidence store, observation engine,
//! memory manager, concept graph, synthesis pipeline) and adapts its
//! multi-tenant, multi-scope, handle-based API to Tessera's single-user,
//! single-file, `OnceLock<AppState>` model.
//!
//! The integration is **additive**: it never touches Tessera's existing
//! `sources` / `chunks` / `chunk_embeddings` data. Substrate artifacts
//! live in their own SQLCipher sibling files, all derived from the one
//! master key Tessera already manages. See [`SubstrateManager`] for the
//! model-adaptation details.

mod error;
mod manager;
mod types;

pub use error::{Result, SubstrateError};
pub use manager::SubstrateManager;
pub use types::{
    DecaySweepSummary, EnrichedKnowledge, KnowledgeConcept, MemoryRecord, RelatedSourceSuggestion,
    SynthesisSummary,
};
