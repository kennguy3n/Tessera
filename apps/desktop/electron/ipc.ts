import { ipcMain, BrowserWindow, app, dialog } from "electron";
import { existsSync } from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { loadConfig, updateConfig } from "./config";
import { getBridge, getModelSidecar } from "./appState";
import type { SettingsData, ModelStatus } from "./preload";
import { startOAuthFlow, exchangeCodeForTokens, refreshAccessToken, revokeToken } from "./oauthServer";
import * as tokenVault from "./tokenVault";
import {
  deleteCurrentModel,
  detectPlatformInfo,
  downloadModel,
  getCurrentModel,
  listModelsForPlatform,
  loadManifest,
  planDownload,
  recommendModel,
  resetManifestCache,
  type DownloadProgress,
  type ResolvedModel,
} from "./modelManagement";

// Mirrors `ExtractedItem` in apps/desktop/renderer/src/types/ipc.ts. We
// duplicate the type here instead of crossing the renderer/main module
// boundary so that ipc.ts stays free of UI imports. Any change to the
// schema must be made in both places.
interface ExtractedItem {
  itemType: "task" | "decision";
  text: string;
  sourceCitation: string;
  confidence: number;
}

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
    await sidecar.start(true);
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
    sidecar.markGenerationActive();
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

    const win = BrowserWindow.fromWebContents(event.sender);
    let sentDone = false;

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
            sentDone = true;
            streamDone = true;
            break;
          }
          try {
            const parsed = JSON.parse(data) as { content?: string; stop?: boolean };
            win?.webContents.send("model:token", {
              token: parsed.content ?? "",
              done: parsed.stop ?? false,
            });
            if (parsed.stop) {
              sentDone = true;
              streamDone = true;
              break;
            }
          } catch {
            // skip unparseable SSE lines
          }
        }
      }
    } finally {
      sidecar.markGenerationIdle();
      if (activeGenerationController === controller) {
        activeGenerationController = null;
      }
      if (!sentDone) {
        win?.webContents.send("model:token", { token: "", done: true });
      }
    }
  });

  ipcMain.handle("model:cancelJob", async () => {
    if (activeGenerationController) {
      activeGenerationController.abort();
    }
  });

  // --- Runtime: platform / model registry / single-model enforcement ---

  function userDataDir(): string {
    return app.getPath("userData");
  }

  /**
   * Stop the llama-server child process if it is currently running.
   *
   * The sidecar holds an OS-level file handle on the active model file
   * (mapped/read by `llama-server`). On Windows that handle blocks
   * `fsp.unlink`/`rename` with EPERM/EBUSY, so a swap or delete that does
   * not stop the sidecar first will fail. On macOS / Linux the unlink
   * succeeds (the open fd keeps the inode alive) but the orphaned sidecar
   * still holds port 8384 and continues serving the now-deleted model,
   * which collides with the next `model:start` and confuses
   * `model:status`.
   *
   * Every IPC entry-point that mutates the on-disk model file
   * (`runtime:downloadModel`, `runtime:deleteModel`) calls this BEFORE the
   * mutation. The renderer is expected to do the same as a UX nicety, but
   * we treat the server-side as the authoritative enforcement point so
   * that direct IPC callers (tests, other windows, future automation) get
   * the same correctness.
   */
  async function stopSidecarIfRunning(): Promise<void> {
    const sidecar = getModelSidecar();
    if (sidecar && sidecar.isRunning) {
      await sidecar.stop();
    }
  }

  function loadResolvedManifest() {
    // In production the manifest is bundled into <resources>/sidecars and
    // does not change at runtime, so the path-keyed cache in modelManagement
    // is correct as-is and we get a fast in-memory hit on every model IPC.
    //
    // In development / tests we invalidate so:
    //   - `npm run dev` hot-reload picks up edits to sidecars/models.json;
    //   - tests that switch fixtures via TESSERA_MODELS_MANIFEST always see
    //     the freshly-pointed file (the path-keyed cache also handles this
    //     naturally when the path differs; the explicit reset covers the
    //     edge case where the same path is re-used between fixtures).
    if (process.env.NODE_ENV !== "production") {
      resetManifestCache();
    }
    return loadManifest();
  }

  function findModelOrThrow(modelId: string): ResolvedModel {
    const info = detectPlatformInfo();
    const manifest = loadResolvedManifest();
    const model = listModelsForPlatform(manifest, info.platform).find(
      (m) => m.id === modelId,
    );
    if (!model) {
      throw new Error(
        `Model ${modelId} is not available on ${info.platformLabel}`,
      );
    }
    return model;
  }

  ipcMain.handle("runtime:detectPlatform", async () => detectPlatformInfo());

  ipcMain.handle("runtime:recommendModel", async () => {
    const info = detectPlatformInfo();
    const manifest = loadResolvedManifest();
    return recommendModel(manifest, info.platform, info.tier);
  });

  ipcMain.handle("runtime:listModels", async () => {
    const info = detectPlatformInfo();
    const manifest = loadResolvedManifest();
    return listModelsForPlatform(manifest, info.platform);
  });

  ipcMain.handle("runtime:getCurrentModel", async () =>
    getCurrentModel(userDataDir()),
  );

  ipcMain.handle("runtime:planDownload", async (_event, modelId: string) => {
    const requested = findModelOrThrow(modelId);
    const current = await getCurrentModel(userDataDir());
    return planDownload(current, requested);
  });

  function progressEmitter(event: Electron.IpcMainInvokeEvent) {
    const win = BrowserWindow.fromWebContents(event.sender);
    return (p: DownloadProgress) => {
      win?.webContents.send("runtime:downloadProgress", p);
    };
  }

  ipcMain.handle("runtime:downloadModel", async (event, modelId: string) => {
    const requested = findModelOrThrow(modelId);
    // Only stop the sidecar if we will actually mutate the model file.
    //
    // Three cases:
    //   (a) Requested model is already installed AND file is still on disk
    //       -> no-op, do NOT touch the sidecar (avoid killing a running
    //       inference server when no download is needed, per Devin Review
    //       finding 3270586297).
    //   (b) Requested model is already installed but file is missing
    //       -> we must re-download. Stop the sidecar in case it's still
    //       pointing at the now-missing path (defensive; in practice if
    //       the file was deleted out from under the sidecar it likely
    //       died already, but we don't rely on that).
    //   (c) A different model is installed (the swap case)
    //       -> `downloadModel` will evict the existing file. The eviction
    //       unlinks it, so we MUST stop the sidecar first — it holds the
    //       OS file handle and on Windows that blocks the unlink with
    //       EPERM/EBUSY.
    //
    // There is intentionally no separate `runtime:swapModel` channel:
    // `downloadModel` already handles both fresh-install and swap, so a
    // second handler that called the same function only invited drift
    // (see Devin Review finding 3270524691).
    const current = await getCurrentModel(userDataDir());
    if (
      current &&
      current.modelId === requested.id &&
      existsSync(current.path)
    ) {
      return current;
    }
    await stopSidecarIfRunning();
    return downloadModel(userDataDir(), requested, progressEmitter(event));
  });

  ipcMain.handle("runtime:deleteModel", async () => {
    // Stop the sidecar before unlinking. See `stopSidecarIfRunning` doc
    // for the OS-level rationale (EPERM/EBUSY on Windows, orphaned
    // process on macOS / Linux).
    await stopSidecarIfRunning();
    await deleteCurrentModel(userDataDir());
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
    let stored: ReturnType<typeof tokenVault.getTokens> = null;
    try {
      stored = tokenVault.getTokens(provider);
    } catch {
      // Vault may be corrupted — proceed with cleanup anyway
    }
    if (stored) {
      await revokeToken(stored.refreshToken ?? stored.accessToken).catch(() => {});
    }
    try { tokenVault.deleteTokens(provider); } catch { /* best effort */ }

    // Clean up synced files and their source index entries
    if (provider !== "google_drive") return { provider, connected: false, status: "disconnected" };
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
      await fsp.rm(syncDir, { recursive: true, force: true }).catch(() => {});
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
    let added = 0;
    let modified = 0;
    let removed = 0;
    const syncedPaths: string[] = [];
    const failedFileIds: string[] = [];

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
        const accessToken = await getValidAccessToken("google_drive");
        const metaResp = await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,modifiedTime`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (!metaResp.ok) {
          // Only treat 404/410 as confirmed Drive-side deletion; skip transient errors
          if (metaResp.status === 404 || metaResp.status === 410) {
            failedFileIds.push(fileId);
          }
          continue;
        }
        const meta = (await metaResp.json()) as {
          id: string;
          name: string;
          mimeType: string;
          size?: string;
          modifiedTime?: string;
        };

        if (meta.mimeType === "application/vnd.google-apps.folder") continue;

        const MAX_SYNC_FILE_BYTES = 100 * 1024 * 1024; // 100 MB
        const fileSize = Number(meta.size ?? "0");
        if (fileSize > MAX_SYNC_FILE_BYTES) continue;

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
          await fsp.mkdir(syncDir, { recursive: true });
          const ext = exportMime
            ? (exportMime === "text/csv" ? ".csv" : ".txt")
            : (meta.name.includes(".") ? meta.name.substring(meta.name.lastIndexOf(".")) : "");
          const localPath = path.join(syncDir, `${fileId}${ext}`);
          await fsp.writeFile(localPath, Buffer.from(contentBytes));

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

    // Remove local files + source index entries for Drive-side deletions
    if (failedFileIds.length > 0) {
      const syncDir = path.join(app.getPath("userData"), "gdrive-sync");
      const bridge = getBridge();
      for (const failedId of failedFileIds) {
        // Find and remove matching local files (any extension)
        try {
          const entries = await fsp.readdir(syncDir);
          for (const entry of entries) {
            const dotIdx = entry.indexOf(".");
            const entryId = dotIdx > 0 ? entry.substring(0, dotIdx) : entry;
            if (entryId === failedId) {
              const localPath = path.join(syncDir, entry);
              if (bridge) {
                const sources = bridge.bridgeListSources() as Array<{ id: string; path: string }>;
                const src = sources.find((s) => s.path === localPath);
                if (src) {
                  try { bridge.bridgeRemoveSource(src.id); } catch { /* best effort */ }
                }
              }
              await fsp.unlink(localPath).catch(() => {});
              removed++;
            }
          }
        } catch {
          // syncDir may not exist
        }
      }
    }

    // Persist manifest with only currently-valid synced paths
    const syncDir = path.join(app.getPath("userData"), "gdrive-sync");
    const manifestPath = path.join(syncDir, "manifest.json");
    let existingManifest: string[] = [];
    try {
      existingManifest = JSON.parse(await fsp.readFile(manifestPath, "utf-8")) as string[];
    } catch {
      // No existing manifest
    }
    // Remove stale paths for failed file IDs and add new synced paths
    const failedIdSet = new Set(failedFileIds);
    const surviving = existingManifest.filter((p) => {
      const bn = path.basename(p);
      const dotIdx = bn.indexOf(".");
      const fileId = dotIdx > 0 ? bn.substring(0, dotIdx) : bn;
      return !failedIdSet.has(fileId);
    });
    const merged = [...new Set([...surviving, ...syncedPaths])];
    if (merged.length > 0) {
      await fsp.mkdir(syncDir, { recursive: true });
      await fsp.writeFile(manifestPath, JSON.stringify(merged));
    } else {
      await fsp.unlink(manifestPath).catch(() => {});
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
      // Validate at the IPC boundary so a misbehaving Rust bridge never
      // ships shape-violating data to the renderer (which would silently
      // render `undefined` confidence / itemType strings). Drop anything
      // that doesn't match the contract instead of casting blindly.
      const parsed: unknown = JSON.parse(json);
      if (!Array.isArray(parsed)) {
        throw new Error(
          "extractTasksDecisions: bridge returned non-array payload",
        );
      }
      const items: ExtractedItem[] = [];
      const dropReasons: string[] = [];
      for (const raw of parsed) {
        if (!raw || typeof raw !== "object") {
          dropReasons.push("non-object payload");
          continue;
        }
        const rec = raw as Record<string, unknown>;
        const itemType =
          rec.itemType === "task" || rec.itemType === "decision"
            ? rec.itemType
            : null;
        const text = typeof rec.text === "string" ? rec.text : null;
        const sourceCitation =
          typeof rec.sourceCitation === "string" ? rec.sourceCitation : null;
        const confidence =
          typeof rec.confidence === "number" && Number.isFinite(rec.confidence)
            ? rec.confidence
            : null;
        if (itemType === null) {
          dropReasons.push(`itemType=${JSON.stringify(rec.itemType)}`);
          continue;
        }
        if (text === null) {
          dropReasons.push("missing-text");
          continue;
        }
        if (sourceCitation === null) {
          dropReasons.push("missing-sourceCitation");
          continue;
        }
        if (confidence === null) {
          dropReasons.push(`bad-confidence=${JSON.stringify(rec.confidence)}`);
          continue;
        }
        items.push({ itemType, text, sourceCitation, confidence });
      }
      if (dropReasons.length > 0) {
        // Surface bridge schema mismatches loudly during development so a
        // Rust-side rename (e.g. itemType → item_type) doesn't disappear
        // into an empty result with no diagnostic. We log a single summary
        // per call to avoid log-spam when the entire batch is malformed.
        console.warn(
          `[tessera] extractTasksDecisions(${sourceId}): dropped ${dropReasons.length}/${parsed.length} item(s) failing schema validation: ${dropReasons.slice(0, 5).join(", ")}${dropReasons.length > 5 ? ", ..." : ""}`,
        );
      }
      return items;
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

  ipcMain.handle(
    "dialog:showSaveDialog",
    async (event, options: Electron.SaveDialogOptions) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      return result;
    },
  );
}
