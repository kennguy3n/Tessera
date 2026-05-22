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

export interface SettingsData {
  theme: string;
  defaultExportFormat: string;
  ignorePatterns: string[];
  watchPatterns: string[];
}

// -----------------------------------------------------------------
// External provider configuration
// -----------------------------------------------------------------

export type ExternalProviderType = "openai_compatible" | "anthropic" | "custom";

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

export type TaskStatus = "todo" | "in_progress" | "done" | "blocked";
export type TaskPriority = "low" | "medium" | "high" | "critical";

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
}

export interface ExternalProviderApi {
  get: () => Promise<ExternalProviderConfigView>;
  set: (
    provider: ExternalProviderConfigInput,
    apiKey: string | null,
  ) => Promise<ExternalProviderConfigView>;
  test: () => Promise<ExternalProviderTestResult>;
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
