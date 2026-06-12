/**
 * Shared IPC type definitions for the Tessera desktop app.
 *
 * This module is the single source of truth for every wire shape that
 * crosses the renderer ↔ Electron ↔ N-API bridge boundary. Previously
 * the same ~30 interfaces were copy-pasted across three files
 * (`electron/preload.ts`, `electron/appState.ts`, and
 * `renderer/src/types/ipc.ts`) with a comment that read "Any change
 * to the schema must be made in all three locations." That comment is
 * now gone — there is one canonical declaration per type, and the
 * three legacy files re-export from here.
 *
 * Conventions:
 *   - Names ending in `Info` describe a structured wire payload
 *     (e.g. `SourceInfo`, `ConnectorStatusInfo`).
 *   - Names ending in `Request` describe a structured input the
 *     renderer hands to the bridge (e.g. `CreateTaskRequest`).
 *   - The `NativeBridge` interface itself lives in `appState.ts`
 *     because it's the only place that touches the loaded N-API
 *     addon; it references the canonical wire types from here.
 *   - The renderer-facing `TesseraApi` and `Window` augmentation
 *     live in `renderer/src/types/ipc.ts` because they reference
 *     the renderer-only `contextBridge` global; the per-domain API
 *     interfaces are declared here so both preload (main-side) and
 *     renderer agree on the function signatures.
 */

// -----------------------------------------------------------------
// Sources
// -----------------------------------------------------------------

export interface SourceInfo {
  id: string;
  sourceType: string;
  path: string;
  status: string;
  createdAt: string;
  lastIndexed: string | null;
  fileCount: number;
}

export interface IndexingProgressInfo {
  status: "idle" | "running" | "done" | "failed";
  scanned: number;
  indexed: number;
  unchanged: number;
  skipped: number;
  errors: number;
  totalFiles: number;
  currentPath: string | null;
  lastError: string | null;
}

/**
 * Snapshot of the embedding-backfill progress tracker (mirror of
 * `tessera_sources::progress::EmbeddingProgressSnapshot`). Used by
 * the Re-embed button on the SourceDetailPage to render a progress
 * banner while a backfill pass is in flight, and to dismiss it
 * once `status === "done"`.
 */
export interface EmbeddingProgressInfo {
  status: "idle" | "running" | "done" | "failed";
  /** Total chunks the active backfill pass intended to embed. */
  totalChunks: number;
  /** Chunks successfully embedded so far. */
  embedded: number;
  /** Chunks that failed embedding and were excluded from retry. */
  failed: number;
  /**
   * The active embedder's `model_id()`. Surfaces "which model is
   * being used" in the UI so a model switch is visually obvious.
   */
  modelId: string | null;
  /** Most recent embed-failure message, if any. */
  lastError: string | null;
}

/** Result of one `sources:backfillEmbeddings` IPC call. */
export interface BackfillEmbeddingsResult {
  /** Number of chunks newly embedded by this call. */
  embedded: number;
  /** Final snapshot of the progress tracker after the call. */
  progress: EmbeddingProgressInfo;
}

/**
 * per-model catalogue entry returned by
 * `settings:getEmbeddingModelStatus`. Mirrors
 * `tessera_bridge::sources::EmbeddingModelInfo`. The Settings page
 * uses this to render the three-way embedding-tier picker:
 *   - "Fast (HashTrick — offline, no download)"
 *   - "Semantic — English (MiniLM)"
 *   - "Semantic — Multilingual (XLM-R)"
 */
export interface EmbeddingModelInfo {
  /** Stable URL-safe identifier, e.g. `all-MiniLM-L6-v2`. */
  slug: string;
  /** Human-readable label for the picker. */
  displayName: string;
  /** Output vector dimensionality (always 384 today). */
  dim: number;
  /** Approximate ONNX file size in bytes. */
  modelSizeBytes: number;
  /** Approximate tokenizer.json size in bytes. */
  tokenizerSizeBytes: number;
  /** Comma-separated list of supported language families. */
  languages: string;
  /** True iff the files exist on disk AND match the pinned SHA-256. */
  installed: boolean;
  /**
   * Canonical `model_id` this model would be tagged with in
   * `chunk_embeddings.model_id`. Format `onnx:{slug}:{dim}d`.
   */
  modelId: string;
}

/**
 * status of an in-flight ONNX model download.
 * Mirrors `tessera_bridge::sources::DownloadProgressInfo`. Polled
 * on a timer by the Settings page to render the progress bar.
 */
export interface EmbeddingDownloadProgressInfo {
  status: "idle" | "downloading" | "done" | "failed";
  /** Slug of the model being / last downloaded. Null before first download. */
  slug: string | null;
  /** Total bytes expected, or null when Content-Length was missing. */
  bytesTotal: number | null;
  /** Bytes received so far (always >= 0). */
  bytesDownloaded: number;
  /** Verbatim error message from the last failed download. */
  lastError: string | null;
}

/**
 * combined catalogue + per-model state + active
 * download state returned by `settings:getEmbeddingModelStatus`.
 * Single round trip so the Settings page renders in one frame.
 */
export interface EmbeddingModelStatusInfo {
  /** `model_id` of the currently-active embedder, or null. */
  currentModelId: string | null;
  /** All shipped ONNX models in display order, with per-model state. */
  models: EmbeddingModelInfo[];
  /** Current download state (idle when no download is in flight). */
  download: EmbeddingDownloadProgressInfo;
  /**
   * number of currently-indexed chunks whose
   * content contains at least one non-ASCII byte. The Settings
   * UI shows a "consider the XLM-R model" hint when
   * `nonAsciiChunks / totalChunks > 0.10` (and `totalChunks` is
   * large enough to be statistically meaningful — see the
   * EmbeddingModelCard for the exact rule). Heuristic: GLOB
   * counts smart quotes as non-ASCII too. See
   * `SourceStore::count_non_ascii_chunks` for the full
   * trade-off rationale.
   */
  nonAsciiChunks: number;
  /** Total indexed chunks across all sources (denominator). */
  totalChunks: number;
}

/**
 * Wire shape for the hybrid retrieval config exposed to the renderer.
 * Mirrors `tessera_bridge::sources::HybridSearchConfigInfo` — the
 * Rust side surfaces "no recency decay" as the explicit
 * `recencyDecayEnabled: false` flag (rather than `recencyHalflifeSecs
 * = Infinity`) because Infinity cannot round-trip through JSON.
 */
export interface HybridSearchConfigInfo {
  bm25Weight: number;
  vectorWeight: number;
  rrfK: number;
  recencyDecayEnabled: boolean;
  /** Half-life in seconds when decay is enabled; null when disabled. */
  recencyHalflifeSecs: number | null;
  candidatePoolSize: number;
  /**
   * Weight of the knowledge-substrate retention ranking in fusion
   * (the fourth RRF signal). Defaults to 1.0.
   */
  retentionWeight: number;
}

/**
 * Partial-update patch sent from the renderer's Settings page to the
 * bridge. Every field is optional — fields that are undefined keep
 * their current value. Mirrors
 * `tessera_bridge::sources::HybridSearchConfigUpdate`.
 */
export interface HybridSearchConfigUpdate {
  bm25Weight?: number;
  vectorWeight?: number;
  rrfK?: number;
  /**
   * `true`  → enable decay (use `recencyHalflifeSecs` if provided,
   * otherwise keep the current value, falling back to the 30-day
   * default if the current value is "disabled");
   * `false` → disable decay (any accompanying `recencyHalflifeSecs`
   * is ignored — the toggle wins);
   * `undefined` → don't touch the flag.
   */
  recencyDecayEnabled?: boolean;
  recencyHalflifeSecs?: number;
  candidatePoolSize?: number;
  /** New retention-signal weight, or undefined to leave unchanged. */
  retentionWeight?: number;
}

export interface IndexedFileInfo {
  path: string;
  hash: string;
  lastModified: string;
  chunkCount: number;
}

export interface SourceDetailInfo {
  source: SourceInfo;
  files: IndexedFileInfo[];
}

/**
 * Result of `bridgeAddKchatChannel(cacheDir)`.
 *
 * The Rust-side `SourceManager::add_kchat_channel` is idempotent on
 * `cacheDir`: a first call inserts a `SourceType::Kchat` row and
 * returns `{ newlyCreated: true, source }`; every subsequent call
 * for the same `cacheDir` reindexes that source in place and
 * returns `{ newlyCreated: false, source }` carrying the *original*
 * `SourceId`. The Node-side `sources:addKchatChannel` handler uses
 * `newlyCreated` to gate the `KchatChannelLinked` audit event so a
 * channel that is re-synced 100 times does not produce 100 audit
 * rows.
 */
export interface KchatChannelAddOutcomeInfo {
  source: SourceInfo;
  newlyCreated: boolean;
}

/**
 * Result of [`NativeBridge.bridgeIndexKchatFile`]. Returned by the
 * substrate's `SourceManager::index_kchat_file`, the targeted
 * single-file index path the Block B Task 2 WS forwarder calls on
 * every `file_added` event after writing the new bytes to the
 * channel cache directory.
 *
 * Field semantics drive the `triggered_reindex` flag the forwarder
 * records on the `KchatFileEventReceived` audit row:
 *   - `wasLinked = false` → channel is not registered as a source;
 *     forwarder records `triggered_reindex = false` and skipped any
 *     network / disk work.
 *   - `wasLinked = true && indexed = true` → file was newly indexed
 *     (or re-indexed because its content hash changed); forwarder
 *     records `triggered_reindex = true`.
 *   - `wasLinked = true && indexed = false` → file's content hash
 *     matched an existing index entry (a concurrent full sync got
 *     there first); forwarder records `triggered_reindex = false`
 *     so the audit log accurately reflects whether THIS event
 *     drove indexer work.
 *
 * `sourceId` is populated only when `wasLinked = true`; it is an
 * empty string otherwise so the napi serialization layer doesn't
 * need an `Option<String>` (consumers never read `sourceId` when
 * `wasLinked` is false).
 */
export interface KchatFileIndexOutcomeInfo {
  wasLinked: boolean;
  indexed: boolean;
  sourceId: string;
}

/**
 * One row of the authoritative KChat-channel member roster the
 * Node-side `KchatEventForwarder` passes to
 * `bridgeRefreshKchatAcl`. Wire shape is intentionally narrow:
 * the substrate persists only the user id + role string, never
 * the human-readable display name / email / nickname (the audit
 * + retrieval-filter paths only need the opaque KChat user id).
 *
 * Block B Task 3.
 */
export interface KchatAclMemberInfo {
  userId: string;
  role: string;
}

/**
 * Outcome of a `bridgeRefreshKchatAcl` call.
 *
 * `outcome` is the snake_case projection result the substrate
 * produced from the refreshed roster:
 *   - `"granted"` — principal in roster, source was already in
 *     a non-revoked state (status untouched).
 *   - `"regranted"` — principal in roster, source was previously
 *     `AccessRevoked`; status transitioned back to `Connected`
 *     (NOT `Indexed`, because the revoke path cryptoshredded all
 *     evidence rows). The Node-side forwarder reads this
 *     outcome as a signal to schedule a full channel re-sync
 *     via the `setKchatChannelResyncImpl` slot (see
 *     `apps/desktop/electron/ipc/kchat.ts`), which re-walks the
 *     file roster, downloads + chunks each file, and lets the
 *     indexer promote the status to `Indexing` → `Indexed` on
 *     its own.
 *   - `"revoked"` — principal NOT in roster; status transitioned
 *     to `AccessRevoked` and retrieval will start filtering the
 *     source's chunks out on the next call.
 *   - `"unlinked"` — no `SourceType::Kchat` source exists for
 *     `cacheDir`; no rows persisted, no status changed.
 *   - `"no_principal"` — substrate has no `kchat_principal` set
 *     (no `kchat:connect` has happened yet); refresh treated as
 *     a no-op rather than auto-revoking every linked source.
 *
 * `memberCount` is the roster size as persisted (always the
 * count of `members` the caller passed; the field is there so
 * downstream audit + telemetry don't have to re-thread the
 * length through every call site).
 *
 * `principalPresent` mirrors the outcome — `true` for
 * `granted` / `regranted`, `false` otherwise — and is the
 * boolean flag the audit row records for operator dashboards.
 *
 * when `outcome === "revoked"`, the
 * inline cryptoshred ran and `chunksDropped` / `filesDropped`
 * report how many evidence rows the substrate scrubbed. For
 * every other outcome the counts are zero (no shred happened).
 */
export interface KchatAclRefreshOutcomeInfo {
  outcome:
    | "granted"
    | "regranted"
    | "revoked"
    | "unlinked"
    | "no_principal";
  memberCount: number;
  principalPresent: boolean;
  /** Block B Task 4: count of chunk rows scrubbed by the inline
   *  cryptoshred on the revoke path; 0 on every non-revoke outcome. */
  chunksDropped: number;
  /** Block B Task 4: count of indexed_files rows scrubbed by the
   *  inline cryptoshred on the revoke path; 0 on every non-revoke
   *  outcome. */
  filesDropped: number;
  /** Block C Task 2: count of `kchat_posts` rows
   *  scrubbed by the inline cryptoshred on the revoke path; 0 on
   *  every non-revoke outcome AND on file-only sources where no
   *  chat-post evidence ever existed. */
  postsDropped: number;
  /** Block C Task 2: `true` when the per-source DEK
   *  row was dropped on the revoke path. `false` on every
   *  non-revoke outcome AND on revokes where the source never
   *  ingested any chat-post evidence (no DEK was ever derived).
   *  This is the cryptographic guarantee surface — once the DEK
   *  is gone, the chat-body chunks are unrecoverable even if the
   *  full SQLCipher master key later leaks. */
  dekDropped: boolean;
  /** Fifth-pass Devin Review fix
   *  (ANALYSIS_pr-review-job-ef3c7d6c..._0001): `true` when the
   *  substrate's belt-and-braces `VACUUM` ran cleanly (or was
   *  skipped because there was nothing to reclaim). `false` only
   *  when `VACUUM` ran and failed; the row-level scrub still
   *  committed under `secure_delete = ON` in that case so the
   *  cryptographic guarantee holds. Forwarded onto the
   *  `KchatSourceCryptoshredded` audit row so operators can grep
   *  for `vacuum_succeeded=false`. */
  vacuumSucceeded: boolean;
  /** Fifth-pass Devin Review fix: first-error message text on a
   *  `VACUUM` failure. `undefined` (mapped from Rust `None`) when
   *  `vacuumSucceeded` is true. */
  vacuumError?: string;
}

/**
 * Outcome of a `bridgeRevokeKchatSource` call (explicit revoke
 * for `channel_archived` / `channel_deleted` / self-`user_removed`
 * events).
 *
 *   - `"revoked"` — source row transitioned from a non-revoked
 *     state to `AccessRevoked`.
 *   - `"already_revoked"` — source was already in
 *     `AccessRevoked`; no status change. The audit row is still
 *     emitted by the caller so operators see the repeat-event
 *     in the trail.
 *   - `"unlinked"` — no `SourceType::Kchat` source exists for
 *     `cacheDir`; nothing to revoke.
 */
export interface KchatRevokeOutcomeInfo {
  outcome: "revoked" | "already_revoked" | "unlinked";
  /** Block B Task 4: count of chunk rows scrubbed by
   *  the inline cryptoshred. Both `revoked` and `already_revoked`
   *  outcomes run the (idempotent) shred so a re-revoke can serve
   *  as a one-time backfill for sources soft-revoked under the
   *  Task 3 build. `unlinked` is always zero. */
  chunksDropped: number;
  /** Block B Task 4: count of indexed_files rows
   *  scrubbed by the inline cryptoshred. Same semantics as
   *  `chunksDropped`. */
  filesDropped: number;
  /** Block C Task 2: count of `kchat_posts` rows
   *  scrubbed by the inline cryptoshred. Same semantics as
   *  `chunksDropped`. `unlinked` outcomes are always zero. */
  postsDropped: number;
  /** Block C Task 2: `true` when the per-source DEK
   *  row was dropped on this revoke. `false` when no DEK ever
   *  existed for this source (file-only ingest) OR on `unlinked`
   *  outcomes. See {@link KchatAclRefreshOutcomeInfo.dekDropped}
   *  for the cryptographic guarantee this surfaces. */
  dekDropped: boolean;
  /** Fifth-pass Devin Review fix: see
   *  {@link KchatAclRefreshOutcomeInfo.vacuumSucceeded}. */
  vacuumSucceeded: boolean;
  /** Fifth-pass Devin Review fix: see
   *  {@link KchatAclRefreshOutcomeInfo.vacuumError}. */
  vacuumError?: string;
}

/**
 * Per-post ingest input passed to `bridge_ingest_kchat_post` /
 * `bridge_edit_kchat_post`. Mirrors the substrate's
 * `KchatPostIngestInput`. The Node-side forwarder builds an
 * instance of this from a `posted` / `post_edited` WS event
 * after `withChannelSyncLock` serialises the work, then hands
 * it across the bridge.
 *
 * Block C Task 1.
 */
export interface KchatPostIngestInputInfo {
  cacheDir: string;
  postId: string;
  channelId: string;
  rootId?: string;
  senderUserId: string;
  body: string;
  createdAtMs: number;
  editedAtMs: number;
}

/**
 * Outcome of [`KchatPostIngestInputInfo`]-driven calls. The
 * substrate produces one of four outcome short-codes:
 *
 *   - `"ingested"`  — post stored, chunks AEAD-sealed under
 *     the per-source DEK, `chunkIds` / `chunkCount` populated.
 *   - `"unchanged"` — re-delivery of the same post body
 *     (BLAKE3 hash matches the existing row); no-op. `chunkCount`
 *     reflects the existing row's chunk count.
 *   - `"unlinked"`  — no `SourceType::Kchat` source exists for
 *     `cacheDir`; defensive no-op (the channel was unlinked
 *     between the WS event and the bridge call).
 *   - `"access_revoked"` — source row exists but is in
 *     `AccessRevoked`; ingestion refuses to write evidence the
 *     retrieval filter would have to drop anyway.
 *
 * `sourceId` is populated for `ingested` / `unchanged` so the
 * Node-side audit pair can correlate without an extra lookup.
 *
 * Block C Task 1.
 */
export interface KchatPostIngestOutcomeInfo {
  outcome: "ingested" | "unchanged" | "unlinked" | "access_revoked";
  sourceId?: string;
  indexedFileId?: number;
  chunkCount: number;
  /** Populated only when `outcome === "ingested"`; one entry per
   *  newly-inserted chunk row so the audit row can record the
   *  substrate ids without exposing the body. */
  chunkIds: number[];
}

/**
 * Outcome of `bridge_delete_kchat_post`. Mirrors the substrate's
 * `KchatPostDeleteOutcome`.
 *
 *   - `"deleted"`        — post bookkeeping + chunks dropped.
 *   - `"not_found"`      — no row matched (post never ingested
 *     or already deleted by a prior tombstone).
 *   - `"unlinked"`       — no source for cacheDir.
 *   - `"access_revoked"` — source row exists but is in
 *     `AccessRevoked`; defensive no-op.
 *
 * Block C Task 1.
 */
