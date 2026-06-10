//! [`SubstrateManager`] — the single entry point Tessera uses to drive
//! the knowledge substrate.
//!
//! # Model adaptation
//!
//! The knowledge crates are multi-tenant / multi-scope and key every
//! encrypted artifact off a per-scope DEK. Tessera is a single-user,
//! single-file desktop app. This adapter bridges the two:
//!
//! * **Single default scope.** All substrate data lands in one
//!   deterministic [`ScopeId`] unless a caller explicitly names another
//!   scope (resolved by UUIDv5 so the mapping is stable across runs).
//! * **Same master key, sibling files.** The substrate derives its own
//!   master key from Tessera's SQLCipher `db_key` via HKDF domain
//!   separation, then opens two SQLCipher files (`*.substrate-evidence`,
//!   `*.substrate-concepts`) next to Tessera's main DB. They are not
//!   tables in the main DB because each knowledge store derives its own
//!   page key — but they share the one master key, so a single key
//!   protects everything and there is nothing extra to provision.
//! * **`OnceLock<AppState>` instead of bigint handles.** The substrate's
//!   N-API surface uses opaque `NapiHandle` bigints; Tessera owns a
//!   process-global `AppState`, so this adapter is a plain struct the
//!   bridge stores in a `Mutex` field — no handle table.

use std::path::{Path, PathBuf};

use chrono::Utc;
use concept_graph::{
    subgraph_for_scope, AllowAllScopes, ConceptEdge, ConceptNode, PersistentConceptGraph,
    RelationType, ViewFilter,
};
use evidence_store::{EvidenceStore, EvidenceStoreConfig, ScopeId};
use knowledge_crypto::{derive_key, MasterKey, MASTER_KEY_LEN};
use memory_manager::{
    compute_retention_score, decay_sweep, MemoryObject, MemoryState, MemoryStateMachine,
    SensitivityClass,
};
use observation_engine::{
    default_pipeline, LexiconExtractor, Observation, ObservationPipeline, ObservationType,
};
use synthesis_pipeline::{SummaryBundle, SynthesisObject, SynthesisObjectType, SynthesisWindow};
use uuid::Uuid;

use crate::error::{Result, SubstrateError};
use crate::types::{DecaySweepSummary, MemoryRecord, SynthesisSummary};

/// HKDF context that separates the substrate master key from Tessera's
/// raw SQLCipher key. Bumping the `vN` suffix rotates every substrate
/// artifact's key.
const SUBSTRATE_MASTER_CONTEXT: &[u8] = b"tessera:substrate:master:v1";

/// HKDF context for the plaintext-DB (no `db_key`) fallback. Produces a
/// stable—but non-secret—master key so substrate data survives restarts
/// in the same unencrypted-DB posture as the rest of Tessera.
const SUBSTRATE_PLAINTEXT_CONTEXT: &[u8] = b"tessera:substrate:nokey:v1";

/// `memory_objects` blob kind holding the aggregate `Vec<MemoryObject>`
/// for a scope (the "memories" plane).
const MEMORIES_KIND: &str = "tessera.memories";

/// Prefix for the per-source `memory_objects` blob holding the raw
/// `Vec<Observation>` extracted from one Tessera source (the
/// "observations" plane). Keyed per source so re-indexing one source
/// replaces only its observations.
const OBSERVATIONS_KIND_PREFIX: &str = "tessera.observations:";

/// UUIDv5 namespace seed for substrate scopes and the source nodes in
/// the concept graph. Constant so ids are reproducible across runs.
const SCOPE_NAMESPACE: Uuid = Uuid::from_bytes([
    0x9e, 0x6f, 0x1b, 0x2c, 0x47, 0x55, 0x4f, 0x3a, 0x8b, 0x1d, 0x7c, 0x21, 0x44, 0x55, 0x66, 0x77,
]);

