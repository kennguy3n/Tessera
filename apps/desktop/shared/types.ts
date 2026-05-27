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
 * Block B Task 3 (Phase 11).
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
 * Block B Task 4 (Phase 11): when `outcome === "revoked"`, the
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
  /** Block C Task 2 (Phase 12): count of `kchat_posts` rows
   *  scrubbed by the inline cryptoshred on the revoke path; 0 on
   *  every non-revoke outcome AND on file-only sources where no
   *  chat-post evidence ever existed. */
  postsDropped: number;
  /** Block C Task 2 (Phase 12): `true` when the per-source DEK
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
  /** Block B Task 4 (Phase 11): count of chunk rows scrubbed by
   *  the inline cryptoshred. Both `revoked` and `already_revoked`
   *  outcomes run the (idempotent) shred so a re-revoke can serve
   *  as a one-time backfill for sources soft-revoked under the
   *  Task 3 build. `unlinked` is always zero. */
  chunksDropped: number;
  /** Block B Task 4 (Phase 11): count of indexed_files rows
   *  scrubbed by the inline cryptoshred. Same semantics as
   *  `chunksDropped`. */
  filesDropped: number;
  /** Block C Task 2 (Phase 12): count of `kchat_posts` rows
   *  scrubbed by the inline cryptoshred. Same semantics as
   *  `chunksDropped`. `unlinked` outcomes are always zero. */
  postsDropped: number;
  /** Block C Task 2 (Phase 12): `true` when the per-source DEK
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
 * Block C Task 1 (Phase 12).
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
 * Block C Task 1 (Phase 12).
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
 * Block C Task 1 (Phase 12).
 */
export interface KchatPostDeleteOutcomeInfo {
  outcome: "deleted" | "not_found" | "unlinked" | "access_revoked";
  sourceId?: string;
  chunksDropped: number;
}

/**
 * Block C Task 4 (Phase 13): persisted backfill state for a
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
 * Block C Task 4 (Phase 13): outcome of a single backfill page
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
 * Block C Task 4 (Phase 13): outcome of
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
 * Block C Task 4 (Phase 13): aggregate result of one
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
 * Block D Task 1 (Phase 14): renderer-facing KChat-post search
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
   * Phase 13 Theme 2 Task 9: human-readable sender username,
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
   * Phase 13 Theme 2 Task 9: human-readable channel display name,
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
 * Block D Task 1 (Phase 14): bridge-side KChat-post search hit.
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
 * Phase 13 Theme 2 Task 13: bridge-side single message in a KChat
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
 * Phase 13 Theme 2 Task 13: renderer-facing thread-context message.
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

export const EXPORT_FORMATS = ["markdown", "html", "csv", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface SettingsData {
  theme: Theme;
  defaultExportFormat: ExportFormat;
  ignorePatterns: string[];
  watchPatterns: string[];
}

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
}

// -----------------------------------------------------------------
// Automations
// -----------------------------------------------------------------

export type AutomationTrigger =
  | { kind: "schedule"; interval_seconds: number }
  | { kind: "on_generate"; template_id: string };

export type AutomationAction =
  | { kind: "reindex_source"; source_id: string }
  | {
      kind: "generate_from_template";
      template_id: string;
      source_ids: string[];
    };

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

export interface SourceApi {
  addLocalFolder: (path: string) => Promise<SourceInfo>;
  addLocalFile: (path: string) => Promise<SourceInfo>;
  listSources: () => Promise<SourceInfo[]>;
  removeSource: (id: string) => Promise<void>;
  searchSources: (query: string, limit: number) => Promise<SearchHit[]>;
  getDetail: (id: string) => Promise<SourceDetailInfo>;
  reindex: (id: string) => Promise<SourceInfo>;
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
  generate: (request: GenerateRequest) => Promise<void>;
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
   * Delete the model currently installed in `capability`'s slot.
   * Defaults to the text slot when omitted so legacy single-slot
   * callers keep working unchanged.
   */
  deleteModel: (capability?: ModelCapability) => Promise<void>;
  onDownloadProgress: (
    callback: (p: ModelDownloadProgress) => void,
  ) => () => void;
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
  ) => Promise<ConnectorStatusInfo>;
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
}

