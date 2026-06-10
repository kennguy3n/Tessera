import { app } from "electron";
import * as path from "path";
import * as fs from "fs";
import { ModelSidecar } from "./sidecar";
import { loadConfig } from "./config";
// `./diffusionSidecar` is loaded dynamically inside
// `configureSidecars()` so the diffusion module graph (sd-server
// binary resolution + tar extraction logic + stable-diffusion.cpp
// log parsing) is not on the cold-start critical path. `import type`
// keeps the `DiffusionSidecar` type available for field declarations
// without emitting a runtime require — TypeScript erases type-only
// imports at compile time, so no module-load cost remains.
import type { DiffusionSidecar } from "./diffusionSidecar";
import { KchatAuthService } from "./kchat/kchatAuth";
import { KchatEventForwarder } from "./kchat/kchatEventForwarder";
import { KchatOfflineQueue } from "./kchat/kchatOfflineQueue";
import {
  KchatLocalApiServer,
  type LocalApiHandlers,
  type LocalApiStatus,
  type TesseraKchatSourceRow,
  type IngestChannelRequest,
  type IngestChannelResponse,
  type ShareArtifactRequest,
  type ShareArtifactResponse,
  LOCAL_API_CAPABILITIES,
  LocalApiError,
} from "./kchat/kchatLocalApi";
import {
  DeeplinkBridge,
  attachAppEvents as attachDeeplinkEvents,
} from "./kchat/kchatDeeplinkBridge";
import { getOrCreateDbKeyAsync, EncryptionUnavailableError } from "./dbKey";
import type {
  AddCitationRequest,
  ArtifactInfo,
  ArtifactVersionInfo,
  AutomationInfo,
  BackfillEmbeddingsResult,
  CitationInfo,
  CompareSourcesResult,
  EmbeddingDownloadProgressInfo,
  EmbeddingModelInfo,
  EmbeddingModelStatusInfo,
  EmbeddingProgressInfo,
  ExportResult,
  HybridSearchConfigInfo,
  HybridSearchConfigUpdate,
  IndexingProgressInfo,
  KchatAclMemberInfo,
  KchatAclRefreshOutcomeInfo,
  KchatChannelAddOutcomeInfo,
  KchatFileIndexOutcomeInfo,
  KchatBackfillCompletionOutcomeInfo,
  KchatBackfillIngestOutcomeInfo,
  KchatBackfillRunOutcome,
  KchatBackfillStateInfo,
  KchatPostDeleteOutcomeInfo,
  KchatPostIngestInputInfo,
  KchatPostIngestOutcomeInfo,
  KchatPostSearchHitInfo,
  KchatRevokeOutcomeInfo,
  KchatThreadContextMessageInfo,
  ReplaceCitationRequest,
  ReplaceCitationResult,
  ResourceMode,
  EnrichedSearchResultInfo,
  SearchHitInfo,
  SourceDetailInfo,
  SourceInfo,
  SubstrateDecayReportInfo,
  SubstrateMemoryInfo,
  SubstrateRelatedSuggestionInfo,
  SubstrateSynthesisInfo,
  TaskInfo,
  TemplateInfo,
  BackupInfo,
  BundleInfo,
  BundleImportReport,
  BundleFileEntry,
  BundleRestoreTarget,
} from "../shared/types";

// Re-export the canonical shared types so existing call sites that
// import them from "./appState" keep working. The single source of
// truth is `apps/desktop/shared/types.ts`.
export type {
  AddCitationRequest,
  ArtifactInfo,
  ArtifactVersionInfo,
  AutomationInfo,
  BackfillEmbeddingsResult,
  CitationInfo,
  CompareSourcesResult,
  ComparisonInfo,
  EmbeddingProgressInfo,
  HybridSearchConfigInfo,
  HybridSearchConfigUpdate,
  IndexedFileInfo,
  IndexingProgressInfo,
  KchatAclMemberInfo,
  KchatAclRefreshOutcomeInfo,
  KchatChannelAddOutcomeInfo,
  KchatFileIndexOutcomeInfo,
  KchatBackfillCompletionOutcomeInfo,
  KchatBackfillIngestOutcomeInfo,
  KchatBackfillRunOutcome,
  KchatBackfillStateInfo,
  KchatPostDeleteOutcomeInfo,
  KchatPostIngestInputInfo,
  KchatPostIngestOutcomeInfo,
  KchatPostSearchHit,
  KchatPostSearchHitInfo,
  KchatRevokeOutcomeInfo,
  KchatThreadContextMessage,
  KchatThreadContextMessageInfo,
  ReplaceCitationRequest,
  ReplaceCitationResult,
  EnrichedSearchResult,
  EnrichedSearchResultInfo,
  SearchHit,
  SearchHitInfo,
  SourceDetailInfo,
  SourceInfo,
  SubstrateConceptInfo,
  SubstrateDecayReportInfo,
  SubstrateMemoryInfo,
  SubstrateRelatedSuggestionInfo,
  SubstrateSynthesisInfo,
  TaskInfo,
  TemplateInfo,
  ThemeInfo,
  EmbeddingModelInfo,
  EmbeddingModelStatusInfo,
  EmbeddingDownloadProgressInfo,
  BackupInfo,
  BundleInfo,
  BundleImportReport,
  BundleFileEntry,
  BundleRestoreTarget,
} from "../shared/types";

/**
 * JS-facing v2 connector descriptor returned by
 * `bridgeConnectorsV2List`. Mirrors `ConnectorV2InfoNapi` in
 * `crates/tessera_bridge/src/connectors_v2_napi.rs`.
 */
export interface ConnectorV2InfoNapi {
  provider: string;
  displayName: string;
  authKind: string;
}