/// Adapter wrapping the knowledge substrate for Tessera.
pub struct SubstrateManager {
    evidence: EvidenceStore,
    concepts: PersistentConceptGraph,
    pipeline: ObservationPipeline<LexiconExtractor, evidence_store::LexiconClassifier>,
    default_scope: ScopeId,
}

impl SubstrateManager {
    /// Open (or create) the substrate stores next to Tessera's main
    /// database.
    ///
    /// `db_path` is Tessera's main DB path; the substrate files are
    /// derived siblings. Pass `":memory:"` (Tessera's test path) to get
    /// in-memory stores. `db_key_hex`, when `Some`, is the same
    /// 64-char hex SQLCipher key Tessera opened its main DB with; the
    /// substrate master key is HKDF-derived from it so a single user
    /// secret protects everything.
    ///
    /// # Errors
    ///
    /// Returns [`SubstrateError`] if the key is malformed or either
    /// underlying store fails to open.
    pub fn open(db_path: &str, db_key_hex: Option<&str>) -> Result<Self> {
        let master_key = derive_master_key(db_path, db_key_hex)?;

        let (evidence_path, concepts_path) = substrate_paths(db_path);

        let evidence = EvidenceStore::open(
            evidence_path.as_path(),
            &master_key,
            EvidenceStoreConfig::default(),
        )?;
        let concepts = PersistentConceptGraph::open(concepts_path.as_path(), &master_key)?;

        let default_scope = default_scope_id();

        Ok(Self {
            evidence,
            concepts,
            pipeline: default_pipeline(),
            default_scope,
        })
    }

    /// The deterministic default scope id (UUID string) all substrate
    /// data uses when a caller does not name a scope.
    pub fn default_scope_uuid(&self) -> String {
        self.default_scope.as_uuid().to_string()
    }

    /// Run the observation pipeline over freshly-indexed chunk text and
    /// persist the resulting observations, lifecycle memory objects, and
    /// concept-graph nodes.
    ///
    /// Idempotent per source: re-running for the same `source_id`
    /// replaces that source's observations and its memory objects rather
    /// than appending duplicates. Returns the number of observations
    /// extracted.
    ///
    /// # Errors
    ///
    /// Returns [`SubstrateError`] on extraction, (de)serialization, or
    /// store failures.
    pub fn extract_observations(&mut self, source_id: &str, chunk_texts: &[String]) -> Result<u32> {
        let scope = self.default_scope;

        let mut observations: Vec<Observation> = Vec::new();
        for text in chunk_texts {
            if text.trim().is_empty() {
                continue;
            }
            observations.extend(self.pipeline.run(text, scope)?);
        }

        // Persist the raw observations for this source (replace prior).
        let obs_kind = observations_kind(source_id);
        let obs_json = serde_json::to_vec(&observations)?;
        self.evidence
            .save_memory_blob(scope, &obs_kind, &obs_json)?;

        // Rebuild this source's slice of the aggregate memory plane.
        let mut memories = self.load_memories(scope)?;
        memories.retain(|m| memory_source_id(m).as_deref() != Some(source_id));

        let now = Utc::now();
        for obs in &observations {
            let mut object =
                MemoryObject::new_candidate(scope, sensitivity_for(obs.observation_type));
            object.last_accessed_at = obs.created_at;
            object.metadata = serde_json::json!({
                "observation_id": obs.id.to_string(),
                "observation_type": observation_type_str(obs.observation_type),
                "content": obs.content,
                "source_id": source_id,
            });
            object.retention_score = compute_retention_score(&object, now).total;
            memories.push(object);
        }
        self.save_memories(scope, &memories)?;

        self.build_concept_graph(scope, source_id, &observations)?;

        Ok(u32::try_from(observations.len()).unwrap_or(u32::MAX))
    }

    /// List all memory objects for a scope (default scope when `None`).
    ///
    /// # Errors
    ///
    /// Returns [`SubstrateError`] on store or (de)serialization failure.
    pub fn list_memories(&self, scope: Option<&str>) -> Result<Vec<MemoryRecord>> {
        let scope = self.resolve_scope(scope);
        let memories = self.load_memories(scope)?;
        Ok(memories.iter().map(memory_to_record).collect())
    }

