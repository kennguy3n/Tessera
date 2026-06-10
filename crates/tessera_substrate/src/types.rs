//! Plain, serde-friendly value types returned across the substrate
//! boundary. These intentionally avoid leaking the knowledge crates'
//! internal enums so the `tessera_bridge` N-API layer can map them to
//! stable TypeScript shapes.

use serde::{Deserialize, Serialize};

/// A memory object as surfaced to the desktop UI.
///
/// Derived from a knowledge `MemoryObject`; the `observation_type`,
/// `content`, and `source_id` are lifted out of the object's freeform
/// metadata so the renderer does not have to understand the substrate's
/// metadata schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryRecord {
    /// Memory object id (UUID).
    pub id: String,
    /// Scope id (UUID) the memory belongs to.
    pub scope_id: String,
    /// Observation kind: `entity`, `fact`, `task`, `decision`,
    /// `claim`, or `question`.
    pub observation_type: String,
    /// Canonical surface text of the observation.
    pub content: String,
    /// Decay state machine state: `candidate`, `reinforced`,
    /// `consolidated`, `canonical`, `superseded`, `archived`, or
    /// `deleted`.
    pub state: String,
    /// Last computed retention score in `0.0 ..= 1.0`.
    pub retention_score: f64,
    /// Number of pins (strongest retention signal).
    pub pin_count: u32,
    /// Number of times retrieved as part of an answered query.
    pub retrieval_count: u32,
    /// Number of independent corroborating sources.
    pub corroboration_count: u32,
    /// Unix epoch seconds of creation.
    pub created_at: i64,
    /// Unix epoch seconds of last access (read / pin / corroboration).
    pub last_accessed_at: i64,
    /// Originating Tessera source id (UUID), when known.
    pub source_id: Option<String>,
}

/// Outcome of a decay sweep over all persisted memories.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecaySweepSummary {
    /// Number of objects whose retention score was recomputed.
    pub scored: u32,
    /// Number of `Candidate -> Archived` transitions.
    pub candidates_archived: u32,
    /// Number of `Superseded -> Archived` transitions.
    pub superseded_archived: u32,
}

/// Result of a synthesis run for a scope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SynthesisSummary {
    /// Synthesis window id (UUID).
    pub window_id: String,
    /// Scope id (UUID) the synthesis covers.
    pub scope_id: String,
    /// Version stamp of the persisted synthesis object.
    pub version: u32,
    /// Free-text recap headline.
    pub recap: String,
    /// Decisions captured during the window.
    pub decisions: Vec<String>,
    /// Open questions captured during the window.
    pub open_questions: Vec<String>,
    /// Active tasks captured during the window.
    pub active_tasks: Vec<String>,
}
