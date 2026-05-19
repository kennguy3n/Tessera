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
  };
  templates: {
    list: () => Promise<TemplateInfo[]>;
    get: (id: string) => Promise<TemplateInfo | null>;
  };
  citations: {
    list: (artifactId: string) => Promise<CitationInfo[]>;
    add: (req: AddCitationRequest) => Promise<CitationInfo>;
    remove: (artifactId: string, citationId: string) => Promise<void>;
    checkChanged: (citationId: string, currentHash: string) => Promise<boolean>;
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
    checkChanged: (citationId: string, currentHash: string) =>
      ipcRenderer.invoke("citations:checkChanged", citationId, currentHash),
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
};

contextBridge.exposeInMainWorld("tessera", api);
