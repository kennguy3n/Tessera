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

use std::collections::{BTreeMap, HashMap, HashSet};
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
use crate::types::{
    DecaySweepSummary, EnrichedKnowledge, KnowledgeConcept, MemoryRecord, RelatedSourceSuggestion,
    SubstrateFileEntry, SynthesisSummary,
};

/// Manifest role tag for the evidence-store sibling in a backup bundle.
pub const SUBSTRATE_EVIDENCE_ROLE: &str = "substrate-evidence";
/// Manifest role tag for the concept-graph sibling in a backup bundle.
pub const SUBSTRATE_CONCEPTS_ROLE: &str = "substrate-concepts";
/// Stable in-bundle archive name (and live sibling file-name suffix) of
/// the evidence-store SQLCipher database.
pub const SUBSTRATE_EVIDENCE_ARCNAME: &str = "substrate-evidence.db";
/// Stable in-bundle archive name (and live sibling file-name suffix) of
/// the concept-graph SQLCipher database.
pub const SUBSTRATE_CONCEPTS_ARCNAME: &str = "substrate-concepts.db";

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

/// Label prefix for the per-source node in the concept graph. Entity
/// nodes are linked `PartOf` one of these so the graph records which
/// Tessera source a concept co-occurs in. The suffix is the Tessera
/// source id (a UUID string).
const SOURCE_NODE_PREFIX: &str = "source:";

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

    /// Produce consistent, encrypted snapshots of both substrate sibling
    /// databases into `dest_dir`, one [`SubstrateFileEntry`] per sibling.
    ///
    /// Each snapshot is written through the upstream `snapshot_to`
    /// (`VACUUM INTO`) primitive against the store's own live
    /// connection, so it is transactionally consistent — no torn pages,
    /// no half-applied write — even while the substrate stays open, and
    /// it re-opens under the *same* HKDF-derived master key (a backup
    /// copy, not a rekey). The destinations are standalone files with no
    /// `-wal` / `-journal` sidecars, so the caller can fold them into a
    /// backup bundle or copy them next to a hot-copy backup verbatim.
    ///
    /// `dest_dir` is created if absent; any stale file at a target name
    /// is removed first because `VACUUM INTO` refuses a present
    /// destination. The returned `path`s live inside `dest_dir`; the
    /// caller owns cleaning the directory up once the files are packed.
    ///
    /// Works for the in-memory test stores too (`VACUUM INTO` copies the
    /// in-memory database to a real on-disk file).
    ///
    /// # Errors
    ///
    /// Returns [`SubstrateError::Io`] if `dest_dir` cannot be created or
    /// a stale snapshot cannot be cleared, and propagates the underlying
    /// store error if a vacuum fails.
    pub fn snapshot_into(&self, dest_dir: &Path) -> Result<Vec<SubstrateFileEntry>> {
        std::fs::create_dir_all(dest_dir).map_err(|e| {
            SubstrateError::Io(format!("create snapshot dir {}: {e}", dest_dir.display()))
        })?;

        let evidence_dest = dest_dir.join(SUBSTRATE_EVIDENCE_ARCNAME);
        let concepts_dest = dest_dir.join(SUBSTRATE_CONCEPTS_ARCNAME);
        // VACUUM INTO refuses a present destination; clear any stale
        // snapshot left by a previously-aborted run at the same path.
        remove_stale_snapshot(&evidence_dest)?;
        remove_stale_snapshot(&concepts_dest)?;

        self.evidence.snapshot_to(&evidence_dest)?;
        self.concepts.snapshot_to(&concepts_dest)?;

        Ok(vec![
            SubstrateFileEntry {
                role: SUBSTRATE_EVIDENCE_ROLE.to_string(),
                arcname: SUBSTRATE_EVIDENCE_ARCNAME.to_string(),
                path: evidence_dest,
            },
            SubstrateFileEntry {
                role: SUBSTRATE_CONCEPTS_ROLE.to_string(),
                arcname: SUBSTRATE_CONCEPTS_ARCNAME.to_string(),
                path: concepts_dest,
            },
        ])
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

    /// List every memory object in the substrate.
    ///
    /// The substrate keeps a single, single-user **memory plane** in the
    /// default scope (see the module docs): observation extraction, pin,
    /// unpin, forget, decay, and synthesis all read and write that one
    /// plane. Listing therefore always returns the default scope's
    /// memories. The `_scope` parameter is retained for N-API signature
    /// stability and forward compatibility, but is intentionally not used
    /// to pick a different memory plane — doing so would let a caller list
    /// ids it could never pin/forget (those paths target the default
    /// scope), which is exactly the asymmetry this design avoids.
    ///
    /// # Errors
    ///
    /// Returns [`SubstrateError`] on store or (de)serialization failure.
    pub fn list_memories(&self, _scope: Option<&str>) -> Result<Vec<MemoryRecord>> {
        let memories = self.load_memories(self.default_scope)?;
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

    /// Forget a single memory: remove it from the single-user memory
    /// plane (the default scope) so its content is no longer recoverable.
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

    /// Purge every substrate artifact derived from a Tessera source when
    /// that source is removed, so a deleted source leaves no recoverable
    /// extracted content behind. Idempotent: a source with no substrate
    /// data is a clean no-op.
    ///
    /// In the single-user default scope this:
    /// 1. destroys the per-source raw observations blob
    ///    (`tessera.observations:<id>`). The evidence store exposes no
    ///    single-`kind` row delete, so the blob is overwritten with an
    ///    empty AEAD-sealed payload — `INSERT OR REPLACE` discards the
    ///    prior ciphertext, making the extracted observation text
    ///    unrecoverable; and
    /// 2. drops every `MemoryObject` in the aggregate memory plane whose
    ///    `source_id` metadata points at the removed source, so those
    ///    memories no longer surface in [`Self::list_memories`].
    ///
    /// The derived concept-graph nodes — a structural `source:<id>` node
    /// (whose label is just the source id the user already knows) and
    /// entity-label nodes that are *deduplicated and shared* across
    /// sources — are intentionally left in place: they carry no document
    /// content, an entity node may still be referenced by other present
    /// sources, and the upstream `PersistentConceptGraph` exposes no
    /// per-source persistent node deletion. They age out through the
    /// normal graph lifecycle. (Purging them safely would require
    /// per-source provenance + a persistent node-delete API upstream.)
    ///
    /// # Errors
    ///
    /// Returns [`SubstrateError`] on store or (de)serialization failure.
    pub fn remove_source(&mut self, source_id: &str) -> Result<()> {
        let scope = self.default_scope;

        // 1. Destroy the per-source raw observations blob, but only if
        //    one was ever written — avoids leaving a spurious empty row
        //    for a source that never produced observations.
        let obs_kind = observations_kind(source_id);
        if self.evidence.load_memory_blob(scope, &obs_kind)?.is_some() {
            let empty = serde_json::to_vec(&Vec::<Observation>::new())?;
            self.evidence.save_memory_blob(scope, &obs_kind, &empty)?;
        }

        // 2. Drop every memory carrying this source_id from the plane.
        let mut memories = self.load_memories(scope)?;
        let before = memories.len();
        memories.retain(|m| memory_source_id(m).as_deref() != Some(source_id));
        if memories.len() != before {
            self.save_memories(scope, &memories)?;
        }

        Ok(())
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

    /// Return a JSON-serialized [`concept_graph::GraphView`] of the
    /// single-user concept graph, bounded by `max_nodes` (the crate
    /// default applies when `None`).
    ///
    /// Like the memory plane, the concept graph is single-scope:
    /// `build_concept_graph` only ever writes nodes under the default
    /// scope, so this view always reads the default scope. The `_scope`
    /// parameter is retained for N-API signature stability and forward
    /// compatibility but is intentionally not used — resolving a
    /// non-default scope here would always return an empty graph (nothing
    /// is ever written to another scope), which would mislead callers
    /// into expecting scoped data that does not exist. This keeps the
    /// concept graph consistent with `list_memories` / `trigger_synthesis`.
    ///
    /// # Errors
    ///
    /// Returns [`SubstrateError`] on store or serialization failure.
    pub fn concept_graph_json(
        &mut self,
        _scope: Option<&str>,
        max_nodes: Option<usize>,
    ) -> Result<String> {
        let scope = self.default_scope;
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
    pub fn trigger_synthesis(&mut self, _scope: Option<&str>) -> Result<SynthesisSummary> {
        // Synthesis summarizes the single-user memory plane, so it always
        // operates on the default scope (matching extract/list/pin/forget).
        // `_scope` is retained for N-API signature stability.
        let scope = self.default_scope;
        let memories = self.load_memories(scope)?;

        let mut decisions = Vec::new();
        let mut open_questions = Vec::new();
        let mut active_tasks = Vec::new();
        let mut entities = Vec::new();
        // Count only memories that are still part of the working set; the
        // recap headline must not include archived/deleted memories or it
        // reports a working set far larger than the actionable content.
        let mut active_count = 0usize;
        for memory in &memories {
            if memory.state == MemoryState::Archived || memory.state == MemoryState::Deleted {
                continue;
            }
            active_count += 1;
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

        let recap = build_recap(active_count, &entities, &decisions, &active_tasks);
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

    /// Observation-enriched search over the single-user memory plane
    /// and concept graph.
    ///
    /// This is the knowledge-plane companion to Tessera's existing
    /// chunk-level hybrid search (BM25 + vector + recency, in
    /// `tessera_sources`). It does **not** rank or return chunks — the
    /// bridge layer composes the two. Here we match the substrate's
    /// extracted observations and concepts against `query`:
    ///
    /// * `memories` — every non-deleted memory whose surface text
    ///   matches the query, ranked by lexical relevance, then by live
    ///   retention score (so active memories rank above fading ones).
    /// * `entities` / `facts` — the `entity` and `fact`/`claim`/
    ///   `decision` projections of `memories`, pre-split for the UI.
    /// * `concepts` — concept-graph nodes whose label matches the
    ///   query, each carrying the Tessera sources it co-occurs in.
    ///
    /// Each list is capped at `limit`. A blank query returns empty
    /// lists rather than the whole corpus.
    ///
    /// # Errors
    ///
    /// Returns [`SubstrateError`] on store or (de)serialization failure.
    pub fn search_knowledge(&mut self, query: &str, limit: usize) -> Result<EnrichedKnowledge> {
        let tokens = query_tokens(query);
        if tokens.is_empty() || limit == 0 {
            return Ok(EnrichedKnowledge {
                entities: Vec::new(),
                facts: Vec::new(),
                concepts: Vec::new(),
                memories: Vec::new(),
            });
        }

        let scope = self.default_scope;
        let memories = self.load_memories(scope)?;
        let now = Utc::now();

        // Score every live memory by lexical relevance; keep only
        // matches. The retention score is recomputed at `now` (not the
        // stored value) so ranking reflects current decay even between
        // sweeps.
        let mut scored: Vec<(f64, f64, MemoryRecord)> = Vec::new();
        for memory in &memories {
            if memory.state == MemoryState::Deleted {
                continue;
            }
            let content = memory_content(memory).unwrap_or_default();
            let relevance = text_relevance(&content.to_lowercase(), &tokens);
            if relevance <= 0.0 {
                continue;
            }
            let retention = compute_retention_score(memory, now).total;
            scored.push((relevance, retention, memory_to_record(memory)));
        }
        // Relevance desc, then retention desc, then id asc for a stable
        // order when both signals tie.
        scored.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal))
                .then_with(|| a.2.id.cmp(&b.2.id))
        });
        let ranked: Vec<MemoryRecord> = scored.into_iter().map(|(_, _, record)| record).collect();

        let entities: Vec<MemoryRecord> = ranked
            .iter()
            .filter(|r| r.observation_type == "entity")
            .take(limit)
            .cloned()
            .collect();
        let facts: Vec<MemoryRecord> = ranked
            .iter()
            .filter(|r| matches!(r.observation_type.as_str(), "fact" | "claim" | "decision"))
            .take(limit)
            .cloned()
            .collect();
        let memories_out: Vec<MemoryRecord> = ranked.into_iter().take(limit).collect();

        let concepts = self.search_concepts(&tokens, limit)?;

        Ok(EnrichedKnowledge {
            entities,
            facts,
            concepts,
            memories: memories_out,
        })
    }

    /// Maximum retention score per Tessera source, keyed by source id.
    ///
    /// Tessera's hybrid search ranks chunks; the substrate tracks
    /// retention per *memory*. This bridges the two planes: for each
    /// source that has at least one memory, we take the strongest
    /// (max) live retention score across its memories. The bridge feeds
    /// this map into the hybrid RRF fusion as a fourth signal so chunks
    /// from sources with active memories rank above fading above
    /// archived.
    ///
    /// Scores are recomputed at `now` rather than read from the stored
    /// field so ranking reflects current decay even between sweeps.
    /// Sources with no memories are simply absent (the fusion treats a
    /// missing entry as "no retention signal", preserving the existing
    /// BM25 + vector + recency ranking for un-extracted sources).
    ///
    /// # Errors
    ///
    /// Returns [`SubstrateError`] on store or (de)serialization failure.
    pub fn retention_by_source(&self) -> Result<HashMap<String, f64>> {
        let memories = self.load_memories(self.default_scope)?;
        let now = Utc::now();
        let mut out: HashMap<String, f64> = HashMap::new();
        for memory in &memories {
            if memory.state == MemoryState::Deleted {
                continue;
            }
            let Some(source_id) = memory_source_id(memory) else {
                continue;
            };
            let score = compute_retention_score(memory, now).total;
            out.entry(source_id)
                .and_modify(|existing| {
                    if score > *existing {
                        *existing = score;
                    }
                })
                .or_insert(score);
        }
        Ok(out)
    }

    /// Suggest sources related to an already-selected working set, via
    /// the concept graph.
    ///
    /// Powers the "You have N sources about [entity]. Include them?"
    /// affordance on the artifact-creation flow. For every concept the
    /// selected sources are linked to (`entity --PartOf--> source`), we
    /// gather the *other* sources that share the concept and surface
    /// them as a suggestion ranked by how many related sources it
    /// pulls in.
    ///
    /// `selected_source_ids` that are not valid / not in the graph are
    /// ignored. Suggestions never include an already-selected source.
    /// Returns at most `max_suggestions` entries.
    ///
    /// # Errors
    ///
    /// Returns [`SubstrateError`] on store failure.
    pub fn suggest_related_sources(
        &mut self,
        selected_source_ids: &[String],
        max_suggestions: usize,
    ) -> Result<Vec<RelatedSourceSuggestion>> {
        if selected_source_ids.is_empty() || max_suggestions == 0 {
            return Ok(Vec::new());
        }
        let scope = self.default_scope;
        self.concepts.load_scope(scope)?;
        let graph = self.concepts.graph();

        let selected: HashSet<&str> = selected_source_ids.iter().map(String::as_str).collect();

        // Resolve the selected source ids to their per-source nodes.
        let selected_nodes: HashSet<concept_graph::NodeId> = graph
            .iter_nodes()
            .filter(|n| n.scope_id == scope)
            .filter(|n| {
                source_id_from_label(&n.label).is_some_and(|sid| selected.contains(sid.as_str()))
            })
            .map(|n| n.id)
            .collect();
        if selected_nodes.is_empty() {
            return Ok(Vec::new());
        }

        // Entities of the selected sources: incoming `PartOf` edges
        // (`entity --PartOf--> source`).
        let mut entity_nodes: HashSet<concept_graph::NodeId> = HashSet::new();
        for edge in graph.iter_edges() {
            if edge.relation == RelationType::PartOf && selected_nodes.contains(&edge.to) {
                entity_nodes.insert(edge.from);
            }
        }

        // For each shared entity, collect the related (non-selected)
        // sources. `BTreeMap` keeps suggestions deterministic before
        // the score sort.
        let mut by_entity: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for entity_node in entity_nodes {
            let Some(node) = graph.get_node(entity_node) else {
                continue;
            };
            let mut related: Vec<String> = graph
                .neighbors(entity_node, Some(RelationType::PartOf))
                .into_iter()
                .filter_map(|nid| graph.get_node(nid))
                .filter_map(|n| source_id_from_label(&n.label))
                .filter(|sid| !selected.contains(sid.as_str()))
                .collect();
            related.sort();
            related.dedup();
            if !related.is_empty() {
                by_entity.insert(node.label.clone(), related);
            }
        }

        let mut suggestions: Vec<RelatedSourceSuggestion> = by_entity
            .into_iter()
            .map(|(entity, source_ids)| RelatedSourceSuggestion {
                score: u32::try_from(source_ids.len()).unwrap_or(u32::MAX),
                entity,
                source_ids,
            })
            .collect();
        // Most related sources first; ties broken by entity label for a
        // stable, reproducible ordering.
        suggestions.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.entity.cmp(&b.entity)));
        suggestions.truncate(max_suggestions);
        Ok(suggestions)
    }

    /// Match concept-graph nodes against the query tokens, resolving
    /// each match's related Tessera sources. Used by
    /// [`Self::search_knowledge`].
    fn search_concepts(
        &mut self,
        tokens: &[String],
        limit: usize,
    ) -> Result<Vec<KnowledgeConcept>> {
        let scope = self.default_scope;
        self.concepts.load_scope(scope)?;
        let graph = self.concepts.graph();

        let mut scored: Vec<(f64, usize, KnowledgeConcept)> = Vec::new();
        for node in graph.iter_nodes() {
            if node.scope_id != scope {
                continue;
            }
            // Per-source nodes are graph plumbing, not concepts.
            if source_id_from_label(&node.label).is_some() {
                continue;
            }
            let relevance = text_relevance(&node.label.to_lowercase(), tokens);
            if relevance <= 0.0 {
                continue;
            }
            let related_source_ids: Vec<String> = graph
                .neighbors(node.id, Some(RelationType::PartOf))
                .into_iter()
                .filter_map(|nid| graph.get_node(nid))
                .filter_map(|n| source_id_from_label(&n.label))
                .collect();
            scored.push((
                relevance,
                related_source_ids.len(),
                KnowledgeConcept {
                    id: node.id.to_string(),
                    label: node.label.clone(),
                    definition: node.definition.clone(),
                    state: node.state.as_str().to_string(),
                    related_source_ids,
                },
            ));
        }
        // Relevance desc, then number of related sources desc, then
        // label asc for a stable order.
        scored.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.1.cmp(&a.1))
                .then_with(|| a.2.label.cmp(&b.2.label))
        });
        Ok(scored
            .into_iter()
            .take(limit)
            .map(|(_, _, concept)| concept)
            .collect())
    }

    // ───────────────────────────── internals ─────────────────────────

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

        let source_label = source_node_label(source_id);
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
///
/// Indexing is done over the raw bytes (not the `&str`) so a malformed
/// key containing multi-byte UTF-8 codepoints can never panic on a
/// character-boundary slice — any non-ASCII-hex input is reported as
/// [`SubstrateError::InvalidKeyHex`].
fn decode_db_key(hex: &str) -> Result<MasterKey> {
    let bytes = hex.as_bytes();
    if bytes.len() != MASTER_KEY_LEN * 2 {
        return Err(SubstrateError::InvalidKeyLength(hex.len()));
    }
    let mut out = [0u8; MASTER_KEY_LEN];
    for (i, byte) in out.iter_mut().enumerate() {
        if let (Some(hi), Some(lo)) = (hex_nibble(bytes[i * 2]), hex_nibble(bytes[i * 2 + 1])) {
            *byte = (hi << 4) | lo;
        } else {
            let pair = String::from_utf8_lossy(&bytes[i * 2..i * 2 + 2]).into_owned();
            return Err(SubstrateError::InvalidKeyHex(pair));
        }
    }
    Ok(out)
}