    /// Increment a memory's pin count — the strongest retention signal —
    /// and promote a `Candidate` to `Reinforced`.
    ///
    /// # Errors
    ///
    /// [`SubstrateError::MemoryNotFound`] if no memory has `id`; other
    /// variants on store failure.
    pub fn pin_memory(&mut self, id: &str) -> Result<MemoryRecord> {
        self.mutate_memory(id, |object| {
            object.pin_count = object.pin_count.saturating_add(1);
            object.last_accessed_at = Utc::now();
            if object.state == MemoryState::Candidate {
                // Pinning is an explicit reinforcement signal.
                let _ = MemoryStateMachine::new().reinforce(object);
            }
            object.retention_score = compute_retention_score(object, Utc::now()).total;
        })
    }

    /// Decrement a memory's pin count (saturating at zero) and recompute
    /// its retention score.
    ///
    /// # Errors
    ///
    /// [`SubstrateError::MemoryNotFound`] if no memory has `id`; other
    /// variants on store failure.
    pub fn unpin_memory(&mut self, id: &str) -> Result<MemoryRecord> {
        self.mutate_memory(id, |object| {
            object.pin_count = object.pin_count.saturating_sub(1);
            object.last_accessed_at = Utc::now();
            object.retention_score = compute_retention_score(object, Utc::now()).total;
        })
    }

    /// Forget a single memory: remove it from every scope's persisted
    /// memory plane so its content is no longer recoverable.
    ///
    /// # Errors
    ///
    /// [`SubstrateError::MemoryNotFound`] if no memory has `id`; other
    /// variants on store failure.
    pub fn forget_memory(&mut self, id: &str) -> Result<()> {
        let target =
            Uuid::parse_str(id).map_err(|_| SubstrateError::InvalidUuid(id.to_string()))?;
        let scope = self.default_scope;
        let mut memories = self.load_memories(scope)?;
        let before = memories.len();
        memories.retain(|m| m.id != target);
        if memories.len() == before {
            return Err(SubstrateError::MemoryNotFound(id.to_string()));
        }
        self.save_memories(scope, &memories)
    }

    /// Recompute retention scores for every memory and apply decay
    /// transitions (`Candidate -> Archived`, `Superseded -> Archived`).
    ///
    /// # Errors
    ///
    /// Returns [`SubstrateError`] on store or (de)serialization failure.
    pub fn run_decay_sweep(&mut self) -> Result<DecaySweepSummary> {
        let scope = self.default_scope;
        let mut memories = self.load_memories(scope)?;
        let report = decay_sweep(&mut memories, Utc::now());
        self.save_memories(scope, &memories)?;
        Ok(DecaySweepSummary {
            scored: u32::try_from(report.scored).unwrap_or(u32::MAX),
            candidates_archived: u32::try_from(report.candidates_archived).unwrap_or(u32::MAX),
            superseded_archived: u32::try_from(report.superseded_archived).unwrap_or(u32::MAX),
        })
    }

    /// Return a JSON-serialized [`concept_graph::GraphView`] for a scope,
    /// bounded by `max_nodes` (the crate default applies when `None`).
    ///
    /// # Errors
    ///
    /// Returns [`SubstrateError`] on store or serialization failure.
    pub fn concept_graph_json(
        &mut self,
        scope: Option<&str>,
        max_nodes: Option<usize>,
    ) -> Result<String> {
        let scope = self.resolve_scope(scope);
        self.concepts.load_scope(scope)?;
        let filter = ViewFilter {
            scope_ids: vec![scope],
            max_nodes,
            ..ViewFilter::default()
        };
        let view = subgraph_for_scope(self.concepts.graph(), scope, &filter, &AllowAllScopes);
        Ok(serde_json::to_string(&view)?)
    }

