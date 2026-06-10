//! N-API surface for source ingestion, indexing and search.

use std::sync::Arc;

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tessera_core::SourceId;
use tessera_sources::hybrid::{HybridSearchConfig, HybridSearchConfigInput};
use tessera_sources::manager::{KchatPostSearchHit, KchatThreadContextMessage, SourceManager};
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
/// JS-facing view of a [`Source`]: identity plus indexing state,
/// with timestamps rendered as RFC 3339 strings for the renderer.
pub struct SourceInfo {
    /// Source id, stringified.
    pub id: String,
    /// Source kind (`"local_folder"`, `"local_file"`, `"kchat"`, …).
    pub source_type: String,
    /// Filesystem path or channel cache dir the source reads from.
    pub path: String,
    /// Current indexing/connection status, stringified.
    pub status: String,
    /// When the source was added, RFC 3339.
    pub created_at: String,
    /// When indexing last completed (RFC 3339), or `None` if never.
    pub last_indexed: Option<String>,
    /// Number of files indexed from this source.
    pub file_count: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
/// JS-facing view of one ranked search hit (a matched chunk plus
/// its source and relevance).
pub struct SearchHitInfo {
    /// Full chunk text.
    pub content: String,
    /// Query-centred snippet for display.
    pub excerpt: String,
    /// Path of the source the chunk came from.
    pub source_path: String,
    /// Source id, stringified.
    pub source_id: String,
    /// Content hash of the matched chunk.
    pub chunk_hash: String,
    /// Position of the chunk within its source.
    pub chunk_index: i32,
    /// Relevance score in `(0, 1]`; higher ranks first.
    pub relevance: f64,
}

/// JS-facing result of an observation-enriched search
/// (`bridge_search_sources_enriched`).
///
/// `hits` are the standard chunk-level results (identical shape to
/// `bridge_search_sources`), but ranked by the retention-weighted
/// hybrid search so chunks from sources with active memories rank
/// higher. The remaining fields are the additive knowledge plane the
/// renderer shows in the "Knowledge" tab: `entities` and `facts` are
/// observation-typed memory items, `concepts` are matching
/// concept-graph nodes, and `memories` is the full ranked memory match
/// set (superset of entities/facts).
#[napi(object)]
pub struct EnrichedSearchResult {
    /// Standard chunk hits, retention-weighted.
    pub hits: Vec<SearchHitInfo>,
    /// Matching `entity` memory items.
    pub entities: Vec<crate::substrate::SubstrateMemory>,
    /// Matching `fact`/`claim`/`decision` memory items.
    pub facts: Vec<crate::substrate::SubstrateMemory>,
    /// Matching concept-graph nodes with their related sources.
    pub concepts: Vec<crate::substrate::SubstrateConcept>,
    /// All matching memory items (any observation type).
    pub memories: Vec<crate::substrate::SubstrateMemory>,
}

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
/// JS-facing view of one indexed file belonging to a source.
pub struct IndexedFileInfo {
    /// File path, relative to or within the source.
    pub path: String,
    /// Content hash at last index, used for staleness detection.
    pub hash: String,
    /// File modification time, RFC 3339.
    pub last_modified: String,
    /// Number of chunks produced from this file.
    pub chunk_count: i32,
}

/// JS-facing pass-through of
/// [`tessera_sources::manager::KchatPostSearchHit`].
///
/// Returned by `bridge_search_kchat_posts`. Differs from
/// [`SearchHitInfo`] in three ways:
///
/// 1. Carries chat-specific metadata (channel id, post id,
///    root id, sender id, timestamps) so the renderer can render
///    a KChat-flavoured citation badge alongside the excerpt and
///    construct a `kchat://` permalink for the "Jump to KChat"
///    action.
/// 2. `source_path` carries the channel cache dir (== channel id
///    by construction) rather than a synthetic `kchat:post:<id>`
///    handle — the renderer maps it to the user-visible channel
///    name from its local roster cache.
/// 3. `chunk_index` and `byte_offset` are surfaced so two
///    citations of the same post on different chunks can be
///    distinguished in the citations list without ambiguity.
///
/// Field ordering matches [`SearchHitInfo`] where the two
/// overlap, plus the KChat-specific block tucked at the end so
/// the napi-generated `.d.ts` is diff-stable when one struct or
/// the other grows a field.
#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct KchatPostSearchHitInfo {
    /// AEAD-verified plaintext of the matched chunk.
    pub content: String,
    /// Query-centred snippet for display.
    pub excerpt: String,
    /// Channel cache dir (equals the channel id) the post lives in.
    pub source_path: String,
    /// Source id, stringified.
    pub source_id: String,
    /// Content hash of the matched chunk.
    pub chunk_hash: String,
    /// Position of the chunk within the post.
    pub chunk_index: i32,
    /// Byte offset of the chunk's start within the post body.
    pub byte_offset: i32,
    /// Relevance score in `(0, 1]`; higher ranks first.
    pub relevance: f64,
    /// KChat post id of the match.
    pub post_id: String,
    /// KChat channel id the post was sent in.
    pub channel_id: String,
    /// Thread root post id, or `None` if the post is a root.
    pub root_id: Option<String>,
    /// User id of the post's author.
    pub sender_user_id: String,
    /// Post creation time, Unix epoch milliseconds.
    pub created_at_ms: i64,
    /// Last-edit time, Unix epoch milliseconds.
    pub edited_at_ms: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
/// JS-facing source-detail payload: a source plus its indexed files.
pub struct SourceDetailInfo {
    /// The source's summary info.
    pub source: SourceInfo,
    /// Files indexed from the source.
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
    /// The linked (or re-synced) channel source.
    pub source: SourceInfo,
    /// `true` only on the first link; `false` on subsequent
    /// re-syncs of the same channel.
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

impl From<&KchatPostSearchHit> for KchatPostSearchHitInfo {
    fn from(h: &KchatPostSearchHit) -> Self {
        Self {
            content: h.content.clone(),
            excerpt: h.excerpt.clone(),
            source_path: h.source_path.clone(),
            source_id: h.source_id.to_string(),
            chunk_hash: h.hash.clone(),
            chunk_index: h.chunk_index as i32,
            byte_offset: h.byte_offset as i32,
            relevance: h.relevance,
            post_id: h.post_id.clone(),
            channel_id: h.channel_id.clone(),
            root_id: h.root_id.clone(),
            sender_user_id: h.sender_user_id.clone(),
            created_at_ms: h.created_at_ms,
            edited_at_ms: h.edited_at_ms,
        }
    }
}

/// napi-shaped pass-through of
/// [`tessera_sources::manager::KchatThreadContextMessage`].
///
/// Returned by `bridge_fetch_kchat_thread_context`. Each element
/// is one AEAD-verified parent message of the post the renderer
/// asked about. The vec is ordered chronologically (oldest first)
/// so the renderer can render the thread top-down as a
/// conversation transcript.
///
/// Fields mirror the substrate type one-for-one; `is_root`
/// distinguishes the thread-root message (the post the threaded
/// reply hangs off of) from the earlier-sibling replies that
/// frame the conversation context.
#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct KchatThreadContextMessageInfo {
    /// KChat post id of this thread message.
    pub post_id: String,
    /// KChat channel id the message was sent in.
    pub channel_id: String,
    /// User id of the message's author.
    pub sender_user_id: String,
    /// Creation time, Unix epoch milliseconds.
    pub created_at_ms: i64,
    /// Last-edit time, Unix epoch milliseconds.
    pub edited_at_ms: i64,
    /// AEAD-verified plaintext of the message.
    pub content: String,
    /// Whether this message is the thread root.
    pub is_root: bool,
}

impl From<&KchatThreadContextMessage> for KchatThreadContextMessageInfo {
    fn from(m: &KchatThreadContextMessage) -> Self {
        Self {
            post_id: m.post_id.clone(),
            channel_id: m.channel_id.clone(),
            sender_user_id: m.sender_user_id.clone(),
            created_at_ms: m.created_at_ms,
            edited_at_ms: m.edited_at_ms,
            content: m.content.clone(),
            is_root: m.is_root,
        }
    }
}

/// Registers a local folder as a source and returns its
/// [`SourceInfo`].
pub fn add_local_folder(manager: &SourceManager, path: &str) -> BridgeResult<SourceInfo> {
    let source = manager.add_local_folder(path).map_err(BridgeError::Core)?;
    Ok(SourceInfo::from(&source))
}

/// Registers a single local file as a source and returns its
/// [`SourceInfo`].
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
    /// `true` if a KChat source exists for the cache dir.
    pub was_linked: bool,
    /// `true` if this event actually triggered indexer work.
    pub indexed: bool,
    /// Source id (empty string when `was_linked` is false).
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
    /// KChat user id of the channel member.
    pub user_id: String,
    /// Member's role in the channel (e.g. `"member"`, `"admin"`).
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
/// when `outcome == "revoked"`, the
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
    /// Which projection rule fired (`granted` / `regranted` /
    /// `revoked` / `unlinked` / `no_principal`).
    pub outcome: String,
    /// Number of members in the refreshed roster.
    pub member_count: i64,
    /// Whether the local principal is a member of the channel.
    pub principal_present: bool,
    /// Count of chunk rows scrubbed by the inline cryptoshred on
    /// the revoke path. Zero on all non-revoke outcomes.
    pub chunks_dropped: u32,
    /// Count of indexed_files rows scrubbed by the inline
    /// cryptoshred on the revoke path. Zero on all non-revoke
    /// outcomes.
    pub files_dropped: u32,
    /// count of `kchat_posts` rows
    /// scrubbed alongside the file/chunk rows. Zero on all
    /// non-revoke outcomes.
    pub posts_dropped: u32,
    /// `true` when the per-source
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
/// both `revoked` and `already_revoked`
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
    /// Revoke result (`revoked` / `already_revoked` / `unlinked`).
    pub outcome: String,
    /// Count of chunk rows scrubbed by the inline cryptoshred.
    pub chunks_dropped: u32,
    /// Count of indexed_files rows scrubbed by the inline cryptoshred.
    pub files_dropped: u32,
    /// see
    /// [`KchatAclRefreshOutcomeInfo::posts_dropped`].
    pub posts_dropped: u32,
    /// see
    /// [`KchatAclRefreshOutcomeInfo::dek_dropped`].
    pub dek_dropped: bool,
    /// Fifth-pass Devin Review fix: see
    /// [`KchatAclRefreshOutcomeInfo::vacuum_succeeded`].
    pub vacuum_succeeded: bool,
    /// Fifth-pass Devin Review fix: see
    /// [`KchatAclRefreshOutcomeInfo::vacuum_error`].
    pub vacuum_error: Option<String>,
}

