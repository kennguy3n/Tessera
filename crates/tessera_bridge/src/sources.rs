use std::sync::Arc;

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tessera_core::SourceId;
use tessera_sources::hybrid::{HybridSearchConfig, HybridSearchConfigInput};
use tessera_sources::manager::SourceManager;
use tessera_sources::progress::{EmbeddingProgressTracker, EmbeddingStatus};
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

/// JS-facing pass-through of [`tessera_sources::manager::KchatChannelAddOutcome`].
///
/// Returned by `bridge_add_kchat_channel`. The Node-side handler
/// (`apps/desktop/electron/ipc/kchat.ts`) inspects `newly_created`
/// to gate the `KchatChannelLinked` audit event: a first sync emits
/// it once; every subsequent re-sync for the same `cache_dir` flips
/// to `newly_created: false` and the handler skips the audit append
/// so the audit log doesn't accumulate one "linked" event per sync.
#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct KchatChannelAddOutcomeInfo {
    pub source: SourceInfo,
    pub newly_created: bool,
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

/// Register-or-reindex a KChat-channel source backed by a local cache
/// directory the Node-side KChat client populates with files downloaded
/// from a channel's file store. The directory is indexed through the
/// standard local-folder pipeline; the `SourceType::Kchat` tag lets the
/// renderer render a KChat-specific icon / detail surface and lets the
/// KChat scheduler poll the corresponding channel for new files on
/// its own interval.
///
/// **Idempotent on `cache_dir`** — the Node side calls this once per
/// add and again on every re-sync. A previous implementation always
/// inserted a fresh source row, producing one duplicate per sync. The
/// returned [`KchatChannelAddOutcomeInfo::newly_created`] flag lets
/// the Node-side handler gate the `KchatChannelLinked` audit event
/// to first-sync only.
pub fn add_kchat_channel(
    manager: &SourceManager,
    cache_dir: &str,
) -> BridgeResult<KchatChannelAddOutcomeInfo> {
    let outcome = manager
        .add_kchat_channel(cache_dir)
        .map_err(BridgeError::Core)?;
    Ok(KchatChannelAddOutcomeInfo {
        source: SourceInfo::from(&outcome.source),
        newly_created: outcome.newly_created,
    })
}

/// JS-facing pass-through of
/// [`tessera_sources::manager::SourceManager::index_kchat_file`].
///
/// Returned by `bridge_index_kchat_file`. The Block B Task 2 WS
/// forwarder uses this to set the `triggered_reindex` flag on the
/// `KchatFileEventReceived` audit row:
///   - `was_linked = false` → channel is not registered as a source;
///     forwarder records `triggered_reindex = false`.
///   - `was_linked = true && indexed = true` → file was newly
///     indexed (or re-indexed because its content hash changed);
///     forwarder records `triggered_reindex = true`.
///   - `was_linked = true && indexed = false` → file's content
///     hash matched an existing index entry (a concurrent full
///     sync got there first); forwarder records `triggered_reindex
///     = false` so the audit log accurately reflects whether THIS
///     event drove indexer work.
///
/// `source_id` is populated only when `was_linked = true`; it is
/// the empty string otherwise so the napi serialization layer
/// doesn't need an `Option<String>` (the renderer never reads
/// `source_id` when `was_linked` is false).
#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct KchatFileIndexOutcomeInfo {
    pub was_linked: bool,
    pub indexed: bool,
    pub source_id: String,
}

/// Returns whether a `SourceType::Kchat` source exists for the
/// given `cache_dir`. The WS forwarder calls this before doing
/// any network I/O on a `file_added` event so a push for a channel
/// the user has not linked never triggers a download.
pub fn is_kchat_channel_linked(manager: &SourceManager, cache_dir: &str) -> BridgeResult<bool> {
    manager
        .is_kchat_channel_linked(cache_dir)
        .map_err(BridgeError::Core)
}