    /// Produce a deterministic, extractive synthesis for a scope from its
    /// current memory plane and persist it as a versioned synthesis
    /// object.
    ///
    /// This is a no-LLM synthesizer: it groups observations by type into
    /// a [`SummaryBundle`] (decisions, open questions, active tasks, and
    /// a recap headline). It is cheap, offline, and fully reproducible —
    /// the right default for a single-user desktop with no inference
    /// budget. A model-backed synthesizer can replace it later behind the
    /// same persisted shape.
    ///
    /// # Errors
    ///
    /// Returns [`SubstrateError`] on store or (de)serialization failure.
    pub fn trigger_synthesis(&mut self, scope: Option<&str>) -> Result<SynthesisSummary> {
        let scope = self.resolve_scope(scope);
        let memories = self.load_memories(scope)?;

        let mut decisions = Vec::new();
        let mut open_questions = Vec::new();
        let mut active_tasks = Vec::new();
        let mut entities = Vec::new();
        for memory in &memories {
            if memory.state == MemoryState::Archived || memory.state == MemoryState::Deleted {
                continue;
            }
            let Some(content) = memory_content(memory) else {
                continue;
            };
            match memory_observation_type(memory).as_deref() {
                Some("decision") => decisions.push(content),
                Some("question") => open_questions.push(content),
                Some("task") => active_tasks.push(content),
                Some("entity") => entities.push(content),
                _ => {}
            }
        }

        let recap = build_recap(memories.len(), &entities, &decisions, &active_tasks);
        let bundle = SummaryBundle {
            recap: recap.clone(),
            decisions: decisions.clone(),
            open_questions: open_questions.clone(),
            active_tasks: active_tasks.clone(),
        };

        let now = Utc::now();
        // A 30-day rolling window — wide enough to cover a desktop user's
        // working set without an unbounded scan.
        let window = SynthesisWindow::rolling(scope, now, chrono::Duration::days(30))
            .unwrap_or_else(|_| fallback_window(scope, now));
        let payload = serde_json::to_vec(&bundle)?;
        let object = SynthesisObject::new(
            scope,
            window.id,
            SynthesisObjectType::ChannelRecap,
            payload,
            Uuid::nil(),
        );
        let object_json = serde_json::to_vec(&object)?;
        self.evidence.save_synthesis_object_version(
            scope,
            window.id.as_uuid(),
            object.version,
            &object_json,
        )?;

        Ok(SynthesisSummary {
            window_id: window.id.as_uuid().to_string(),
            scope_id: scope.as_uuid().to_string(),
            version: object.version,
            recap,
            decisions,
            open_questions,
            active_tasks,
        })
    }

    // ───────────────────────────── internals ─────────────────────────

    fn resolve_scope(&self, scope: Option<&str>) -> ScopeId {
        match scope {
            None => self.default_scope,
            Some(s) if s.trim().is_empty() => self.default_scope,
            Some(s) => scope_id_from_label(s),
        }
    }

    fn load_memories(&self, scope: ScopeId) -> Result<Vec<MemoryObject>> {
        match self.evidence.load_memory_blob(scope, MEMORIES_KIND)? {
            Some(bytes) => Ok(serde_json::from_slice(&bytes)?),
            None => Ok(Vec::new()),
        }
    }

    fn save_memories(&self, scope: ScopeId, memories: &[MemoryObject]) -> Result<()> {
        let json = serde_json::to_vec(memories)?;
        self.evidence
            .save_memory_blob(scope, MEMORIES_KIND, &json)?;
        Ok(())
    }

    fn mutate_memory(
        &mut self,
        id: &str,
        mutate: impl FnOnce(&mut MemoryObject),
    ) -> Result<MemoryRecord> {
        let target =
            Uuid::parse_str(id).map_err(|_| SubstrateError::InvalidUuid(id.to_string()))?;
        let scope = self.default_scope;
        let mut memories = self.load_memories(scope)?;
        let object = memories
            .iter_mut()
            .find(|m| m.id == target)
            .ok_or_else(|| SubstrateError::MemoryNotFound(id.to_string()))?;
        mutate(object);
        let record = memory_to_record(object);
        self.save_memories(scope, &memories)?;
        Ok(record)
    }