/// Refresh a KChat channel's ACL roster + project status. See `SourceManager::refresh_kchat_acl` for
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

/// Explicitly revoke a KChat-channel source. Used for `channel_archived` / `channel_deleted` /
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
/// substrate. Called by the Node-side
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

/// Returns every registered source as [`SourceInfo`].
pub fn list_sources(manager: &SourceManager) -> BridgeResult<Vec<SourceInfo>> {
    let sources = manager.list_sources().map_err(BridgeError::Core)?;
    Ok(sources.iter().map(SourceInfo::from).collect())
}

/// Removes a source and all of its indexed data (id parsed from a
/// UUID string).
pub fn remove_source(manager: &SourceManager, source_id: &str) -> BridgeResult<()> {
    let uuid =
        uuid::Uuid::parse_str(source_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    manager
        .remove_source(&SourceId(uuid))
        .map_err(BridgeError::Core)
}

// -- sync-failure state pass-throughs -----------------
//
// Three thin helpers the napi bridge wraps in `#[napi]` exports
// so the TS-side `runConnectorSync` can record and read the
// per-source failure state. The retry/backoff policy itself is
// applied in TS so the connectors layer remains the single
// authority on how errors are classified — we just durably
// persist the resulting state in SQLite.

/// read the persisted `(last_sync_error,
/// retry_count, failed_permanently)` tuple for one source row.
pub fn get_source_sync_failure_state(
    manager: &SourceManager,
    source_id: &str,
) -> BridgeResult<(Option<String>, u32, bool)> {
    let uuid =
        uuid::Uuid::parse_str(source_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    manager
        .get_sync_failure_state(&SourceId(uuid))
        .map_err(BridgeError::Core)
}

/// atomic write of all three failure-state
/// columns. The TS caller passes the JSON-serialised
/// `PersistedSyncError` plus the policy-computed retry count and
/// permanent flag.
pub fn record_source_sync_failure(
    manager: &SourceManager,
    source_id: &str,
    last_sync_error_json: &str,
    retry_count: u32,
    failed_permanently: bool,
) -> BridgeResult<()> {
    let uuid =
        uuid::Uuid::parse_str(source_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    manager
        .record_sync_failure(
            &SourceId(uuid),
            last_sync_error_json,
            retry_count,
            failed_permanently,
        )
        .map_err(BridgeError::Core)
}

/// clear the failure-state columns. Called from
/// TS after a successful connector sync — the live "sync OK"
/// signal must clear any sticky "permanently failed" badge so the
/// user does not have to manually dismiss it after re-authorising.
pub fn record_source_sync_success(manager: &SourceManager, source_id: &str) -> BridgeResult<()> {
    let uuid =
        uuid::Uuid::parse_str(source_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    manager
        .record_sync_success(&SourceId(uuid))
        .map_err(BridgeError::Core)
}

/// Runs a hybrid search over file sources, returning up to `limit`
/// [`SearchHitInfo`]s.
pub fn search_sources(
    manager: &SourceManager,
    query: &str,
    limit: usize,
) -> BridgeResult<Vec<SearchHitInfo>> {
    let results = manager.search(query, limit).map_err(BridgeError::Core)?;
    Ok(results.iter().map(SearchHitInfo::from).collect())
}

/// Like [`search_sources`] but fuses the knowledge-substrate retention
/// signal into the hybrid ranking via
/// [`SourceManager::search_with_retention`]. An empty
/// `retention_by_source` map yields ranking identical to
/// [`search_sources`].
///
/// The default `RandomState` hasher is intentionally concrete (rather
/// than a generic `S: BuildHasher`): the map is handed straight to
/// [`SourceManager::search_with_retention`], whose `SearchEngine`
/// stores it in a `HashMap<String, f64>` field pinned to the default
/// hasher, so a generic parameter here would buy nothing and force a
/// rebuild at the boundary.
#[allow(clippy::implicit_hasher)]
pub fn search_sources_with_retention(
    manager: &SourceManager,
    query: &str,
    limit: usize,
    retention_by_source: std::collections::HashMap<String, f64>,
) -> BridgeResult<Vec<SearchHitInfo>> {
    let results = manager
        .search_with_retention(query, limit, retention_by_source)
        .map_err(BridgeError::Core)?;
    Ok(results.iter().map(SearchHitInfo::from).collect())
}

/// bridge counterpart of
/// [`SourceManager::search_kchat_posts`]. Returns AEAD-verified
/// KChat post-body chunks ranked by BM25 + reciprocal rank.
///
/// Intentionally a sibling of [`search_sources`] (rather than a
/// merged "search-everywhere") so the renderer can:
///
/// 1. Display file and chat citations with distinct visual
///    treatment without branching on a tagged-union return type.
/// 2. Apply per-kind privacy controls — e.g. the renderer could
///    suppress KChat post results in the Comparison surface but
///    keep them in the Artifact surface.
/// 3. Audit the two query kinds independently — the
///    `KchatPostSearchExecuted` audit row only fires when this
///    bridge is called (see `bridge_log_kchat_post_search_executed`).
pub fn search_kchat_posts(
    manager: &SourceManager,
    query: &str,
    limit: usize,
) -> BridgeResult<Vec<KchatPostSearchHitInfo>> {
    let results = manager
        .search_kchat_posts(query, limit)
        .map_err(BridgeError::Core)?;
    Ok(results.iter().map(KchatPostSearchHitInfo::from).collect())
}

/// bridge counterpart of
/// [`SourceManager::fetch_kchat_thread_context`]. Returns the
/// AEAD-verified parent messages of `post_id` (up to 3: the
/// thread root + up to 2 most-recent earlier-replies) ordered
/// chronologically.
///
/// The renderer wires this to a hit's expand-thread affordance:
/// after `search_kchat_posts` surfaces a row whose `root_id` is
/// non-null, the user can click "show thread" to expand the row
/// into a transcript. Calling this on a non-threaded hit (or on
/// an unknown post id) returns an empty vec — the manager swallows
/// the "not found / not threaded" cases as benign empty results
/// rather than errors, so the renderer can render an "expand"
/// affordance unconditionally and degrade gracefully when the
/// substrate has no context to show.
///
/// `source_id` is the renderer-facing UUID string (
/// `KchatPostSearchHitInfo::source_id`); invalid UUIDs surface
/// as `BridgeError::InvalidArgs` so the IPC layer can scrub the
/// raw input out of the error message before it reaches the
/// renderer.
pub fn fetch_kchat_thread_context(
    manager: &SourceManager,
    source_id: &str,
    post_id: &str,
) -> BridgeResult<Vec<KchatThreadContextMessageInfo>> {
    let uuid =
        uuid::Uuid::parse_str(source_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let results = manager
        .fetch_kchat_thread_context(&SourceId(uuid), post_id)
        .map_err(BridgeError::Core)?;
    Ok(results
        .iter()
        .map(KchatThreadContextMessageInfo::from)
        .collect())
}

/// Returns a source together with its indexed files for the
/// detail view.
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

/// Re-runs indexing for a source and returns its refreshed
/// [`SourceInfo`].
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
/// JS-facing snapshot of a source's indexing progress.
pub struct IndexingProgressInfo {
    /// Lifecycle state (`"idle"` / `"running"` / `"done"` /
    /// `"failed"`).
    pub status: String,
    /// Files visited so far.
    pub scanned: u32,
    /// Files (re)indexed.
    pub indexed: u32,
    /// Files skipped because unchanged.
    pub unchanged: u32,
    /// Files skipped (ignored/unsupported).
    pub skipped: u32,
    /// Files that errored.
    pub errors: u32,
    /// Final file count when done (0 while running).
    pub total_files: u32,
    /// In-flight file path, if known.
    pub current_path: Option<String>,
    /// Failure reason when `status == "failed"`.
    pub last_error: Option<String>,
}

/// Returns the current [`IndexingProgressInfo`] for a source.
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
/// JS-facing snapshot of an embedding-backfill pass's progress.
pub struct EmbeddingProgressInfo {
    /// Lifecycle state (`"idle"` / `"running"` / `"done"` /
    /// `"failed"`).
    pub status: String,
    /// Chunks the pass intends to embed (stable denominator).
    pub total_chunks: u32,
    /// Chunks successfully embedded so far.
    pub embedded: u32,
    /// Chunks whose embedding failed (non-fatal).
    pub failed: u32,
    /// Embedder model id the pass targets, if started.
    pub model_id: Option<String>,
    /// Failure reason when `status == "failed"`.
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
/// Result of a one-shot embedding-backfill pass: how many chunks
/// were embedded plus the final progress snapshot.
pub struct BackfillEmbeddingsResult {
    /// Number of chunks newly embedded by this call. If the index
    /// already has up-to-date embeddings for the active model, this
    /// is 0 and `progress.status` flips Idle → Done immediately.
    pub embedded: u32,
    /// Final progress snapshot after the call.
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
    /// Weight of the BM25 ranking in fusion.
    pub bm25_weight: f64,
    /// Weight of the vector-cosine ranking in fusion.
    pub vector_weight: f64,
    /// RRF damping constant.
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
    /// Candidates pulled from each ranking before fusion.
    pub candidate_pool_size: u32,
    /// Weight of the knowledge-substrate retention ranking in fusion
    /// (the fourth RRF signal).
    pub retention_weight: f64,
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
            retention_weight: c.retention_weight,
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
    /// New BM25 weight, or `None` to leave unchanged.
    pub bm25_weight: Option<f64>,
    /// New vector-cosine weight, or `None` to leave unchanged.
    pub vector_weight: Option<f64>,
    /// New RRF damping constant, or `None` to leave unchanged.
    pub rrf_k: Option<f64>,
    /// `Some(true)` → enable decay (use the accompanying
    /// `recency_halflife_secs` if provided, else keep current);
    /// `Some(false)` → disable decay (sets internal halflife to
    /// `f64::INFINITY`); `None` → don't touch the flag.
    pub recency_decay_enabled: Option<bool>,
    /// New recency half-life (seconds), or `None` to leave
    /// unchanged.
    pub recency_halflife_secs: Option<f64>,
    /// New candidate-pool size, or `None` to leave unchanged.
    pub candidate_pool_size: Option<u32>,
    /// New retention-signal weight, or `None` to leave unchanged.
    pub retention_weight: Option<f64>,
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
        retention_weight: update.retention_weight,
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

// =====================================================================
// ONNX embedding model management.
//
// Three IPC-shaped helpers wrap the [`tessera_sources::model_registry`]
// + [`tessera_sources::onnx_embedder`] layers so the renderer can
// (a) discover which models exist and which are currently installed,
// (b) trigger a download of a not-yet-installed model with progress
// reporting, and (c) swap the live embedder to a downloaded model
// without restarting the bridge.
//
// The download progress is published through a [`DownloadProgressTracker`]
// owned by the bridge's `AppState`, mirroring the existing
// embedding-progress / indexing-progress polling architecture: the
// renderer never receives push events; it polls. This keeps the
// IPC boundary one-way (renderer → main) and avoids any
// `ThreadsafeFunction` dance, which historically has been the most
// painful part of N-API surface in this codebase.
// =====================================================================

use std::path::PathBuf;
use std::sync::Mutex;

use tessera_sources::model_registry::{self, ModelInfo, SHIPPED_MODELS};
use tessera_sources::onnx_embedder::OnnxEmbeddingProvider;

/// Public wire-shape for a single shipped embedding model.
///
/// Mirrors [`ModelInfo`] with two derived fields the renderer
/// needs to render the model picker UI:
///   - `installed`: whether the model is fully downloaded AND
///     its SHA-256 matches the pinned hash on disk (the partial-
///     download recovery contract from `model_registry`).
///   - `model_id`: the canonical id this model would be tagged
///     with in `chunk_embeddings.model_id` once active, so the
///     renderer can show "current model" with the same string
///     the search hot path actually uses.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct EmbeddingModelInfo {
    /// Stable registry slug used to select/download the model.
    pub slug: String,
    /// Human-readable name for the model picker.
    pub display_name: String,
    /// Output embedding dimensionality.
    pub dim: u32,
    /// Approximate ONNX file size in bytes — used to render the
    /// "120 MB download" hint before the user opts into the
    /// download.
    pub model_size_bytes: f64,
    /// Approximate tokenizer.json size in bytes.
    pub tokenizer_size_bytes: f64,
    /// Human-readable language coverage (e.g. `"English"`).
    pub languages: String,
    /// `true` when downloaded and SHA-256-verified on disk.
    pub installed: bool,
    /// Canonical id written to `chunk_embeddings.model_id` when
    /// this model is active.
    pub model_id: String,
}

impl EmbeddingModelInfo {
    fn from_info(info: &ModelInfo, models_root: &std::path::Path) -> Self {
        Self {
            slug: info.slug.to_string(),
            display_name: info.display_name.to_string(),
            dim: u32::try_from(info.dim).unwrap_or(u32::MAX),
            // f64 because napi-rs's `u64` mapping requires the
            // `BigInt` ergonomics on the JS side and renderer
            // code consistently uses `number` for sizes.
            model_size_bytes: info.model_size_bytes as f64,
            tokenizer_size_bytes: info.tokenizer_size_bytes as f64,
            languages: info.languages.to_string(),
            installed: info.is_installed(models_root),
            model_id: format!("onnx:{}:{}d", info.slug, info.dim),
        }
    }
}

/// Wire shape returned by `getEmbeddingModelStatus`. Combines the
/// model catalogue with the current bridge-level state in a single
/// payload so the Settings UI can render with one round trip
/// instead of three sequential calls.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct EmbeddingModelStatusInfo {
    /// `model_id` of the currently-active embedder. `None` if the
    /// manager has no embedder attached, which happens in test
    /// builds and during the brief startup window before the
    /// default HashTrick is plumbed in.
    pub current_model_id: Option<String>,
    /// Catalogue of every shipped ONNX model with per-entry
    /// install state. Always returns all entries (in display
    /// order) regardless of which one is active — the renderer
    /// uses this to populate the picker.
    pub models: Vec<EmbeddingModelInfo>,
    /// Current download progress snapshot (status + counters).
    /// Always present so the renderer can render the progress
    /// banner without a second IPC; reports `status="idle"` when
    /// no download is in flight.
    pub download: DownloadProgressInfo,
    /// number of currently-indexed chunks whose
    /// content contains at least one non-ASCII byte. The Settings
    /// UI uses `non_ascii_chunks / total_chunks > 0.10` to render
    /// a "your corpus looks multilingual — consider the XLM-R
    /// model" hint. `f64` (not `u64`) so we can return both
    /// counts inside the napi-derive JS object shape without
    /// overflowing the `Number` precision boundary on extreme
    /// corpora — a chunk count above 2^53 is impossible in
    /// practice but `napi-derive` lacks BigInt support and we
    /// want the field shape to be stable.
    pub non_ascii_chunks: f64,
    /// total indexed chunks across all sources.
    /// Companion to `non_ascii_chunks` — the renderer needs the
    /// denominator to compute the ratio and also surfaces the
    /// absolute counts ("128 of 1,400 chunks contain non-Latin
    /// text") for transparency.
    pub total_chunks: f64,
}

/// Status of an in-flight model download.
///
/// Matches the spirit of [`EmbeddingProgressInfo`]: a single
/// snapshot the renderer polls on a timer. The renderer uses
/// `bytes_downloaded / bytes_total` to render the progress bar
/// and `status == "done" || "failed"` to dismiss it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct DownloadProgressInfo {
    /// `"idle" | "downloading" | "done" | "failed"`. Strings
    /// rather than a typed enum at the IPC boundary so the
    /// renderer's type-narrowing code can use a discriminated
    /// union with literal types without depending on the napi
    /// crate's enum encoding.
    pub status: String,
    /// Slug of the model being / last downloaded. `None` before
    /// the first download in the session.
    pub slug: Option<String>,
    /// Total bytes the active download expects. `None` when the
    /// upstream `Content-Length` was missing (rare on HF CDN);
    /// the renderer should fall back to an indeterminate bar.
    pub bytes_total: Option<f64>,
    /// Bytes downloaded so far. Always >= 0.
    pub bytes_downloaded: f64,
    /// Last error message when `status == "failed"`. `None`
    /// otherwise. Surfaced verbatim from the registry / network
    /// layer so a user can copy-paste it into a bug report.
    pub last_error: Option<String>,
}

/// Shared download-progress state owned by `AppState`. Wrapped in
/// a [`Mutex`] because the only writers are (a) the async download
/// task (one at a time) and (b) the snapshot-read path used by
/// `bridge_get_embedding_download_progress`. Mutex contention is
/// negligible: writers update on every streamed chunk (~64 KiB)
/// while readers poll on a renderer timer (typically 500 ms).
#[derive(Debug)]
pub struct DownloadProgressTracker {
    inner: Mutex<DownloadProgressInfo>,
}

impl Default for DownloadProgressTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl DownloadProgressTracker {
    /// Creates a tracker in the `idle` state with no active
    /// download.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(DownloadProgressInfo {
                status: "idle".to_string(),
                slug: None,
                bytes_total: None,
                bytes_downloaded: 0.0,
                last_error: None,
            }),
        }
    }

    /// Reset the snapshot for a new download. Called synchronously
    /// from the bridge entry point before the async task spawns,
    /// to defuse the same race the embedding-backfill tracker has:
    /// the renderer's first poll for a new download MUST see
    /// `status=downloading` instead of the previous run's
    /// terminal status (`done` or `failed`).
    pub fn mark_starting(&self, slug: &str) {
        if let Ok(mut g) = self.inner.lock() {
            *g = DownloadProgressInfo {
                status: "downloading".to_string(),
                slug: Some(slug.to_string()),
                bytes_total: None,
                bytes_downloaded: 0.0,
                last_error: None,
            };
        }
    }

    /// Push a `(bytes_downloaded, bytes_total)` update from the
    /// registry's streaming callback.
    ///
    /// Since the cumulative-progress refactor, the
    /// registry's `download_model` wrapper always supplies a fixed,
    /// non-zero `combined_total` derived from the registry hints
    /// (model + tokenizer sizes), so `bytes_total > 0` always holds
    /// at this call site in production. The `== 0` branch below is
    /// retained as defence-in-depth in case a future caller wires
    /// the tracker to a different progress source that lacks a
    /// known total (e.g. chunked-encoding without Content-Length);
    /// in that scenario surfacing `None` lets the renderer fall
    /// back to an indeterminate progress bar instead of rendering
    /// "0 % of 0 B".
    pub fn update(&self, bytes_downloaded: u64, bytes_total: u64) {
        if let Ok(mut g) = self.inner.lock() {
            g.bytes_downloaded = bytes_downloaded as f64;
            g.bytes_total = if bytes_total == 0 {
                None
            } else {
                Some(bytes_total as f64)
            };
        }
    }

    /// Marks the active download as completed successfully.
    pub fn mark_done(&self) {
        if let Ok(mut g) = self.inner.lock() {
            g.status = "done".to_string();
            g.last_error = None;
        }
    }

    /// Marks the active download as failed, recording `msg`.
    pub fn mark_failed(&self, msg: &str) {
        if let Ok(mut g) = self.inner.lock() {
            g.status = "failed".to_string();
            g.last_error = Some(msg.to_string());
        }
    }

    /// Returns a copy of the current progress for the renderer to
    /// poll.
    pub fn snapshot(&self) -> DownloadProgressInfo {
        self.inner.lock().ok().map_or_else(
            || DownloadProgressInfo {
                status: "failed".to_string(),
                slug: None,
                bytes_total: None,
                bytes_downloaded: 0.0,
                last_error: Some("download tracker mutex poisoned".to_string()),
            },
            |g| g.clone(),
        )
    }
}

