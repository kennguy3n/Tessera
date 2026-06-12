//! The `SourceManager`: the top-level facade for ingesting, indexing
//! and searching sources.

use std::path::Path;
use std::sync::{Arc, Mutex};
use tessera_core::error::{Error, Result};
use tessera_core::{SharedConnection, SharedReadPool, SourceId, SourceStatus};

use crate::chunker::Chunk;
use crate::embedding::{EmbeddingProvider, HashTrickEmbedding};
use crate::hybrid::{HybridSearchConfig, HybridSearchConfigInput};
use crate::indexer::{BackfillOutcome, Indexer};
use crate::kchat_crypto::{KchatCrypto, MasterKey};
use crate::progress::{
    finish_embedding, mark_embedding_failed, EmbeddingProgressSnapshot, EmbeddingProgressTracker,
    ProgressSnapshot, ProgressTracker,
};
use crate::search::{SearchEngine, SearchResult};
use crate::source::Source;
use crate::store::{IndexedFile, SourceStore};
use crate::vision_extractor::VisionExtractor;

/// Result of registering (or reindexing) a KChat-channel source via
/// [`SourceManager::add_kchat_channel`].
///
/// The Node-side `sources:addKchatChannel` IPC handler is the only
/// caller and uses `newly_created` to decide whether to emit a
/// `KchatChannelLinked` audit event: a first sync emits it, every
/// subsequent re-sync of the same `cache_dir` is treated as a
/// reindex and does not duplicate the audit row.
#[derive(Debug, Clone)]
pub struct KchatChannelAddOutcome {
    /// The source row as persisted (refreshed after reindexing so
    /// `last_indexed` / `file_count` reflect the run that just
    /// completed).
    pub source: Source,
    /// `true` when this call inserted a brand-new row, `false` when
    /// an existing `SourceType::Kchat` row with the same `path` was
    /// reindexed in place.
    pub newly_created: bool,
}

/// One entry of the authoritative KChat-channel member roster the
/// Node-side forwarder passes to
/// [`SourceManager::refresh_kchat_acl`]. Mirrors the wire shape of
/// `KchatChannelMember` so the napi bridge can hand the list over
/// without an extra adapter struct.
#[derive(Debug, Clone)]
pub struct KchatAclMember {
    /// KChat user id (the opaque `id` from `GET /users/me`).
    pub user_id: String,
    /// Comma-separated KChat role list, e.g. `"channel_user channel_admin"`.
    /// The substrate does not interpret it but persists it for
    /// forensics + future per-role retrieval filters.
    pub role: String,
}

/// Outcome of a [`SourceManager::refresh_kchat_acl`] call.
///
/// Block B Task 3 splits the result into four cases so
/// callers (the napi bridge + audit logger) can record exactly
/// what happened without re-querying the store. The cases are
/// mutually exclusive and exhaustive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KchatAclRefreshOutcome {
    /// The principal is in the refreshed roster AND the source
    /// row was in any non-revoked state. Status left unchanged
    /// (still `Indexed` / `Indexing` / etc.), the ACL row-set was
    /// replaced atomically. `principal_present == true`.
    Granted,
    /// The principal is in the refreshed roster AND the source
    /// row was previously `AccessRevoked` (e.g. the user was
    /// removed and then re-added). The roster was replaced
    /// atomically. `principal_present == true`.
    ///
    /// status transitions to
    /// `Connected` (NOT `Indexed`). The earlier revoke cryptoshred
    /// scrubbed every chunk + indexed_file row, so the source is
    /// empty until a full re-sync runs. The Node-side forwarder
    /// treats this outcome as a signal to schedule a re-sync via
    /// `bridge_sync_source`; the indexer then promotes the status
    /// to `Indexing` and `Indexed` on its own — the same flow used
    /// for a freshly-linked channel.
    Regranted,
    /// The principal is NOT in the refreshed roster. Status
    /// transitioned to `AccessRevoked`. The roster was still
    /// replaced atomically (so a future re-grant via re-add
    /// transitions to `Connected` and triggers a re-sync; see
    /// the `Regranted` doc). `principal_present == false`.
    ///
    /// the transition also triggers an
    /// inline cryptoshred — the source's chunks and indexed_files
    /// rows are deleted and the database is VACUUMed under
    /// `PRAGMA secure_delete = ON`, so leftover plaintext chunks
    /// from the now-revoked channel cannot leak via a future
    /// retrieval-filter bug, a direct SQL inspection, or a forensic
    /// disk-image of the SQLCipher-encrypted file (in the master-key
    /// compromise case). The roster row-set is intentionally KEPT —
    /// "who else had access at the moment of revocation" is a real
    /// question operators ask.
    Revoked {
        /// Count of chunk rows scrubbed by the inline cryptoshred.
        chunks_dropped: u32,
        /// Count of indexed_file rows scrubbed by the inline cryptoshred.
        files_dropped: u32,
        /// count of `kchat_posts` rows
        /// scrubbed alongside the file/chunk rows.
        posts_dropped: u32,
        /// `true` when the per-source
        /// wrapped DEK row existed and was deleted as part of the
        /// shred. `false` when the source never ingested a chat
        /// post and therefore had no DEK to drop. Together with
        /// the in-memory `forget_dek` call the manager issues
        /// after this outcome returns, this is the observable
        /// signal that the post-evidence DEK has been retired.
        dek_dropped: bool,
        /// Fifth-pass Devin Review fix
        /// (ANALYSIS_pr-review-job-ef3c7d6c..._0001): `true` when the
        /// belt-and-braces `VACUUM` ran cleanly (or was skipped
        /// because there was nothing to reclaim). `false` only when
        /// `VACUUM` ran and failed; the row-level scrub still
        /// committed under `secure_delete = ON` in that case so the
        /// cryptographic guarantee holds.
        vacuum_succeeded: bool,
        /// First-error message text on a `VACUUM` failure. `None`
        /// when `vacuum_succeeded` is `true`. The Node-side forwarder
        /// surfaces this on the `KchatSourceCryptoshredded` audit row
        /// so operators can grep for `vacuum_succeeded=false` and
        /// learn the underlying SQLite error without chasing
        /// stderr.
        vacuum_error: Option<String>,
    },
    /// No `SourceType::Kchat` row exists for the cache_dir the
    /// caller passed. The roster was NOT persisted (there's no
    /// source row to attach it to). Returned when the forwarder
    /// races a membership event against an unlinked channel.
    Unlinked,
    /// No `kchat_principal` is set on the substrate side. The
    /// roster was NOT persisted and the source status was NOT
    /// touched — flipping every linked source to `AccessRevoked`
    /// during the brief window between substrate startup and
    /// `kchat:connect` would flap statuses unnecessarily. The
    /// forwarder is expected to be a no-op when disconnected
    /// (which it is), so this case is the defence-in-depth
    /// fallback for tests + race windows.
    NoPrincipal,
}

/// Outcome of a [`SourceManager::revoke_kchat_source`] call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KchatRevokeOutcome {
    /// The source row transitioned from a non-revoked state to
    /// `AccessRevoked`. Block B Task 4: the transition
    /// also triggers an inline cryptoshred (see
    /// `KchatAclRefreshOutcome::Revoked` for the details).
    Revoked {
        /// Count of chunk rows scrubbed by the inline cryptoshred.
        chunks_dropped: u32,
        /// Count of indexed_file rows scrubbed by the inline cryptoshred.
        files_dropped: u32,
        /// see
        /// [`KchatAclRefreshOutcome::Revoked::posts_dropped`].
        posts_dropped: u32,
        /// see
        /// [`KchatAclRefreshOutcome::Revoked::dek_dropped`].
        dek_dropped: bool,
        /// Fifth-pass Devin Review fix: see
        /// [`KchatAclRefreshOutcome::Revoked::vacuum_succeeded`].
        vacuum_succeeded: bool,
        /// Fifth-pass Devin Review fix: see
        /// [`KchatAclRefreshOutcome::Revoked::vacuum_error`].
        vacuum_error: Option<String>,
    },
    /// The source row was already `AccessRevoked` — no status
    /// change applied. The audit row is still emitted by the
    /// caller so operators see the revoke event in the trail
    /// (otherwise a repeat `channel_archived` would silently drop
    /// the operator's clue that the channel was archived twice).
    ///
    /// a second revoke still runs
    /// cryptoshred so the operation is idempotent at the evidence
    /// layer — this also serves as a one-time backfill path for
    /// sources that were soft-revoked under the Task 3 build before
    /// the cryptoshred step landed. `chunks_dropped` /
    /// `files_dropped` will be zero for an already-scrubbed source.
    AlreadyRevoked {
        /// Count of chunk rows scrubbed by the inline cryptoshred.
        chunks_dropped: u32,
        /// Count of indexed_file rows scrubbed by the inline cryptoshred.
        files_dropped: u32,
        /// see
        /// [`KchatAclRefreshOutcome::Revoked::posts_dropped`].
        /// Typically zero on this path because the previous shred
        /// already dropped the kchat_posts rows.
        posts_dropped: u32,
        /// see
        /// [`KchatAclRefreshOutcome::Revoked::dek_dropped`].
        /// Typically `false` on this path because the previous
        /// shred already deleted the wrapped-DEK row.
        dek_dropped: bool,
        /// Fifth-pass Devin Review fix: see
        /// [`KchatAclRefreshOutcome::Revoked::vacuum_succeeded`].
        /// Typically `true` on this path because the idempotent
        /// re-shred drops zero rows so `VACUUM` is skipped — but a
        /// backfill of a Task-3-era soft-revoked source that still
        /// has chunks/indexed_files rows WILL run `VACUUM` and could
        /// fail.
        vacuum_succeeded: bool,
        /// Fifth-pass Devin Review fix: see
        /// [`KchatAclRefreshOutcome::Revoked::vacuum_error`].
        vacuum_error: Option<String>,
    },
    /// No `SourceType::Kchat` row exists for the cache_dir the
    /// caller passed. Returned when the forwarder races a
    /// `channel_archived` / `channel_deleted` event against a
    /// channel the user never linked as a source.
    Unlinked,
}

/// Input wire-shape for [`SourceManager::ingest_kchat_post`] /
/// [`SourceManager::edit_kchat_post`].
///
/// Block C Task 1. Built by the napi bridge from the
/// `posted` / `post_edited` WS event payloads (which the
/// `KchatEventForwarder` has already parsed + serialised against a
/// per-channel lock).
///
/// `cache_dir` is the channel id (mirrors the on-disk cache path
/// that `add_kchat_channel` registered as the `source.path`).
#[derive(Debug, Clone)]
pub struct KchatPostIngestInput {
    /// On-disk cache directory for the channel; equals the source's
    /// `path` and the `channel_id` (see `add_kchat_channel`).
    pub cache_dir: String,
    /// KChat post id being ingested.
    pub post_id: String,
    /// KChat channel id the post belongs to.
    pub channel_id: String,
    /// Thread root post id, or `None` if the post is a root.
    pub root_id: Option<String>,
    /// User id of the post's author.
    pub sender_user_id: String,
    /// Raw post body text to be chunked and indexed.
    pub body: String,
    /// KChat-server `create_at` millis since the unix epoch.
    pub created_at_ms: i64,
    /// KChat-server `edit_at` millis (0 for never-edited posts).
    pub edited_at_ms: i64,
}

/// Outcome of an [`SourceManager::ingest_kchat_post`] /
/// [`SourceManager::edit_kchat_post`] call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KchatPostIngestOutcome {
    /// A row was inserted (new post) or rewritten (edited post).
    /// `chunk_ids` carries the row ids of the AEAD-sealed chunks
    /// in the same order they were chunked. `sealed_count == 0`
    /// is valid (an empty-body post records bookkeeping only).
    Ingested {
        /// Source the post was ingested into.
        source_id: SourceId,
        /// Row id of the post's bookkeeping (`indexed_files`) entry.
        indexed_file_id: i64,
        /// Row ids of the AEAD-sealed chunks, in chunk order.
        chunk_ids: Vec<i64>,
        /// Number of chunks sealed (0 for an empty-body post).
        sealed_count: u32,
    },
    /// The (source_id, post_id) row already exists with the same
    /// body hash — duplicate delivery, no-op. The substrate
    /// still surfaces the row's chunk count so the audit row can
    /// faithfully record "no chunks added".
    Unchanged {
        /// Source the duplicate post belongs to.
        source_id: SourceId,
        /// Row id of the existing bookkeeping entry.
        indexed_file_id: i64,
        /// Number of chunks already stored for the post.
        chunk_count: u32,
    },
    /// No `SourceType::Kchat` row exists for the cache_dir.
    Unlinked,
    /// The source exists but is in `AccessRevoked` status —
    /// cryptographic refusal to ingest. The forwarder treats
    /// this as a no-op (the channel was revoked between the WS
    /// event arrival and the bridge call).
    AccessRevoked,
}

/// Outcome of an [`SourceManager::delete_kchat_post`] call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KchatPostDeleteOutcome {
    /// The chunks and the bookkeeping row were deleted.
    Deleted {
        /// Source the post was deleted from.
        source_id: SourceId,
        /// Number of chunks removed for the post.
        chunks_dropped: u32,
    },
    /// The bookkeeping row did not exist — either the post was
    /// never indexed (filtered out at the WS layer) or it was
    /// already deleted. No-op.
    NotFound {
        /// Source that was checked.
        source_id: SourceId,
    },
    /// No `SourceType::Kchat` row exists for the cache_dir.
    Unlinked,
    /// The source is in `AccessRevoked` status — defence in
    /// depth. The cryptoshred already removed all of this
    /// source's chunks; this branch is the "double delete"
    /// observability case.
    AccessRevoked,
}

/// persisted backfill state for a KChat
/// channel.
///
/// The orchestrator uses this to decide whether to (a) start a new
/// walk, (b) resume an interrupted walk from the persisted cursor,
/// (c) skip a walk that already completed, or (d) refuse to walk a
/// revoked / unlinked source. The discriminator is on the variant
/// so a future field rename can't accidentally drop the
/// "completed" sentinel via JSON drift.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KchatBackfillState {
    /// The source exists and is eligible for backfill.
    ///
    /// - `oldest_post_id` is the persisted cursor; `None` means
    ///   no walk has run yet, so the next REST fetch should omit
    ///   the `before=` parameter and start at the newest post.
    /// - `completed_at` is the RFC3339 timestamp at which the
    ///   walk reached the end of channel history; `None` means
    ///   the walk needs more pages (or has not started).
    Idle {
        /// Source eligible for backfill.
        source_id: SourceId,
        /// Persisted cursor: oldest post seen so far, or `None`
        /// before the first page.
        oldest_post_id: Option<String>,
        /// RFC 3339 time the walk reached end-of-history, or `None`
        /// if incomplete.
        completed_at: Option<String>,
    },
    /// No `SourceType::Kchat` row exists for the cache_dir. The
    /// orchestrator treats this as a no-op (the user removed the
    /// channel between the IPC kickoff and the substrate call).
    Unlinked,
    /// The source exists but is revoked; the orchestrator must
    /// not walk it (backfilling a revoked source would re-create
    /// the very chunks the cryptoshred just destroyed).
    AccessRevoked {
        /// The revoked source the orchestrator must not walk.
        source_id: SourceId,
    },
}

/// outcome of a single backfill page
/// ingest.
///
/// Carries the per-page counters the audit row needs to record
/// "what work this page did", plus the cursor the orchestrator
/// uses to fetch the next page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KchatBackfillIngestOutcome {
    /// The page was processed end-to-end. Counters break the page
    /// down by per-post substrate outcome so the audit trail and
    /// the renderer's progress indicator can show "X newly
    /// indexed, Y already known, Z skipped due to revocation".
    Ingested {
        /// Source the page was ingested into.
        source_id: SourceId,
        /// Posts newly inserted by this page.
        posts_ingested: u32,
        /// Posts already known (duplicate delivery).
        posts_unchanged: u32,
        /// Posts skipped because the source was revoked.
        posts_skipped_revoked: u32,
        /// The post id the cursor was advanced to. `None` when
        /// the page was empty (the orchestrator handles the
        /// completion transition separately) or when no post in
        /// the page was durably acknowledged (defensive — the
        /// loop's invariants prevent this in practice).
        oldest_post_id_in_page: Option<String>,
    },
    /// No `SourceType::Kchat` row exists for the cache_dir.
    Unlinked,
    /// The source flipped to `AccessRevoked` before or during
    /// the page. The orchestrator stops the walk; the audit row
    /// reflects an aborted-mid-walk transition.
    AccessRevoked {
        /// The source that flipped to revoked mid-walk.
        source_id: SourceId,
    },
}

/// outcome of
/// [`SourceManager::mark_kchat_backfill_complete`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KchatBackfillCompletionOutcome {
    /// The completion sentinel was set. Re-trigger of
    /// `runBackfillKchatChannel` short-circuits at
    /// `kchat_backfill_state` from here on.
    Completed {
        /// Source whose backfill is now marked complete.
        source_id: SourceId,
    },
    /// No `SourceType::Kchat` row exists for the cache_dir.
    Unlinked,
    /// The source is in `AccessRevoked` — the completion sentinel
    /// is NOT set; a future re-grant will start the walk fresh
    /// (the cryptoshred path already cleared the cursor).
    AccessRevoked {
        /// The revoked source.
        source_id: SourceId,
    },
}

/// one renderer-facing hit returned by
/// [`SourceManager::search_kchat_posts`].
///
/// Each hit is one chunk of a KChat post body that matched the
/// caller's FTS5 query AND whose AEAD ciphertext authenticates
/// under the per-source DEK. The `content` field carries the
/// verified plaintext (re-derived from the AEAD open, not the
/// `chunks.content` column) so a tampered-disk attack that
/// flipped a bit in the plaintext column without re-encrypting
/// cannot ride through retrieval. The plaintext bit-for-bit
/// matches what the indexer fed to FTS5 in the happy path.
///
/// Carries enough metadata for the renderer's citation surface
/// to:
///
/// 1. Render a citation badge (`channel_id`, `post_id`,
///    `created_at_ms`, `sender_user_id`) — the renderer maps
///    `channel_id` to the user-visible channel name from its
///    own local roster cache, and `sender_user_id` to a display
///    name similarly.
/// 2. Construct a "Jump to KChat" permalink (the IPC layer
///    composes `{server}/channel/{channel_id}/post/{post_id}`
///    using the kchat-auth server URL — the substrate does not
///    know the server URL).
/// 3. Insert a citation row with `source_type = "kchat"` (the
///    post's real backend — `SourceType` has no post-granularity
///    variant, and the cited source genuinely is a KChat channel),
///    `chunk_hash = hash`, and the `kchat://channel/<id>/post/<id>`
///    URN as the `source_uri`. The URN both identifies the post and
///    discriminates it from a file citation; the bridge maps it to
///    the synthetic `kchat:post:<id>` `indexed_files` path for
///    freshness hashing.
#[derive(Debug, Clone)]
pub struct KchatPostSearchHit {
    /// Source the matched post belongs to.
    pub source_id: SourceId,
    /// The KChat-channel cache_dir; equals `channel_id` by
    /// construction (see `add_kchat_channel`). Surfaced for
    /// parity with the file-search `source_path` field.
    pub source_path: String,
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
    /// Position of the matched chunk within the post.
    pub chunk_index: usize,
    /// Byte offset of the chunk's start within the post body.
    pub byte_offset: usize,
    /// AEAD-verified plaintext content of the chunk. Bit-for-bit
    /// equal to the `chunks.content` column in the happy path
    /// (the manager asserts equality before yielding the hit).
    pub content: String,
    /// Query-aware ±50-char snippet centred on the first query
    /// term, mirrors `search::build_excerpt` for visual parity
    /// with the file-search citations.
    pub excerpt: String,
    /// BLAKE3 hex of the post-body plaintext (NOT the chunk
    /// content). Citation rows use this so two citations of the
    /// same post on different chunks dedupe sensibly at the
    /// citation layer.
    pub hash: String,
    /// Position-stable relevance in `(0, 1]` — `1.0 / (rank + 1)`
    /// where `rank` is the 1-based position in the BM25-ordered
    /// hit list. Same scheme as
    /// [`crate::search::SearchResult::relevance`] for consistent
    /// surfacing across file-source and KChat-post citations.
    pub relevance: f64,
}

/// one renderer-facing AEAD-verified
/// message of thread context surrounding a search hit.
///
/// Returned by
/// [`SourceManager::fetch_kchat_thread_context`] in chronological
/// order (oldest first) — the renderer can render the messages
/// top-down as the conversation transcript leading up to the hit.
///
/// **Single-chunk preview.** `content` is the AEAD-verified
/// plaintext of the leading chunk (`chunks.chunk_index = 0`) of
/// the post body. In the typical case a KChat post fits in one
/// chunk so this is the entire body; for unusually-long parent
/// messages the renderer can render a "…" affordance and (in a
/// future iteration) request the full body via a dedicated
/// "fetch full post" handler. The trade-off here is keeping the
/// thread-context payload bounded so the IPC round-trip is fast
/// — a 10-thread × full-post payload would otherwise dwarf the
/// search result itself.
///
/// **Field discriminators.**
///
/// - `is_root` is `true` for the message whose `post_id` equals
///   the root id the lookup was anchored on (i.e. the original
///   parent the threaded reply hangs off of). The renderer
///   surfaces a distinct "Thread root" badge for this row.
/// - The other messages (`is_root == false`) are earlier-replies
///   in the same thread, with `created_at_ms < hit.created_at_ms`.
///
/// **Privacy.** The store's `source_id` filter + the manager's
/// per-source DEK gate guarantee that messages from a different
/// principal's KChat indexing of the same channel never surface
/// here, even when post ids happen to collide across sources
/// (e.g. two principals indexing the same KChat channel under
/// distinct `Source` rows). See
/// [`crate::store::SourceStore::fetch_kchat_thread_context_rows`]
/// for the substrate-side rationale.
#[derive(Debug, Clone)]
pub struct KchatThreadContextMessage {
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

/// High-level facade over [`SourceStore`], the indexer, and the
/// embedding/search pipeline; the bridge's entry point for managing
/// sources and running retrieval.
pub struct SourceManager {
    store: SourceStore,
    indexer: Indexer,
    progress: Arc<ProgressTracker>,
    embedding_progress: Arc<EmbeddingProgressTracker>,
    embedder: Option<Arc<dyn EmbeddingProvider>>,
    /// Live hybrid retrieval config. Behind a [`Mutex`] so the
    /// renderer's Settings page can update half-life / weights at
    /// runtime without rebuilding the manager. The `search` /
    /// `search_broad` hot path clones the snapshot under the lock
    /// and drops the guard before doing any I/O, so config updates
    /// never block in-flight searches and an in-flight search never
    /// holds the lock across a SQLite call.
    hybrid_config: Mutex<HybridSearchConfig>,
    /// per-source DEK + AEAD facade used
    /// by the KChat post-ingest path. Initialised with the same
    /// SQLCipher master key the bridge already validates in
    /// `tessera_core::db::open_shared_with_key`, so the KEK
    /// derivation is bound to the same root secret that protects
    /// the database file itself. For in-memory test runs the
    /// constructor falls back to a deterministic test key — the
    /// crypto is fully exercised in tests without requiring a
    /// keychain round-trip.
    kchat_crypto: Arc<KchatCrypto>,
}

impl SourceManager {
    /// Opens (or creates) the store at `db_path` and builds the
    /// default hybrid indexer/embedder/search pipeline.
    pub fn new(db_path: &str, ignore_patterns: &[String]) -> Result<Self> {
        let store = SourceStore::open(db_path)?;
        let (indexer, embedder, hybrid_config) = build_default_hybrid_pipeline(ignore_patterns);
        Ok(Self {
            store,
            indexer,
            progress: Arc::new(ProgressTracker::new()),
            embedding_progress: Arc::new(EmbeddingProgressTracker::new()),
            embedder,
            hybrid_config: Mutex::new(hybrid_config),
            kchat_crypto: Self::default_kchat_crypto(),
        })
    }

    /// Builds a manager backed by an ephemeral in-memory store (for
    /// tests).
    pub fn new_in_memory(ignore_patterns: &[String]) -> Result<Self> {
        let store = SourceStore::open_in_memory()?;
        let (indexer, embedder, hybrid_config) = build_default_hybrid_pipeline(ignore_patterns);
        Ok(Self {
            store,
            indexer,
            progress: Arc::new(ProgressTracker::new()),
            embedding_progress: Arc::new(EmbeddingProgressTracker::new()),
            embedder,
            hybrid_config: Mutex::new(hybrid_config),
            kchat_crypto: Self::default_kchat_crypto(),
        })
    }

    /// Build a manager backed by a [`SharedConnection`] that is also
    /// used by other stores. Used by the napi bridge.
    pub fn with_shared_conn(conn: SharedConnection, ignore_patterns: &[String]) -> Result<Self> {
        // Defaults to the empty pool ⇒ every SourceStore read
        // falls back to the writer mutex. Production callers
        // upgrade via [`Self::with_shared_conn_and_read_pool`]
        // once they have an on-disk database open.
        Self::with_shared_conn_and_read_pool(conn, tessera_core::empty_read_pool(), ignore_patterns)
    }

