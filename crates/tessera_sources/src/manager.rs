use std::path::Path;
use std::sync::{Arc, Mutex};
use tessera_core::error::{Error, Result};
use tessera_core::{SharedConnection, SourceId, SourceStatus};

use crate::embedding::{EmbeddingProvider, HashTrickEmbedding};
use crate::hybrid::{HybridSearchConfig, HybridSearchConfigInput};
use crate::indexer::{BackfillOutcome, Indexer};
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
/// Block B Task 3 (Phase 11) splits the result into four cases so
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
    /// removed and then re-added). Status transitioned from
    /// `AccessRevoked` back to `Indexed`. The roster was replaced
    /// atomically. `principal_present == true`.
    Regranted,
    /// The principal is NOT in the refreshed roster. Status
    /// transitioned to `AccessRevoked`. The roster was still
    /// replaced atomically (so a future re-grant via re-add
    /// transitions back to `Indexed`). `principal_present == false`.
    Revoked,
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
    /// `AccessRevoked`.
    Revoked,
    /// The source row was already `AccessRevoked` — no status
    /// change applied. The audit row is still emitted by the
    /// caller so operators see the revoke event in the trail
    /// (otherwise a repeat `channel_archived` would silently drop
    /// the operator's clue that the channel was archived twice).
    AlreadyRevoked,
    /// No `SourceType::Kchat` row exists for the cache_dir the
    /// caller passed. Returned when the forwarder races a
    /// `channel_archived` / `channel_deleted` event against a
    /// channel the user never linked as a source.
    Unlinked,
}

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
}

impl SourceManager {
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
        })
    }

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
        })
    }

    /// Build a manager backed by a [`SharedConnection`] that is also
    /// used by other stores. Used by the napi bridge.
    pub fn with_shared_conn(conn: SharedConnection, ignore_patterns: &[String]) -> Result<Self> {
        let store = SourceStore::with_shared_conn(conn)?;
        let (indexer, embedder, hybrid_config) = build_default_hybrid_pipeline(ignore_patterns);
        Ok(Self {
            store,
            indexer,
            progress: Arc::new(ProgressTracker::new()),
            embedding_progress: Arc::new(EmbeddingProgressTracker::new()),
            embedder,
            hybrid_config: Mutex::new(hybrid_config),
        })
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

    /// Backfill embeddings with a tracked progress snapshot exposed
    /// via [`embedding_progress`]. The renderer polls
    /// `bridge_get_embedding_progress` during the call and shows a
    /// determinate `embedded / total_chunks` bar.
    ///
    /// Semantics relative to [`backfill_embeddings`]:
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
        // Tenth-pass Devin Review ANALYSIS_0004: a previous version
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
    /// Block B Task 3 (Phase 11).
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
    /// Status projection rules (Block B Task 3):
    ///
    /// - If the locally-authenticated principal is in `members`
    ///   AND the source was `AccessRevoked`, transition to
    ///   `Indexed` (re-grant).
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
            return Ok(KchatAclRefreshOutcome::Revoked);
        }

        if source.status == SourceStatus::AccessRevoked {
            // Principal was re-added after a previous revoke;
            // restore retrievability. Transition back to `Indexed`
            // rather than `Connected` — the source was previously
            // indexed and the corpus chunks are still on disk, so
            // resuming retrieval is the correct end state.
            self.store
                .update_source_status(&source.id, SourceStatus::Indexed, None)?;
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
    /// Block B Task 3 (Phase 11).
    pub fn revoke_kchat_source(&self, cache_dir: &str) -> Result<KchatRevokeOutcome> {
        let Some(source) = self
            .store
            .find_source_by_type_and_path(&tessera_core::SourceType::Kchat, cache_dir)?
        else {
            return Ok(KchatRevokeOutcome::Unlinked);
        };

        if source.status == SourceStatus::AccessRevoked {
            return Ok(KchatRevokeOutcome::AlreadyRevoked);
        }

        self.store
            .update_source_status(&source.id, SourceStatus::AccessRevoked, None)?;
        Ok(KchatRevokeOutcome::Revoked)
    }

    /// Read the cached ACL roster for a KChat-channel source. Used
    /// by the renderer's source-detail surface + cargo tests.
    pub fn list_kchat_acl(&self, source_id: &SourceId) -> Result<Vec<crate::store::KchatAclRow>> {
        self.store.list_kchat_acl(source_id)
    }

    pub fn remove_source(&self, source_id: &SourceId) -> Result<()> {
        self.store.remove_source(source_id)
    }

    pub fn list_sources(&self) -> Result<Vec<Source>> {
        self.store.list_sources()
    }

    pub fn get_source(&self, source_id: &SourceId) -> Result<Source> {
        self.store.get_source(source_id)
    }

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

    pub fn search_broad(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let cfg = self
            .hybrid_config
            .lock()
            .expect("hybrid_config mutex poisoned")
            .clone();
        let engine = SearchEngine::hybrid(&self.store, self.embedder.as_deref(), cfg);
        engine.search_broad(query, limit)
    }

    pub fn list_indexed_files(&self, source_id: &SourceId) -> Result<Vec<IndexedFile>> {
        self.store.list_indexed_files(source_id)
    }

    pub fn get_current_file_hash(&self, file_path: &str) -> Result<Option<String>> {
        self.store.get_current_file_hash(file_path)
    }

    pub fn get_detail(&self, source_id: &SourceId) -> Result<(Source, Vec<IndexedFile>)> {
        let source = self.store.get_source(source_id)?;
        let files = self.store.list_indexed_files(source_id)?;
        Ok((source, files))
    }

    pub fn get_chunks_for_source(&self, source_id: &SourceId) -> Result<Vec<String>> {
        self.store.get_chunk_contents_for_source(source_id)
    }

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

    // ----------------------------------------------------------------
    // KChat-channel idempotency (eighth-pass Devin Review BUG_0001)
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
    // Block B Task 3 (Phase 11): KChat channel ACL projection
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
        assert_eq!(outcome, KchatAclRefreshOutcome::Revoked);
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
        assert_eq!(
            manager.get_source(&added.source.id).unwrap().status,
            SourceStatus::Indexed,
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
        assert_eq!(outcome, KchatRevokeOutcome::Revoked);
        assert_eq!(
            manager.get_source(&added.source.id).unwrap().status,
            SourceStatus::AccessRevoked,
        );

        // Idempotent: a second revoke reports `AlreadyRevoked`.
        let again = manager
            .revoke_kchat_source(dir.path().to_str().unwrap())
            .unwrap();
        assert_eq!(again, KchatRevokeOutcome::AlreadyRevoked);
    }

    #[test]
    fn revoke_kchat_source_unlinked_when_no_source_row() {
        let manager = SourceManager::new_in_memory(&[]).unwrap();
        let outcome = manager.revoke_kchat_source("/no/such/dir").unwrap();
        assert_eq!(outcome, KchatRevokeOutcome::Unlinked);
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
            Err(Error::Database(
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
                    Err(Error::Database("simulated even-index failure".into()))
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
}