export interface NativeBridge {
  /**
   * Initialise the Rust-side workspace.
   *
   * `dbKey`, when provided, is the 64-character hex SQLCipher key
   * derived by `electron/dbKey.ts`. The Rust side issues
   * `PRAGMA key = "x'<hex>'"` on the connection and, on first launch
   * against a pre-encryption plaintext DB, transparently migrates
   * via `sqlcipher_export`. Pass `null` or omit to open the DB
   * unencrypted (only used in fallback / test paths).
   */
  initBridge(dbPath: string, templateDir: string, dbKey?: string | null): void;
  /**
   * graceful shutdown hook. Runs
   * `PRAGMA wal_checkpoint(TRUNCATE)` so the on-disk WAL file is
   * folded back into the main database file before the process
   * exits. The `will-quit` handler (`apps/desktop/electron/main.ts`)
   * calls this after the scheduler and sidecars are drained so the
   * next cold start does not pay a WAL-replay cost and backup
   * tooling sees a single self-contained file.
   *
   * Safe to call before {@link initBridge} — the Rust side returns
   * `Ok(())` as a no-op when the bridge hasn't been initialised,
   * so the will-quit handler doesn't need to guard against early
   * boot failures.
   */
  bridgeDispose(): void;
  bridgeAddLocalFolder(path: string): SourceInfo;
  bridgeAddLocalFile(path: string): SourceInfo;
  /**
   * Register-or-reindex a KChat-channel source backed by a local
   * cache directory the Node-side KChat client populates with files
   * downloaded from a KChat channel's file store. The directory is
   * indexed through the standard local-folder pipeline; the
   * `SourceType::Kchat` tag lets the renderer render a KChat-
   * specific icon / detail surface and lets the KChat scheduler
   * poll the corresponding channel for new files on its own
   * interval.
   *
   * **Idempotent on `cacheDir`.** The `sources:addKchatChannel`
   * IPC handler invokes this on every channel re-sync (the
   * convergent-sync pattern). An earlier implementation always
   * generated a fresh `SourceId`, leaving one duplicate source row
   * per sync (unbounded source-table growth + double indexing). The
   * returned outcome's `newlyCreated` flag is true only on the call
   * that inserted the row; subsequent re-syncs return the same
   * `SourceId` with `newlyCreated=false`, and the handler uses the
   * flag to gate the `KchatChannelLinked` audit event to first-sync
   * only.
   */
  bridgeAddKchatChannel(cacheDir: string): KchatChannelAddOutcomeInfo;
  /**
   * Returns whether a `SourceType::Kchat` source row exists for the
   * given `cacheDir`. The Block B Task 2 WS forwarder calls this on
   * every `file_added` event so a push for a channel the user has
   * not linked never triggers a download. O(log n) on the
   * `idx_sources_type_path` composite index — cheap enough to call
   * once per push.
   */
  bridgeIsKchatChannelLinked(cacheDir: string): boolean;
  /**
   * Targeted single-file index for a KChat-channel source. Called
   * by the Block B Task 2 WS forwarder after it has downloaded the
   * bytes referenced by a `file_added` event into the channel cache
   * directory. The substrate side re-applies path-traversal
   * containment on `fileBasename` as defence-in-depth — the Node
   * side also sanitises with `path.basename(...)` before writing
   * the file. The returned `wasLinked && indexed` AND condition is
   * what the forwarder records as the `triggered_reindex` flag on
   * the `KchatFileEventReceived` audit row, so the audit log
   * accurately reflects whether THIS event drove indexer work.
   */
  bridgeIndexKchatFile(
    cacheDir: string,
    fileBasename: string,
  ): KchatFileIndexOutcomeInfo;
  /**
   * Refresh a KChat channel's ACL roster + project status onto the
   * source row. Called by
   * `KchatEventForwarder` after every membership-change event
   * (`user_added`, `user_removed`, `channel_updated`) with the
   * authoritative roster fetched from `GET /channels/{id}/members`.
   *
   * Status projection rules:
   *   - principal in roster + source previously `AccessRevoked` →
   *     transitions back to `Connected` (outcome `"regranted"`).
   *     `Connected` (not `Indexed`) because the revoke path
   *     cryptoshredded all evidence rows in Block B Task 4; the
   *     Node-side forwarder reads `"regranted"` as a signal to
   *     schedule a full channel re-sync via the
   *     `setKchatChannelResyncImpl` slot wired in
   *     `apps/desktop/electron/ipc/kchat.ts`, after which the
   *     indexer promotes the status to `Indexing` → `Indexed`.
   *   - principal in roster + any other state → status untouched
   *     (outcome `"granted"`).
   *   - principal NOT in roster → transitions to `AccessRevoked`
   *     (outcome `"revoked"`).
   *   - source not linked → `"unlinked"`.
   *   - no `kchat_principal` set → `"no_principal"` (no-op).
   *
   * The roster is replaced atomically in a single SQLite
   * transaction; concurrent retrieval queries see either the
   * pre- or post-refresh state, never an empty intermediate.
   */
  bridgeRefreshKchatAcl(
    cacheDir: string,
    members: KchatAclMemberInfo[],
  ): KchatAclRefreshOutcomeInfo;
  /**
   * Explicitly revoke a KChat-channel source. Used for `channel_archived` / `channel_deleted` /
   * self-`user_removed` events where there is no roster to fetch.
   * The ACL roster is left intact for forensics — "who else had
   * access at the moment of revocation" is a real question
   * operators ask.
   */
  bridgeRevokeKchatSource(cacheDir: string): KchatRevokeOutcomeInfo;
  /**
   * Set the locally-authenticated KChat principal user id on the
   * substrate. Called by the
   * `kchat:connect` IPC handler after `/users/me` returns. The
   * substrate persists the id in a singleton `kchat_principal`
   * row so subsequent `bridgeRefreshKchatAcl` calls can check
   * membership without re-threading the id through every event.
   */
  bridgeSetKchatPrincipal(userId: string): void;
  /** Clear the persisted KChat principal on `kchat:disconnect`. */
  bridgeClearKchatPrincipal(): void;
  bridgeListSources(): SourceInfo[];
  bridgeRemoveSource(sourceId: string): void;
  bridgeSearchSources(query: string, limit: number): SearchHitInfo[];
  /**
   * Observation-enriched search. Returns the same chunk `hits` as
   * {@link bridgeSearchSources} (retention-weighted via the substrate's
   * per-source retention scores) plus the additive knowledge plane
   * (entities, facts, concepts, memories) for the renderer's
   * "Knowledge" tab. Exported from `tessera_bridge`'s `napi_exports.rs`
   * as `bridge_search_sources_enriched`.
   */
  bridgeSearchSourcesEnriched(
    query: string,
    limit: number,
  ): EnrichedSearchResultInfo;
  bridgeGetSourceDetail(sourceId: string): SourceDetailInfo;
  bridgeReindexSource(sourceId: string): SourceInfo;
  bridgeGetIndexingProgress(sourceId: string): IndexingProgressInfo;
  /**
   * Trigger an embedding backfill pass over every chunk missing an
   * embedding for the active model. The Rust side is idempotent —
   * a second call against an up-to-date index reports `embedded=0`.
   * Pass `null` (or omit) to let the bridge pick its default batch
   * size.
   *
   * **Returns a `Promise`** — the Rust napi function is declared as
   * `AsyncTask<BackfillEmbeddingsTask>` so the heavy DB / embedding
   * work runs on a libuv worker thread (Node's built-in thread
   * pool) rather than blocking the JS main thread. The IPC handler
   * at `ipc/sources.ts:135` and every other consumer MUST `await`
   * the result; a non-awaited access (e.g.
   * `bridge.bridgeBackfillEmbeddings(null).embedded`) would silently
   * read `.embedded` off the Promise and get `undefined`.
   */
  bridgeBackfillEmbeddings(
    batchSize?: number | null,
  ): Promise<BackfillEmbeddingsResult>;
  bridgeGetEmbeddingProgress(): EmbeddingProgressInfo;
  /**
   * snapshot of all shipped ONNX embedding models
   * (catalogue entries with per-model install state) plus the
   * currently-active embedder's `model_id` plus the in-flight
   * download tracker. Single round-trip so the Settings UI can
   * render the picker in one frame.
   *
   * `userDataDir` is the Electron app's `app.getPath("userData")`
   * path — the bridge stores ONNX files under
   * `${userDataDir}/models/onnx/${slug}/`. Passed explicitly so the
   * bridge does not need to call Electron APIs (it lives in
   * `tessera_bridge`, which has no Electron dependency).
   */
  bridgeGetEmbeddingModelStatus(userDataDir: string): EmbeddingModelStatusInfo;
  /**
   * download an ONNX embedding model + tokenizer
   * to `${userDataDir}/models/onnx/${slug}/`. Returns a Promise
   * that resolves with the model's final catalogue entry
   * (`installed: true`, canonical `modelId`) or rejects with the
   * download error.
   *
   * Use `bridgeGetEmbeddingDownloadProgress` to poll progress on a
   * timer while the Promise is pending. Idempotent: re-running on
   * an already-installed model returns immediately with
   * `installed: true`.
   */
  bridgeDownloadEmbeddingModel(
    slug: string,
    userDataDir: string,
  ): Promise<EmbeddingModelInfo>;
  /**
   * lightweight progress poll for in-flight model
   * downloads. Mirrors `bridgeGetEmbeddingProgress` — bypasses the
   * source-manager lock so the progress bar updates at full timer
   * cadence regardless of what else the bridge is doing.
   */
  bridgeGetEmbeddingDownloadProgress(): EmbeddingDownloadProgressInfo;
  /**
   * synchronously swap the active embedder to a
   * downloaded ONNX model. Returns the freshly-activated model's
   * catalogue entry. Does NOT trigger a re-embed pass — the caller
   * (the `settings:switchEmbeddingModel` IPC handler) chains a
   * `bridgeBackfillEmbeddings` call immediately after so the
   * progress UI can render the backfill bar.
   */
  bridgeSwitchEmbeddingModel(
    slug: string,
    userDataDir: string,
  ): EmbeddingModelInfo;
  bridgeGetHybridSearchConfig(): HybridSearchConfigInfo;
  bridgeUpdateHybridSearchConfig(
    update: HybridSearchConfigUpdate,
  ): HybridSearchConfigInfo;
  bridgeCreateArtifact(
    title: string,
    artifactType: string,
    templateId?: string | null,
  ): ArtifactInfo;
  bridgeUpdateArtifactContent(
    artifactId: string,
    content: string,
  ): ArtifactInfo;
  bridgeGetArtifact(artifactId: string): ArtifactInfo;
  bridgeListArtifacts(): ArtifactInfo[];
  bridgeDeleteArtifact(artifactId: string): void;
  bridgeExportArtifact(
    artifactId: string,
    format: string,
    contentOverride?: string | null,
    /**
     * When `false`, the artifact's citation list is suppressed at the
     * Rust dispatch layer before any format-specific exporter sees it.
     * `null` / `undefined` / `true` keep existing behaviour (citations
     * are rendered into the export bytes when present).
     */
    includeCitations?: boolean | null,
  ): ExportResult;
  bridgeExportArtifactToFile(
    artifactId: string,
    format: string,
    path: string,
    contentOverride?: string | null,
    includeCitations?: boolean | null,
  ): void;
  bridgeListTemplates(): TemplateInfo[];
  bridgeGetTemplate(templateId: string): TemplateInfo | null;
  bridgeListCitations(artifactId: string): CitationInfo[];
  bridgeAddCitation(req: AddCitationRequest): CitationInfo;
  bridgeRemoveCitation(artifactId: string, citationId: string): void;
  bridgeCheckSourceChanged(citationId: string): boolean;
  bridgeCheckCitationFreshness(citationId: string): string;
  bridgeReplaceCitation(req: ReplaceCitationRequest): ReplaceCitationResult;
  bridgeListVersions(artifactId: string): ArtifactVersionInfo[];
  bridgeRestoreVersion(artifactId: string, versionNumber: number): ArtifactInfo;
  bridgeGenerateFromTemplate(
    templateId: string,
    sourceIds: string[],
    /**
     * Optional, additive knowledge-substrate context lines appended to
     * generation as a "Knowledge context" section. Both the interactive
     * (`artifacts:generateFromTemplate`) and automated (scheduler)
     * generation paths augment via `buildMemoryContext`; the argument
     * stays optional so a caller that passes nothing (or an empty
     * context, e.g. an empty/unavailable substrate) preserves
     * backward-compatible output.
     */
    memoryContext?: string[],
  ): ArtifactInfo;
  bridgeExtractTasksDecisions(sourceId: string): string;
  bridgeCompareSources(
    sourceIdA: string,
    sourceIdB: string,
  ): CompareSourcesResult;
  bridgeExportEvidencePack(artifactId: string, outputPath: string): string;
  /**
   * In-memory evidence-pack variant. Builds the same ZIP archive as
   * `bridgeExportEvidencePack` but returns the bytes directly so
   * the share-to-KChat path can stream them straight into the
   * channel upload without staging on disk.
   */
  bridgeEvidencePackBytes(artifactId: string): Buffer;
  // --- Tasks ---
  // `req_json` is a JSON-encoded `tessera_bridge::tasks::CreateTaskRequest`
  // / `UpdateTaskRequest`. JSON-tunneling is used because the napi macro
  // does not generate TS types for serde-default + Option-of-Option
  // fields cleanly; the bridge's serde_json deserialization gives the
  // backend full structural validation (including parse_opt_rfc3339).
  bridgeCreateTask(reqJson: string): TaskInfo;
  bridgeListTasks(): TaskInfo[];
  bridgeGetTask(taskId: string): TaskInfo | null;
  bridgeUpdateTask(taskId: string, reqJson: string): TaskInfo;
  bridgeDeleteTask(taskId: string): boolean;
  bridgeReorderTasks(status: string, ids: string[]): void;
  // --- Automations ---
  bridgeCreateAutomation(reqJson: string): AutomationInfo;
  bridgeListAutomations(): AutomationInfo[];
  bridgeGetAutomation(automationId: string): AutomationInfo | null;
  bridgeSetAutomationEnabled(automationId: string, enabled: boolean): void;
  bridgeDeleteAutomation(automationId: string): boolean;
  /** Enabled `Schedule` automations whose `next_scheduled_at <= now`. */
  bridgeDueScheduledAutomations(): AutomationInfo[];
  /** Enabled `OnGenerate` automations tied to the given template string id
   *  (e.g. `"prd-v1"`). The bridge hashes the id via
   *  `TemplateId::from_string` to match the UUID5 stored on the trigger. */
  bridgeMatchingOnGenerateAutomations(templateId: string): AutomationInfo[];
  /** Enabled `OnKchatMessageMatch` automations whose `channel_id` equals
   *  `channelId` and whose `regex` matches `message`. Called from the
   *  KChat event forwarder on every `posted` WebSocket event. */
  bridgeMatchingKchatMessageAutomations(
    channelId: string,
    message: string,
  ): AutomationInfo[];
  /** Persist a run result. `status` is rendered verbatim by the UI. */
  bridgeRecordAutomationRun(automationId: string, status: string): void;
  // --- Audit pass-throughs (the audit code) ---
  //
  // The events below are emitted from JS-side IPC handlers
  // (`ipc/settings.ts`, `ipc/model.ts`, `ipc/connectors/handlers.ts`)
  // and routed through the Rust audit store via these pass-throughs
  // so every audit event lives in the same SQLite append-only table
  // as the bridge-internal ones. Each method is a no-throw, no-await
  // best-effort call — failure to append an audit row must never
  // propagate back to the IPC handler (see Rust-side rationale in
  // `napi_exports.rs`).
  bridgeLogSettingsChanged(setting: string, value: string): void;
  bridgeLogModelStarted(modelId: string): void;
  bridgeLogModelStopped(reason: string): void;
  bridgeLogConnectorConnected(provider: string): void;
  bridgeLogConnectorSynced(
    provider: string,
    added: number,
    updated: number,
    removed: number,
  ): void;
  bridgeLogConnectorDisconnected(provider: string, filesRemoved: number): void;
  // --- v2 connector framework (knowledge substrate) bridge ---
  //
  // These map onto `crates/tessera_bridge/src/connectors_v2_napi.rs`.
  // They are the long-term replacement for Tessera's hand-rolled
  // per-provider TS sync logic: the Rust side wraps the knowledge
  // `connector_framework::Connector` trait (authenticate / initial_
  // sync / incremental_sync / fetch_content). Token and sync payloads
  // cross as JSON strings (the napi 2.x object surface can't express
  // optional/nested/binary fields losslessly); the TS adapter in
  // `ipc/connectors/connectorsV2.ts` is the single (de)serialiser.
  //
  // The methods are optional on the interface because a build that
  // compiles `tessera_bridge` without the `connectors-v2` feature
  // (or an older native addon) will not export them; the adapter
  // probes for their presence and falls back to the legacy path.
  /** List the v2 connector providers compiled into the native addon. */
  bridgeConnectorsV2List?(): ConnectorV2InfoNapi[];
  /** Whether `provider` is a feature-enabled v2 connector. */
  bridgeConnectorsV2Supported?(provider: string): boolean;
  /** Exchange an auth code for a token. Returns a `TokenWire` JSON string. */
  bridgeConnectorsV2Authenticate?(
    provider: string,
    authConfigJson: string,
    scopeId?: string | null,
  ): string;
  /** Refresh a token. Returns the refreshed `TokenWire` JSON string. */
  bridgeConnectorsV2Refresh?(
    provider: string,
    authConfigJson: string,
    tokenJson: string,
    scopeId?: string | null,
  ): string;
  /**
   * Run one sync pass. Returns a `Promise` resolving to a `SyncOutcome`
   * JSON string. The blocking HTTP sync runs on a libuv worker thread
   * (napi `AsyncTask`) so the Electron main process event loop stays
   * responsive during a long initial import — see
   * `crates/tessera_bridge/src/connectors_v2_napi.rs`.
   */
  bridgeConnectorsV2Sync?(
    provider: string,
    authConfigJson: string,
    tokenJson: string,
    stateJson?: string | null,
    scopeId?: string | null,
    fetchContent?: boolean | null,
    maxFetch?: number | null,
  ): Promise<string>;
  // --- KChat audit pass-throughs ---
  //
  // Each method is a no-throw best-effort append into the
  // `tessera_audit` SQLite store so the KChat audit trail lives in
  // the same place as every other source / connector event. See
  // `napi_exports.rs:bridge_log_kchat_*` for the corresponding
  // Rust side.
  bridgeLogKchatConnected(serverUrl: string, kchatUserId: string): void;
  bridgeLogKchatDisconnected(kchatUserId: string): void;
  bridgeLogKchatArtifactShared(
    artifactId: string,
    channelId: string,
    format: string,
    includeCitations: boolean,
    includeEvidencePack: boolean,
  ): void;
  bridgeLogKchatChannelLinked(
    channelId: string,
    channelName: string,
    cacheDir: string,
  ): void;
  bridgeLogKchatChannelUnlinked(channelId: string, filesRemoved: number): void;
  bridgeLogKchatFileDownloaded(
    channelId: string,
    fileName: string,
    bytes: number,
  ): void;
  /**
   * No-throw audit append called by the `KchatEventForwarder` for
   * each WebSocket event surfaced to renderers (and, on
   * `file_added`, to the auto-reindex hook). Payload bodies are
   * NOT passed — only the event name, originating channel id
   * (when present in the broadcast envelope), an optional file id
   * for `file_added` events, and the boolean `triggered_reindex`
   * flag so operators can correlate WS-driven indexer activity
   * with the originating event without consulting the KChat
   * server's own audit log. See `napi_exports.rs:bridge_log_kchat_file_event_received`.
   */
  bridgeLogKchatFileEventReceived(
    eventName: string,
    channelId: string | null,
    fileId: string | null,
    triggeredReindex: boolean,
  ): void;
  /**
   * No-throw audit append called by `KchatEventForwarder` after
   * every `bridgeRefreshKchatAcl` call. Member ids / roles are
   * NOT logged — only the roster size and the projection outcome
   * (`granted` / `regranted` / `revoked` / `unlinked` /
   * `no_principal`) so operators can see the ACL decision in the
   * audit trail without re-querying the substrate.
   */
  bridgeLogKchatAclRefreshed(
    channelId: string,
    memberCount: number,
    principalPresent: boolean,
    outcome: string,
  ): void;
  /**
   * No-throw audit append called by `KchatEventForwarder`
   * whenever a KChat-channel source transitions to
   * `SourceStatus::AccessRevoked`.
   * `reason` is the operator-visible short code for the
   * triggering event: `principal_removed` (explicit
   * `user_removed` for the auth user), `channel_archived`,
   * `channel_deleted`, or `principal_missing_from_roster` (a
   * routine refresh returned `Revoked`).
   */
  bridgeLogKchatChannelAccessRevoked(
    channelId: string,
    reason: string,
  ): void;
  /**
   * No-throw audit append called by `KchatEventForwarder` /
   * `kchat:disconnect` immediately after a revoke transition
   * triggers the substrate's inline cryptoshred. Emitted on every
   * revoke outcome — fresh revoke, already-revoked re-shred path,
   * and refresh-driven revoke — so the audit trail correlates the
   * `KchatChannelAccessRevoked` status-transition row with the
   * actual evidence-scrub counts.
   *
   * `reason` matches the sibling
   * `bridgeLogKchatChannelAccessRevoked` short code;
   * `chunksDropped` / `filesDropped` are the substrate counts
   * surfaced via `KchatRevokeOutcomeInfo` /
   * `KchatAclRefreshOutcomeInfo`.
   *
   * `fsScrubSucceeded` / `fsScrubError` are the Node-side
   * filesystem-scrub outcomes from `secureDeleteChannelArtifacts`.
   * The substrate counts only describe the database scrub; the
   * filesystem holds downloaded plaintext until the cache dir +
   * manifest sidecar are removed. Operators grep
   * `fs_scrub_succeeded=false` in the audit log to find revokes
   * whose on-disk plaintext survived the scrub.
   *
   * `vacuumSucceeded` / `vacuumError` are the substrate's Phase 5
   * `VACUUM` outcomes, forwarded through the bridge revoke /
   * refresh outcome structs. A `false` value is NOT a scrub
   * failure — the row-level DELETE + UPDATE already
   * committed under `secure_delete = ON` so the cryptographic
   * guarantee holds — but operators want the audit row to record
   * the degraded state so they can re-run `VACUUM` manually once
   * the underlying issue resolves. Previously a VACUUM failure
   * propagated `?` up to the forwarder's catch block and defaulted
   * the audit row to `outcome=unlinked`, hiding the successful
   * scrub from the trail.
   */
  bridgeLogKchatSourceCryptoshredded(
    channelId: string,
    reason: string,
    chunksDropped: number,
    filesDropped: number,
    /** Block C Task 2: `kchat_posts` row count
     *  scrubbed by the cryptoshred. Logged on the audit row so
     *  operators can grep `posts_dropped=N`. */
    postsDropped: number,
    /** Block C Task 2: `true` when the per-source DEK
     *  row was actually dropped. `false` indicates no DEK ever
     *  existed for this source (file-only ingest) — NOT a
     *  failure mode. Logged so operators can confirm the
     *  cryptographic guarantee fired when expected. */
    dekDropped: boolean,
    fsScrubSucceeded: boolean,
    fsScrubError: string | undefined,
    vacuumSucceeded: boolean,
    vacuumError: string | undefined,
  ): void;