/// Construct the `models_root` path the registry expects from a
/// renderer-supplied data dir.
///
/// The renderer passes `app.getPath("userData")` (e.g.
/// `~/.config/Tessera`). The registry lays files out at
/// `{models_root}/onnx/{slug}/{model,tokenizer}.{onnx,json}`, and
/// other capabilities (vision, imagegen) live under
/// `{models_root}/{vision,imagegen}/`, so `models_root` is the
/// `models` subdirectory of userData. We resolve it here once so
/// every entry point gets the same path semantics.
fn models_root_for(user_data_dir: &str) -> PathBuf {
    PathBuf::from(user_data_dir).join("models")
}

/// Resolve and return the catalogue + active model id + download
/// state in a single payload. See [`EmbeddingModelStatusInfo`] for
/// the wire shape.
pub fn get_embedding_model_status(
    manager: &SourceManager,
    tracker: &DownloadProgressTracker,
    user_data_dir: &str,
) -> BridgeResult<EmbeddingModelStatusInfo> {
    let models_root = models_root_for(user_data_dir);
    let models = SHIPPED_MODELS
        .iter()
        .map(|info| EmbeddingModelInfo::from_info(info, &models_root))
        .collect();
    // pull the non-ASCII chunk stats inside the
    // same call so the renderer doesn't need a second IPC just to
    // decide whether to render the multilingual hint. The cost is
    // two index-only `COUNT(*)` scans against the chunks table —
    // amortised vs. the registry-scan I/O the call already does.
    let (non_ascii_chunks, total_chunks) = manager.count_non_ascii_chunks()?;
    Ok(EmbeddingModelStatusInfo {
        current_model_id: manager.current_embedder_model_id(),
        models,
        download: tracker.snapshot(),
        non_ascii_chunks: non_ascii_chunks as f64,
        total_chunks: total_chunks as f64,
    })
}

