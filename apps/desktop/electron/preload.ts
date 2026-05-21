import { contextBridge, ipcRenderer } from "electron";

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

// Mirrors `ExtractedItem` in apps/desktop/renderer/src/types/ipc.ts and
// the local copy in apps/desktop/electron/ipc.ts. We duplicate the shape
// here so the preload's `extractTasksDecisions` signature is sound across
// the contextBridge without forcing preload (main-side, Electron) to
// import from the renderer module (which would pull React-aware build
// settings into the main process). Any change to the schema must be made
// in all three locations.
export interface ExtractedItem {
  itemType: "task" | "decision";
  text: string;
  sourceCitation: string;
  confidence: number;
}

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
  // Records persisted before `diskSizeMb` was added (or by an older
  // build) won't have this field — read via `effectiveDiskSizeMb`
  // from `modelManagement.ts` to fall back to `downloadSizeMb`.
  // Kept optional here so the type matches the on-disk wire shape
  // and the canonical declaration in `modelManagement.ts`.
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

export interface ExportResult {
  content: string;
  format: string;
}

export interface ArtifactVersionInfo {
  version: number;
  content: string;
  createdAt: string;
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

export interface ConnectorStatusInfo {
  provider: string;
  connected: boolean;
  status: string;
}

export interface TesseraApi {
  sources: {
    addLocalFolder: (path: string) => Promise<SourceInfo>;
    addLocalFile: (path: string) => Promise<SourceInfo>;
    listSources: () => Promise<SourceInfo[]>;
    removeSource: (id: string) => Promise<void>;
    searchSources: (query: string, limit: number) => Promise<SearchHit[]>;
    getDetail: (id: string) => Promise<SourceDetailInfo>;
    reindex: (id: string) => Promise<SourceInfo>;
  };
  artifacts: {
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
  };
  templates: {
    list: () => Promise<TemplateInfo[]>;
    get: (id: string) => Promise<TemplateInfo | null>;
  };
  citations: {
    list: (artifactId: string) => Promise<CitationInfo[]>;
    add: (req: AddCitationRequest) => Promise<CitationInfo>;
    remove: (artifactId: string, citationId: string) => Promise<void>;
    checkChanged: (citationId: string) => Promise<boolean>;
  };
  settings: {
    get: () => Promise<SettingsData>;
    update: (settings: Partial<SettingsData>) => Promise<SettingsData>;
  };
  model: {
    status: () => Promise<ModelStatus>;
    start: (modelPath: string) => Promise<void>;
    stop: () => Promise<void>;
    generate: (request: unknown) => Promise<void>;
    cancelJob: () => Promise<void>;
    onToken: (callback: (chunk: unknown) => void) => () => void;
  };
  runtime: {
    detectPlatform: () => Promise<PlatformInfo>;
    recommendModel: () => Promise<ResolvedModel | null>;
    listModels: () => Promise<ResolvedModel[]>;
    getCurrentModel: () => Promise<InstalledModelRecord | null>;
    planDownload: (modelId: string) => Promise<DownloadPlan>;
    downloadModel: (modelId: string) => Promise<InstalledModelRecord>;
    deleteModel: () => Promise<void>;
    onDownloadProgress: (callback: (p: ModelDownloadProgress) => void) => () => void;
  };
  connectors: {
    authenticate: (provider: string, clientId: string, clientSecret: string) => Promise<ConnectorStatusInfo>;
    disconnect: (provider: string) => Promise<ConnectorStatusInfo>;
    status: (provider: string) => Promise<ConnectorStatusInfo>;
    listDriveFiles: (folderId?: string, pageToken?: string) => Promise<{ nextPageToken: string | null; files: ConnectorFileInfo[] }>;
    selectItems: (items: Array<{ id: string; name: string; mimeType: string }>) => Promise<Array<{ id: string; name: string; mimeType: string; selected: boolean }>>;
    syncDrive: (selectedFileIds?: string[]) => Promise<{ added: number; modified: number; removed: number; status: string }>;
  };
  tasks: {
    create: (req: CreateTaskRequest) => Promise<TaskInfo>;
    list: () => Promise<TaskInfo[]>;
    get: (id: string) => Promise<TaskInfo | null>;
    update: (id: string, req: UpdateTaskRequest) => Promise<TaskInfo>;
    remove: (id: string) => Promise<boolean>;
    reorder: (status: string, ids: string[]) => Promise<void>;
  };
  automations: {
    create: (req: CreateAutomationRequest) => Promise<AutomationInfo>;
    list: () => Promise<AutomationInfo[]>;
    get: (id: string) => Promise<AutomationInfo | null>;
    setEnabled: (id: string, enabled: boolean) => Promise<void>;
    remove: (id: string) => Promise<boolean>;
    schedulerStatus: () => Promise<SchedulerStatusInfo>;
    runNow: () => Promise<SchedulerStatusInfo>;
  };
  dialog: {
    showSaveDialog: (options: SaveDialogOptions) => Promise<SaveDialogResult>;
  };
}

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
   * tessera_bridge::tasks::UpdateTaskRequest.
   */
  assignee?: string | null;
  /** Same tri-state semantics as `assignee`. The bridge surfaces a
   *  parse error if a non-empty string isn't valid RFC 3339 — see
   *  the `update_task_with_invalid_due_date_does_not_clear_existing`
   *  regression test. */
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

export interface SchedulerStatusInfo {
  running: boolean;
  lastTickAt: string | null;
  lastTickError: string | null;
  inFlight: boolean;
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

const api: TesseraApi = {
  sources: {
    addLocalFolder: (folderPath: string) =>
      ipcRenderer.invoke("sources:addLocalFolder", folderPath),
    addLocalFile: (filePath: string) =>
      ipcRenderer.invoke("sources:addLocalFile", filePath),
    listSources: () => ipcRenderer.invoke("sources:list"),
    removeSource: (id: string) => ipcRenderer.invoke("sources:remove", id),
    searchSources: (query: string, limit: number) =>
      ipcRenderer.invoke("sources:search", query, limit),
    getDetail: (id: string) => ipcRenderer.invoke("sources:getDetail", id),
    reindex: (id: string) => ipcRenderer.invoke("sources:reindex", id),
  },
  artifacts: {
    create: (title: string, artifactType: string, templateId?: string) =>
      ipcRenderer.invoke("artifacts:create", title, artifactType, templateId),
    update: (id: string, content: string) =>
      ipcRenderer.invoke("artifacts:update", id, content),
    list: () => ipcRenderer.invoke("artifacts:list"),
    get: (id: string) => ipcRenderer.invoke("artifacts:get", id),
    remove: (id: string) => ipcRenderer.invoke("artifacts:remove", id),
    exportArtifact: (
      id: string,
      format: string,
      contentOverride?: string | null,
    ) =>
      ipcRenderer.invoke(
        "artifacts:export",
        id,
        format,
        contentOverride ?? null,
      ),
    exportToFile: (
      id: string,
      format: string,
      filePath: string,
      contentOverride?: string | null,
    ) =>
      ipcRenderer.invoke(
        "artifacts:exportToFile",
        id,
        format,
        filePath,
        contentOverride ?? null,
      ),
    listVersions: (id: string) =>
      ipcRenderer.invoke("artifacts:listVersions", id),
    restoreVersion: (id: string, versionNumber: number) =>
      ipcRenderer.invoke("artifacts:restoreVersion", id, versionNumber),
    generateFromTemplate: (templateId: string, sourceIds: string[]) =>
      ipcRenderer.invoke("artifacts:generateFromTemplate", templateId, sourceIds),
    extractTasksDecisions: (sourceId: string) =>
      ipcRenderer.invoke("artifacts:extractTasksDecisions", sourceId),
    compareSources: (sourceIdA: string, sourceIdB: string) =>
      ipcRenderer.invoke("artifacts:compareSources", sourceIdA, sourceIdB),
    exportEvidencePack: (artifactId: string, outputPath: string) =>
      ipcRenderer.invoke("artifacts:exportEvidencePack", artifactId, outputPath),
    exportMarp: (req) => ipcRenderer.invoke("artifacts:exportMarp", req),
    exportTypst: (req) => ipcRenderer.invoke("artifacts:exportTypst", req),
  },
  templates: {
    list: () => ipcRenderer.invoke("templates:list"),
    get: (id: string) => ipcRenderer.invoke("templates:get", id),
  },
  citations: {
    list: (artifactId: string) =>
      ipcRenderer.invoke("citations:list", artifactId),
    add: (req: AddCitationRequest) => ipcRenderer.invoke("citations:add", req),
    remove: (artifactId: string, citationId: string) =>
      ipcRenderer.invoke("citations:remove", artifactId, citationId),
    checkChanged: (citationId: string) =>
      ipcRenderer.invoke("citations:checkChanged", citationId),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    update: (settings: Partial<SettingsData>) =>
      ipcRenderer.invoke("settings:update", settings),
  },
  model: {
    status: () => ipcRenderer.invoke("model:status"),
    start: (modelPath: string) => ipcRenderer.invoke("model:start", modelPath),
    stop: () => ipcRenderer.invoke("model:stop"),
    generate: (request: unknown) => ipcRenderer.invoke("model:generate", request),
    cancelJob: () => ipcRenderer.invoke("model:cancelJob"),
    onToken: (callback: (chunk: unknown) => void) => {
      const listener = (_event: unknown, chunk: unknown) => callback(chunk);
      ipcRenderer.on("model:token", listener as never);
      return () => { ipcRenderer.removeListener("model:token", listener as never); };
    },
  },
  runtime: {
    detectPlatform: () => ipcRenderer.invoke("runtime:detectPlatform"),
    recommendModel: () => ipcRenderer.invoke("runtime:recommendModel"),
    listModels: () => ipcRenderer.invoke("runtime:listModels"),
    getCurrentModel: () => ipcRenderer.invoke("runtime:getCurrentModel"),
    planDownload: (modelId: string) =>
      ipcRenderer.invoke("runtime:planDownload", modelId),
    // `downloadModel` handles both fresh-install and swap (delete-then-
    // fetch). There is intentionally no separate `swapModel` channel —
    // see Devin Review finding 3270524691.
    downloadModel: (modelId: string) =>
      ipcRenderer.invoke("runtime:downloadModel", modelId),
    deleteModel: () => ipcRenderer.invoke("runtime:deleteModel"),
    onDownloadProgress: (callback: (p: ModelDownloadProgress) => void) => {
      const listener = (_event: unknown, p: ModelDownloadProgress) => callback(p);
      ipcRenderer.on("runtime:downloadProgress", listener as never);
      return () => {
        ipcRenderer.removeListener("runtime:downloadProgress", listener as never);
      };
    },
  },
  connectors: {
    authenticate: (provider: string, clientId: string, clientSecret: string) =>
      ipcRenderer.invoke("connectors:authenticate", provider, clientId, clientSecret),
    disconnect: (provider: string) =>
      ipcRenderer.invoke("connectors:disconnect", provider),
    status: (provider: string) =>
      ipcRenderer.invoke("connectors:status", provider),
    listDriveFiles: (folderId?: string, pageToken?: string) =>
      ipcRenderer.invoke("connectors:gdrive:listFiles", folderId, pageToken),
    selectItems: (items: Array<{ id: string; name: string; mimeType: string }>) =>
      ipcRenderer.invoke("connectors:gdrive:selectItems", items),
    syncDrive: (selectedFileIds?: string[]) =>
      ipcRenderer.invoke("connectors:gdrive:sync", selectedFileIds),
  },
  tasks: {
    create: (req) => ipcRenderer.invoke("tasks:create", req),
    list: () => ipcRenderer.invoke("tasks:list"),
    get: (id) => ipcRenderer.invoke("tasks:get", id),
    update: (id, req) => ipcRenderer.invoke("tasks:update", id, req),
    remove: (id) => ipcRenderer.invoke("tasks:delete", id),
    reorder: (status, ids) => ipcRenderer.invoke("tasks:reorder", status, ids),
  },
  automations: {
    create: (req) => ipcRenderer.invoke("automations:create", req),
    list: () => ipcRenderer.invoke("automations:list"),
    get: (id) => ipcRenderer.invoke("automations:get", id),
    setEnabled: (id, enabled) =>
      ipcRenderer.invoke("automations:setEnabled", id, enabled),
    remove: (id) => ipcRenderer.invoke("automations:delete", id),
    schedulerStatus: () => ipcRenderer.invoke("automations:schedulerStatus"),
    runNow: () => ipcRenderer.invoke("automations:runNow"),
  },
  dialog: {
    showSaveDialog: (options: SaveDialogOptions) =>
      ipcRenderer.invoke("dialog:showSaveDialog", options),
  },
};

contextBridge.exposeInMainWorld("tessera", api);