    /// variant of [`Self::with_shared_conn`]
    /// that wires a [`SharedReadPool`] into the underlying
    /// [`SourceStore`].
    ///
    /// The bridge calls this with a pool of N read-only
    /// connections to the same on-disk DB so hot reads (FTS5
    /// BM25, embedding-row scan, chunk hydration, age lookup)
    /// don't compete with writers for the single writer mutex.
    /// For in-memory tests, pass [`tessera_core::empty_read_pool`]
    /// — every read transparently falls back to the writer
    /// connection, preserving the legacy behaviour.
    pub fn with_shared_conn_and_read_pool(
        conn: SharedConnection,
        read_pool: SharedReadPool,
        ignore_patterns: &[String],
    ) -> Result<Self> {
        let store = SourceStore::with_shared_conn_and_read_pool(conn, read_pool)?;
        let (indexer, embedder, hybrid_config) = build_default_hybrid_pipeline(ignore_patterns);
        Ok(Self {
            store,
            indexer,
            progress: Arc::new(ProgressTracker::new()),
            embedding_progress: Arc::new(EmbeddingProgressTracker::new()),
            embedder,
            hybrid_config: Mutex::new(hybrid_config),
            kchat_crypto: Self::default_kchat_crypto(),
        })
    }

    /// wire the per-source KChat-post DEK
    /// layer to a real master key.
    ///
    /// The bridge calls this immediately after `with_shared_conn`,
    /// passing the same 64-hex-character key it gave to
    /// `open_shared_with_key`. After this call the KEK derivation
    /// shares fate with the SQLCipher master key — losing one
    /// loses both. Until this is called, ingestion uses the
    /// process-ephemeral test key generated by
    /// `Self::default_kchat_crypto`, which is appropriate ONLY
    /// for substrate tests; production must always rebind.
    pub fn set_kchat_master_key(&mut self, master_key_hex: &str) -> Result<()> {
        let mk = MasterKey::from_hex(master_key_hex)?;
        self.kchat_crypto = Arc::new(KchatCrypto::new(mk));
        Ok(())
    }

    /// Produce an ephemeral [`KchatCrypto`] facade backed by a
    /// random 32-byte key drawn at construction time. Used by the
    /// bare constructors so substrate tests + bridge tests have a
    /// working crypto layer without needing to thread a master key
    /// through; production calls [`Self::set_kchat_master_key`]
    /// immediately after `with_shared_conn` to rebind to the
    /// SQLCipher root.
    ///
    /// Implementation note: we draw 32 bytes from `OsRng`, then
    /// hex-encode + pass through `MasterKey::from_hex` so the
    /// public construction surface is identical between the
    /// production and test paths. A fixed-string default would
    /// leak the test key into any release build that forgot to
    /// call `set_kchat_master_key` — using random bytes makes
    /// that mistake silently safe (the data is unreadable
    /// post-restart, but the cryptographic protection is real).
    fn default_kchat_crypto() -> Arc<KchatCrypto> {
        use rand::RngCore;
        use std::fmt::Write;
        let mut buf = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut buf);
        let mut hex = String::with_capacity(buf.len() * 2);
        for b in &buf {
            // SAFETY: writing to a `String` via `fmt::Write::write_fmt`
            // is infallible (the underlying buffer is heap-backed).
            write!(&mut hex, "{b:02x}").expect("write to String is infallible");
        }
        let mk = MasterKey::from_hex(&hex).expect("freshly-built hex string must validate");
        Arc::new(KchatCrypto::new(mk))
    }

    /// Install / replace / remove the vision extractor on the
    /// underlying indexer. Block C task 9 / 10 / 11 plumbing: the
    /// bridge calls this after the vision sidecar reaches the
    /// `Ready` state with the installed-model record so subsequent
    /// `index_folder` / `reindex_source` calls describe images,
    /// OCR scanned PDFs, and (when chart extraction is enabled)
    /// describe charts.
    ///
    /// Pass `None` to detach \\- typically when the user uninstalls
    /// the vision model or the host transitions to a CPU-only
    /// configuration where vision is unavailable.
    pub fn set_vision_extractor(&mut self, extractor: Option<Arc<dyn VisionExtractor>>) {
        self.indexer.set_vision_extractor(extractor);
    }

    /// Toggle the chart-extraction pass on / off. Block C task 11
    /// plumbing: the bridge enables this after detecting `tier >=
    /// medium` AND a vision model is installed, because chart
    /// description requires the spatial-reasoning grade of
    /// Qwen3.5-VL (the recommended medium-tier vision model).
    /// Low-tier hosts running SmolVLM-256M leave this off.
    pub fn set_chart_extraction_enabled(&mut self, enabled: bool) {
        self.indexer.set_chart_extraction_enabled(enabled);
    }

    /// Returns a clone of the current hybrid retrieval config. Used
    /// by the renderer's Settings page to populate the initial form
    /// state (half-life slider, hybrid-on/off toggle, …).
    pub fn get_hybrid_config(&self) -> HybridSearchConfig {
        self.hybrid_config
            .lock()
            .expect("hybrid_config mutex poisoned")
            .clone()
    }

    /// Apply a partial-update patch to the hybrid retrieval config.
    /// Validation lives in [`HybridSearchConfig::apply_patch`]; this
    /// method holds the mutex for the whole patch-and-commit so a
    /// concurrent reader never sees the half-applied state. Returns
    /// the new effective config so the renderer can echo it back
    /// to the user.
    pub fn update_hybrid_config(
        &self,
        patch: &HybridSearchConfigInput,
    ) -> Result<HybridSearchConfig> {
        let mut guard = self
            .hybrid_config
            .lock()
            .expect("hybrid_config mutex poisoned");
        guard.apply_patch(patch)?;
        Ok(guard.clone())
    }

    /// Backfill embeddings for every chunk that doesn't yet have one
    /// for the current embedder. Idempotent. The bridge layer
    /// invokes this after attaching a new embedder so existing
    /// corpora benefit from hybrid retrieval without a full reindex.
    pub fn backfill_embeddings(&self, batch_size: usize) -> Result<usize> {
        self.indexer.backfill_embeddings(&self.store, batch_size)
    }

    /// Swap the active embedding provider.
    ///
    /// Used by the bridge when the user changes the embedding tier
    /// in Settings (e.g. "Fast (HashTrick)" → "Semantic — English
    /// (MiniLM)" → "Semantic — Multilingual (XLM-R)"). The provider
    /// is plumbed both into `SourceManager::embedder` (which the
    /// search hot path reads to embed the query) and into the
    /// underlying [`Indexer`] (which embeds new chunks at ingest
    /// time). Both sides MUST agree, otherwise the indexer would
    /// keep writing vectors under the old `model_id` even as the
    /// query side asks for the new one.
    ///
    /// `model_id` changes are handled transparently by
    /// `chunk_embeddings`'s `(chunk_id, model_id)` schema: vectors
    /// from the old model remain on disk (so a user who switches
    /// back doesn't have to re-embed), and the search path filters
    /// to the current model's vectors. Calling
    /// [`SourceManager::backfill_embeddings_tracked`] after a swap
    /// populates the new model's vectors in the background.
    pub fn set_embedder(&mut self, embedder: Option<Arc<dyn EmbeddingProvider>>) {
        self.indexer.set_embedder(embedder.clone());
        self.embedder = embedder;
    }

    /// Returns the `model_id` of the currently-attached embedder, or
    /// `None` if there is no embedder. Used by the bridge to
    /// answer `settings:getEmbeddingModelStatus` without having to
    /// snapshot every loaded model URL.
    pub fn current_embedder_model_id(&self) -> Option<String> {
        self.embedder.as_ref().map(|e| e.model_id().to_string())
    }

    /// forward to [`SourceStore::count_non_ascii_chunks`]
    /// for the Settings page's "consider the multilingual model"
    /// hint. Returns `(non_ascii_chunks, total_chunks)`.
    pub fn count_non_ascii_chunks(&self) -> Result<(u64, u64)> {
        self.store.count_non_ascii_chunks()
    }

    /// Backfill embeddings with a tracked progress snapshot exposed
    /// via `embedding_progress`. The renderer polls
    /// `bridge_get_embedding_progress` during the call and shows a
    /// determinate `embedded / total_chunks` bar.
    ///
    /// Semantics relative to `backfill_embeddings`:
    ///   * Same idempotence guarantees (`chunks_missing_embedding`
    ///     is the canonical work-set query).
    ///   * Same termination guarantees (per-session failure exclude
    ///     list + stall-detector backstop).
    ///   * Additionally seeds `total_chunks` *before* the embed loop
    ///     starts via a single `COUNT(*)` index-only scan, so the
    ///     denominator is visible to the renderer on the very first
    ///     poll instead of being unknown until the first batch lands.
    ///   * Flips status to `Done` on normal completion (including the
    ///     empty-corpus / no-embedder cases), `Failed` with a
    ///     stall-specific error message when the indexer reports a
    ///     stall ([`BackfillOutcome::Stalled`] — every chunk in a
    ///     batch failed, indicating the embedder is broken), and
    ///     `Failed` with the underlying error message on whole-pass
    ///     infrastructure failure (e.g. the DB connection died).
    ///
    ///   * Per-chunk failures continue to be non-fatal as long as
    ///     *some* chunks in the batch succeed — they only increment
    ///     the `failed` counter so the corpus's other chunks still
    ///     get embedded.
    pub fn backfill_embeddings_tracked(&self, batch_size: usize) -> Result<usize> {
        let Some(embedder) = &self.embedder else {
            // No embedder attached → nothing to do, but flip the
            // status so a renderer that polled while idle sees a
            // clean Done state rather than a stuck Running.
            let slot = self.embedding_progress.start(0, "none");
            finish_embedding(slot);
            return Ok(0);
        };
        let model_id = embedder.model_id().to_string();
        let total_chunks = self.store.count_chunks_missing_embedding(&model_id)?;
        let slot = self.embedding_progress.start(total_chunks, &model_id);
        match self
            .indexer
            .backfill_embeddings_with_progress(&self.store, batch_size, slot)
        {
            Ok(BackfillOutcome::Completed { embedded }) => {
                finish_embedding(slot);
                Ok(embedded)
            }
            Ok(BackfillOutcome::Stalled {
                embedded,
                stalled_batch_len,
            }) => {
                // The indexer's stall detector tripped — every chunk
                // in a single batch failed. Surface to the user as a
                // failure (with the partial-progress counters intact)
                // rather than a clean Done state with N silent
                // failures. The `embedded` count is still returned so
                // the bridge can echo the partial-progress number to
                // the renderer; the renderer reads `status=Failed`
                // plus `last_error` from the next progress poll and
                // renders the failure banner.
                let err_msg = format!(
                    "backfill stalled: every chunk in a {stalled_batch_len}-chunk batch failed to embed (embedder may be broken; check sidecar logs)"
                );
                mark_embedding_failed(slot, &err_msg);
                Ok(embedded)
            }
            Err(e) => {
                mark_embedding_failed(slot, &e.to_string());
                Err(e)
            }
        }
    }

    /// Returns the latest indexing progress snapshot for a source.
    /// Idle by default if no index pass has been observed.
    pub fn indexing_progress(&self, source_id: &SourceId) -> ProgressSnapshot {
        self.progress.snapshot(source_id)
    }

    /// Returns the latest embedding-backfill progress snapshot. Idle
    /// by default if no backfill pass has been observed since the
    /// bridge process came up.
    pub fn embedding_progress(&self) -> EmbeddingProgressSnapshot {
        self.embedding_progress.snapshot()
    }

    /// Returns a clone of the shared `Arc<EmbeddingProgressTracker>`
    /// so callers (most importantly the napi bridge) can read progress
    /// snapshots WITHOUT having to acquire the outer `SourceManager`
    /// mutex. This matters during a worker-thread backfill: the
    /// backfill itself holds the `SourceManager` lock for the duration
    /// of its DB writes, and a progress poll that also tried to lock
    /// the manager would queue up behind the backfill and never get
    /// to read the in-progress counters.
    ///
    /// The tracker has its own internal `Mutex` so concurrent readers
    /// only briefly contend with the worker thread's `record_*` calls.
    /// In practice that means progress polls return in microseconds
    /// regardless of how much work the backfill is doing.
    pub fn embedding_progress_handle(&self) -> Arc<EmbeddingProgressTracker> {
        Arc::clone(&self.embedding_progress)
    }

    /// Registers a local folder as a source and returns the created
    /// [`Source`] (does not index it yet).
    pub fn add_local_folder(&self, path: &str) -> Result<Source> {
        let folder_path = Path::new(path);
        if !folder_path.is_dir() {
            return Err(Error::InvalidPath(folder_path.to_path_buf()));
        }

        let source = Source::new_local_folder(path.to_string());
        self.store.add_source(&source)?;
        self.indexer
            .index_folder(&source.id, folder_path, &self.store)?;

        self.store.get_source(&source.id)
    }

    /// Registers a single local file as a source and returns the
    /// created [`Source`] (does not index it yet).
    pub fn add_local_file(&self, path: &str) -> Result<Source> {
        let file_path = Path::new(path);
        if !file_path.is_file() {
            return Err(Error::InvalidPath(file_path.to_path_buf()));
        }

        let source = Source::new_local_file(path.to_string());
        self.store.add_source(&source)?;
        self.indexer
            .index_single_file(&source.id, file_path, &self.store)?;

        let file_count = self.store.file_count_for_source(&source.id)?;
        self.store.update_source_status(
            &source.id,
            tessera_core::SourceStatus::Indexed,
            Some(file_count),
        )?;

        self.store.get_source(&source.id)
    }

    /// Register-or-reindex a KChat-channel source backed by an on-disk
    /// cache directory. The Node-side KChat client owns downloading
    /// the channel's files into `cache_dir`; this call wires the
    /// directory through the normal local-folder indexing pipeline
    /// (text extraction, chunking, embeddings, FTS5).
    ///
    /// **Idempotent on `cache_dir`.** The Node-side
    /// `sources:addKchatChannel` handler is invoked once per channel
    /// sync — first on add and again on every re-sync. An earlier
    /// implementation always inserted a fresh `Source` row with a
    /// new `SourceId`, so every re-sync produced a duplicate entry
    /// in the sources table (one per sync), unbounded source-table
    /// growth, and duplicate indexing of the same `cache_dir`.
    /// This method now queries for an existing `SourceType::Kchat`
    /// row with the same `path` and, when found, reindexes that
    /// source in place rather than inserting a new one. The
    /// `newly_created` flag in the return value lets callers gate
    /// "channel linked" audit events to the first-sync path only —
    /// re-syncs do not emit a fresh "linked" event.
    ///
    /// `cache_dir` must already exist on disk — the Node side
    /// creates it on first sync. We reject non-existent or
    /// non-directory paths up-front so a misconfigured channel does
    /// not silently add an empty, un-indexable source.
    pub fn add_kchat_channel(&self, cache_dir: &str) -> Result<KchatChannelAddOutcome> {
        let dir_path = Path::new(cache_dir);
        if !dir_path.is_dir() {
            return Err(Error::InvalidPath(dir_path.to_path_buf()));
        }

        // Look for an existing KChat source pointing at the same
        // cache_dir. We do an exact string match on `path` because
        // the Node side always constructs `cacheDir` deterministically
        // (kchatCacheDirFor(channelId) → `<root>/<channelId>`), so two
        // calls for the same channel pass the same `path`. We do NOT
        // canonicalise (e.g. via `Path::canonicalize`) because doing
        // so would change behaviour on systems where the cache dir
        // is reachable via multiple paths (symlinks, network mounts);
        // the Node side is the single source of truth for cache
        // location.
        //
        // Tenth-pass: a previous version
        // of this method did `list_sources().into_iter().find(...)`
        // which loaded every connector's sources off disk and
        // scanned them in-process. With hundreds of mixed-connector
        // sources the linear scan dominated the cost of every
        // channel re-sync. We now delegate to a dedicated
        // `find_source_by_type_and_path` query that is backed by the
        // composite `idx_sources_type_path` index (O(log n)) and
        // does not allocate on the not-found path.
        if let Some(existing) = self
            .store
            .find_source_by_type_and_path(&tessera_core::SourceType::Kchat, cache_dir)?
        {
            // Reindex in place to pick up files the Node side has
            // just downloaded since the last sync. Reusing the
            // existing SourceId keeps citations, evidence-pack
            // references, and any other persisted source-id pointers
            // valid across re-syncs.
            self.indexer
                .index_folder(&existing.id, dir_path, &self.store)?;
            let refreshed = self.store.get_source(&existing.id)?;
            return Ok(KchatChannelAddOutcome {
                source: refreshed,
                newly_created: false,
            });
        }

        let source = Source::new_kchat_channel(cache_dir.to_string());
        self.store.add_source(&source)?;
        self.indexer
            .index_folder(&source.id, dir_path, &self.store)?;

        let refreshed = self.store.get_source(&source.id)?;
        Ok(KchatChannelAddOutcome {
            source: refreshed,
            newly_created: true,
        })
    }

    /// Returns whether a `SourceType::Kchat` source exists with the
    /// given `cache_dir` registered as its `path`.
    ///
    /// The Block B Task 2 WS forwarder calls this on every
    /// `file_added` event to decide whether to bother downloading
    /// the new file's bytes: a channel that has never been linked
    /// as a source (or has since been unlinked) should not trigger
    /// disk I/O on the next push. The lookup is backed by the same
    /// composite `idx_sources_type_path` index that
    /// [`SourceManager::add_kchat_channel`] uses (O(log n) on the
    /// row count, no allocation on the not-found path).
    pub fn is_kchat_channel_linked(&self, cache_dir: &str) -> Result<bool> {
        Ok(self
            .store
            .find_source_by_type_and_path(&tessera_core::SourceType::Kchat, cache_dir)?
            .is_some())
    }

    /// Targeted single-file index for a KChat-channel source.
    ///
    /// The Block B Task 2 WebSocket forwarder calls this after
    /// downloading the new file's bytes into the channel cache
    /// directory so the indexer picks it up *immediately* instead
    /// of waiting for the next 30 s reconciliation poll to invoke
    /// the full `add_kchat_channel` walk. Re-walking the entire
    /// directory on every `file_added` push would cost
    /// O(files-in-channel) hash reads per event — fine for a
    /// channel with 10 files, but a busy 5,000-file channel under
    /// a burst of 10 simultaneous uploads would issue 50,000 hash
    /// reads. The single-file path is O(1).
    ///
    /// Returns:
    ///   - `Ok(None)` — no `SourceType::Kchat` row exists for
    ///     `cache_dir`. The caller should skip indexing entirely
    ///     and record `triggered_reindex = false`.
    ///   - `Ok(Some((source_id, outcome)))` — the source exists.
    ///     `outcome.indexed` is `true` when the file was newly
    ///     indexed (or re-indexed because its content hash
    ///     changed), `false` when the existing hash matched (a
    ///     no-op skip — the WS event arrived for a file we'd
    ///     already indexed via a prior full sync).
    ///
    /// Containment: `file_basename` is treated as untrusted and
    /// MUST resolve to a path that lives strictly inside
    /// `cache_dir`. `Path::join` accepts absolute paths
    /// (overwriting the parent) and would otherwise let a
    /// malicious server-supplied name like `/etc/passwd` escape
    /// the cache root. The check rejects empty / `.` / `..` /
    /// path-separator-containing basenames up-front, and after
    /// joining re-validates with a prefix check on the
    /// canonicalised parent so a symlink under the cache dir
    /// cannot escape either. The Node-side syncer applies the
    /// same belt-and-braces check before writing, so this is
    /// defence-in-depth for the substrate boundary.
    pub fn index_kchat_file(
        &self,
        cache_dir: &str,
        file_basename: &str,
    ) -> Result<Option<(SourceId, crate::indexer::IndexFileOutcome)>> {
        // Reject names that don't behave like a single basename.
        // `path::Path::file_name()` returns `None` for `.` / `..`
        // / paths ending in a separator, but we also need to
        // refuse names containing any path separator (so a
        // server-supplied `subdir/file.txt` cannot drill into a
        // subdirectory of the cache that the indexer would walk
        // separately). The Node side ALSO sanitises with
        // `path.basename(...)`, but accepting a richer name here
        // would silently widen the surface a future refactor of
        // the Node sanitiser could break.
        if file_basename.is_empty()
            || file_basename == "."
            || file_basename == ".."
            || file_basename.contains('/')
            || file_basename.contains('\\')
            || file_basename.contains('\0')
        {
            return Err(Error::InvalidPath(Path::new(file_basename).to_path_buf()));
        }

        let Some(source) = self
            .store
            .find_source_by_type_and_path(&tessera_core::SourceType::Kchat, cache_dir)?
        else {
            return Ok(None);
        };

        let cache_path = Path::new(cache_dir);
        let target = cache_path.join(file_basename);

        // Defence-in-depth containment: the joined path's parent
        // (after stripping the basename) must equal cache_dir.
        // We compare the canonical parent rather than the raw
        // `cache_path` so a symlink under cache_dir that resolves
        // out doesn't pass the check. Falling back to a
        // string-prefix check when canonicalisation fails (e.g.
        // because the cache_dir was removed between the lookup
        // and this call) keeps the reject-by-default behaviour.
        let canonical_parent = std::fs::canonicalize(cache_path).ok();
        let canonical_target = std::fs::canonicalize(&target).ok();
        if let (Some(parent), Some(t)) = (&canonical_parent, &canonical_target) {
            let parent_with_sep = {
                let mut s = parent.as_os_str().to_owned();
                s.push(std::path::MAIN_SEPARATOR.to_string());
                s
            };
            if !t
                .as_os_str()
                .to_string_lossy()
                .starts_with(&*parent_with_sep.to_string_lossy())
            {
                return Err(Error::InvalidPath(target));
            }
        }
        // If either side failed to canonicalise, fall through —
        // the file may not exist yet (the caller wrote and
        // immediately reindexed under a tight race) or the
        // cache_dir vanished; the indexer will surface a richer
        // error below.

        let outcome = self
            .indexer
            .index_single_file(&source.id, &target, &self.store)?;
        Ok(Some((source.id, outcome)))
    }

    /// Set the locally-authenticated KChat principal user id.
    ///
    /// Called by the Node-side `kchat:connect` IPC handler after
    /// the `/users/me` probe succeeds. The substrate persists the
    /// id in a singleton `kchat_principal` row so subsequent
    /// `refresh_kchat_acl` calls can check membership without
    /// re-threading the id through every event.
    ///
    /// Block B Task 3.
    pub fn set_kchat_principal(&self, user_id: &str) -> Result<()> {
        self.store.set_kchat_principal(user_id)
    }

    /// Return the persisted KChat principal user id, if any.
    pub fn get_kchat_principal(&self) -> Result<Option<String>> {
        self.store.get_kchat_principal()
    }

    /// Clear the principal singleton on `kchat:disconnect`.
    pub fn clear_kchat_principal(&self) -> Result<()> {
        self.store.clear_kchat_principal()
    }

