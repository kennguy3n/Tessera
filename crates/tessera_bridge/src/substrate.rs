//! N-API surface for the additive knowledge substrate.
//!
//! These nine entry points are the FOUNDATIONAL contract the UI and
//! search sessions wire to. They mirror Tessera's existing
//! `napi-derive` style (snake_case `bridge_*` functions returning
//! `napi::Result<T>` with `#[napi(object)]` DTOs), and they delegate to
//! the [`tessera_substrate::SubstrateManager`] held in the global
//! `AppState`. The substrate is additive: none of these functions touch
//! the existing `sources` / `chunks` / `chunk_embeddings` tables.

use napi_derive::napi;

use tessera_substrate::{
    DecaySweepSummary, KnowledgeConcept, MemoryRecord, RelatedSourceSuggestion, SynthesisSummary,
};

use crate::napi_exports::{extract_observations_for_source, substrate_lock, SUBSTRATE_UNAVAILABLE};

/// A memory object as surfaced to the renderer.
#[napi(object)]
pub struct SubstrateMemory {
    /// Memory object id (UUID).
    pub id: String,
    /// Scope id (UUID) the memory belongs to.
    pub scope_id: String,
    /// Observation kind: `entity`, `fact`, `task`, `decision`,
    /// `claim`, or `question`.
    pub observation_type: String,
    /// Canonical surface text of the observation.
    pub content: String,
    /// Decay state: `candidate`, `reinforced`, `consolidated`,
    /// `canonical`, `superseded`, `archived`, or `deleted`.
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
    /// Unix epoch seconds of last access.
    pub last_accessed_at: i64,
    /// Originating Tessera source id (UUID), when known.
    pub source_id: Option<String>,
}

impl From<MemoryRecord> for SubstrateMemory {
    fn from(record: MemoryRecord) -> Self {
        Self {
            id: record.id,
            scope_id: record.scope_id,
            observation_type: record.observation_type,
            content: record.content,
            state: record.state,
            retention_score: record.retention_score,
            pin_count: record.pin_count,
            retrieval_count: record.retrieval_count,
            corroboration_count: record.corroboration_count,
            created_at: record.created_at,
            last_accessed_at: record.last_accessed_at,
            source_id: record.source_id,
        }
    }
}

