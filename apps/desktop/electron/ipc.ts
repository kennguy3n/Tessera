import { ipcMain, BrowserWindow, app } from "electron";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { loadConfig, updateConfig } from "./config";
import { getBridge, getModelSidecar } from "./appState";
import type { SettingsData, ModelStatus } from "./preload";
import { startOAuthFlow, exchangeCodeForTokens, refreshAccessToken, revokeToken } from "./oauthServer";
import * as tokenVault from "./tokenVault";

async function getValidAccessToken(provider: string): Promise<string> {
  const stored = tokenVault.getTokens(provider);
  if (!stored) throw new Error(`${provider} not connected`);

  if (Date.now() < stored.expiresAt - 60_000) {
    return stored.accessToken;
  }

  if (!stored.refreshToken) {
    tokenVault.deleteTokens(provider);
    throw new Error(`${provider} token expired and no refresh token available — re-authenticate`);
  }

  const clientId = stored.clientId;
  const clientSecret = stored.clientSecret;
  if (!clientId || !clientSecret) {
    tokenVault.deleteTokens(provider);
    throw new Error("OAuth credentials missing from token store — re-authenticate");
  }

  const refreshed = await refreshAccessToken(clientId, clientSecret, stored.refreshToken);
  tokenVault.storeTokens(provider, {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? stored.refreshToken,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
    scopes: stored.scopes,
    clientId,
    clientSecret,
  });
  return refreshed.access_token;
}

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
    async (_event, citationId: string) => {
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeCheckSourceChanged(citationId);
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
    const sidecar = getModelSidecar();
    if (sidecar && sidecar.isRunning) {
      const healthy = await sidecar.healthCheck();
      return {
        available: true,
        modelName: "Ternary-Bonsai",
        status: healthy ? "running" : "loading",
      } as ModelStatus;
    }
    return {
      available: false,
      modelName: null,
      status: "stopped",
    } as ModelStatus;
  });

  ipcMain.handle("model:start", async (_event, modelPath: string) => {
    const sidecar = getModelSidecar();
    if (!sidecar) throw new Error("Model sidecar not initialized");
    if (sidecar.isRunning) return;
    sidecar.setModelPath(modelPath);
    await sidecar.start();
  });

  ipcMain.handle("model:stop", async () => {
    const sidecar = getModelSidecar();
    if (sidecar && sidecar.isRunning) {
      await sidecar.stop();
    }
  });

  let activeGenerationController: AbortController | null = null;

  ipcMain.handle("model:generate", async (event, request: {
    prompt: string;
    maxTokens?: number;
    temperature?: number;
  }) => {
    const sidecar = getModelSidecar();
    if (!sidecar || !sidecar.isRunning) {
      throw new Error("Model runtime not running — start a model first");
    }
    sidecar.recordActivity();
    const endpoint = sidecar.endpoint;
    const body = {
      prompt: request.prompt,
      n_predict: request.maxTokens ?? 2048,
      temperature: request.temperature ?? 0.7,
      stream: true,
    };

    // Abort any in-flight generation before starting a new one
    if (activeGenerationController) {
      activeGenerationController.abort();
    }
    const controller = new AbortController();
    activeGenerationController = controller;

    try {
      const resp = await fetch(`${endpoint}/completion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Generation failed: HTTP ${resp.status} — ${text}`);
      }

      const reader = resp.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      const win = BrowserWindow.fromWebContents(event.sender);
      let lineBuffer = "";
      let streamDone = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done || streamDone) break;
        sidecar.recordActivity();
        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") {
            win?.webContents.send("model:token", { token: "", done: true });
            streamDone = true;
            break;
          }
          try {
            const parsed = JSON.parse(data) as { content?: string; stop?: boolean };
            win?.webContents.send("model:token", {
              token: parsed.content ?? "",
              done: parsed.stop ?? false,
            });
          } catch {
            // skip unparseable SSE lines
          }
        }
      }
    } finally {
      if (activeGenerationController === controller) {
        activeGenerationController = null;
      }
    }
  });

  ipcMain.handle("model:cancelJob", async () => {
    if (activeGenerationController) {
      activeGenerationController.abort();
    }
  });

  // --- Connectors ---

  ipcMain.handle(
    "connectors:authenticate",
    async (_event, provider: string, clientId: string, clientSecret: string) => {
      if (provider !== "google_drive") {
        throw new Error(`Unsupported provider: ${provider}`);
      }
      const oauthResult = await startOAuthFlow(clientId, clientSecret);
      const tokens = await exchangeCodeForTokens(
        oauthResult.code,
        clientId,
        clientSecret,
      );
      tokenVault.storeTokens(provider, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
        clientId,
        clientSecret,
      });
      return { provider, connected: true, status: "connected" };
    },
  );

  ipcMain.handle("connectors:disconnect", async (_event, provider: string) => {
    const stored = tokenVault.getTokens(provider);
    if (stored) {
      await revokeToken(stored.accessToken).catch(() => {});
      tokenVault.deleteTokens(provider);
    }

    // Clean up synced files and their source index entries (async to avoid blocking main thread)
    const syncDir = path.join(app.getPath("userData"), "gdrive-sync");
    const manifestPath = path.join(syncDir, "manifest.json");
    try {
      const manifestData = await fsp.readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(manifestData) as string[];
      const bridge = getBridge();
      if (bridge) {
        const sources = bridge.bridgeListSources() as Array<{ id: string; path: string }>;
        const syncedSet = new Set(manifest);
        for (const src of sources) {
          if (syncedSet.has(src.path)) {
            try { bridge.bridgeRemoveSource(src.id); } catch { /* best effort */ }
          }
        }
      }
      await Promise.all(manifest.map((filePath) => fsp.unlink(filePath).catch(() => {})));
      await fsp.unlink(manifestPath).catch(() => {});
      await fsp.rmdir(syncDir).catch(() => {});
    } catch {
      // No manifest — nothing to clean up
    }

    return { provider, connected: false, status: "disconnected" };
  });

  ipcMain.handle("connectors:status", async (_event, provider: string) => {
    const hasTokens = tokenVault.hasTokens(provider);
    return {
      provider,
      connected: hasTokens,
      status: hasTokens ? "connected" : "disconnected",
    };
  });

  ipcMain.handle(
    "connectors:gdrive:listFiles",
    async (_event, folderId?: string, pageToken?: string) => {
      const accessToken = await getValidAccessToken("google_drive");

      const sanitizedFolderId = (folderId ?? "root").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const query = `'${sanitizedFolderId}' in parents and trashed = false`;
      const params = new URLSearchParams({
        q: query,
        fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)",
        pageSize: "100",
        orderBy: "folder,name",
      });
      if (pageToken) params.set("pageToken", pageToken);

      const resp = await fetch(
        `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Drive API error: HTTP ${resp.status} — ${text}`);
      }

      const data = (await resp.json()) as {
        nextPageToken?: string;
        files: Array<{
          id: string;
          name: string;
          mimeType: string;
          size?: string;
          modifiedTime?: string;
          parents?: string[];
        }>;
      };

      return {
        nextPageToken: data.nextPageToken ?? null,
        files: data.files.map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: Number(f.size ?? "0"),
          modifiedTime: f.modifiedTime ?? null,
          isFolder: f.mimeType === "application/vnd.google-apps.folder",
          parentId: f.parents?.[0] ?? null,
        })),
      };
    },
  );

  ipcMain.handle(
    "connectors:gdrive:selectItems",
    async (
      _event,
      items: Array<{ id: string; name: string; mimeType: string }>,
    ) => {
      return items.map((item) => ({
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        selected: true,
      }));
    },
  );

  ipcMain.handle("connectors:gdrive:sync", async (_event, selectedFileIds?: string[]) => {
    const accessToken = await getValidAccessToken("google_drive");

    let added = 0;
    let modified = 0;
    const removed = 0;
    const syncedPaths: string[] = [];

    // When no file IDs provided ("Sync Now" button), re-sync previously synced files from manifest
    let resolvedFileIds = selectedFileIds;
    if (!resolvedFileIds || resolvedFileIds.length === 0) {
      const syncDir = path.join(app.getPath("userData"), "gdrive-sync");
      const manifestPath = path.join(syncDir, "manifest.json");
      try {
        const manifestData = await fsp.readFile(manifestPath, "utf-8");
        const manifestPaths = JSON.parse(manifestData) as string[];
        // Extract file IDs from paths: <syncDir>/<fileId><ext> → fileId
        resolvedFileIds = manifestPaths.map((p) => {
          const basename = path.basename(p);
          const dotIdx = basename.indexOf(".");
          return dotIdx > 0 ? basename.substring(0, dotIdx) : basename;
        });
      } catch {
        // No manifest — nothing to re-sync
        return { added: 0, modified: 0, removed: 0, status: "synced" };
      }
    }

    if (resolvedFileIds && resolvedFileIds.length > 0) {
      for (const fileId of resolvedFileIds) {
        const metaResp = await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,modifiedTime`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (!metaResp.ok) continue;
        const meta = (await metaResp.json()) as {
          id: string;
          name: string;
          mimeType: string;
          size?: string;
          modifiedTime?: string;
        };

        if (meta.mimeType === "application/vnd.google-apps.folder") continue;

        const exportMimeMap: Record<string, string> = {
          "application/vnd.google-apps.document": "text/plain",
          "application/vnd.google-apps.spreadsheet": "text/csv",
          "application/vnd.google-apps.presentation": "text/plain",
        };

        let contentBytes: ArrayBuffer;
        const exportMime = exportMimeMap[meta.mimeType];
        if (exportMime) {
          const exportResp = await fetch(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
          );
          if (!exportResp.ok) continue;
          contentBytes = await exportResp.arrayBuffer();
        } else {
          const dlResp = await fetch(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
          );
          if (!dlResp.ok) continue;
          contentBytes = await dlResp.arrayBuffer();
        }

        const bridge = getBridge();
        if (bridge && contentBytes.byteLength > 0) {
          const syncDir = path.join(app.getPath("userData"), "gdrive-sync");
          fs.mkdirSync(syncDir, { recursive: true });
          const ext = exportMime
            ? (exportMime === "text/csv" ? ".csv" : ".txt")
            : (meta.name.includes(".") ? meta.name.substring(meta.name.lastIndexOf(".")) : "");
          const localPath = path.join(syncDir, `${fileId}${ext}`);
          fs.writeFileSync(localPath, Buffer.from(contentBytes));

          try {
            // Upsert: reindex existing source instead of creating duplicate
            const sources = bridge.bridgeListSources();
            const existing = sources.find((s) => s.path === localPath);
            if (existing) {
              bridge.bridgeReindexSource(existing.id);
              modified++;
            } else {
              bridge.bridgeAddLocalFile(localPath);
              added++;
            }
            syncedPaths.push(localPath);
          } catch {
            // Indexing failed — do not count
          }
        }
      }
    }

    // Persist manifest of synced file paths for disconnect cleanup
    if (syncedPaths.length > 0) {
      const syncDir = path.join(app.getPath("userData"), "gdrive-sync");
      fs.mkdirSync(syncDir, { recursive: true });
      const manifestPath = path.join(syncDir, "manifest.json");
      let existing: string[] = [];
      try {
        existing = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as string[];
      } catch {
        // No existing manifest
      }
      const merged = [...new Set([...existing, ...syncedPaths])];
      fs.writeFileSync(manifestPath, JSON.stringify(merged));
    }

    return { added, modified, removed, status: "synced" };
  });

  // --- Artifact Generation ---

  ipcMain.handle(
    "artifacts:generateFromTemplate",
    async (
      _event,
      templateId: string,
      sourceIds: string[],
    ) => {
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      return bridge.bridgeGenerateFromTemplate(templateId, sourceIds);
    },
  );

  ipcMain.handle(
    "artifacts:extractTasksDecisions",
    async (_event, sourceId: string) => {
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      const json = bridge.bridgeExtractTasksDecisions(sourceId);
      return JSON.parse(json) as unknown[];
    },
  );

  ipcMain.handle(
    "artifacts:compareSources",
    async (_event, sourceIdA: string, sourceIdB: string) => {
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      return bridge.bridgeCompareSources(sourceIdA, sourceIdB);
    },
  );

  ipcMain.handle(
    "artifacts:exportEvidencePack",
    async (_event, artifactId: string, outputPath: string) => {
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      return bridge.bridgeExportEvidencePack(artifactId, outputPath);
    },
  );
}
