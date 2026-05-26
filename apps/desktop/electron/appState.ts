import { app } from "electron";
import * as path from "path";
import * as fs from "fs";
import { ModelSidecar } from "./sidecar";
import { DiffusionSidecar, resolveDiffusionBinary } from "./diffusionSidecar";
import { KchatAuthService } from "./kchat/kchatAuth";
import { KchatEventForwarder } from "./kchat/kchatEventForwarder";
import { getOrCreateDbKeyAsync, EncryptionUnavailableError } from "./dbKey";
import type {
  AddCitationRequest,
  ArtifactInfo,
  ArtifactVersionInfo,
  AutomationInfo,
  BackfillEmbeddingsResult,
  CitationInfo,
  CompareSourcesResult,
  EmbeddingProgressInfo,
  ExportResult,
  HybridSearchConfigInfo,
  HybridSearchConfigUpdate,
  IndexingProgressInfo,
  KchatAclMemberInfo,
  KchatAclRefreshOutcomeInfo,
  KchatChannelAddOutcomeInfo,
  KchatFileIndexOutcomeInfo,
  KchatRevokeOutcomeInfo,
  ReplaceCitationRequest,
  ReplaceCitationResult,
  SearchHitInfo,
  SourceDetailInfo,
  SourceInfo,
  TaskInfo,
  TemplateInfo,
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
  KchatRevokeOutcomeInfo,
  ReplaceCitationRequest,
  ReplaceCitationResult,
  SearchHit,
  SearchHitInfo,
  SourceDetailInfo,
  SourceInfo,
  TaskInfo,
  TemplateInfo,
  ThemeInfo,
} from "../shared/types";

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
   * source row (Block B Task 3, Phase 11). Called by
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
   * Explicitly revoke a KChat-channel source (Block B Task 3,
   * Phase 11). Used for `channel_archived` / `channel_deleted` /
   * self-`user_removed` events where there is no roster to fetch.
   * The ACL roster is left intact for forensics — "who else had
   * access at the moment of revocation" is a real question
   * operators ask.
   */
  bridgeRevokeKchatSource(cacheDir: string): KchatRevokeOutcomeInfo;
  /**
   * Set the locally-authenticated KChat principal user id on the
   * substrate (Block B Task 3, Phase 11). Called by the
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
   * every `bridgeRefreshKchatAcl` call (Block B Task 3, Phase
   * 11). Member ids / roles are NOT logged — only the roster
   * size and the projection outcome (`granted` / `regranted` /
   * `revoked` / `unlinked` / `no_principal`) so operators can
   * see the ACL decision in the audit trail without re-querying
   * the substrate.
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
   * `SourceStatus::AccessRevoked` (Block B Task 3, Phase 11).
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
   * triggers the substrate's inline cryptoshred (Block B Task 4,
   * Phase 11). Emitted on every revoke outcome — fresh revoke +
   * already-revoked re-shred path + refresh-driven revoke — so
   * the audit trail correlates the `KchatChannelAccessRevoked`
   * status-transition row with the actual evidence-scrub counts.
   *
   * `reason` matches the sibling
   * `bridgeLogKchatChannelAccessRevoked` short code;
   * `chunksDropped` / `filesDropped` are the substrate counts
   * surfaced via `KchatRevokeOutcomeInfo` /
   * `KchatAclRefreshOutcomeInfo`.
   *
   * `fsScrubSucceeded` / `fsScrubError` are the Node-side
   * filesystem-scrub outcomes from `secureDeleteChannelArtifacts`
   * (third-pass Devin Review observability fix on PR #46). The
   * substrate counts only describe the database scrub; the
   * filesystem holds downloaded plaintext until the cache dir +
   * manifest sidecar are removed. Operators grep
   * `fs_scrub_succeeded=false` in the audit log to find revokes
   * whose on-disk plaintext survived the scrub.
   *
   * `vacuumSucceeded` / `vacuumError` are the substrate's Phase 5
   * `VACUUM` outcomes, forwarded through the bridge revoke /
   * refresh outcome structs (fifth-pass Devin Review fix,
   * ANALYSIS_pr-review-job-ef3c7d6c..._0001). A `false` value is
   * NOT a scrub failure — the row-level DELETE + UPDATE already
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
    fsScrubSucceeded: boolean,
    fsScrubError: string | undefined,
    vacuumSucceeded: boolean,
    vacuumError: string | undefined,
  ): void;
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
}

let bridge: NativeBridge | null = null;
let modelSidecar: ModelSidecar | null = null;
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
// Block B Task 4 (Phase 11) second-pass Devin Review ANALYSIS_0002:
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
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(addonPath) as NativeBridge;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export async function initAppState(): Promise<boolean> {
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

  modelSidecar = new ModelSidecar({
    binaryPath: resolveSidecarBinary(),
    port: 8384,
    label: "text",
  });
  // Vision sidecar reuses the same llama-server binary but binds a
  // distinct port so it can run concurrently with the text sidecar
  // — concurrent text + vision is a real workflow (the artifact
  // generator pulls VLM descriptions of source images while the
  // text generator is mid-stream).
  //
  // `modelPath` and `extraArgs` are unset here intentionally; the
  // vision IPC handler populates both from the installed vision
  // record (which carries `path` + `mmprojPath`) before calling
  // `start()`. Starting now without a model would throw.
  visionSidecar = new ModelSidecar({
    binaryPath: resolveSidecarBinary(),
    port: 8385,
    label: "vision",
  });
  diffusionSidecar = new DiffusionSidecar({
    binaryPath: resolveDiffusionBinary(
      app.getAppPath(),
      __dirname,
      (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
    ),
    port: 8386,
    label: "diffusion",
  });
  console.log(
    "[Tessera] Model sidecars configured (text=8384 vision=8385 diffusion=8386)",
  );

  return true;
}

function resolveSidecarBinary(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
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

export function getModelSidecar(): ModelSidecar | null {
  return modelSidecar;
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
      // Block B Task 4 (Phase 11) second-pass Devin Review
      // ANALYSIS_0002: thread the regrant auto-resync hook
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
  }
  return kchatAuthService;
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
 * ANALYSIS_0003 (first pass on PR #43) called this out as a
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
  // Block B Task 4 (Phase 11) third-pass Devin Review ANALYSIS_0006:
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
  await stopSidecarsList([
    { label: "text", sidecar: modelSidecar },
    { label: "vision", sidecar: visionSidecar },
    { label: "diffusion", sidecar: diffusionSidecar },
  ]);
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
