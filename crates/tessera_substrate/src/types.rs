//! Plain, serde-friendly value types returned across the substrate
//! boundary. These intentionally avoid leaking the knowledge crates'
//! internal enums so the `tessera_bridge` N-API layer can map them to
//! stable TypeScript shapes.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// One substrate sibling database file, used by the backup layer.
///
/// Returned by [`crate::SubstrateManager::snapshot_into`] (where `path`
/// points at a freshly-produced, consistent snapshot inside the
/// caller's staging dir) and by [`crate::substrate_sibling_entries`]
/// (where `path` is the *live* sibling next to Tessera's main DB, used
/// as the on-disk restore target). Its `role` / `arcname` are stable so
/// an export entry and the matching import target line up by name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubstrateFileEntry {
    /// Stable role tag recorded in a backup manifest
    /// (`substrate-evidence` / `substrate-concepts`).
    pub role: String,
    /// Stable archive name used inside a bundle and to match an export
    /// entry to its import target (no directory component).
    pub arcname: String,
    /// Filesystem path: the produced snapshot (export) or the live
    /// sibling to restore into (import).
    pub path: PathBuf,
}

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

/// A concept-graph node surfaced to the desktop UI as part of an
/// enriched search result (`SubstrateManager::search_knowledge`).
///
/// Concepts are the entity nodes the observation pipeline extracted
/// across the corpus; `related_source_ids` are the Tessera sources the
/// concept co-occurs in (resolved from the `entity --PartOf--> source`
/// edges in the concept graph). The renderer renders these in the
/// "Knowledge" tab so a search surfaces *what the corpus knows about a
/// topic*, not just the chunks that lexically match.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KnowledgeConcept {
    /// Concept node id (UUID).
    pub id: String,
    /// Human-readable concept label (the extracted entity surface).
    pub label: String,
    /// Short definition / provenance tag for the node.
    pub definition: String,
    /// Concept lifecycle state: `candidate`, `canonical`,
    /// `superseded`, `contradicted`, or `deleted`.
    pub state: String,
    /// Tessera source ids (UUID strings) this concept co-occurs in.
    pub related_source_ids: Vec<String>,
}

/// The knowledge-plane half of an enriched search: the entities,
/// facts, concepts, and memory items the substrate matched for a query.
///
/// This is purely additive context that accompanies the standard
/// chunk-level [`crate::MemoryRecord`]-free hit list produced by
/// Tessera's existing hybrid search. `entities` and `facts` are
/// disjoint projections of `memories` by observation type, pre-split
/// so the renderer's "Knowledge" tab does not have to re-bucket them.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EnrichedKnowledge {
    /// Memory items whose observation type is `entity`, ranked by
    /// query relevance then retention.
    pub entities: Vec<MemoryRecord>,
    /// Memory items whose observation type is `fact`, `claim`, or
    /// `decision`, ranked by query relevance then retention.
    pub facts: Vec<MemoryRecord>,
    /// Concept-graph nodes matching the query, with their related
    /// sources.
    pub concepts: Vec<KnowledgeConcept>,
    /// All matching memory items (any observation type), ranked by
    /// query relevance then retention. Superset of `entities`/`facts`.
    pub memories: Vec<MemoryRecord>,
}

/// A concept-graph-derived suggestion of sources related to a working
/// set the user has already selected
/// (`SubstrateManager::suggest_related_sources`).
///
/// "You have N sources about [entity]. Include them?" — `entity` is the
/// shared concept, `source_ids` are the related (not-yet-selected)
/// Tessera sources, and `score` is the number of related sources (used
/// for ranking suggestions).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelatedSourceSuggestion {
    /// Concept label the suggestion is anchored on.
    pub entity: String,
    /// Related Tessera source ids (UUID strings) not already selected.
    pub source_ids: Vec<String>,
    /// Ranking signal: the number of related sources.
    pub score: u32,
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
