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
  generateFromTemplate: (templateId: string, sourceIds: string[]) => Promise<ArtifactInfo>;
  extractTasksDecisions: (sourceId: string) => Promise<ExtractedItem[]>;
  compareSources: (sourceIdA: string, sourceIdB: string) => Promise<ArtifactInfo>;
  exportEvidencePack: (artifactId: string, outputPath: string) => Promise<string>;
  exportMarp: (req: {
    markdown: string;
    format: "pdf" | "pptx" | "html";
    outputPath: string;
    theme?: string;
    includeNotes?: boolean;
    allowHtml?: boolean;
  }) => Promise<string | null>;
  exportTypst: (req: {
    markup: string;
    format: "pdf" | "svg";
    outputPath?: string;
  }) => Promise<{ outputPath: string; bytes: number }>;
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

export interface SettingsApi {
  get: () => Promise<SettingsData>;
  update: (settings: Partial<SettingsData>) => Promise<SettingsData>;
}

export type ExternalProviderType =
  | "openai_compatible"
  | "anthropic"
  | "custom";

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

export interface ExternalProviderConfigView
  extends ExternalProviderConfigInput {
  hasApiKey: boolean;
}

export type ExternalProviderTestResult =
  | { ok: true; latencyMs: number }
  | { ok: false; error: string };

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
  // Optional to match the on-disk wire shape: records persisted before
  // `diskSizeMb` was added by older builds won't have this field. Read
  // via the `effectiveDiskSizeMb` helper in the electron module to fall
  // back to `downloadSizeMb` for those legacy records.
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

export interface RuntimeApi {
  detectPlatform: () => Promise<PlatformInfo>;
  recommendModel: () => Promise<ResolvedModel | null>;
  listModels: () => Promise<ResolvedModel[]>;
  getCurrentModel: () => Promise<InstalledModelRecord | null>;
  planDownload: (modelId: string) => Promise<DownloadPlan>;
  // `downloadModel` handles both fresh-install and swap (delete-then-fetch).
  // There is intentionally no separate `swapModel` channel.
  downloadModel: (modelId: string) => Promise<InstalledModelRecord>;
  deleteModel: () => Promise<void>;
  onDownloadProgress: (callback: (p: ModelDownloadProgress) => void) => () => void;
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
   * sync wrapper returns. See Devin Review wave 15 ANALYSIS_0007.
   */
  offline?: boolean;
}

export interface DriveSyncResult {
  added: number;
  modified: number;
  removed: number;
  status: string;
}

export interface ConnectorApi {
  authenticate: (provider: string, clientId: string, clientSecret: string) => Promise<ConnectorStatusInfo>;
  disconnect: (provider: string) => Promise<ConnectorStatusInfo>;
  status: (provider: string) => Promise<ConnectorStatusInfo>;
  listDriveFiles: (folderId?: string, pageToken?: string) => Promise<DriveFileListResult>;
  selectItems: (items: Array<{ id: string; name: string; mimeType: string }>) => Promise<Array<{ id: string; name: string; mimeType: string; selected: boolean }>>;
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
   * carrying any per-provider hardcoded fallback. See Devin Review
   * wave 20 ANALYSIS: "ConnectorsList hardcodes fallback redirectUri
   * values that must sync with providerOAuth.ts config".
   */
  getAllRedirectUris: () => Promise<Record<string, string>>;
}

export interface DialogApi {
  showSaveDialog: (options: SaveDialogOptions) => Promise<SaveDialogResult>;
}

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

export interface TaskApi {
  create: (req: CreateTaskRequest) => Promise<TaskInfo>;
  list: () => Promise<TaskInfo[]>;
  get: (id: string) => Promise<TaskInfo | null>;
  update: (id: string, req: UpdateTaskRequest) => Promise<TaskInfo>;
  remove: (id: string) => Promise<boolean>;
  reorder: (status: string, ids: string[]) => Promise<void>;
}

export interface SchedulerStatus {
  running: boolean;
  lastTickAt: string | null;
  lastTickError: string | null;
  inFlight: boolean;
}

export interface AutomationApi {
  create: (req: CreateAutomationRequest) => Promise<AutomationInfo>;
  list: () => Promise<AutomationInfo[]>;
  get: (id: string) => Promise<AutomationInfo | null>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  remove: (id: string) => Promise<boolean>;
  schedulerStatus: () => Promise<SchedulerStatus>;
  runNow: () => Promise<SchedulerStatus>;
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
  connectors: ConnectorApi;
  tasks: TaskApi;
  automations: AutomationApi;
  dialog: DialogApi;
}

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
  // Tri-state: `undefined` = unchanged, `null` = explicit clear,
  // string = set. See tessera_bridge::tasks::UpdateTaskRequest.
  assignee?: string | null;
  dueDate?: string | null;
}

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
  triggerJson: string;
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

export interface SourceInfo {
  id: string;
  sourceType: string;
  path: string;
  status: string;
  createdAt: string;
  lastIndexed: string | null;
  fileCount: number;
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

export interface SearchHit {
  sourcePath: string;
  sourceId: string;
  chunkHash: string;
  chunkContent: string;
  relevanceScore: number;
  excerpt: string;
}

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

export interface TemplateInfo {
  id: string;
  name: string;
  artifactType: string;
  description: string;
  sectionCount: number;
  exportFormats: string[];
}

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

export interface SettingsData {
  theme: string;
  defaultExportFormat: string;
  ignorePatterns: string[];
  watchPatterns: string[];
}

export interface ModelStatus {
  available: boolean;
  modelName: string | null;
  status: string;
}

export interface ExportResult {
  content: string;
  format: string;
}

export interface ArtifactVersionInfo {
  version: number;
  content: string;
  createdAt: string;
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

export interface ExtractedItem {
  itemType: "task" | "decision";
  text: string;
  sourceCitation: string;
  confidence: number;
}

export interface ConnectorStatusInfo {
  provider: string;
  connected: boolean;
  status: string;
}

export interface ConnectorFileInfo {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  modifiedTime: string | null;
  isFolder: boolean;
  parentId: string | null;
}

declare global {
  interface Window {
    tessera: TesseraApi;
  }
}