  /**
   * ingest a single KChat post body.
   * Called by `KchatEventForwarder` on a `posted` WS event after
   * `withChannelSyncLock` serialises the work.
   */
  bridgeIngestKchatPost(
    input: KchatPostIngestInputInfo,
  ): KchatPostIngestOutcomeInfo;
  /**
   * re-ingest a KChat post body after
   * a `post_edited` WS event. Distinct from
   * `bridgeIngestKchatPost` only so the audit pair routes to
   * `KchatPostEdited` rather than `KchatPostIngested`.
   */
  bridgeEditKchatPost(
    input: KchatPostIngestInputInfo,
  ): KchatPostIngestOutcomeInfo;
  /**
   * drop the substrate evidence for
   * a KChat post after a `post_deleted` WS event. Returns the
   * outcome so the audit row can record `outcome=not_found`
   * vs `outcome=deleted`.
   */
  bridgeDeleteKchatPost(
    cacheDir: string,
    postId: string,
  ): KchatPostDeleteOutcomeInfo;
  /**
   * no-throw audit append for the
   * post-body ingest pipeline. Called by the forwarder after
   * `bridgeIngestKchatPost` returns.
   */
  bridgeLogKchatPostIngested(
    channelId: string,
    postId: string,
    outcome: string,
    chunkCount: number,
  ): void;
  /** Block C Task 1: see {@link bridgeLogKchatPostIngested}. */
  bridgeLogKchatPostEdited(
    channelId: string,
    postId: string,
    outcome: string,
    chunkCount: number,
  ): void;
  /** Block C Task 1: see {@link bridgeLogKchatPostIngested}. */
  bridgeLogKchatPostDeleted(
    channelId: string,
    postId: string,
    outcome: string,
    chunksDropped: number,
  ): void;

  // --- Block C Task 4: KChat historical backfill ---
  //
  // Three substrate-facing calls + four audit log calls compose
  // the orchestrator. The orchestrator (`runBackfillKchatChannel`
  // in `appState.ts`) lives outside the bridge and drives the
  // REST pagination loop via the channel-scoped lock; these
  // methods are the unit-of-work primitives the loop calls
  // page-by-page.

  /**
   * Read the persisted backfill state for a KChat channel. The
   * orchestrator uses this on entry to decide between "start a
   * fresh walk", "resume from cursor", "skip already-completed",
   * and "refuse to walk revoked/unlinked".
   */
  bridgeGetKchatBackfillState(cacheDir: string): KchatBackfillStateInfo;
  /**
   * Ingest one page of historical posts. `page` must be the
   * REST-returned newest-first list; the substrate advances the
   * persisted cursor to the OLDEST post id in the page.
   * Per-post substrate dedupe (BLAKE3 body-hash) makes
   * re-deliveries cheap (no double-chunking).
   */
  bridgeIngestKchatBackfillPage(
    cacheDir: string,
    page: KchatPostIngestInputInfo[],
  ): KchatBackfillIngestOutcomeInfo;
  /**
   * Mark the walk complete. Called by the orchestrator when the
   * REST page returns `prevPostId === null`. Future
   * `runBackfillKchatChannel` calls short-circuit at the state
   * read after this commits.
   */
  bridgeMarkKchatBackfillComplete(
    cacheDir: string,
  ): KchatBackfillCompletionOutcomeInfo;
  /** Audit row at the start of a walk. `resumeFromPostId === undefined`
   *  means the walk is fresh; the audit row prints `(fresh)`. */
  bridgeLogKchatBackfillStarted(
    channelId: string,
    sourceId: string,
    resumeFromPostId: string | undefined,
  ): void;
  /** Audit row after each successfully-ingested page. */
  bridgeLogKchatBackfillPageIngested(
    channelId: string,
    sourceId: string,
    pageNumber: number,
    postsIngested: number,
    postsUnchanged: number,
    postsSkippedRevoked: number,
    oldestPostIdInPage: string | undefined,
  ): void;
  /** Audit row when the walk reaches the end-of-history boundary. */
  bridgeLogKchatBackfillCompleted(
    channelId: string,
    sourceId: string,
    pagesWalked: number,
    totalPostsIngested: number,
    totalPostsUnchanged: number,
  ): void;
  /** Audit row when the walk stops early. `reason` is one of
   *  `access_revoked` / `safety_cap` / `unlinked` / `error`. */
  bridgeLogKchatBackfillAborted(
    channelId: string,
    sourceId: string,
    reason: string,
    pagesWalked: number,
    totalPostsIngested: number,
  ): void;
  /** Block D Task 1: audit row emitted by the
   *  `kchat:searchPosts` IPC handler after a successful retrieval.
   *  The handler computes `queryHash` (SHA-256 hex, first 16
   *  chars) and `latencyMs` (end-to-end IPC duration) before
   *  passing — the substrate never sees the raw query string,
   *  so a leaked audit log can't reveal what the user typed. */
  bridgeLogKchatPostSearchExecuted(
    queryHash: string,
    hits: number,
    sourcesTouched: number,
    latencyMs: number,
  ): void;
  /** Block D Task 1: FTS5 retrieval over chat-post
   *  bodies. Returns AEAD-verified hits — sources whose DEK has
   *  been dropped (revoked) yield no hits even if their old
   *  chunks remain in the FTS5 index (defence-in-depth for the
   *  cryptoshred guarantee). See
   *  `tessera_sources::manager::search_kchat_posts` for the
   *  pipeline. */
  bridgeSearchKchatPosts(
    query: string,
    limit: number,
  ): KchatPostSearchHitInfo[];
  /** Task 13: AEAD-verified thread-context
   *  retrieval. Returns up to 3 chronologically-ordered messages
   *  (thread root + up to 2 most-recent earlier-replies) or an
   *  empty array if the post is top-level / unknown / revoked.
   *  See `tessera_sources::manager::fetch_kchat_thread_context`
   *  for the full taxonomy of empty-vs-populated semantics. */
  bridgeFetchKchatThreadContext(
    sourceId: string,
    postId: string,
  ): KchatThreadContextMessageInfo[];
  // --- Audit query ---
  //
  // Renderer-facing read API over the audit store. The renderer
  // calls this through `audit:listRecent` IPC to render the recent
  // activity list on Settings. Limit is clamped main-side to
  // `[1, 500]` so a bad caller cannot OOM the main process; the
  // renderer schema rejects out-of-range values before this point.
  bridgeRecentAuditEvents(
    limit: number,
    offset: number,
  ): Array<{
    /** UUID. `audit_events.id` is TEXT-typed, not autoincrement. */
    id: string;
    eventType: string;
    timestamp: string;
    details: string;
  }>;
  /**
   * rotate the audit log (archive + delete the
   * oldest rows once the live table exceeds 100K rows). Returns
   * `null` when the table is below the threshold, otherwise an
   * object describing where the gzipped JSONL archive was
   * written.
   *
   * `archiveDir` is the absolute path the renderer wants archives
   * in — typically `<userData>/audit-archives/`. Owning the path
   * choice in the renderer (rather than letting the bridge pick)
   * keeps the rotation kicked off via IPC consistent with the one
   * a future scheduler invokes from the main process.
   */
  bridgeAuditRotate(archiveDir: string): {
    archivePath: string;
    rotatedCount: number;
  } | null;
  /**
   * list the audit-archive filenames in
   * `archiveDir`, newest-first. Returns `[]` when the directory
   * does not yet exist.
   */
  bridgeAuditListArchives(archiveDir: string): string[];
  /**
   * read the persisted sync-failure state for
   * one source row. Returns `last_error_json = null`, `retry_count
   * = 0`, `failed_permanently = false` when the row has never
   * failed (and when the row does not exist at all — the two
   * cases are indistinguishable to the renderer by design).
   */
  bridgeGetSourceSyncFailureState(sourceId: string): {
    lastErrorJson: string | null;
    retryCount: number;
    failedPermanently: boolean;
  };
  /**
   * atomic persistence of all three failure-
   * state columns. The caller (TS-side connectorBackoff) computes
   * the new `retryCount` and `failedPermanently` flag by applying
   * the policy in `connectorBackoff.ts` to the previous state +
   * the just-classified error.
   */
  bridgeRecordSourceSyncFailure(
    sourceId: string,
    lastSyncErrorJson: string,
    retryCount: number,
    failedPermanently: boolean,
  ): void;
  /**
   * clear failure-state columns. Resets
   * `last_sync_error → NULL`, `retry_count → 0`,
   * `failed_permanently → false`. Called from the success branch
   * of `runConnectorSync`.
   */
  bridgeRecordSourceSyncSuccess(sourceId: string): void;
  // --- Vision + image generation ---
  //
  // Async bridges that talk to local sidecars:
  //   - `bridgeVisionDescribe` → `llama-server --mmproj` on
  //     port 8385 (managed by `visionSidecar` here).
  //   - `bridgeGenerateImage`  → `sd-server` on port 8386
  //     (managed by `diffusionSidecar` here, started on
  //     explicit user action only).
  // Both return Promises (the napi side wraps the inner async
  // `tessera_runtime` calls in `AsyncTask`s) so the JS main
  // process event loop stays free during the 10-30 s sidecar
  // call.

  /**
   * Run a vision completion against a `llama-server --mmproj`
   * sidecar. Used by the indexing pipeline (image description,
   * OCR for scanned PDFs, chart extraction) and by Block-E user
   * features (whiteboard transcription, ask-about-image).
   *
   * `mode` selects a pre-tuned prompt:
   *   - `"describe"`: free-form image description for the search
   *     index.
   *   - `"ocr"`: verbatim text transcription, preserving layout
   *     in markdown.
   *   - `"chart"`: structured chart / diagram summary.
   *
   * Resolves with `{ content, stop, tokensPredicted,
   * tokensEvaluated }`. Rejects with the sidecar's HTTP status
   * line + body on failure (e.g. `HTTP 503: overloaded`) or with
   * the underlying I/O error if `imagePath` can't be read.
   */
  bridgeVisionDescribe(
    endpoint: string,
    imagePath: string,
    mode: "describe" | "ocr" | "chart",
    maxTokens: number,
  ): Promise<{
    content: string;
    stop: boolean;
    tokensPredicted: number;
    tokensEvaluated: number;
  }>;
  /**
   * Generate one image via the sd-server diffusion sidecar.
   * Used by the `imagegen:generate` IPC handler.
   *
   * `steps`, `cfgScale`, `seed`, and `negativePrompt` are
   * optional — pass `null` to fall back to FLUX.2-klein's
   * recommended sampling settings baked into the Rust side.
   *
   * Resolves with `{ pngBytes: Buffer, seed: BigInt }`.
   * `pngBytes` is the raw PNG payload (the IPC handler writes it
   * to `<userData>/generated-images/<artifactId>/<n>.png`).
   * `seed` is what sd-server actually used (caller-supplied or
   * server-chosen) so the artifact can persist it for
   * "regenerate in the same style" workflows.
   */
  bridgeGenerateImage(
    endpoint: string,
    request: {
      prompt: string;
      width: number;
      height: number;
      steps: number | null;
      cfgScale: number | null;
      seed: number | null;
      negativePrompt: string | null;
    },
  ): Promise<{ pngBytes: Buffer; seed: bigint }>;