/// A concept-graph node surfaced to the renderer as part of an
/// enriched search (the "Knowledge" tab).
#[napi(object)]
pub struct SubstrateConcept {
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

impl From<KnowledgeConcept> for SubstrateConcept {
    fn from(concept: KnowledgeConcept) -> Self {
        Self {
            id: concept.id,
            label: concept.label,
            definition: concept.definition,
            state: concept.state,
            related_source_ids: concept.related_source_ids,
        }
    }
}

/// A concept-graph-derived suggestion of related sources for the
/// artifact-creation flow ("You have N sources about `[entity]`.").
#[napi(object)]
pub struct SubstrateRelatedSuggestion {
    /// Concept label the suggestion is anchored on.
    pub entity: String,
    /// Related Tessera source ids (UUID strings) not already selected.
    pub source_ids: Vec<String>,
    /// Ranking signal: the number of related sources.
    pub score: u32,
}

impl From<RelatedSourceSuggestion> for SubstrateRelatedSuggestion {
    fn from(suggestion: RelatedSourceSuggestion) -> Self {
        Self {
            entity: suggestion.entity,
            source_ids: suggestion.source_ids,
            score: suggestion.score,
        }
    }
}

/// Outcome of a decay sweep over all persisted memories.
#[napi(object)]
pub struct SubstrateDecayReport {
    /// Number of objects whose retention score was recomputed.
    pub scored: u32,
    /// Number of `Candidate -> Archived` transitions.
    pub candidates_archived: u32,
    /// Number of `Superseded -> Archived` transitions.
    pub superseded_archived: u32,
}

impl From<DecaySweepSummary> for SubstrateDecayReport {
    fn from(summary: DecaySweepSummary) -> Self {
        Self {
            scored: summary.scored,
            candidates_archived: summary.candidates_archived,
            superseded_archived: summary.superseded_archived,
        }
    }
}

/// Result of a synthesis run for a scope.
#[napi(object)]
pub struct SubstrateSynthesis {
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

impl From<SynthesisSummary> for SubstrateSynthesis {
    fn from(summary: SynthesisSummary) -> Self {
        Self {
            window_id: summary.window_id,
            scope_id: summary.scope_id,
            version: summary.version,
            recap: summary.recap,
            decisions: summary.decisions,
            open_questions: summary.open_questions,
            active_tasks: summary.active_tasks,
        }
    }
}

/// Run the observation pipeline over a source's indexed chunks and
/// persist the extracted observations, memory objects, and concept
/// nodes. Idempotent per `source_id`. Returns the number of
/// observations extracted.
///
/// This is the on-demand counterpart to the automatic extraction that
/// runs after `bridge_add_local_folder` / `bridge_add_local_file` /
/// `bridge_add_kchat_channel` / `bridge_reindex_source`.
#[napi]
pub fn bridge_extract_observations(source_id: String) -> napi::Result<u32> {
    extract_observations_for_source(&source_id)
}

/// List all memory objects for a scope. `scope` is a scope label or
/// UUID; `null`/omitted uses the single default scope.
#[napi]
pub fn bridge_get_memories(scope: Option<String>) -> napi::Result<Vec<SubstrateMemory>> {
    let guard = substrate_lock()?
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let manager = guard
        .as_ref()
        .ok_or_else(|| napi::Error::from_reason(SUBSTRATE_UNAVAILABLE))?;
    let records = manager
        .list_memories(scope.as_deref())
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(records.into_iter().map(SubstrateMemory::from).collect())
}

/// Suggest sources related to an already-selected working set, via the
/// concept graph. Powers the artifact-creation "You have N sources
/// about `[entity]`. Include them?" affordance.
///
/// `selected_source_ids` is the user's current selection (source UUID
/// strings); suggestions never include an already-selected source and
/// are capped at `max_suggestions` (a `null`/omitted limit applies a
/// default of 10). Returns suggestions ranked by how many related
/// sources each concept pulls in.
#[napi]
pub fn bridge_suggest_related_sources(
    selected_source_ids: Vec<String>,
    max_suggestions: Option<u32>,
) -> napi::Result<Vec<SubstrateRelatedSuggestion>> {
    let max = max_suggestions.map_or(10, |n| n as usize);
    let mut guard = substrate_lock()?
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let manager = guard
        .as_mut()
        .ok_or_else(|| napi::Error::from_reason(SUBSTRATE_UNAVAILABLE))?;
    let suggestions = manager
        .suggest_related_sources(&selected_source_ids, max)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(suggestions
        .into_iter()
        .map(SubstrateRelatedSuggestion::from)
        .collect())
}

/// Pin a memory by id — the strongest retention signal — promoting a
/// `Candidate` to `Reinforced`. Returns the updated memory.
#[napi]
pub fn bridge_pin_memory(id: String) -> napi::Result<SubstrateMemory> {
    let mut guard = substrate_lock()?
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let manager = guard
        .as_mut()
        .ok_or_else(|| napi::Error::from_reason(SUBSTRATE_UNAVAILABLE))?;
    manager
        .pin_memory(&id)
        .map(SubstrateMemory::from)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Decrement a memory's pin count (saturating at zero). Returns the
/// updated memory.
#[napi]
pub fn bridge_unpin_memory(id: String) -> napi::Result<SubstrateMemory> {
    let mut guard = substrate_lock()?
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let manager = guard
        .as_mut()
        .ok_or_else(|| napi::Error::from_reason(SUBSTRATE_UNAVAILABLE))?;
    manager
        .unpin_memory(&id)
        .map(SubstrateMemory::from)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Forget (delete) a single memory by id so its content is no longer
/// recoverable from the persisted memory plane.
#[napi]
pub fn bridge_forget_memory(id: String) -> napi::Result<()> {
    let mut guard = substrate_lock()?
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let manager = guard
        .as_mut()
        .ok_or_else(|| napi::Error::from_reason(SUBSTRATE_UNAVAILABLE))?;
    manager
        .forget_memory(&id)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Return a JSON-serialized concept-graph view for a scope, bounded by
/// `max_nodes` (substrate default applies when `null`/omitted). The
/// JSON shape is `concept_graph::GraphView` — nodes, edges, and a
/// truncation marker — which the renderer parses directly.
#[napi]
pub fn bridge_get_concept_graph(
    scope: Option<String>,
    max_nodes: Option<u32>,
) -> napi::Result<String> {
    let mut guard = substrate_lock()?
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let manager = guard
        .as_mut()
        .ok_or_else(|| napi::Error::from_reason(SUBSTRATE_UNAVAILABLE))?;
    manager
        .concept_graph_json(scope.as_deref(), max_nodes.map(|n| n as usize))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Recompute retention scores for every memory and apply decay
/// transitions. Returns a report of how many objects were scored and
/// archived. Called on a 6-hour timer by the Electron main process.
#[napi]
pub fn bridge_run_decay_sweep() -> napi::Result<SubstrateDecayReport> {
    let mut guard = substrate_lock()?
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let manager = guard
        .as_mut()
        .ok_or_else(|| napi::Error::from_reason(SUBSTRATE_UNAVAILABLE))?;
    manager
        .run_decay_sweep()
        .map(SubstrateDecayReport::from)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Produce a deterministic, offline synthesis (recap, decisions, open
/// questions, active tasks) for a scope and persist it as a versioned
/// synthesis object. `scope` is a scope label or UUID; `null`/omitted
/// uses the default scope.
#[napi]
pub fn bridge_trigger_synthesis(scope: Option<String>) -> napi::Result<SubstrateSynthesis> {
    let mut guard = substrate_lock()?
        .lock()
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let manager = guard
        .as_mut()
        .ok_or_else(|| napi::Error::from_reason(SUBSTRATE_UNAVAILABLE))?;
    manager
        .trigger_synthesis(scope.as_deref())
        .map(SubstrateSynthesis::from)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}
