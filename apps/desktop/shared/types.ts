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
  /** Fifth-pass Devin Review fix: see
   *  {@link KchatAclRefreshOutcomeInfo.vacuumSucceeded}. */
  vacuumSucceeded: boolean;
  /** Fifth-pass Devin Review fix: see
   *  {@link KchatAclRefreshOutcomeInfo.vacuumError}. */
  vacuumError?: string;
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
  name: string;
  size: number;
  mime_type: string;
  extension: string;
  create_at: number;
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
