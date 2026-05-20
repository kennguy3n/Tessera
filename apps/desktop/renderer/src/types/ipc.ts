export interface SourceApi {
  addLocalFolder: (path: string) => Promise<SourceInfo>;
  addLocalFile: (path: string) => Promise<SourceInfo>;
  listSources: () => Promise<SourceInfo[]>;
  removeSource: (id: string) => Promise<void>;
  searchSources: (query: string, limit: number) => Promise<SearchHit[]>;
  getDetail: (id: string) => Promise<SourceDetailInfo>;
  reindex: (id: string) => Promise<SourceInfo>;
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
  ) => Promise<string>;
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
  }) => Promise<string>;
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
}

export interface SettingsApi {
  get: () => Promise<SettingsData>;
  update: (settings: Partial<SettingsData>) => Promise<SettingsData>;
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

export interface TesseraApi {
  sources: SourceApi;
  artifacts: ArtifactApi;
  templates: TemplateApi;
  citations: CitationApi;
  settings: SettingsApi;
  model: ModelApi;
  runtime: RuntimeApi;
  connectors: ConnectorApi;
  dialog: DialogApi;
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
