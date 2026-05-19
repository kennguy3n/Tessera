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
  citations: string[];
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface TemplateInfo {
  id: string;
  name: string;
  templateType: string;
  description: string;
  sectionCount: number;
  exportFormats: string[];
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

export interface TesseraApi {
  sources: {
    addLocalFolder: (path: string) => Promise<SourceInfo>;
    addLocalFile: (path: string) => Promise<SourceInfo>;
    listSources: () => Promise<SourceInfo[]>;
    removeSource: (id: string) => Promise<void>;
    searchSources: (query: string, limit: number) => Promise<SearchHit[]>;
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
    ) => Promise<{ content: string }>;
  };
  templates: {
    list: () => Promise<TemplateInfo[]>;
    get: (id: string) => Promise<TemplateInfo | null>;
  };
  settings: {
    get: () => Promise<SettingsData>;
    update: (settings: Partial<SettingsData>) => Promise<SettingsData>;
  };
  model: {
    status: () => Promise<ModelStatus>;
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
  },
  templates: {
    list: () => ipcRenderer.invoke("templates:list"),
    get: (id: string) => ipcRenderer.invoke("templates:get", id),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    update: (settings: Partial<SettingsData>) =>
      ipcRenderer.invoke("settings:update", settings),
  },
  model: {
    status: () => ipcRenderer.invoke("model:status"),
  },
};

contextBridge.exposeInMainWorld("tessera", api);