/// Download a registered ONNX embedding model to disk.
///
/// Drives [`model_registry::download_model`] with a progress
/// callback that publishes into the shared [`DownloadProgressTracker`].
/// The caller (the napi `AsyncTask`) is responsible for marking
/// the tracker `done` / `failed` based on this function's result,
/// because the registry function returns *after* the file has been
/// atomically renamed and so a `Ok` from here unambiguously means
/// the files are in place.
///
/// Returns the install directory containing the downloaded
/// `model.onnx` + `tokenizer.json`.
pub async fn download_embedding_model(
    slug: &str,
    user_data_dir: &str,
    tracker: Arc<DownloadProgressTracker>,
) -> BridgeResult<PathBuf> {
    let models_root = models_root_for(user_data_dir);
    let cb_tracker = Arc::clone(&tracker);
    let cb: model_registry::ProgressCallback =
        Arc::new(move |downloaded, total| cb_tracker.update(downloaded, total));
    let install_dir = model_registry::download_model(slug, &models_root, Some(cb))
        .await
        .map_err(|e| {
            // Surface the registry's structured error verbatim —
            // it already encodes whether the failure was a
            // network error, an SHA-256 mismatch, or a missing
            // slug, all of which the renderer renders identically
            // ("download failed, retry") but the audit log
            // needs to distinguish.
            BridgeError::Core(e)
        })?;
    Ok(install_dir)
}