/// Map a single ASCII hex digit to its 0–15 value, or `None` if the byte
/// is not an ASCII hex digit.
fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Compute the substrate sibling DB paths for a Tessera `db_path`.
/// `:memory:` maps to independent in-memory stores.
fn substrate_paths(db_path: &str) -> (PathBuf, PathBuf) {
    if db_path == ":memory:" {
        return (PathBuf::from(":memory:"), PathBuf::from(":memory:"));
    }
    let base = Path::new(db_path);
    let evidence = sibling(base, SUBSTRATE_EVIDENCE_ARCNAME);
    let concepts = sibling(base, SUBSTRATE_CONCEPTS_ARCNAME);
    (evidence, concepts)
}

/// The live substrate sibling databases for a Tessera main `db_path`,
/// paired with the stable bundle `role` / `arcname` they back up under.
///
/// Used by the backup/restore layer (where no [`SubstrateManager`] need
/// be open) to learn *where on disk* each bundle entry must be restored:
/// the returned `path` is the live sibling next to the main DB, and the
/// `arcname` matches the entry [`SubstrateManager::snapshot_into`]
/// produced on export. Returns an empty vector for the in-memory test
/// path (`":memory:"`), which has no on-disk siblings.
pub fn substrate_sibling_entries(db_path: &str) -> Vec<SubstrateFileEntry> {
    if db_path == ":memory:" {
        return Vec::new();
    }
    let (evidence, concepts) = substrate_paths(db_path);
    vec![
        SubstrateFileEntry {
            role: SUBSTRATE_EVIDENCE_ROLE.to_string(),
            arcname: SUBSTRATE_EVIDENCE_ARCNAME.to_string(),
            path: evidence,
        },
        SubstrateFileEntry {
            role: SUBSTRATE_CONCEPTS_ROLE.to_string(),
            arcname: SUBSTRATE_CONCEPTS_ARCNAME.to_string(),
            path: concepts,
        },
    ]
}