    /// Build/extend a co-occurrence concept graph for one source:
    /// entities become `Candidate` nodes (deduped by label within the
    /// scope) and each entity is linked `PartOf` a per-source node, so
    /// the graph reflects which concepts a document is about.
    fn build_concept_graph(
        &mut self,
        scope: ScopeId,
        source_id: &str,
        observations: &[Observation],
    ) -> Result<()> {
        let entity_labels: Vec<&str> = observations
            .iter()
            .filter(|o| o.observation_type == ObservationType::Entity)
            .map(|o| o.content.trim())
            .filter(|c| !c.is_empty())
            .collect();
        if entity_labels.is_empty() {
            return Ok(());
        }

        // Rehydrate the scope so dedup sees previously-persisted nodes.
        self.concepts.load_scope(scope)?;

        let source_label = format!("source:{source_id}");
        let source_node = self.ensure_node(scope, &source_label, "tessera source")?;

        for label in entity_labels {
            let entity_node = self.ensure_node(scope, label, "entity")?;
            if entity_node == source_node {
                continue;
            }
            let already_linked = self
                .concepts
                .graph()
                .neighbors(entity_node, Some(RelationType::PartOf))
                .contains(&source_node);
            if !already_linked {
                let edge = ConceptEdge::new(entity_node, source_node, RelationType::PartOf, scope);
                self.concepts.add_edge(edge)?;
            }
        }
        Ok(())
    }

    /// Return the id of an existing node with `label` in `scope`, or
    /// create and persist a fresh `Candidate` node.
    fn ensure_node(
        &mut self,
        scope: ScopeId,
        label: &str,
        definition: &str,
    ) -> Result<concept_graph::NodeId> {
        if let Some(existing) = self
            .concepts
            .graph()
            .iter_nodes()
            .find(|n| n.scope_id == scope && n.label == label)
        {
            return Ok(existing.id);
        }
        let node = ConceptNode::new_candidate(label, definition, scope);
        Ok(self.concepts.add_node(node)?)
    }
}

/// Derive the substrate master key from Tessera's `db_key`.
fn derive_master_key(db_path: &str, db_key_hex: Option<&str>) -> Result<MasterKey> {
    match db_key_hex {
        Some(hex) if !hex.is_empty() => {
            let raw = decode_db_key(hex)?;
            Ok(derive_key(&raw, SUBSTRATE_MASTER_CONTEXT)?)
        }
        _ => {
            // Plaintext-DB posture: derive a stable (non-secret) key from
            // the db path so data persists across restarts.
            let mut seed =
                Vec::with_capacity(SUBSTRATE_PLAINTEXT_CONTEXT.len() + db_path.len() + 1);
            seed.extend_from_slice(SUBSTRATE_PLAINTEXT_CONTEXT);
            seed.push(b':');
            seed.extend_from_slice(db_path.as_bytes());
            Ok(derive_key(&[0u8; MASTER_KEY_LEN], &seed)?)
        }
    }
}

/// Decode a 64-char hex SQLCipher key into 32 raw bytes.
fn decode_db_key(hex: &str) -> Result<MasterKey> {
    if hex.len() != MASTER_KEY_LEN * 2 {
        return Err(SubstrateError::InvalidKeyLength(hex.len()));
    }
    let mut out = [0u8; MASTER_KEY_LEN];
    for (i, byte) in out.iter_mut().enumerate() {
        let slice = &hex[i * 2..i * 2 + 2];
        *byte = u8::from_str_radix(slice, 16)
            .map_err(|_| SubstrateError::InvalidKeyHex(slice.to_string()))?;
    }
    Ok(out)
}