/// Targeted single-file index for a KChat-channel source.
///
/// Called by the WS forwarder after it has downloaded the bytes
/// referenced by a `file_added` event into the channel cache dir.
/// `file_basename` is treated as untrusted; the substrate's
/// `index_kchat_file` re-applies path-traversal containment
/// checks on top of the Node-side sanitisation as defence-in-depth.
pub fn index_kchat_file(
    manager: &SourceManager,
    cache_dir: &str,
    file_basename: &str,
) -> BridgeResult<KchatFileIndexOutcomeInfo> {
    match manager
        .index_kchat_file(cache_dir, file_basename)
        .map_err(BridgeError::Core)?
    {
        None => Ok(KchatFileIndexOutcomeInfo {
            was_linked: false,
            indexed: false,
            source_id: String::new(),
        }),
        Some((source_id, outcome)) => Ok(KchatFileIndexOutcomeInfo {
            was_linked: true,
            indexed: outcome.indexed,
            source_id: source_id.to_string(),
        }),
    }
}

/// JS-facing pass-through of one entry in the KChat channel member
/// roster the Node-side forwarder hands to
/// [`refresh_kchat_acl`]. Mirrors the wire shape of
/// `KchatChannelMember` so the napi bridge can hand the list
/// through without an extra adapter struct on the Node side.
#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct KchatAclMemberInfo {
    pub user_id: String,
    pub role: String,
}

/// JS-facing outcome of a `bridge_refresh_kchat_acl` call.
///
/// `outcome` is the snake_case form of the manager's
/// `KchatAclRefreshOutcome` variant: `granted` / `regranted` /
/// `revoked` / `unlinked` / `no_principal`. The Node side records
/// this verbatim in the `KchatAclRefreshed` audit row so an
/// operator can see exactly which projection rule fired.
///
/// Block B Task 4 (Phase 11): when `outcome == "revoked"`, the
/// inline cryptoshred ran and `chunks_dropped` / `files_dropped`
/// report how many rows the substrate scrubbed. For every other
/// outcome the counts are zero (no shred happened).
///
/// Fifth-pass Devin Review fix
/// (ANALYSIS_pr-review-job-ef3c7d6c..._0001): `vacuum_succeeded` /
/// `vacuum_error` record whether the substrate's Phase 5 `VACUUM`
/// (the belt-and-braces freelist sweep that runs after the DELETE
/// + UPDATE transaction commits under `PRAGMA secure_delete = ON`)
/// ran cleanly. A `false` here is NOT a scrub failure — the
/// row-level scrub already committed and the cryptographic
/// guarantee holds — but operators want the audit row to record
/// the degraded state so they can re-run `VACUUM` manually once
/// the underlying issue resolves.
#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct KchatAclRefreshOutcomeInfo {
    pub outcome: String,
    pub member_count: i64,
    pub principal_present: bool,
    /// Count of chunk rows scrubbed by the inline cryptoshred on
    /// the revoke path. Zero on all non-revoke outcomes.
    pub chunks_dropped: u32,
    /// Count of indexed_files rows scrubbed by the inline
    /// cryptoshred on the revoke path. Zero on all non-revoke
    /// outcomes.
    pub files_dropped: u32,
    /// Block C Task 2 (Phase 12): count of `kchat_posts` rows
    /// scrubbed alongside the file/chunk rows. Zero on all
    /// non-revoke outcomes.
    pub posts_dropped: u32,
    /// Block C Task 2 (Phase 12): `true` when the per-source
    /// wrapped-DEK row existed and was deleted as part of the
    /// shred. Paired with the in-memory `forget_dek` call the
    /// manager issues on revoke. Always `false` on non-revoke
    /// outcomes.
    pub dek_dropped: bool,
    /// Fifth-pass Devin Review fix: `true` when the belt-and-braces
    /// `VACUUM` ran cleanly (or was skipped). `false` only when
    /// `VACUUM` ran and failed; the row-level scrub still committed
    /// under `secure_delete = ON` in that case so the cryptographic
    /// guarantee holds.
    pub vacuum_succeeded: bool,
    /// Fifth-pass Devin Review fix: first-error message text on a
    /// `VACUUM` failure. `None` when `vacuum_succeeded` is `true`.
    pub vacuum_error: Option<String>,
}