  // --- Knowledge substrate (additive native layer) ---------------------
  //
  // The nine functions below are exported from `tessera_bridge`'s
  // `substrate.rs` module (snake_case `bridge_*` on the Rust side,
  // camelCased here by napi-derive). They delegate to the
  // `SubstrateManager` held in `AppState`, which writes only to the
  // substrate's own sibling DB files — never the existing
  // `sources` / `chunks` / `chunk_embeddings` tables. See
  // `crates/tessera_bridge/src/substrate.rs`.

  /**
   * Run the observation pipeline over a source's indexed chunks and
   * persist the extracted observations, memory objects, and concept
   * nodes. Idempotent per `sourceId` (re-running replaces that
   * source's slice rather than duplicating it). Returns the number of
   * observations extracted. This is the on-demand counterpart to the
   * automatic extraction that runs after
   * `bridgeAddLocalFolder` / `bridgeAddLocalFile` / `bridgeReindexSource`.
   */
  bridgeExtractObservations(sourceId: string): number;
  /**
   * List every memory object for a scope. `scope` is a scope label or
   * UUID; `null`/omitted uses the single default scope.
   */
  bridgeGetMemories(scope?: string | null): SubstrateMemoryInfo[];
  /** Pin a memory by id (strongest retention signal). */
  bridgePinMemory(id: string): SubstrateMemoryInfo;
  /** Decrement a memory's pin count (saturating at zero). */
  bridgeUnpinMemory(id: string): SubstrateMemoryInfo;
  /** Forget (delete) a single memory by id. */
  bridgeForgetMemory(id: string): void;
  /**
   * Return a JSON-serialized `concept_graph::GraphView` for a scope,
   * bounded by `maxNodes` (substrate default applies when
   * `null`/omitted).
   */
  bridgeGetConceptGraph(
    scope?: string | null,
    maxNodes?: number | null,
  ): string;
  /**
   * Suggest sources related to an already-selected working set via the
   * concept graph (the artifact-creation "You have N sources about
   * [entity]" affordance). `selectedSourceIds` is the user's current
   * selection; suggestions exclude already-selected sources and are
   * capped at `maxSuggestions` (default 10 when `null`/omitted).
   * Exported from `tessera_bridge`'s `substrate.rs` as
   * `bridge_suggest_related_sources`.
   */
  bridgeSuggestRelatedSources(
    selectedSourceIds: string[],
    maxSuggestions?: number | null,
  ): SubstrateRelatedSuggestionInfo[];
  /**
   * Recompute retention scores for every memory and apply decay
   * transitions. Returns a report of how many objects were scored and
   * archived. Called on a 6-hour timer by the main process
   * (`substrateDecayScheduler.ts`).
   */
  bridgeRunDecaySweep(): SubstrateDecayReportInfo;
  /**
   * Produce a deterministic, offline synthesis (recap, decisions, open
   * questions, active tasks) for a scope and persist it as a versioned
   * synthesis object.
   */
  bridgeTriggerSynthesis(scope?: string | null): SubstrateSynthesisInfo;

  // --- Backup & recovery ---
  //
  // Hot copies run against the same shared connection every other
  // store writes through, so the SQLite Online Backup API observes a
  // transactionally-consistent snapshot. The SQLCipher key and live
  // database path are captured Rust-side at `initBridge`, so the
  // renderer never handles key material or re-derives the on-disk path.
  /**
   * Hot-copy the live database into `backupDir` (created if absent)
   * using the SQLite Online Backup API, re-encrypted under the live
   * SQLCipher key. Written to a `*.partial` temp file and atomically
   * renamed, so a crash never leaves a usable-looking truncated file.
   */
  bridgeCreateBackup(backupDir: string): BackupInfo;
  /** List backups in `backupDir`, newest first. A missing directory
   *  yields an empty list rather than throwing. */
  bridgeListBackups(backupDir: string): BackupInfo[];
  /** Delete backups beyond the `keep` most recent (always keeps at
   *  least one). Returns the filenames removed. */
  bridgePruneBackups(backupDir: string, keep: number): string[];
  /**
   * Validate that `backupPath` decrypts under the live key, then stage
   * it as a `*.pending-restore` sibling of the live DB. The swap
   * happens at next launch via {@link bridgeApplyPendingRestore}.
   * Returns the staged file path. Requires an app restart to take
   * effect — the live connection is never swapped underneath open
   * statements.
   */
  bridgeStageRestore(backupPath: string): string;
  /**
   * Apply a previously-staged restore for the DB at `dbPath` by
   * swapping the pending file into place. Returns `true` when a swap
   * occurred. Called at startup BEFORE {@link initBridge} opens the
   * database, so it does not depend on bridge state.
   */
  bridgeApplyPendingRestore(dbPath: string): boolean;
  /**
   * Export a full workspace bundle (hot DB copy + caller-supplied
   * sidecar files) into a single `.tessera-backup` tar.gz archive at
   * `outPath` with a SHA-256 manifest.
   */
  bridgeExportBundle(outPath: string, extras: BundleFileEntry[]): BundleInfo;
  /**
   * Import a workspace bundle from `bundlePath`: verify every entry's
   * SHA-256 against the manifest, stage the contained database for the
   * next launch, and atomically restore the matched sidecar `targets`.
   * Requires an app restart for the database swap to take effect.
   */
  bridgeImportBundle(
    bundlePath: string,
    targets: BundleRestoreTarget[],
  ): BundleImportReport;
}

let bridge: NativeBridge | null = null;
let modelSidecar: ModelSidecar | null = null;
// Gate for demand-loaded sidecar construction (LW-1). The text and
// vision `ModelSidecar` objects are NO LONGER constructed during
// `initAppState()` — building them probes the filesystem for the
// llama-server binary (`resolveSidecarBinary` does up to 5
// `fs.existsSync` calls) and installs idle-unload timers, all wasted
// work for a session where the user never generates. Instead the
// `ensureModelSidecar()` / `ensureVisionSidecar()` accessors lazily
// construct on first use (a `model:start` / vision request).
//
// This flag preserves the historical "null in fallback mode"
// contract: it flips to `true` only at the point `initAppState()`
// previously constructed the sidecars (i.e. after the native bridge
// initialised successfully). When the bridge is unavailable
// `initAppState()` returns early before setting it, so the ensure
// accessors keep returning `null` and the IPC handlers surface the
// same "sidecar not initialised" errors as before.
let sidecarsEnabled = false;
// KChat auth + REST + WebSocket client. Singleton because every IPC
// handler reads the same connection state (sidebar presence, share
// button enable/disable, channel browser) and a stray second
// instance would either hand out stale state or duplicate the
// outgoing WebSocket connection. Lazy-initialised on first
// `getKchatAuthService()` call to keep cold-start cheap when the
// user never connects KChat.
let kchatAuthService: KchatAuthService | null = null;
// KChat WebSocket forwarder singleton. Constructed lazily
// alongside the auth service so an app run that never touches
// KChat doesn't pay the cost. The forwarder subscribes to the
// auth service's `KchatClient` and pushes events to every
// renderer window via `kchat:event` IPC (see
// `kchat/kchatEventForwarder.ts` for the Block B Task 1
// design). Reset alongside the auth service in tests via
// `resetKchatAuthService`.
let kchatEventForwarder: KchatEventForwarder | null = null;
// Session 8 Task 3/6: renderer-owned watch list + auto-create toggle,
// held at module scope so the intent survives forwarder
// (re)construction. The forwarder is reconstructed on every
// `resetKchatAuthService` (token change / re-login) and is only
// lazily built on the first `getKchatAuthService()`; without
// persisting the intent here, a toggle applied before either event
// would be silently dropped while the IPC handler still echoed
// success. `applyKchatForwarderIntent` re-applies these to whichever
// forwarder is live. Reset to defaults on `resetKchatAuthService`
// because the ids/toggle are scoped to a single auth session.
let kchatWatchedChannelsIntent: string[] = [];
let kchatAutoCreateTasksIntent = false;
// Offline write-queue singleton. Holds `shareArtifact` /
// `ingestChannel` requests that were issued while the KChat
// server was unreachable and replays them FIFO on the next
// `connected` transition (subscription wired in
// `getKchatAuthService`). Lazily constructed alongside the auth
// service; the IPC layer registers the executors that actually
// perform the deferred work via `getKchatOfflineQueue().setExecutors`.
let kchatOfflineQueue: KchatOfflineQueue | null = null;
// localhost HTTP server the Tessera `.kcz`
// extension (running inside KChat Desktop) talks to. Lazily
// started by `startKchatLocalApiServer()` from the main-process
// `whenReady` chain and torn down by `stopKchatLocalApiServer()`
// from the `will-quit` chain (or by tests that need a fresh
// instance between cases). NOTE: this slot is intentionally NOT
// cleared by `resetKchatAuthService` — unlike the auth
// service's companion `KchatEventForwarder`, the local API
// server holds an active bound HTTP port and a synchronous
// `slot = null` would leak the listening socket. Tests that
// need a clean slate must call the async
// `stopKchatLocalApiServer()` explicitly.
let kchatLocalApiServer: KchatLocalApiServer | null = null;
// Pending-promise slot so concurrent `startKchatLocalApiServer()`
// calls coalesce onto a single `server.start()` rather than racing
// through the `kchatLocalApiServer === null` check and binding two
// HTTP ports.
let kchatLocalApiServerPending: Promise<KchatLocalApiServer> | null = null;
// Stopping-promise slot so a `startKchatLocalApiServer()` call that
// arrives while a `stopKchatLocalApiServer()` is in flight waits for
// the stop to fully complete before constructing a new server. Without
// this slot, the start's IIFE would race the stop's slot-clearing
// writes: the stop captures the start's pending promise, awaits it,
// reads `kchatLocalApiServer`, and clears the slot — but a concurrent
// new start that arrived AFTER the stop cleared the pending slot and
// BEFORE the stop cleared `kchatLocalApiServer` would observe an empty
// pending slot, construct its own server, and its IIFE would later
// write `kchatLocalApiServer = serverC`. The stop's subsequent slot
// clear then either wipes serverC (orphaning it — server still
// running, slot null, nobody can call `stop()` on it) or, depending
// on ordering, the start's IIFE overwrites the stop's null write
// (giving the caller back a server that the stop has already torn
// down).
//
// Symmetric with the start's pending slot: the start awaits the
// stopping slot if non-null, and the stop publishes its work into
// the stopping slot so concurrent stops also serialise.
let kchatLocalApiServerStopping: Promise<void> | null = null;
// `tessera://` deeplink router. Constructed
// eagerly at module load so a pre-ready `open-url` event from
// macOS can be parked before `whenReady` fires. The renderer
// installs the consumer once it boots.
const kchatDeeplinkBridge = new DeeplinkBridge();
let kchatDeeplinkTeardown: (() => void) | null = null;
// Block B Task 4 second-pass:
// the IPC handler populates this slot with the full-channel-sync
// closure that `runAddKchatChannel` powers, so the forwarder can
// schedule a re-sync when a `KchatAclRefreshOutcome::Regranted`
// outcome lands. Declared at module scope (not in
// `getKchatAuthService`) so the forwarder constructor below can
// pass a stable callback that reads the *current* impl at call
// time — supporting hot-reload + test reset patterns.
//
// The two-step wiring (forwarder constructed with `() =>
// kchatChannelResyncImpl?.(id)`, IPC registration calls
// `setKchatChannelResyncImpl(...)`) avoids the circular import
// that would result from `appState.ts` importing the IPC module
// directly (the IPC module already imports `getKchatAuthService`
// and `getBridge` from this file).
let kchatChannelResyncImpl:
  | ((channelId: string) => Promise<void>)
  | null = null;
export function setKchatChannelResyncImpl(
  next: ((channelId: string) => Promise<void>) | null,
): void {
  kchatChannelResyncImpl = next;
}
export function getKchatChannelResyncImpl():
  | ((channelId: string) => Promise<void>)
  | null {
  return kchatChannelResyncImpl;
}

// backfill orchestrator slot. The IPC
// handler populates this with the per-channel orchestrator
// (`runBackfillKchatChannel(id)`) that drives REST pagination
// via the channel-scoped lock. Lives in module-scope (not inside
// `getKchatAuthService`) so the renderer-facing IPC handler
// `sources:backfillKchatChannel` and any future automation hook
// (e.g. a scheduled background-sync sweep) can share the single
// dedup'd implementation without circular imports.
//
// Like the resync impl above, the slot is cleared by
// `resetKchatAuthService(null)` so a test that swaps out the
// auth service can't observe a stale impl.
let kchatBackfillImpl:
  | ((channelId: string) => Promise<KchatBackfillRunOutcome>)
  | null = null;