/// Remove a stale snapshot file at `path` if present, so a fresh
/// `VACUUM INTO` (which refuses a present destination) can write there.
fn remove_stale_snapshot(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(SubstrateError::Io(format!(
            "clear stale snapshot {}: {e}",
            path.display()
        ))),
    }
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

/// Build the concept-graph label for a Tessera source node.
fn source_node_label(source_id: &str) -> String {
    format!("{SOURCE_NODE_PREFIX}{source_id}")
}

/// Recover the Tessera source id from a per-source node label, or
/// `None` if `label` is not a source node (e.g. an entity node).
fn source_id_from_label(label: &str) -> Option<String> {
    label
        .strip_prefix(SOURCE_NODE_PREFIX)
        .map(ToString::to_string)
}

/// Tokenize a free-text query into lowercase alphanumeric terms of at
/// least two characters, de-duplicated while preserving order. Used by
/// the substrate's lexical matching for [`SubstrateManager::search_knowledge`].
fn query_tokens(query: &str) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut tokens = Vec::new();
    for raw in query.split(|c: char| !c.is_alphanumeric()) {
        if raw.len() < 2 {
            continue;
        }
        let token = raw.to_lowercase();
        if seen.insert(token.clone()) {
            tokens.push(token);
        }
    }
    tokens
}

