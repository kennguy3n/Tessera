import { ipcMain } from "electron";
import { loadConfig, updateConfig } from "./config";
import { getBridge } from "./appState";
import type { SettingsData, ModelStatus } from "./preload";

export function registerIpcHandlers(): void {
  // --- Sources ---

  ipcMain.handle(
    "sources:addLocalFolder",
    async (_event, folderPath: string) => {
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeAddLocalFolder(folderPath);
      }
      throw new Error("Native bridge not available");
    },
  );

  ipcMain.handle("sources:addLocalFile", async (_event, filePath: string) => {
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeAddLocalFile(filePath);
    }
    throw new Error("Native bridge not available");
  });

  ipcMain.handle("sources:list", async () => {
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeListSources();
    }
    return [];
  });

  ipcMain.handle("sources:remove", async (_event, id: string) => {
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeRemoveSource(id);
    }
    throw new Error("Native bridge not available");
  });

  ipcMain.handle(
    "sources:search",
    async (_event, query: string, limit: number) => {
      const bridge = getBridge();
      if (bridge) {
        const results = bridge.bridgeSearchSources(query, limit);
        return results.map((r) => ({
          sourcePath: r.sourcePath,
          sourceId: r.sourceId,
          chunkHash: r.chunkHash,
          chunkContent: r.content,
          relevanceScore: r.relevance,
          excerpt: r.excerpt,
        }));
      }
      return [];
    },
  );

  ipcMain.handle("sources:getDetail", async (_event, id: string) => {
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeGetSourceDetail(id);
    }
    throw new Error("Native bridge not available");
  });

  ipcMain.handle("sources:reindex", async (_event, id: string) => {
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeReindexSource(id);
    }
    throw new Error("Native bridge not available");
  });

  // --- Artifacts ---

  ipcMain.handle(
    "artifacts:create",
    async (
      _event,
      title: string,
      artifactType: string,
      templateId?: string,
    ) => {
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeCreateArtifact(title, artifactType, templateId);
      }
      throw new Error("Native bridge not available");
    },
  );

  ipcMain.handle(
    "artifacts:update",
    async (_event, id: string, content: string) => {
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeUpdateArtifactContent(id, content);
      }
      throw new Error("Native bridge not available");
    },
  );

  ipcMain.handle("artifacts:list", async () => {
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeListArtifacts();
    }
    return [];
  });

  ipcMain.handle("artifacts:get", async (_event, id: string) => {
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeGetArtifact(id);
    }
    throw new Error("Native bridge not available");
  });

  ipcMain.handle("artifacts:remove", async (_event, id: string) => {
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeDeleteArtifact(id);
    }
    throw new Error("Native bridge not available");
  });

  ipcMain.handle(
    "artifacts:export",
    async (_event, id: string, format: string) => {
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeExportArtifact(id, format);
      }
      throw new Error("Native bridge not available");
    },
  );

  ipcMain.handle(
    "artifacts:exportToFile",
    async (_event, id: string, format: string, filePath: string) => {
      const bridge = getBridge();
      if (bridge) {
        bridge.bridgeExportArtifactToFile(id, format, filePath);
        return;
      }
      throw new Error("Native bridge not available");
    },
  );

  // --- Templates ---

  ipcMain.handle("templates:list", async () => {
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeListTemplates();
    }
    return [];
  });

  ipcMain.handle("templates:get", async (_event, id: string) => {
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeGetTemplate(id);
    }
    return null;
  });

  // --- Citations ---

  ipcMain.handle("citations:list", async (_event, artifactId: string) => {
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeListCitations(artifactId);
    }
    return [];
  });

  ipcMain.handle("citations:add", async (_event, req: unknown) => {
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeAddCitation(
        req as {
          artifactId: string;
          sourceId: string;
          sourceType: string;
          sourceTitle: string;
          sourceUri: string;
          chunkHash: string;
          page: number | null;
          confidence: number;
          usedFor: string;
        },
      );
    }
    throw new Error("Native bridge not available");
  });

  ipcMain.handle(
    "citations:remove",
    async (_event, artifactId: string, citationId: string) => {
      const bridge = getBridge();
      if (bridge) {
        bridge.bridgeRemoveCitation(artifactId, citationId);
        return;
      }
      throw new Error("Native bridge not available");
    },
  );

  ipcMain.handle(
    "citations:checkChanged",
    async (_event, citationId: string, currentHash: string) => {
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeCheckSourceChanged(citationId, currentHash);
      }
      throw new Error("Native bridge not available");
    },
  );

  // --- Settings (remain in electron-store/JSON config) ---

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

  // --- Version History ---

  ipcMain.handle("artifacts:listVersions", async (_event, id: string) => {
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeListVersions(id);
    }
    return [];
  });

  ipcMain.handle(
    "artifacts:restoreVersion",
    async (_event, id: string, versionNumber: number) => {
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeRestoreVersion(id, versionNumber);
      }
      throw new Error("Native bridge not available");
    },
  );

  // --- Model Runtime ---

  ipcMain.handle("model:status", async () => {
    return {
      available: false,
      modelName: null,
      status: "stopped",
    } as ModelStatus;
  });

  ipcMain.handle("model:start", async (_event, _modelPath: string) => {
    // Will be wired to RuntimeManager when sidecar is available
    throw new Error("Model runtime not yet configured — download a model first");
  });

  ipcMain.handle("model:stop", async () => {
    // Will be wired to RuntimeManager
    throw new Error("Model runtime not yet configured");
  });

  ipcMain.handle("model:generate", async (_event, _request: unknown) => {
    throw new Error("Model runtime not yet configured — start a model first");
  });

  ipcMain.handle("model:cancelJob", async () => {
    // No-op if no generation running
  });
}