    /// Refresh the cached ACL roster for a KChat-channel source and
    /// project the result onto the source's status.
    ///
    /// The Node-side `KchatEventForwarder` calls this after every
    /// membership-change WebSocket event (`user_added`,
    /// `user_removed`, `channel_updated`). `members` is the
    /// authoritative roster fetched from `GET /channels/{id}/members`
    /// — the substrate does NOT validate it against the KChat
    /// server, it trusts the Node-side validator (which already
    /// runs `assertKchatServerObjectId` on each member). The
    /// roster replaces any previously-cached rows atomically.
    ///
    /// Status projection rules :
    ///
    /// - If the locally-authenticated principal is in `members`
    ///   AND the source was `AccessRevoked`, transition to
    ///   `Connected` (re-grant) and return
    ///   `KchatAclRefreshOutcome::Regranted`. Block B Task 4
    ///   landed `cryptoshred_kchat_source_evidence` on the revoke
    ///   path, so a previously-revoked source has zero indexed
    ///   content; the Node-side forwarder reads `Regranted` as a
    ///   signal to schedule a full channel re-sync via
    ///   `setKchatChannelResyncImpl` (wired in
    ///   `apps/desktop/electron/ipc/kchat.ts`), after which the
    ///   indexer promotes the status to `Indexing` → `Indexed` on
    ///   its own.
    /// - If the principal is in `members` AND the source is in
    ///   any other state, leave the status alone (the indexer
    ///   may be mid-run, the source may legitimately be in
    ///   `Error`, etc.). The roster is still replaced.
    /// - If the principal is NOT in `members`, transition to
    ///   `AccessRevoked`. Retrieval queries (`search_fts`,
    ///   `load_embeddings_for_model`, `fetch_chunks_by_ids`)
    ///   will start filtering the source's chunks out
    ///   immediately on the next call.
    /// - If no `kchat_principal` is set, return `NoPrincipal`
    ///   without touching the source row. Membership refresh
    ///   races against connect/disconnect would otherwise flap
    ///   statuses during the brief window where the substrate
    ///   has not yet been told who the principal is.
    /// - If no `SourceType::Kchat` source exists for `cache_dir`,
    ///   return `Unlinked` — the channel was never linked as a
    ///   corpus source (or has since been unlinked).
    pub fn refresh_kchat_acl(
        &self,
        cache_dir: &str,
        members: &[KchatAclMember],
    ) -> Result<KchatAclRefreshOutcome> {
        let Some(principal) = self.store.get_kchat_principal()? else {
            return Ok(KchatAclRefreshOutcome::NoPrincipal);
        };

        let Some(source) = self
            .store
            .find_source_by_type_and_path(&tessera_core::SourceType::Kchat, cache_dir)?
        else {
            return Ok(KchatAclRefreshOutcome::Unlinked);
        };

        // Replace the ACL roster first so a concurrent retrieval
        // query that reaches the membership check sees the
        // refreshed roster regardless of which side of the status
        // transition it ran on. Roster replacement is a single
        // SQLite transaction (DELETE + INSERTs), so concurrent
        // readers see either the pre- or post-refresh state, never
        // an empty intermediate.
        let acl_rows: Vec<(String, String)> = members
            .iter()
            .map(|m| (m.user_id.clone(), m.role.clone()))
            .collect();
        self.store.replace_kchat_acl(&source.id, &acl_rows)?;

        let principal_present = members.iter().any(|m| m.user_id == principal);

        if !principal_present {
            if source.status != SourceStatus::AccessRevoked {
                self.store
                    .update_source_status(&source.id, SourceStatus::AccessRevoked, None)?;
            }
            // inline cryptoshred of
            // chunks / indexed_files + VACUUM under PRAGMA
            // secure_delete=ON. Runs unconditionally on the revoke
            // path (idempotent — drops zero rows if the source was
            // already scrubbed) so this also backfills sources that
            // were soft-revoked under Task 3 before this step
            // landed.
            let shred = self.store.cryptoshred_kchat_source_evidence(&source.id)?;
            // Block C Task 2 — pair the on-disk DEK
            // deletion that `cryptoshred_kchat_source_evidence`
            // already issued with an in-memory cache eviction so the
            // process can no longer decrypt previously-sealed
            // AEAD bytes even from RAM. `forget_dek` is idempotent
            // (no-op if the source never ingested a chat post and
            // therefore was never cached).
            self.kchat_crypto.forget_dek(&source.id);
            return Ok(KchatAclRefreshOutcome::Revoked {
                chunks_dropped: shred.chunks_dropped,
                files_dropped: shred.files_dropped,
                posts_dropped: shred.posts_dropped,
                dek_dropped: shred.dek_dropped,
                vacuum_succeeded: shred.vacuum_succeeded,
                vacuum_error: shred.vacuum_error,
            });
        }

        if source.status == SourceStatus::AccessRevoked {
            // Principal was re-added after a previous revoke.
            // because the revoke path
            // now cryptoshreds every chunk + indexed_file row
            // (`cryptoshred_kchat_source_evidence`), the source
            // has zero indexed content even though it was
            // previously `Indexed`. Transitioning straight back
            // to `Indexed` would leave the source-detail UI
            // claiming the channel is searchable while every
            // query returns nothing — a confusing dead-end for
            // the operator.
            //
            // Instead, transition to `Connected` (the natural
            // "ACL is OK, no content indexed yet" status). The
            // Node-side forwarder treats
            // `KchatAclRefreshOutcome::Regranted` as a signal to
            // schedule a full channel re-sync via the
            // `setKchatChannelResyncImpl` slot populated by
            // `registerKchatHandlers` in
            // `apps/desktop/electron/ipc/kchat.ts`, after which
            // the indexer promotes the status to `Indexing` and
            // then `Indexed` on its own — the same flow used for
            // a freshly-linked channel. Retrieval continues to
            // exclude `Connected` sources (only `Indexed` rows
            // surface) so there is no stale-data window.
            self.store
                .update_source_status(&source.id, SourceStatus::Connected, None)?;
            return Ok(KchatAclRefreshOutcome::Regranted);
        }

        Ok(KchatAclRefreshOutcome::Granted)
    }

    /// Explicitly revoke a KChat-channel source.
    ///
    /// Called by the Node-side forwarder on `channel_archived` /
    /// `channel_deleted` / self-`user_removed` events — cases
    /// where there is no member-list to fetch (the channel is
    /// gone) but the source must still be soft-deleted from
    /// retrieval. The ACL roster is left intact for forensics —
    /// "who else had access at the moment of revocation" is a
    /// real question operators ask.
    ///
    /// Block B Task 3.
    pub fn revoke_kchat_source(&self, cache_dir: &str) -> Result<KchatRevokeOutcome> {
        let Some(source) = self
            .store
            .find_source_by_type_and_path(&tessera_core::SourceType::Kchat, cache_dir)?
        else {
            return Ok(KchatRevokeOutcome::Unlinked);
        };

        let was_already_revoked = source.status == SourceStatus::AccessRevoked;

        if !was_already_revoked {
            self.store
                .update_source_status(&source.id, SourceStatus::AccessRevoked, None)?;
        }

        // cryptoshred runs on BOTH paths
        // — the first revoke transitions status and scrubs evidence;
        // a re-revoke (AlreadyRevoked) still calls shred so the
        // operation is idempotent at the evidence layer AND serves
        // as a one-time backfill for sources soft-revoked under the
        // Task 3 build. The shred call is O(rows-deleted) and runs
        // a VACUUM after, which is cheap when there is nothing to
        // free; we pay it intentionally to keep the contract simple.
        let shred = self.store.cryptoshred_kchat_source_evidence(&source.id)?;
        // Block C Task 2 — pair the on-disk DEK
        // deletion with an in-memory cache eviction. See the
        // matching block in `refresh_kchat_acl` for rationale.
        self.kchat_crypto.forget_dek(&source.id);

        let chunks_dropped = shred.chunks_dropped;
        let files_dropped = shred.files_dropped;
        let posts_dropped = shred.posts_dropped;
        let dek_dropped = shred.dek_dropped;
        let vacuum_succeeded = shred.vacuum_succeeded;
        let vacuum_error = shred.vacuum_error;

        Ok(if was_already_revoked {
            KchatRevokeOutcome::AlreadyRevoked {
                chunks_dropped,
                files_dropped,
                posts_dropped,
                dek_dropped,
                vacuum_succeeded,
                vacuum_error,
            }
        } else {
            KchatRevokeOutcome::Revoked {
                chunks_dropped,
                files_dropped,
                posts_dropped,
                dek_dropped,
                vacuum_succeeded,
                vacuum_error,
            }
        })
    }

    /// ingest a KChat post body into the
    /// substrate.
    ///
    /// Called by the Node-side `KchatEventForwarder` on a `posted`
    /// WS event after the forwarder has serialised the event with
    /// `withChannelSyncLock` and confirmed the source is not
    /// `AccessRevoked`. The substrate:
    ///
    /// 1. Looks up the source by `cache_dir` (the channel id); if
    ///    none, returns [`KchatPostIngestOutcome::Unlinked`] so the
    ///    forwarder can no-op.
    /// 2. Refuses to ingest into an `AccessRevoked` source (defence
    ///    in depth — the forwarder already filters but a race could
    ///    deliver an event after revocation).
    /// 3. Chunks the post body with the same [`chunk_text`] used for
    ///    file ingestion so retrieval-quality is consistent.
    /// 4. Ensures a per-source DEK exists (generating + wrapping +
    ///    persisting one on the first post for the source).
    /// 5. AEAD-seals each chunk with the per-source DEK + a 12-byte
    ///    random nonce + source_id-bound AAD.
    /// 6. Inserts both the plaintext (for FTS5) AND the
    ///    AEAD-ciphertext blobs into the chunks table.
    /// 7. Records the post_id → indexed_file_id mapping for fast
    ///    edit / delete in the future.
    ///
    /// Idempotency: a repeated `posted` event for an unchanged post
    /// returns [`KchatPostIngestOutcome::Unchanged`] without
    /// touching the chunks. A re-delivery whose body hash changed
    /// is treated as an edit (the chunks are re-extracted) — this
    /// mirrors the KChat server's actual behaviour: an "edit" can
    /// arrive as either a `post_edited` event OR a `posted` event
    /// with a fresh body and the same id, depending on the
    /// reconnect path.
    ///
    /// [`chunk_text`]: crate::chunker::chunk_text
    pub fn ingest_kchat_post(
        &self,
        input: &KchatPostIngestInput,
    ) -> Result<KchatPostIngestOutcome> {
        // 1. Look up the source row.
        let Some(source) = self
            .store
            .find_source_by_type_and_path(&tessera_core::SourceType::Kchat, &input.cache_dir)?
        else {
            return Ok(KchatPostIngestOutcome::Unlinked);
        };

        // 2. Refuse on revoked sources. The forwarder also gates this
        //    but a race between an event-arrival and a revocation
        //    could still slip through; this is the cryptographic
        //    backstop.
        if source.status == SourceStatus::AccessRevoked {
            return Ok(KchatPostIngestOutcome::AccessRevoked);
        }

        // 3. Compute the message hash (for dedupe) + chunk the body.
        let body_trimmed = input.body.trim();
        if body_trimmed.is_empty() {
            // A post with no body (e.g. an attachment-only message)
            // has nothing to chunk into FTS. We still record the
            // bookkeeping row so a later edit that adds text takes
            // the edit path; but we do NOT generate a DEK for an
            // empty body, which keeps the test-roster cleaner.
            return self.ingest_kchat_post_empty_body(&source, input);
        }

        let new_hash = blake3::hash(body_trimmed.as_bytes()).to_hex().to_string();

        // 4. If we already have a row for (source, post_id) with the
        //    same hash, this is a duplicate delivery — no-op.
        if let Some((existing_indexed_file_id, existing_hash)) =
            self.store.find_kchat_post(&source.id, &input.post_id)?
        {
            if existing_hash == new_hash {
                let chunks_in_index = self
                    .store
                    .count_chunks_for_indexed_file(existing_indexed_file_id)?;
                return Ok(KchatPostIngestOutcome::Unchanged {
                    source_id: source.id,
                    indexed_file_id: existing_indexed_file_id,
                    chunk_count: chunks_in_index,
                });
            }
            // 4b. Hash changed → treat as edit. Delete the existing
            //     chunks; the bookkeeping row is overwritten by
            //     `insert_kchat_post_bookkeeping`.
            self.store
                .delete_chunks_for_indexed_file(existing_indexed_file_id)?;
        }

        // 5. Ensure a per-source DEK is loaded into the crypto cache.
        self.ensure_dek_loaded(&source.id)?;

        // 6. Chunk + seal.
        let synthetic_path = format!("kchat:post:{}", input.post_id);
        let chunks = crate::chunker::chunk_text(
            &synthetic_path,
            body_trimmed,
            &crate::chunker::ChunkerConfig::default(),
        );
        let sealed = self.seal_chunks(&source.id, &chunks)?;

        // 7. Insert bookkeeping + chunk rows.
        let indexed_file_id = self.store.insert_kchat_post_bookkeeping(
            &source.id,
            &input.post_id,
            &input.channel_id,
            input.root_id.as_deref(),
            &input.sender_user_id,
            &new_hash,
            input.created_at_ms,
            input.edited_at_ms,
        )?;
        let ids = self
            .store
            .insert_kchat_post_chunks(indexed_file_id, &chunks, &sealed)?;

        Ok(KchatPostIngestOutcome::Ingested {
            source_id: source.id,
            indexed_file_id,
            chunk_ids: ids,
            sealed_count: u32::try_from(chunks.len()).unwrap_or(u32::MAX),
        })
    }

    fn ingest_kchat_post_empty_body(
        &self,
        source: &Source,
        input: &KchatPostIngestInput,
    ) -> Result<KchatPostIngestOutcome> {
        // The empty-body path still records the post bookkeeping so
        // a future edit that adds content can be discovered by
        // `find_kchat_post`. Hash is the BLAKE3 of the empty string
        // — distinct from any non-empty body so a follow-on edit
        // is correctly detected as "changed".
        let empty_hash = blake3::hash(b"").to_hex().to_string();
        if let Some((existing_indexed_file_id, existing_hash)) =
            self.store.find_kchat_post(&source.id, &input.post_id)?
        {
            if existing_hash == empty_hash {
                return Ok(KchatPostIngestOutcome::Unchanged {
                    source_id: source.id,
                    indexed_file_id: existing_indexed_file_id,
                    chunk_count: 0,
                });
            }
            self.store
                .delete_chunks_for_indexed_file(existing_indexed_file_id)?;
        }
        let indexed_file_id = self.store.insert_kchat_post_bookkeeping(
            &source.id,
            &input.post_id,
            &input.channel_id,
            input.root_id.as_deref(),
            &input.sender_user_id,
            &empty_hash,
            input.created_at_ms,
            input.edited_at_ms,
        )?;
        Ok(KchatPostIngestOutcome::Ingested {
            source_id: source.id,
            indexed_file_id,
            chunk_ids: Vec::new(),
            sealed_count: 0,
        })
    }

    /// handle a `post_edited` WS event.
    ///
    /// Delegates to [`Self::ingest_kchat_post`] — the ingest path's
    /// hash-comparison branch already covers the "same id, new
    /// body" case correctly. Kept as a separate public function so
    /// the bridge / forwarder can emit a distinct audit row even
    /// when the substrate ends up taking the same code path.
    pub fn edit_kchat_post(&self, input: &KchatPostIngestInput) -> Result<KchatPostIngestOutcome> {
        self.ingest_kchat_post(input)
    }

    /// handle a `post_deleted` WS event.
    ///
    /// Deletes the chunks and the bookkeeping row for the post.
    /// The DEK stays in place — other posts on the source may still
    /// need it; the per-source DEK is only retired on revoke
    /// (`cryptoshred_kchat_source_evidence`).
    pub fn delete_kchat_post(
        &self,
        cache_dir: &str,
        post_id: &str,
    ) -> Result<KchatPostDeleteOutcome> {
        let Some(source) = self
            .store
            .find_source_by_type_and_path(&tessera_core::SourceType::Kchat, cache_dir)?
        else {
            return Ok(KchatPostDeleteOutcome::Unlinked);
        };
        if source.status == SourceStatus::AccessRevoked {
            return Ok(KchatPostDeleteOutcome::AccessRevoked);
        }
        let Some((indexed_file_id, _hash)) = self.store.find_kchat_post(&source.id, post_id)?
        else {
            return Ok(KchatPostDeleteOutcome::NotFound {
                source_id: source.id,
            });
        };
        let chunks_dropped = self.store.delete_chunks_for_indexed_file(indexed_file_id)?;
        self.store
            .delete_kchat_post_bookkeeping(&source.id, post_id, indexed_file_id)?;
        Ok(KchatPostDeleteOutcome::Deleted {
            source_id: source.id,
            chunks_dropped,
        })
    }

    /// read the persisted backfill state
    /// for a KChat channel.
    ///
    /// Returns `Ok(KchatBackfillState::Unlinked)` when no source
    /// row exists for `cache_dir`; the caller (orchestrator) treats
    /// that the same as `Idle { complete: false, oldest_post_id:
    /// None }` because there's nothing to walk yet.
    pub fn kchat_backfill_state(&self, cache_dir: &str) -> Result<KchatBackfillState> {
        let Some(source) = self
            .store
            .find_source_by_type_and_path(&tessera_core::SourceType::Kchat, cache_dir)?
        else {
            return Ok(KchatBackfillState::Unlinked);
        };
        if source.status == SourceStatus::AccessRevoked {
            return Ok(KchatBackfillState::AccessRevoked {
                source_id: source.id,
            });
        }
        let row = self.store.kchat_backfill_state(&source.id)?;
        let (oldest_post_id, completed_at) = row.unwrap_or((None, None));
        Ok(KchatBackfillState::Idle {
            source_id: source.id,
            oldest_post_id,
            completed_at,
        })
    }

    /// ingest one page of historical
    /// KChat posts as part of the backfill walk.
    ///
    /// Each post in the page flows through the same
    /// [`SourceManager::ingest_kchat_post`] path as a live `posted`
    /// WS event, so the dedupe / DEK-seal / chunk insertion /
    /// FTS5-index / audit-bookkeeping pipeline is shared. The page
    /// is processed in REST-returned order (newest-first), which
    /// matters because the cursor we persist after the page is the
    /// OLDEST post id in the page (the `prev_post_id` boundary the
    /// next page will use as its `before=` cursor).
    ///
    /// **Idempotency**. A re-delivery of the same posts (e.g. the
    /// orchestrator resumed from a slightly-stale cursor on app
    /// restart) flows through the `find_kchat_post` dedupe in
    /// `ingest_kchat_post` so re-runs cost only a hash lookup per
    /// already-ingested post; no double-chunking, no double-FTS5
    /// inserts, no double-audit-bookkeeping.
    ///
    /// **Mid-walk revocation**. If the source flips to
    /// `AccessRevoked` between pages (e.g. the WS forwarder
    /// processed a `channel_member_removed` event in parallel),
    /// the per-post ingest returns `AccessRevoked` for every row,
    /// the page outcome carries `posts_skipped_revoked == page.len()`
    /// + `final_status = AccessRevoked`, and the orchestrator stops
    ///   the walk. The cursor is NOT advanced because the substrate
    ///   did not actually durably ingest anything from this page.
    ///
    /// **Cursor advancement**. The cursor is advanced to the
    /// oldest post id in the page (`page.last().post_id`) when at
    /// least one post in the page reached `Ingested` or `Unchanged`
    /// (i.e. the post is durably present in `kchat_posts` for this
    /// source). This guarantees the orchestrator never skips a
    /// page on resume — the next `before=` value points at a row
    /// the substrate has acknowledged.
    pub fn ingest_kchat_backfill_page(
        &self,
        cache_dir: &str,
        page: &[KchatPostIngestInput],
    ) -> Result<KchatBackfillIngestOutcome> {
        let Some(source) = self
            .store
            .find_source_by_type_and_path(&tessera_core::SourceType::Kchat, cache_dir)?
        else {
            return Ok(KchatBackfillIngestOutcome::Unlinked);
        };
        if source.status == SourceStatus::AccessRevoked {
            return Ok(KchatBackfillIngestOutcome::AccessRevoked {
                source_id: source.id,
            });
        }
        if page.is_empty() {
            // An empty page is the orchestrator's signal that the
            // walk reached the end of channel history. We do NOT
            // mark complete here — the orchestrator calls
            // `mark_kchat_backfill_complete` explicitly after
            // observing `prev_post_id == null` on the REST page,
            // so the substrate has a single linearizable point of
            // commitment and the audit row reflects "completed
            // walk" rather than "ingested zero posts".
            return Ok(KchatBackfillIngestOutcome::Ingested {
                source_id: source.id,
                posts_ingested: 0,
                posts_unchanged: 0,
                posts_skipped_revoked: 0,
                oldest_post_id_in_page: None,
            });
        }

        let mut posts_ingested = 0u32;
        let mut posts_unchanged = 0u32;
        let posts_skipped_revoked = 0u32;
        let mut last_ingested_post_id: Option<String> = None;

        for input in page {
            let outcome = self.ingest_kchat_post(input)?;
            match outcome {
                KchatPostIngestOutcome::Ingested { .. } => {
                    posts_ingested += 1;
                    last_ingested_post_id = Some(input.post_id.clone());
                }
                KchatPostIngestOutcome::Unchanged { .. } => {
                    posts_unchanged += 1;
                    last_ingested_post_id = Some(input.post_id.clone());
                }
                KchatPostIngestOutcome::AccessRevoked => {
                    // The source was revoked mid-walk. Stop
                    // processing the rest of the page; the
                    // orchestrator will compute "posts skipped due
                    // to revocation" as `page.len() -
                    // posts_ingested - posts_unchanged` from the
                    // outcome it already has access to.
                    return Ok(KchatBackfillIngestOutcome::AccessRevoked {
                        source_id: source.id,
                    });
                }
                KchatPostIngestOutcome::Unlinked => {
                    // Shouldn't happen — we already verified the
                    // source above and the manager holds the
                    // shared connection mutex across this call.
                    // Surface as a hard error so a future race
                    // condition does NOT silently drop posts.
                    return Err(Error::DatabaseState(format!(
                        "ingest_kchat_backfill_page: source disappeared mid-walk for cache_dir={cache_dir}"
                    )));
                }
            }
        }

        // Advance the cursor to the oldest post id in the page. KChat
        // returns pages newest-first, so the LAST element of `page`
        // is the oldest — that's the value we want to use as the
        // `before=` cursor for the next REST page fetch (which will
        // return strictly older posts).
        let oldest_post_id_in_page = page.last().map(|p| p.post_id.clone());
        if let Some(cursor) = oldest_post_id_in_page.as_deref() {
            // Only advance the cursor when at least one post on
            // the page was durably acknowledged by the substrate
            // (Ingested OR Unchanged). The Unlinked branch above
            // early-returns so we don't reach here with zero
            // acknowledged rows in practice, but the explicit
            // guard makes the invariant local and audit-friendly.
            if last_ingested_post_id.is_some() {
                self.store.set_kchat_backfill_cursor(&source.id, cursor)?;
            }
        }

        Ok(KchatBackfillIngestOutcome::Ingested {
            source_id: source.id,
            posts_ingested,
            posts_unchanged,
            posts_skipped_revoked,
            oldest_post_id_in_page,
        })
    }

    /// mark the backfill walk complete.
    ///
    /// Called by the orchestrator when the REST page returns
    /// `prev_post_id == null` (the server says "no posts older
    /// than the current cursor exist"). After this point a
    /// re-trigger of `runBackfillKchatChannel` short-circuits at
    /// `kchat_backfill_state`.
    pub fn mark_kchat_backfill_complete(
        &self,
        cache_dir: &str,
    ) -> Result<KchatBackfillCompletionOutcome> {
        let Some(source) = self
            .store
            .find_source_by_type_and_path(&tessera_core::SourceType::Kchat, cache_dir)?
        else {
            return Ok(KchatBackfillCompletionOutcome::Unlinked);
        };
        if source.status == SourceStatus::AccessRevoked {
            return Ok(KchatBackfillCompletionOutcome::AccessRevoked {
                source_id: source.id,
            });
        }
        self.store.mark_kchat_backfill_complete(&source.id)?;
        Ok(KchatBackfillCompletionOutcome::Completed {
            source_id: source.id,
        })
    }

    /// Load the persisted DEK for `source_id` into the crypto
    /// cache, generating + persisting one if missing. Returns
    /// `Ok(())` when the cache contains an unwrapped DEK for the
    /// source after the call.
    fn ensure_dek_loaded(&self, source_id: &SourceId) -> Result<()> {
        // Fast path: the DEK is already unwrapped in the in-memory cache, so
        // skip the DB read + KEK derivation + AEAD unwrap. Repeated ingests
        // for the same source (the common case) hit this branch.
        if self.kchat_crypto.has_dek(source_id) {
            return Ok(());
        }
        if let Some(wrapped) = self.store.load_wrapped_dek_for_source(source_id)? {
            self.kchat_crypto.unwrap_dek(source_id, &wrapped)?;
            return Ok(());
        }
        let wrapped = self.kchat_crypto.generate_and_wrap_dek(source_id)?;
        self.store.upsert_wrapped_dek(source_id, &wrapped)?;
        Ok(())
    }

    /// AEAD-seal each chunk under the per-source DEK already
    /// loaded into the crypto cache. Panics (programmer error) if
    /// the DEK is not loaded — call sites must invoke
    /// `ensure_dek_loaded` first.
    fn seal_chunks(
        &self,
        source_id: &SourceId,
        chunks: &[Chunk],
    ) -> Result<Vec<crate::kchat_crypto::SealedChunk>> {
        let mut sealed = Vec::with_capacity(chunks.len());
        for chunk in chunks {
            sealed.push(
                self.kchat_crypto
                    .seal_chunk(source_id, chunk.content.as_bytes())?,
            );
        }
        Ok(sealed)
    }

    /// Test-only: return a reference to the crypto facade so unit
    /// tests can verify cache invariants (e.g. `forget_dek` was
    /// invoked on revoke).
    #[cfg(test)]
    pub(crate) fn kchat_crypto(&self) -> &KchatCrypto {
        &self.kchat_crypto
    }

    /// Read the cached ACL roster for a KChat-channel source. Used
    /// by the renderer's source-detail surface + cargo tests.
    pub fn list_kchat_acl(&self, source_id: &SourceId) -> Result<Vec<crate::store::KchatAclRow>> {
        self.store.list_kchat_acl(source_id)
    }

    /// Removes a source and all of its indexed data.
    pub fn remove_source(&self, source_id: &SourceId) -> Result<()> {
        self.store.remove_source(source_id)
    }

    /// Returns every registered [`Source`].
    pub fn list_sources(&self) -> Result<Vec<Source>> {
        self.store.list_sources()
    }

    /// Fetches a single [`Source`] by id.
    pub fn get_source(&self, source_id: &SourceId) -> Result<Source> {
        self.store.get_source(source_id)
    }

    /// read the persisted sync-failure state for
    /// a source row. Pass-through to [`SourceStore::get_sync_failure_state`].
    /// Returns `Ok((None, 0, false))` when the row has never failed.
    pub fn get_sync_failure_state(
        &self,
        source_id: &SourceId,
    ) -> Result<(Option<String>, u32, bool)> {
        self.store.get_sync_failure_state(source_id)
    }

    /// stamp a failed sync attempt. Pass-through
    /// to [`SourceStore::record_sync_failure`]. The connectors
    /// layer (TS-side `runConnectorSync`) calls this via the napi
    /// bridge after classifying the error.
    pub fn record_sync_failure(
        &self,
        source_id: &SourceId,
        last_sync_error_json: &str,
        retry_count: u32,
        failed_permanently: bool,
    ) -> Result<()> {
        self.store.record_sync_failure(
            source_id,
            last_sync_error_json,
            retry_count,
            failed_permanently,
        )
    }

