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
    exportArtifact: (id: string, format: string) => Promise<ExportResult>;
    exportToFile: (
      id: string,
      format: string,
      filePath: string,
    ) => Promise<void>;
    listVersions: (id: string) => Promise<ArtifactVersionInfo[]>;
    restoreVersion: (id: string, versionNumber: number) => Promise<ArtifactInfo>;
    generateFromTemplate: (templateId: string, sourceIds: string[]) => Promise<ArtifactInfo>;
    extractTasksDecisions: (sourceId: string) => Promise<unknown>;
    compareSources: (sourceIdA: string, sourceIdB: string) => Promise<ArtifactInfo>;
    exportEvidencePack: (artifactId: string, outputPath: string) => Promise<string>;
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
  connectors: {
    authenticate: (provider: string, clientId: string, clientSecret: string) => Promise<ConnectorStatusInfo>;
    disconnect: (provider: string) => Promise<ConnectorStatusInfo>;
    status: (provider: string) => Promise<ConnectorStatusInfo>;
    listDriveFiles: (folderId?: string, pageToken?: string) => Promise<{ nextPageToken: string | null; files: ConnectorFileInfo[] }>;
    selectItems: (items: Array<{ id: string; name: string; mimeType: string }>) => Promise<Array<{ id: string; name: string; mimeType: string; selected: boolean }>>;
    syncDrive: (selectedFileIds?: string[]) => Promise<{ added: number; modified: number; removed: number; status: string }>;
  };
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
    exportArtifact: (id: string, format: string) =>
      ipcRenderer.invoke("artifacts:export", id, format),
    exportToFile: (id: string, format: string, filePath: string) =>
      ipcRenderer.invoke("artifacts:exportToFile", id, format, filePath),
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
};

contextBridge.exposeInMainWorld("tessera", api);