/// JS-facing outcome of a `bridge_revoke_kchat_source` call.
/// `outcome` is the snake_case form of the manager's
/// `KchatRevokeOutcome`: `revoked` / `already_revoked` / `unlinked`.
///
/// Block B Task 4 (Phase 11): both `revoked` and `already_revoked`
/// outcomes report the cryptoshred counts — a fresh revoke scrubs
/// the live evidence, and a re-revoke runs the (idempotent) shred
/// again so a previously soft-revoked source still gets its
/// chunks + indexed_files scrubbed during the Task-4 backfill.
/// `unlinked` is always zero.
///
/// Fifth-pass Devin Review fix
/// (ANALYSIS_pr-review-job-ef3c7d6c..._0001): `vacuum_succeeded` /
/// `vacuum_error` carry the substrate's Phase 5 `VACUUM` result.
/// See [`KchatAclRefreshOutcomeInfo`] for the full semantics.
#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct KchatRevokeOutcomeInfo {
    pub outcome: String,
    /// Count of chunk rows scrubbed by the inline cryptoshred.
    pub chunks_dropped: u32,
    /// Count of indexed_files rows scrubbed by the inline cryptoshred.
    pub files_dropped: u32,
    /// Block C Task 2 (Phase 12): see
    /// [`KchatAclRefreshOutcomeInfo::posts_dropped`].
    pub posts_dropped: u32,
    /// Block C Task 2 (Phase 12): see
    /// [`KchatAclRefreshOutcomeInfo::dek_dropped`].
    pub dek_dropped: bool,
    /// Fifth-pass Devin Review fix: see
    /// [`KchatAclRefreshOutcomeInfo::vacuum_succeeded`].
    pub vacuum_succeeded: bool,
    /// Fifth-pass Devin Review fix: see
    /// [`KchatAclRefreshOutcomeInfo::vacuum_error`].
    pub vacuum_error: Option<String>,
}

/// Refresh a KChat channel's ACL roster + project status (Block B
/// Task 3, Phase 11). See `SourceManager::refresh_kchat_acl` for
/// the full semantics. The Node-side `KchatEventForwarder` calls
/// this after every membership-change event.
pub fn refresh_kchat_acl(
    manager: &SourceManager,
    cache_dir: &str,
    members: &[KchatAclMemberInfo],
) -> BridgeResult<KchatAclRefreshOutcomeInfo> {
    use tessera_sources::manager::{KchatAclMember, KchatAclRefreshOutcome};
    let internal: Vec<KchatAclMember> = members
        .iter()
        .map(|m| KchatAclMember {
            user_id: m.user_id.clone(),
            role: m.role.clone(),
        })
        .collect();
    let outcome = manager
        .refresh_kchat_acl(cache_dir, &internal)
        .map_err(BridgeError::Core)?;
    let (
        outcome_str,
        principal_present,
        chunks_dropped,
        files_dropped,
        posts_dropped,
        dek_dropped,
        vacuum_succeeded,
        vacuum_error,
    ) = match outcome {
        KchatAclRefreshOutcome::Granted => {
            ("granted", true, 0_u32, 0_u32, 0_u32, false, true, None)
        }
        KchatAclRefreshOutcome::Regranted => {
            ("regranted", true, 0_u32, 0_u32, 0_u32, false, true, None)
        }
        KchatAclRefreshOutcome::Revoked {
            chunks_dropped,
            files_dropped,
            posts_dropped,
            dek_dropped,
            vacuum_succeeded,
            vacuum_error,
        } => (
            "revoked",
            false,
            chunks_dropped,
            files_dropped,
            posts_dropped,
            dek_dropped,
            vacuum_succeeded,
            vacuum_error,
        ),
        KchatAclRefreshOutcome::Unlinked => {
            ("unlinked", false, 0_u32, 0_u32, 0_u32, false, true, None)
        }
        KchatAclRefreshOutcome::NoPrincipal => (
            "no_principal",
            false,
            0_u32,
            0_u32,
            0_u32,
            false,
            true,
            None,
        ),
    };
    Ok(KchatAclRefreshOutcomeInfo {
        outcome: outcome_str.to_string(),
        member_count: internal.len() as i64,
        principal_present,
        chunks_dropped,
        files_dropped,
        posts_dropped,
        dek_dropped,
        vacuum_succeeded,
        vacuum_error,
    })
}