    /// clear failure state on a successful sync.
    /// Pass-through to [`SourceStore::record_sync_success`].
    pub fn record_sync_success(&self, source_id: &SourceId) -> Result<()> {
        self.store.record_sync_success(source_id)
    }

    /// Runs a strict (AND) hybrid search, returning up to `limit`
    /// ranked [`SearchResult`]s.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        // Clone the snapshot under the lock and drop the guard
        // before any I/O so concurrent `update_hybrid_config` calls
        // never block on a slow SQLite query, and an in-flight
        // search uses a coherent config even if the user toggles
        // hybrid-off mid-flight.
        let cfg = self
            .hybrid_config
            .lock()
            .expect("hybrid_config mutex poisoned")
            .clone();
        let engine = SearchEngine::hybrid(&self.store, self.embedder.as_deref(), cfg);
        engine.search(query, limit)
    }

    /// Runs a strict (AND) hybrid search with the knowledge-substrate
    /// retention signal fused in as a fourth RRF input.
    ///
    /// `retention_by_source` maps a Tessera source id to its live
    /// retention score (from
    /// `tessera_substrate::SubstrateManager::retention_by_source`); the
    /// bridge layer owns substrate access and threads the map in here.
    /// An empty map makes this identical to [`Self::search`], so the
    /// existing BM25 + vector + recency ranking is preserved when the
    /// substrate has no memories yet.
    pub fn search_with_retention(
        &self,
        query: &str,
        limit: usize,
        retention_by_source: std::collections::HashMap<String, f64>,
    ) -> Result<Vec<SearchResult>> {
        let cfg = self
            .hybrid_config
            .lock()
            .expect("hybrid_config mutex poisoned")
            .clone();
        let engine = SearchEngine::hybrid_with_retention(
            &self.store,
            self.embedder.as_deref(),
            cfg,
            retention_by_source,
        );
        engine.search(query, limit)
    }

    /// Runs a broader (OR) hybrid search, returning up to `limit`
    /// ranked [`SearchResult`]s.
    pub fn search_broad(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let cfg = self
            .hybrid_config
            .lock()
            .expect("hybrid_config mutex poisoned")
            .clone();
        let engine = SearchEngine::hybrid(&self.store, self.embedder.as_deref(), cfg);
        engine.search_broad(query, limit)
    }

    /// retrieve KChat post chunks that
    /// match `query`. The returned hits are the chat-body counterpart
    /// to [`SourceManager::search`] (which only surfaces file
    /// chunks).
    ///
    /// Pipeline:
    ///
    /// 1. The query is normalised via the same FTS5 sanitiser the
    ///    file-search path uses
    ///    (`crate::search::build_fts_query`) so a search like
    ///    `Q3 launch` becomes `"Q3" AND "launch"`. Empty / all-
    ///    stopword queries short-circuit to an empty result set
    ///    (no SQL round-trip).
    /// 2. The store-layer FTS5 join
    ///    ([`crate::store::SourceStore::search_kchat_posts_fts`])
    ///    handles the ACL gate (status != AccessRevoked), the
    ///    chunk-kind filter (`'chat_post'`), and the DEK-row
    ///    existence gate. Rows whose source no longer has a DEK
    ///    cannot reach us.
    /// 3. For each row this method first ensures the per-source
    ///    DEK is unwrappable (load-only, never generate). Then it
    ///    AEAD-opens `content_aead` and **compares the decrypted
    ///    plaintext to the `content` column** — a mismatch means
    ///    on-disk tampering (the `content` column has the
    ///    attacker's text but the AEAD-sealed copy doesn't), and
    ///    the hit is silently dropped. If the DEK exists in the
    ///    row but unwrap fails (KEK rotation, corrupted blob,
    ///    etc.) the hit is dropped and the source is marked as
    ///    "DEK broken" in the in-memory cache so subsequent rows
    ///    from the same source short-circuit without retrying.
    ///    Finally, a query-aware excerpt is built via the shared
    ///    helper so the excerpt formatting matches file-source
    ///    hits byte-for-byte (the renderer's RelevanceBadge +
    ///    excerpt component does not branch on hit kind).
    /// 4. The final relevance is the 1-based reciprocal rank of
    ///    the surviving hits — `1.0 / (i + 1.0)`. The same scheme
    ///    `crate::search::SearchEngine::search_with_mode` uses
    ///    for file hits, so a renderer that merges and re-sorts
    ///    file + post hits gets a consistent score axis without
    ///    having to know which kind produced each score.
    pub fn search_kchat_posts(&self, query: &str, limit: usize) -> Result<Vec<KchatPostSearchHit>> {
        let fts_query = crate::search::build_fts_query(query, true);
        if fts_query.is_empty() {
            return Ok(Vec::new());
        }
        // Fetch a larger pool than `limit` so AEAD-verification
        // drops (which should be rare — tamper / DEK-broken) do
        // not cause the returned vec to undershoot the caller's
        // limit. The factor of 2 is conservative — even a
        // 50%-tamper-rate corpus would still return `limit` hits.
        let pool = limit.saturating_mul(2).max(limit);
        let rows = self.store.search_kchat_posts_fts(&fts_query, pool)?;

        let mut verified: Vec<KchatPostSearchHit> = Vec::with_capacity(rows.len());
        // Cache the per-source result of `ensure_dek_loaded` so a
        // source whose unwrap fails once doesn't get retried for
        // every chunk in the page — DEK unwrap is the expensive
        // step in this pipeline (AES-GCM-256 init + decrypt).
        let mut dek_status: std::collections::HashMap<String, bool> =
            std::collections::HashMap::new();

        for row in rows {
            // The `chunks` table only contains rows we wrote, and
            // every write goes through `Source::id` which is a
            // `SourceId(Uuid)`. A parse failure here would mean
            // someone hand-edited the DB to insert an invalid id;
            // drop the hit rather than poison the whole search.
            let Ok(uuid) = uuid::Uuid::parse_str(&row.source_id) else {
                continue;
            };
            let source_id = SourceId(uuid);
            let dek_ok = if let Some(v) = dek_status.get(&row.source_id) {
                *v
            } else {
                // IMPORTANT: do NOT call `ensure_dek_loaded`
                // here — that path *generates and persists a
                // new DEK* if one does not already exist (the
                // ingest path's first-write-wins logic). A
                // cryptoshred that committed between the
                // store-layer FTS5 query and this call would
                // leave the DEK row deleted; if we generated a
                // fresh DEK here we would (a) resurrect crypto
                // material for a revoked source, and (b)
                // silently re-key a future re-grant so the old
                // AEAD chunks become unopenable — exactly the
                // integrity gap Block C Task 2 closed.
                // Load-only, never generate.
                let ok = match self.store.load_wrapped_dek_for_source(&source_id) {
                    Ok(Some(wrapped)) => self.kchat_crypto.unwrap_dek(&source_id, &wrapped).is_ok(),
                    _ => false,
                };
                dek_status.insert(row.source_id.clone(), ok);
                ok
            };
            if !dek_ok {
                continue;
            }

            // The store-layer query already restricted to
            // `kind = 'chat_post'`, which the ingest path always
            // pairs with `content_aead` + `content_aead_nonce`
            // BLOBs (see `SourceStore::insert_kchat_post_chunks`).
            // A row missing either column is a corrupted DB — drop
            // the hit rather than surfacing un-authenticated
            // plaintext.
            let (Some(ciphertext), Some(nonce)) =
                (row.content_aead.as_ref(), row.content_aead_nonce.as_ref())
            else {
                continue;
            };
            let sealed = crate::kchat_crypto::SealedChunk {
                nonce: nonce.clone(),
                ciphertext: ciphertext.clone(),
            };
            let Ok(opened) = self.kchat_crypto.open_chunk(&source_id, &sealed) else {
                continue;
            };
            // AEAD-verified plaintext MUST match the FTS5-indexed
            // `content` column. If they diverge, the disk-level
            // plaintext has been tampered with — the indexed
            // column says one thing, the authenticated ciphertext
            // says another. Drop the hit rather than choose a
            // side; the operator's audit trail (which would catch
            // a tampered DB on next backup) is the recovery path.
            let Ok(opened_str) = String::from_utf8(opened) else {
                continue;
            };
            if opened_str != row.content {
                continue;
            }

            let excerpt = crate::search::build_excerpt(&opened_str, query, 200);
            // 1-based reciprocal rank — `verified.len()` is the
            // 0-based index of the hit that's about to be pushed.
            let relevance = 1.0 / (verified.len() as f64 + 1.0);
            verified.push(KchatPostSearchHit {
                source_id,
                source_path: row.source_path,
                post_id: row.post_id,
                channel_id: row.channel_id,
                root_id: row.root_id,
                sender_user_id: row.sender_user_id,
                created_at_ms: row.created_at_ms,
                edited_at_ms: row.edited_at_ms,
                chunk_index: row.chunk_index,
                byte_offset: row.byte_offset,
                content: opened_str,
                excerpt,
                hash: row.hash,
                relevance,
            });
            if verified.len() >= limit {
                break;
            }
        }
        Ok(verified)
    }

    /// fetch up to 3 thread-context
    /// messages surrounding the post identified by `post_id`.
    ///
    /// Returns an empty vec — never an error — for any of the
    /// following non-error cases:
    ///
    /// 1. `post_id` is not known to this manager's store (e.g.
    ///    the post was cryptoshredded between the search and
    ///    this call, or the renderer is calling with a stale id).
    /// 2. `post_id` is a top-level post (`root_id IS NULL`);
    ///    there is no thread to surface. The renderer can
    ///    short-circuit further UI on an empty result.
    /// 3. The source's DEK is not loadable (cryptoshred-then-
    ///    re-grant happened mid-call, or the DB was tampered).
    ///    Same posture as [`Self::search_kchat_posts`] —
    ///    load-only, never generate; never re-key a revoked
    ///    source.
    ///
    /// The returned vec is ordered chronologically (oldest first)
    /// and capped at 3 messages: the thread root + up to 2
    /// most-recent earlier-replies. The cap mirrors the task spec
    /// ("up to 3 parent messages") and bounds the IPC payload —
    /// a longer transcript would dwarf the search hit itself.
    ///
    /// **Fail-quiet AEAD verification.** Each row is re-opened
    /// under the per-source DEK and the opened bytes are compared
    /// to the indexed `chunks.content` column. Any row whose
    /// ciphertext fails to open, or whose opened bytes diverge
    /// from the plaintext column, is dropped from the result. The
    /// renderer surfaces "partial thread context" by virtue of
    /// the vec being shorter than 3; it does not see a hard
    /// error. This mirrors the search-path posture so the user's
    /// experience is consistent across surfaces.
    ///
    /// **Why not error on tampered rows?** A tampered DB should
    /// not be detectable from the renderer's surface — the
    /// audit-log surface (which IS authenticated) is the
    /// recovery path. Surfacing a hard error here would let an
    /// attacker who tampered a single row block the user from
    /// seeing the honest siblings of that row.
    pub fn fetch_kchat_thread_context(
        &self,
        source_id: &SourceId,
        post_id: &str,
    ) -> Result<Vec<KchatThreadContextMessage>> {
        // 1. Look up the hit's `(channel_id, root_id,
        // created_at_ms)`. A row absent from the store is a
        // benign "stale renderer state" case — return empty.
        let Some((_channel_id, root_id_opt, hit_created_at_ms)) =
            self.store.find_kchat_post_metadata(source_id, post_id)?
        else {
            return Ok(Vec::new());
        };
        // 2. Top-level post — no parents to surface. The renderer
        // is expected to gate on `hit.root_id != null` before
        // calling this method, but the substrate validates
        // defence-in-depth so a buggy caller cannot drive a
        // self-referential lookup.
        let Some(root_post_id) = root_id_opt else {
            return Ok(Vec::new());
        };

        // 3. DEK gate — load-only, never generate (same posture
        // as `search_kchat_posts`). Cryptoshred-then-re-grant
        // between the search and this call is correctly
        // classified as "no thread context" rather than
        // "thread context with a fresh-DEK row that can't open
        // historical ciphertext".
        let dek_ready = matches!(
            self.store.load_wrapped_dek_for_source(source_id),
            Ok(Some(ref wrapped)) if self.kchat_crypto.unwrap_dek(source_id, wrapped).is_ok()
        );
        if !dek_ready {
            return Ok(Vec::new());
        }

        // 4. Fetch the raw rows. The substrate-side query caps
        // the result at 3 rows (root + ≤ 2 most-recent earlier
        // siblings) and orders chronologically.
        let rows = self.store.fetch_kchat_thread_context_rows(
            source_id,
            &root_post_id,
            hit_created_at_ms,
            3,
        )?;

        // 5. AEAD-verify each row; drop those that fail.
        let mut messages: Vec<KchatThreadContextMessage> = Vec::with_capacity(rows.len());
        for row in rows {
            // Same drop-rule as the search path: a row missing
            // either AEAD column is a corrupted DB (the ingest
            // path always pairs ciphertext + nonce). Drop rather
            // than surfacing un-authenticated plaintext.
            let (Some(ciphertext), Some(nonce)) =
                (row.content_aead.as_ref(), row.content_aead_nonce.as_ref())
            else {
                continue;
            };
            let sealed = crate::kchat_crypto::SealedChunk {
                nonce: nonce.clone(),
                ciphertext: ciphertext.clone(),
            };
            let Ok(opened) = self.kchat_crypto.open_chunk(source_id, &sealed) else {
                continue;
            };
            let Ok(opened_str) = String::from_utf8(opened) else {
                continue;
            };
            // Plaintext-divergence check — see search path
            // rationale (the FTS5 index would otherwise return a
            // chunk whose `content` was tampered to read one
            // thing while the AEAD authenticates as another).
            if opened_str != row.content {
                continue;
            }
            let is_root = row.post_id == root_post_id;
            messages.push(KchatThreadContextMessage {
                post_id: row.post_id,
                channel_id: row.channel_id,
                sender_user_id: row.sender_user_id,
                created_at_ms: row.created_at_ms,
                edited_at_ms: row.edited_at_ms,
                content: opened_str,
                is_root,
            });
        }

        Ok(messages)
    }

    /// Lists the [`IndexedFile`]s belonging to a source.
    pub fn list_indexed_files(&self, source_id: &SourceId) -> Result<Vec<IndexedFile>> {
        self.store.list_indexed_files(source_id)
    }

    /// Returns the on-disk content hash of `file_path` for staleness
    /// checks, or `None` if unreadable.
    pub fn get_current_file_hash(&self, file_path: &str) -> Result<Option<String>> {
        self.store.get_current_file_hash(file_path)
    }

    /// Returns a source together with its indexed files, for the
    /// source-detail view.
    pub fn get_detail(&self, source_id: &SourceId) -> Result<(Source, Vec<IndexedFile>)> {
        let source = self.store.get_source(source_id)?;
        let files = self.store.list_indexed_files(source_id)?;
        Ok((source, files))
    }

    /// Returns the plaintext content of every chunk belonging to a
    /// source.
    pub fn get_chunks_for_source(&self, source_id: &SourceId) -> Result<Vec<String>> {
        self.store.get_chunk_contents_for_source(source_id)
    }

    /// Re-runs indexing for a source, refreshing its chunks and
    /// embeddings.
    pub fn reindex_source(&self, source_id: &SourceId) -> Result<()> {
        let source = self.store.get_source(source_id)?;
        let path = Path::new(&source.path);

        // Always allocate a fresh progress slot — the UI polls
        // `bridge_get_indexing_progress` and expects `Running`
        // status during the call.
        let slot = self.progress.start(source_id);

        let outcome = match source.source_type {
            tessera_core::SourceType::LocalFolder | tessera_core::SourceType::Kchat => self
                .indexer
                .index_folder_with_progress(source_id, path, &self.store, Some(&slot))
                .map(|_| ()),
            tessera_core::SourceType::LocalFile => self
                .indexer
                .index_single_file(source_id, path, &self.store)
                .and_then(|_| self.store.file_count_for_source(source_id))
                .and_then(|file_count| {
                    self.store.update_source_status(
                        source_id,
                        tessera_core::SourceStatus::Indexed,
                        Some(file_count),
                    )?;
                    crate::progress::finish(&slot, file_count);
                    Ok(())
                }),
            _ => Ok(()),
        };

        if let Err(ref e) = outcome {
            crate::progress::mark_failed(&slot, &e.to_string());
        }
        outcome
    }
}