/// Switch the active embedding provider to a downloaded ONNX model.
///
/// Validates that the requested model is fully installed (matching
/// SHA-256) before constructing the [`OnnxEmbeddingProvider`] so a
/// mid-download switch doesn't silently activate a corrupted
/// model. After the swap, the caller is expected to invoke
/// [`SourceManager::backfill_embeddings_tracked`] so the new
/// model's vectors are populated for existing chunks — that is
/// scheduled by the IPC layer rather than fired here so the
/// renderer can drive the progress UI.
pub fn switch_embedding_model(
    manager: &mut SourceManager,
    user_data_dir: &str,
    slug: &str,
) -> BridgeResult<EmbeddingModelInfo> {
    let models_root = models_root_for(user_data_dir);
    // the slug `"hash-trick"` is a reserved pseudo-
    // slug that reverts the active embedder to the bundled offline
    // HashTrick provider. It never appears in `SHIPPED_MODELS` (it
    // has no `.onnx` file to download), but the IPC layer and the
    // renderer's picker need to be able to round-trip it through
    // this same channel so "switch back to fast / offline" stays
    // symmetric with switching to one of the ONNX models. The
    // returned `EmbeddingModelInfo` reports `installed: true` and
    // `model_size_bytes: 0.0` (no on-disk artefact) so the
    // renderer can render the HashTrick option uniformly with the
    // ONNX ones.
    if slug == HASH_TRICK_SLUG {
        use tessera_sources::embedding::EmbeddingProvider as _;
        let provider = tessera_sources::embedding::HashTrickEmbedding::default_config();
        let model_id = provider.model_id().to_string();
        let arc_provider: Arc<dyn tessera_sources::embedding::EmbeddingProvider> =
            Arc::new(provider);
        manager.set_embedder(Some(arc_provider));
        return Ok(EmbeddingModelInfo {
            slug: HASH_TRICK_SLUG.to_string(),
            display_name: "Fast (offline, no download)".to_string(),
            dim: 256,
            model_size_bytes: 0.0,
            tokenizer_size_bytes: 0.0,
            languages: "any (lexical only)".to_string(),
            installed: true,
            model_id,
        });
    }
    let info = model_registry::lookup(slug)
        .ok_or_else(|| BridgeError::InvalidArgs(format!("unknown embedding model slug: {slug}")))?;
    if !info.is_installed(&models_root) {
        return Err(BridgeError::InvalidArgs(format!(
            "model {slug} is not installed (run download_embedding_model first)"
        )));
    }
    let model_path = info.model_path(&models_root);
    let tokenizer_path = info.tokenizer_path(&models_root);
    let provider = OnnxEmbeddingProvider::load(&model_path, &tokenizer_path, slug, info.dim)
        .map_err(BridgeError::Core)?;
    let arc_provider: Arc<dyn tessera_sources::embedding::EmbeddingProvider> = Arc::new(provider);
    manager.set_embedder(Some(arc_provider));
    Ok(EmbeddingModelInfo::from_info(info, &models_root))
}