/// Explicitly revoke a KChat-channel source (Block B Task 3,
/// Phase 11). Used for `channel_archived` / `channel_deleted` /
/// self-`user_removed` events where there is no roster to fetch.
pub fn revoke_kchat_source(
    manager: &SourceManager,
    cache_dir: &str,
) -> BridgeResult<KchatRevokeOutcomeInfo> {
    use tessera_sources::manager::KchatRevokeOutcome;
    let outcome = manager
        .revoke_kchat_source(cache_dir)
        .map_err(BridgeError::Core)?;
    let (
        outcome_str,
        chunks_dropped,
        files_dropped,
        posts_dropped,
        dek_dropped,
        vacuum_succeeded,
        vacuum_error,
    ) = match outcome {
        KchatRevokeOutcome::Revoked {
            chunks_dropped,
            files_dropped,
            posts_dropped,
            dek_dropped,
            vacuum_succeeded,
            vacuum_error,
        } => (
            "revoked",
            chunks_dropped,
            files_dropped,
            posts_dropped,
            dek_dropped,
            vacuum_succeeded,
            vacuum_error,
        ),
        KchatRevokeOutcome::AlreadyRevoked {
            chunks_dropped,
            files_dropped,
            posts_dropped,
            dek_dropped,
            vacuum_succeeded,
            vacuum_error,
        } => (
            "already_revoked",
            chunks_dropped,
            files_dropped,
            posts_dropped,
            dek_dropped,
            vacuum_succeeded,
            vacuum_error,
        ),
        KchatRevokeOutcome::Unlinked => ("unlinked", 0, 0, 0, false, true, None),
    };
    Ok(KchatRevokeOutcomeInfo {
        outcome: outcome_str.to_string(),
        chunks_dropped,
        files_dropped,
        posts_dropped,
        dek_dropped,
        vacuum_succeeded,
        vacuum_error,
    })
}

/// Set the locally-authenticated KChat principal user id on the
/// substrate (Block B Task 3, Phase 11). Called by the Node-side
/// `kchat:connect` IPC handler after `/users/me` returns.
pub fn set_kchat_principal(manager: &SourceManager, user_id: &str) -> BridgeResult<()> {
    manager
        .set_kchat_principal(user_id)
        .map_err(BridgeError::Core)
}

