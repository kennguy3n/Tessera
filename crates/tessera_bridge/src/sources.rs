use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tessera_core::SourceId;
use tessera_sources::hybrid::{HybridSearchConfig, HybridSearchConfigInput};
use tessera_sources::manager::SourceManager;
use tessera_sources::progress::EmbeddingStatus;
use tessera_sources::search::SearchResult;
use tessera_sources::source::Source;

use crate::{BridgeError, BridgeResult};

/// Default batch size for embedding backfill. Picked large enough
/// that a 10k-chunk corpus completes in a small number of iterations
/// of the inner SQL query, but small enough that a transient
/// embedder failure (network blip on a hosted embedder) only loses
/// progress on at most one batch's worth of work.
const DEFAULT_EMBEDDING_BACKFILL_BATCH_SIZE: usize = 64;

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct SourceInfo {
    pub id: String,
    pub source_type: String,
    pub path: String,
    pub status: String,
    pub created_at: String,
    pub last_indexed: Option<String>,
    pub file_count: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct SearchHitInfo {
    pub content: String,
    pub excerpt: String,
    pub source_path: String,
    pub source_id: String,
    pub chunk_hash: String,
    pub chunk_index: i32,
    pub relevance: f64,
}

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct IndexedFileInfo {
    pub path: String,
    pub hash: String,
    pub last_modified: String,
    pub chunk_count: i32,
}

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct SourceDetailInfo {
    pub source: SourceInfo,
    pub files: Vec<IndexedFileInfo>,
}

impl From<&Source> for SourceInfo {
    fn from(s: &Source) -> Self {
        Self {
            id: s.id.to_string(),
            source_type: s.source_type.to_string(),
            path: s.path.clone(),
            status: s.status.to_string(),
            created_at: s.created_at.to_rfc3339(),
            last_indexed: s.last_indexed.map(|t| t.to_rfc3339()),
            file_count: s.file_count as i64,
        }
    }
}

impl From<&SearchResult> for SearchHitInfo {
    fn from(r: &SearchResult) -> Self {
        Self {
            content: r.content.clone(),
            excerpt: r.excerpt.clone(),
            source_path: r.source_path.clone(),
            source_id: r.source_id.clone(),
            chunk_hash: r.hash.clone(),
            chunk_index: r.chunk_index as i32,
            relevance: r.relevance,
        }
    }
}

pub fn add_local_folder(manager: &SourceManager, path: &str) -> BridgeResult<SourceInfo> {
    let source = manager.add_local_folder(path).map_err(BridgeError::Core)?;
    Ok(SourceInfo::from(&source))
}

pub fn add_local_file(manager: &SourceManager, path: &str) -> BridgeResult<SourceInfo> {
    let source = manager.add_local_file(path).map_err(BridgeError::Core)?;
    Ok(SourceInfo::from(&source))
}

pub fn list_sources(manager: &SourceManager) -> BridgeResult<Vec<SourceInfo>> {
    let sources = manager.list_sources().map_err(BridgeError::Core)?;
    Ok(sources.iter().map(SourceInfo::from).collect())
}

pub fn remove_source(manager: &SourceManager, source_id: &str) -> BridgeResult<()> {
    let uuid =
        uuid::Uuid::parse_str(source_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    manager
        .remove_source(&SourceId(uuid))
        .map_err(BridgeError::Core)
}

pub fn search_sources(
    manager: &SourceManager,
    query: &str,
    limit: usize,
) -> BridgeResult<Vec<SearchHitInfo>> {
    let results = manager.search(query, limit).map_err(BridgeError::Core)?;
    Ok(results.iter().map(SearchHitInfo::from).collect())
}

pub fn get_source_detail(
    manager: &SourceManager,
    source_id: &str,
) -> BridgeResult<SourceDetailInfo> {
    let uuid =
        uuid::Uuid::parse_str(source_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let source = manager
        .get_source(&SourceId(uuid))
        .map_err(BridgeError::Core)?;
    let files = manager
        .list_indexed_files(&SourceId(uuid))
        .map_err(BridgeError::Core)?;
    let file_infos: Vec<IndexedFileInfo> = files
        .iter()
        .map(|f| IndexedFileInfo {
            path: f.path.clone(),
            hash: f.hash.clone(),
            last_modified: f.last_modified.clone(),
            chunk_count: f.chunk_count as i32,
        })
        .collect();
    Ok(SourceDetailInfo {
        source: SourceInfo::from(&source),
        files: file_infos,
    })
}

pub fn reindex_source(manager: &SourceManager, source_id: &str) -> BridgeResult<SourceInfo> {
    let uuid =
        uuid::Uuid::parse_str(source_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    manager
        .reindex_source(&SourceId(uuid))
        .map_err(BridgeError::Core)?;
    let source = manager
        .get_source(&SourceId(uuid))
        .map_err(BridgeError::Core)?;
    Ok(SourceInfo::from(&source))
}

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct IndexingProgressInfo {
    pub status: String,
    pub scanned: u32,
    pub indexed: u32,
    pub unchanged: u32,
    pub skipped: u32,
    pub errors: u32,
    pub total_files: u32,
    pub current_path: Option<String>,
    pub last_error: Option<String>,
}

pub fn get_indexing_progress(
    manager: &SourceManager,
    source_id: &str,
) -> BridgeResult<IndexingProgressInfo> {
    let uuid =
        uuid::Uuid::parse_str(source_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let snap = manager.indexing_progress(&SourceId(uuid));
    Ok(IndexingProgressInfo {
        status: match snap.status {
            tessera_sources::progress::IndexStatus::Idle => "idle".to_string(),
            tessera_sources::progress::IndexStatus::Running => "running".to_string(),
            tessera_sources::progress::IndexStatus::Done => "done".to_string(),
            tessera_sources::progress::IndexStatus::Failed => "failed".to_string(),
        },
        scanned: u32::try_from(snap.scanned).unwrap_or(u32::MAX),
        indexed: u32::try_from(snap.indexed).unwrap_or(u32::MAX),
        unchanged: u32::try_from(snap.unchanged).unwrap_or(u32::MAX),
        skipped: u32::try_from(snap.skipped).unwrap_or(u32::MAX),
        errors: u32::try_from(snap.errors).unwrap_or(u32::MAX),
        total_files: u32::try_from(snap.total_files).unwrap_or(u32::MAX),
        current_path: snap.current_path,
        last_error: snap.last_error,
    })
}

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct EmbeddingProgressInfo {
    pub status: String,
    pub total_chunks: u32,
    pub embedded: u32,
    pub failed: u32,
    pub model_id: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct BackfillEmbeddingsResult {
    /// Number of chunks newly embedded by this call. If the index
    /// already has up-to-date embeddings for the active model, this
    /// is 0 and `progress.status` flips Idle → Done immediately.
    pub embedded: u32,
    pub progress: EmbeddingProgressInfo,
}

/// Wire shape for [`HybridSearchConfig`] crossing the napi boundary.
/// We deliberately don't derive this directly from `HybridSearchConfig`
/// because `recency_halflife_secs` uses a custom JSON-null
/// representation for the `f64::INFINITY` "no decay" sentinel — at
/// the napi boundary we instead surface that as an explicit
/// `recency_decay_enabled: false` flag so the TS renderer can render
/// the toggle without learning about `INFINITY`.
#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct HybridSearchConfigInfo {
    pub bm25_weight: f64,
    pub vector_weight: f64,
    pub rrf_k: f64,
    /// `true` when the active config applies temporal recency decay,
    /// `false` when decay is disabled (internally
    /// `recency_halflife_secs == f64::INFINITY`).
    pub recency_decay_enabled: bool,
    /// Half-life in seconds when `recency_decay_enabled == true`.
    /// `None` when decay is disabled — the value is unobservable in
    /// that mode so the renderer should keep its last-known value
    /// rather than reset the slider to a placeholder.
    pub recency_halflife_secs: Option<f64>,
    pub candidate_pool_size: u32,
}

impl From<&HybridSearchConfig> for HybridSearchConfigInfo {
    fn from(c: &HybridSearchConfig) -> Self {
        let decay_enabled = c.recency_halflife_secs.is_finite();
        Self {
            bm25_weight: c.bm25_weight,
            vector_weight: c.vector_weight,
            rrf_k: c.rrf_k,
            recency_decay_enabled: decay_enabled,
            recency_halflife_secs: decay_enabled.then_some(c.recency_halflife_secs),
            candidate_pool_size: u32::try_from(c.candidate_pool_size).unwrap_or(u32::MAX),
        }
    }
}

/// Wire shape for partial-update patches from the renderer.
///
/// Mirrors [`HybridSearchConfigInput`] but expresses "disable decay"
/// as an explicit `recency_decay_enabled: Some(false)` toggle rather
/// than asking the renderer to pass `f64::INFINITY` (which it can't
/// represent in JSON). The translation back into the Rust input
/// shape lives in [`update_hybrid_search_config`].
#[derive(Debug, Default, Serialize, Deserialize)]
#[napi(object)]
pub struct HybridSearchConfigUpdate {
    pub bm25_weight: Option<f64>,
    pub vector_weight: Option<f64>,
    pub rrf_k: Option<f64>,
    /// `Some(true)` → enable decay (use the accompanying
    /// `recency_halflife_secs` if provided, else keep current);
    /// `Some(false)` → disable decay (sets internal halflife to
    /// `f64::INFINITY`); `None` → don't touch the flag.
    pub recency_decay_enabled: Option<bool>,
    pub recency_halflife_secs: Option<f64>,
    pub candidate_pool_size: Option<u32>,
}

fn embedding_status_str(status: EmbeddingStatus) -> String {
    match status {
        EmbeddingStatus::Idle => "idle".to_string(),
        EmbeddingStatus::Running => "running".to_string(),
        EmbeddingStatus::Done => "done".to_string(),
        EmbeddingStatus::Failed => "failed".to_string(),
    }
}

fn snapshot_to_info(
    snap: tessera_sources::progress::EmbeddingProgressSnapshot,
) -> EmbeddingProgressInfo {
    EmbeddingProgressInfo {
        status: embedding_status_str(snap.status),
        total_chunks: u32::try_from(snap.total_chunks).unwrap_or(u32::MAX),
        embedded: u32::try_from(snap.embedded).unwrap_or(u32::MAX),
        failed: u32::try_from(snap.failed).unwrap_or(u32::MAX),
        model_id: snap.model_id,
        last_error: snap.last_error,
    }
}

/// Trigger an embedding backfill pass over chunks that don't yet
/// have an embedding for the active model. Returns the number of
/// newly-embedded chunks plus a snapshot of the progress tracker so
/// the caller can render the final state without a follow-up poll.
///
/// Idempotent: a second call with an up-to-date index does no work
/// and reports `embedded=0, status=Done`.
pub fn backfill_embeddings(
    manager: &SourceManager,
    batch_size: Option<u32>,
) -> BridgeResult<BackfillEmbeddingsResult> {
    let batch = batch_size
        .map(|n| usize::try_from(n).unwrap_or(DEFAULT_EMBEDDING_BACKFILL_BATCH_SIZE))
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_EMBEDDING_BACKFILL_BATCH_SIZE);
    let embedded = manager
        .backfill_embeddings_tracked(batch)
        .map_err(BridgeError::Core)?;
    Ok(BackfillEmbeddingsResult {
        embedded: u32::try_from(embedded).unwrap_or(u32::MAX),
        progress: snapshot_to_info(manager.embedding_progress()),
    })
}

/// Lightweight poll for the renderer. The progress tracker stays
/// alive past the end of a backfill pass — `status=Done` plus the
/// final counters are what the renderer uses to dismiss the progress
/// banner.
pub fn get_embedding_progress(manager: &SourceManager) -> BridgeResult<EmbeddingProgressInfo> {
    Ok(snapshot_to_info(manager.embedding_progress()))
}

/// Hand the renderer the current effective hybrid retrieval config
/// (e.g. for populating the Settings page on first render).
pub fn get_hybrid_search_config(manager: &SourceManager) -> BridgeResult<HybridSearchConfigInfo> {
    Ok(HybridSearchConfigInfo::from(&manager.get_hybrid_config()))
}

/// Apply a partial-update patch from the renderer. Validation lives
/// in the core crate (see [`HybridSearchConfig::apply_patch`]); this
/// function just translates the wire shape into the input shape and
/// surfaces validation errors as `BridgeError::InvalidArgs` so the
/// IPC layer can echo them to the renderer's form-field state.
pub fn update_hybrid_search_config(
    manager: &SourceManager,
    update: HybridSearchConfigUpdate,
) -> BridgeResult<HybridSearchConfigInfo> {
    // Translate the renderer-friendly toggle into the `f64::INFINITY`
    // sentinel that the core crate uses. Three cases matter:
    //   1. `Some(false)`  → force disable, halflife → INFINITY
    //      (any accompanying numeric halflife is dropped: the toggle
    //       wins so we never end up with a "decay-on" effective
    //       config when the user clicked "off").
    //   2. `Some(true)`   → enable decay. If the user gave a finite
    //      halflife, use it. Otherwise, leave the existing halflife
    //      alone — unless the existing value is INFINITY (decay was
    //      previously disabled), in which case fall back to the
    //      documented 30-day default so the renderer never has to
    //      pre-load a halflife when re-enabling.
    //   3. `None`         → don't touch the flag. Pass whatever
    //      halflife the renderer sent (could be `None`).
    let mut effective_halflife = update.recency_halflife_secs;
    if matches!(update.recency_decay_enabled, Some(false)) {
        effective_halflife = Some(f64::INFINITY);
    } else if matches!(update.recency_decay_enabled, Some(true))
        && update.recency_halflife_secs.is_none()
        && !manager.get_hybrid_config().recency_halflife_secs.is_finite()
    {
        effective_halflife = Some(tessera_sources::hybrid::DEFAULT_RECENCY_HALFLIFE_SECS);
    }

    let patch = HybridSearchConfigInput {
        bm25_weight: update.bm25_weight,
        vector_weight: update.vector_weight,
        rrf_k: update.rrf_k,
        recency_halflife_secs: effective_halflife,
        candidate_pool_size: update.candidate_pool_size.map(|n| n as usize),
    };
    let new_cfg = manager.update_hybrid_config(&patch).map_err(|e| match e {
        // Validation errors live in `Error::InvalidConfig`; surface
        // them as `InvalidArgs` so the IPC handler can render them
        // as a 400-equivalent rather than a 500-equivalent.
        tessera_core::error::Error::InvalidConfig(msg) => BridgeError::InvalidArgs(msg),
        other => BridgeError::Core(other),
    })?;
    Ok(HybridSearchConfigInfo::from(&new_cfg))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_add_folder_and_search() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("notes.txt"),
            "Important meeting notes about the project roadmap",
        )
        .unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let info = add_local_folder(&manager, dir.path().to_str().unwrap()).unwrap();
        assert_eq!(info.file_count, 1);

        let sources = list_sources(&manager).unwrap();
        assert_eq!(sources.len(), 1);

        let results = search_sources(&manager, "meeting notes", 10).unwrap();
        assert!(!results.is_empty());
    }

    #[test]
    fn bridge_remove_source() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("test.txt"), "content").unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let info = add_local_folder(&manager, dir.path().to_str().unwrap()).unwrap();

        remove_source(&manager, &info.id).unwrap();
        let sources = list_sources(&manager).unwrap();
        assert!(sources.is_empty());
    }

    #[test]
    fn bridge_reindex_source() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("test.txt"), "initial content").unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let info = add_local_folder(&manager, dir.path().to_str().unwrap()).unwrap();

        std::fs::write(dir.path().join("new.txt"), "new content").unwrap();
        let updated = reindex_source(&manager, &info.id).unwrap();
        assert!(updated.file_count >= 1);
    }

    #[test]
    fn bridge_backfill_embeddings_is_idempotent_with_default_embedder() {
        // The default in-memory manager attaches a HashTrick embedder,
        // so a fresh add_local_folder already populates embeddings.
        // The first call to bridge_backfill_embeddings is therefore a
        // no-op, but it must still flip the tracker to Done.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hello world").unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        add_local_folder(&manager, dir.path().to_str().unwrap()).unwrap();

        let result = backfill_embeddings(&manager, None).unwrap();
        // No missing chunks → embedded=0, status=done.
        assert_eq!(result.embedded, 0);
        assert_eq!(result.progress.status, "done");

        // A repeat call is still safe and still ends Done.
        let again = backfill_embeddings(&manager, Some(4)).unwrap();
        assert_eq!(again.embedded, 0);
        assert_eq!(again.progress.status, "done");
    }

    #[test]
    fn bridge_get_embedding_progress_starts_idle() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let snap = get_embedding_progress(&manager).unwrap();
        assert_eq!(snap.status, "idle");
        assert_eq!(snap.total_chunks, 0);
        assert_eq!(snap.embedded, 0);
        assert_eq!(snap.failed, 0);
    }

    #[test]
    fn bridge_get_hybrid_search_config_returns_default_with_decay_enabled() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let cfg = get_hybrid_search_config(&manager).unwrap();
        // Default config: bm25=1, vector=1, decay enabled with 30-day half-life.
        assert!((cfg.bm25_weight - 1.0).abs() < 1e-9);
        assert!((cfg.vector_weight - 1.0).abs() < 1e-9);
        assert!(cfg.recency_decay_enabled);
        let halflife = cfg.recency_halflife_secs.expect("decay enabled → halflife Some");
        let thirty_days = 30.0 * 24.0 * 60.0 * 60.0;
        assert!((halflife - thirty_days).abs() < 1.0);
    }

    #[test]
    fn bridge_update_hybrid_search_config_can_disable_decay() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let updated = update_hybrid_search_config(
            &manager,
            HybridSearchConfigUpdate {
                recency_decay_enabled: Some(false),
                // Decay-off must win over any numeric halflife — verify
                // by sending a deliberately-suspicious value alongside.
                recency_halflife_secs: Some(99_999_999.0),
                ..HybridSearchConfigUpdate::default()
            },
        )
        .unwrap();
        assert!(!updated.recency_decay_enabled);
        // When decay is off, the renderer should not see a halflife
        // number — the wire shape is `None` so the form keeps its
        // last-known value rather than showing 99999999.
        assert!(updated.recency_halflife_secs.is_none());

        // And the underlying manager should reflect the disabled state.
        let live = get_hybrid_search_config(&manager).unwrap();
        assert!(!live.recency_decay_enabled);
    }

    #[test]
    fn bridge_update_hybrid_search_config_can_re_enable_decay_with_default_halflife() {
        // Disable decay → halflife=INFINITY internally. Then send
        // `recency_decay_enabled: Some(true)` with no halflife: the
        // bridge should choose the documented default (30 days)
        // rather than leave INFINITY in place.
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        update_hybrid_search_config(
            &manager,
            HybridSearchConfigUpdate {
                recency_decay_enabled: Some(false),
                ..HybridSearchConfigUpdate::default()
            },
        )
        .unwrap();
        let re_enabled = update_hybrid_search_config(
            &manager,
            HybridSearchConfigUpdate {
                recency_decay_enabled: Some(true),
                ..HybridSearchConfigUpdate::default()
            },
        )
        .unwrap();
        assert!(re_enabled.recency_decay_enabled);
        let halflife = re_enabled
            .recency_halflife_secs
            .expect("decay re-enabled → halflife Some");
        let thirty_days = 30.0 * 24.0 * 60.0 * 60.0;
        assert!((halflife - thirty_days).abs() < 1.0);
    }

    #[test]
    fn bridge_update_hybrid_search_config_can_re_enable_decay_with_explicit_halflife() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        update_hybrid_search_config(
            &manager,
            HybridSearchConfigUpdate {
                recency_decay_enabled: Some(false),
                ..HybridSearchConfigUpdate::default()
            },
        )
        .unwrap();
        let want_halflife = 7.0 * 24.0 * 60.0 * 60.0;
        let updated = update_hybrid_search_config(
            &manager,
            HybridSearchConfigUpdate {
                recency_decay_enabled: Some(true),
                recency_halflife_secs: Some(want_halflife),
                ..HybridSearchConfigUpdate::default()
            },
        )
        .unwrap();
        assert!(updated.recency_decay_enabled);
        assert!((updated.recency_halflife_secs.unwrap() - want_halflife).abs() < 1.0);
    }

    #[test]
    fn bridge_update_hybrid_search_config_rejects_invalid_weights_as_invalid_args() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let err = update_hybrid_search_config(
            &manager,
            HybridSearchConfigUpdate {
                bm25_weight: Some(-1.0),
                ..HybridSearchConfigUpdate::default()
            },
        )
        .unwrap_err();
        match err {
            BridgeError::InvalidArgs(msg) => {
                assert!(msg.contains("bm25_weight"), "msg: {msg}");
            }
            other => panic!("expected InvalidArgs, got {other:?}"),
        }
    }

    #[test]
    fn bridge_update_hybrid_search_config_with_empty_patch_is_noop() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let before = get_hybrid_search_config(&manager).unwrap();
        let after = update_hybrid_search_config(
            &manager,
            HybridSearchConfigUpdate::default(),
        )
        .unwrap();
        // Empty patch → config unchanged.
        assert!((after.bm25_weight - before.bm25_weight).abs() < 1e-9);
        assert!((after.vector_weight - before.vector_weight).abs() < 1e-9);
        assert_eq!(after.recency_decay_enabled, before.recency_decay_enabled);
    }
}
