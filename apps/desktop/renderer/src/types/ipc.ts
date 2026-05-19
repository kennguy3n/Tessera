export interface SourceApi {
  addLocalFolder: (path: string) => Promise<SourceInfo>;
  addLocalFile: (path: string) => Promise<SourceInfo>;
  listSources: () => Promise<SourceInfo[]>;
  removeSource: (id: string) => Promise<void>;
  searchSources: (query: string, limit: number) => Promise<SearchHit[]>;
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
  exportArtifact: (id: string, format: string) => Promise<ExportResult>;
}

export interface TemplateApi {
  list: () => Promise<TemplateInfo[]>;
  get: (id: string) => Promise<TemplateInfo | null>;
}

export interface SettingsApi {
  get: () => Promise<SettingsData>;
  update: (settings: Partial<SettingsData>) => Promise<SettingsData>;
}

export interface ModelApi {
  status: () => Promise<ModelStatus>;
}

export interface TesseraApi {
  sources: SourceApi;
  artifacts: ArtifactApi;
  templates: TemplateApi;
  settings: SettingsApi;
  model: ModelApi;
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

export interface ExportResult {
  content: string;
}

declare global {
  interface Window {
    tessera: TesseraApi;
  }
}