/// reserved pseudo-slug for the bundled offline
/// HashTrick embedder. Exposed as a `pub const` so the napi
/// exports layer + tests can reference the canonical string
/// without a magic literal scattered through the codebase.
pub const HASH_TRICK_SLUG: &str = "hash-trick";

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

    /// the bridge `search_kchat_posts`
    /// wrapper must round-trip the substrate's
    /// [`KchatPostSearchHit`] into the napi-shaped
    /// [`KchatPostSearchHitInfo`] preserving every metadata field
    /// the renderer needs (channel id, post id, sender id,
    /// created_at, edited_at, byte_offset, root_id). Loss of any
    /// of these fields would silently break the citation badge or
    /// the `kchat://` permalink construction downstream.
    #[test]
    fn bridge_search_kchat_posts_round_trips_metadata() {
        use tessera_sources::manager::KchatPostIngestInput;
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager.add_kchat_channel(cache_dir).unwrap();
        let _ = manager
            .ingest_kchat_post(&KchatPostIngestInput {
                cache_dir: cache_dir.to_string(),
                post_id: "post-bridge".to_string(),
                channel_id: "ch-bridge".to_string(),
                root_id: Some("root-thread".to_string()),
                sender_user_id: "u-author".to_string(),
                body: "narwhal walrus dolphin orca whale".to_string(),
                created_at_ms: 1_700_000_001_000,
                edited_at_ms: 1_700_000_002_000,
            })
            .unwrap();

        let hits = search_kchat_posts(&manager, "narwhal", 10).unwrap();
        assert_eq!(hits.len(), 1, "expected one hit (got {})", hits.len());
        let h = &hits[0];
        assert_eq!(h.post_id, "post-bridge");
        assert_eq!(h.channel_id, "ch-bridge");
        assert_eq!(h.root_id.as_deref(), Some("root-thread"));
        assert_eq!(h.sender_user_id, "u-author");
        assert_eq!(h.created_at_ms, 1_700_000_001_000);
        assert_eq!(h.edited_at_ms, 1_700_000_002_000);
        assert_eq!(h.source_path, cache_dir);
        assert!(h.content.contains("narwhal"));
        assert!(!h.chunk_hash.is_empty());
        assert!(h.byte_offset >= 0);
        assert!(h.relevance > 0.0 && h.relevance <= 1.0);
    }

    /// empty result set must round-trip
    /// as an empty `Vec` — NOT as an error. The renderer's
    /// CitationPanel relies on this to render "no chat results"
    /// alongside file results without branching on error vs.
    /// empty.
    #[test]
    fn bridge_search_kchat_posts_empty_returns_empty_vec() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let hits = search_kchat_posts(&manager, "nonexistent-term-xyz", 10).unwrap();
        assert!(hits.is_empty());
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