export function setKchatBackfillImpl(
  next:
    | ((channelId: string) => Promise<KchatBackfillRunOutcome>)
    | null,
): void {
  kchatBackfillImpl = next;
}
export function getKchatBackfillImpl():
  | ((channelId: string) => Promise<KchatBackfillRunOutcome>)
  | null {
  return kchatBackfillImpl;
}
// Vision sidecar runs the same `llama-server` binary as the text
// sidecar but on a separate port (8385) and with `--mmproj`
// appended so the multimodal projector is loaded alongside the
// language model. Lifecycle is on-demand — the IPC handler that
// answers vision requests warms it up on first use rather than at
// app boot, so a machine that never asks for a VLM never pays the
// memory cost. The 60 s idle-unload matches the text sidecar.
let visionSidecar: ModelSidecar | null = null;
// Diffusion sidecar (sd-server / stable-diffusion.cpp) is bigger
// still (~6 GB VRAM for FLUX.2-klein) and starts ONLY on explicit
// user action — the renderer's "Generate image" button — never at
// boot, never on app focus, never on speculative warm-up. The 30 s
// idle-unload reflects bursty user interaction (generate / edit /
// re-generate) typical of the image-gen workflow.
let diffusionSidecar: DiffusionSidecar | null = null;
// track the lifecycle of
// the lazy `./diffusionSidecar` module import so callers can
// distinguish three states that all looked identical when we only
// stored `diffusionSidecar: DiffusionSidecar | null`:
//
//   "unloaded"  — `initAppState()` has not been called yet (or the
//                 bridge failed to come up). The next `initAppState`
//                 call may transition this to "loading".
//   "loading"   — the dynamic `import("./diffusionSidecar")` is in
//                 flight. The IPC handler should report "Image
//                 generation is still warming up; retry in a moment"
//                 rather than the permanent-failure message.
//   "loaded"    — the constructor ran and `diffusionSidecar` is
//                 non-null. The handler should call `start()` to
//                 boot the underlying sd-server process.
//   "failed"    — the dynamic import threw. The sidecar will not
//                 self-recover this session; the user must restart
//                 the app to get image generation back. The handler
//                 surfaces that explicit instruction so users are
//                 not left wondering whether to keep retrying.
//
// We expose this through `getDiffusionSidecarState()` so the IPC
// layer can render the right error. The raw nullable accessor stays
// for the shutdown path which only cares "is there a process to
// stop?".
type DiffusionSidecarState =
  | "unloaded"
  | "loading"
  | "loaded"
  | "failed";
let diffusionSidecarState: DiffusionSidecarState = "unloaded";
let diffusionSidecarLoadError: Error | null = null;
// follow-up: track the in-flight
// `import("./diffusionSidecar")` promise so the shutdown path can
// await it before deciding whether the sidecar slot is null.
//
// Without this, `stopAllSidecars()` had a race window: if
// `handleWillQuit` fires while the dynamic import is still resolving,
// the function sees `diffusionSidecar === null` and skips the slot.
// The import then resolves, the constructor runs, and the resulting
// `DiffusionSidecar` instance is never stopped — orphaning any future
// `start()` call's sd-server process if the constructor ever grows a
// side-effect (port probing, binary extraction, file lock).
//
// The constructor is side-effect-free today (it only stores config),
// but waiting on the import promise is the architecturally correct
// fix: it closes the race regardless of what the constructor does in
// the future. The wait is bounded by `LOAD_AWAIT_TIMEOUT_MS` so a
// truly hung import does NOT block `app.quit()`; the process.exit
// SIGKILL fallback in `main.ts` is the final backstop.
let diffusionSidecarLoadPromise: Promise<void> | null = null;
const DIFFUSION_LOAD_AWAIT_TIMEOUT_MS = 2_000;