export interface KchatPostDeleteOutcomeInfo {
  outcome: "deleted" | "not_found" | "unlinked" | "access_revoked";
  sourceId?: string;
  chunksDropped: number;
}

/**
 * persisted backfill state for a
 * KChat channel. The orchestrator's
 * `runBackfillKchatChannel` uses this to decide whether to start
 * a fresh walk, resume from a cursor, skip an already-completed
 * walk, or refuse to walk a revoked / unlinked source.
 *
 *   - `"idle"`           — eligible for backfill. `oldestPostId`
 *     is the persisted `before=` cursor; null means "no walk
 *     started yet, fetch from the newest post". `completedAt`
 *     is the RFC3339 timestamp at which the walk reached the
 *     end of channel history (null while still in progress).
 *   - `"unlinked"`       — no source for `cacheDir`; defensive
 *     no-op (the channel was removed between the IPC kickoff
 *     and the substrate call).
 *   - `"access_revoked"` — source exists but is revoked; the
 *     orchestrator must NOT walk it (would re-create the chunks
 *     the cryptoshred destroyed).
 *
 * `sourceId` is populated whenever the source row exists.
 */
export interface KchatBackfillStateInfo {
  outcome: "idle" | "unlinked" | "access_revoked";
  sourceId?: string;
  /** RFC3339 timestamp when the walk completed; null while
   *  still in progress or never started. */
  oldestPostId?: string;
  completedAt?: string;
}

/**
 * outcome of a single backfill page
 * ingest. The orchestrator calls
 * `bridgeIngestKchatBackfillPage(...)` once per
 * `getPostsForChannel(...)` response.
 *
 *   - `"ingested"`       — page was processed. The counters
 *     split it by per-post substrate outcome.
 *     `oldestPostIdInPage` is the cursor the substrate
 *     advanced to (null on an empty page).
 *   - `"unlinked"`       — no source for `cacheDir`.
 *   - `"access_revoked"` — source flipped to revoked mid-walk;
 *     the orchestrator stops the loop and emits an
 *     `aborted` audit row.
 */
export interface KchatBackfillIngestOutcomeInfo {
  outcome: "ingested" | "unlinked" | "access_revoked";
  sourceId?: string;
  postsIngested: number;
  postsUnchanged: number;
  postsSkippedRevoked: number;
  oldestPostIdInPage?: string;
}

/**
 * outcome of
 * `bridgeMarkKchatBackfillComplete`. Set when the orchestrator
 * observes `prevPostId === null` on the REST response.
 *
 *   - `"completed"`       — the completion sentinel was set.
 *     Future `runBackfillKchatChannel` calls short-circuit at
 *     the state read.
 *   - `"unlinked"`        — no source row.
 *   - `"access_revoked"`  — source is revoked; sentinel NOT
 *     set (the cryptoshred path already cleared the cursor).
 */
export interface KchatBackfillCompletionOutcomeInfo {
  outcome: "completed" | "unlinked" | "access_revoked";
  sourceId?: string;
}

/**
 * aggregate result of one
 * orchestrator-driven backfill walk
 * (`runBackfillKchatChannel(channelId)`). Surfaced to the
 * renderer via the `sources:backfillKchatChannel` IPC handler so
 * the UI can show per-channel progress / final counts and so the
 * audit emission can correlate with the user-visible row.
 *
 *   - `"completed"`        — REST server returned
 *     `prevPostId === null`. The substrate sentinel is set; future
 *     walks short-circuit.
 *   - `"aborted"`          — walk stopped early. `reason` is one of
 *     `access_revoked` (source flipped mid-walk),
 *     `safety_cap` (cumulative cap hit), `unlinked` (source
 *     disappeared between pages), or `error` (REST / substrate
 *     error). The cursor is preserved at the last successfully-
 *     persisted post id so a later retrigger resumes from there.
 *   - `"skipped"`          — short-circuit at the state read
 *     because the walk has already completed (`completedAt`
 *     populated) or the source is in a state that disallows a
 *     walk. `reason` carries the precise short-circuit cause:
 *     `already_completed`, `unlinked`, or `access_revoked`.
 *
 * The per-walk counters are cumulative over every page processed
 * during this single `runBackfillKchatChannel` invocation. They do
 * NOT include posts ingested on a prior walk that resumed from a
 * cursor — the substrate dedupe takes care of preserving the
 * total without double-counting.
 */
export interface KchatBackfillRunOutcome {
  outcome: "completed" | "aborted" | "skipped";
  reason?:
    | "access_revoked"
    | "safety_cap"
    | "unlinked"
    | "error"
    | "already_completed";
  pagesWalked: number;
  totalPostsIngested: number;
  totalPostsUnchanged: number;
  totalPostsSkippedRevoked: number;
  /** RFC3339 string when `outcome === "skipped"` and the walk
   *  was already completed; absent otherwise. */
  completedAt?: string;
}

/**
 * Renderer-facing search result. The IPC handler maps from the
 * Rust-side `SearchHitInfo` (which uses `content` / `relevance` /
 * `chunkIndex`) to this shape (`chunkContent` / `relevanceScore`,
 * no `chunkIndex`) before sending to the renderer.
 */
export interface SearchHit {
  sourcePath: string;
  sourceId: string;
  chunkHash: string;
  chunkContent: string;
  relevanceScore: number;
  excerpt: string;
}

/**
 * Bridge-side search hit. This is the raw shape the Rust N-API
 * returns. The renderer never sees this — it's transformed into
 * `SearchHit` by the `sources:search` IPC handler.
 */
export interface SearchHitInfo {
  content: string;
  excerpt: string;
  sourcePath: string;
  sourceId: string;
  chunkHash: string;
  chunkIndex: number;
  relevance: number;
}

/**
 * A concept-graph node surfaced in the "Knowledge" tab of search
 * results. Mirrors `tessera_bridge::substrate::SubstrateConcept`
 * (camelCased by napi-derive); used unchanged on both the bridge and
 * renderer sides.
 */
export interface SubstrateConceptInfo {
  /** Concept node id (UUID). */
  id: string;
  /** Human-readable concept label (the extracted entity surface). */
  label: string;
  /** Short definition / provenance tag for the node. */
  definition: string;
  /**
   * Concept lifecycle state: `candidate`, `canonical`, `superseded`,
   * `contradicted`, or `deleted`.
   */
  state: string;
  /** Tessera source ids (UUID strings) this concept co-occurs in. */
  relatedSourceIds: string[];
}

/**
 * Bridge-side (raw N-API) result of an observation-enriched search,
 * returned by `bridgeSearchSourcesEnriched`. Mirrors
 * `tessera_bridge::sources::EnrichedSearchResult`. The `sources:search`
 * enriched IPC handler transforms `hits` (`SearchHitInfo`) into the
 * renderer's {@link EnrichedSearchResult} (`SearchHit`); the knowledge
 * planes pass through unchanged.
 */
export interface EnrichedSearchResultInfo {
  hits: SearchHitInfo[];
  entities: SubstrateMemoryInfo[];
  facts: SubstrateMemoryInfo[];
  concepts: SubstrateConceptInfo[];
  memories: SubstrateMemoryInfo[];
}

/**
 * Renderer-facing observation-enriched search result.
 *
 * `hits` is the standard chunk-level result set (identical to
 * {@link SourceApi.searchSources}), retention-weighted so chunks from
 * sources with active memories rank higher. The remaining fields are
 * the additive knowledge plane rendered in the "Knowledge" tab:
 * `entities`/`facts` are observation-typed memories, `concepts` are
 * matching concept-graph nodes, and `memories` is the full ranked
 * memory match set.
 */
export interface EnrichedSearchResult {
  hits: SearchHit[];
  entities: SubstrateMemoryInfo[];
  facts: SubstrateMemoryInfo[];
  concepts: SubstrateConceptInfo[];
  memories: SubstrateMemoryInfo[];
}

/**
 * A concept-graph-derived suggestion of related sources for the
 * artifact-creation flow ("You have N sources about [entity]."),
 * returned by `bridgeSuggestRelatedSources`. Mirrors
 * `tessera_bridge::substrate::SubstrateRelatedSuggestion`.
 */
export interface SubstrateRelatedSuggestionInfo {
  /** Concept label the suggestion is anchored on. */
  entity: string;
  /** Related Tessera source ids (UUID strings) not already selected. */
  sourceIds: string[];
  /** Ranking signal: the number of related sources. */
  score: number;
}

/**
 * renderer-facing KChat-post search
 * hit. Mirrors {@link SearchHit} for the fields the renderer's
 * existing evidence-search UI already consumes, plus the
 * KChat-specific metadata block (channel, post, sender,
 * timestamps, permalink) the citation badge renders alongside
 * the excerpt.
 *
 * The `permalink` is composed by the IPC handler — the substrate
 * does not know the KChat server URL, only `kchatAuth` does, so
 * the URL is built at the IPC layer from `channelId`/`postId` +
 * the user's authenticated server base. A null `permalink` means
 * the user is currently disconnected from KChat (the citation is
 * still valid for retrieval but the "Open in KChat" button is
 * disabled).
 *
 * `kind` is a fixed discriminator (`"kchat_post"`) so the
 * renderer's CitationPanel can render the chat citation badge
 * without branching on a tagged-union elsewhere.
 */
export interface KchatPostSearchHit {
  kind: "kchat_post";
  sourcePath: string;
  sourceId: string;
  chunkHash: string;
  chunkContent: string;
  relevanceScore: number;
  excerpt: string;
  postId: string;
  channelId: string;
  rootId: string | null;
  senderUserId: string;
  createdAtMs: number;
  editedAtMs: number;
  /** Composed `kchat://<server>/channel/<channel_id>/post/<post_id>`
   * permalink, or `null` when the user is disconnected from KChat. */
  permalink: string | null;
  /**
   * human-readable sender username,
   * resolved by the IPC handler from `senderUserId` via the KChat
   * `POST /users/ids` bulk endpoint and cached at the IPC layer.
   *
   * `null` when the user is disconnected from KChat OR when the
   * referenced user is no longer visible to the authenticated
   * principal (e.g. account deleted, lost cross-team visibility).
   * The renderer falls back to the raw `senderUserId` for display
   * in that case so the citation row still renders.
   */
  senderUsername: string | null;
  /**
   * human-readable channel display name,
   * resolved by the IPC handler from `channelId` via the KChat
   * `GET /channels/{id}` endpoint and cached at the IPC layer.
   *
   * `null` when disconnected OR the channel is no longer visible
   * (e.g. user was removed from the channel). The renderer falls
   * back to the raw `channelId` for display, and the underlying
   * citation is still stored against the channel id so the
   * indexed post remains retrievable.
   */
  channelDisplayName: string | null;
}

/**
 * bridge-side KChat-post search hit.
 * This is the raw shape the Rust N-API returns. The renderer
 * never sees this — the `kchat:searchPosts` IPC handler maps it
 * to {@link KchatPostSearchHit} (renaming fields to camelCase
 * shape, composing the permalink, and tagging with `kind`).
 *
 * Field ordering matches {@link SearchHitInfo} where the two
 * overlap, plus the KChat-specific block tucked at the end so
 * the napi-generated `.d.ts` stays diff-stable as either struct
 * grows fields.
 */
export interface KchatPostSearchHitInfo {
  content: string;
  excerpt: string;
  sourcePath: string;
  sourceId: string;
  chunkHash: string;
  chunkIndex: number;
  byteOffset: number;
  relevance: number;
  postId: string;
  channelId: string;
  rootId: string | null;
  senderUserId: string;
  createdAtMs: number;
  editedAtMs: number;
}

/**
 * bridge-side single message in a KChat
 * thread context lookup. One element of the array returned by
 * `bridgeFetchKchatThreadContext` — the IPC layer maps these to
 * {@link KchatThreadContextMessage} (enriching with `senderUsername`
 * / `channelDisplayName` via the same cache the search path uses).
 */
export interface KchatThreadContextMessageInfo {
  postId: string;
  channelId: string;
  senderUserId: string;
  createdAtMs: number;
  editedAtMs: number;
  content: string;
  /** `true` for the thread root, `false` for the earlier-reply
   *  siblings that frame the conversation. The substrate guarantees
   *  at most one row in a result vec carries `isRoot: true`. */
  isRoot: boolean;
}

/**
 * renderer-facing thread-context message.
 * One element of the chronologically-ordered transcript returned
 * by `window.kchat.fetchThreadContext(...)`. The IPC layer
 * enriches each row with the sender username / channel display
 * name resolved through the same LRU cache the search path uses;
 * unresolvable names surface as `null` and the renderer falls back
 * to raw ids (matching `KchatPostSearchHit`'s posture).
 *
 * The renderer should render these top-down: `[0]` is the
 * chronologically-earliest message (typically the thread root),
 * `[N-1]` is the most-recent earlier-reply before the search hit.
 */
export interface KchatThreadContextMessage {
  postId: string;
  channelId: string;
  senderUserId: string;
  createdAtMs: number;
  editedAtMs: number;
  content: string;
  isRoot: boolean;
  /** Resolved sender username (`null` ⇒ raw-id fallback). */
  senderUsername: string | null;
  /** Resolved channel display name (`null` ⇒ raw-id fallback). */
  channelDisplayName: string | null;
}

// -----------------------------------------------------------------
// Artifacts
// -----------------------------------------------------------------