export interface TaskApi {
  create: (req: CreateTaskRequest) => Promise<TaskInfo>;
  list: () => Promise<TaskInfo[]>;
  get: (id: string) => Promise<TaskInfo | null>;
  update: (id: string, req: UpdateTaskRequest) => Promise<TaskInfo>;
  remove: (id: string) => Promise<boolean>;
  reorder: (status: string, ids: string[]) => Promise<void>;
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
 * Renderer-facing API namespace exposed on `window.tessera`. The
 * preload script's `contextBridge.exposeInMainWorld("tessera", api)`
 * call must satisfy this shape.
 */
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
  automations: AutomationApi;
  dialog: DialogApi;
  updates: UpdatesApi;
  kchat: KchatApi;
  audit: AuditApi;
}

// --- KChat (Phase 11) -----------------------------------------------------
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
   * "channel files" preview can show *who* uploaded each file
   * (Phase 13 Theme 2 Task 11). The id is validated against the
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
   * Resolved uploader username (Phase 13 Theme 2 Task 11). The
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
 * Phase 14 — renderer-facing detection result for the Tessera
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
 * Phase 13 Task 10 — renderer-facing projection of an in-flight
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
 * Phase 11 Block B Task 1 introduces this view; the Block A
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

/** Renderer-facing KChat API namespace. */
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
  ) => Promise<{ fileId: string; fileName: string }>;
  addChannelSource: (
    channelId: string,
    channelName: string,
  ) => Promise<{ sourceId: string; cacheDir: string }>;
  /**
   * Block C Task 4 (Phase 13): trigger the historical-backfill
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
   * Block D Task 1 (Phase 14): KChat post-body retrieval. Returns
   * AEAD-verified hits, ranked, with a composed permalink (or
   * `null` when the user is disconnected). The handler enforces
   * a 10/s sustained + 20-burst rate limit (`kchat:searchPosts`)
   * matching `sources.search`, and emits a
   * `KchatPostSearchExecuted` audit row carrying only the
   * 16-hex SHA-256 of the query — never the raw query.
   */
  searchPosts: (query: string, limit: number) => Promise<KchatPostSearchHit[]>;
  /**
   * Phase 13 Theme 2 Task 13: fetch up to 3 thread-context
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
   * Phase 14 Task 6: open a KChat conversation in KChat Desktop
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
   * Phase 14 Task 4: open the KChat Desktop extension-management
   * settings page (`kchat://app/settings/extensions`) via the OS
   * URL handler. No-arg by design: the deeplink is fixed so the
   * renderer cannot smuggle arbitrary URLs across the IPC
   * boundary.
   */
  openDesktopExtensions: () => Promise<{ opened: boolean; url: string }>;
  /**
   * Phase 14 Task 4: read Tessera's own snapshot of whether the
   * KChat Desktop side of the integration is currently reachable.
   * The renderer polls this from the Settings card to render the
   * "KChat Desktop detected" indicator. Returns `null` when the
   * underlying detection isn't ready yet (e.g. during the very
   * first paint after app launch).
   */
  desktopBridgeStatus: () => Promise<KchatDesktopBridgeStatusView | null>;
  /**
   * Phase 13 Task 10: KChat channel backfill progress. Polled by
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

// --- Audit (Phase 11 Task 6) ----------------------------------------------
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

export interface AuditApi {
  /**
   * Return the `limit` most recent audit rows, newest first.
   * `limit` defaults to 100 and is clamped to `[1, 500]` in the
   * main process. `offset` defaults to 0 and lets the renderer
   * page backwards through history.
   */
  listRecent: (limit?: number, offset?: number) => Promise<AuditEventView[]>;
}