/// Lexical relevance of `text` against pre-tokenized query `tokens`, in
/// `0.0 ..= 2.0`.
///
/// The base score is the fraction of query tokens that appear as a
/// substring of the (already lowercased) `text`. A whole-token
/// word-boundary match adds a small bonus so "tessera" ranks an exact
/// word above a hit buried inside "tesserae". Returns `0.0` when no
/// token matches, which the callers use to drop non-matching items.
fn text_relevance(text_lower: &str, tokens: &[String]) -> f64 {
    if tokens.is_empty() {
        return 0.0;
    }
    let mut matched = 0usize;
    let mut word_bonus = 0.0;
    for token in tokens {
        if text_lower.contains(token.as_str()) {
            matched += 1;
            if text_lower
                .split(|c: char| !c.is_alphanumeric())
                .any(|w| w == token)
            {
                word_bonus += 1.0;
            }
        }
    }
    if matched == 0 {
        return 0.0;
    }
    let coverage = matched as f64 / tokens.len() as f64;
    let boundary = word_bonus / tokens.len() as f64;
    coverage + boundary
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

    #[test]
    fn recap_counts_only_active_memories_after_archival() {
        let mut manager = SubstrateManager::open(":memory:", None).expect("open substrate");
        let scope = manager.default_scope;

        // Two fresh, active facts plus three long-aged candidates that the
        // sweep will archive.
        let mut seed = vec![aged_useful_fact(scope, 0), aged_useful_fact(scope, 0)];
        seed.extend((0..3).map(|_| aged_useful_fact(scope, 365 * 5)));
        manager.save_memories(scope, &seed).expect("seed memories");

        let report = manager.run_decay_sweep().expect("decay sweep");
        assert_eq!(
            report.candidates_archived, 3,
            "the three aged facts archive"
        );

        let summary = manager.trigger_synthesis(None).expect("synthesis");
        // The headline must reflect the 2 active memories, not all 5.
        assert!(
            summary.recap.contains("2 memories"),
            "recap should count only active memories, got: {}",
            summary.recap
        );
        assert!(
            !summary.recap.contains("5 memories"),
            "recap must not count archived memories, got: {}",
            summary.recap
        );
    }

    #[test]
    fn recap_reports_empty_when_all_memories_archived() {
        let mut manager = SubstrateManager::open(":memory:", None).expect("open substrate");
        let scope = manager.default_scope;
        let seed: Vec<MemoryObject> = (0..4).map(|_| aged_useful_fact(scope, 365 * 5)).collect();
        manager.save_memories(scope, &seed).expect("seed memories");

        manager.run_decay_sweep().expect("decay sweep");

        let summary = manager.trigger_synthesis(None).expect("synthesis");
        assert_eq!(
            summary.recap, "No memories have been captured yet.",
            "an all-archived working set must not look populated"
        );
    }

    const SOURCE_A: &str = "11111111-1111-4111-8111-111111111111";
    const SOURCE_B: &str = "22222222-2222-4222-8222-222222222222";

    /// Seed two sources whose chunk text shares the capitalised entity
    /// "Acme" (extracted by the lexicon observation pipeline) so the
    /// resulting memory plane + concept graph can be queried end to end.
    fn seed_two_sources_sharing_acme() -> SubstrateManager {
        let mut manager = SubstrateManager::open(":memory:", None).expect("open substrate");
        manager
            .extract_observations(SOURCE_A, &["Acme shipped the contract.".to_string()])
            .expect("extract A");
        manager
            .extract_observations(SOURCE_B, &["Acme renewed with Globex.".to_string()])
            .expect("extract B");
        manager
    }

    #[test]
    fn search_knowledge_returns_matching_entities_and_concepts() {
        let mut manager = seed_two_sources_sharing_acme();

        let knowledge = manager.search_knowledge("Acme", 10).expect("search");
        // The shared entity surfaces as an observation-typed memory.
        assert!(
            knowledge.entities.iter().any(|e| e.content == "Acme"),
            "expected an 'Acme' entity, got {:?}",
            knowledge
                .entities
                .iter()
                .map(|e| &e.content)
                .collect::<Vec<_>>()
        );
        // The concept graph resolves "Acme" to BOTH sources it
        // co-occurs in.
        let acme = knowledge
            .concepts
            .iter()
            .find(|c| c.label == "Acme")
            .expect("Acme concept present");
        assert!(acme.related_source_ids.contains(&SOURCE_A.to_string()));
        assert!(acme.related_source_ids.contains(&SOURCE_B.to_string()));
    }

    #[test]
    fn search_knowledge_empty_query_is_a_noop() {
        let mut manager = seed_two_sources_sharing_acme();
        let knowledge = manager.search_knowledge("   ", 10).expect("search");
        assert!(knowledge.entities.is_empty());
        assert!(knowledge.facts.is_empty());
        assert!(knowledge.concepts.is_empty());
        assert!(knowledge.memories.is_empty());
        // A zero limit is likewise a no-op even for a matching query.
        let none = manager.search_knowledge("Acme", 0).expect("search");
        assert!(none.memories.is_empty());
    }

    #[test]
    fn retention_by_source_reports_live_scores_per_source() {
        let manager = seed_two_sources_sharing_acme();
        let map = manager.retention_by_source().expect("retention map");
        // Both freshly-extracted sources have at least one live memory,
        // so both appear with a positive retention score.
        let a = map.get(SOURCE_A).copied().expect("source A scored");
        let b = map.get(SOURCE_B).copied().expect("source B scored");
        assert!(a > 0.0, "fresh source A should have positive retention");
        assert!(b > 0.0, "fresh source B should have positive retention");
    }

    #[test]
    fn suggest_related_sources_surfaces_co_occurring_source() {
        let mut manager = seed_two_sources_sharing_acme();
        let suggestions = manager
            .suggest_related_sources(&[SOURCE_A.to_string()], 5)
            .expect("suggest");
        // "Acme" links A to B → exactly one suggestion pointing at B.
        let acme = suggestions
            .iter()
            .find(|s| s.entity == "Acme")
            .expect("Acme suggestion present");
        assert_eq!(acme.source_ids, vec![SOURCE_B.to_string()]);
        assert!(
            !acme.source_ids.contains(&SOURCE_A.to_string()),
            "an already-selected source must never be suggested back"
        );
    }

    #[test]
    fn suggest_related_sources_empty_selection_is_a_noop() {
        let mut manager = seed_two_sources_sharing_acme();
        assert!(manager
            .suggest_related_sources(&[], 5)
            .expect("suggest")
            .is_empty());
        // A zero cap likewise yields nothing.
        assert!(manager
            .suggest_related_sources(&[SOURCE_A.to_string()], 0)
            .expect("suggest")
            .is_empty());
    }
}