export interface ArtifactInfo {
  id: string;
  title: string;
  artifactType: string;
  templateId: string | null;
  content: string;
  citationCount: number;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface ArtifactVersionInfo {
  version: number;
  content: string;
  createdAt: string;
}

/**
 * One theme surfaced by `tessera_artifacts::comparison::compare_sources`.
 * The Rust-side definition lives in
 * `crates/tessera_artifacts/src/comparison.rs::Theme`; the bridge
 * exposes it as `ThemeInfo` (this shape). `frequency` is the
 * combined occurrence count across both compared sources for
 * common themes, or the per-source count for unique themes.
 */
export interface ThemeInfo {
  label: string;
  frequency: number;
}

/**
 * Structured comparison data surfaced by `compareSources`.
 * `similarityScore` is in `[0.0, 1.0]` (the renderer scales it to
 * a percentage). Theme arrays preserve the Rust-side truncation
 * order (`commonThemes` ≤ 30, `uniqueToA` / `uniqueToB` ≤ 20)
 * already applied by `compare_sources`. Mirrors the napi
 * `ComparisonInfo` struct.
 */
export interface ComparisonInfo {
  similarityScore: number;
  commonThemes: ThemeInfo[];
  uniqueToA: ThemeInfo[];
  uniqueToB: ThemeInfo[];
}

/**
 * Return type for `compareSources`. Carries both the persisted
 * comparison artifact (so the renderer can navigate to it / link
 * it elsewhere) AND the structured comparison data (so the
 * `ComparisonResultModal` can render rich theme badges without
 * re-parsing the markdown). `labelA` / `labelB` are bridge-side
 * friendly source labels derived from the source paths.
 */
export interface CompareSourcesResult {
  artifact: ArtifactInfo;
  comparison: ComparisonInfo;
  labelA: string;
  labelB: string;
}

export interface ExportResult {
  content: string;
  format: string;
}

export interface MarpExportRequest {
  markdown: string;
  format: "pdf" | "pptx" | "html";
  outputPath: string;
  theme?: string;
  includeNotes?: boolean;
  allowHtml?: boolean;
}

export interface TypstExportRequest {
  markup: string;
  format: "pdf" | "svg";
  outputPath?: string;
}

export interface TypstExportResult {
  outputPath: string;
  bytes: number;
}

// -----------------------------------------------------------------
// Templates
// -----------------------------------------------------------------

export interface TemplateInfo {
  id: string;
  name: string;
  artifactType: string;
  description: string;
  sectionCount: number;
  exportFormats: string[];
}

// -----------------------------------------------------------------
// Citations
// -----------------------------------------------------------------

export interface CitationInfo {
  citationId: string;
  sourceId: string;
  sourceType: string;
  sourceTitle: string;
  sourceUri: string;
  chunkHash: string;
  page: number | null;
  confidence: number;
  usedFor: string;
  createdAt: string;
}

export interface AddCitationRequest {
  artifactId: string;
  sourceId: string;
  sourceType: string;
  sourceTitle: string;
  sourceUri: string;
  chunkHash: string;
  page: number | null;
  confidence: number;
  usedFor: string;
}

export type CitationFreshness = "fresh" | "changed" | "source_missing";

export interface ReplaceCitationRequest {
  artifactId: string;
  citationId: string;
  sourceId: string;
  sourceType: string;
  sourceTitle: string;
  sourceUri: string;
  /** Hash of the new source chunk. Required by the Rust N-API
   *  `ReplaceCitationRequest` struct — without it, the bridge call
   *  fails to deserialize and the entire replace flow throws. */
  chunkHash: string;
  page: number | null;
  confidence: number;
}

export interface ReplaceCitationResult {
  citation: CitationInfo;
  previousSourceUri: string;
}

// -----------------------------------------------------------------
// Settings
// -----------------------------------------------------------------

/**
 * Single source of truth for the settings enum-like fields. The arrays
 * are exported as runtime values so the IPC zod schemas
 * (`apps/desktop/electron/ipc/schemas.ts`) and the renderer pages
 * (Settings page dropdown) can both pull from one declaration — the
 * historical pattern of redeclaring `"light" | "dark" | "system"` in
 * each layer is what allowed an enum to silently drift on one side
 * (cf. zod schema initially missing `"blocked"`/`"critical"`/`"csv"`).
 */
export const THEMES = ["light", "dark", "system"] as const;
export type Theme = (typeof THEMES)[number];

/**
 * Curated accent palette. The accent drives every primary
 * affordance — buttons, links, focus rings, selected states — via
 * the `--accent-*` tokens in `renderer/src/styles/tokens.css`. Each
 * key maps to a `[data-accent="<key>"]` ramp that defines an
 * AA-safe light base (readable with white text) and a lighter dark
 * base (readable on the dark page surface). Exported as a runtime
 * value so the IPC zod schemas, the on-disk config schema, and the
 * Settings page picker all pull from a single declaration — the
 * same single-source-of-truth pattern as `THEMES`/`EXPORT_FORMATS`.
 * `"violet"` is the historic brand default and the `:root` fallback
 * when no `data-accent` attribute is present.
 */
export const ACCENT_COLORS = [
  "violet",
  "blue",
  "teal",
  "green",
  "amber",
  "orange",
  "red",
  "pink",
] as const;
export type AccentColor = (typeof ACCENT_COLORS)[number];

export const EXPORT_FORMATS = ["markdown", "html", "csv", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface SettingsData {
  theme: Theme;
  /**
   * accent colour key driving every primary affordance (buttons,
   * links, focus rings, active/selected states). One of
   * {@link ACCENT_COLORS}; defaults to `"violet"` (the historic
   * brand colour). Applied by `useTheme` as a `data-accent`
   * attribute on `<html>`, which selects the matching `--accent-*`
   * ramp in `tokens.css`. Persisted via `settings:update` so the
   * choice survives restarts, the same as `theme`.
   */
  accentColor: AccentColor;
  defaultExportFormat: ExportFormat;
  ignorePatterns: string[];
  watchPatterns: string[];
  /**
   * tracks whether the first-run `OnboardingWizard`
   * has been completed (or explicitly dismissed) for this install.
   * The wizard inspects this flag, the source list, and the artifact
   * list on mount: it only shows when ALL three conditions hold
   * (`onboardingCompleted === false`, zero sources, zero artifacts)
   * so an existing user whose config was cleared but whose DB still
   * contains data does not get surprised by a wizard on the next
   * launch.
   *
   * Once the wizard is dismissed (either by reaching the final
   * "Finish" step or by the explicit "Skip" button) the renderer
   * calls `settings:update` with `{ onboardingCompleted: true }`
   * and the wizard never appears again on this install — even if
   * the user later removes every source and artifact. The user
   * always has the manual "Add Source" / "Browse Templates" CTAs
   * on `HomePage` for that case.
   */
  onboardingCompleted: boolean;
  /**
   * artifact IDs the user has pinned ("favorited")
   * from the command palette, the artifact editor header, or the
   * right-click context menu on the home page. Order matters — the
   * sidebar and command palette render them in the order the user
   * pinned them, with the most recently pinned first.
   *
   * Stored in `SettingsData` (not on the artifact row itself) for
   * two reasons:
   *
   *   1. Pinning is a per-install user preference, not an artifact
   *      attribute — exporting / sharing an artifact should not
   *      smuggle the original user's pinned state. Keeping it in
   *      settings means it travels with the user, not the data.
   *   2. The toggle path is renderer-driven and lossless: a single
   *      `settings:update({ pinnedArtifactIds: [...] })` round-trip
   *      replaces the whole list, with no risk of partial writes
   *      desynchronising a pinned-set from an artifact row.
   *
   * Stale entries (IDs whose artifact has been deleted) are pruned
   * lazily by the renderer when it joins `pinnedArtifactIds`
   * against the live artifact list — there is no IPC needed at
   * delete time.
   */
  pinnedArtifactIds: string[];
  /**
   * artifact IDs in user-recency order (most
   * recently *viewed* first), capped at 32 entries. Recorded every
   * time the artifact editor mounts for a given ID, deduped so a
   * given artifact appears at most once. The command palette's
   * "Recent" group reads from this list — distinct from
   * `useRecentArtifacts` which sorts by `updatedAt` and surfaces
   * recently *edited* artifacts.
   *
   * The view-history vs. edit-history distinction matters because
   * a user often wants to re-open an artifact they just inspected
   * (e.g. comparing two reports side-by-side) without having
   * touched its content. The 32-item cap is generous enough that
   * realistic browsing sessions never spill it but small enough
   * that the value stays cheap to serialise alongside the rest of
   * `SettingsData`.
   *
   * Stale entries are pruned lazily by the renderer at join time
   * against the live artifact list, same policy as
   * `pinnedArtifactIds`.
   */
  recentArtifactIds: string[];
  /**
   * idle window in seconds after which the
   * local llama-server / vision / diffusion sidecars unload their
   * model weights to release RAM / VRAM. `0` disables idle unloading
   * entirely ("Keep loaded forever" — useful on workstations with
   * abundant memory where reload latency hurts more than the memory
   * pressure). The renderer exposes this as a `<select>` in
   * `SettingsPage` with discrete buckets (30 s / 1 min / 5 min /
   * 30 min / 1 hour / never) so users don't have to reason about
   * raw second counts.
   *
   * **Migration note:** historically `sidecar.ts` defaulted to
   * `idleUnloadMs: 60_000` and `diffusionSidecar.ts` to
   * `idleUnloadMs: 30_000`. Unifying the field intentionally
   * collapses those two defaults into a single user-controlled
   * value — the persisted setting applies to ALL three sidecars
   * (text, vision, diffusion) so the user has one knob to reason
   * about instead of three. The defaulted `60` matches the
   * text/vision historical floor; **diffusion's idle window
   * therefore doubles from 30 s → 60 s on fresh installs and on
   * existing installs where the on-disk config lacked this field
   * (the on-disk schema heals missing/corrupt values to 60 s).**
   * Users on memory-constrained GPUs (≤ 8 GB) should explicitly
   * pick the `30 seconds` bucket in `SettingsPage` to restore the
   * pre-unification diffusion behavior. This trade-off is
   * documented here because making the user-facing UI a single
   * select rather than three independent ones is a deliberate
   * UX simplification — three idle-window dropdowns would be more
   * precise but materially harder to explain.
   *
   * Bounds: `[0, 24 * 60 * 60]` (24 hours) — anything past 24h
   * is effectively "never" and the UI surfaces it as such.
   */
  modelIdleTimeoutSecs: number;
  /**
   * local telemetry toggle. When `true`, the
   * main process appends anonymised counters + timings to a local
   * JSONL sink at `<userData>/telemetry.jsonl`. The sink is
   * purely local: there is no remote endpoint, no network egress,
   * and no PII / content / identifier ever recorded. The flag
   * defaults to `false` (opt-in only) so a fresh install ships with
   * telemetry disabled, matching Tessera's local-first ethos.
   *
   * The renderer surfaces this in Settings under "Privacy". When
   * the user flips the toggle off, the in-memory buffer is dropped
   * and the on-disk file is truncated — the toggle is the only
   * source of truth.
   */
  telemetryEnabled: boolean;
  /**
   * app-lock mode. `"off"` means no lock
   * is required to open the app. `"pin"` prompts a PIN. `"biometric"`
   * uses the platform biometric (TouchID on macOS, Windows Hello on
   * Windows) and falls back to PIN if biometric is unavailable.
   * `"fido2"` uses a registered FIDO2/WebAuthn authenticator
   * (platform authenticator or roaming security key) and likewise
   * falls back to PIN if the authenticator is unavailable.
   *
   * Setup of a PIN is gated behind a separate IPC
   * (`appLock:setPin`) so flipping the mode to `"pin"` /
   * `"biometric"` / `"fido2"` without first setting a PIN is
   * rejected at the IPC boundary. `"fido2"` additionally requires a
   * registered credential (`appLock:registerFido2`). Defaults to
   * `"off"` so a fresh install does not surprise the user with a
   * lock prompt.
   */
  appLockMode: AppLockMode;
  /**
   * auto-updater Ed25519 signature
   * enforcement. When `true` (default), downloaded update artifacts
   * MUST present a valid Ed25519 signature against the embedded
   * Tessera-controlled public key before `quitAndInstall` is
   * allowed to fire. When `false`, the verification step is logged
   * as skipped — this exists so power users on a self-hosted build
   * channel with their own signing key can disable the embedded
   * check while we add a key-pinning UX in a later phase. The
   * channel is also gated by `app.isPackaged` (dev builds always
   * skip), so this flag only matters in packaged installs.
   */
  enforceUpdateSignature: boolean;
  /**
   * Per-app keychain ACL enforcement. When `true`,
   * `vaultCrypto.encryptForVault` refuses to write secrets
   * under Electron's `basic_text` fallback (Linux-only,
   * XOR-with-hardcoded-key — NOT real encryption). On macOS / Windows
   * the OS-backed backend is always available, so this flag is a
   * no-op in practice. On Linux a user without a running secret-store
   * daemon (gnome-keyring / kwallet) will see a `KeychainAclError`
   * when Tessera tries to persist a new secret; they recover by
   * starting the daemon and re-launching, or by flipping this off in
   * Settings → Security to accept the reduced protection.
   *
   * Defaults to `true` so a fresh install enforces the strict policy.
   * Reads of already-stored blobs are NEVER gated — refusing to
   * decrypt would brick a running session.
   *
   * Trust tier reported via `keychain.backend.<name>` telemetry +
   * surfaced in the Settings → Security panel:
   *   - `enforced-by-os` (macOS Keychain w/ per-bundle ACL)
   *   - `user-scoped`     (Windows DPAPI, Linux gnome/kwallet)
   *   - `none`            (Linux basic_text)
   *   - `none-unavailable` (no safeStorage; password-vault fallback active)
   */
  enforceKeychainAcl: boolean;
  /**
   * When `true` (default) the sidebar shows only the primary
   * navigation items (Home, Sources, Create, Settings) and tucks the
   * secondary tools (Templates, Tasks, Automations, Vision) behind a
   * collapsed "More tools" section. Flipping it `false` from
   * Settings → General expands the secondary section by default for
   * power users who want every destination visible at once.
   *
   * This only controls the *default* collapsed state: the user's
   * explicit expand/collapse click on the "More tools" toggle is
   * remembered separately in `localStorage` and takes precedence
   * over this flag. Keyboard shortcuts (`Ctrl/Cmd+1..N`) navigate to
   * every destination regardless of this flag, because they read the
   * full `SIDEBAR_ITEMS` array, not the visible subset.
   */
  simplifiedNav: boolean;
  /**
   * When `true` (default) a fresh install with no text model
   * installed automatically downloads the recommended model in the
   * background on first launch, surfaced via the non-blocking
   * `ModelDownloadBanner`. Set `false` (Settings → Models) to stay in
   * extraction-only mode permanently — artifacts are then assembled
   * from source material without LLM drafting until the user
   * downloads a model manually.
   */
  autoDownloadModel: boolean;
  /**
   * Controls the default Create page experience. `"wizard"` (default)
   * shows the intent-based "What do you need?" flow that surfaces a
   * small curated set of templates for new users; `"gallery"` shows
   * the full tabbed gallery of every template immediately. The user
   * can switch modes at any time via the in-page links ("Show all
   * templates" / "Guided picker"), which persist their choice here.
   */
  createPageMode: CreatePageMode;
  /**
   * Resource-management profile. `"lightweight"` (default) keeps the
   * idle footprint minimal: only one local model sidecar (text /
   * vision / diffusion) may run at a time — starting one stops the
   * others — and background work (connector sync, synthesis) is
   * gated more aggressively. `"performance"` restores the historical
   * behaviour where text + vision sidecars may run concurrently for
   * workflows that interleave text generation with VLM description.
   * The diffusion sidecar never auto-starts in either mode.
   */
  resourceMode: ResourceMode;
  /**
   * LW-9 (minimize-to-tray). When `true`, closing the main window hides
   * it to the system tray and suspends the app (sidecars stopped,
   * scheduler paused) instead of quitting; the user reopens via the
   * tray icon and quits via the tray's "Quit Tessera" item. When
   * `false` (default) closing the window quits as before. Toggled in
   * Settings → General; mirrors `AppConfig.closeToTray`.
   */
  closeToTray: boolean;
  /**
   * When `true` (default) the main process runs a periodic hot backup
   * of the encrypted database on the {@link backupIntervalHours}
   * cadence, pruning to {@link backupRetentionCount}. Flipping it off
   * (Settings → Backup) stops the timer; existing backups are kept.
   * Mirrors `AppConfig.autoBackup`.
   */
  autoBackup: boolean;
  /**
   * Absolute directory the automatic + manual backups are written to.
   * Empty string means "use the built-in default"
   * (`<userData>/backups`), which the main process resolves at
   * runtime since `userData` is not known to the renderer. Chosen via
   * the native folder picker in Settings → Backup. Mirrors
   * `AppConfig.backupDir`.
   */
  backupDir: string;
  /**
   * Interval in hours between automatic backups. Bounded to
   * `[1, 168]` (1 hour … 1 week) at the IPC boundary. Mirrors
   * `AppConfig.backupIntervalHours`.
   */
  backupIntervalHours: number;
  /**
   * Number of most-recent backups to keep; older ones are pruned
   * after each successful backup. Bounded to `[1, 30]`. Mirrors
   * `AppConfig.backupRetentionCount`.
   */
  backupRetentionCount: number;
}

// -----------------------------------------------------------------
// Backup & recovery
// -----------------------------------------------------------------

/**
 * Metadata for a single backup file on disk. Mirrors the Rust
 * `tessera_bridge::backup::BackupInfo`. `createdAtMs` /
 * `sizeBytes` are plain numbers (within `Number.MAX_SAFE_INTEGER`
 * for any realistic timestamp / file size).
 */
export interface BackupInfo {
  /** Absolute path to the backup file. */
  path: string;
  /** Bare filename (no directory component). */
  fileName: string;
  /** Creation time in milliseconds since the Unix epoch. */
  createdAtMs: number;
  /** Size of the backup file in bytes. */
  sizeBytes: number;
}

/**
 * Result of a bundle export. Mirrors
 * `tessera_bridge::backup::BundleInfo`.
 */
export interface BundleInfo {
  /** Absolute path to the written `.tessera-backup` archive. */
  path: string;
  /** Size of the archive in bytes. */
  sizeBytes: number;
  /** Number of entries (database + sidecars) packed. */
  entryCount: number;
}

/**
 * Outcome of a bundle import. Mirrors
 * `tessera_bridge::backup::BundleImportReport`.
 */
export interface BundleImportReport {
  /** Absolute path of the staged `*.pending-restore` database file. */
  stagedDbPath: string;
  /** Absolute paths of the sidecar files replaced on disk. */
  restoredFiles: string[];
}

/**
 * A sidecar file to fold into a bundle on export. Mirrors
 * `tessera_bridge::backup::BundleFileEntry`.
 */
export interface BundleFileEntry {
  /** Logical role tag recorded in the manifest (e.g. `"settings"`). */
  role: string;
  /** Stable name used inside the archive (no directory component). */
  arcname: string;
  /** Absolute path of the file to read. */
  path: string;
}

/**
 * A sidecar file target to restore on import, matched by arcname.
 * Mirrors `tessera_bridge::backup::BundleRestoreTarget`.
 */
export interface BundleRestoreTarget {
  /** Archive name to look for (matches a {@link BundleFileEntry.arcname}). */
  arcname: string;
  /** Absolute path the file is written to (atomically) on import. */
  path: string;
}

/**
 * Effective backup configuration + scheduler health, returned by
 * `backup:status` and `backup:configure`. Combines the persisted
 * `AppConfig` backup fields (with `backupDir` already resolved to the
 * absolute directory in use) with live scheduler state so the Settings
 * → Backup panel and the HomePage indicator can render without a
 * second round-trip.
 */
export interface BackupStatus {
  /** Whether the automatic-backup scheduler is enabled. */
  autoBackup: boolean;
  /**
   * Absolute directory backups are written to — the resolved path, not
   * the empty-string sentinel. The renderer shows this verbatim.
   */
  backupDir: string;
  /** Interval in hours between automatic backups. */
  backupIntervalHours: number;
  /** Number of most-recent backups retained. */
  backupRetentionCount: number;
  /** Whether the interval timer is currently armed. */
  schedulerRunning: boolean;
  /** Whether a backup is in flight right now. */
  backupInFlight: boolean;
  /**
   * Epoch-ms timestamp of the last successful backup observed by the
   * scheduler this session, or `null` if none has run yet. This is the
   * in-memory scheduler view; the authoritative "newest backup on disk"
   * comes from `backup:list`.
   */
  lastBackupAt: number | null;
  /** Message from the last failed backup this session, or `null`. */
  lastBackupError: string | null;
}

/**
 * Result of staging a single-file restore (`backup:restore`) or a
 * bundle import (`backup:importBundle`). Both stage the database for a
 * swap at next launch rather than mutating the live DB, so
 * `requiresRestart` is always `true` — the renderer uses it to drive
 * the "restart to finish restoring" confirmation.
 */
export interface BackupRestoreResult {
  /** Absolute path of the staged `*.pending-restore` database file. */
  stagedPath: string;
  /** Always `true`: the swap happens at the next launch. */
  requiresRestart: boolean;
}

/** Lower bound (inclusive) on {@link SettingsData.backupRetentionCount}. */
export const MIN_BACKUP_RETENTION_COUNT = 1;
/** Upper bound (inclusive) on {@link SettingsData.backupRetentionCount}. */
export const MAX_BACKUP_RETENTION_COUNT = 30;
/** Lower bound (inclusive) on {@link SettingsData.backupIntervalHours}. */
export const MIN_BACKUP_INTERVAL_HOURS = 1;
/** Upper bound (inclusive) on {@link SettingsData.backupIntervalHours} (1 week). */
export const MAX_BACKUP_INTERVAL_HOURS = 168;
/** Default automatic-backup cadence, in hours. */
export const DEFAULT_BACKUP_INTERVAL_HOURS = 24;
/** Default number of backups retained. */
export const DEFAULT_BACKUP_RETENTION_COUNT = 7;

/**
 * Resource-management profiles. `"lightweight"` enforces single-
 * sidecar mutual exclusion and aggressive background gating so the
 * idle footprint stays near the Electron + renderer + substrate
 * floor (no SLM resident). `"performance"` preserves concurrent
 * text + vision sidecars. Constrained to a fixed tuple so the
 * renderer toggle, the IPC schema, and the persisted config all
 * reference the same values.
 */
export const RESOURCE_MODES = ["lightweight", "performance"] as const;
export type ResourceMode = (typeof RESOURCE_MODES)[number];

/**
 * Default Create-page presentation mode. `"wizard"` is the
 * progressive-disclosure intent flow for new / non-technical users;
 * `"gallery"` is the full tabbed template gallery for power users.
 * Constrained to a fixed tuple so the renderer toggle, the IPC
 * schema, and the persisted config all reference the same values.
 */
export const CREATE_PAGE_MODES = ["wizard", "gallery"] as const;
export type CreatePageMode = (typeof CREATE_PAGE_MODES)[number];

/**
 * valid app-lock modes. Constrained to a
 * fixed enum so the renderer's lock-mode selector, the IPC schema,
 * and the persisted config all reference the same tuple.
 */
export const APP_LOCK_MODES = ["off", "pin", "biometric", "fido2"] as const;
export type AppLockMode = (typeof APP_LOCK_MODES)[number];

/**
 * maximum number of artifact IDs retained in
 * {@link SettingsData.recentArtifactIds}. Centralised here (not in
 * the renderer hook) because both the IPC validation schema
 * `SettingsUpdateSchema.recentArtifactIds.max()` and the renderer
 * `useTrackArtifactView` truncation logic must agree — a mismatch
 * would either reject a legitimate write at the IPC boundary or
 * silently let the renderer write past the documented cap.
 */
export const MAX_RECENT_ARTIFACTS = 32;

/**
 * maximum number of artifact IDs retained in
 * {@link SettingsData.pinnedArtifactIds}. Centralised alongside
 * {@link MAX_RECENT_ARTIFACTS} so the IPC validation schema, the
 * on-disk config schema, and the renderer truncation logic all
 * reference the same source of truth. A mismatch would either
 * reject a legitimate write at the IPC boundary or silently let
 * the renderer write past the documented cap.
 *
 * PR #87: removed the previous "can't
 * import from shared/types because of project boundaries" caveat
 * — `electron/config.ts` already imports from `../shared/types`,
 * so there is no actual cross-project obstacle, and three literal
 * `256` / `32` duplicates risked drift.
 */
export const MAX_PINNED_ARTIFACTS = 256;

/**
 * hard upper bound on `modelIdleTimeoutSecs`.
 * 24 hours is well past any reasonable interactive session — beyond
 * this the field is effectively the same as `0` (never unload) but
 * we keep the explicit cap to bound the on-disk value and to keep
 * `setInterval(...)` math from overflowing on the sidecar side.
 *
 * Shared between the IPC schema, the on-disk config schema, the
 * renderer's `<select>` validator, and the doc comment above so a
 * future change to the cap stays in lockstep across layers. Mirrors
 * the constants-consolidation pattern from `MAX_PINNED_ARTIFACTS`
 * and `MAX_RECENT_ARTIFACTS`.
 */
export const MAX_MODEL_IDLE_TIMEOUT_SECS = 24 * 60 * 60;

/**
 * default idle window in seconds for the
 * local text/vision sidecar host. Matches the historical
 * `idleUnloadMs: 60_000` literal that lived in
 * `electron/sidecar.ts` DEFAULT_OPTIONS before the field was made
 * user-configurable. Re-exporting from `shared/types.ts` keeps the
 * IPC `settings:get` fallback, the on-disk config `.catch(...)`
 * default, and the renderer's `DEFAULT_SETTINGS` in lockstep so a
 * fresh install behaves identically with or without the field on
 * disk.
 */
export const DEFAULT_MODEL_IDLE_TIMEOUT_SECS = 60;

/**
 * maximum number of in-memory telemetry
 * events retained before a flush. Bounded so the in-process buffer
 * cannot grow without bound when the user enables telemetry and
 * never restarts the app. The flush cadence (60 s) means a
 * realistic session never approaches this cap, but the bound
 * defends against a runaway emitter (e.g. a bridge crash loop)
 * filling memory.
 */
export const TELEMETRY_BUFFER_MAX_EVENTS = 1024;

/**
 * interval between telemetry buffer
 * flushes to the on-disk sink, in milliseconds. Set to 60 seconds
 * because telemetry events are small (a counter increment or a
 * timing sample) and a 60-second batch keeps disk IO infrequent
 * while still flushing on a user-perceivable timescale before
 * `app.willQuit` fires.
 */
export const TELEMETRY_FLUSH_INTERVAL_MS = 60_000;

/**
 * minimum PIN length. Six digits is the
 * standard minimum for a numeric PIN (matching iOS / Android device
 * passcodes). Longer PINs and alphanumeric passwords are also
 * accepted up to 256 characters.
 */
export const APP_LOCK_PIN_MIN_LENGTH = 6;

/**
 * maximum PIN length. 256 characters is
 * an upper bound on what we'll PBKDF2 — long enough for users who
 * want to use a passphrase, short enough that a malformed payload
 * cannot stall the derivation step for seconds.
 */
export const APP_LOCK_PIN_MAX_LENGTH = 256;

/**
 * failed-attempt lockout threshold. After
 * this many consecutive incorrect PIN attempts, the app refuses
 * further attempts for {@link APP_LOCK_BACKOFF_BASE_MS} *
 * 2^(attempts - threshold) milliseconds. Standard mobile-OS
 * behaviour uses 5 attempts before backoff kicks in.
 */
export const APP_LOCK_LOCKOUT_THRESHOLD = 5;

/**
 * base backoff duration in milliseconds.
 * After the lockout threshold is reached, each subsequent failed
 * attempt doubles the wait. Starts at 30 seconds, capped at 1 hour
 * by {@link APP_LOCK_BACKOFF_MAX_MS}.
 */
export const APP_LOCK_BACKOFF_BASE_MS = 30_000;

/**
 * maximum backoff duration in
 * milliseconds. Caps the exponential growth at 1 hour so a
 * legitimate user who genuinely forgot their PIN can recover
 * within a session without leaving the app permanently bricked.
 * The user can always wipe `<userData>/app-lock.bin` to reset.
 */
export const APP_LOCK_BACKOFF_MAX_MS = 60 * 60 * 1000;

// -----------------------------------------------------------------
// External provider configuration
// -----------------------------------------------------------------

// `EXTERNAL_PROVIDER_TYPES` is the single source of truth for which
// remote inference providers Tessera supports. The const tuple feeds
// both the zod runtime validators (IPC `ExternalProviderConfigSchema`
// + on-disk `ExternalProviderConfigOnDiskSchema`) and the
// `ExternalProviderType` compile-time union — adding a new provider
// only requires extending this list.
export const EXTERNAL_PROVIDER_TYPES = [
  "openai_compatible",
  "anthropic",
  "custom",
] as const;
export type ExternalProviderType = (typeof EXTERNAL_PROVIDER_TYPES)[number];

/** Payload accepted by `externalProvider.set` from the renderer. */
export interface ExternalProviderConfigInput {
  enabled: boolean;
  providerType: ExternalProviderType;
  apiUrl: string;
  apiKeyRef: string;
  modelName: string;
  maxTokens: number;
  temperature: number;
  timeoutSecs: number;
  maxRetries: number;
}

/** Payload returned by `externalProvider.get` / `.set`. Includes the
 *  derived `hasApiKey` so the renderer can hide the password field
 *  when the keychain already has a value. */
export interface ExternalProviderConfigView extends ExternalProviderConfigInput {
  hasApiKey: boolean;
}

export type ExternalProviderTestResult =
  | { ok: true; latencyMs: number }
  | { ok: false; error: string };

/**
 * Result of listing available models from an OpenAI-compatible
 * provider via `GET /v1/models`. Discriminated on `ok` so renderer
 * code can switch on success vs. failure without crashing on
 * provider-not-supported or transport errors.
 *
 * - `ok: true, models: string[]`: at least one model id was
 *   returned. Sorted alphabetically by id for stable display.
 * - `ok: false, kind: "unsupported"`: the configured provider type
 *   does not expose a models endpoint AT ALL (Anthropic — the
 *   Messages API has no `/v1/models` analogue). The renderer
 *   should gracefully degrade to the manual text input.
 * - `ok: false, kind: "endpoint_not_found", url: string`: the
 *   provider type supports the schema in principle, but THIS
 *   provider's deployment returned HTTP 404 at the `/v1/models`
 *   URL. This is the common case for custom self-hosted shims
 *   that implement chat completions without the models discovery
 *   endpoint (e.g. older llama-server builds, minimal proxies).
 *   Distinguished from the generic `error` variant so the renderer
 *   can show a hint that points the user at the manual text input
 *   instead of treating it as a transient failure they should
 *   retry. The `url` is the exact endpoint the renderer attempted
 *   so the user can verify the deployment exposes it.
 * - `ok: false, kind: "error", error: string`: network or
 *   non-404 HTTP error. The renderer should surface the message
 *   and keep the manual text input.
 */
export type ExternalProviderListModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; kind: "unsupported" }
  | { ok: false; kind: "endpoint_not_found"; url: string }
  | { ok: false; kind: "error"; error: string };

/**
 * Optional draft-state overrides accepted by
 * `externalProvider:listModels`. Lets the renderer's "List models"
 * button operate against in-flight form state (apiUrl /
 * providerType) without forcing the user to save first. The
 * main-process handler merges these atop the persisted
 * `externalProvider` config — fields left undefined inherit the
 * saved value.
 *
 * `apiKey` is intentionally NOT settable here: the IPC layer
 * keeps plaintext keys out of the wire, and the persisted vault
 * entry (looked up via `apiKeyRef`) is always used for the actual
 * HTTP call. To list models against a NEW key, the user must save
 * the key first.
 *
 * `enabled` IS settable so a user who has just toggled the
 * provider on in the form (but not yet saved) can still click
 * "List models" without first hitting Save. Previously the
 * handler gated on the PERSISTED `enabled` flag, so a fresh-enable
 * + List would fail with "External provider is disabled" even
 * though the form the user is looking at clearly intends the
 * provider to be on.
 * Including `enabled` in the draft override lets the handler gate
 * on the EFFECTIVE config (overrides merged atop persisted) so
 * the UX matches the user's mental model.
 */
export interface ExternalProviderListModelsDraftOverrides {
  apiUrl?: string;
  providerType?: ExternalProviderType;
  enabled?: boolean;
}

/**
 * Cumulative external-provider token usage. The shape and units are
 * documented in `electron/tokenCounter.ts`. Lives in `AppConfig` so
 * it survives launches; the renderer reads it via
 * `externalProvider.getTokenUsage` and resets it via
 * `externalProvider.resetTokenUsage`.
 */
export interface ExternalProviderTokenUsage {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  /** ISO-8601 timestamp when the counter was last reset. */
  lastResetDate: string;
}

// -----------------------------------------------------------------
// Tasks & decisions
// -----------------------------------------------------------------

/**
 * Item extracted from a source by `bridge_extract_tasks_decisions`.
 * Must stay in sync with the Rust bridge's emitted JSON; the
 * validation contract lives in `electron/extractedItemValidation.ts`.
 */
export interface ExtractedItem {
  itemType: "task" | "decision";
  text: string;
  sourceCitation: string;
  confidence: number;
}

// -----------------------------------------------------------------
// Model runtime
// -----------------------------------------------------------------

export interface ModelStatus {
  available: boolean;
  modelName: string | null;
  status: string;
}

export type ModelPlatform =
  | "macos-apple-silicon"
  | "macos-intel"
  | "windows-x64"
  | "linux-x64"
  | "linux-arm64";

export type ModelFormat = "gguf" | "mlx";
export type ComputeBackend = "cpu" | "cuda" | "vulkan" | "metal" | "rocm";
export type DeviceTier = "low" | "medium" | "high";

/**
 * Per-capability model slot. Tessera installs at most one model on
 * disk per capability per device:
 *   - `"text"`     — text generation (Ternary-Bonsai today).
 *   - `"vision"`   — vision-language model (image description, OCR,
 *                    chart extraction).
 *   - `"imagegen"` — diffusion-based image generation. GPU-gated;
 *                    not available on Low tier or CPU-only devices.
 *
 * Mirrors the Rust `ModelCapability` enum in
 * `crates/tessera_runtime/src/config.rs`. The lowercase string form is
 * the wire format used by both the manifest (`sidecars/models.json`)
 * and the per-slot on-disk record file (`active-model-<capability>.json`).
 */
export type ModelCapability = "text" | "vision" | "imagegen";

export interface PlatformInfo {
  platform: ModelPlatform;
  platformLabel: string;
  totalRamGb: number;
  tier: DeviceTier;
  tierLabel: string;
  computeBackends: ComputeBackend[];
  preferredFormat: ModelFormat;
}

export interface ResolvedModel {
  id: string;
  name: string;
  parameters: string;
  /**
   * Which slot this model occupies. Mirrors `ModelCapability` in the
   * Rust runtime (`crates/tessera_runtime/src/config.rs`). The
   * manifest defaults this to `"text"` when absent for forward
   * compatibility with the single-slot era.
   */
  capability: ModelCapability;
  format: ModelFormat;
  formatLabel: string;
  quantization: string;
  platform: ModelPlatform;
  tier: DeviceTier;
  computeBackends: ComputeBackend[];
  downloadSizeMb: number;
  diskSizeMb: number;
  requiredRamGb: number;
  contextLength: number;
  filename: string;
  url: string;
  sha256: string | null;
  /**
   * Vision-only: filename of the multimodal projector (mmproj) that
   * llama-server needs alongside the main weights to load the vision
   * tower. Stored as a sibling file of `filename` inside the per-slot
   * `models/vision/` directory. Absent on:
   *   - Text and imagegen entries (no projector concept).
   *   - MLX vision entries (the projector is packaged inside the
   *     archive and the MLX adapter loads it implicitly).
   * Required (alongside `mmprojUrl`) on all `vision` + `gguf` entries.
   */
  mmprojFilename?: string;
  mmprojUrl?: string;
  mmprojSha256?: string | null;
  /**
   * Disk footprint contributed by the projector file on its own.
   * Reported separately from `diskSizeMb` so the Settings UI can
   * show users the total cost of the vision slot (weights +
   * projector) without forcing every reader to maintain a side
   * table of per-entry projector sizes.
   */
  mmprojSizeMb?: number;
}

export interface InstalledModelRecord {
  modelId: string;
  /**
   * Which slot the installed model occupies. Records persisted before
   * multi-slot model storage was introduced have no `capability`
   * field and are interpreted as `"text"` by
   * `getCurrentModel` / `getInstalledModel` (the only slot that
   * existed at the time). Kept optional here so the type matches
   * legacy on-disk records.
   */
  capability?: ModelCapability;
  format: ModelFormat;
  filename: string;
  path: string;
  downloadSizeMb: number;
  /**
   * Records persisted before `diskSizeMb` was added (or by an older
   * build) won't have this field — read via `effectiveDiskSizeMb`
   * from `modelManagement.ts` to fall back to `downloadSizeMb`.
   * Kept optional here so the type matches the on-disk wire shape.
   */
  diskSizeMb?: number;
  sha256: string | null;
  /**
   * Absolute on-disk path to the downloaded multimodal projector,
   * populated for vision GGUF installs whose manifest entry carried
   * `mmprojFilename` + `mmprojUrl`. The vision sidecar is started
   * with `--mmproj <mmprojPath>` so llama-server can wire the vision
   * tower onto the language model.
   *
   * Always absent on text / imagegen / MLX-vision records (those
   * code paths don't use a sibling projector file).
   */
  mmprojPath?: string;
  mmprojSha256?: string | null;
  /**
   * Disk footprint of the projector file alone. Read separately from
   * `diskSizeMb` by the Settings UI's per-slot disk-usage display so
   * users see the true cost of the vision slot.
   */
  mmprojSizeMb?: number;
  downloadedAt: string;
}

/**
 * Aggregate of installed models across all slots. Used by
 * `runtime:getInstalledModels` so the Settings UI can render disk
 * usage and per-slot install state without N round-trips.
 *
 * Slots with no model installed map to `null`.
 */
export type InstalledModelsByCapability = Record<
  ModelCapability,
  InstalledModelRecord | null
>;

export type DownloadPlan =
  | { kind: "already-installed"; modelId: string }
  | {
      kind: "direct-download";
      modelId: string;
      filename: string;
      downloadSizeMb: number;
      message: string;
    }
  | {
      kind: "swap";
      evictModelId: string;
      evictFilename: string;
      evictSizeMb: number;
      installModelId: string;
      installFilename: string;
      installSizeMb: number;
      netDiskDeltaMb: number;
      message: string;
    };

export interface ModelDownloadProgress {
  modelId: string;
  /**
   * Which slot the in-flight download is targeting. Renderer event
   * dispatch routes per-capability progress to the correct progress
   * bar in the multi-slot Settings UI.
   */
  capability: ModelCapability;
  format: ModelFormat;
  filename: string;
  downloadedMb: number;
  totalMb: number;
  percent: number;
}

/**
 * Terminal failure of a background model download, broadcast on the
 * `runtime:downloadError` channel. The renderer-initiated
 * `runtime:downloadModel` / `runtime:downloadRecommended` invocations
 * surface their own rejection to the caller, so this event exists
 * specifically for the main-process FIRST-LAUNCH auto-download
 * (`autoModelDownload.ts`), which is fire-and-forget and has no caller
 * to reject to. The `ModelDownloadBanner` observes it to flip to its
 * "Setup failed — retry" state. `modelId` is absent when the failure
 * occurred before a model was resolved (e.g. the manifest could not be
 * read).
 */
export interface ModelDownloadError {
  capability: ModelCapability;
  modelId?: string;
  message: string;
}

export interface GenerateRequest {
  templateId?: string;
  sourceIds?: string[];
  sectionIndex?: number;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface GenerateChunk {
  token: string;
  done: boolean;
  error?: string;
}

/**
 * Resolved value of a `model:generate` dispatch (LW-3). The normal
 * streaming path resolves `void` and delivers tokens via the
 * `model:token` channel. When synthesis is paused because the device is
 * on a low battery (≤20% and discharging), the handler resolves this
 * sentinel INSTEAD of starting a stream, so the caller can surface
 * "Generation paused — battery below 20%" without waiting on a token
 * that will never arrive. Desktops / AC power / unknown battery state
 * never gate (fail open), so this is only ever returned on a laptop
 * that is genuinely low and unplugged.
 */
export interface GenerateBatteryGated {
  status: "battery_low";
}

// -----------------------------------------------------------------
// Connectors
// -----------------------------------------------------------------

export interface ConnectorFileInfo {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  modifiedTime: string | null;
  isFolder: boolean;
  parentId: string | null;
}

export interface ConnectorStatusInfo {
  provider: string;
  connected: boolean;
  status: string;
}

/**
 * Result of a `connectors:test` connection probe — the single source of
 * truth for the IPC contract, imported by both the main-process handler
 * (`ipc/connectors/handlers.ts`) and the renderer. Carries NO secret
 * values — `message` is the connector framework's flattened,
 * machine-categorised reason, safe to render in the modal.
 */
export interface ConnectorProbeResult {
  provider: string;
  /** True iff the connector completed an authenticated read. */
  ok: boolean;
  /**
   * Change events the connector surfaced on its first authenticated
   * read — a reachability signal, present on success. Zero is a valid
   * success, so the UI keys off `ok`, not this count.
   */
  observedEvents?: number;
  /** True when the failure was a network/transport fault (offline). */
  offline?: boolean;
  /** Non-secret, human-readable failure reason. Present iff `!ok`. */
  message?: string;
}

export interface DriveFileListResult {
  nextPageToken: string | null;
  files: ConnectorFileInfo[];
  /**
   * Set to `true` when the IPC handler caught a `NetworkError` while
   * talking to Google Drive (DNS failure, TCP refused, fetch rejected
   * without a status code, etc.) and degraded to a soft-offline
   * response instead of throwing. The renderer uses this to show an
   * "Offline" affordance in the file picker rather than a raw error
   * banner that says "fetch failed", which would mislead the user
   * into thinking their token expired or the Drive API is down. Same
   * idea as the `"offline"` `ConnectorSyncResult.status` that the
   * sync wrapper returns.
   */
  offline?: boolean;
}

export interface DriveSyncResult {
  added: number;
  modified: number;
  removed: number;
  status: string;
}

export interface DrivePickerItem {
  id: string;
  name: string;
  mimeType: string;
}

export interface DrivePickerSelection extends DrivePickerItem {
  selected: boolean;
}

// -----------------------------------------------------------------
// Tasks
// -----------------------------------------------------------------

/**
 * Single source of truth for task status / priority. The arrays are
 * runtime values so the IPC zod schemas
 * (`apps/desktop/electron/ipc/schemas.ts`) and the renderer's
 * TasksPage Kanban columns + dropdowns can both pull from one
 * declaration. Adding a new column means adding a value here and
 * nothing else.
 */
export const TASK_STATUSES = ["todo", "in_progress", "done", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface TaskInfo {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  position: number;
  assignee: string | null;
  dueDate: string | null;
  sourceId: string | null;
  extractedItemId: string | null;
  /** Ids of the tasks this task depends on (UUID strings). Empty when
   *  the task has no dependencies. Drives the Gantt dependency arrows. */
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskRequest {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  assignee?: string | null;
  dueDate?: string | null;
  sourceId?: string | null;
  extractedItemId?: string | null;
  /** Task ids (UUID strings) this task depends on. Defaults to empty. */
  dependsOn?: string[];
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  position?: number;
  /**
   * Tri-state field. `undefined` (key omitted) leaves the value
   * unchanged. `null` explicitly clears the assignee. A string sets it.
   * The bridge enforces this via `Option<Option<String>>` — see
   * `tessera_bridge::tasks::UpdateTaskRequest`.
   */
  assignee?: string | null;
  /**
   * Same tri-state semantics as `assignee`. The bridge surfaces a
   * parse error if a non-empty string isn't valid RFC 3339 — see
   * the `update_task_with_invalid_due_date_does_not_clear_existing`
   * regression test.
   */
  dueDate?: string | null;
  /**
   * `undefined` (key omitted) leaves the dependency set unchanged. An
   * array replaces it; pass `[]` to clear all dependencies. The bridge
   * rejects an update that would introduce a dependency cycle.
   */
  dependsOn?: string[];
}

// -----------------------------------------------------------------
// Automations
// -----------------------------------------------------------------

export type AutomationTrigger =
  | { kind: "schedule"; interval_seconds: number }
  | { kind: "on_generate"; template_id: string }
  | { kind: "on_kchat_message_match"; channel_id: string; regex: string };

export type AutomationAction =
  | { kind: "reindex_source"; source_id: string }
  | {
      kind: "generate_from_template";
      template_id: string;
      source_ids: string[];
    }
  /** Run an ordered list of leaf actions; a failing step is reported
   *  but does not abort the remaining steps. */
  | { kind: "sequence"; actions: AutomationAction[] };

export interface AutomationInfo {
  id: string;
  name: string;
  /** Tagged-enum JSON: `{ "kind": "schedule", "interval_seconds": N }` or
   *  `{ "kind": "on_generate", "template_id": "..." }`. */
  triggerJson: string;
  /** Tagged-enum JSON: `{ "kind": "reindex_source", "source_id": "..." }`
   *  or `{ "kind": "generate_from_template", "template_id": "...",
   *  "source_ids": [...] }`. */
  actionJson: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  nextScheduledAt: string | null;
}

export interface CreateAutomationRequest {
  name: string;
  trigger: AutomationTrigger;
  action: AutomationAction;
  enabled?: boolean;
}

export interface SchedulerStatusInfo {
  running: boolean;
  lastTickAt: string | null;
  lastTickError: string | null;
  inFlight: boolean;
}

/** Renderer-side alias for `SchedulerStatusInfo` (preserved for
 *  backwards compatibility with `renderer/src/types/ipc.ts`). */
export type SchedulerStatus = SchedulerStatusInfo;

// -----------------------------------------------------------------
// Dialogs
// -----------------------------------------------------------------

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface SaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

/**
 * Options for `dialog:pickImage`. The filter list and the `properties`
 * array are decided main-side so the renderer can't widen the picker
 * beyond image files. `title` is the only knob exposed because it's
 * the only UX element the renderer reasonably needs to vary (e.g.
 * "Choose a chart to analyse" vs "Choose a whiteboard photo").
 */
export interface OpenImageDialogOptions {
  title?: string;
}

/**
 * Result shape for `dialog:pickImage`. `canceled` is always present
 * so the renderer can branch on it without optional-chaining; when
 * `canceled` is true, `filePath` is `null`. When `canceled` is
 * false, `filePath` is a non-empty absolute path the renderer
 * forwards to `vision:describe` (or other downstream IPCs).
 *
 * `filePath` is non-nullable rather than optional so the renderer
 * gets a strict `string | null` discriminated-union semantics —
 * the existing `SaveDialogResult.filePath?: string` shape predates
 * this pattern and is left alone for backward compatibility.
 */
export interface OpenImageDialogResult {
  canceled: boolean;
  filePath: string | null;
}

// -----------------------------------------------------------------
// Auto-updater
// -----------------------------------------------------------------

export interface UpdateStatusInfo {
  status:
    | "idle"
    | "checking"
    | "available"
    | "not-available"
    | "downloading"
    | "downloaded"
    | "error";
  message?: string;
  percent?: number;
  bytesPerSecond?: number;
  newVersion?: string;
}

// -----------------------------------------------------------------
// Per-domain API surface (function signatures)
//
// `TesseraApi` (the renderer-facing namespace surfaced on
// `window.tessera`) lives in `renderer/src/types/ipc.ts` because it
// also augments the `Window` global. The per-domain interfaces below
// are reused by both the preload's `api: TesseraApi` declaration and
// the renderer's `Window.tessera` augmentation so the two cannot
// drift.
// -----------------------------------------------------------------

// -----------------------------------------------------------------
// IPC batch operation envelope shared between
// the main process (`electron/ipc/batch.ts`), the preload bridge,
// and the renderer-side callers. Lives in `shared/types.ts` (not
// in `electron/ipc/batch.ts`) because the renderer cannot import
// from `electron/` — that path is restricted to the main process
// by Electron's process model and by the renderer's tsconfig.
// Moving the contract here is the only way the three sides can
// agree on the wire format. See `electron/ipc/batch.ts:runBatch`
// for the producer side and `preload.ts` for the consumer side.
// -----------------------------------------------------------------

/**
 * Hard cap on the number of items in a single batch IPC call.
 *
 * The cap is "an order of magnitude above any realistic UI
 * action" — the largest practical bulk action a user might
 * trigger is "re-index every source after a connector schema
 * change", which on a power-user workspace tops out around ~50
 * sources. 256 leaves plenty of headroom for "select all"
 * workflows without letting a compromised renderer DOS the
 * bridge. Renderer-side enforcement is advisory; the main
 * process re-validates and rejects oversized batches.
 */
export const BATCH_MAX_ITEMS = 256;

/**
 * Per-item outcome surfaced to the renderer.
 *
 * Discriminated union (rather than `value: T | null`) so the
 * renderer's `result.ok` narrowing in TypeScript works without
 * an extra `result.error == null` check.
 */
export type BatchItemResult<T> =
  | { id: string; ok: true; value: T }
  | { id: string; ok: false; error: string };

/**
 * Aggregate response for a batch IPC call.
 *
 * - `total`: number of items submitted (always equals `results.length`).
 * - `succeeded`: count of `ok: true` entries.
 * - `failed`: count of `ok: false` entries.
 * - `results`: per-item outcomes in input order, so the renderer
 *   can render "row 7 of 12 failed" without a second round-trip.
 */
export interface BatchResponse<T> {
  total: number;
  succeeded: number;
  failed: number;
  results: BatchItemResult<T>[];
}

export interface SourceApi {
  addLocalFolder: (path: string) => Promise<SourceInfo>;
  addLocalFile: (path: string) => Promise<SourceInfo>;
  listSources: () => Promise<SourceInfo[]>;
  removeSource: (id: string) => Promise<void>;
  searchSources: (query: string, limit: number) => Promise<SearchHit[]>;
  /**
   * Observation-enriched search. Returns the same retention-weighted
   * chunk `hits` as {@link searchSources} plus the additive knowledge
   * plane (entities, facts, concepts, memories) for the "Knowledge"
   * tab. Backed by `sources:searchEnriched`.
   */
  searchEnriched: (
    query: string,
    limit: number,
  ) => Promise<EnrichedSearchResult>;
  getDetail: (id: string) => Promise<SourceDetailInfo>;
  reindex: (id: string) => Promise<SourceInfo>;
  /**
   * re-index up to {@link BATCH_MAX_ITEMS} sources
   * in a single IPC round-trip. Replaces the
   * `Promise.all(ids.map(id => sources.reindex(id)))` pattern so a
   * 50-source workspace pays one rate-limiter token and one IPC
   * handshake instead of 50.
   *
   * Per-source errors are isolated into the `BatchItemResult`
   * envelope; the call resolves (does not reject) on partial
   * failure. The renderer should iterate `results` and surface a
   * per-item toast / dialog for each `ok: false`.
   */
  batchReindex: (sourceIds: string[]) => Promise<BatchResponse<SourceInfo>>;
  getIndexingProgress: (id: string) => Promise<IndexingProgressInfo>;
  /**
   * Run an embedding-backfill pass over every chunk missing an
   * embedding for the active model. Idempotent. Pass `batchSize`
   * to override the bridge default (used by tests).
   */
  backfillEmbeddings: (
    batchSize?: number,
  ) => Promise<BackfillEmbeddingsResult>;
  /** Lightweight poll for the active backfill pass. */
  getEmbeddingProgress: () => Promise<EmbeddingProgressInfo>;
  /**
   * per-source health snapshot for the Settings
   * page Source Health dashboard. One round-trip aggregates last
   * sync time, sync-status traffic-light, indexed chunk count, and
   * on-disk storage estimate across every source.
   */
  healthReport: () => Promise<SourceHealthReport>;
}

/**
 * wire shape for `sources:healthReport`.
 *
 * `health` is a derived traffic-light over the underlying
 * `SourceStatus` enum plus the on-disk staleness check:
 *   - `error`   → backing status reads `error` / `access_revoked`
 *   - `warning` → status is `indexing`, OR any indexed file failed
 *                 to stat (file moved since last index), OR no
 *                 `lastIndexed` timestamp persisted yet
 *   - `healthy` → status is `indexed` / `connected` AND every
 *                 indexed file is still readable
 * `storageBytes` sums `fs.stat(path).size` over every indexed file
 * (NOT over the source root directory) — exactly the bytes Tessera
 * is paying to keep chunked. `staleFiles` reports how many indexed
 * files no longer stat (useful for "Re-index to clean up" UI nudges).
 */
export interface SourceHealthEntry {
  sourceId: string;
  sourceType: string;
  path: string;
  lastIndexed: string | null;
  /** Raw backing `SourceStatus` (snake_case from Rust). */
  status: string;
  health: "healthy" | "warning" | "error";
  chunkCount: number;
  storageBytes: number;
  staleFiles: number;
}

export interface SourceHealthReport {
  /** ISO-8601 timestamp the snapshot was assembled at. */
  generatedAt: string;
  sources: SourceHealthEntry[];
}

export interface ArtifactApi {
  create: (
    title: string,
    artifactType: string,
    templateId?: string,
  ) => Promise<ArtifactInfo>;
  update: (id: string, content: string) => Promise<ArtifactInfo>;
  list: () => Promise<ArtifactInfo[]>;
  get: (id: string) => Promise<ArtifactInfo>;
  remove: (id: string) => Promise<void>;
  exportArtifact: (
    id: string,
    format: string,
    contentOverride?: string | null,
  ) => Promise<ExportResult>;
  /**
   * export up to {@link BATCH_MAX_ITEMS} artifacts
   * to the same `format` in a single IPC round-trip. Intended for
   * "Export selected" workflows in the Artifacts page where the
   * user has checked N rows and clicked "Export as PDF".
   *
   * Note: the per-item handler intentionally passes `null` for
   * `contentOverride` — the batch path always exports the
   * persisted DB content, never an in-editor override. If the
   * renderer needs to export a dirty editor, it must save first
   * (or fall through to the single-item `exportArtifact` path).
   *
   * Per-artifact errors are isolated into the `BatchItemResult`
   * envelope; the call resolves (does not reject) on partial
   * failure.
   */
  batchExport: (
    artifactIds: string[],
    format: string,
  ) => Promise<BatchResponse<ExportResult>>;
  exportToFile: (
    id: string,
    format: string,
    filePath: string,
    contentOverride?: string | null,
  ) => Promise<string | null>;
  listVersions: (id: string) => Promise<ArtifactVersionInfo[]>;
  restoreVersion: (id: string, versionNumber: number) => Promise<ArtifactInfo>;
  generateFromTemplate: (
    templateId: string,
    sourceIds: string[],
  ) => Promise<ArtifactInfo>;
  extractTasksDecisions: (sourceId: string) => Promise<ExtractedItem[]>;
  compareSources: (
    sourceIdA: string,
    sourceIdB: string,
  ) => Promise<CompareSourcesResult>;
  exportEvidencePack: (
    artifactId: string,
    outputPath: string,
  ) => Promise<string>;
  exportMarp: (req: MarpExportRequest) => Promise<string | null>;
  exportTypst: (req: TypstExportRequest) => Promise<TypstExportResult>;
  /**
   * artifact auto-save recovery probe. Called when
   * an artifact is opened to decide whether to surface a "Restore
   * unsaved changes from <time>?" prompt.
   *
   * Returns the {@link ArtifactRecoveryEnvelope} when a sidecar
   * file exists and is strictly newer than the DB row's
   * `updatedAt`, otherwise `null` (no prompt). The handler also
   * silently clears stale sidecars (sidecar timestamp ≤ DB
   * `updatedAt`) so subsequent opens don't have to re-decide.
   */
  checkRecovery: (id: string) => Promise<ArtifactRecoveryEnvelope | null>;
  /**
   * explicit-discard for the auto-save recovery
   * sidecar. Invoked when the user clicks "Discard" on the restore
   * prompt. Idempotent — calling for an artifact with no sidecar
   * is a successful no-op.
   */
  discardRecovery: (id: string) => Promise<boolean>;
  /**
   * list pending failed exports persisted under
   * `<userData>/failed-exports.json`. Powers the Settings page's
   * "Failed exports" card.
   */
  failedExports: () => Promise<FailedExportEntry[]>;
  /**
   * one-click retry of a previously failed
   * export. Resolves to the destination path on success, `null` if
   * the entry has already been removed (race with another retry
   * or with `discardFailedExport`), and rejects with the
   * underlying export error if the retry itself fails (the queue
   * entry stays in place with `retryCount` incremented).
   */
  retryExport: (exportId: string) => Promise<string | null>;
  /**
   * discard a failed-export entry without
   * retrying. Used when the user clicks "Dismiss" — the artifact
   * has been deleted or they no longer want the export.
   */
  discardFailedExport: (exportId: string) => Promise<boolean>;
}

/**
 * persisted shape of one failed export entry.
 * Identical to the on-disk envelope in
 * `apps/desktop/electron/failedExportQueue.ts:FailedExportEntry` —
 * lifted to `shared/types.ts` so the renderer's Settings UI can
 * type-check against the same shape the main-process layer
 * persists.
 */
export interface FailedExportEntry {
  /** Stable ID generated server-side at enqueue time. */
  id: string;
  artifactId: string;
  format: string;
  /**
   * Original destination path. Always a non-empty absolute path —
   * the main-process `enqueueFailedExport` rejects empty or
   * relative inputs at the write boundary, and `listFailedExports`
   * filters tampered entries on read. Renderer code can rely on
   * `filePath` being directly usable as a retry destination.
   */
  filePath: string;
  /** Human-readable failure reason. */
  errorMessage: string;
  /** Epoch ms at enqueue time. */
  failedAt: number;
  /** Cumulative retry attempts since initial failure. */
  retryCount: number;
}

/**
 * shape returned by `artifacts:checkRecovery`. A
 * non-null value means the main-process side observed a recovery
 * sidecar strictly newer than the DB row's `updatedAt`, so the
 * renderer should surface the restore prompt with `timestamp` (epoch
 * ms) as the "Unsaved since…" label and `content` as the body to
 * restore on user confirmation.
 *
 * `version` mirrors the on-disk envelope version (see
 * `apps/desktop/electron/artifactRecovery.ts`). A future format
 * bump would surface as an envelope with a different value here,
 * which the renderer can reject without misinterpreting the
 * payload.
 */
export interface ArtifactRecoveryEnvelope {
  version: 1;
  artifactId: string;
  content: string;
  /** Epoch ms at the moment the sidecar was written by main. */
  timestamp: number;
}

export interface TemplateApi {
  list: () => Promise<TemplateInfo[]>;
  get: (id: string) => Promise<TemplateInfo | null>;
}

export interface CitationApi {
  list: (artifactId: string) => Promise<CitationInfo[]>;
  add: (req: AddCitationRequest) => Promise<CitationInfo>;
  remove: (artifactId: string, citationId: string) => Promise<void>;
  checkChanged: (citationId: string) => Promise<boolean>;
  checkFreshness: (citationId: string) => Promise<CitationFreshness>;
  replace: (req: ReplaceCitationRequest) => Promise<ReplaceCitationResult>;
}

export interface SettingsApi {
  get: () => Promise<SettingsData>;
  update: (settings: Partial<SettingsData>) => Promise<SettingsData>;
  /**
   * Fetch the current effective hybrid retrieval config. Lives on
   * `SettingsApi` (not `SourceApi`) because the channel name is
   * `settings:getHybridSearchConfig` and the handler is registered
   * inside `registerSettingsHandlers()` — keeping the IPC channel
   * namespace, the handler module, and the preload surface aligned
   * to one mental model ("hybrid search is a global setting")
   * makes the handler easy to find from any of those entry points.
   */
  getHybridSearchConfig: () => Promise<HybridSearchConfigInfo>;
  /**
   * Apply a partial-update patch to the hybrid retrieval config.
   * Returns the new effective config so the renderer can echo it
   * back into its form state. Validation errors reject the entire
   * patch (transactional).
   */
  updateHybridSearchConfig: (
    update: HybridSearchConfigUpdate,
  ) => Promise<HybridSearchConfigInfo>;
  /**
   * snapshot of every shipped ONNX embedding
   * model + per-model install state + the active embedder's
   * `modelId` + the in-flight download state, in one round trip.
   * Polled on a 1 s timer by the embedding-model card so the UI
   * stays in sync with downloads triggered from elsewhere
   * (multiple Settings windows, future scriptable IPC, etc.).
   */
  getEmbeddingModelStatus: () => Promise<EmbeddingModelStatusInfo>;
  /**
   * lightweight progress poll for in-flight model
   * downloads. Returns the latest tracker snapshot — cheap enough
   * to call at 500 ms cadence so the progress bar feels live.
   */
  getEmbeddingDownloadProgress: () => Promise<EmbeddingDownloadProgressInfo>;
  /**
   * trigger a model download. Resolves with the
   * model's catalogue entry (with `installed: true`) on success;
   * rejects with the download error on network / checksum failure.
   * Idempotent — calling on an already-installed model returns
   * immediately. Rate-limited at 1 call / 5 s.
   */
  downloadEmbeddingModel: (slug: string) => Promise<EmbeddingModelInfo>;
  /**
   * activate a downloaded model and fire a
   * fire-and-forget background backfill so existing chunks get
   * the new model's vectors. Returns the freshly-activated
   * model's catalogue entry. Rate-limited at 1 call / 1 s.
   * Surfaces backfill progress through the existing
   * `sources:getEmbeddingProgress` channel; this channel returns
   * as soon as the swap itself is durable.
   */
  switchEmbeddingModel: (slug: string) => Promise<EmbeddingModelInfo>;
}

export interface ExternalProviderApi {
  get: () => Promise<ExternalProviderConfigView>;
  set: (
    provider: ExternalProviderConfigInput,
    apiKey: string | null,
  ) => Promise<ExternalProviderConfigView>;
  test: () => Promise<ExternalProviderTestResult>;
  /** List available models from the configured OpenAI-compatible
   *  provider via `GET /v1/models`. Anthropic providers return
   *  `{ ok: false, kind: "unsupported" }`; network/HTTP errors
   *  return `{ ok: false, kind: "error", error }`.
   *
   *  Accepts optional `overrides` so the renderer can list models
   *  against IN-FLIGHT form state (apiUrl, providerType) without
   *  saving first. The persisted `apiKeyRef` is always used for
   *  the actual HTTP call — plaintext keys never travel over IPC. */
  listModels: (
    overrides?: ExternalProviderListModelsDraftOverrides,
  ) => Promise<ExternalProviderListModelsResult>;
  /** Read the cumulative external-provider token-usage counter.
   *  See `electron/tokenCounter.ts` for the heuristic and rationale. */
  getTokenUsage: () => Promise<ExternalProviderTokenUsage>;
  /** Reset the cumulative external-provider token-usage counter to
   *  zero (with `lastResetDate` updated to now). */
  resetTokenUsage: () => Promise<ExternalProviderTokenUsage>;
}

export interface ModelApi {
  status: () => Promise<ModelStatus>;
  start: (modelPath: string) => Promise<void>;
  stop: () => Promise<void>;
  generate: (
    request: GenerateRequest,
  ) => Promise<void | GenerateBatteryGated>;
  cancelJob: () => Promise<void>;
  onToken: (callback: (chunk: GenerateChunk) => void) => () => void;
}

export interface RuntimeApi {
  detectPlatform: () => Promise<PlatformInfo>;
  /**
   * Recommend a model for the given capability slot. When omitted,
   * the text slot is used so existing single-slot callers keep
   * working without changes.
   */
  recommendModel: (
    capability?: ModelCapability,
  ) => Promise<ResolvedModel | null>;
  /**
   * List candidate models for the current platform. When `capability`
   * is omitted, returns every slot's candidates merged together; pass
   * `"text"` / `"vision"` / `"imagegen"` to filter.
   */
  listModels: (capability?: ModelCapability) => Promise<ResolvedModel[]>;
  /**
   * Return the model currently installed in `capability`'s slot, or
   * `null` if nothing is installed there. Defaults to the text slot
   * for backwards compatibility with the single-slot UI.
   */
  getCurrentModel: (
    capability?: ModelCapability,
  ) => Promise<InstalledModelRecord | null>;
  /**
   * Snapshot of every per-capability slot's installed record. Used by
   * the multi-capability Settings UI to render disk usage and
   * install state across all slots in a single round-trip.
   */
  getInstalledModels: () => Promise<InstalledModelsByCapability>;
  /**
   * Return true iff the given capability is available on the current
   * device (tier + GPU gating + always-on rules). Mirrors the Rust
   * `is_capability_available` helper.
   */
  isCapabilityAvailable: (capability: ModelCapability) => Promise<boolean>;
  planDownload: (modelId: string) => Promise<DownloadPlan>;
  /**
   * Handles both fresh-install and swap (delete-then-fetch) within
   * the requested model's capability slot. There is intentionally no
   * separate `swapModel` channel; the slot is derived from the
   * model's manifest entry.
   */
  downloadModel: (modelId: string) => Promise<InstalledModelRecord>;
  /**
   * Resolve the recommended model for `capability` on this machine and
   * ensure it is installed, downloading it if needed. Unlike
   * `downloadModel` the renderer does not need to know the model id in
   * advance — used by the ModelDownloadBanner's "Retry" affordance.
   * Resolves `null` when the manifest has no candidate for this
   * platform/tier. Defaults to the text slot when omitted.
   */
  downloadRecommended: (
    capability?: ModelCapability,
  ) => Promise<InstalledModelRecord | null>;
  /**
   * Cancel any in-flight download in `capability`'s slot. Backs the
   * ModelDownloadBanner's "Skip — work without AI" affordance: aborts
   * the running transfer (first-launch auto-download or a "Retry"),
   * tearing down the connection and cleaning up the `.partial` so no
   * network/disk is consumed after opt-out — a true cancellation, not
   * just a banner dismissal. Idempotent: resolves `false` when nothing
   * was downloading. Defaults to the text slot when omitted.
   */
  cancelDownload: (capability?: ModelCapability) => Promise<boolean>;
  /**
   * Delete the model currently installed in `capability`'s slot.
   * Defaults to the text slot when omitted so legacy single-slot
   * callers keep working unchanged.
   */
  deleteModel: (capability?: ModelCapability) => Promise<void>;
  onDownloadProgress: (
    callback: (p: ModelDownloadProgress) => void,
  ) => () => void;
  /**
   * Subscribe to terminal failures of the main-process first-launch
   * auto-download. See {@link ModelDownloadError}.
   */
  onDownloadError: (callback: (e: ModelDownloadError) => void) => () => void;
}

/**
 * Vision-language model API exposed on `window.tessera.vision`.
 * Backed by the `llama-server --mmproj` sidecar on port 8385.
 *
 * The renderer treats this as best-effort: callers should always
 * await `isAvailable()` (or `runtime.isCapabilityAvailable("vision")`)
 * before showing vision-driven UI, since `describe()` rejects on
 * hosts that haven't downloaded a VLM yet.
 */
export interface VisionApi {
  /**
   * True iff the native bridge is loaded AND a vision-slot model is
   * installed on disk AND it has the multimodal projector stored
   * alongside it. Cheap — does not touch the sidecar.
   */
  isAvailable: () => Promise<boolean>;
  /**
   * Describe / OCR / chart-extract the image at the given path. The
   * sidecar warms up on the first call (~3 s on top of the actual
   * 5-15 s VLM forward pass) and stays warm for 60 s between calls.
   * Rejects with a structured error message if (a) no vision model
   * is installed, (b) the file is unreadable, or (c) the sidecar
   * is offline.
   */
  describe: (req: {
    imagePath: string;
    mode: "describe" | "ocr" | "chart";
    maxTokens?: number;
  }) => Promise<{
    content: string;
    stop: boolean;
    tokensPredicted: number;
    tokensEvaluated: number;
  }>;
}

/**
 * Image-generation API exposed on `window.tessera.imagegen`. Backed
 * by the `sd-server` diffusion sidecar on port 8386. ALWAYS gate the
 * surface with `isAvailable()` — image generation is GPU-only and a
 * large fraction of users won't have a GPU.
 */
export interface ImagegenApi {
  /**
   * True iff (a) the native bridge is loaded, (b) the host's tier +
   * compute backends satisfy `isCapabilityAvailable("imagegen")`,
   * and (c) an imagegen model is installed on disk.
   */
  isAvailable: () => Promise<boolean>;
  /**
   * Generate one image and persist it to
   * `<userData>/generated-images/<artifactId>/<timestamp>-<seed>.png`.
   * Returns the absolute path plus the seed the sampler actually
   * used (so the caller can persist it for reproducibility) plus
   * timing and size metadata so the preview renders without a
   * follow-up `stat()`.
   *
   * Single in-flight call: a second `generate()` while a first is
   * still running rejects with "already in flight". Callers must
   * either wait or call `cancel()` first.
   */
  generate: (req: {
    prompt: string;
    width: number;
    height: number;
    steps?: number;
    cfgScale?: number;
    seed?: number;
    negativePrompt?: string;
    artifactId: string;
    sectionIndex?: number;
  }) => Promise<{
    path: string;
    /**
     * `tessera-asset://` URL the renderer can drop directly into
     * `<img src>`. Always present when the IPC returns successfully
     * (the main-process handler refuses to ship a result whose
     * `path` is outside `<userData>/generated-images/`, so this
     * field is never empty in practice). The renderer never
     * computes this itself — it has no `<userData>` reference.
     */
    assetUrl: string;
    seed: number;
    width: number;
    height: number;
    durationMs: number;
    sizeBytes: number;
  }>;
  /**
   * Schedule cancellation of the in-flight generation. Returns
   * `{ scheduled: true }` if a generation was actually pending —
   * note that sd-server can't be safely interrupted mid-sample, so
   * the bridge call will still run to completion; only the result
   * persistence is skipped.
   */
  cancel: () => Promise<{ scheduled: boolean }>;
}

export interface ConnectorApi {
  authenticate: (
    provider: string,
    clientId: string,
    clientSecret: string,
    /**
     * Per-target / non-OAuth2 connector config collected at connect
     * time, keyed by the `auth_config_json` field name the upstream
     * connector reads (see `shared/connectorConfig.ts`). For token-method
     * providers (GitLab, Trello) this carries the credential itself;
     * `clientId`/`clientSecret` are ignored for those. Omitted for
     * whole-account OAuth2 providers that need no extra inputs.
     */
    config?: Record<string, string>,
  ) => Promise<ConnectorStatusInfo>;
  /**
   * Run a read-only connection probe BEFORE connecting. Acquires a
   * token the same way `authenticate` does (OAuth browser flow, or the
   * pasted credential for token-method providers) but does a minimal
   * authenticated read and discards the token — nothing is written to
   * the keychain. Lets the modal confirm the entered
   * credentials/target actually work and surface a precise, non-secret
   * reason when they don't, instead of leaving the user to discover a
   * misconfiguration on the first sync.
   */
  test: (
    provider: string,
    clientId: string,
    clientSecret: string,
    config?: Record<string, string>,
  ) => Promise<ConnectorProbeResult>;
  disconnect: (provider: string) => Promise<ConnectorStatusInfo>;
  status: (provider: string) => Promise<ConnectorStatusInfo>;
  listDriveFiles: (
    folderId?: string,
    pageToken?: string,
  ) => Promise<DriveFileListResult>;
  selectItems: (items: DrivePickerItem[]) => Promise<DrivePickerSelection[]>;
  syncDrive: (selectedFileIds?: string[]) => Promise<DriveSyncResult>;
  /**
   * Provider-agnostic sync entrypoint. Used for OneDrive / Notion /
   * Jira / Confluence / Figma — Google Drive still uses `syncDrive`
   * because it accepts an explicit file selection from the picker.
   * Returns the same `{ added, modified, removed, status }` shape.
   * `status === "offline"` indicates the sync failed with a network
   * error and the UI should show the offline badge.
   */
  sync: (provider: string) => Promise<DriveSyncResult>;
  /**
   * Resolve the loopback redirect URI the user must register in the
   * provider's developer console. Source of truth is the OAuth config
   * in `electron/ipc/connectors/providerOAuth.ts` — the renderer
   * fetches it via IPC instead of hard-coding so the displayed URI
   * cannot drift from the one the authorize request actually sends.
   */
  getRedirectUri: (provider: string) => Promise<string>;
  /**
   * Bulk-fetch the canonical redirect URI for every known provider
   * in a single IPC round-trip. Used by `ConnectorsList` at mount
   * time so the modal renders the authoritative value without
   * carrying any per-provider hardcoded fallback.
   */
  getAllRedirectUris: () => Promise<Record<string, string>>;
  /**
   * read-only inspection of the
   * requested-vs-granted OAuth scope diff for the given provider.
   *
   * Returns `null` when the user is not connected (no stored
   * token). Returns a `ConnectorScopeComparison` describing
   * requested, granted, and missing scopes when the user IS
   * connected. The renderer uses this to render a "scopes
   * narrowed" banner with a Reconnect CTA when `fullyGranted` is
   * false.
   *
   * Cheap and side-effect-free: never touches the network, never
   * triggers a refresh, never mutates anything. Safe to call on
   * every connector card mount and on every settings page load.
   */
  inspectScopes: (
    provider: string,
  ) => Promise<ConnectorScopeComparison | null>;
}

/**
 * structured diff between the OAuth
 * scopes Tessera requested for a connector and what the provider
 * actually granted. See `electron/oauthScope.ts` for the
 * authoritative implementation; this interface mirrors the shape
 * sent over IPC.
 */
export interface ConnectorScopeComparison {
  provider: string;
  requested: string[];
  granted: string[];
  /** Subset of `requested` that is NOT in `granted`. */
  missing: string[];
  /** `true` iff every requested scope is in granted (no narrowing). */
  fullyGranted: boolean;
}

export interface TaskApi {
  create: (req: CreateTaskRequest) => Promise<TaskInfo>;
  list: () => Promise<TaskInfo[]>;
  get: (id: string) => Promise<TaskInfo | null>;
  update: (id: string, req: UpdateTaskRequest) => Promise<TaskInfo>;
  remove: (id: string) => Promise<boolean>;
  reorder: (status: string, ids: string[]) => Promise<void>;
}

/**
 * A single memory object from the knowledge substrate, surfaced to the
 * renderer by the `bridge_get_memories` / `bridge_pin_memory` /
 * `bridge_unpin_memory` N-API functions (camelCased on the JS side).
 * Mirrors `tessera_substrate::MemoryRecord` field-for-field.
 */
export interface SubstrateMemoryInfo {
  /** Memory object id (UUID). */
  id: string;
  /** Scope id (UUID) the memory belongs to. */
  scopeId: string;
  /**
   * Observation kind: `entity`, `fact`, `task`, `decision`, `claim`,
   * or `question`.
   */
  observationType: string;
  /** Canonical surface text of the observation. */
  content: string;
  /**
   * Decay state: `candidate`, `reinforced`, `consolidated`,
   * `canonical`, `superseded`, `archived`, or `deleted`.
   */
  state: string;
  /** Last computed retention score in `0.0 ..= 1.0`. */
  retentionScore: number;
  /** Number of pins (strongest retention signal). */
  pinCount: number;
  /** Number of times retrieved as part of an answered query. */
  retrievalCount: number;
  /** Number of independent corroborating sources. */
  corroborationCount: number;
  /** Unix epoch seconds of creation. */
  createdAt: number;
  /** Unix epoch seconds of last access. */
  lastAccessedAt: number;
  /** Originating Tessera source id (UUID), when known. */
  sourceId: string | null;
}

/**
 * Outcome of a substrate decay sweep (`bridge_run_decay_sweep`).
 * Mirrors `tessera_substrate::DecaySweepSummary`.
 */
export interface SubstrateDecayReportInfo {
  /** Number of objects whose retention score was recomputed. */
  scored: number;
  /** Number of `Candidate -> Archived` transitions. */
  candidatesArchived: number;
  /** Number of `Superseded -> Archived` transitions. */
  supersededArchived: number;
}

/**
 * Result of a substrate synthesis run (`bridge_trigger_synthesis`).
 * Mirrors `tessera_substrate::SynthesisSummary`.
 */
export interface SubstrateSynthesisInfo {
  /** Synthesis window id (UUID). */
  windowId: string;
  /** Scope id (UUID) the synthesis covers. */
  scopeId: string;
  /** Version stamp of the persisted synthesis object. */
  version: number;
  /** Free-text recap headline. */
  recap: string;
  /** Decisions captured during the window. */
  decisions: string[];
  /** Open questions captured during the window. */
  openQuestions: string[];
  /** Active tasks captured during the window. */
  activeTasks: string[];
}

/**
 * Renderer surface for the additive knowledge substrate. Wired to the
 * `substrate:*` IPC channels registered in `electron/ipc/substrate.ts`.
 * Sessions 3 (UI) and 6 (search) build on this contract.
 */
export interface SubstrateApi {
  /**
   * Run the observation pipeline over a source's indexed chunks and
   * persist the extracted observations/memories/concepts. Idempotent
   * per `sourceId`. Resolves with the number of observations extracted.
   */
  extractObservations: (sourceId: string) => Promise<number>;
  /** List memory objects for a scope (default scope when omitted). */
  getMemories: (scope?: string | null) => Promise<SubstrateMemoryInfo[]>;
  /** Pin a memory (strongest retention signal). */
  pinMemory: (id: string) => Promise<SubstrateMemoryInfo>;
  /** Decrement a memory's pin count (saturating at zero). */
  unpinMemory: (id: string) => Promise<SubstrateMemoryInfo>;
  /** Forget (delete) a single memory by id. */
  forgetMemory: (id: string) => Promise<void>;
  /**
   * JSON-serialized concept-graph view (`concept_graph::GraphView`)
   * for a scope, bounded by `maxNodes`.
   */
  getConceptGraph: (
    scope?: string | null,
    maxNodes?: number | null,
  ) => Promise<string>;
  /**
   * Suggest sources related to an already-selected working set via the
   * concept graph. Powers the artifact-creation "You have N sources
   * about [entity]. Include them?" affordance. Suggestions never
   * include an already-selected source; `maxSuggestions` defaults to 10
   * when omitted.
   */
  suggestRelatedSources: (
    selectedSourceIds: string[],
    maxSuggestions?: number | null,
  ) => Promise<SubstrateRelatedSuggestionInfo[]>;
  /** Recompute retention and apply decay transitions. */
  runDecaySweep: () => Promise<SubstrateDecayReportInfo>;
  /** Produce and persist a deterministic synthesis for a scope. */
  triggerSynthesis: (
    scope?: string | null,
  ) => Promise<SubstrateSynthesisInfo>;
}

export interface AutomationApi {
  create: (req: CreateAutomationRequest) => Promise<AutomationInfo>;
  list: () => Promise<AutomationInfo[]>;
  get: (id: string) => Promise<AutomationInfo | null>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  remove: (id: string) => Promise<boolean>;
  schedulerStatus: () => Promise<SchedulerStatusInfo>;
  runNow: () => Promise<SchedulerStatusInfo>;
}

export interface DialogApi {
  showSaveDialog: (options: SaveDialogOptions) => Promise<SaveDialogResult>;
  /**
   * Open a native image-file picker locked to the supported
   * extensions (jpg/jpeg/png/webp/gif/bmp). Returns
   * `{ canceled: true, filePath: null }` if the user dismissed the
   * dialog, otherwise `{ canceled: false, filePath: <absolute path> }`.
   */
  pickImage: (options?: OpenImageDialogOptions) => Promise<OpenImageDialogResult>;
  /**
   * Open a native folder picker (Settings → Backup "choose folder").
   * Returns `{ canceled: true, filePath: null }` if dismissed, else
   * `{ canceled: false, filePath: <absolute directory> }`.
   */
  openDirectory: (
    options?: OpenDirectoryDialogOptions,
  ) => Promise<OpenImageDialogResult>;
  /**
   * Open a native file picker locked to `.tessera-backup` archives
   * (Settings → Backup "Import workspace bundle"). Same result shape as
   * {@link pickImage}: `{ canceled: true, filePath: null }` if
   * dismissed, else `{ canceled: false, filePath: <absolute path> }`.
   */
  openBundle: (
    options?: OpenBundleDialogOptions,
  ) => Promise<OpenImageDialogResult>;
}

/** Options for `dialog:openDirectory`. Only the title is exposed. */
export interface OpenDirectoryDialogOptions {
  title?: string;
}

/** Options for `dialog:openBundle`. Only the title is exposed. */
export interface OpenBundleDialogOptions {
  title?: string;
}

/**
 * Renderer-facing API for the local backup & recovery system
 * (`backup:*` channels). Restores never mutate the live database — they
 * stage a file that is swapped in at the next launch — so the
 * restore/import calls resolve with `requiresRestart: true` and the UI
 * prompts for a relaunch.
 */
export interface BackupApi {
  /** Run a hot backup now; resolves with the new file's metadata. */
  create: () => Promise<BackupInfo>;
  /** List existing backups, newest first. */
  list: () => Promise<BackupInfo[]>;
  /** Effective config + scheduler health in one round-trip. */
  status: () => Promise<BackupStatus>;
  /** Stage a single backup file for restore at next launch. */
  restore: (backupPath: string) => Promise<BackupRestoreResult>;
  /** Patch the backup-scheduler config; resolves with the new status. */
  configure: (patch: BackupConfigureInput) => Promise<BackupStatus>;
  /** Export a full `.tessera-backup` workspace archive to `outPath`. */
  exportBundle: (outPath: string) => Promise<BundleInfo>;
  /** Verify + stage a `.tessera-backup` archive for restore at launch. */
  importBundle: (bundlePath: string) => Promise<BundleImportReport>;
}

/**
 * Renderer-side mirror of the `backup:configure` payload. Every field
 * optional so the UI can PATCH a single control. Kept in `shared/` so
 * the preload and renderer agree on the shape without importing from
 * `electron/`.
 */
export interface BackupConfigureInput {
  autoBackup?: boolean;
  backupDir?: string;
  backupIntervalHours?: number;
  backupRetentionCount?: number;
}

/**
 * One slide as shipped to the presentation windows by
 * `slides:startPresentation`. The renderer flattens each slide to a
 * title, a list of plain-text body `lines`, and the speaker `notes`.
 *
 * Everything is plain text by design: the main process renders it with
 * `textContent` (never `innerHTML`), so a slide body can never inject
 * markup into the presentation window regardless of what the user
 * typed into the deck.
 */
export interface PresentationSlide {
  title: string;
  /** Plain-text body lines (bullets / paragraphs / block labels). */
  lines: string[];
  /** Plain-text speaker notes, shown only in the presenter window. */
  notes: string;
}

/** Payload for `slides:startPresentation`. */
export interface StartPresentationRequest {
  slides: PresentationSlide[];
  /** Zero-based slide to open on. Clamped to range by the main process. */
  startIndex: number;
  /** Optional deck title used in the window chrome. */
  deckTitle?: string;
}

/** Result of `slides:startPresentation`. */
export interface StartPresentationResult {
  ok: boolean;
  /** Number of slides the presentation was opened with. */
  slideCount: number;
}

/**
 * Slides presenter-mode surface. The Slides editor calls
 * `startPresentation` to open a fullscreen audience window plus a
 * second presenter window (speaker notes + next-slide preview). The
 * two windows share a dedicated session partition and stay in sync via
 * `localStorage` `storage` events, so no further IPC round-trips are
 * needed once they are open.
 */
export interface SlidesApi {
  startPresentation: (
    request: StartPresentationRequest,
  ) => Promise<StartPresentationResult>;
}

/**
 * Auto-update integration surface. The renderer never talks to
 * `electron-updater` directly — every interaction goes through these
 * IPC channels so the main process can validate state, run the
 * updater out of the sandboxed renderer, and apply a single
 * configuration source of truth (Settings -> Auto-update toggle).
 */
export interface UpdatesApi {
  /** Last known update status. Useful for the Settings card. */
  status: () => Promise<UpdateStatusInfo>;
  /** Force-check the release feed now. */
  check: () => Promise<UpdateStatusInfo>;
  /** Install a downloaded update (quits + relaunches). */
  install: () => Promise<{ ok: boolean; message?: string }>;
  getAutoUpdateEnabled: () => Promise<boolean>;
  setAutoUpdateEnabled: (enabled: boolean) => Promise<boolean>;
  /** Subscribe to streaming update events. Returns an unsubscribe. */
  onStatus: (cb: (s: UpdateStatusInfo) => void) => () => void;
}

/**
 * Window-lifecycle signals from the main process (LW-4). Lets the
 * renderer pause work that is wasted while the window is hidden
 * (minimized / minimized-to-tray / `app.hide()` on macOS) — chiefly the
 * recurring status-poll intervals — and resume it on show. Both
 * subscriptions return an unsubscribe to call in React cleanup.
 */
export interface AppLifecycleApi {
  /** Fires when the window becomes hidden. Returns an unsubscribe. */
  onSuspend: (cb: () => void) => () => void;
  /** Fires when the window becomes visible again. Returns an unsubscribe. */
  onResume: (cb: () => void) => () => void;
}

/**
 * Renderer-facing API namespace exposed on `window.tessera`. The
 * preload script's `contextBridge.exposeInMainWorld("tessera", api)`
 * call must satisfy this shape.
 */
/**
 * LW-8 (cold-start budget): the boot-time readiness state of the native
 * bridge, surfaced to the renderer so it can paint a "Loading
 * workspace…" skeleton while `initAppState()` runs off the cold-start
 * critical path and hydrate the real app shell only once the bridge is
 * up.
 *
 *   - `"initializing"` — the main process is still opening the store
 *     (SQLCipher open + tombstone replay + FTS purge). The renderer
 *     shows the skeleton and issues no bridge-backed IPC yet.
 *   - `"ready"`        — the bridge is up; the renderer mounts the app.
 *   - `"error"`        — bridge init threw; `error` carries the reason.
 */
export interface BridgeStateView {
  state: "initializing" | "ready" | "error";
  /** Failure reason; non-null only when `state === "error"`. */
  error: string | null;
}

/**
 * App-lifecycle IPC surface. Today it only carries the bridge-readiness
 * signal (LW-8); it is deliberately a distinct namespace from the
 * domain APIs because it is the one surface that must be callable
 * *before* the bridge — and therefore every domain API — is ready.
 */
export interface LifecycleApi {
  /**
   * Read the current bridge state. Called by the renderer on mount so a
   * subscription that races the `"ready"` transition (subscribing just
   * after it fired) still learns the bridge is up instead of waiting
   * forever on an event already delivered to no listener.
   */
  getBridgeState: () => Promise<BridgeStateView>;
  /**
   * Subscribe to bridge-state transitions. Returns a disposer that
   * removes the listener. The callback fires on every
   * `initializing → ready` / `initializing → error` transition.
   */
  onBridgeState: (cb: (state: BridgeStateView) => void) => () => void;
}

export interface TesseraApi {
  sources: SourceApi;
  artifacts: ArtifactApi;
  templates: TemplateApi;
  citations: CitationApi;
  settings: SettingsApi;
  externalProvider: ExternalProviderApi;
  model: ModelApi;
  runtime: RuntimeApi;
  vision: VisionApi;
  imagegen: ImagegenApi;
  connectors: ConnectorApi;
  tasks: TaskApi;
  /** Additive knowledge-substrate surface (memories, concepts, decay). */
  substrate: SubstrateApi;
  automations: AutomationApi;
  dialog: DialogApi;
  /** Local backup & recovery surface (`backup:*`). */
  backup: BackupApi;
  slides: SlidesApi;
  updates: UpdatesApi;
  kchat: KchatApi;
  audit: AuditApi;
  /** Local-only telemetry inspection. */
  telemetry: TelemetryApi;
  /** PIN / biometric app lock surface. */
  appLock: AppLockApi;
  /** Crash / error-boundary reporting surface. */
  diagnostics: DiagnosticsApi;
  /** Main-process window-visibility signals (suspend/resume). */
  appLifecycle: AppLifecycleApi;
  /** LW-12 read-only resource-usage snapshot for Settings → Performance. */
  resources: ResourcesApi;
  /** App-lifecycle surface (LW-8 bridge readiness). */
  lifecycle: LifecycleApi;
}

/**
 * Crash-report payload a renderer error boundary forwards to the main
 * process when a descendant component throws during render. The main
 * process persists it as `crash-report.json` in the log directory (see
 * `electron/crashReport.ts`).
 */
export interface RendererCrashReport {
  /** Name of the boundary / component subtree that crashed. */
  component: string;
  /** `error.message` from the thrown error. */
  error: string;
  /**
   * `error.stack` if present, else the React component stack. Captured
   * as a single string so the on-disk report is self-contained.
   */
  stack: string;
  /** ISO-8601 timestamp of when the boundary caught the error. */
  timestamp: string;
}

/**
 * Diagnostics IPC surface. Currently just crash reporting from renderer
 * error boundaries; the main process owns the disk-backed log directory
 * so the renderer cannot write files directly (it is the untrusted web
 * context).
 */
export interface DiagnosticsApi {
  /**
   * Persist a renderer crash report to `crash-report.json` in the log
   * directory and mirror it to the structured logger. Best-effort: the
   * promise resolves even if the write fails so the error-boundary UI
   * never blocks on disk IO.
   */
  reportCrash: (report: RendererCrashReport) => Promise<void>;
}

/**
 * LW-12: a single read-only snapshot of everything the resource-usage
 * dashboard (Settings → Performance) shows. Aggregated in the main
 * process from the live subsystems the LW work introduced — the model
 * sidecars (LW-1), the resource mode (LW-2), the battery monitor
 * (LW-3), and the indexing RSS watchdog (LW-7) — so the renderer never
 * reaches into main-process state directly.
 *
 * Every field is a plain JSON-cloneable value: the snapshot crosses the
 * IPC boundary by structured clone, so it carries no live handles.
 */
export interface ResourceUsage {
  /** Active resource profile (drives the gates above). */
  resourceMode: ResourceMode;
  memory: ResourceUsageMemory;
  slm: ResourceUsageSlm;
  connections: ResourceUsageConnections;
  indexing: ResourceUsageIndexing;
  battery: ResourceUsageBattery;
}

/**
 * Main-process memory footprint from `process.memoryUsage()`. RSS is
 * the headline number the dashboard shows: it covers the Electron main
 * process **including** the in-process Rust substrate (the N-API addon
 * runs in this process, not a child), which is the bulk of the idle
 * footprint once the renderer is excluded. The model sidecars are
 * separate child processes and are reported under {@link slm} instead.
 */
export interface ResourceUsageMemory {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
}

/** Per-capability local-model (sidecar) load state. */
export interface ResourceUsageSlm {
  /** Local text-generation sidecar (llama-server). */
  text: ResourceUsageSidecar;
  /** Local vision sidecar. */
  vision: ResourceUsageSidecar;
  /**
   * Image-generation (diffusion) sidecar lifecycle. Distinct shape
   * because it has an explicit load state machine
   * (`unloaded → loading → loaded`/`failed`) rather than the simple
   * running/stopped of the llama-server sidecars.
   */
  imagegen: { state: "unloaded" | "loading" | "loaded" | "failed" };
}

export interface ResourceUsageSidecar {
  running: boolean;
  /** Loopback endpoint when running, else `null`. */
  endpoint: string | null;
}

/**
 * Open SQLCipher connections. The store uses a single serialized
 * writer (the `SharedConnection` mutex) plus a bounded read pool sized
 * by `tessera_core::db::default_read_pool_size()`
 * (`min(available_parallelism, MAX_READ_POOL_SIZE)`). The bridge does
 * not currently export the live pool size, so the main process mirrors
 * that formula; see `electron/ipc/resources.ts` for the single
 * cross-FFI coupling point.
 */
export interface ResourceUsageConnections {
  /** Always 1 — the serialized writer connection. */
  writers: number;
  /** Read-pool size (bounded readers). */
  readers: number;
}

/** RSS-watchdog view of bulk-indexing admission (LW-7). */
export interface ResourceUsageIndexing {
  /** Bulk-indexing admission currently deferred by memory pressure. */
  deferredForMemory: boolean;
  /**
   * Latest watchdog sample, or `null` before the first poll / when the
   * watchdog is not running (e.g. some test envs).
   */
  pressure: {
    paused: boolean;
    rssBytes: number;
    highWaterMarkBytes: number;
    lowWaterMarkBytes: number;
  } | null;
}

/** Power-state view used to explain battery-driven gating (LW-3). */
export interface ResourceUsageBattery {
  hasBattery: boolean;
  isOnBattery: boolean;
  isCharging: boolean;
  /** Charge level 0–100, or `null` when unknown. */
  percent: number | null;
  /**
   * Whether low-battery synthesis gating is currently active (a present
   * battery, discharging, at/below the low-battery threshold).
   */
  gating: boolean;
}

/**
 * LW-12 resource-usage inspection surface. Read-only; the dashboard
 * polls {@link ResourcesApi.getUsage} on a short interval while the
 * Performance settings card is mounted.
 */
export interface ResourcesApi {
  getUsage: () => Promise<ResourceUsage>;
}

/**
 * telemetry inspection + single-key
 * write surface. See `electron/telemetrySink.ts` for the privacy
 * contract.
 */
export interface TelemetryApi {
  /** Persisted-on-disk + in-memory snapshot, time-ordered. */
  getEvents: () => Promise<TelemetryEventView[]>;
  /** Persisted-on-disk slice only. */
  getPersistedEvents: () => Promise<TelemetryEventView[]>;
  /**
   * Record a counter event. Key MUST be in the whitelist
   * defined by `TELEMETRY_KEYS` in `electron/telemetrySink.ts`;
   * non-whitelisted keys are silently dropped.
   */
  recordCounter: (key: string, increment?: number) => Promise<void>;
}

/**
 * Wire shape of a single telemetry event. Mirrors the
 * `TelemetryEvent` union in `electron/telemetrySink.ts` but uses
 * the renderer-safe `TelemetryEventView` name so the renderer
 * does not have to import from the main-process module.
 */
export type TelemetryEventView =
  | { t: number; k: "counter"; key: string; value: number }
  | { t: number; k: "timing"; key: string; value: number };

/**
 * PIN / biometric app lock IPC surface.
 * The renderer's `LockOverlay` component drives this; see
 * `electron/appLock.ts` for the cryptography.
 */
export interface AppLockApi {
  getStatus: () => Promise<AppLockStatus>;
  setPin: (pin: string) => Promise<void>;
  changePin: (oldPin: string, newPin: string) => Promise<void>;
  removePin: (pin: string) => Promise<void>;
  attemptUnlock: (pin: string) => Promise<AppLockUnlockResult>;
  attemptBiometric: (
    reason?: string,
  ) => Promise<{ success: boolean }>;
  /**
   * Options the renderer hands to `navigator.credentials.create()`
   * to register a new FIDO2 authenticator. The challenge is
   * single-use and expires; the renderer must call
   * `registerFido2` with the resulting credential before it lapses.
   */
  getFido2RegistrationOptions: () => Promise<Fido2RegistrationOptions>;
  /**
   * Persist a freshly-created FIDO2 credential. The renderer
   * extracts the SPKI public key and COSE algorithm from the
   * `PublicKeyCredential` (via `response.getPublicKey()` /
   * `response.getPublicKeyAlgorithm()`) so the main process never
   * has to CBOR-decode the attestation object.
   */
  registerFido2: (
    input: Fido2RegistrationInput,
  ) => Promise<{ success: boolean }>;
  /**
   * Options the renderer hands to `navigator.credentials.get()` to
   * produce an assertion that unlocks the app. Returns `null` when
   * no credential is registered (the renderer should fall back to
   * PIN).
   */
  getFido2AssertionOptions: () => Promise<Fido2AssertionOptions | null>;
  /** Verify a FIDO2 assertion and, on success, unlock the app. */
  verifyFido2: (input: Fido2AssertionInput) => Promise<AppLockUnlockResult>;
  /** Remove the registered FIDO2 credential (requires the PIN). */
  removeFido2: (pin: string) => Promise<void>;
}

/**
 * Status snapshot returned by `appLock:getStatus`. The renderer
 * uses `hasPinSet` to decide whether the Settings UI should show
 * "Set up a PIN" or "Change PIN", `hasFido2Set` to decide whether
 * to offer "Register a security key" vs "Remove security key", and
 * `mode` to decide whether to render the lock overlay at all.
 */
export interface AppLockStatus {
  hasPinSet: boolean;
  hasFido2Set: boolean;
  mode: AppLockMode;
}

/**
 * COSE algorithm identifiers Tessera accepts for FIDO2 unlock.
 * `-7` = ES256 (ECDSA P-256 + SHA-256, the platform-authenticator
 * default), `-257` = RS256 (RSA PKCS#1 v1.5 + SHA-256), `-8` =
 * EdDSA (Ed25519). These are the three the main process knows how
 * to verify in `appLock.ts`.
 */
export const FIDO2_SUPPORTED_ALGS = [-7, -257, -8] as const;

/**
 * Registration options surfaced to the renderer. Mirrors the
 * subset of `PublicKeyCredentialCreationOptions` the renderer
 * needs; binary fields are base64url so they cross the IPC
 * boundary as JSON.
 */
export interface Fido2RegistrationOptions {
  /** base64url, single-use, server-issued. */
  challenge: string;
  rpId: string;
  rpName: string;
  /** base64url stable per-install user handle. */
  userId: string;
  userName: string;
  userDisplayName: string;
  /** COSE alg ids, most-preferred first. */
  pubKeyCredParams: readonly number[];
  timeoutMs: number;
}

/** Payload the renderer posts back after `credentials.create()`. */
export interface Fido2RegistrationInput {
  /** base64url credential ID from the authenticator. */
  credentialId: string;
  /** base64 DER SPKI public key (`response.getPublicKey()`). */
  publicKeySpki: string;
  /** COSE alg (`response.getPublicKeyAlgorithm()`). */
  alg: number;
  /** base64 of the raw `response.clientDataJSON`. */
  clientDataJson: string;
}

/** Assertion options surfaced to the renderer for unlock. */
export interface Fido2AssertionOptions {
  /** base64url, single-use, server-issued. */
  challenge: string;
  rpId: string;
  /** base64url credential IDs the renderer may use. */
  allowCredentialIds: readonly string[];
  timeoutMs: number;
}

/** Payload the renderer posts back after `credentials.get()`. */
export interface Fido2AssertionInput {
  /** base64url credential ID used for the assertion. */
  credentialId: string;
  /** base64 of `response.authenticatorData`. */
  authenticatorData: string;
  /** base64 of `response.clientDataJSON`. */
  clientDataJson: string;
  /** base64 of `response.signature`. */
  signature: string;
}

/**
 * Discriminated union mirroring `UnlockResult` from
 * `electron/appLock.ts`. The renderer pattern-matches on `kind`
 * to render the correct overlay state.
 */
export type AppLockUnlockResult =
  | { kind: "success" }
  | { kind: "failure"; failures: number }
  | { kind: "locked_out"; nextAttemptAt: number }
  | { kind: "no_pin_set" };

// --- KChat -----------------------------------------------------
//
// The KChat REST + WebSocket integration. Everything here is renderer-safe:
// the personal access token never crosses the IPC boundary.

/** Sanitised view of a KChat user surfaced to the renderer. */
export interface KchatUserView {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
}

/** Sanitised KChat team. */
export interface KchatTeamView {
  id: string;
  name: string;
  display_name: string;
  description?: string;
  type: "O" | "I";
}

/** Sanitised KChat channel. */
export interface KchatChannelView {
  id: string;
  team_id: string;
  name: string;
  display_name: string;
  type: "O" | "P" | "D" | "G";
  purpose?: string;
  header?: string;
}

/** Sanitised KChat channel member. */
export interface KchatChannelMemberView {
  channel_id: string;
  user_id: string;
  roles: string;
}

/** Sanitised KChat file metadata. */
export interface KchatFileView {
  id: string;
  /**
   * Uploader's KChat user id. Surfaced to the renderer so the
   * "channel files" preview can show *who* uploaded each file. The id is validated against the
   * KChat object-id shape at the client/deserialisation boundary
   * inside `KchatClient.listChannelFiles`, so the renderer can
   * trust it as opaque-but-shape-valid.
   */
  user_id: string;
  name: string;
  size: number;
  mime_type: string;
  extension: string;
  create_at: number;
  /**
   * Resolved uploader username. The
   * IPC layer enriches this field via the existing module-level
   * `KCHAT_USERNAME_CACHE` + `getUsersByIds()` path the citation
   * enrichment uses. `null` when the enrichment couldn't resolve
   * the id (transient REST failure, disconnected state, server
   * elided the user from the response). The renderer must
   * tolerate `null` and fall back to the raw `user_id`.
   */
  uploaderUsername: string | null;
}

/**
 * Sanitised view of the authenticated KChat user inside
 * `KchatConnectionStateView`. Uses camelCase to match
 * `KchatUserView` (returned by `kchat:connect`) so the renderer
 * sees one canonical shape everywhere — earlier revisions exposed
 * snake_case here, which forced every consumer to special-case
 * the connection-state branch.
 */
export interface KchatConnectionUserView {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
}

/** Connection state surfaced via `kchat:status`. */
export interface KchatConnectionStateView {
  state: "disconnected" | "connecting" | "connected" | "error";
  user?: KchatConnectionUserView;
  serverUrl?: string;
  error?: string;
  lastHealthyAt?: string;
  /** Auth backend powering this connection. */
  authMode?: "none" | "pat";
}

/**
 * Alias used by the renderer code for the sanitised user shape
 * returned by `kchat:connect`. Kept as a type alias rather than a
 * direct reference at every call site so the intent ("we got a
 * user view back from a connect call") stays explicit.
 */
export type KchatConnectedUserView = KchatConnectionUserView;

/**
 * renderer-facing detection result for the Tessera
 * .kcz extension installed in KChat Desktop. The Settings card
 * uses this to decide whether to show the "KChat Desktop
 * detected" affordance. Detection is purely passive: Tessera's
 * main process notes whether its own localhost API server is
 * bound (and therefore whether the extension installed in KChat
 * Desktop can reach it). It does NOT probe the desktop app over
 * any IPC channel — the two apps are independent KChat clients.
 */
export interface KchatDesktopBridgeStatusView {
  /**
   * True when Tessera's localhost API server is up and the
   * port-file is on disk where the extension would discover it.
   * False during the brief window between app start and server
   * bind, or when the user-data dir is read-only.
   */
  apiServerRunning: boolean;
  /**
   * Loopback port the extension would talk to. Surfaced to the
   * renderer for diagnostics only; the renderer never connects.
   */
  apiServerPort: number | null;
  /** Absolute path of the discovery file the extension reads. */
  portFilePath: string | null;
  /**
   * ISO-8601 timestamp of the most recent successful request from
   * the .kcz extension (a heartbeat the local API server records).
   * `null` until the extension makes its first authenticated call.
   */
  lastExtensionContactAt: string | null;
}

/**
 * renderer-facing projection of an in-flight
 * channel backfill. The `SourceDetailPage` polls
 * `kchat:backfillProgress` for the linked channel id and renders
 * a progress bar derived from `postsIngested` / `totalPosts`. The
 * `status` discriminator tells the renderer whether to show the
 * bar (`active`), a "complete" badge (`complete`), or hide the
 * row entirely (`idle`).
 */
export interface KchatBackfillProgressView {
  channelId: string;
  /**
   * Oldest post create_at timestamp (ms since epoch) the walker
   * has fetched. `null` when no walk has run yet.
   */
  oldestFetched: number | null;
  /**
   * Total post count reported by the channel head — `null` when
   * unknown (KChat doesn't always surface this).
   */
  totalPosts: number | null;
  /** Posts ingested via dedupe-aware ingest on this walk. */
  postsIngested: number;
  /**
   * `idle` → no walk has ever run; `active` → walk in flight;
   * `complete` → walk reached the head of the channel; `error`
   * → last walk attempt failed (UI shows a retry button).
   */
  status: "idle" | "active" | "complete" | "error";
  /** Last-error message when `status === "error"`. */
  error?: string;
}

/**
 * Renderer-facing projection of a KChat WebSocket event surfaced
 * by the main-process forwarder over the `kchat:event` push
 * channel. The shape mirrors the main-process
 * `KchatWebSocketEventView` (see `electron/kchat/kchatTypes.ts`)
 * with the `omit_users` server-routing map dropped and the
 * `broadcast.*` fields flattened so the renderer doesn't need to
 * reach into a nested envelope to find the originating channel
 * id.
 *
 * `event` is left as a free-form `string` rather than a union
 * because the KChat WebSocket protocol is open-ended and the
 * forwarder's filter list is the single source of truth for
 * which subset reaches the renderer. Renderer consumers should
 * narrow with an `if`/`switch` over the event name they care
 * about and treat unrecognised values as no-ops.
 *
 * Block B Task 1 introduces this view; the Block A
 * sidebar polled `kchat:listChannelFiles` every 30 s, which is
 * still kept as a reconciliation fallback for the
 * mid-disconnect window.
 */
export interface KchatWebSocketEventPayload {
  /**
   * Wire-level event name (`posted`, `file_added`,
   * `channel_member_updated`, `channel_created`, …).
   */
  event: string;
  /**
   * Originating channel id when the KChat server tagged the
   * broadcast envelope with one; many event types carry no
   * channel scope and surface as `null`.
   */
  channelId: string | null;
  /** Originating team id when present in the broadcast envelope. */
  teamId: string | null;
  /** Originating user id when present in the broadcast envelope. */
  userId: string | null;
  /**
   * Monotonically-increasing sequence number assigned by the
   * KChat server. The renderer can detect dropped events by
   * watching for non-contiguous jumps; the 30 s reconciliation
   * poll closes any gap by re-querying REST.
   */
  seq: number;
  /**
   * Opaque event-specific payload. Renderer consumers should
   * narrow per-event (e.g. cast to `KchatPostedEvent` shape) and
   * defensively check for missing fields, since the KChat server
   * is treated as untrusted with respect to wire-payload shape.
   */
  data: Record<string, unknown>;
}

/**
 * Renderer-safe KChat user projection for the DocumentEditor
 * `@mention` typeahead (Session 8 Task 2). Only the id, the
 * `@`-handle, and a human display label cross the IPC boundary —
 * never email or roles.
 */
export interface KchatUserSearchResultView {
  id: string;
  username: string;
  displayName: string;
}

/** Coarse KChat presence value surfaced to the renderer (Task 5). */
export type KchatPresenceStatusView = "online" | "away" | "dnd" | "offline";

/** Renderer-safe presence row backing the Sidebar indicator (Task 5). */
export interface KchatUserStatusView {
  userId: string;
  status: KchatPresenceStatusView;
}

/** One pending offline-queue operation, as seen by the renderer (Task 1). */
export interface KchatOfflineQueueOpView {
  id: string;
  // Mirror the main-process `KchatQueuedOpType` discriminator exactly.
  // `kchat:offlineQueueStatus` forwards `op.type` verbatim, so a value
  // omitted here would arrive at the renderer untyped and break any
  // exhaustive match on the discriminator.
  type: "shareArtifact" | "ingestChannel" | "postTask";
  attempts: number;
  enqueuedAt: number;
}

/** Snapshot of the offline write queue surfaced to the renderer (Task 1). */
export interface KchatOfflineQueueStatusView {
  size: number;
  operations: KchatOfflineQueueOpView[];
}

/**
 * Minimal Tessera task shape the renderer posts to KChat via
 * `kchat.postTaskToChannel` (Session 8 Task 6).
 */
export interface KchatPostTaskInput {
  id: string;
  title: string;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
  dueDate?: string | null;
  assignee?: string | null;
}

export interface KchatApi {
  isAvailable: () => Promise<boolean>;
  status: () => Promise<KchatConnectionStateView>;
  connect: (token: string, serverUrl: string) => Promise<KchatUserView>;
  disconnect: () => Promise<{ disconnected: boolean }>;
  listTeams: () => Promise<KchatTeamView[]>;
  listChannels: (teamId: string) => Promise<KchatChannelView[]>;
  listMembers: (channelId: string) => Promise<KchatChannelMemberView[]>;
  listChannelFiles: (
    channelId: string,
    page?: number,
    perPage?: number,
  ) => Promise<KchatFileView[]>;
  shareArtifact: (
    artifactId: string,
    channelId: string,
    format: "markdown" | "html" | "pdf" | "docx" | "json",
    includeCitations: boolean,
    includeEvidencePack: boolean,
    /**
     * Session 8 Task 4: delivery mode. `"attachment"` (default)
     * exports the artifact and uploads it as a file;
     * `"deeplink"` posts a `tessera://` deeplink message instead
     * of exporting bytes.
     */
    delivery?: "attachment" | "deeplink",
  ) => Promise<{
    fileId: string;
    fileName: string;
    /** Set for `deeplink` delivery — the id of the posted message. */
    postId?: string;
    /** True when the server was offline and the op was queued (Task 1). */
    queued?: boolean;
    /** The offline-queue entry id when `queued` is true. */
    queueId?: string;
  }>;
  addChannelSource: (
    channelId: string,
    channelName: string,
  ) => Promise<{
    sourceId: string;
    cacheDir: string;
    /** True when the server was offline and the op was queued (Task 1). */
    queued?: boolean;
    /** The offline-queue entry id when `queued` is true. */
    queueId?: string;
  }>;
  /**
   * Session 8 Task 2: search KChat users for the DocumentEditor
   * `@mention` typeahead. `limit` defaults to 10 (clamped to
   * `[1, 50]`). An empty / whitespace term resolves to `[]`
   * without a server round-trip.
   */
  searchUsers: (
    term: string,
    limit?: number,
  ) => Promise<KchatUserSearchResultView[]>;
  /**
   * Session 8 Task 5: coarse presence for a bounded list of user
   * ids (at most 200), backing the Sidebar presence indicator.
   */
  getUserStatuses: (userIds: string[]) => Promise<KchatUserStatusView[]>;
  /**
   * Session 8 Task 1: read-only snapshot of the offline write
   * queue (pending `shareArtifact` / `ingestChannel` ops). Pure
   * local read — no server round-trip.
   */
  offlineQueueStatus: () => Promise<KchatOfflineQueueStatusView>;
  /**
   * Session 8 Task 3: set which channels raise native OS
   * notifications for new posts. Returns the deduped count actually
   * applied. Task auto-create is a separate opt-in toggled via
   * {@link setAutoCreateTasks}.
   */
  setWatchedChannels: (channelIds: string[]) => Promise<{ count: number }>;
  /**
   * Session 8 Task 6: toggle inbound task auto-create. Opt-in and
   * controlled independently of the watch list, since auto-create
   * writes persistent Tessera tasks (a higher-consequence
   * side-effect than a transient notification). Echoes the applied
   * state.
   */
  setAutoCreateTasks: (enabled: boolean) => Promise<{ enabled: boolean }>;
  /**
   * Session 8 Task 6 (Tessera → KChat): post a Tessera task to a
   * channel as a formatted message. Carries the `— via Tessera`
   * footer so the inbound detector ignores the round-trip.
   */
  postTaskToChannel: (
    channelId: string,
    task: KchatPostTaskInput,
  ) => Promise<{ postId: string; queued?: boolean; queueId?: string }>;
  /**
   * trigger the historical-backfill
   * walk for an already-linked KChat channel. The walk paginates
   * the REST history endpoint backwards from the persisted
   * cursor (or from the newest post on a fresh run) until either
   * the server reports end-of-history (`prevPostId === null`),
   * the substrate reports access revocation, the per-channel
   * 50_000-post safety cap is hit, or a REST/substrate error
   * fires. The substrate persists a completion sentinel so a
   * subsequent retrigger short-circuits with
   * `outcome: "skipped" / reason: "already_completed"`.
   *
   * The returned counters are cumulative over THIS walk only
   * (pages processed, posts ingested via dedupe-aware ingest,
   * posts unchanged via BLAKE3 dedupe, posts skipped because of
   * mid-walk revocation). Per-page progress is also recorded as
   * audit rows by the substrate so operators can reconstruct
   * progression mid-flight.
   */
  backfillChannel: (channelId: string) => Promise<KchatBackfillRunOutcome>;
  /**
   * KChat post-body retrieval. Returns
   * AEAD-verified hits, ranked, with a composed permalink (or
   * `null` when the user is disconnected). The handler enforces
   * a 10/s sustained + 20-burst rate limit (`kchat:searchPosts`)
   * matching `sources.search`, and emits a
   * `KchatPostSearchExecuted` audit row carrying only the
   * 16-hex SHA-256 of the query — never the raw query.
   */
  searchPosts: (query: string, limit: number) => Promise<KchatPostSearchHit[]>;
  /**
   * fetch up to 3 thread-context
   * messages for a search hit whose `rootId` is non-null. Returns
   * a chronologically-ordered transcript (oldest first) of:
   *
   *   - the thread root (`isRoot: true`), AND
   *   - up to 2 most-recent earlier-replies (`isRoot: false`)
   *     occurring strictly before the hit.
   *
   * Returns an empty array when the post id is unknown, the hit
   * is itself a top-level post, the source has been revoked
   * (cryptoshredded DEK), or every available row failed AEAD
   * verification. The renderer should therefore gate the "expand
   * thread" affordance on `hit.rootId != null` AND fallback to
   * just rendering the hit when the array comes back empty.
   *
   * Rate-limited at 5/s sustained + burst 10
   * (`kchat:fetchThreadContext`); a poorly-built renderer cannot
   * pin the substrate by auto-expanding every hit on a results
   * page.
   */
  fetchThreadContext: (
    sourceId: string,
    postId: string,
  ) => Promise<KchatThreadContextMessage[]>;
  /**
   * open a KChat conversation in KChat Desktop
   * via the OS-level `kchat://` URL scheme. The renderer calls
   * this from the per-channel "Open in KChat Desktop" action;
   * Tessera's main process invokes `shell.openExternal()` so the
   * OS shell routes the URL to whichever binary owns the
   * `kchat://` scheme registration (KChat Desktop in the
   * cooperating-apps case, the browser as a graceful fallback).
   */
  openInDesktop: (
    channelId: string,
  ) => Promise<{ opened: boolean; url: string }>;
  /**
   * open the KChat Desktop extension-management
   * settings page (`kchat://app/settings/extensions`) via the OS
   * URL handler. No-arg by design: the deeplink is fixed so the
   * renderer cannot smuggle arbitrary URLs across the IPC
   * boundary.
   */
  openDesktopExtensions: () => Promise<{ opened: boolean; url: string }>;
  /**
   * read Tessera's own snapshot of whether the
   * KChat Desktop side of the integration is currently reachable.
   * The renderer polls this from the Settings card to render the
   * "KChat Desktop detected" indicator. Returns `null` when the
   * underlying detection isn't ready yet (e.g. during the very
   * first paint after app launch).
   */
  desktopBridgeStatus: () => Promise<KchatDesktopBridgeStatusView | null>;
  /**
   * KChat channel backfill progress. Polled by
   * `SourceDetailPage` while a backfill is active; the IPC
   * handler returns the current watermark and a status
   * discriminator the renderer maps to a progress bar.
   */
  backfillProgress: (
    channelId: string,
  ) => Promise<KchatBackfillProgressView>;
  /**
   * Subscribe to KChat connection-state changes surfaced by the
   * main process. The callback fires once on every successful
   * connect, disconnect, or transient error transition. Returns
   * an unsubscribe function the caller must invoke in the React
   * cleanup phase to avoid leaking the IPC listener.
   *
   * This mirrors the `updates.onStatus` precedent so the
   * renderer doesn't have to choose between blocking on
   * `kchat.status()` Promise polling and a per-component
   * reconciliation timer for connection-card refresh.
   */
  onStatusChange: (
    cb: (status: KchatConnectionStateView) => void,
  ) => () => void;
  /**
   * Subscribe to KChat WebSocket events surfaced by the main
   * process forwarder. The forwarder is a pass-through: every
   * event it observes from `KchatClient.onWebSocketEvent` is
   * projected to a renderer-safe view and broadcast to all
   * subscribed renderers. There is NO event-type allowlist at
   * the forwarder layer — `posted`, `file_added`,
   * `channel_member_updated`, `channel_created`,
   * `channel_deleted`, `user_added`, `user_removed`,
   * `status_change`, and any other event the KChat server
   * pushes will all surface here. Consumers must filter by
   * `event.event` if they want a narrower set; the
   * `KchatSidebarSection` is one such consumer (it only acts
   * on `posted` and `file_added`).
   *
   * Returns an unsubscribe function the caller must invoke in
   * the React cleanup phase. The main-process forwarder uses a
   * per-renderer-window ring buffer (drop-oldest, 100-event
   * cap) so a stuck renderer can never wedge the WS reader; if
   * the renderer misses events during a backpressure drop, the
   * sidebar's 30 s reconciliation poll closes the gap on the
   * next tick.
   */
  onEvent: (cb: (event: KchatWebSocketEventPayload) => void) => () => void;
}

// --- Audit ----------------------------------------------
//
// Read-only renderer-facing view of the append-only `tessera_audit`
// SQLite store. The renderer renders the recent-activity list on
// Settings and the KChat audit filter; both go through
// `audit:listRecent` which returns events newest-first.

/**
 * A single audit row, as seen by the renderer.
 *
 * `eventType` is the **snake_case** wire form of the
 * `AuditEventType` enum — `"kchat_connected"`, `"artifact_shared"`,
 * `"source_added"`, etc. The Rust enum is annotated with
 * `#[serde(rename_all = "snake_case")]` (see `AuditEventType` in
 * `crates/tessera_audit/src/event.rs`), which is the form that
 * survives the napi bridge and lands in the renderer. The renderer
 * groups events by snake_case prefix (`kchat_`, `source_`,
 * `artifact_`, `connector_`, etc.) in `AuditActivityCard.tsx`.
 *
 * `timestamp` is an RFC 3339 / ISO 8601 string in UTC.
 */
export interface AuditEventView {
  /**
   * UUID assigned at append time. Audit rows use TEXT-typed UUIDs
   * (`uuid::Uuid::new_v4`) rather than auto-increment integers so
   * concurrent appenders cannot collide on a primary key — the
   * renderer should treat the value as opaque.
   */
  id: string;
  eventType: string;
  timestamp: string;
  details: string;
}

/**
 * outcome of one successful audit-log rotation
 * call. `archivePath` is the absolute on-disk path of the gzipped
 * JSONL archive the rotation wrote — the renderer surfaces it in
 * the Settings UI so the user can copy / inspect it.
 *
 * `rotatedCount` is the number of rows that were archived AND
 * deleted from the live table — matches the number of JSONL
 * lines in `archivePath`.
 */
export interface AuditRotationResult {
  archivePath: string;
  rotatedCount: number;
}

export interface AuditApi {
  /**
   * Return the `limit` most recent audit rows, newest first.
   * `limit` defaults to 100 and is clamped to `[1, 500]` in the
   * main process. `offset` defaults to 0 and lets the renderer
   * page backwards through history.
   */
  listRecent: (limit?: number, offset?: number) => Promise<AuditEventView[]>;
  /**
   * list audit-archive file paths in the
   * userData/audit-archives directory, newest first. Returns
   * `[]` when no rotations have ever happened.
   */
  getArchives: () => Promise<string[]>;
  /**
   * trigger an immediate audit-log rotation.
   * Returns `null` when the live table is at or below the
   * threshold (no rotation occurred).
   */
  rotate: () => Promise<AuditRotationResult | null>;
}
