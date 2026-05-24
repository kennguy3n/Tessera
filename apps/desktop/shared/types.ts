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
 * - `ok: false, kind: "unsupported"`: the configured provider does
 *   not expose a models endpoint (Anthropic). The renderer should
 *   gracefully degrade to the manual text input.
 * - `ok: false, kind: "error", error: string`: network or HTTP
 *   error. The renderer should surface the message and keep the
 *   manual text input.
 */
export type ExternalProviderListModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; kind: "unsupported" }
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
 * "List models" without first hitting Save. Devin Review round 12
 * ANALYSIS_002 flagged the gap: previously the handler gated on
 * the PERSISTED `enabled` flag, so a fresh-enable + List would
 * fail with "External provider is disabled" even though the form
 * the user is looking at clearly intends the provider to be on.
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
}

export interface InstalledModelRecord {
  modelId: string;
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
  downloadedAt: string;
}

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
  ) => Promise<ArtifactInfo>;
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
  recommendModel: () => Promise<ResolvedModel | null>;
  listModels: () => Promise<ResolvedModel[]>;
  getCurrentModel: () => Promise<InstalledModelRecord | null>;
  planDownload: (modelId: string) => Promise<DownloadPlan>;
  /**
   * Handles both fresh-install and swap (delete-then-fetch). There is
   * intentionally no separate `swapModel` channel.
   */
  downloadModel: (modelId: string) => Promise<InstalledModelRecord>;
  deleteModel: () => Promise<void>;
  onDownloadProgress: (
    callback: (p: ModelDownloadProgress) => void,
  ) => () => void;
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
   * Provider-agnostic sync (Phase 10). Used for OneDrive / Notion /
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
}

/**
 * Auto-update integration (Phase 10). The renderer never talks to
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
  connectors: ConnectorApi;
  tasks: TaskApi;
  automations: AutomationApi;
  dialog: DialogApi;
  updates: UpdatesApi;
}