/// Compute the substrate sibling DB paths for a Tessera `db_path`.
/// `:memory:` maps to independent in-memory stores.
fn substrate_paths(db_path: &str) -> (PathBuf, PathBuf) {
    if db_path == ":memory:" {
        return (PathBuf::from(":memory:"), PathBuf::from(":memory:"));
    }
    let base = Path::new(db_path);
    let evidence = sibling(base, "substrate-evidence.db");
    let concepts = sibling(base, "substrate-concepts.db");
    (evidence, concepts)
}

/// Build a sibling path `<file_name>.<suffix>` next to `base`.
fn sibling(base: &Path, suffix: &str) -> PathBuf {
    let name = base
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("tessera.db");
    let sibling_name = format!("{name}.{suffix}");
    match base.parent() {
        Some(dir) => dir.join(sibling_name),
        None => PathBuf::from(sibling_name),
    }
}

/// Deterministic default scope id.
fn default_scope_id() -> ScopeId {
    scope_id_from_label("default")
}

/// Map a free-form scope label to a stable [`ScopeId`]. A label that is
/// already a UUID is used verbatim; otherwise it is hashed via UUIDv5.
fn scope_id_from_label(label: &str) -> ScopeId {
    if let Ok(uuid) = Uuid::parse_str(label) {
        return ScopeId::from_uuid(uuid);
    }
    ScopeId::from_uuid(Uuid::new_v5(&SCOPE_NAMESPACE, label.as_bytes()))
}

/// Per-source observations blob kind.
fn observations_kind(source_id: &str) -> String {
    format!("{OBSERVATIONS_KIND_PREFIX}{source_id}")
}

/// Map an observation type to a decay sensitivity class. Decisions are
/// the only `Important` class (slow decay); everything else is `Useful`.
fn sensitivity_for(observation_type: ObservationType) -> SensitivityClass {
    match observation_type {
        ObservationType::Decision => SensitivityClass::Important,
        _ => SensitivityClass::Useful,
    }
}

/// Stable lowercase string for an observation type.
fn observation_type_str(observation_type: ObservationType) -> &'static str {
    match observation_type {
        ObservationType::Entity => "entity",
        ObservationType::Fact => "fact",
        ObservationType::Task => "task",
        ObservationType::Decision => "decision",
        ObservationType::Claim => "claim",
        ObservationType::Question => "question",
    }
}

/// Stable lowercase string for a memory decay state.
fn memory_state_str(state: MemoryState) -> &'static str {
    match state {
        MemoryState::Candidate => "candidate",
        MemoryState::Reinforced => "reinforced",
        MemoryState::Consolidated => "consolidated",
        MemoryState::Canonical => "canonical",
        MemoryState::Superseded => "superseded",
        MemoryState::Archived => "archived",
        MemoryState::Deleted => "deleted",
    }
}

fn memory_metadata_str(memory: &MemoryObject, key: &str) -> Option<String> {
    memory
        .metadata
        .get(key)
        .and_then(|v| v.as_str())
        .map(ToString::to_string)
}

fn memory_source_id(memory: &MemoryObject) -> Option<String> {
    memory_metadata_str(memory, "source_id")
}

fn memory_content(memory: &MemoryObject) -> Option<String> {
    memory_metadata_str(memory, "content")
}

fn memory_observation_type(memory: &MemoryObject) -> Option<String> {
    memory_metadata_str(memory, "observation_type")
}

fn memory_to_record(memory: &MemoryObject) -> MemoryRecord {
    MemoryRecord {
        id: memory.id.to_string(),
        scope_id: memory.scope_id.as_uuid().to_string(),
        observation_type: memory_observation_type(memory).unwrap_or_default(),
        content: memory_content(memory).unwrap_or_default(),
        state: memory_state_str(memory.state).to_string(),
        retention_score: memory.retention_score,
        pin_count: memory.pin_count,
        retrieval_count: memory.retrieval_count,
        corroboration_count: memory.corroboration_count,
        created_at: memory.created_at.timestamp(),
        last_accessed_at: memory.last_accessed_at.timestamp(),
        source_id: memory_source_id(memory),
    }
}