function resolveNativeAddon(): NativeBridge | null {
  // The compiled main bundle now lives at `dist-electron/electron/main.js`
  // (Workstream 1 sibling-rooted layout — see `tsconfig.electron.json`),
  // so `__dirname` at runtime is `<desktop>/dist-electron/electron/`.
  // The `__dirname`-relative fallbacks below compensate by going up
  // one more level than they did before; without this they'd resolve
  // inside `dist-electron/` itself (which never contains a sibling
  // `native/` directory) and degenerate into dead paths.
  const possiblePaths = [
    path.join(app.getAppPath(), "native", "tessera_bridge.node"),
    path.join(app.getAppPath(), "..", "native", "tessera_bridge.node"),
    path.join(__dirname, "..", "..", "native", "tessera_bridge.node"),
    // Sibling-of-main: build scripts that drop the .node binary next
    // to `main.js` end up at `dist-electron/electron/<binary>`.
    path.join(__dirname, "tessera_bridge.node"),
    // Legacy sibling-of-`dist-electron`: covers the historical layout
    // where main.js was at `dist-electron/main.js`.
    path.join(__dirname, "..", "tessera_bridge.node"),
  ];

  for (const addonPath of possiblePaths) {
    if (fs.existsSync(addonPath)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- sync require() is intentional: this addon is CommonJS and the existsSync probe above expects synchronous resolution of one of several candidate paths.
        return require(addonPath) as NativeBridge;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export async function initAppState(): Promise<boolean> {
  // Publish the resource profile to the in-process native addon before
  // it can build any thread pool. `tessera_sources` reads
  // `TESSERA_RESOURCE_MODE` once, when its extraction rayon pool is
  // first constructed (on the first bulk index), to size the pool
  // (lightweight = num_cpus/4, performance = num_cpus/2). Setting it
  // here — ahead of the first `sources:*` call — guarantees the addon
  // observes the persisted setting rather than the lightweight default.
  // A live toggle takes effect on next launch; the RSS watchdog is the
  // within-session lever (see `memoryWatchdog.ts`).
  try {
    // `?? "lightweight"` is belt-and-suspenders: the zod schema's
    // `.catch("lightweight")` already guarantees a valid value today, but
    // were that fallback ever dropped, `process.env.X = undefined` would
    // coerce to the literal string "undefined" — a silently wrong env var.
    // The fallback keeps the addon defaulting to the safe low-footprint
    // profile regardless.
    process.env.TESSERA_RESOURCE_MODE = loadConfig().resourceMode ?? "lightweight";
  } catch {
    process.env.TESSERA_RESOURCE_MODE = "lightweight";
  }

  bridge = resolveNativeAddon();
  if (!bridge) {
    console.warn(
      "[Tessera] Native bridge not found. Running in fallback mode.",
    );
    return false;
  }

  const userData = app.getPath("userData");
  const dbPath = path.join(userData, "tessera.db");
  const templateDir = path.join(app.getAppPath(), "templates");

  // Derive the SQLCipher key. Two-tier failure handling:
  //
  // - `EncryptionUnavailableError` means NEITHER `safeStorage` NOR
  //   the password-derived vault is available to wrap the cipher
  //   key. The boot contract is that the call sequence
  //   in `main.ts` runs `maybeInitPasswordVault()` BEFORE
  //   `initAppState()`, so by the time we reach this code the
  //   vault has either been unlocked (in which case
  //   `getOrCreateDbKeyAsync` uses it transparently to wrap the
  //   cipher key) or it's verifiably absent. Falling through to an
  //   unencrypted bridge is the right degradation path because the
  //   on-disk DB is either fresh or was previously opened
  //   unencrypted — there is no encrypted state to lose.
  //
  // - Any OTHER error from `getOrCreateDbKeyAsync` (zero-byte key
  //   file, wrong decrypted length, decrypt failure from a userData
  //   dir copied to a different machine, wrong vault password)
  //   means the user previously had encryption working and the key
  //   is now lost or corrupted. The on-disk DB is almost certainly
  //   encrypted, so we MUST NOT fall back to unencrypted mode —
  //   doing so would either fail noisily at the next `CREATE TABLE`
  //   or, in the corner case where the DB doesn't yet exist,
  //   silently regress to plaintext storage without the user
  //   realising. Refuse to bring up the bridge and surface the
  //   actionable recovery message (`db.key` corrupt → restore from
  //   backup or accept data loss).
  let dbKey: string | null = null;
  try {
    dbKey = await getOrCreateDbKeyAsync();
  } catch (keyErr) {
    if (keyErr instanceof EncryptionUnavailableError) {
      console.warn(
        "[Tessera] Database encryption unavailable — running in unencrypted mode.",
        keyErr.message,
      );
    } else {
      console.error(
        "[Tessera] Database key is unrecoverable. Refusing to bring up the bridge to avoid corrupting an existing encrypted database.",
        keyErr,
      );
      console.error(
        "[Tessera] Recovery: restore <userData>/db.key from backup, or delete both <userData>/db.key and <userData>/tessera.db to start fresh (data loss).",
      );
      bridge = null;
      return false;
    }
  }

  // Apply a previously-staged restore BEFORE the bridge opens the
  // database. A restore (single backup or bundle import) is never
  // applied to the live connection — it is staged as a
  // `*.pending-restore` sibling and swapped in here, at the one moment
  // the DB file is guaranteed closed. This makes restore crash-safe:
  // the swap is an atomic rename, so a crash mid-restore either leaves
  // the old DB intact (rename not yet done) or the new DB in place
  // (rename done) — never a half-written file. A swap failure must not
  // block boot; the staged file is left for the next attempt.
  try {
    const swapped = bridge.bridgeApplyPendingRestore(dbPath);
    if (swapped) {
      console.log("[Tessera] Applied staged database restore at startup.");
    }
  } catch (restoreErr) {
    console.error(
      "[Tessera] Failed to apply staged database restore; continuing with the existing database.",
      restoreErr,
    );
  }

  try {
    bridge.initBridge(dbPath, templateDir, dbKey);
    console.log(
      "[Tessera] Native bridge initialized:",
      dbPath,
      dbKey ? "(encrypted)" : "(UNENCRYPTED — keyring unavailable)",
    );
  } catch (err) {
    console.error("[Tessera] Failed to initialize native bridge:", err);
    bridge = null;
    return false;
  }

  // LW-1: the text (8384) and vision (8385) sidecars are NO LONGER
  // constructed here. Building them eagerly probed the filesystem
  // for the llama-server binary and armed idle-unload timers on
  // every boot, even for sessions that never generate. Construction
  // now happens lazily in `ensureModelSidecar()` / `ensureVisionSidecar()`
  // on the first `model:start` / vision request, where the binary
  // path is resolved and the persisted idle window is read fresh
  // (see `resolveSidecarIdleUnloadMs`). Flipping `sidecarsEnabled`
  // here — at the exact point construction used to happen, after the
  // bridge initialised — preserves the historical contract that the
  // accessors return `null` in fallback mode (bridge unavailable).
  sidecarsEnabled = true;

  // LW-1: the diffusion sidecar (8386) is also demand-loaded now. The
  // heavy `./diffusionSidecar` module graph (sd-server binary
  // resolution, tar extraction, stable-diffusion.cpp log parsing) and
  // the `DiffusionSidecar` object are NO LONGER built at boot — the
  // earlier behaviour kicked off `import("./diffusionSidecar")` here
  // on every launch even for the (vast majority of) sessions that
  // never generate an image. Construction now happens lazily in
  // `ensureDiffusionSidecar()` on the first "Generate image" action,
  // matching the text/vision accessors. The underlying `sd-server`
  // PROCESS still never auto-starts; `start()` runs only on explicit
  // user action. The slot stays `null` / state `"unloaded"` until
  // then, which `applyModelIdleTimeoutToSidecars` and
  // `stopAllSidecars` already handle (both skip a null slot).

  console.log(
    "[Tessera] Model sidecars armed (text=8384 vision=8385 diffusion=8386 demand-loaded)",
  );

  return true;
}

// `platform` is injectable for architectural parity with
// `resolveDiffusionBinary()` in `diffusionSidecar.ts` so the `.exe`-
// suffix decision can be pinned per-platform in future tests without
// mutating `process.platform`. Production callers pass no argument
// and get the live platform. Per Devin Review PR #59 pass 2
function resolveSidecarBinary(
  platform: NodeJS.Platform = process.platform,
): string {
  const ext = platform === "win32" ? ".exe" : "";
  const binaryName = `llama-server${ext}`;
  // electron-builder copies sidecars/llama-server/ into process.resourcesPath/sidecars/llama-server
  // for packaged builds. In dev we look relative to the repo root.
  // `__dirname` at runtime is `<desktop>/dist-electron/electron/` (see
  // the comment in `resolveNativeAddon` above), so the relative paths
  // below climb two extra levels to land at `<desktop>/` and
  // `<repo>/apps/` respectively — the `../../..` entry does NOT reach
  // the repo root, it reaches `apps/`, which is consistent with how the
  // earlier `../..` lookup behaved. Without the depth bump these would
  // silently resolve inside `dist-electron/`.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const possiblePaths = [
    resourcesPath &&
      path.join(resourcesPath, "sidecars", "llama-server", binaryName),
    path.join(app.getAppPath(), "sidecars", "llama-server", binaryName),
    path.join(app.getAppPath(), "..", "sidecars", "llama-server", binaryName),
    // `<desktop>/sidecars/...` (was previously the first `__dirname` entry).
    path.join(__dirname, "..", "..", "sidecars", "llama-server", binaryName),
    // `<repo>/apps/sidecars/...` (was previously the second entry — kept
    // for backwards compat even though the directory is not at the
    // canonical repo-root `sidecars/` location).
    path.join(
      __dirname,
      "..",
      "..",
      "..",
      "sidecars",
      "llama-server",
      binaryName,
    ),
  ].filter((p): p is string => typeof p === "string");
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return binaryName;
}

export function getBridge(): NativeBridge | null {
  return bridge;
}

export function isBridgeAvailable(): boolean {
  return bridge !== null;
}

/**
 * Non-constructing peek at the text sidecar slot. Returns `null`
 * until `ensureModelSidecar()` has lazily built it (or in fallback
 * mode where the bridge never came up). Hot, frequently-polled paths
 * — `model:status` (5 s renderer poll), `model:stop`, the idle-timer
 * apply loop, and the mutual-exclusion enforcer — MUST use this peek
 * so a status poll never triggers construction of a sidecar the user
 * never asked for (which would defeat LW-1's demand-loading).
 */
export function getModelSidecar(): ModelSidecar | null {
  return modelSidecar;
}

/**
 * Resolve the idle-unload window (milliseconds) for a freshly
 * constructed sidecar from the persisted `modelIdleTimeoutSecs`
 * setting, run through the shared normaliser so the lazy-construction
 * path cannot drift from the runtime `applyModelIdleTimeoutToSidecars`
 * path. Read fresh on every construction so a `settings:update` that
 * landed before first use is honoured without an extra apply call.
 */
function resolveSidecarIdleUnloadMs(): number {
  return normalizeModelIdleTimeoutSecsToMs(loadConfig().modelIdleTimeoutSecs);
}

/**
 * Demand-load accessor for the text sidecar (LW-1). Constructs the
 * `ModelSidecar` on first call — resolving the llama-server binary
 * and reading the persisted idle window at that point, not at boot —
 * and memoises it in the module slot. Returns `null` in fallback mode
 * (bridge unavailable) so `model:start` surfaces the same
 * "Model sidecar not initialized" error as before. Use this from the
 * construct-and-start path (`model:start`); use `getModelSidecar()`
 * everywhere else.
 */
export function ensureModelSidecar(): ModelSidecar | null {
  if (!sidecarsEnabled) return null;
  if (modelSidecar === null) {
    modelSidecar = new ModelSidecar({
      binaryPath: resolveSidecarBinary(),
      port: 8384,
      label: "text",
      idleUnloadMs: resolveSidecarIdleUnloadMs(),
    });
    console.log("[Tessera] Text sidecar constructed on demand (port 8384)");
  }
  return modelSidecar;
}

/**
 * Demand-load accessor for the vision sidecar (LW-1). Mirrors
 * `ensureModelSidecar()`. `modelPath` / `extraArgs` are intentionally
 * left unset here — `ensureVisionSidecarRunning()` in `ipc/vision.ts`
 * populates them from the installed vision record (which carries
 * `path` + `mmprojPath`) before calling `start()`; constructing with
 * no model would be fine, starting without one would throw.
 */
export function ensureVisionSidecar(): ModelSidecar | null {
  if (!sidecarsEnabled) return null;
  if (visionSidecar === null) {
    visionSidecar = new ModelSidecar({
      binaryPath: resolveSidecarBinary(),
      port: 8385,
      label: "vision",
      idleUnloadMs: resolveSidecarIdleUnloadMs(),
    });
    console.log("[Tessera] Vision sidecar constructed on demand (port 8385)");
  }
  return visionSidecar;
}

/** A local model sidecar slot subject to single-sidecar exclusion. */
export type SidecarKind = "text" | "vision" | "diffusion";

/**
 * Enforce single-sidecar mutual exclusion (LW-2) before starting the
 * `starting` sidecar. In `"lightweight"` resource mode (the default)
 * only one of text / vision / diffusion may run at a time, so this
 * stops whichever OTHER sidecars are currently running. In
 * `"performance"` mode this is a no-op and the historical concurrent
 * text + vision behaviour is preserved.
 *
 * Construction is deliberately avoided: this reads the raw module
 * slots (not the `ensure*` accessors) and only acts on slots that are
 * both constructed AND running, so checking exclusivity never spins
 * up a sidecar. Diffusion mid-lazy-load has no running process, so
 * there is nothing to wait on or stop in that window.
 *
 * Stops are best-effort and run concurrently — a stop failure on one
 * sidecar is logged but must not block starting the requested one.
 */
export async function enforceSidecarExclusivity(
  starting: SidecarKind,
): Promise<void> {
  await stopOtherSidecarsForExclusivity(
    starting,
    loadConfig().resourceMode,
    [
      { kind: "text", sidecar: modelSidecar },
      { kind: "vision", sidecar: visionSidecar },
      { kind: "diffusion", sidecar: diffusionSidecar },
    ],
  );
}

/**
 * Pure decision + stop helper behind [`enforceSidecarExclusivity`].
 * Takes the resource `mode` and an explicit `slots` list so tests can
 * drive the single-sidecar policy without spawning real sidecar
 * processes (the production wrapper reads `loadConfig().resourceMode`
 * and the module-private slots). Mirrors the `stopSidecarsList`
 * split used by `stopAllSidecars`.
 *
 * In `"performance"` mode this is a no-op (concurrent sidecars
 * allowed). In `"lightweight"` mode it stops every slot that is NOT
 * the one being started AND is currently running. Stops are
 * best-effort and concurrent; a failure is logged but never blocks
 * starting the requested sidecar.
 *
 * Exported for `__tests__/resourceMode.test.ts`. Production code
 * should call `enforceSidecarExclusivity()` instead.
 */
export async function stopOtherSidecarsForExclusivity(
  starting: SidecarKind,
  mode: ResourceMode,
  slots: Array<{
    kind: SidecarKind;
    sidecar: { isRunning: boolean; stop(): Promise<void> } | null;
  }>,
): Promise<void> {
  if (mode !== "lightweight") return;
  await Promise.all(
    slots
      .filter(
        (e): e is {
          kind: SidecarKind;
          sidecar: { isRunning: boolean; stop(): Promise<void> };
        } => e.kind !== starting && e.sidecar !== null && e.sidecar.isRunning,
      )
      .map((e) =>
        e.sidecar.stop().catch((err) => {
          console.error(
            `[Tessera] Failed to stop ${e.kind} sidecar for single-sidecar exclusion (starting ${starting}):`,
            err,
          );
        }),
      ),
  );
}

/**
 * Vision sidecar accessor. Returns `null` when the native bridge
 * isn't initialised (fallback mode) or when initialisation was
 * skipped — the caller is responsible for warming it up on demand
 * once a vision request is made. The lifecycle contract is:
 *   1. The vision IPC handler reads the current vision slot's
 *      `InstalledModelRecord` (via `getCurrentModel(_, "vision")`).
 *   2. If no record, surface "no vision model installed" to the
 *      renderer and DO NOT call `setModelPath` (start() would
 *      throw).
 *   3. If a record exists, call `setModelPath(record.path)` and
 *      `setExtraArgs(["--mmproj", record.mmprojPath, ...])` then
 *      `start()`. For low-tier (`tier === "low"`) hosts, also append
 *      `--parallel 1` to halve the KV-cache budget.
 *   4. Idle-unload is automatic after 60 s; the next vision request
 *      re-runs steps 1-3.
 */
export function getVisionSidecar(): ModelSidecar | null {
  return visionSidecar;
}

/**
 * Diffusion sidecar accessor. Same null-on-fallback contract as
 * `getVisionSidecar`, but with a stricter on-demand contract: the
 * sidecar must NEVER be started until the user explicitly clicks
 * "Generate image" in the InfographicEditor / LandingPageEditor.
 * Auto-starting would burn ~6 GB of VRAM at app boot on any host
 * that has an imagegen model installed, which would brick the
 * machine for anyone running other GPU workloads (gaming, CUDA
 * compute, video editing).
 */
export function getDiffusionSidecar(): DiffusionSidecar | null {
  return diffusionSidecar;
}

/**
 * Demand-load accessor for the diffusion sidecar (LW-1 parity with
 * `ensureModelSidecar()` / `ensureVisionSidecar()`). The heavy
 * `./diffusionSidecar` module graph (sd-server binary resolution, tar
 * extraction, stable-diffusion.cpp log parsing) and the
 * `DiffusionSidecar` object are built here on first use — typically the
 * user's first "Generate image" action — rather than at boot. The
 * underlying `sd-server` PROCESS is still NEVER auto-started; only the
 * explicit imagegen path calls `start()` after this resolves.
 *
 * Lifecycle / re-entrancy (mirrors the boot-time contract this
 * replaced, so `getDiffusionSidecarState()` and `ipc/imagegen.ts`
 * behave identically):
 *   - Fallback mode (bridge unavailable, `sidecarsEnabled === false`):
 *     returns `null`, state stays `"unloaded"` — same as the
 *     text/vision accessors.
 *   - Already constructed: returns the memoised slot.
 *   - Load failed earlier this session (`state === "failed"`): returns
 *     `null` without retrying. A failed import is permanent for the
 *     session; the IPC layer surfaces an actionable "restart the app"
 *     message via `getDiffusionSidecarState()`.
 *   - Load already in flight: awaits the SAME
 *     `diffusionSidecarLoadPromise` instead of kicking off a second
 *     `import()`, so two near-simultaneous generations coalesce onto
 *     one load. (Single-threaded main process: no microtask runs
 *     between the null-check and the await, so the promise reference is
 *     stable.)
 *
 * `stopAllSidecars()` still awaits `diffusionSidecarLoadPromise` (with
 * a bounded timeout) so a generation that triggered the load during
 * shutdown is observed before the slot is torn down.
 */
export async function ensureDiffusionSidecar(): Promise<DiffusionSidecar | null> {
  if (!sidecarsEnabled) return null;
  if (diffusionSidecar !== null) return diffusionSidecar;
  if (diffusionSidecarState === "failed") return null;
  if (diffusionSidecarLoadPromise === null) {
    diffusionSidecarState = "loading";
    diffusionSidecarLoadError = null;
    // Retain the promise so `stopAllSidecars()` can await it (bounded)
    // and observe the resolved sidecar before deciding whether to stop
    // it. Cleared in the terminal `.finally()` so a stale reference
    // doesn't keep the module record alive after the load settles.
    diffusionSidecarLoadPromise = import("./diffusionSidecar")
      .then(({ DiffusionSidecar, resolveDiffusionBinary }) => {
        diffusionSidecar = new DiffusionSidecar({
          binaryPath: resolveDiffusionBinary(
            app.getAppPath(),
            __dirname,
            (process as NodeJS.Process & { resourcesPath?: string })
              .resourcesPath,
          ),
          port: 8386,
          label: "diffusion",
          // Read the persisted idle window when the lazy load settles
          // (rather than capturing a boot-time value) so a
          // `settings:update` that landed earlier is reflected here.
          // The next `applyModelIdleTimeoutToSidecars` sees the same
          // value and short-circuits the no-op diff.
          idleUnloadMs: normalizeModelIdleTimeoutSecsToMs(
            loadConfig().modelIdleTimeoutSecs,
          ),
        });
        diffusionSidecarState = "loaded";
        console.log(
          "[Tessera] Diffusion sidecar constructed on demand (port 8386)",
        );
      })
      .catch((err: unknown) => {
        // Mark the slot permanently failed for this session. The IPC
        // handler reads this state and surfaces an actionable "restart
        // the app" message rather than the generic "not initialised"
        // one that would leave the user wondering whether to retry.
        diffusionSidecarState = "failed";
        diffusionSidecarLoadError =
          err instanceof Error ? err : new Error(String(err));
        console.warn(
          "[Tessera] Diffusion sidecar lazy-load failed; image generation will be unavailable until next launch:",
          diffusionSidecarLoadError.message,
        );
      })
      .finally(() => {
        diffusionSidecarLoadPromise = null;
      });
  }
  await diffusionSidecarLoadPromise;
  return diffusionSidecar;
}

/**
 * push the user's idle-unload window in
 * seconds to every live sidecar. Called from
 * `electron/ipc/settings.ts` after a successful `settings:update`
 * that mutates `modelIdleTimeoutSecs` so the new window takes
 * effect immediately for any currently-running model — no relaunch
 * required.
 *
 * Semantics:
 *   - `idleTimeoutSecs === 0` disables idle unloading entirely
 *     ("Keep loaded forever"). `setIdleUnloadMs(0)` is the
 *     documented sentinel; the sidecar's `startIdleMonitor`
 *     short-circuits without arming the timer.
 *   - Positive seconds are multiplied by 1000 and passed straight
 *     through. The sidecar floors the value and ignores a no-op
 *     diff (same value as the currently stored one), so calling
 *     this on every `settings:update` (even ones where the user
 *     re-saved the same value) is cheap.
 *   - Each sidecar slot may be `null` at call time:
 *       - `modelSidecar` / `visionSidecar` are `null` until their
 *         demand-load accessor (`ensureModelSidecar()` /
 *         `ensureVisionSidecar()`) has constructed them on first use
 *         (LW-1), or permanently in fallback mode (bridge unavailable),
 *         where they are never constructed. A `settings:update` that
 *         lands before first use is not lost: each accessor reads the
 *         persisted `modelIdleTimeoutSecs` (via
 *         `resolveSidecarIdleUnloadMs()`) at construction time.
 *       - `diffusionSidecar` is `null` until the lazy-load
 *         `import("./diffusionSidecar")` resolves. The lazy-load
 *         constructor reads the persisted value again so a settings
 *         change that happens during the window between
 *         `initAppState` and the lazy-load completing is not lost.
 *   - Errors thrown by any sidecar's `setIdleUnloadMs` are caught
 *     and logged per-sidecar so a partial failure (e.g. the
 *     diffusion sidecar in a weird state) does not block the
 *     text/vision sidecars from picking up the new window.
 */
/**
 * single normaliser for converting
 * the user-facing `modelIdleTimeoutSecs` setting into the
 * milliseconds value that every sidecar's `idleUnloadMs` field
 * stores. Centralising the rounding/clamp in one helper means the
 * boot path (`initAppState` constructor calls) and the runtime
 * path (`applyModelIdleTimeoutToSidecars` → `setIdleUnloadMs`)
 * cannot drift apart — any future schema bypass (e.g. a test that
 * stubs `loadConfig()` and forgets `.int().min(0)`) still produces
 * a non-negative integer milliseconds value at the sidecar
 * boundary.
 *
 * The `Math.max(0, …)` floor matches `sidecar.ts:setIdleUnloadMs`,
 * which clamps incoming values on its own; this helper exists so
 * the call site cannot construct a sidecar with an out-of-contract
 * `idleUnloadMs` in the first place (defense-in-depth, not a
 * functional change against today's schema-validated values).
 */
export function normalizeModelIdleTimeoutSecsToMs(
  idleTimeoutSecs: number,
): number {
  if (!Number.isFinite(idleTimeoutSecs)) return 0;
  return Math.max(0, Math.floor(idleTimeoutSecs)) * 1000;
}

export function applyModelIdleTimeoutToSidecars(
  idleTimeoutSecs: number,
): void {
  const idleUnloadMs = normalizeModelIdleTimeoutSecsToMs(idleTimeoutSecs);
  const sidecars: Array<{ name: string; sidecar: { setIdleUnloadMs: (ms: number) => void } | null }> = [
    { name: "text", sidecar: modelSidecar },
    { name: "vision", sidecar: visionSidecar },
    { name: "diffusion", sidecar: diffusionSidecar },
  ];
  for (const { name, sidecar } of sidecars) {
    if (!sidecar) continue;
    try {
      sidecar.setIdleUnloadMs(idleUnloadMs);
    } catch (err) {
      console.warn(
        `[Tessera] Failed to apply idle timeout (${idleUnloadMs} ms) to ${name} sidecar:`,
        err,
      );
    }
  }
}

/**
 * expose the lazy-load
 * lifecycle of the diffusion sidecar module so IPC handlers can
 * report the right error to the renderer.
 *
 * Returns `{ state, error }` where `state` is one of
 * `unloaded | loading | loaded | failed` and `error` is the
 * exception that caused a `failed` transition (so the handler can
 * surface its `.message` without exposing the stack to the UI).
 *
 * Tests injecting fixture state can use `__resetDiffusionSidecarStateForTests`
 * (test-only, lives at the bottom of this file).
 */
export function getDiffusionSidecarState(): {
  state: DiffusionSidecarState;
  error: Error | null;
} {
  return { state: diffusionSidecarState, error: diffusionSidecarLoadError };
}

/**
 * Lazy accessor for the singleton KChat auth service. First call
 * constructs a `KchatAuthService` (which in turn constructs a
 * `KchatClient`); subsequent calls return the same instance. Tests
 * that want a fresh instance can call {@link resetKchatAuthService}
 * between cases.
 */
export function getKchatAuthService(): KchatAuthService {
  if (!kchatAuthService) {
    kchatAuthService = new KchatAuthService();
    // Lazily construct + start the WS forwarder alongside the
    // auth service. The forwarder must outlive every individual
    // `connect` / `disconnect` cycle because the underlying
    // `KchatClient` is reused — `KchatClient` re-attaches its
    // own listeners (the WS event multicast set) on every
    // connect, so the forwarder's single subscription stays
    // valid across reconnects. Starting once at construction
    // also means a renderer that opens before any KChat
    // connect still has the IPC channel listener installed
    // when the user finally connects.
    kchatEventForwarder = new KchatEventForwarder({
      getBridge,
      // Block B Task 4 second-pass Devin Review: thread the regrant auto-resync hook
      // through the forwarder. The actual impl is populated by
      // `registerKchatIpcHandlers` in `ipc/kchat.ts`; we wrap it
      // in a closure that re-reads the slot at call time so a
      // forwarder constructed BEFORE IPC handlers register (e.g.
      // in cold-start sequence) still picks up the real impl
      // when the user later triggers a regrant.
      scheduleChannelResync: async (channelId) => {
        const fn = getKchatChannelResyncImpl();
        if (!fn) return;
        await fn(channelId);
      },
    });
    kchatEventForwarder.start(kchatAuthService.getClient());
    // Honour any watch list / auto-create toggle the renderer sent
    // before this lazy construction (the IPC handler stored the
    // intent at module scope).
    applyKchatForwarderIntent();

    // Replay any persisted offline write-queue when the connection
    // comes back. The subscription lives here (not in the IPC
    // layer) because the auth service outlives every connect /
    // disconnect cycle, so a single listener installed at
    // construction time fires on every future reconnect. The
    // executors are registered by the IPC layer; if a `connected`
    // transition arrives before they are wired, `replay()` finds no
    // executor and leaves the operations queued for the next tick.
    const queue = getKchatOfflineQueue();
    kchatAuthService.onStatusChange((state) => {
      if (state.state === "connected") {
        void queue.replay().catch((err) => {
          console.error("[kchat] offline-queue replay failed:", err);
        });
      }
    });
  }
  return kchatAuthService;
}

/**
 * Accessor for the singleton KChat offline write-queue. Lazily
 * constructed on first access. The IPC layer registers executors
 * on it and enqueues `shareArtifact` / `ingestChannel` requests
 * that hit an offline error; the {@link getKchatAuthService}
 * status subscription drains it on reconnect.
 */
export function getKchatOfflineQueue(): KchatOfflineQueue {
  if (!kchatOfflineQueue) {
    kchatOfflineQueue = new KchatOfflineQueue();
  }
  return kchatOfflineQueue;
}

/**
 * Accessor for the singleton KChat WebSocket event forwarder.
 * Returns `null` if {@link getKchatAuthService} has not yet
 * been called (the forwarder is lazy-constructed alongside the
 * auth service). Exposed so tests can introspect the
 * forwarder's per-window ring buffer state and so a future
 * Settings diagnostics surface can render dropped-event counts.
 */
export function getKchatEventForwarder(): KchatEventForwarder | null {
  return kchatEventForwarder;
}

/**
 * Re-apply the persisted watch list + auto-create toggle to the
 * live forwarder. Called at every forwarder construction site so a
 * toggle the renderer sent before the forwarder existed (or before
 * the most recent `resetKchatAuthService`) is honoured rather than
 * silently dropped. No-op when no forwarder is live.
 */
function applyKchatForwarderIntent(): void {
  if (!kchatEventForwarder) return;
  kchatEventForwarder.setWatchedChannels(kchatWatchedChannelsIntent);
  kchatEventForwarder.setAutoCreateTasks(kchatAutoCreateTasksIntent);
}

/**
 * Session 8 Task 3: record the renderer's watched-channel set and
 * push it to the live forwarder. The intent is stored at module
 * scope (see {@link applyKchatForwarderIntent}) so it survives a
 * forwarder that is constructed or reconstructed later. The IPC
 * handler validates/sanitises ids before calling this.
 */
export function setKchatWatchedChannels(channelIds: readonly string[]): void {
  // Dedupe at the boundary so the stored intent matches what the
  // forwarder actually watches (it also dedupes via `new Set`), rather
  // than carrying redundant ids that are re-deduped on every
  // `applyKchatForwarderIntent()`.
  kchatWatchedChannelsIntent = [...new Set(channelIds)];
  kchatEventForwarder?.setWatchedChannels(kchatWatchedChannelsIntent);
}

/**
 * Session 8 Task 6: record the renderer's inbound task auto-create
 * toggle and push it to the live forwarder. Persisted at module
 * scope so it is honoured even when toggled before the forwarder
 * exists or after a later reconnect reconstructs it.
 */
export function setKchatAutoCreateTasks(enabled: boolean): void {
  kchatAutoCreateTasksIntent = enabled;
  kchatEventForwarder?.setAutoCreateTasks(enabled);
}

/**
 * Accessor for the singleton localhost API server used by the
 * Tessera `.kcz` extension installed in KChat Desktop. Returns
 * `null` until {@link startKchatLocalApiServer} has been called
 * from the main-process `whenReady` chain.
 */
export function getKchatLocalApiServer(): KchatLocalApiServer | null {
  return kchatLocalApiServer;
}

/**
 * Start the localhost API server. Idempotent and concurrency-safe
 * against:
 *
 * 1. **Concurrent starts** — The first caller drives `server.start()`, and
 *      any concurrent callers that arrive while that `start()` is
 *      in-flight coalesce onto the same promise instead of racing
 *      through the null-check and binding a second port.
 *
 * 2. **Stop-during-in-flight-start** — handled by
 *      `stopKchatLocalApiServer()`: it captures and awaits the
 *      pending start before clearing `kchatLocalApiServer`.
 *
 * 3. **Start-during-in-flight-stop** — handled here: if a stop is in
 *      flight we await `kchatLocalApiServerStopping` BEFORE entering the
 *      pending-promise branch, so the stop fully tears down the
 *      previous server (and clears `kchatLocalApiServer`) before
 *      we construct a new one. Without this wait, a new start's
 *      IIFE would race the in-flight stop's slot writes — the new
 *      server could land in the slot mid-stop and be silently torn
 *      down by the stop's `kchatLocalApiServer = null` write, or
 *      worse, the start's IIFE could clobber the stop's null write
 *      and hand the caller a server the stop has already closed.
 *      Re-checking idempotency after the await is load-bearing:
 *      the stop's predecessor start may have left a live server in
 *      the slot.
 *
 * Sequential calls after the first succeeds return the cached
 * instance synchronously.
 *
 * Called once from the main-process `whenReady` chain in
 * `main.ts`; the pending-promise / stopping-promise slots are
 * defence-in-depth so a future second call site doesn't silently
 * leak an HTTP server.
 *
 * The `handlers` argument is supplied by the caller (the IPC
 * registration layer) so this module stays decoupled from the
 * Tessera source / artifact subsystems. The default-handlers
 * factory below is a thin glue layer over `getKchatAuthService`
 * plus the Rust bridge.
 */
export async function startKchatLocalApiServer(
  userDataDir: string,
  handlers: LocalApiHandlers,
): Promise<KchatLocalApiServer> {
  if (kchatLocalApiServer !== null) return kchatLocalApiServer;
  // Drain any in-flight stop FIRST, so we never construct a new
  // server whose slot-write races the stop's slot-clearing writes.
  // The `while` (rather than `if`) tolerates a chain of overlapping
  // stops: each iteration awaits the most recently published
  // stopping promise, and we re-read the slot to pick up any newer
  // stop that the previous await raced against. The catch swallows
  // the stop's rejection because the stop's responsibility for
  // teardown is complete by the time it rejects — we just need to
  // know it has stopped writing to `kchatLocalApiServer`.
  while (kchatLocalApiServerStopping !== null) {
    const stopping = kchatLocalApiServerStopping;
    try {
      await stopping;
    } catch {
      // The stop's failure is the caller's problem to surface;
      // here we only care that it has finished touching the slot.
    }
    // Re-check after the await: a stop's predecessor start may
    // have left a live server in the slot that we should reuse.
    if (kchatLocalApiServer !== null) return kchatLocalApiServer;
  }
  if (kchatLocalApiServerPending !== null) return kchatLocalApiServerPending;
  kchatLocalApiServerPending = (async () => {
    const server = new KchatLocalApiServer(handlers, {
      userDataDir,
    });
    await server.start();
    kchatLocalApiServer = server;
    return server;
  })();
  try {
    return await kchatLocalApiServerPending;
  } finally {
    kchatLocalApiServerPending = null;
  }
}

/**
 * Stop the localhost API server and remove the port-file. Called
 * from `app.on("will-quit", ...)` in `main.ts`.
 *
 * The actual teardown work runs inside an IIFE published into
 * `kchatLocalApiServerStopping` so a concurrent
 * `startKchatLocalApiServer()` can await it before constructing a
 * new server
 * Concurrent stops also serialise via the same slot.
 */
export async function stopKchatLocalApiServer(): Promise<void> {
  // Serialise concurrent stops. The second stop must wait for the
  // first to complete before checking the slot — otherwise the
  // second stop could observe a still-running server that the
  // first stop is about to tear down, double-call `stop()`, and
  // double-unlink the port file (the port-file unlink is
  // idempotent today via `rmSync({ force: true })`, but the
  // server's `close()` is not — calling it twice raises
  // ERR_SERVER_NOT_RUNNING on the second invocation).
  while (kchatLocalApiServerStopping !== null) {
    const stopping = kchatLocalApiServerStopping;
    try {
      await stopping;
    } catch {
      // A prior stop rejected; we don't propagate its failure
      // because the caller asked us to stop, and the prior stop
      // has done its part of the teardown.
    }
  }
  const work = (async (): Promise<void> => {
    // Capture and clear the pending-promise slot FIRST. If a
    // `startKchatLocalApiServer()` IIFE is still in flight, we
    // MUST wait for it to settle before checking
    // `kchatLocalApiServer` — otherwise the IIFE will complete
    // `await server.start()` and write `kchatLocalApiServer =
    // server` AFTER this function returns, leaving an orphaned
    // running HTTP server that nobody will ever call `stop()` on
    // (it would hold an event-loop handle and a bound port for
    // the rest of the process lifetime).
    // Clearing the slot before the await is intentional: a third
    // concurrent caller arriving while we're inside this await
    // must NOT join the same start (we're about to tear it down)
    // — it observes an empty pending slot, observes the non-null
    // stopping slot we publish below, and awaits the teardown
    // before constructing a fresh server.
    const pending = kchatLocalApiServerPending;
    kchatLocalApiServerPending = null;
    if (pending !== null) {
      try {
        await pending;
      } catch {
        // The in-flight start rejected. The IIFE's failure path
        // is responsible for tearing down its own bound socket
        // via the rollback in `KchatLocalApiServer.start()`.
        // `kchatLocalApiServer` will be null when we fall through,
        // so this branch is a no-op.
      }
    }
    if (kchatLocalApiServer === null) return;
    const server = kchatLocalApiServer;
    kchatLocalApiServer = null;
    await server.stop();
  })();
  // Publish the work into the stopping slot BEFORE awaiting it
  // so a concurrent start that's already past its idempotency
  // check can see it. The slot is cleared in `finally` only if
  // it still points at OUR work — a subsequent stop may have
  // replaced it (its `while` loop awaited us first), and we
  // must not stomp the newer slot value.
  kchatLocalApiServerStopping = work;
  try {
    await work;
  } finally {
    if (kchatLocalApiServerStopping === work) {
      kchatLocalApiServerStopping = null;
    }
  }
}

/**
 * Accessor for the singleton `tessera://` deeplink router.
 * Always returns a live bridge — instantiated at module load so
 * a pre-ready `open-url` event can be parked.
 */
export function getKchatDeeplinkBridge(): DeeplinkBridge {
  return kchatDeeplinkBridge;
}

/**
 * Attach the deeplink bridge to Electron app events. Idempotent;
 * called from the main-process boot sequence after IPC
 * registration so the consumer is already wired.
 */
export function attachKchatDeeplinkBridge(): void {
  if (kchatDeeplinkTeardown !== null) return;
  kchatDeeplinkTeardown = attachDeeplinkEvents(kchatDeeplinkBridge, app);
}

/**
 * Detach the deeplink bridge listeners. Used by tests + by the
 * `will-quit` handler so a re-launched main process does not
 * stack listeners.
 */
export function detachKchatDeeplinkBridge(): void {
  if (kchatDeeplinkTeardown === null) return;
  const fn = kchatDeeplinkTeardown;
  kchatDeeplinkTeardown = null;
  fn();
}

/**
 * Build a `LocalApiHandlers` adapter wired into the live KChat
 * auth service. This is the production glue between the
 * localhost API server and the rest of Tessera's main process.
 * The artifact-share and ingest paths surface typed `LocalApiError`
 * envelopes so failures are mapped to the right HTTP status.
 *
 * The handlers intentionally do NOT mint new tokens or write to
 * the vault — they reuse the existing PAT session managed by
 * {@link KchatAuthService}. If the user is disconnected, every
 * call returns `tessera_unavailable` until the user reconnects.
 */
export function buildLocalApiHandlers(): LocalApiHandlers {
  const tesseraVersion = app.getVersion();
  return {
    async status(): Promise<LocalApiStatus> {
      const svc = getKchatAuthService();
      const state = svc.getState();
      return {
        tesseraVersion,
        connected: state.state === "connected",
        serverUrl: state.serverUrl ?? null,
        // The localhost API surface intentionally does not enumerate
        // sources here; `listSources` does that. Surface a 0 / null
        // so the wire-format stays stable when sources are wired in
        // later phases.
        indexedChannelCount: 0,
        lastEventAt: state.lastHealthyAt ?? null,
        capabilities: LOCAL_API_CAPABILITIES,
      };
    },
    async listSources(): Promise<readonly TesseraKchatSourceRow[]> {
      const fn = localApiSourcesProvider;
      if (fn === null) {
        throw new LocalApiError(
          503,
          "tessera_unavailable",
          "Tessera sources provider not registered yet",
        );
      }
      return fn();
    },
    async ingestChannel(
      req: IngestChannelRequest,
    ): Promise<IngestChannelResponse> {
      const fn = localApiIngestChannelHandler;
      if (fn === null) {
        throw new LocalApiError(
          503,
          "tessera_unavailable",
          "Tessera ingest handler not registered yet",
        );
      }
      return fn(req);
    },
    async shareArtifact(
      req: ShareArtifactRequest,
    ): Promise<ShareArtifactResponse> {
      const fn = localApiShareArtifactHandler;
      if (fn === null) {
        throw new LocalApiError(
          503,
          "tessera_unavailable",
          "Tessera share-artifact handler not registered yet",
        );
      }
      return fn(req);
    },
  };
}

// Provider slots populated by the IPC registration layer so the
// local API server doesn't import the source / artifact modules
// directly (avoiding a layering cycle).
let localApiSourcesProvider:
  | (() => Promise<readonly TesseraKchatSourceRow[]>)
  | null = null;
let localApiIngestChannelHandler:
  | ((req: IngestChannelRequest) => Promise<IngestChannelResponse>)
  | null = null;
let localApiShareArtifactHandler:
  | ((req: ShareArtifactRequest) => Promise<ShareArtifactResponse>)
  | null = null;

export function setLocalApiSourcesProvider(
  fn:
    | (() => Promise<readonly TesseraKchatSourceRow[]>)
    | null,
): void {
  localApiSourcesProvider = fn;
}

export function setLocalApiIngestChannelHandler(
  fn:
    | ((req: IngestChannelRequest) => Promise<IngestChannelResponse>)
    | null,
): void {
  localApiIngestChannelHandler = fn;
}

export function setLocalApiShareArtifactHandler(
  fn:
    | ((req: ShareArtifactRequest) => Promise<ShareArtifactResponse>)
    | null,
): void {
  localApiShareArtifactHandler = fn;
}

/**
 * Replace (or clear) the singleton KChat auth service AND the
 * companion WebSocket forwarder. Used by tests to inject a
 * stub or a fresh instance between cases. Disposing the
 * forwarder here ensures a leftover IPC listener from a
 * previous test cannot leak into the next test's renderer.
 *
 * When `next` is non-null we ALSO construct a fresh forwarder
 * and bind it to the new service's client. This preserves the
 * "the forwarder is always live alongside an active auth
 * service" invariant — without it, a caller that injects a
 * non-null replacement would observe the auth service start
 * with no WS forwarding (silent regression). Devin Review
 * (first pass on PR #43) called this out as a
 * latent issue; fixed by re-creating the forwarder here.
 * Tests that want a stub forwarder still have the escape hatch
 * of calling {@link resetKchatEventForwarder} afterwards to
 * swap the production forwarder for one with a fake
 * `listWindows`.
 */
export function resetKchatAuthService(
  next: KchatAuthService | null = null,
): void {
  if (kchatEventForwarder) {
    kchatEventForwarder.dispose();
    kchatEventForwarder = null;
  }
  // A reset means a new auth session (token change / re-login, or a
  // test swapping the service). The watch list + auto-create toggle
  // are scoped to the previous session — channel ids and the toggle
  // from the old account must not leak into the new one — so reset
  // the persisted intent to defaults. The renderer re-applies its
  // own intent after the next `connected` transition.
  kchatWatchedChannelsIntent = [];
  kchatAutoCreateTasksIntent = false;
  // Drop the offline-queue singleton so a test that swaps the auth
  // service starts from a clean in-memory queue (and re-registers
  // executors against the new service). The on-disk file is left
  // untouched — the next queue reads it back on first `load()`.
  kchatOfflineQueue = null;
  // Block B Task 4 third-pass:
  // clear the regrant-resync slot alongside the forwarder so the
  // module-level lifecycle invariants stay coherent. The previous
  // impl captures `runAddKchatChannel` which itself closes over
  // `getKchatAuthService()`; if a test calls
  // `resetKchatAuthService(null)` and a stale slot survived, a
  // subsequent direct call into the slot would deref a null auth
  // service. The forwarder disposal above prevents the live event
  // path from triggering this, but the slot is also reachable via
  // `getKchatChannelResyncImpl()` for tests that drive it manually,
  // so we close the gap defensively here. The production IPC
  // handler's `registerKchatHandlers` re-populates the slot at the
  // next startup; tests that need a fresh impl can repopulate via
  // `setKchatChannelResyncImpl` after the reset.
  setKchatChannelResyncImpl(null);
  // clear the backfill orchestrator
  // slot alongside the resync slot for the same reason — the
  // closure captures `getBridge()` / `getKchatAuthService()`,
  // and a test that calls `resetKchatAuthService(null)` should
  // never observe an impl that closes over a torn-down service.
  setKchatBackfillImpl(null);
  // The three local-API provider slots (`localApiSourcesProvider`,
  // `localApiIngestChannelHandler`,
  // `localApiShareArtifactHandler`) are reachable from the
  // localhost API server via `buildLocalApiHandlers()`. When the
  // future IPC registration layer wires them up, the supplied
  // closures will capture `getKchatAuthService()` / `getBridge()`
  // just like the resync and backfill impls above — so the same
  // "stale closure surviving a `resetKchatAuthService(null)` could
  // deref a torn-down service" hazard applies. Clearing the slots
  // here pre-emptively means the future wiring PR doesn't have to
  // remember to update this reset path; the local API server's
  // null-checks already map "slot is null" to a 503
  // `tessera_unavailable` envelope, which is the correct
  // post-reset behaviour in tests.
  setLocalApiSourcesProvider(null);
  setLocalApiIngestChannelHandler(null);
  setLocalApiShareArtifactHandler(null);
  kchatAuthService = next;
  if (next) {
    kchatEventForwarder = new KchatEventForwarder({
      getBridge,
      scheduleChannelResync: async (channelId) => {
        const fn = getKchatChannelResyncImpl();
        if (!fn) return;
        await fn(channelId);
      },
    });
    kchatEventForwarder.start(next.getClient());
    // Re-apply the (just-reset) intent so the new forwarder starts
    // from a coherent baseline and is ready to honour the renderer's
    // next toggle.
    applyKchatForwarderIntent();
  }
}

/**
 * Replace (or clear) the singleton KChat WebSocket forwarder.
 * Exposed for the tests in `__tests__/kchatEventForwarder.test.ts`
 * which need to inject a forwarder with a stub `listWindows`
 * enumerator. Production code should never call this.
 */
export function resetKchatEventForwarder(
  next: KchatEventForwarder | null = null,
): void {
  if (kchatEventForwarder && kchatEventForwarder !== next) {
    kchatEventForwarder.dispose();
  }
  kchatEventForwarder = next;
}

/**
 * Graceful shutdown for every initialised sidecar. Called from
 * `main.ts`'s `will-quit` handler so an orderly app exit delivers
 * SIGTERM (with the 5 s SIGKILL fallback inside each sidecar's
 * `stop()`) instead of relying on the synchronous `process.on("exit")`
 * SIGKILL handler each sidecar installs as a last-resort orphan
 * guard.
 *
 * Stops are best-effort: a stop failure on one sidecar must not
 * prevent the others from being torn down, and must not block app
 * exit — the process.on("exit") SIGKILL fallback is there exactly
 * for the case where this graceful path doesn't complete in time.
 * Errors are logged so an audit can tell graceful vs. forced
 * shutdowns apart.
 */
export async function stopAllSidecars(): Promise<void> {
  // If the diffusion sidecar's dynamic import is still in flight,
  // wait for it (bounded) so we observe the resolved sidecar slot
  // before deciding whether to stop it. See the comment on
  // `diffusionSidecarLoadPromise` for the race-window rationale.
  await awaitDiffusionLoadOrTimeout(DIFFUSION_LOAD_AWAIT_TIMEOUT_MS);
  await stopSidecarsList([
    { label: "text", sidecar: modelSidecar },
    { label: "vision", sidecar: visionSidecar },
    { label: "diffusion", sidecar: diffusionSidecar },
  ]);
}

/**
 * Internal helper used by [`stopAllSidecars`] (and exported only
 * for the lazy-load-race test). Returns when either the in-flight
 * `import("./diffusionSidecar")` settles OR `timeoutMs` elapses.
 * Settled means the constructor ran (or the import threw) and
 * `diffusionSidecar` is now in its final shutdown-visible state.
 * The timeout is the safety belt: a truly hung import must not
 * block `app.quit()`.
 */
export async function awaitDiffusionLoadOrTimeout(
  timeoutMs: number,
): Promise<void> {
  const pending = diffusionSidecarLoadPromise;
  if (pending === null) return;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutP = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(resolve, timeoutMs);
    if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();
  });
  await Promise.race([pending, timeoutP]);
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
}

/**
 * Pure helper for [`stopAllSidecars`]. Takes an explicit list so
 * tests can inject fakes (the production function reads from
 * module-private state). Each task swallows its sidecar's error
 * and logs it — so a hung or throwing sidecar must NOT block the
 * others from being stopped, and must NOT bubble an error up to
 * the `will-quit` handler (which would otherwise block
 * `app.quit()`).
 *
 * Exported for the test in `__tests__/stopAllSidecars.test.ts`.
 * Production code should call `stopAllSidecars()` instead.
 */
export async function stopSidecarsList(
  entries: Array<{
    label: string;
    sidecar: { stop(): Promise<void> } | null;
  }>,
): Promise<void> {
  await Promise.all(
    entries
      .filter((e): e is { label: string; sidecar: { stop(): Promise<void> } } =>
        e.sidecar !== null,
      )
      .map((e) =>
        e.sidecar.stop().catch((err) => {
          console.error(`[tessera] ${e.label} sidecar stop failed:`, err);
        }),
      ),
  );
}