/// Construct the default hybrid retrieval pipeline used by every
/// `SourceManager` constructor.
///
/// The default uses [`HashTrickEmbedding::default_config()`] as the
/// embedder. This is the offline, zero-dependency option: it doesn't
/// need a running model server, doesn't make network calls, and
/// produces a meaningful vector signal for short queries / typos /
/// substring matches over the BM25 baseline.
///
/// Production deployments that want transformer-quality embeddings
/// can build their own `SourceManager` with `SourceStore` + `Indexer`
/// directly and pass in a different `EmbeddingProvider` (e.g. one
/// that calls llama-server's `/embedding` endpoint, or an external
/// API). The trait surface is stable across providers — the only
/// migration cost is re-embedding existing chunks because each
/// provider's `model_id` is distinct and cross-model cosines are
/// filtered out at query time.
fn build_default_hybrid_pipeline(
    ignore_patterns: &[String],
) -> (
    Indexer,
    Option<Arc<dyn EmbeddingProvider>>,
    HybridSearchConfig,
) {
    let embedder: Arc<dyn EmbeddingProvider> = Arc::new(HashTrickEmbedding::default_config());
    let indexer = Indexer::new(ignore_patterns).with_embedder(Arc::clone(&embedder));
    let hybrid_config = HybridSearchConfig::default();
    (indexer, Some(embedder), hybrid_config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manager_add_folder_and_search() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("readme.txt"),
            "Tessera productivity workspace documentation",
        )
        .unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let source = manager
            .add_local_folder(dir.path().to_str().unwrap())
            .unwrap();

        assert_eq!(source.file_count, 1);

        let results = manager.search("productivity", 10).unwrap();
        assert!(!results.is_empty());
    }

    #[test]
    fn manager_add_file() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("doc.txt");
        std::fs::write(&file_path, "Single document for testing search").unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let source = manager.add_local_file(file_path.to_str().unwrap()).unwrap();

        assert_eq!(source.file_count, 1);
    }

    #[test]
    fn manager_remove_source() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("test.txt"), "content").unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let source = manager
            .add_local_folder(dir.path().to_str().unwrap())
            .unwrap();

        manager.remove_source(&source.id).unwrap();
        let sources = manager.list_sources().unwrap();
        assert!(sources.is_empty());
    }

    #[test]
    fn manager_list_sources() {
        let dir1 = tempfile::tempdir().unwrap();
        let dir2 = tempfile::tempdir().unwrap();
        std::fs::write(dir1.path().join("a.txt"), "a").unwrap();
        std::fs::write(dir2.path().join("b.txt"), "b").unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager
            .add_local_folder(dir1.path().to_str().unwrap())
            .unwrap();
        manager
            .add_local_folder(dir2.path().to_str().unwrap())
            .unwrap();

        let sources = manager.list_sources().unwrap();
        assert_eq!(sources.len(), 2);
    }

    #[test]
    fn manager_hybrid_populates_embeddings_on_index() {
        // After indexing a folder via the default constructor, every
        // chunk should have an embedding stored — hybrid retrieval
        // is on by default and the indexer is wired to populate
        // `chunk_embeddings` inline with chunk insertion.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("readme.txt"),
            "Tessera uses SQLite FTS5 with hybrid retrieval for full-text search.",
        )
        .unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager
            .add_local_folder(dir.path().to_str().unwrap())
            .unwrap();

        // The default embedder model id is hash-trick-v1; load every
        // embedding and verify the chunk got persisted.
        let rows = manager
            .store
            .load_embeddings_for_model("hash-trick-v1-256d-char3-5")
            .unwrap();
        assert!(
            !rows.is_empty(),
            "embeddings should be populated by default after indexing"
        );
        assert_eq!(
            rows[0].vector.len(),
            256,
            "vector dim should match embedder"
        );
    }

    #[test]
    fn manager_backfill_embeddings_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha bravo charlie").unwrap();
        std::fs::write(dir.path().join("b.txt"), "delta echo foxtrot").unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager
            .add_local_folder(dir.path().to_str().unwrap())
            .unwrap();

        // First backfill should find nothing missing (indexer already
        // embedded inline), but the call must succeed.
        let first = manager.backfill_embeddings(100).unwrap();
        assert_eq!(first, 0, "no missing embeddings after fresh indexing");

        // Second backfill is a no-op.
        let second = manager.backfill_embeddings(100).unwrap();
        assert_eq!(second, 0);
    }

    #[test]
    fn manager_hybrid_search_returns_results_for_typo_query() {
        // Hybrid retrieval should be more forgiving of typos than
        // BM25 alone because the hash-trick embedding shares
        // character n-grams between the typo'd query and the
        // correctly-spelled chunk content. We probe this by indexing
        // a chunk and querying with a one-character substitution.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("doc.txt"),
            "Tessera implements hybrid retrieval combining BM25, vector cosine, and recency decay.",
        )
        .unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager
            .add_local_folder(dir.path().to_str().unwrap())
            .unwrap();

        // Multi-word query so BM25 has terms to anchor on; the
        // "Tesserae" typo is the failure case that pure BM25 misses
        // (no exact match). Hybrid finds it via the embedding signal.
        let results = manager.search("Tesserae hybrid retrieval", 5).unwrap();
        assert!(
            !results.is_empty(),
            "hybrid search should find typo'd query"
        );
    }

    #[test]
    fn manager_invalid_path_returns_error() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let result = manager.add_local_folder("/nonexistent/path/12345");
        assert!(result.is_err());
    }

    #[test]
    fn retention_promotes_low_bm25_chunk_when_vector_disabled() {
        // Regression: the retention signal must be able to promote a
        // chunk that BM25 ranked *past* the top-`limit` cutoff — that
        // is its entire purpose (surface chunks from active-memory
        // sources). Before the pool-sizing fix the candidate pool
        // collapsed to exactly `limit` whenever the vector signal was
        // off (no embeddings / `vector_weight = 0`), so retention could
        // only reorder *within* the BM25 top-`limit` and never pulled a
        // high-retention chunk in from below the cutoff.
        let strong_dir = tempfile::tempdir().unwrap();
        std::fs::write(
            strong_dir.path().join("strong.txt"),
            "alpha alpha alpha alpha alpha",
        )
        .unwrap();
        let weak_dir = tempfile::tempdir().unwrap();
        std::fs::write(
            weak_dir.path().join("weak.txt"),
            "alpha beta gamma delta epsilon zeta eta theta iota kappa",
        )
        .unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let strong = manager
            .add_local_folder(strong_dir.path().to_str().unwrap())
            .unwrap();
        let weak = manager
            .add_local_folder(weak_dir.path().to_str().unwrap())
            .unwrap();

        // Drive the BM25-only path: with vector off, the candidate pool
        // used to be capped at exactly `limit`.
        manager
            .update_hybrid_config(&HybridSearchConfigInput {
                vector_weight: Some(0.0),
                ..HybridSearchConfigInput::default()
            })
            .unwrap();

        // Baseline: by BM25 alone (limit=1) the higher-TF doc wins, so
        // the weak doc sits below the top-`limit` cutoff.
        let baseline = manager.search("alpha", 1).unwrap();
        assert_eq!(baseline.len(), 1);
        assert_eq!(baseline[0].source_id, strong.id.to_string());

        // Fuse retention with the weak-BM25 source scored far higher.
        // It must be promoted into the single top slot, which is only
        // possible if the candidate pool was oversampled past `limit`.
        let mut retention = std::collections::HashMap::new();
        retention.insert(weak.id.to_string(), 1_000.0);
        let promoted = manager
            .search_with_retention("alpha", 1, retention)
            .unwrap();
        assert_eq!(promoted.len(), 1);
        assert_eq!(
            promoted[0].source_id,
            weak.id.to_string(),
            "a high-retention chunk below the BM25 top-`limit` cutoff must be promoted"
        );
    }

    // ----------------------------------------------------------------
    // KChat-channel idempotency
    // ----------------------------------------------------------------

    #[test]
    fn add_kchat_channel_first_call_creates_source_and_returns_newly_created_true() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("file.txt"), "kchat content").unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let outcome = manager
            .add_kchat_channel(dir.path().to_str().unwrap())
            .unwrap();

        assert!(
            outcome.newly_created,
            "first add_kchat_channel call must report newly_created=true"
        );
        assert!(matches!(
            outcome.source.source_type,
            tessera_core::SourceType::Kchat
        ));
        let sources = manager.list_sources().unwrap();
        assert_eq!(sources.len(), 1, "exactly one source row after first add");
    }

    #[test]
    fn add_kchat_channel_second_call_reindexes_in_place_no_duplicate_row() {
        // Convergent-sync invariant: calling add_kchat_channel twice
        // with the same cache_dir must NOT create a second row in the
        // sources table. A regression here would cause one duplicate
        // source per re-sync, leading to unbounded growth and double
        // indexing of every file.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("file.txt"), "kchat content").unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let first = manager
            .add_kchat_channel(dir.path().to_str().unwrap())
            .unwrap();

        // Drop a second file into the cache dir to simulate a new
        // file arriving between syncs.
        std::fs::write(dir.path().join("file2.txt"), "more content").unwrap();

        let second = manager
            .add_kchat_channel(dir.path().to_str().unwrap())
            .unwrap();

        assert!(
            !second.newly_created,
            "second add_kchat_channel call for same cache_dir must report newly_created=false"
        );
        assert_eq!(
            first.source.id, second.source.id,
            "second call must return the same SourceId (in-place reindex, not a new row)"
        );

        let sources = manager.list_sources().unwrap();
        assert_eq!(
            sources.len(),
            1,
            "exactly one source row after two add_kchat_channel calls for the same cache_dir"
        );
        // The reindex must have picked up the second file.
        assert!(
            sources[0].file_count >= 2,
            "reindex on re-sync should pick up newly arrived files (got file_count={})",
            sources[0].file_count
        );
    }

    #[test]
    fn add_kchat_channel_different_cache_dirs_get_separate_rows() {
        // Two distinct channels live in two distinct cache dirs and
        // must produce two distinct source rows. The idempotency
        // contract is on `(SourceType::Kchat, path)`, NOT on
        // SourceType alone — a regression that matched on type only
        // would collapse every channel into one row.
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();
        std::fs::write(dir_a.path().join("a.txt"), "channel A").unwrap();
        std::fs::write(dir_b.path().join("b.txt"), "channel B").unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let a = manager
            .add_kchat_channel(dir_a.path().to_str().unwrap())
            .unwrap();
        let b = manager
            .add_kchat_channel(dir_b.path().to_str().unwrap())
            .unwrap();

        assert!(a.newly_created);
        assert!(b.newly_created);
        assert_ne!(
            a.source.id, b.source.id,
            "distinct cache dirs must get distinct SourceIds"
        );
        assert_eq!(manager.list_sources().unwrap().len(), 2);
    }

    // ----------------------------------------------------------------
    // Block B Task 2: targeted single-file index for KChat WS push
    // ----------------------------------------------------------------

    #[test]
    fn is_kchat_channel_linked_returns_false_when_no_source_exists() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        assert!(!manager
            .is_kchat_channel_linked("/tmp/never-linked")
            .unwrap());
    }

    #[test]
    fn is_kchat_channel_linked_returns_true_after_add_kchat_channel() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager.add_kchat_channel(cache_dir).unwrap();
        assert!(manager.is_kchat_channel_linked(cache_dir).unwrap());
    }

    #[test]
    fn index_kchat_file_returns_none_when_channel_is_not_linked() {
        // The WS forwarder calls this on every `file_added` event;
        // for channels the user has not linked as a source, the
        // call must short-circuit so the audit row carries
        // `triggered_reindex = false` and no indexer work is done.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("doc.txt"), "kchat content").unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        // Note: no add_kchat_channel call — the cache dir exists
        // on disk but is not registered as a source.
        let outcome = manager
            .index_kchat_file(dir.path().to_str().unwrap(), "doc.txt")
            .unwrap();
        assert!(outcome.is_none());
    }

    #[test]
    fn index_kchat_file_indexes_newly_arrived_file_on_linked_channel() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager.add_kchat_channel(cache_dir).unwrap();
        // Simulate the forwarder writing a new file to disk after
        // the WS push arrived but before the next full reconciliation.
        std::fs::write(dir.path().join("pushed.txt"), "ws-driven file").unwrap();

        let outcome = manager
            .index_kchat_file(cache_dir, "pushed.txt")
            .unwrap()
            .expect("linked channel should return Some");
        let (_source_id, file_outcome) = outcome;
        assert!(
            file_outcome.indexed,
            "first index_kchat_file call for a fresh file must index it"
        );
    }

    #[test]
    fn index_kchat_file_is_idempotent_on_same_content_hash() {
        // Second call for the same file returns indexed=false
        // (the hash matched, no re-extraction needed). This
        // matters because the WS forwarder may re-fire `file_added`
        // for a file that a concurrent full sync has already
        // indexed; the single-file path must not double-chunk it.
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager.add_kchat_channel(cache_dir).unwrap();
        std::fs::write(dir.path().join("pushed.txt"), "ws-driven file").unwrap();

        manager
            .index_kchat_file(cache_dir, "pushed.txt")
            .unwrap()
            .unwrap();
        let (_source_id, second_outcome) = manager
            .index_kchat_file(cache_dir, "pushed.txt")
            .unwrap()
            .unwrap();
        assert!(
            !second_outcome.indexed,
            "second call with unchanged content must skip on hash match"
        );
    }

    #[test]
    fn index_kchat_file_rejects_path_traversal_basenames() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager.add_kchat_channel(cache_dir).unwrap();

        // The Node-side syncer applies `path.basename(...)` before
        // ever calling here, so these cases shouldn't reach the
        // substrate in practice. The substrate-boundary check is
        // defence-in-depth.
        for malicious in [
            "..",
            ".",
            "",
            "../etc/passwd",
            "subdir/file.txt",
            "windows\\path.txt",
            "with\0nul.txt",
        ] {
            let err = manager.index_kchat_file(cache_dir, malicious);
            assert!(
                err.is_err(),
                "index_kchat_file must reject malicious basename {malicious:?}"
            );
        }
    }

    // ----------------------------------------------------------------
    // KChat channel ACL projection
    // ----------------------------------------------------------------

    fn make_acl_member(user_id: &str, role: &str) -> KchatAclMember {
        KchatAclMember {
            user_id: user_id.to_string(),
            role: role.to_string(),
        }
    }

    #[test]
    fn refresh_kchat_acl_no_principal_returns_no_principal_without_touching_source() {
        // Pre-condition: substrate has no `kchat_principal` set
        // (no `kchat:connect` happened yet). refresh_kchat_acl
        // must NOT auto-revoke every linked source; it returns
        // NoPrincipal and leaves status untouched so the
        // forwarder remains effectively a no-op.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "x").unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager
            .add_kchat_channel(dir.path().to_str().unwrap())
            .unwrap();

        let outcome = manager
            .refresh_kchat_acl(
                dir.path().to_str().unwrap(),
                &[make_acl_member("user-A", "channel_user")],
            )
            .unwrap();
        assert_eq!(outcome, KchatAclRefreshOutcome::NoPrincipal);
        // Status untouched — should still be whatever
        // add_kchat_channel left it (Indexed for a successful run).
        let refreshed = manager.get_source(&added.source.id).unwrap();
        assert_eq!(refreshed.status, added.source.status);
    }

    #[test]
    fn refresh_kchat_acl_unlinked_when_no_source_row() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager.set_kchat_principal("principal").unwrap();
        let outcome = manager
            .refresh_kchat_acl(
                "/no/such/cache/dir",
                &[make_acl_member("principal", "channel_user")],
            )
            .unwrap();
        assert_eq!(outcome, KchatAclRefreshOutcome::Unlinked);
    }

    #[test]
    fn refresh_kchat_acl_principal_present_returns_granted_and_persists_roster() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "x").unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager
            .add_kchat_channel(dir.path().to_str().unwrap())
            .unwrap();
        manager.set_kchat_principal("principal").unwrap();

        let outcome = manager
            .refresh_kchat_acl(
                dir.path().to_str().unwrap(),
                &[
                    make_acl_member("principal", "channel_user channel_admin"),
                    make_acl_member("alice", "channel_user"),
                ],
            )
            .unwrap();
        assert_eq!(outcome, KchatAclRefreshOutcome::Granted);

        // Status unchanged (still whatever add_kchat_channel left it).
        let refreshed = manager.get_source(&added.source.id).unwrap();
        assert_eq!(refreshed.status, added.source.status);

        // Roster persisted exactly as passed.
        let rows = manager.list_kchat_acl(&added.source.id).unwrap();
        assert_eq!(rows.len(), 2);
        let principal_row = rows.iter().find(|r| r.member_user_id == "principal");
        assert!(principal_row.is_some(), "principal row must be persisted");
        assert_eq!(
            principal_row.unwrap().role,
            "channel_user channel_admin",
            "role string must be persisted verbatim"
        );
    }

    #[test]
    fn refresh_kchat_acl_principal_missing_transitions_to_access_revoked() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "x").unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager
            .add_kchat_channel(dir.path().to_str().unwrap())
            .unwrap();
        manager.set_kchat_principal("principal").unwrap();

        let outcome = manager
            .refresh_kchat_acl(
                dir.path().to_str().unwrap(),
                &[
                    make_acl_member("alice", "channel_user"),
                    make_acl_member("bob", "channel_user"),
                ],
            )
            .unwrap();
        // the revoke outcome carries the
        // cryptoshred counters. `add_kchat_channel` above indexed
        // the single `f.txt` file (one indexed_files row + one
        // chunk), so the revoke scrubs both. The dedicated end-to-end
        // shred regression test lives in
        // `refresh_kchat_acl_revoke_cryptoshreds_indexed_evidence`
        // — this assertion pins the contract that the count fields
        // are populated, not zero-by-default.
        assert_eq!(
            outcome,
            KchatAclRefreshOutcome::Revoked {
                chunks_dropped: 1,
                files_dropped: 1,
                // file-only ingest never
                // generated a per-source DEK or kchat_posts row, so
                // both new counters report zero on the file-only
                // shred path.
                posts_dropped: 0,
                dek_dropped: false,
                vacuum_succeeded: true,
                vacuum_error: None,
            },
        );
        let refreshed = manager.get_source(&added.source.id).unwrap();
        assert_eq!(refreshed.status, SourceStatus::AccessRevoked);

        // Roster still persisted — operator-visible forensics for
        // "who had access at the moment of revocation".
        let rows = manager.list_kchat_acl(&added.source.id).unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn refresh_kchat_acl_regrant_on_principal_readded() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "x").unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager
            .add_kchat_channel(dir.path().to_str().unwrap())
            .unwrap();
        manager.set_kchat_principal("principal").unwrap();

        // Revoke first.
        manager
            .refresh_kchat_acl(
                dir.path().to_str().unwrap(),
                &[make_acl_member("alice", "channel_user")],
            )
            .unwrap();
        assert_eq!(
            manager.get_source(&added.source.id).unwrap().status,
            SourceStatus::AccessRevoked,
        );

        // Now re-add the principal.
        let outcome = manager
            .refresh_kchat_acl(
                dir.path().to_str().unwrap(),
                &[
                    make_acl_member("alice", "channel_user"),
                    make_acl_member("principal", "channel_user"),
                ],
            )
            .unwrap();
        assert_eq!(outcome, KchatAclRefreshOutcome::Regranted);
        // regrant transitions to
        // `Connected`, NOT `Indexed`. The earlier revoke
        // cryptoshredded every chunk + indexed_file row, so the
        // source is empty until the Node-side forwarder runs a
        // full re-sync — and only then will the indexer promote
        // status to `Indexing` and `Indexed`. Asserting `Indexed`
        // here (as an earlier draft did) would mean the UI
        // claims the channel is searchable while every query
        // returns zero rows.
        assert_eq!(
            manager.get_source(&added.source.id).unwrap().status,
            SourceStatus::Connected,
        );
    }

    #[test]
    fn revoke_kchat_source_transitions_to_access_revoked() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "x").unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager
            .add_kchat_channel(dir.path().to_str().unwrap())
            .unwrap();

        let outcome = manager
            .revoke_kchat_source(dir.path().to_str().unwrap())
            .unwrap();
        // `add_kchat_channel` above indexed the single `f.txt`
        // file (one indexed_files row + one chunk), so the revoke
        // scrubs both. See
        // `revoke_kchat_source_cryptoshreds_evidence_idempotently`
        // for the dedicated multi-file regression test.
        assert_eq!(
            outcome,
            KchatRevokeOutcome::Revoked {
                chunks_dropped: 1,
                files_dropped: 1,
                // file-only ingest —
                // no post / DEK rows were ever created.
                posts_dropped: 0,
                dek_dropped: false,
                vacuum_succeeded: true,
                vacuum_error: None,
            },
        );
        assert_eq!(
            manager.get_source(&added.source.id).unwrap().status,
            SourceStatus::AccessRevoked,
        );

        // Idempotent: a second revoke reports `AlreadyRevoked`
        // with zero shred counts (the first revoke already
        // scrubbed every chunk + indexed_file row).
        let again = manager
            .revoke_kchat_source(dir.path().to_str().unwrap())
            .unwrap();
        assert_eq!(
            again,
            KchatRevokeOutcome::AlreadyRevoked {
                chunks_dropped: 0,
                files_dropped: 0,
                posts_dropped: 0,
                dek_dropped: false,
                vacuum_succeeded: true,
                vacuum_error: None,
            },
        );
    }

    #[test]
    fn revoke_kchat_source_unlinked_when_no_source_row() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let outcome = manager.revoke_kchat_source("/no/such/dir").unwrap();
        assert_eq!(outcome, KchatRevokeOutcome::Unlinked);
    }

    /// end-to-end regression for
    /// cryptoshred-on-explicit-revoke. We index a multi-file channel,
    /// confirm `list_indexed_files` reports the expected rows, revoke
    /// the source, and assert that the indexed_files + chunk rows
    /// for that source are gone. The source row itself stays (with
    /// `file_count = 0` and `last_indexed = None`) so an operator
    /// can still see "this channel was revoked".
    #[test]
    fn revoke_kchat_source_cryptoshreds_evidence_idempotently() {
        let dir = tempfile::tempdir().unwrap();
        // Three files with three different contents so the chunker
        // emits at least three chunk rows.
        std::fs::write(dir.path().join("a.txt"), "alpha file content").unwrap();
        std::fs::write(dir.path().join("b.txt"), "bravo file content").unwrap();
        std::fs::write(dir.path().join("c.txt"), "charlie file content").unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager
            .add_kchat_channel(dir.path().to_str().unwrap())
            .unwrap();

        let pre_files = manager.list_indexed_files(&added.source.id).unwrap();
        assert_eq!(
            pre_files.len(),
            3,
            "control: add_kchat_channel must index all 3 files",
        );

        let outcome = manager
            .revoke_kchat_source(dir.path().to_str().unwrap())
            .unwrap();
        let (chunks_dropped, files_dropped) = match outcome {
            KchatRevokeOutcome::Revoked {
                chunks_dropped,
                files_dropped,
                posts_dropped: _,
                dek_dropped: _,
                vacuum_succeeded,
                vacuum_error,
            } => {
                // Fifth-pass Devin Review fix
                // (ANALYSIS_pr-review-job-ef3c7d6c..._0001): the
                // happy-path multi-file revoke must always report a
                // clean VACUUM. The dedicated
                // `cryptoshred_kchat_source_evidence_records_vacuum_failure`
                // test in `store.rs` exercises the failure path via a
                // poisoned connection.
                assert!(vacuum_succeeded, "happy-path VACUUM must succeed");
                assert!(vacuum_error.is_none());
                (chunks_dropped, files_dropped)
            }
            other => panic!("expected Revoked variant, got {other:?}"),
        };
        assert_eq!(
            files_dropped, 3,
            "all 3 indexed_files rows must be scrubbed by the cryptoshred"
        );
        assert!(
            chunks_dropped >= 3,
            "all per-file chunks must be scrubbed; got {chunks_dropped} \
             chunks_dropped for 3 indexed files"
        );

        // Post-shred: source row stays, evidence gone.
        let refreshed = manager.get_source(&added.source.id).unwrap();
        assert_eq!(refreshed.status, SourceStatus::AccessRevoked);
        assert_eq!(refreshed.file_count, 0);
        assert_eq!(refreshed.last_indexed, None);
        let post_files = manager.list_indexed_files(&added.source.id).unwrap();
        assert!(
            post_files.is_empty(),
            "post-cryptoshred indexed_files must be empty; got {post_files:?}"
        );

        // Idempotency: a second revoke reports `AlreadyRevoked`
        // with zero counts (every row already scrubbed).
        let again = manager
            .revoke_kchat_source(dir.path().to_str().unwrap())
            .unwrap();
        assert_eq!(
            again,
            KchatRevokeOutcome::AlreadyRevoked {
                chunks_dropped: 0,
                files_dropped: 0,
                posts_dropped: 0,
                dek_dropped: false,
                vacuum_succeeded: true,
                vacuum_error: None,
            },
        );
    }

    /// regression for the
    /// `refresh_kchat_acl(Revoked)` auto-shred path. The
    /// retrieval-side filter from Task 3 is the first line of
    /// defence; the inline cryptoshred makes the chunks actually
    /// disappear so a future filter regression cannot leak them.
    #[test]
    fn refresh_kchat_acl_revoke_cryptoshreds_indexed_evidence() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha file content").unwrap();
        std::fs::write(dir.path().join("b.txt"), "bravo file content").unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager
            .add_kchat_channel(dir.path().to_str().unwrap())
            .unwrap();
        manager.set_kchat_principal("principal").unwrap();

        let pre_files = manager.list_indexed_files(&added.source.id).unwrap();
        assert_eq!(pre_files.len(), 2, "control: two files must be indexed");

        // Refresh with a roster the principal is NOT in → Revoked.
        let outcome = manager
            .refresh_kchat_acl(
                dir.path().to_str().unwrap(),
                &[make_acl_member("alice", "channel_user")],
            )
            .unwrap();
        let (chunks_dropped, files_dropped) = match outcome {
            KchatAclRefreshOutcome::Revoked {
                chunks_dropped,
                files_dropped,
                posts_dropped: _,
                dek_dropped: _,
                vacuum_succeeded,
                vacuum_error,
            } => {
                assert!(vacuum_succeeded, "happy-path VACUUM must succeed");
                assert!(vacuum_error.is_none());
                (chunks_dropped, files_dropped)
            }
            other => panic!("expected Revoked variant, got {other:?}"),
        };
        assert_eq!(files_dropped, 2);
        assert!(
            chunks_dropped >= 2,
            "cryptoshred must scrub chunks for every indexed file; got \
             chunks_dropped={chunks_dropped}"
        );

        let post_files = manager.list_indexed_files(&added.source.id).unwrap();
        assert!(post_files.is_empty());
        assert_eq!(
            manager.get_source(&added.source.id).unwrap().status,
            SourceStatus::AccessRevoked,
        );
    }

    #[test]
    fn refresh_kchat_acl_atomic_roster_replace_drops_old_rows() {
        // The roster is a full replacement, not a delta — a member
        // who was present in the previous refresh but absent in
        // the new one must disappear from the ACL table. A
        // regression that did an INSERT-only would let stale
        // members stay in the audit forensics indefinitely.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "x").unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager
            .add_kchat_channel(dir.path().to_str().unwrap())
            .unwrap();
        manager.set_kchat_principal("principal").unwrap();

        manager
            .refresh_kchat_acl(
                dir.path().to_str().unwrap(),
                &[
                    make_acl_member("principal", "channel_user"),
                    make_acl_member("alice", "channel_user"),
                    make_acl_member("bob", "channel_user"),
                ],
            )
            .unwrap();
        assert_eq!(manager.list_kchat_acl(&added.source.id).unwrap().len(), 3);

        manager
            .refresh_kchat_acl(
                dir.path().to_str().unwrap(),
                &[make_acl_member("principal", "channel_user")],
            )
            .unwrap();
        let rows = manager.list_kchat_acl(&added.source.id).unwrap();
        assert_eq!(rows.len(), 1, "stale rows must be dropped on refresh");
        assert_eq!(rows[0].member_user_id, "principal");
    }

    #[test]
    fn kchat_principal_round_trip_set_get_clear() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        assert_eq!(manager.get_kchat_principal().unwrap(), None);
        manager.set_kchat_principal("user-X").unwrap();
        assert_eq!(
            manager.get_kchat_principal().unwrap().as_deref(),
            Some("user-X")
        );
        // Overwrite — singleton row, latest value wins.
        manager.set_kchat_principal("user-Y").unwrap();
        assert_eq!(
            manager.get_kchat_principal().unwrap().as_deref(),
            Some("user-Y")
        );
        manager.clear_kchat_principal().unwrap();
        assert_eq!(manager.get_kchat_principal().unwrap(), None);
    }

    // ----------------------------------------------------------------
    // backfill_embeddings_tracked + embedding_progress tests
    // ----------------------------------------------------------------

    use crate::progress::EmbeddingStatus;

    #[test]
    fn embedding_progress_default_state_is_idle() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let snap = manager.embedding_progress();
        assert_eq!(snap.status, EmbeddingStatus::Idle);
        assert_eq!(snap.total_chunks, 0);
        assert_eq!(snap.embedded, 0);
        assert_eq!(snap.failed, 0);
        assert!(snap.model_id.is_none());
        assert!(snap.last_error.is_none());
    }

    #[test]
    fn embedding_progress_handle_shares_state_with_manager() {
        // The handle is the same `Arc` the manager mutates internally,
        // so reads through the handle must observe the same state as
        // reads through `manager.embedding_progress()`. The bridge
        // relies on this invariant to skip the `source_manager` lock
        // during progress polls.
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let handle = manager.embedding_progress_handle();
        let initial = handle.snapshot();
        assert_eq!(initial.status, EmbeddingStatus::Idle);

        // Run a no-op backfill (no embedder attached) to flip the
        // state. The handle observes the transition because it
        // points at the same `EmbeddingProgressTracker` instance.
        let _ = manager.backfill_embeddings_tracked(64).unwrap();
        let after = handle.snapshot();
        let via_manager = manager.embedding_progress();
        assert_eq!(after.status, via_manager.status);
        assert_eq!(after.total_chunks, via_manager.total_chunks);
        assert_eq!(after.embedded, via_manager.embedded);
    }

    #[test]
    fn tracked_backfill_on_fresh_index_reports_zero_missing() {
        // Indexer already embedded inline during add_local_folder, so
        // count_chunks_missing_embedding returns 0 and the tracker
        // ends in Done with embedded=0 / total_chunks=0.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.txt"),
            "alpha bravo charlie delta echo foxtrot",
        )
        .unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager
            .add_local_folder(dir.path().to_str().unwrap())
            .unwrap();

        let total = manager.backfill_embeddings_tracked(64).unwrap();
        assert_eq!(total, 0, "fresh index should leave zero chunks missing");

        let snap = manager.embedding_progress();
        assert_eq!(snap.status, EmbeddingStatus::Done);
        assert_eq!(snap.total_chunks, 0);
        assert_eq!(snap.embedded, 0);
        assert_eq!(snap.failed, 0);
        assert_eq!(
            snap.model_id.as_deref(),
            Some("hash-trick-v1-256d-char3-5"),
            "tracker should record the active model id"
        );
    }

    #[test]
    fn tracked_backfill_fills_chunks_indexed_without_embedder() {
        // Hand-build a SourceManager whose indexer has no embedder,
        // index a folder, then attach an embedder and confirm
        // backfill_embeddings_tracked walks the corpus and reports
        // accurate progress.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.txt"),
            "alpha bravo charlie delta echo foxtrot",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("b.txt"),
            "golf hotel india juliet kilo lima",
        )
        .unwrap();

        // Build a manager with NO embedder so the index pass leaves
        // chunk_embeddings empty.
        let store = SourceStore::open_in_memory().unwrap();
        let indexer = Indexer::new(&[]); // no .with_embedder(...)
        let mut manager = SourceManager {
            store,
            indexer,
            progress: Arc::new(ProgressTracker::new()),
            embedding_progress: Arc::new(EmbeddingProgressTracker::new()),
            embedder: None,
            hybrid_config: Mutex::new(HybridSearchConfig::default()),
            kchat_crypto: SourceManager::default_kchat_crypto(),
        };

        manager
            .add_local_folder(dir.path().to_str().unwrap())
            .unwrap();

        // Now attach the default embedder so backfill has something to
        // populate. We rebuild only the indexer + embedder; the store
        // stays the same so the chunks survive.
        let embedder: Arc<dyn EmbeddingProvider> = Arc::new(HashTrickEmbedding::default_config());
        manager.indexer = Indexer::new(&[]).with_embedder(Arc::clone(&embedder));
        manager.embedder = Some(Arc::clone(&embedder));

        // Pre-flight: the count of missing chunks should be the total
        // number of chunks (zero have been embedded).
        let model_id = embedder.model_id();
        let pre_count = manager
            .store
            .count_chunks_missing_embedding(model_id)
            .unwrap();
        assert!(
            pre_count > 0,
            "indexing without embedder should leave chunks missing embeddings"
        );

        // Run the tracked backfill. Use a small batch size so the
        // loop iterates multiple times — tests the per-chunk progress
        // reporting end-to-end.
        let total = manager.backfill_embeddings_tracked(2).unwrap();
        assert_eq!(
            total, pre_count as usize,
            "backfill should embed every previously-missing chunk"
        );

        let snap = manager.embedding_progress();
        assert_eq!(snap.status, EmbeddingStatus::Done);
        assert_eq!(snap.total_chunks, pre_count);
        assert_eq!(snap.embedded, pre_count);
        assert_eq!(snap.failed, 0);

        // Post-condition: count is now zero (every chunk has an
        // embedding) so a second tracked backfill is a no-op.
        let post_count = manager
            .store
            .count_chunks_missing_embedding(model_id)
            .unwrap();
        assert_eq!(post_count, 0);
        let second = manager.backfill_embeddings_tracked(2).unwrap();
        assert_eq!(second, 0);
        let snap = manager.embedding_progress();
        assert_eq!(snap.status, EmbeddingStatus::Done);
        assert_eq!(snap.total_chunks, 0);
        assert_eq!(snap.embedded, 0);
    }

    #[test]
    fn update_hybrid_config_returns_new_effective_config() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let before = manager.get_hybrid_config();
        assert!((before.vector_weight - 1.0).abs() < 1e-9);

        let new_cfg = manager
            .update_hybrid_config(&HybridSearchConfigInput {
                vector_weight: Some(0.0),
                recency_halflife_secs: Some(14.0 * 24.0 * 60.0 * 60.0),
                ..HybridSearchConfigInput::default()
            })
            .unwrap();
        assert!(new_cfg.vector_weight.abs() < 1e-9);
        assert!((new_cfg.recency_halflife_secs - 14.0 * 24.0 * 60.0 * 60.0).abs() < 1.0);

        // A subsequent get must reflect the updated state — i.e. the
        // mutex was actually written, not just the returned clone.
        let after = manager.get_hybrid_config();
        assert!(after.vector_weight.abs() < 1e-9);
    }

    #[test]
    fn update_hybrid_config_rejects_invalid_patch_without_mutating_state() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let before = manager.get_hybrid_config();
        let err = manager
            .update_hybrid_config(&HybridSearchConfigInput {
                vector_weight: Some(2.0),
                recency_halflife_secs: Some(-1.0),
                ..HybridSearchConfigInput::default()
            })
            .unwrap_err();
        assert!(err.to_string().contains("recency_halflife_secs"));
        let after = manager.get_hybrid_config();
        // Even though vector_weight=2.0 was valid, the whole patch
        // must be rejected together — `apply_patch` is transactional.
        assert!((after.vector_weight - before.vector_weight).abs() < 1e-9);
        assert!((after.recency_halflife_secs - before.recency_halflife_secs).abs() < 1e-9);
    }

    #[test]
    fn update_hybrid_config_disables_vector_signal_for_subsequent_searches() {
        // Set vector_weight=0 and verify search still works (BM25
        // only) without panicking. We can't easily black-box assert
        // "BM25-only ordering" without instrumenting the engine, so
        // this test focuses on the end-to-end "config flows through
        // to the search" contract: a search after the update
        // succeeds and returns results that match the BM25 path.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("doc.txt"),
            "Hybrid retrieval combines BM25 with vector similarity for robust ranking.",
        )
        .unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager
            .add_local_folder(dir.path().to_str().unwrap())
            .unwrap();
        manager
            .update_hybrid_config(&HybridSearchConfigInput {
                vector_weight: Some(0.0),
                ..HybridSearchConfigInput::default()
            })
            .unwrap();
        let results = manager.search("BM25 ranking", 5).unwrap();
        assert!(
            !results.is_empty(),
            "BM25-only search must still find an exact-term query"
        );
    }

    #[test]
    fn update_hybrid_config_is_thread_safe() {
        // Pound the Mutex from multiple threads — concurrent updates
        // must serialize cleanly (no panic from a poisoned mutex,
        // every successful patch is visible to the final reader).
        // We use the manager-level get_hybrid_config() as the
        // observation point because that's exactly what the IPC
        // bridge will call.
        use std::sync::Arc;
        use std::thread;
        let manager = Arc::new(SourceManager::new_in_memory(&[]).unwrap());
        let mut handles = Vec::new();
        for tid in 0..4 {
            let mgr = Arc::clone(&manager);
            handles.push(thread::spawn(move || {
                for i in 0..50 {
                    let weight = ((tid * 50 + i) as f64) / 1000.0;
                    mgr.update_hybrid_config(&HybridSearchConfigInput {
                        vector_weight: Some(weight),
                        ..HybridSearchConfigInput::default()
                    })
                    .unwrap();
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        // Final state must be one of the values the threads set
        // (i.e. in [0.0, 0.199]) — the assertion proves the mutex
        // didn't get poisoned and the final write landed cleanly.
        let final_cfg = manager.get_hybrid_config();
        assert!(
            (0.0..=0.2).contains(&final_cfg.vector_weight),
            "final vector_weight must reflect one of the concurrent writes: {}",
            final_cfg.vector_weight
        );
    }

    #[test]
    fn tracked_backfill_with_no_embedder_flips_status_to_done() {
        // A SourceManager whose embedder is None should flip status
        // to Done immediately (with total_chunks=0) so the renderer
        // sees a clean idle->done transition rather than getting
        // stuck on Running forever.
        let store = SourceStore::open_in_memory().unwrap();
        let manager = SourceManager {
            store,
            indexer: Indexer::new(&[]),
            progress: Arc::new(ProgressTracker::new()),
            embedding_progress: Arc::new(EmbeddingProgressTracker::new()),
            embedder: None,
            hybrid_config: Mutex::new(HybridSearchConfig::default()),
            kchat_crypto: SourceManager::default_kchat_crypto(),
        };

        let total = manager.backfill_embeddings_tracked(64).unwrap();
        assert_eq!(total, 0);
        let snap = manager.embedding_progress();
        assert_eq!(snap.status, EmbeddingStatus::Done);
        assert_eq!(snap.total_chunks, 0);
        assert_eq!(snap.embedded, 0);
        assert_eq!(snap.failed, 0);
        // model_id is recorded as "none" so the UI can distinguish
        // the no-embedder case from a real run.
        assert_eq!(snap.model_id.as_deref(), Some("none"));
    }

    /// Embedding provider that fails on every call. Used to verify
    /// the manager flips status to `Failed` (not `Done`) when the
    /// indexer's stall detector trips on an all-failed batch.
    struct AlwaysFailEmbedder {
        model_id: String,
        dim: usize,
    }

    impl crate::embedding::EmbeddingProvider for AlwaysFailEmbedder {
        fn model_id(&self) -> &str {
            &self.model_id
        }
        fn dim(&self) -> usize {
            self.dim
        }
        fn embed(&self, _input: &str) -> Result<Vec<f32>> {
            Err(Error::DatabaseState(
                "AlwaysFailEmbedder rejects every input on purpose".into(),
            ))
        }
    }

    #[test]
    fn tracked_backfill_flips_to_failed_when_indexer_stalls() {
        // Regression test for finding: when every chunk
        // in a batch fails to embed, the indexer's stall detector
        // breaks the loop and returns `Ok(BackfillOutcome::Stalled)`.
        // The manager MUST flip status to Failed (not Done) so the
        // renderer shows the failure banner with a useful error
        // message instead of "Re-embed complete" with N silent
        // failures.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.txt"),
            "alpha bravo charlie delta echo foxtrot golf hotel india",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("b.txt"),
            "juliet kilo lima mike november oscar papa quebec romeo",
        )
        .unwrap();

        let store = SourceStore::open_in_memory().unwrap();
        let mut manager = SourceManager {
            store,
            indexer: Indexer::new(&[]),
            progress: Arc::new(ProgressTracker::new()),
            embedding_progress: Arc::new(EmbeddingProgressTracker::new()),
            embedder: None,
            hybrid_config: Mutex::new(HybridSearchConfig::default()),
            kchat_crypto: SourceManager::default_kchat_crypto(),
        };
        manager
            .add_local_folder(dir.path().to_str().unwrap())
            .unwrap();

        // Now attach a perpetually-failing embedder. The index pass
        // populated `chunks` but left `chunk_embeddings` empty (no
        // embedder was attached), so backfill has real work to do.
        let bad: Arc<dyn EmbeddingProvider> = Arc::new(AlwaysFailEmbedder {
            model_id: "always-fail-v0".to_string(),
            dim: 32,
        });
        manager.indexer = Indexer::new(&[]).with_embedder(Arc::clone(&bad));
        manager.embedder = Some(Arc::clone(&bad));

        let pre_count = manager
            .store
            .count_chunks_missing_embedding(bad.model_id())
            .unwrap();
        assert!(pre_count > 0, "expected chunks to be missing embeddings");

        // Run the tracked backfill. The embedder rejects every input
        // so the first batch's `batch_progress` will be 0 → stall
        // detector trips → indexer returns Stalled.
        let embedded = manager.backfill_embeddings_tracked(4).unwrap();

        // The bridge gets `embedded=0` echoed back so the renderer's
        // banner can show "embedded 0 of N".
        assert_eq!(
            embedded, 0,
            "no chunks should have been embedded by AlwaysFailEmbedder"
        );

        let snap = manager.embedding_progress();
        // Critical assertion: status is Failed, NOT Done. This is the
        // exact bug the indexer's stall path used to hide by calling
        // finish_embedding on the way out.
        assert_eq!(
            snap.status,
            EmbeddingStatus::Failed,
            "stall must surface as Failed so the renderer shows the failure banner, \
             not Done (which would say 'Re-embed complete' over N silent failures)"
        );
        assert_eq!(snap.embedded, 0);
        // `failed` should reflect the chunks the indexer fed to the
        // embedder in the stalled batch — at least all `pre_count`
        // chunks for this short-text test, where the chunker emits
        // one chunk per file and both fit in the first batch.
        assert!(
            snap.failed >= pre_count,
            "got failed={}, pre_count={}",
            snap.failed,
            pre_count
        );
        let err = snap.last_error.as_deref().unwrap_or("");
        assert!(
            err.contains("stalled"),
            "last_error should mention the stall; got {err:?}"
        );
        assert!(
            err.contains("embedder may be broken"),
            "last_error should hint at the root cause; got {err:?}"
        );
        // model_id stays populated so the renderer can still show
        // which model was being targeted when the stall fired.
        assert_eq!(snap.model_id.as_deref(), Some("always-fail-v0"));
    }

    #[test]
    fn tracked_backfill_keeps_done_status_when_some_chunks_succeed_some_fail() {
        // Counterpart to the stall test: as long as SOME chunks
        // succeed in a batch, the loop must terminate via the clean
        // `Completed` path. The manager should flip status to Done
        // (not Failed) with the partial-failure count surfaced in
        // `failed`. The user sees a "Re-embed complete" card with a
        // non-zero failure count, which is the intentional
        // partial-success UX.
        struct EvenIndexFailEmbedder {
            model_id: String,
            dim: usize,
            count: Arc<Mutex<usize>>,
        }
        impl crate::embedding::EmbeddingProvider for EvenIndexFailEmbedder {
            fn model_id(&self) -> &str {
                &self.model_id
            }
            fn dim(&self) -> usize {
                self.dim
            }
            fn embed(&self, _input: &str) -> Result<Vec<f32>> {
                let mut n = self.count.lock().unwrap();
                let i = *n;
                *n += 1;
                if i.is_multiple_of(2) {
                    Err(Error::DatabaseState("simulated even-index failure".into()))
                } else {
                    Ok(vec![0.0; self.dim])
                }
            }
        }

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.txt"),
            "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("b.txt"),
            "kilo lima mike november oscar papa quebec romeo sierra tango",
        )
        .unwrap();

        let store = SourceStore::open_in_memory().unwrap();
        let mut manager = SourceManager {
            store,
            indexer: Indexer::new(&[]),
            progress: Arc::new(ProgressTracker::new()),
            embedding_progress: Arc::new(EmbeddingProgressTracker::new()),
            embedder: None,
            hybrid_config: Mutex::new(HybridSearchConfig::default()),
            kchat_crypto: SourceManager::default_kchat_crypto(),
        };
        manager
            .add_local_folder(dir.path().to_str().unwrap())
            .unwrap();

        let flaky: Arc<dyn EmbeddingProvider> = Arc::new(EvenIndexFailEmbedder {
            model_id: "even-fail-v0".to_string(),
            dim: 16,
            count: Arc::new(Mutex::new(0)),
        });
        manager.indexer = Indexer::new(&[]).with_embedder(Arc::clone(&flaky));
        manager.embedder = Some(Arc::clone(&flaky));

        let embedded = manager.backfill_embeddings_tracked(4).unwrap();
        assert!(
            embedded > 0,
            "some chunks should succeed under EvenIndexFailEmbedder"
        );

        let snap = manager.embedding_progress();
        // Partial-success is still Done — the failure count is the
        // signal, not the status. This matches the indexing
        // pipeline's existing partial-failure UX.
        assert_eq!(snap.status, EmbeddingStatus::Done);
        assert!(snap.embedded > 0);
        assert!(snap.failed > 0);
        assert!(
            snap.last_error.is_none(),
            "Done with per-chunk failures should not populate last_error \
             (that's reserved for whole-pass / stall failures)"
        );
    }

    // ----------------------------------------------------------------
    // Block C Task 1 + Task 2: KChat post body ingestion
    // ----------------------------------------------------------------

    fn make_post_input(
        cache_dir: &str,
        post_id: &str,
        channel_id: &str,
        sender: &str,
        body: &str,
    ) -> KchatPostIngestInput {
        KchatPostIngestInput {
            cache_dir: cache_dir.to_string(),
            post_id: post_id.to_string(),
            channel_id: channel_id.to_string(),
            root_id: None,
            sender_user_id: sender.to_string(),
            body: body.to_string(),
            created_at_ms: 1_700_000_000_000,
            edited_at_ms: 0,
        }
    }

    /// Block C Task 1 end-to-end: ingest a fresh post, confirm it
    /// creates a per-source DEK row, inserts AEAD-sealed chunks,
    /// records bookkeeping, and survives an idempotent re-delivery.
    #[test]
    fn ingest_kchat_post_seals_chunks_and_persists_dek() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();

        let body = "alpha bravo charlie delta echo \
                    foxtrot golf hotel india juliet";
        let input = make_post_input(cache_dir, "post-1", "channel-1", "user-1", body);

        let outcome = manager.ingest_kchat_post(&input).unwrap();
        let (indexed_file_id, chunk_count, chunk_ids) = match outcome {
            KchatPostIngestOutcome::Ingested {
                source_id,
                indexed_file_id,
                chunk_ids,
                sealed_count,
            } => {
                assert_eq!(source_id, added.source.id);
                assert!(sealed_count >= 1);
                assert_eq!(chunk_ids.len(), sealed_count as usize);
                (indexed_file_id, sealed_count, chunk_ids)
            }
            other => panic!("expected Ingested, got {other:?}"),
        };

        // Wrapped DEK row exists for the source.
        let wrapped = manager
            .store
            .load_wrapped_dek_for_source(&added.source.id)
            .unwrap();
        assert!(wrapped.is_some(), "wrapped DEK must be persisted");

        // Chunks are AEAD-sealed and the sealed copy round-trips
        // under the same DEK back to the original plaintext.
        for chunk_id in &chunk_ids {
            let sealed = manager
                .store
                .load_chunk_aead(*chunk_id)
                .unwrap()
                .expect("AEAD blob must be persisted alongside plaintext");
            let plaintext = manager
                .kchat_crypto()
                .open_chunk(&added.source.id, &sealed)
                .expect("AEAD seal must decrypt under the same DEK");
            assert!(!plaintext.is_empty());
        }

        // Bookkeeping row points back at the indexed_file_id.
        let found = manager
            .store
            .find_kchat_post(&added.source.id, "post-1")
            .unwrap();
        assert_eq!(found.map(|(id, _)| id), Some(indexed_file_id));

        // Idempotent re-delivery.
        let again = manager.ingest_kchat_post(&input).unwrap();
        match again {
            KchatPostIngestOutcome::Unchanged {
                source_id,
                indexed_file_id: ifid,
                chunk_count: cc,
            } => {
                assert_eq!(source_id, added.source.id);
                assert_eq!(ifid, indexed_file_id);
                assert_eq!(cc, chunk_count);
            }
            other => panic!("expected Unchanged on re-delivery, got {other:?}"),
        }
    }

    /// Block C Task 1: editing a post replaces the chunks under the
    /// same indexed_file_id and the new chunks decrypt under the
    /// same DEK (the source DEK is stable across edits).
    #[test]
    fn edit_kchat_post_reindexes_chunks_under_same_indexed_file() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let _added = manager.add_kchat_channel(cache_dir).unwrap();
        let initial = make_post_input(
            cache_dir,
            "post-7",
            "channel-X",
            "user-7",
            "original message body alpha bravo charlie",
        );
        let first = manager.ingest_kchat_post(&initial).unwrap();
        let initial_file_id = match &first {
            KchatPostIngestOutcome::Ingested {
                indexed_file_id, ..
            } => *indexed_file_id,
            other => panic!("expected Ingested, got {other:?}"),
        };

        // Now an edit — same post_id, different body.
        let mut edited = initial.clone();
        edited.body = "edited message body delta echo foxtrot".into();
        edited.edited_at_ms = 1_700_000_100_000;
        let second = manager.edit_kchat_post(&edited).unwrap();
        match second {
            KchatPostIngestOutcome::Ingested {
                indexed_file_id, ..
            } => {
                assert_eq!(
                    indexed_file_id, initial_file_id,
                    "edits must reuse the same indexed_file_id so external \
                     references stay valid",
                );
            }
            other => panic!("expected Ingested on edit, got {other:?}"),
        }
    }

    /// Block C Task 1: delete drops the chunks + bookkeeping row;
    /// re-delete on an already-gone post is `NotFound`, not an
    /// error.
    #[test]
    fn delete_kchat_post_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();
        let input = make_post_input(cache_dir, "post-9", "ch", "u", "body to delete");
        let outcome = manager.ingest_kchat_post(&input).unwrap();
        match outcome {
            KchatPostIngestOutcome::Ingested { .. } => {}
            other => panic!("expected Ingested, got {other:?}"),
        }

        let deleted = manager.delete_kchat_post(cache_dir, "post-9").unwrap();
        match deleted {
            KchatPostDeleteOutcome::Deleted {
                source_id,
                chunks_dropped,
            } => {
                assert_eq!(source_id, added.source.id);
                assert!(chunks_dropped >= 1);
            }
            other => panic!("expected Deleted, got {other:?}"),
        }

        // Bookkeeping is gone.
        let after = manager
            .store
            .find_kchat_post(&added.source.id, "post-9")
            .unwrap();
        assert!(after.is_none());

        // Idempotent re-delete.
        let again = manager.delete_kchat_post(cache_dir, "post-9").unwrap();
        match again {
            KchatPostDeleteOutcome::NotFound { source_id } => {
                assert_eq!(source_id, added.source.id);
            }
            other => panic!("expected NotFound on re-delete, got {other:?}"),
        }
    }

    /// Block C Task 2: a revoke after a post ingest must drop the
    /// per-source DEK row AND evict the in-memory cache entry so
    /// the SQLCipher master key alone cannot decrypt the previously
    /// sealed chunks.
    #[test]
    fn revoke_after_post_ingest_drops_dek_and_forgets_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();
        let input = make_post_input(cache_dir, "post-r", "ch", "u", "body alpha bravo");
        let _ = manager.ingest_kchat_post(&input).unwrap();
        assert!(manager
            .store
            .load_wrapped_dek_for_source(&added.source.id)
            .unwrap()
            .is_some());
        assert!(manager.kchat_crypto().has_dek(&added.source.id));

        // Explicit revoke (channel_archived path).
        let outcome = manager.revoke_kchat_source(cache_dir).unwrap();
        match outcome {
            KchatRevokeOutcome::Revoked {
                posts_dropped,
                dek_dropped,
                ..
            } => {
                assert_eq!(posts_dropped, 1);
                assert!(dek_dropped, "DEK row must be dropped on revoke");
            }
            other => panic!("expected Revoked, got {other:?}"),
        }

        assert!(manager
            .store
            .load_wrapped_dek_for_source(&added.source.id)
            .unwrap()
            .is_none());
        assert!(!manager.kchat_crypto().has_dek(&added.source.id));
    }

    /// `ensure_dek_loaded` takes a cache fast-path: once a source's DEK is
    /// in the in-memory cache it must not re-read the DB or re-unwrap. Proven
    /// by corrupting the on-disk wrapped row (valid length, garbage bytes)
    /// while the cache is warm: the warm call still succeeds (fast-path,
    /// never touches the row), but after `forget_dek` evicts the cache the
    /// same call fails because it now has to unwrap the corrupt row.
    #[test]
    fn ensure_dek_loaded_uses_cache_fast_path() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();
        let input = make_post_input(cache_dir, "post-fp", "ch", "u", "body fast path");
        let _ = manager.ingest_kchat_post(&input).unwrap();
        let source_id = added.source.id;
        assert!(manager.kchat_crypto().has_dek(&source_id));

        // Overwrite the persisted DEK with a same-shape but undecryptable
        // blob. `from_blobs` only validates lengths, so reuse the real
        // row's nonce/wrapped lengths and zero the bytes.
        let real = manager
            .store
            .load_wrapped_dek_for_source(&source_id)
            .unwrap()
            .expect("DEK row persisted after ingest");
        let corrupt = crate::kchat_crypto::WrappedDek::from_blobs(
            &vec![0u8; real.wrap_nonce().len()],
            &vec![0u8; real.wrapped().len()],
        )
        .expect("corrupt blob has valid lengths");
        manager
            .store
            .upsert_wrapped_dek(&source_id, &corrupt)
            .unwrap();

        // Cache is warm -> fast path returns Ok without reading the row.
        manager
            .ensure_dek_loaded(&source_id)
            .expect("warm cache must short-circuit before touching the DB");

        // Evict the cache; now the same call must read + unwrap the corrupt
        // row and fail, proving the previous success came from the cache.
        manager.kchat_crypto().forget_dek(&source_id);
        assert!(!manager.kchat_crypto().has_dek(&source_id));
        assert!(
            manager.ensure_dek_loaded(&source_id).is_err(),
            "cold cache must unwrap the corrupt row and fail"
        );
    }

    /// Block C Task 1: ingestion against a missing source returns
    /// `Unlinked` without panic and without DEK creation.
    #[test]
    fn ingest_kchat_post_unlinked_when_no_source_row() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let outcome = manager
            .ingest_kchat_post(&make_post_input(
                "/no/such/dir",
                "post-x",
                "ch",
                "u",
                "body",
            ))
            .unwrap();
        assert_eq!(outcome, KchatPostIngestOutcome::Unlinked);
    }

    /// Block C Task 1: ingestion against a revoked source returns
    /// `AccessRevoked` (defence in depth — the forwarder filters
    /// first but a race could still slip through).
    #[test]
    fn ingest_kchat_post_refuses_revoked_source() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let _added = manager.add_kchat_channel(cache_dir).unwrap();
        let _ = manager.revoke_kchat_source(cache_dir).unwrap();

        let outcome = manager
            .ingest_kchat_post(&make_post_input(cache_dir, "p", "ch", "u", "body"))
            .unwrap();
        assert_eq!(outcome, KchatPostIngestOutcome::AccessRevoked);
    }

    // ─────────────────────────────────────────────────────────────
    // Block C Task 4 — historical backfill watermark
    // ─────────────────────────────────────────────────────────────

    /// A freshly-linked channel reports a clean backfill state:
    /// `Idle { oldest_post_id: None, completed_at: None }`. The
    /// orchestrator uses this to decide "start the walk at the
    /// newest post".
    #[test]
    fn kchat_backfill_state_is_clean_on_fresh_channel() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();

        let state = manager.kchat_backfill_state(cache_dir).unwrap();
        assert_eq!(
            state,
            KchatBackfillState::Idle {
                source_id: added.source.id,
                oldest_post_id: None,
                completed_at: None,
            }
        );
    }

    /// `kchat_backfill_state` against an unknown cache_dir returns
    /// `Unlinked` (no panic, no DEK creation). The orchestrator
    /// treats this as a no-op.
    #[test]
    fn kchat_backfill_state_unlinked_when_no_source() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        assert_eq!(
            manager.kchat_backfill_state("/no/such/dir").unwrap(),
            KchatBackfillState::Unlinked,
        );
    }

    /// `kchat_backfill_state` against a revoked source returns
    /// `AccessRevoked`. The orchestrator refuses to walk it — a
    /// backfill against a revoked source would re-create the
    /// chunks the cryptoshred just destroyed.
    #[test]
    fn kchat_backfill_state_access_revoked_after_revoke() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();
        let _ = manager.revoke_kchat_source(cache_dir).unwrap();

        assert_eq!(
            manager.kchat_backfill_state(cache_dir).unwrap(),
            KchatBackfillState::AccessRevoked {
                source_id: added.source.id,
            }
        );
    }

    /// End-to-end happy path: ingest a 3-post page, confirm each
    /// post lands in `kchat_posts` with chunks + AEAD seal, and
    /// the cursor advances to the OLDEST post id in the page
    /// (the last one, since KChat pages are newest-first).
    #[test]
    fn ingest_kchat_backfill_page_advances_cursor_to_oldest_post() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();

        let page = vec![
            make_post_input(cache_dir, "newest", "ch-1", "u-1", "first body"),
            make_post_input(cache_dir, "middle", "ch-1", "u-1", "second body"),
            make_post_input(cache_dir, "oldest", "ch-1", "u-1", "third body"),
        ];

        let outcome = manager
            .ingest_kchat_backfill_page(cache_dir, &page)
            .unwrap();
        match outcome {
            KchatBackfillIngestOutcome::Ingested {
                source_id,
                posts_ingested,
                posts_unchanged,
                posts_skipped_revoked,
                oldest_post_id_in_page,
            } => {
                assert_eq!(source_id, added.source.id);
                assert_eq!(posts_ingested, 3);
                assert_eq!(posts_unchanged, 0);
                assert_eq!(posts_skipped_revoked, 0);
                assert_eq!(oldest_post_id_in_page.as_deref(), Some("oldest"));
            }
            other => panic!("expected Ingested, got {other:?}"),
        }

        // Cursor is persisted.
        let state = manager.kchat_backfill_state(cache_dir).unwrap();
        let cursor = match state {
            KchatBackfillState::Idle {
                oldest_post_id,
                completed_at: None,
                ..
            } => oldest_post_id,
            other => panic!("expected Idle (not complete), got {other:?}"),
        };
        assert_eq!(cursor.as_deref(), Some("oldest"));

        // Each post is independently ingested.
        for post_id in ["newest", "middle", "oldest"] {
            let row = manager
                .store
                .find_kchat_post(&added.source.id, post_id)
                .unwrap();
            assert!(row.is_some(), "post {post_id} must have a bookkeeping row");
        }
    }

    /// A re-delivery of the same page (e.g. resume after restart)
    /// produces all-`posts_unchanged` and does NOT re-chunk any
    /// post — the substrate dedupe in `ingest_kchat_post`
    /// short-circuits at the body-hash lookup. The cursor remains
    /// at the same oldest id.
    #[test]
    fn ingest_kchat_backfill_page_is_idempotent_on_redelivery() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();

        let page = vec![
            make_post_input(cache_dir, "p-1", "ch-1", "u-1", "body one"),
            make_post_input(cache_dir, "p-2", "ch-1", "u-1", "body two"),
        ];

        // First run.
        let _ = manager
            .ingest_kchat_backfill_page(cache_dir, &page)
            .unwrap();
        let p1_chunks_before = manager
            .store
            .count_chunks_for_indexed_file(
                manager
                    .store
                    .find_kchat_post(&added.source.id, "p-1")
                    .unwrap()
                    .unwrap()
                    .0,
            )
            .unwrap();

        // Re-delivery.
        let outcome = manager
            .ingest_kchat_backfill_page(cache_dir, &page)
            .unwrap();
        match outcome {
            KchatBackfillIngestOutcome::Ingested {
                posts_ingested,
                posts_unchanged,
                ..
            } => {
                assert_eq!(posts_ingested, 0);
                assert_eq!(posts_unchanged, 2);
            }
            other => panic!("expected Ingested with all Unchanged, got {other:?}"),
        }

        // Chunk count must NOT have grown.
        let p1_chunks_after = manager
            .store
            .count_chunks_for_indexed_file(
                manager
                    .store
                    .find_kchat_post(&added.source.id, "p-1")
                    .unwrap()
                    .unwrap()
                    .0,
            )
            .unwrap();
        assert_eq!(p1_chunks_before, p1_chunks_after);
    }

    /// An empty page (the orchestrator's "end-of-history" signal)
    /// returns `Ingested { ..zeros.., oldest_post_id_in_page: None
    /// }` — the substrate does NOT mark the walk complete here;
    /// the orchestrator calls `mark_kchat_backfill_complete`
    /// explicitly. This keeps the linearization point in the
    /// orchestrator's hands rather than smuggling it through a
    /// zero-row ingest.
    #[test]
    fn ingest_kchat_backfill_page_empty_returns_zeros_without_completion() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();

        let outcome = manager.ingest_kchat_backfill_page(cache_dir, &[]).unwrap();
        match outcome {
            KchatBackfillIngestOutcome::Ingested {
                source_id,
                posts_ingested,
                posts_unchanged,
                posts_skipped_revoked,
                oldest_post_id_in_page,
            } => {
                assert_eq!(source_id, added.source.id);
                assert_eq!(posts_ingested, 0);
                assert_eq!(posts_unchanged, 0);
                assert_eq!(posts_skipped_revoked, 0);
                assert_eq!(oldest_post_id_in_page, None);
            }
            other => panic!("expected Ingested (empty page), got {other:?}"),
        }

        // Completion sentinel is NOT set by the empty-page path.
        let state = manager.kchat_backfill_state(cache_dir).unwrap();
        assert!(
            matches!(
                state,
                KchatBackfillState::Idle {
                    completed_at: None,
                    ..
                }
            ),
            "empty page must not set completed_at: {state:?}"
        );
    }

    /// Mark complete after an empty page: the sentinel is set,
    /// any subsequent state read shows `completed_at` populated,
    /// and the cursor (if previously advanced) survives unchanged.
    #[test]
    fn mark_kchat_backfill_complete_sets_completion_sentinel() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();

        // Walk one page so a cursor exists.
        let page = vec![make_post_input(cache_dir, "only", "ch", "u", "body")];
        let _ = manager
            .ingest_kchat_backfill_page(cache_dir, &page)
            .unwrap();

        let outcome = manager.mark_kchat_backfill_complete(cache_dir).unwrap();
        match outcome {
            KchatBackfillCompletionOutcome::Completed { source_id } => {
                assert_eq!(source_id, added.source.id);
            }
            other => panic!("expected Completed, got {other:?}"),
        }

        let state = manager.kchat_backfill_state(cache_dir).unwrap();
        match state {
            KchatBackfillState::Idle {
                oldest_post_id,
                completed_at,
                ..
            } => {
                assert_eq!(oldest_post_id.as_deref(), Some("only"));
                assert!(completed_at.is_some(), "completed_at must be set");
            }
            other => panic!("expected Idle (completed), got {other:?}"),
        }
    }

    /// If the source flips to `AccessRevoked` between pages, the
    /// next ingest call returns `AccessRevoked` and the cursor is
    /// NOT advanced (would point at a post id whose chunks were
    /// just cryptoshredded).
    #[test]
    fn ingest_kchat_backfill_page_stops_on_access_revoked() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();

        // First page lands cleanly.
        let _ = manager
            .ingest_kchat_backfill_page(
                cache_dir,
                &[make_post_input(cache_dir, "p-1", "ch", "u", "body one")],
            )
            .unwrap();

        // Cursor was advanced once.
        let cursor_before = match manager.kchat_backfill_state(cache_dir).unwrap() {
            KchatBackfillState::Idle { oldest_post_id, .. } => oldest_post_id,
            other => panic!("expected Idle, got {other:?}"),
        };
        assert_eq!(cursor_before.as_deref(), Some("p-1"));

        // Revoke mid-walk.
        let _ = manager.revoke_kchat_source(cache_dir).unwrap();

        let outcome = manager
            .ingest_kchat_backfill_page(
                cache_dir,
                &[make_post_input(cache_dir, "p-2", "ch", "u", "body two")],
            )
            .unwrap();
        assert_eq!(
            outcome,
            KchatBackfillIngestOutcome::AccessRevoked {
                source_id: added.source.id,
            }
        );

        // State reflects the revocation; cursor was NOT advanced
        // to p-2 (the cryptoshred would have wiped it anyway, but
        // the substrate must not silently move the cursor past a
        // post it never durably ingested).
        let state = manager.kchat_backfill_state(cache_dir).unwrap();
        match state {
            KchatBackfillState::AccessRevoked { source_id } => {
                assert_eq!(source_id, added.source.id);
            }
            other => panic!("expected AccessRevoked, got {other:?}"),
        }
    }

    /// Cryptoshred-on-revoke extension: the
    /// `cryptoshred_kchat_source_evidence` path clears the
    /// backfill cursor + completion sentinel inside the same
    /// transaction as the chunks/files/posts/DEK deletes. A
    /// future re-grant on the same source starts the walk fresh.
    #[test]
    fn cryptoshred_clears_kchat_backfill_state() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();

        // Advance cursor + mark complete so we can verify both
        // columns get cleared.
        let page = vec![make_post_input(cache_dir, "p", "ch", "u", "body")];
        let _ = manager
            .ingest_kchat_backfill_page(cache_dir, &page)
            .unwrap();
        let _ = manager.mark_kchat_backfill_complete(cache_dir).unwrap();

        // Pre-revoke state has cursor + completed_at populated.
        let pre = manager
            .store
            .kchat_backfill_state(&added.source.id)
            .unwrap();
        let (pre_cursor, pre_completed) = pre.expect("source row must exist");
        assert!(pre_cursor.is_some());
        assert!(pre_completed.is_some());

        // Cryptoshred via the manager (matches the
        // `revoke_kchat_source` flow).
        let _ = manager.revoke_kchat_source(cache_dir).unwrap();

        // Post-revoke: both columns are cleared.
        let post = manager
            .store
            .kchat_backfill_state(&added.source.id)
            .unwrap();
        let (post_cursor, post_completed) =
            post.expect("source row must still exist (status=revoked)");
        assert_eq!(post_cursor, None);
        assert_eq!(post_completed, None);
    }

    // ----------------------------------------------------------------
    // KChat post retrieval bridge
    // ----------------------------------------------------------------

    /// Happy path: ingest a couple of post bodies, search for a
    /// term that hits one of them, confirm we get back exactly the
    /// expected hit with all metadata fields populated.
    #[test]
    fn search_kchat_posts_returns_matching_post_with_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();

        let post_a = make_post_input(
            cache_dir,
            "post-A",
            "channel-Z",
            "user-author",
            "the quarterly launch plan needs review",
        );
        let post_b = make_post_input(
            cache_dir,
            "post-B",
            "channel-Z",
            "user-other",
            "lunch plans for friday",
        );
        manager.ingest_kchat_post(&post_a).unwrap();
        manager.ingest_kchat_post(&post_b).unwrap();

        let hits = manager.search_kchat_posts("quarterly launch", 10).unwrap();
        assert_eq!(
            hits.len(),
            1,
            "expected exactly one hit for quarterly+launch"
        );
        let hit = &hits[0];
        assert_eq!(hit.source_id, added.source.id);
        assert_eq!(hit.source_path, cache_dir);
        assert_eq!(hit.post_id, "post-A");
        assert_eq!(hit.channel_id, "channel-Z");
        assert_eq!(hit.sender_user_id, "user-author");
        assert_eq!(hit.created_at_ms, 1_700_000_000_000);
        assert!(
            hit.content.contains("quarterly") && hit.content.contains("launch"),
            "content must carry the AEAD-verified plaintext (got {:?})",
            hit.content
        );
        assert!(
            hit.excerpt.to_lowercase().contains("quarterly")
                || hit.excerpt.to_lowercase().contains("launch"),
            "excerpt must focus on the query term"
        );
        assert!(
            hit.relevance > 0.0 && hit.relevance <= 1.0,
            "relevance must be a 1-based reciprocal rank in (0, 1]"
        );
    }

    /// Empty-query / all-stopword-query short-circuit: no SQL round
    /// trip, no hits.
    #[test]
    fn search_kchat_posts_empty_query_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let _added = manager.add_kchat_channel(cache_dir).unwrap();
        manager
            .ingest_kchat_post(&make_post_input(
                cache_dir,
                "p",
                "c",
                "u",
                "any plain body content here",
            ))
            .unwrap();

        let hits_blank = manager.search_kchat_posts("", 10).unwrap();
        assert!(hits_blank.is_empty(), "blank query must short-circuit");

        let hits_stop = manager.search_kchat_posts("the and of", 10).unwrap();
        assert!(
            hits_stop.is_empty(),
            "all-stopword query must short-circuit (was {:?})",
            hits_stop
        );
    }

    /// Block B Task 3 ACL gate: a revoked source's chunks must NOT
    /// surface in `search_kchat_posts`, even if the FTS5 index
    /// still has the tokens. The revoke path cryptoshreds chunks
    /// too — this test verifies BOTH gates (status filter + DEK
    /// drop) hold by leaning on the existing
    /// `revoke_kchat_source` plumbing.
    #[test]
    fn search_kchat_posts_excludes_revoked_sources() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager.set_kchat_principal("self-user").unwrap();
        let _added = manager.add_kchat_channel(cache_dir).unwrap();
        manager
            .ingest_kchat_post(&make_post_input(
                cache_dir,
                "p-revoked",
                "c-revoked",
                "u-revoked",
                "tangerine grapefruit pomelo citrus",
            ))
            .unwrap();

        // Confirm the post is findable before revoke.
        let pre = manager.search_kchat_posts("tangerine", 10).unwrap();
        assert_eq!(pre.len(), 1, "pre-revoke must surface the hit");

        // Revoke — this both flips status AND cryptoshreds chunks
        // + DEK row.
        let _ = manager.revoke_kchat_source(cache_dir).unwrap();

        let post = manager.search_kchat_posts("tangerine", 10).unwrap();
        assert!(
            post.is_empty(),
            "post-revoke must surface no hits (got {:?})",
            post.iter().map(|h| h.post_id.as_str()).collect::<Vec<_>>()
        );
    }

    /// Defence-in-depth: tampering with the plaintext `content`
    /// column (e.g. an attacker swapping a row's plaintext without
    /// re-encrypting the AEAD copy) must cause the hit to be
    /// dropped. The plaintext-vs-AEAD comparison in
    /// `search_kchat_posts` is the only thing standing between
    /// "FTS5 matched on tampered text" and "tampered text reaches
    /// the renderer".
    #[test]
    fn search_kchat_posts_drops_aead_mismatched_rows() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager.add_kchat_channel(cache_dir).unwrap();
        manager
            .ingest_kchat_post(&make_post_input(
                cache_dir,
                "p-tamper",
                "c",
                "u",
                "indigo violet ultraviolet xenon yttrium",
            ))
            .unwrap();

        // Pre-tamper: hit returns.
        let pre = manager.search_kchat_posts("ultraviolet", 10).unwrap();
        assert_eq!(pre.len(), 1);

        // Tamper the plaintext `content` column directly via the
        // store's raw connection. We swap the chunk text for one
        // that ALSO contains `ultraviolet` so the FTS5 MATCH still
        // returns the row — only the AEAD-comparison gate can
        // catch the swap.
        manager
            .store
            .tamper_chunk_content_for_test("ultraviolet attacker tampered text payload")
            .unwrap();

        let post = manager.search_kchat_posts("ultraviolet", 10).unwrap();
        assert!(
            post.is_empty(),
            "tampered chunk must not reach the renderer (got {:?})",
            post.iter().map(|h| h.content.as_str()).collect::<Vec<_>>()
        );
    }

    /// Cross-source partitioning: each KChat-channel source has
    /// its own DEK + its own AEAD AAD (the source_id is bound into
    /// the AAD by `chunk_aad`). A search must surface a hit from
    /// each source independently — confirming that the per-source
    /// DEK-load cache key in `search_kchat_posts` is keyed
    /// correctly.
    #[test]
    fn search_kchat_posts_surfaces_hits_across_multiple_sources() {
        let dir1 = tempfile::tempdir().unwrap();
        let dir2 = tempfile::tempdir().unwrap();
        let cd1 = dir1.path().to_str().unwrap();
        let cd2 = dir2.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let a1 = manager.add_kchat_channel(cd1).unwrap();
        let a2 = manager.add_kchat_channel(cd2).unwrap();

        manager
            .ingest_kchat_post(&make_post_input(
                cd1,
                "p1",
                "c1",
                "u1",
                "zephyr alpha bravo charlie",
            ))
            .unwrap();
        manager
            .ingest_kchat_post(&make_post_input(
                cd2,
                "p2",
                "c2",
                "u2",
                "zephyr delta echo foxtrot",
            ))
            .unwrap();

        let hits = manager.search_kchat_posts("zephyr", 10).unwrap();
        assert_eq!(hits.len(), 2, "both sources must surface");
        let by_source: std::collections::HashSet<_> = hits.iter().map(|h| h.source_id).collect();
        assert!(by_source.contains(&a1.source.id));
        assert!(by_source.contains(&a2.source.id));
    }

    /// Limit semantics: when more rows match than the caller's
    /// limit, the BM25 ordering applied by the store-layer
    /// `LIMIT ?2` keeps the top-N — and our reciprocal-rank
    /// post-processing assigns 1.0, 0.5, ... to that order.
    #[test]
    fn search_kchat_posts_honors_limit_and_reciprocal_rank() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager.add_kchat_channel(cache_dir).unwrap();
        for i in 0..6 {
            manager
                .ingest_kchat_post(&make_post_input(
                    cache_dir,
                    &format!("p{i}"),
                    "c",
                    "u",
                    &format!("kiwi mango pineapple round-{i}"),
                ))
                .unwrap();
        }

        let hits = manager.search_kchat_posts("kiwi", 3).unwrap();
        assert_eq!(hits.len(), 3, "limit must cap the returned vec");
        assert!(
            (hits[0].relevance - 1.0).abs() < 1e-9,
            "first hit must have relevance 1.0 (got {})",
            hits[0].relevance
        );
        assert!(
            (hits[1].relevance - 0.5).abs() < 1e-9,
            "second hit must have relevance 0.5 (got {})",
            hits[1].relevance
        );
        // Strictly decreasing.
        assert!(hits[0].relevance > hits[1].relevance);
        assert!(hits[1].relevance > hits[2].relevance);
    }

    // ----------------------------------------------------------------
    // KChat thread context retrieval
    // ----------------------------------------------------------------

    /// Convenience: build a `KchatPostIngestInput` for a thread
    /// reply at a specific timestamp. The default `make_post_input`
    /// pins everything at `1_700_000_000_000` which prevents
    /// thread-ordering tests from distinguishing replies.
    fn make_threaded_post_input(
        cache_dir: &str,
        post_id: &str,
        channel_id: &str,
        root_id: Option<&str>,
        sender: &str,
        body: &str,
        created_at_ms: i64,
    ) -> KchatPostIngestInput {
        KchatPostIngestInput {
            cache_dir: cache_dir.to_string(),
            post_id: post_id.to_string(),
            channel_id: channel_id.to_string(),
            root_id: root_id.map(str::to_string),
            sender_user_id: sender.to_string(),
            body: body.to_string(),
            created_at_ms,
            edited_at_ms: 0,
        }
    }

    /// Happy path: a thread with a root + 2 earlier replies, the
    /// caller looks up context for the latest reply. Expect the
    /// chronological transcript `[root, reply_1, reply_2]` with the
    /// `is_root` flag distinguishing the first row.
    #[test]
    fn fetch_kchat_thread_context_returns_root_and_earlier_replies() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();
        let source_id = added.source.id;

        let t0 = 1_700_000_000_000_i64;
        let root = make_threaded_post_input(
            cache_dir,
            "root-1",
            "channel-X",
            None,
            "alice",
            "we should ship the launch plan by friday",
            t0,
        );
        let reply_1 = make_threaded_post_input(
            cache_dir,
            "reply-1",
            "channel-X",
            Some("root-1"),
            "bob",
            "+1, lets also include the migration runbook",
            t0 + 60_000,
        );
        let reply_2 = make_threaded_post_input(
            cache_dir,
            "reply-2",
            "channel-X",
            Some("root-1"),
            "carol",
            "i can draft the runbook by wednesday",
            t0 + 120_000,
        );
        let reply_3 = make_threaded_post_input(
            cache_dir,
            "reply-3",
            "channel-X",
            Some("root-1"),
            "alice",
            "great, lets do a review on thursday",
            t0 + 180_000,
        );
        manager.ingest_kchat_post(&root).unwrap();
        manager.ingest_kchat_post(&reply_1).unwrap();
        manager.ingest_kchat_post(&reply_2).unwrap();
        manager.ingest_kchat_post(&reply_3).unwrap();

        let ctx = manager
            .fetch_kchat_thread_context(&source_id, "reply-3")
            .unwrap();

        assert_eq!(
            ctx.len(),
            3,
            "expected root + 2 most-recent earlier-replies (got {:?})",
            ctx.iter().map(|m| m.post_id.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(
            ctx[0].post_id, "root-1",
            "root must come first chronologically"
        );
        assert!(ctx[0].is_root, "first row must carry is_root=true");
        assert_eq!(ctx[1].post_id, "reply-1");
        assert!(!ctx[1].is_root, "sibling rows must carry is_root=false");
        assert_eq!(ctx[2].post_id, "reply-2");
        assert!(!ctx[2].is_root);

        // Content is AEAD-verified plaintext — substrate must
        // never surface unverified bytes.
        assert!(ctx[0].content.contains("launch plan"));
        assert!(ctx[1].content.contains("migration runbook"));
        assert!(ctx[2].content.contains("draft the runbook"));

        // Timestamps strictly increasing (chronological order).
        assert!(ctx[0].created_at_ms < ctx[1].created_at_ms);
        assert!(ctx[1].created_at_ms < ctx[2].created_at_ms);
        assert!(
            ctx[2].created_at_ms < t0 + 180_000,
            "hit's own row must be excluded"
        );

        // Channel id surfaces for renderer permalink composition.
        for m in &ctx {
            assert_eq!(m.channel_id, "channel-X");
        }
    }

    /// Top-level post (root_id IS NULL) has no thread to surface
    /// — must return an empty vec, never an error.
    #[test]
    fn fetch_kchat_thread_context_for_top_level_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();
        let source_id = added.source.id;

        manager
            .ingest_kchat_post(&make_post_input(
                cache_dir,
                "solo-1",
                "channel-Y",
                "alice",
                "standalone top-level announcement",
            ))
            .unwrap();

        let ctx = manager
            .fetch_kchat_thread_context(&source_id, "solo-1")
            .unwrap();
        assert!(
            ctx.is_empty(),
            "top-level post must surface no thread context (got {:?})",
            ctx.iter().map(|m| m.post_id.as_str()).collect::<Vec<_>>()
        );
    }

    /// Unknown post id — renderer might be holding a stale id
    /// after a cryptoshred + re-ingest. Must surface as an empty
    /// vec (no panic, no error) so the UI degrades to "no thread".
    #[test]
    fn fetch_kchat_thread_context_for_unknown_post_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();
        let source_id = added.source.id;

        let ctx = manager
            .fetch_kchat_thread_context(&source_id, "nonexistent-post-id")
            .unwrap();
        assert!(
            ctx.is_empty(),
            "unknown post must surface no thread context"
        );
    }

    /// `(source_id, post_id)` is the lookup key — a post in a
    /// DIFFERENT source must not surface even if a same-named
    /// post id exists. The DEK gate at the manager would also
    /// drop the wrong source's rows, but the SQL filter is the
    /// first line of defence.
    #[test]
    fn fetch_kchat_thread_context_for_unknown_source_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let _ = manager.add_kchat_channel(cache_dir).unwrap();
        manager
            .ingest_kchat_post(&make_threaded_post_input(
                cache_dir,
                "reply",
                "c",
                Some("root"),
                "u",
                "body",
                1_700_000_000_000,
            ))
            .unwrap();

        let bogus = SourceId(uuid::Uuid::new_v4());
        let ctx = manager.fetch_kchat_thread_context(&bogus, "reply").unwrap();
        assert!(
            ctx.is_empty(),
            "unknown source must surface no thread context"
        );
    }

    /// Cap-at-3 semantics: a thread with the root + 6 earlier
    /// replies, the caller looks up context for the latest reply.
    /// Expect exactly 3 rows: the root + the 2 most-recent earlier
    /// siblings (the others, chronologically further from the hit,
    /// are excluded).
    #[test]
    fn fetch_kchat_thread_context_caps_at_three_rows() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();
        let source_id = added.source.id;

        let t0 = 1_700_000_000_000_i64;
        manager
            .ingest_kchat_post(&make_threaded_post_input(
                cache_dir,
                "root",
                "c",
                None,
                "u0",
                "thread starts here",
                t0,
            ))
            .unwrap();
        for i in 1..=6 {
            manager
                .ingest_kchat_post(&make_threaded_post_input(
                    cache_dir,
                    &format!("r{i}"),
                    "c",
                    Some("root"),
                    &format!("u{i}"),
                    &format!("reply body {i}"),
                    t0 + (i as i64) * 60_000,
                ))
                .unwrap();
        }
        // r7 is the hit — its context window should be root + r5 + r6
        // (the 2 most-recent earlier-replies before r7).
        manager
            .ingest_kchat_post(&make_threaded_post_input(
                cache_dir,
                "r7",
                "c",
                Some("root"),
                "u7",
                "hit body 7",
                t0 + 7 * 60_000,
            ))
            .unwrap();

        let ctx = manager
            .fetch_kchat_thread_context(&source_id, "r7")
            .unwrap();
        assert_eq!(ctx.len(), 3, "must cap at 3 rows");
        let ids: Vec<&str> = ctx.iter().map(|m| m.post_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["root", "r5", "r6"],
            "expected root + 2 most-recent earlier siblings (got {ids:?})"
        );
        assert!(ctx[0].is_root, "root must be flagged");
        assert!(!ctx[1].is_root);
        assert!(!ctx[2].is_root);
    }

    /// If the thread root itself was never indexed (e.g. backfill
    /// hasn't reached that far back, or the root was deleted),
    /// the lookup falls back to surfacing the most-recent
    /// earlier-replies alone. No is_root row in the result.
    #[test]
    fn fetch_kchat_thread_context_omits_unindexed_root() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();
        let source_id = added.source.id;

        let t0 = 1_700_000_000_000_i64;
        // NO ingest of "root" — only the replies.
        manager
            .ingest_kchat_post(&make_threaded_post_input(
                cache_dir,
                "r1",
                "c",
                Some("root"),
                "u1",
                "first orphan reply",
                t0,
            ))
            .unwrap();
        manager
            .ingest_kchat_post(&make_threaded_post_input(
                cache_dir,
                "r2",
                "c",
                Some("root"),
                "u2",
                "second orphan reply",
                t0 + 60_000,
            ))
            .unwrap();

        let ctx = manager
            .fetch_kchat_thread_context(&source_id, "r2")
            .unwrap();
        assert_eq!(
            ctx.len(),
            1,
            "should surface only the indexed earlier sibling"
        );
        assert_eq!(ctx[0].post_id, "r1");
        assert!(
            !ctx[0].is_root,
            "no row should claim is_root when root absent"
        );
    }

    /// Revoked source: the DEK is cryptoshredded so no thread
    /// context can be AEAD-verified — must surface as empty.
    #[test]
    fn fetch_kchat_thread_context_excludes_revoked_source() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager.set_kchat_principal("self-user").unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();
        let source_id = added.source.id;

        let t0 = 1_700_000_000_000_i64;
        manager
            .ingest_kchat_post(&make_threaded_post_input(
                cache_dir,
                "rev-root",
                "rev-c",
                None,
                "u0",
                "revoke-test root body",
                t0,
            ))
            .unwrap();
        manager
            .ingest_kchat_post(&make_threaded_post_input(
                cache_dir,
                "rev-reply",
                "rev-c",
                Some("rev-root"),
                "u1",
                "revoke-test reply body",
                t0 + 60_000,
            ))
            .unwrap();

        // Confirm pre-revoke the context is non-empty.
        let pre = manager
            .fetch_kchat_thread_context(&source_id, "rev-reply")
            .unwrap();
        assert!(!pre.is_empty(), "pre-revoke must surface context");

        let _ = manager.revoke_kchat_source(cache_dir).unwrap();
        let post = manager
            .fetch_kchat_thread_context(&source_id, "rev-reply")
            .unwrap();
        assert!(
            post.is_empty(),
            "post-revoke must surface no context (got {:?})",
            post.iter().map(|m| m.post_id.as_str()).collect::<Vec<_>>()
        );
    }

    /// AEAD-divergence: tamper with the `chunks.content` column of
    /// one context message so the indexed plaintext no longer
    /// matches the AEAD-opened bytes. That row must be dropped
    /// from the result; the honest siblings must still surface.
    #[test]
    fn fetch_kchat_thread_context_drops_aead_tampered_rows() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();
        let source_id = added.source.id;

        let t0 = 1_700_000_000_000_i64;
        manager
            .ingest_kchat_post(&make_threaded_post_input(
                cache_dir,
                "tamper-root",
                "tc",
                None,
                "u0",
                "honest root body",
                t0,
            ))
            .unwrap();
        manager
            .ingest_kchat_post(&make_threaded_post_input(
                cache_dir,
                "tamper-r1",
                "tc",
                Some("tamper-root"),
                "u1",
                "honest sibling body",
                t0 + 60_000,
            ))
            .unwrap();
        manager
            .ingest_kchat_post(&make_threaded_post_input(
                cache_dir,
                "tamper-r2",
                "tc",
                Some("tamper-root"),
                "u2",
                "the-hit body",
                t0 + 120_000,
            ))
            .unwrap();

        // Tamper the root's plaintext column out-of-band. The AEAD
        // ciphertext still authenticates as "honest root body"
        // but the indexed `content` now reads something else;
        // the manager's plaintext-divergence check must drop it.
        let n = manager
            .store
            .tamper_chunk_content_for_post_test(&source_id, "tamper-root", "TAMPERED BODY")
            .unwrap();
        assert_eq!(n, 1, "exactly one chunk row should have been tampered");

        let ctx = manager
            .fetch_kchat_thread_context(&source_id, "tamper-r2")
            .unwrap();
        let ids: Vec<&str> = ctx.iter().map(|m| m.post_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["tamper-r1"],
            "tampered root must be dropped; honest sibling must remain (got {ids:?})"
        );
    }

    /// The lookup's `before_created_at_ms` filter excludes the
    /// hit's own row from the result — defence against a
    /// self-referential lookup that would otherwise return the
    /// hit as its own parent.
    #[test]
    fn fetch_kchat_thread_context_excludes_the_hit_itself() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();
        let source_id = added.source.id;

        let t0 = 1_700_000_000_000_i64;
        manager
            .ingest_kchat_post(&make_threaded_post_input(
                cache_dir,
                "rt",
                "c",
                None,
                "u0",
                "root body",
                t0,
            ))
            .unwrap();
        // The hit IS the only reply; its created_at_ms is the
        // lookup's exclusive upper bound, so the hit's own row is
        // not eligible.
        manager
            .ingest_kchat_post(&make_threaded_post_input(
                cache_dir,
                "rh",
                "c",
                Some("rt"),
                "u1",
                "the-only-reply body",
                t0 + 60_000,
            ))
            .unwrap();

        let ctx = manager
            .fetch_kchat_thread_context(&source_id, "rh")
            .unwrap();
        let ids: Vec<&str> = ctx.iter().map(|m| m.post_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["rt"],
            "self-exclusion must keep the hit out of its own context (got {ids:?})"
        );
    }

    // ----------------------------------------------------------------
    // AEAD full-lifecycle round-trip
    // ----------------------------------------------------------------

    /// Full-lifecycle round-trip: ingest → search → cryptoshred →
    /// verify DEK gone → re-grant → re-ingest → search again.
    ///
    /// End-to-end KChat post ingest AEAD round-trip (post → DEK →
    /// ciphertext → decrypt → cryptoshred). Existing tests cover
    /// individual stages (e.g. `ingest_kchat_post_seals_chunks_and_
    /// persists_dek` tests ingest + seal + open; `search_kchat_posts_
    /// excludes_revoked_sources` tests revoke-then-search). This test
    /// proves the invariant across the COMPLETE lifecycle: data that
    /// was cryptographically erased can never resurface, and the
    /// substrate recovers cleanly into a functional state after a
    /// cryptoshred + re-grant.
    #[test]
    fn kchat_aead_full_lifecycle_ingest_search_cryptoshred_regrant() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager.set_kchat_principal("self-user").unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();
        let source_id = added.source.id;

        // ── Phase 1: ingest two posts, verify DEK + AEAD round-trip ──

        let post_alpha = make_post_input(
            cache_dir,
            "pa-lifecycle",
            "ch-lifecycle",
            "u-alice",
            "rhodium palladium osmium iridium platinum",
        );
        let post_beta = make_post_input(
            cache_dir,
            "pb-lifecycle",
            "ch-lifecycle",
            "u-bob",
            "ruthenium rhodium rhenium technetium molybdenum",
        );
        let outcome_a = manager.ingest_kchat_post(&post_alpha).unwrap();
        let outcome_b = manager.ingest_kchat_post(&post_beta).unwrap();

        let chunk_ids_a = match &outcome_a {
            KchatPostIngestOutcome::Ingested { chunk_ids, .. } => chunk_ids.clone(),
            other => panic!("expected Ingested for alpha, got {other:?}"),
        };
        let chunk_ids_b = match &outcome_b {
            KchatPostIngestOutcome::Ingested { chunk_ids, .. } => chunk_ids.clone(),
            other => panic!("expected Ingested for beta, got {other:?}"),
        };

        // DEK row exists.
        let wrapped_pre = manager
            .store
            .load_wrapped_dek_for_source(&source_id)
            .unwrap();
        assert!(
            wrapped_pre.is_some(),
            "wrapped DEK must be persisted after ingest"
        );

        // AEAD round-trip: every chunk decrypts to non-empty plaintext.
        for chunk_id in chunk_ids_a.iter().chain(chunk_ids_b.iter()) {
            let sealed = manager
                .store
                .load_chunk_aead(*chunk_id)
                .unwrap()
                .expect("AEAD blob must be persisted");
            let pt = manager
                .kchat_crypto()
                .open_chunk(&source_id, &sealed)
                .expect("AEAD must decrypt under the source DEK");
            assert!(!pt.is_empty(), "decrypted plaintext must be non-empty");
        }

        // ── Phase 2: search returns both posts ──

        let hits_pre = manager.search_kchat_posts("rhodium", 10).unwrap();
        assert_eq!(
            hits_pre.len(),
            2,
            "pre-cryptoshred: both posts contain 'rhodium' and must surface"
        );
        for hit in &hits_pre {
            assert!(
                hit.content.contains("rhodium"),
                "hit content must carry the AEAD-verified plaintext"
            );
        }

        // ── Phase 3: cryptoshred via revoke ──

        // Save a sealed chunk from before the shred so we can prove it
        // is undecryptable after the DEK is destroyed.
        let sealed_before_shred = manager
            .store
            .load_chunk_aead(chunk_ids_a[0])
            .unwrap()
            .expect("pre-shred: chunk AEAD must still exist");

        let revoke_outcome = manager.revoke_kchat_source(cache_dir).unwrap();
        assert!(
            matches!(
                revoke_outcome,
                KchatRevokeOutcome::Revoked {
                    chunks_dropped, ..
                } if chunks_dropped > 0
            ),
            "revoke must cryptoshred chunks (got {revoke_outcome:?})"
        );

        // DEK row gone from store.
        let wrapped_post = manager
            .store
            .load_wrapped_dek_for_source(&source_id)
            .unwrap();
        assert!(
            wrapped_post.is_none(),
            "wrapped DEK row must be deleted after cryptoshred"
        );

        // In-memory DEK cache evicted.
        assert_eq!(
            manager.kchat_crypto().cache_size(),
            0,
            "in-memory DEK cache must be empty after cryptoshred"
        );

        // The saved sealed chunk is now undecryptable: the DEK is gone.
        let open_err = manager
            .kchat_crypto()
            .open_chunk(&source_id, &sealed_before_shred);
        assert!(
            open_err.is_err(),
            "opening a sealed chunk after DEK destruction must fail"
        );

        // ── Phase 4: search returns nothing ──

        let hits_post_shred = manager.search_kchat_posts("rhodium", 10).unwrap();
        assert!(
            hits_post_shred.is_empty(),
            "post-cryptoshred: no hits must surface (got {} hits)",
            hits_post_shred.len()
        );

        // ── Phase 5: re-grant the source ──

        let regrant = manager
            .refresh_kchat_acl(cache_dir, &[make_acl_member("self-user", "channel_admin")])
            .unwrap();
        assert_eq!(
            regrant,
            KchatAclRefreshOutcome::Regranted,
            "ACL refresh with principal present must re-grant"
        );
        let source_after = manager.get_source(&source_id).unwrap();
        assert_eq!(
            source_after.status,
            SourceStatus::Connected,
            "re-granted source should be Connected (not Indexed — content was shredded)"
        );

        // No DEK exists yet for the re-granted source (the old one was
        // shredded; a new one is generated on next ingest).
        let wrapped_regranted = manager
            .store
            .load_wrapped_dek_for_source(&source_id)
            .unwrap();
        assert!(
            wrapped_regranted.is_none(),
            "no DEK until new content is ingested post-regrant"
        );

        // ── Phase 6: re-ingest a new post under the fresh DEK ──

        let post_gamma = KchatPostIngestInput {
            cache_dir: cache_dir.to_string(),
            post_id: "pg-lifecycle".to_string(),
            channel_id: "ch-lifecycle".to_string(),
            root_id: None,
            sender_user_id: "u-charlie".to_string(),
            body: "rhodium is a transition metal element".to_string(),
            created_at_ms: 1_700_000_001_000,
            edited_at_ms: 0,
        };
        let outcome_g = manager.ingest_kchat_post(&post_gamma).unwrap();
        let chunk_ids_g = match &outcome_g {
            KchatPostIngestOutcome::Ingested { chunk_ids, .. } => chunk_ids.clone(),
            other => panic!("expected Ingested for gamma, got {other:?}"),
        };

        // New DEK generated.
        let wrapped_new = manager
            .store
            .load_wrapped_dek_for_source(&source_id)
            .unwrap();
        assert!(
            wrapped_new.is_some(),
            "new DEK must be generated on first ingest post-regrant"
        );

        // New AEAD round-trips under the new DEK.
        for chunk_id in &chunk_ids_g {
            let sealed = manager
                .store
                .load_chunk_aead(*chunk_id)
                .unwrap()
                .expect("post-regrant chunk must have AEAD blob");
            let pt = manager
                .kchat_crypto()
                .open_chunk(&source_id, &sealed)
                .expect("post-regrant AEAD must decrypt under new DEK");
            assert!(
                !pt.is_empty(),
                "post-regrant decrypted plaintext must be non-empty"
            );
        }

        // The pre-shred sealed chunk STILL fails to open (the new DEK
        // is different from the old one — the old one was randomly
        // generated and is now gone).
        let open_err_again = manager
            .kchat_crypto()
            .open_chunk(&source_id, &sealed_before_shred);
        assert!(
            open_err_again.is_err(),
            "pre-shred ciphertext must remain undecryptable even after re-grant (new DEK differs)"
        );

        // ── Phase 7: search returns only the new post ──

        let hits_final = manager.search_kchat_posts("rhodium", 10).unwrap();
        assert_eq!(
            hits_final.len(),
            1,
            "only the post-regrant post must surface (got {:?})",
            hits_final
                .iter()
                .map(|h| h.post_id.as_str())
                .collect::<Vec<_>>()
        );
        assert_eq!(hits_final[0].post_id, "pg-lifecycle");
        assert!(
            hits_final[0].content.contains("rhodium"),
            "post-regrant hit must carry AEAD-verified plaintext"
        );
    }

    /// Thread-context retrieval across the cryptoshred boundary:
    /// after a source is cryptoshredded and then re-granted with
    /// new content, `fetch_kchat_thread_context` must return only
    /// messages sealed under the current DEK, not ghosts from the
    /// pre-shred era.
    #[test]
    fn kchat_aead_thread_context_survives_cryptoshred_cycle() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager.set_kchat_principal("self-user").unwrap();
        let added = manager.add_kchat_channel(cache_dir).unwrap();
        let source_id = added.source.id;

        // Pre-shred: ingest a thread (root + reply).
        manager
            .ingest_kchat_post(&KchatPostIngestInput {
                cache_dir: cache_dir.to_string(),
                post_id: "root-pre".to_string(),
                channel_id: "ch-ctx".to_string(),
                root_id: None,
                sender_user_id: "u-x".to_string(),
                body: "hafnium zirconium titanium".to_string(),
                created_at_ms: 1_000,
                edited_at_ms: 0,
            })
            .unwrap();
        manager
            .ingest_kchat_post(&KchatPostIngestInput {
                cache_dir: cache_dir.to_string(),
                post_id: "reply-pre".to_string(),
                channel_id: "ch-ctx".to_string(),
                root_id: Some("root-pre".to_string()),
                sender_user_id: "u-y".to_string(),
                body: "niobium tantalum vanadium".to_string(),
                created_at_ms: 2_000,
                edited_at_ms: 0,
            })
            .unwrap();

        // Thread context works pre-shred.
        let ctx_pre = manager
            .fetch_kchat_thread_context(&source_id, "reply-pre")
            .unwrap();
        assert_eq!(
            ctx_pre.len(),
            1,
            "pre-shred: root must appear as context for the reply"
        );
        assert_eq!(ctx_pre[0].post_id, "root-pre");

        // Cryptoshred.
        manager.revoke_kchat_source(cache_dir).unwrap();

        // Thread context returns empty after shred (DEK gone).
        let ctx_shredded = manager
            .fetch_kchat_thread_context(&source_id, "reply-pre")
            .unwrap();
        assert!(
            ctx_shredded.is_empty(),
            "post-shred: no thread context must be returned"
        );

        // Re-grant.
        manager
            .refresh_kchat_acl(cache_dir, &[make_acl_member("self-user", "channel_admin")])
            .unwrap();

        // Re-ingest a new thread.
        manager
            .ingest_kchat_post(&KchatPostIngestInput {
                cache_dir: cache_dir.to_string(),
                post_id: "root-post".to_string(),
                channel_id: "ch-ctx".to_string(),
                root_id: None,
                sender_user_id: "u-z".to_string(),
                body: "scandium yttrium lanthanum".to_string(),
                created_at_ms: 3_000,
                edited_at_ms: 0,
            })
            .unwrap();
        manager
            .ingest_kchat_post(&KchatPostIngestInput {
                cache_dir: cache_dir.to_string(),
                post_id: "reply-post".to_string(),
                channel_id: "ch-ctx".to_string(),
                root_id: Some("root-post".to_string()),
                sender_user_id: "u-w".to_string(),
                body: "cerium praseodymium neodymium".to_string(),
                created_at_ms: 4_000,
                edited_at_ms: 0,
            })
            .unwrap();

        // Thread context works for the new thread under the new DEK.
        let ctx_post = manager
            .fetch_kchat_thread_context(&source_id, "reply-post")
            .unwrap();
        assert_eq!(
            ctx_post.len(),
            1,
            "post-regrant: root of the new thread must appear as context"
        );
        assert_eq!(ctx_post[0].post_id, "root-post");
        assert!(
            ctx_post[0].content.contains("scandium"),
            "post-regrant context must carry AEAD-verified new-DEK plaintext"
        );
    }

    // ----------------------------------------------------------------
    // Hybrid search ordering + revocation
    // ----------------------------------------------------------------

    /// The reciprocal-rank scoring contract between file-search and
    /// KChat-post-search is that both produce scores in (0, 1]:
    /// `1.0 / (rank + 1.0)` where rank is 0-based position within
    /// the returned vec. A renderer that interleaves file hits and
    /// post hits can sort by `relevance` desc to produce a single
    /// merged ranking without distinguishing hit types. This test
    /// verifies both search methods produce scores on the same axis.
    #[test]
    fn search_scoring_axis_is_consistent_between_files_and_kchat_posts() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        // Create a doc file so the folder source has content.
        std::fs::write(
            dir.path().join("doc.txt"),
            "beryllium magnesium calcium strontium barium radium",
        )
        .unwrap();

        let manager = SourceManager::new_in_memory(&[]).unwrap();
        // Add a file source (index the folder).
        manager
            .add_local_folder(dir.path().to_str().unwrap())
            .unwrap();
        // Add a KChat source and ingest posts.
        let _added = manager.add_kchat_channel(cache_dir).unwrap();
        for i in 0..3 {
            manager
                .ingest_kchat_post(&make_post_input(
                    cache_dir,
                    &format!("p-axis-{i}"),
                    "c-axis",
                    "u-axis",
                    &format!("beryllium strontium element-{i} alkaline earth metal"),
                ))
                .unwrap();
        }

        // File search (hybrid engine).
        let file_hits = manager.search("beryllium", 10).unwrap();
        assert!(
            !file_hits.is_empty(),
            "file search must find the indexed txt"
        );
        // KChat post search.
        let post_hits = manager.search_kchat_posts("beryllium", 10).unwrap();
        assert_eq!(
            post_hits.len(),
            3,
            "post search must find all 3 ingested posts"
        );

        // Both use the same reciprocal rank formula.
        assert!(
            (file_hits[0].relevance - 1.0).abs() < 1e-9,
            "first file hit must be 1.0 (got {})",
            file_hits[0].relevance
        );
        assert!(
            (post_hits[0].relevance - 1.0).abs() < 1e-9,
            "first post hit must be 1.0 (got {})",
            post_hits[0].relevance
        );
        assert!(
            (post_hits[1].relevance - 0.5).abs() < 1e-9,
            "second post hit must be 0.5 (got {})",
            post_hits[1].relevance
        );
        assert!(
            (post_hits[2].relevance - (1.0 / 3.0)).abs() < 1e-9,
            "third post hit must be 1/3 (got {})",
            post_hits[2].relevance
        );

        // All scores are in (0, 1].
        for hit in &file_hits {
            assert!(
                hit.relevance > 0.0 && hit.relevance <= 1.0,
                "file hit score must be in (0, 1] (got {})",
                hit.relevance
            );
        }
        for hit in &post_hits {
            assert!(
                hit.relevance > 0.0 && hit.relevance <= 1.0,
                "post hit score must be in (0, 1] (got {})",
                hit.relevance
            );
        }
    }

    /// Revocation mid-session: the same `search_kchat_posts` call
    /// returns hits from a source, then that source is revoked, then
    /// the SAME call (no manager re-creation) returns no hits. This
    /// proves the runtime revocation is visible to subsequent queries
    /// without a process restart.
    #[test]
    fn search_kchat_posts_revocation_takes_effect_immediately() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager.set_kchat_principal("self-user").unwrap();
        manager.add_kchat_channel(cache_dir).unwrap();

        manager
            .ingest_kchat_post(&make_post_input(
                cache_dir,
                "p-rev-1",
                "c-rev",
                "u-rev",
                "tungsten wolfram transition metal element",
            ))
            .unwrap();
        manager
            .ingest_kchat_post(&make_post_input(
                cache_dir,
                "p-rev-2",
                "c-rev",
                "u-rev",
                "tungsten filament incandescent bulb",
            ))
            .unwrap();

        // Pre-revoke: both posts surface.
        let pre = manager.search_kchat_posts("tungsten", 10).unwrap();
        assert_eq!(pre.len(), 2, "pre-revoke must surface both hits");

        // Revoke the source (cryptoshred + status flip).
        let outcome = manager.revoke_kchat_source(cache_dir).unwrap();
        assert!(
            matches!(outcome, KchatRevokeOutcome::Revoked { .. }),
            "revoke must succeed"
        );

        // Post-revoke: zero hits from the SAME manager instance.
        let post = manager.search_kchat_posts("tungsten", 10).unwrap();
        assert!(
            post.is_empty(),
            "post-revoke must surface zero hits (got {} hits: {:?})",
            post.len(),
            post.iter().map(|h| h.post_id.as_str()).collect::<Vec<_>>()
        );
    }

    /// BM25 relevance ordering is preserved through AEAD verification:
    /// if two posts have different BM25 scores (one is a closer lexical
    /// match to the query), the BM25-ranked order must survive the
    /// verification pipeline — the AEAD check must not re-order or
    /// drop verified hits that are correctly sealed.
    #[test]
    fn search_kchat_posts_bm25_ordering_preserved_through_verification() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager.add_kchat_channel(cache_dir).unwrap();

        // Post A: high relevance (query terms repeated, exact phrase).
        manager
            .ingest_kchat_post(&make_post_input(
                cache_dir,
                "p-hi",
                "c-ord",
                "u-ord",
                "xenon krypton xenon krypton noble gas element xenon",
            ))
            .unwrap();
        // Post B: lower relevance (query term once, more diluted).
        manager
            .ingest_kchat_post(&make_post_input(
                cache_dir,
                "p-lo",
                "c-ord",
                "u-ord",
                "the atmospheric composition contains traces of xenon alongside nitrogen oxygen argon",
            ))
            .unwrap();

        let hits = manager.search_kchat_posts("xenon krypton", 10).unwrap();
        assert!(
            hits.len() >= 2,
            "both posts must surface (got {})",
            hits.len()
        );
        // The post with repeated query terms should rank higher.
        let pos_hi = hits.iter().position(|h| h.post_id == "p-hi");
        let pos_lo = hits.iter().position(|h| h.post_id == "p-lo");
        assert!(
            pos_hi.is_some() && pos_lo.is_some(),
            "both posts must be present in results"
        );
        assert!(
            pos_hi.unwrap() < pos_lo.unwrap(),
            "higher-BM25-score post must rank before lower-score post \
             (high={:?}, low={:?})",
            pos_hi,
            pos_lo
        );
        // The first hit should have relevance 1.0 (reciprocal rank).
        assert!(
            (hits[0].relevance - 1.0).abs() < 1e-9,
            "top hit must have relevance 1.0"
        );
    }

    /// Cross-source revocation isolation: revoking source A must not
    /// affect posts from source B. After revocation, only source B's
    /// posts surface.
    #[test]
    fn search_kchat_posts_cross_source_revocation_isolation() {
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();
        let cd_a = dir_a.path().to_str().unwrap();
        let cd_b = dir_b.path().to_str().unwrap();
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        manager.set_kchat_principal("self-user").unwrap();
        let added_a = manager.add_kchat_channel(cd_a).unwrap();
        let added_b = manager.add_kchat_channel(cd_b).unwrap();

        manager
            .ingest_kchat_post(&make_post_input(
                cd_a,
                "p-src-a",
                "ch-a",
                "u-a",
                "promethium samarium europium gadolinium",
            ))
            .unwrap();
        manager
            .ingest_kchat_post(&make_post_input(
                cd_b,
                "p-src-b",
                "ch-b",
                "u-b",
                "promethium terbium dysprosium holmium",
            ))
            .unwrap();

        // Both surface before any revoke.
        let pre = manager.search_kchat_posts("promethium", 10).unwrap();
        assert_eq!(pre.len(), 2, "both sources must surface pre-revoke");

        // Revoke source A only.
        manager.revoke_kchat_source(cd_a).unwrap();

        // Only source B's post survives.
        let post = manager.search_kchat_posts("promethium", 10).unwrap();
        assert_eq!(
            post.len(),
            1,
            "only source B must survive (got {:?})",
            post.iter().map(|h| h.post_id.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(post[0].post_id, "p-src-b");
        assert_eq!(post[0].source_id, added_b.source.id);

        // Source A's post is gone.
        assert!(
            !post.iter().any(|h| h.source_id == added_a.source.id),
            "revoked source A must not appear in results"
        );
    }
}