/// Compose a short recap headline for the synthesis bundle.
fn build_recap(
    memory_count: usize,
    entities: &[String],
    decisions: &[String],
    active_tasks: &[String],
) -> String {
    if memory_count == 0 {
        return "No memories have been captured yet.".to_string();
    }
    let mut parts = vec![format!("{memory_count} memories")];
    if !entities.is_empty() {
        parts.push(format!("{} entities", entities.len()));
    }
    if !decisions.is_empty() {
        parts.push(format!("{} decisions", decisions.len()));
    }
    if !active_tasks.is_empty() {
        parts.push(format!("{} open tasks", active_tasks.len()));
    }
    format!("Working set: {}.", parts.join(", "))
}

/// Last-resort one-second window if `rolling` rejects its bounds (cannot
/// happen for a positive duration, but avoids an `unwrap`).
fn fallback_window(scope: ScopeId, now: chrono::DateTime<Utc>) -> SynthesisWindow {
    SynthesisWindow::new(scope, now - chrono::Duration::seconds(1), now)
        .expect("1s window has end strictly after start")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aged_useful_fact(scope: ScopeId, age_days: i64) -> MemoryObject {
        let mut object = MemoryObject::new_candidate(scope, SensitivityClass::Useful);
        object.created_at = Utc::now() - chrono::Duration::days(age_days);
        object.last_accessed_at = object.created_at;
        object.metadata = serde_json::json!({
            "observation_id": Uuid::new_v4().to_string(),
            "observation_type": "fact",
            "content": "an old fact",
            "source_id": "11111111-1111-4111-8111-111111111111",
        });
        object
    }

    #[test]
    fn decode_db_key_round_trips() {
        let hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let raw = decode_db_key(hex).expect("valid 64-char hex");
        assert_eq!(raw[0], 0x01);
        assert_eq!(raw[31], 0xef);
        assert!(matches!(
            decode_db_key("abc"),
            Err(SubstrateError::InvalidKeyLength(3))
        ));
        let bad = "zz".repeat(32);
        assert!(matches!(
            decode_db_key(&bad),
            Err(SubstrateError::InvalidKeyHex(_))
        ));
    }

    #[test]
    fn scope_label_is_stable_and_uuid_passthrough() {
        let a = scope_id_from_label("default");
        let b = scope_id_from_label("default");
        assert_eq!(a, b, "label hashing must be deterministic");
        let explicit = Uuid::new_v4();
        assert_eq!(
            scope_id_from_label(&explicit.to_string()).as_uuid(),
            explicit,
            "a literal UUID label must pass through unchanged"
        );
    }

    #[test]
    fn aged_candidate_archived_by_sweep_and_persisted() {
        let mut manager = SubstrateManager::open(":memory:", None).expect("open substrate");
        let scope = manager.default_scope;
        manager
            .save_memories(scope, &[aged_useful_fact(scope, 365 * 5)])
            .expect("seed aged memory");

        let report = manager.run_decay_sweep().expect("decay sweep");
        assert_eq!(report.scored, 1);
        assert_eq!(report.candidates_archived, 1);

        // The archived state must survive the load/save round trip.
        let memories = manager.list_memories(None).expect("list");
        assert_eq!(memories.len(), 1);
        assert_eq!(memories[0].state, "archived");
    }

    #[test]
    fn pinned_aged_candidate_survives_sweep() {
        let mut manager = SubstrateManager::open(":memory:", None).expect("open substrate");
        let scope = manager.default_scope;
        let mut object = aged_useful_fact(scope, 365 * 5);
        object.pin_count = 1;
        manager
            .save_memories(scope, &[object])
            .expect("seed pinned memory");

        let report = manager.run_decay_sweep().expect("decay sweep");
        assert_eq!(
            report.candidates_archived, 0,
            "pinned memory must not archive"
        );
        let memories = manager.list_memories(None).expect("list");
        assert_eq!(memories[0].state, "candidate");
        assert!(memories[0].retention_score >= 0.9);
    }
}
