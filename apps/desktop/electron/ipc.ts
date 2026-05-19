import { ipcMain } from "electron";
import { loadConfig, updateConfig } from "./config";
import type { SettingsData, ModelStatus } from "./preload";

let sources: Array<{
  id: string;
  sourceType: string;
  path: string;
  status: string;
  createdAt: string;
  lastIndexed: string | null;
  fileCount: number;
}> = [];

let artifacts: Array<{
  id: string;
  title: string;
  artifactType: string;
  templateId: string | null;
  content: string;
  citations: string[];
  createdAt: string;
  updatedAt: string;
  version: number;
}> = [];

function generateId(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).substring(2, 10)
  );
}

export function registerIpcHandlers(): void {
  ipcMain.handle(
    "sources:addLocalFolder",
    async (_event, folderPath: string) => {
      const source = {
        id: generateId(),
        sourceType: "local_folder",
        path: folderPath,
        status: "connected",
        createdAt: new Date().toISOString(),
        lastIndexed: null,
        fileCount: 0,
      };
      sources.push(source);
      return source;
    },
  );

  ipcMain.handle("sources:addLocalFile", async (_event, filePath: string) => {
    const source = {
      id: generateId(),
      sourceType: "local_file",
      path: filePath,
      status: "connected",
      createdAt: new Date().toISOString(),
      lastIndexed: null,
      fileCount: 1,
    };
    sources.push(source);
    return source;
  });

  ipcMain.handle("sources:list", async () => {
    return sources;
  });

  ipcMain.handle("sources:remove", async (_event, id: string) => {
    sources = sources.filter((s) => s.id !== id);
  });

  ipcMain.handle(
    "sources:search",
    async (_event, query: string, limit: number) => {
      return sources
        .filter(
          (s) =>
            s.path.toLowerCase().includes(query.toLowerCase()) ||
            s.sourceType.toLowerCase().includes(query.toLowerCase()),
        )
        .slice(0, limit)
        .map((s) => ({
          sourcePath: s.path,
          chunkContent: "",
          relevanceScore: 1.0,
          excerpt: s.path,
        }));
    },
  );

  ipcMain.handle(
    "artifacts:create",
    async (
      _event,
      title: string,
      artifactType: string,
      templateId?: string,
    ) => {
      const now = new Date().toISOString();
      const artifact = {
        id: generateId(),
        title,
        artifactType,
        templateId: templateId ?? null,
        content: "",
        citations: [],
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      artifacts.push(artifact);
      return artifact;
    },
  );

  ipcMain.handle(
    "artifacts:update",
    async (_event, id: string, content: string) => {
      const artifact = artifacts.find((a) => a.id === id);
      if (!artifact) throw new Error(`Artifact ${id} not found`);
      artifact.content = content;
      artifact.updatedAt = new Date().toISOString();
      artifact.version += 1;
      return artifact;
    },
  );

  ipcMain.handle("artifacts:list", async () => {
    return artifacts;
  });

  ipcMain.handle("artifacts:get", async (_event, id: string) => {
    const artifact = artifacts.find((a) => a.id === id);
    if (!artifact) throw new Error(`Artifact ${id} not found`);
    return artifact;
  });

  ipcMain.handle("artifacts:remove", async (_event, id: string) => {
    artifacts = artifacts.filter((a) => a.id !== id);
  });

  ipcMain.handle(
    "artifacts:export",
    async (_event, id: string, format: string) => {
      const artifact = artifacts.find((a) => a.id === id);
      if (!artifact) throw new Error(`Artifact ${id} not found`);
      let content: string;
      switch (format) {
        case "markdown":
          content = `# ${artifact.title}\n\n${artifact.content}`;
          break;
        case "html":
          content = `<html><body><h1>${artifact.title}</h1><div>${artifact.content}</div></body></html>`;
          break;
        case "csv":
          content = `title,content\n"${artifact.title}","${artifact.content}"`;
          break;
        default:
          content = artifact.content;
      }
      return { content };
    },
  );

  ipcMain.handle("templates:list", async () => {
    return [];
  });

  ipcMain.handle("templates:get", async (_event, _id: string) => {
    return null;
  });

  ipcMain.handle("settings:get", async () => {
    const config = loadConfig();
    return {
      theme: config.theme,
      defaultExportFormat: config.defaultExportFormat,
      ignorePatterns: config.ignorePatterns,
      watchPatterns: config.watchPatterns,
    } as SettingsData;
  });

  ipcMain.handle(
    "settings:update",
    async (_event, settings: Partial<SettingsData>) => {
      const config = loadConfig();
      const updated = {
        ...config,
        ...settings,
      };
      updateConfig(settings);
      return {
        theme: updated.theme,
        defaultExportFormat: updated.defaultExportFormat,
        ignorePatterns: updated.ignorePatterns,
        watchPatterns: updated.watchPatterns,
      } as SettingsData;
    },
  );

  ipcMain.handle("model:status", async () => {
    return {
      available: false,
      modelName: null,
      status: "not_configured",
    } as ModelStatus;
  });
}