/// Clear the persisted KChat principal on `kchat:disconnect`.
pub fn clear_kchat_principal(manager: &SourceManager) -> BridgeResult<()> {
    manager.clear_kchat_principal().map_err(BridgeError::Core)
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

/// Read the latest snapshot directly from a shared progress tracker,
/// bypassing the outer [`SourceManager`] mutex. Used by the napi
/// bridge while a backfill is in flight: the backfill itself holds
/// the `SourceManager` lock on a worker thread, and we still want
/// `bridge_get_embedding_progress` calls on the JS main thread to
/// return cheap real-time counters rather than queueing up behind
/// the DB writes.
///
/// Callers obtain the `Arc` via [`SourceManager::embedding_progress_handle`]
/// at init time and cache it for the lifetime of the bridge.
pub fn get_embedding_progress_from_tracker(
    tracker: &Arc<EmbeddingProgressTracker>,
) -> EmbeddingProgressInfo {
    snapshot_to_info(tracker.snapshot())
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
    // sentinel that the core crate uses. Four cases matter:
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
    //   3. `None` + caller sent a finite halflife while current
    //      state has decay disabled → DROP the halflife. Without
    //      this guard, a future caller writing
    //      `{ recencyDecayEnabled: None, recencyHalflifeSecs: Some(30d) }`
    //      against a decay-off state would silently re-enable decay
    //      via the finite-halflife back door (the JSON wire layer
    //      can't represent `INFINITY`, so the bridge's effective
    //      `recency_decay_enabled` is computed from `is_finite()`).
    //      Requiring an explicit `Some(true)` to enable decay keeps
    //      the wire-level semantics aligned with caller intent and
    //      prevents the API surface from drifting between "don't
    //      touch the flag" and "I'm setting halflife but not the
    //      toggle".
    //   4. `None`         → otherwise, pass whatever halflife the
    //      renderer sent (could be `None`).
    let current_decay_enabled = manager
        .get_hybrid_config()
        .recency_halflife_secs
        .is_finite();
    let mut effective_halflife = update.recency_halflife_secs;
    match update.recency_decay_enabled {
        Some(false) => {
            effective_halflife = Some(f64::INFINITY);
        }
        Some(true) => {
            if update.recency_halflife_secs.is_none() && !current_decay_enabled {
                effective_halflife = Some(tessera_sources::hybrid::DEFAULT_RECENCY_HALFLIFE_SECS);
            }
        }
        None => {
            if !current_decay_enabled && update.recency_halflife_secs.is_some_and(f64::is_finite) {
                // Decay is currently off and the caller didn't ask to
                // enable it — refuse to silently re-enable via a
                // finite halflife. Drop the halflife so the patch is
                // a no-op on this field. The toggle (still `None`)
                // doesn't touch the underlying INFINITY value.
                effective_halflife = None;
            }
        }
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
    fn get_embedding_progress_from_tracker_reflects_manager_state() {
        // The tracker handle handed out by `embedding_progress_handle`
        // is the same `Arc` that the manager records progress against,
        // so reads through it must agree with reads that go through
        // the manager API.
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let tracker = manager.embedding_progress_handle();

        let from_tracker = get_embedding_progress_from_tracker(&tracker);
        let from_manager = get_embedding_progress(&manager).unwrap();
        assert_eq!(from_tracker.status, from_manager.status);
        assert_eq!(from_tracker.total_chunks, from_manager.total_chunks);
        assert_eq!(from_tracker.embedded, from_manager.embedded);
        assert_eq!(from_tracker.failed, from_manager.failed);

        // Run a backfill against an empty index — flips Idle → Done.
        // Both read paths must now report `done` without contending
        // for the same lock.
        let _ = backfill_embeddings(&manager, None).unwrap();
        let from_tracker = get_embedding_progress_from_tracker(&tracker);
        assert_eq!(from_tracker.status, "done");
    }

    #[test]
    fn bridge_get_hybrid_search_config_returns_default_with_decay_enabled() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let cfg = get_hybrid_search_config(&manager).unwrap();
        // Default config: bm25=1, vector=1, decay enabled with 30-day half-life.
        assert!((cfg.bm25_weight - 1.0).abs() < 1e-9);
        assert!((cfg.vector_weight - 1.0).abs() < 1e-9);
        assert!(cfg.recency_decay_enabled);
        let halflife = cfg
            .recency_halflife_secs
            .expect("decay enabled → halflife Some");
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
        let after =
            update_hybrid_search_config(&manager, HybridSearchConfigUpdate::default()).unwrap();
        // Empty patch → config unchanged.
        assert!((after.bm25_weight - before.bm25_weight).abs() < 1e-9);
        assert!((after.vector_weight - before.vector_weight).abs() < 1e-9);
        assert_eq!(after.recency_decay_enabled, before.recency_decay_enabled);
    }

    #[test]
    fn bridge_update_hybrid_search_config_does_not_silently_re_enable_decay() {
        // Regression test for finding: when a
        // caller sends `recency_decay_enabled: None` (don't touch
        // toggle) together with `recency_halflife_secs: Some(finite)`
        // against a manager whose current state has decay DISABLED
        // (halflife = INFINITY), the bridge must NOT silently
        // re-enable decay by overwriting the halflife with the
        // caller's finite value. Re-enable must be explicit via
        // `recency_decay_enabled: Some(true)`.
        let manager = SourceManager::new_in_memory(&[]).unwrap();

        // Step 1: explicitly disable decay. The internal halflife is
        // now `f64::INFINITY` (sentinel for "decay off").
        update_hybrid_search_config(
            &manager,
            HybridSearchConfigUpdate {
                recency_decay_enabled: Some(false),
                ..HybridSearchConfigUpdate::default()
            },
        )
        .unwrap();
        let pre = get_hybrid_search_config(&manager).unwrap();
        assert!(!pre.recency_decay_enabled);
        assert!(
            pre.recency_halflife_secs.is_none(),
            "decay-off should serialise as `None` on the wire (INFINITY is not JSON-representable)"
        );

        // Step 2: send a finite halflife with no toggle. The caller
        // probably MEANT to enable decay but forgot the flag. The
        // safe behaviour is to drop the halflife and keep the toggle
        // off — making the caller's intent explicit instead of
        // letting an undeclared side effect flip a security-relevant
        // setting.
        let want_halflife = 7.0 * 24.0 * 60.0 * 60.0; // 7 days
        let after = update_hybrid_search_config(
            &manager,
            HybridSearchConfigUpdate {
                recency_decay_enabled: None,
                recency_halflife_secs: Some(want_halflife),
                ..HybridSearchConfigUpdate::default()
            },
        )
        .unwrap();

        // Decay must still be DISABLED.
        assert!(
            !after.recency_decay_enabled,
            "bridge silently re-enabled decay; recency_decay_enabled became true \
             even though the caller did not set the toggle"
        );
        assert!(
            after.recency_halflife_secs.is_none(),
            "halflife should still serialise as `None` (decay off); got {:?}",
            after.recency_halflife_secs
        );

        // Step 3: by contrast, an EXPLICIT enable with the same
        // halflife should be honored. This proves the guard isn't
        // over-broad — it only prevents the silent path.
        let enabled = update_hybrid_search_config(
            &manager,
            HybridSearchConfigUpdate {
                recency_decay_enabled: Some(true),
                recency_halflife_secs: Some(want_halflife),
                ..HybridSearchConfigUpdate::default()
            },
        )
        .unwrap();
        assert!(enabled.recency_decay_enabled);
        let returned = enabled
            .recency_halflife_secs
            .expect("halflife should be Some when decay is enabled");
        assert!((returned - want_halflife).abs() < 1.0);
    }

    #[test]
    fn bridge_update_hybrid_search_config_passes_through_halflife_when_decay_is_already_on() {
        // Counterpart to the silent-re-enable test: when decay is
        // already ON (halflife is finite), a caller sending
        // `recency_decay_enabled: None` plus a new finite halflife
        // must STILL be allowed to adjust the halflife. The guard
        // only kicks in when current decay is OFF — adjusting the
        // halflife with decay already on doesn't change the toggle.
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        // Sanity: fresh manager has decay enabled (finite default).
        let pre = get_hybrid_search_config(&manager).unwrap();
        assert!(pre.recency_decay_enabled);

        let new_halflife = 14.0 * 24.0 * 60.0 * 60.0;
        let after = update_hybrid_search_config(
            &manager,
            HybridSearchConfigUpdate {
                recency_decay_enabled: None,
                recency_halflife_secs: Some(new_halflife),
                ..HybridSearchConfigUpdate::default()
            },
        )
        .unwrap();
        assert!(after.recency_decay_enabled);
        let returned = after
            .recency_halflife_secs
            .expect("halflife should be Some when decay is enabled");
        assert!((returned - new_halflife).abs() < 1.0);
    }
}
