import { ipcMain, BrowserWindow, app, dialog } from "electron";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  loadConfig,
  updateConfig,
  DEFAULT_EXTERNAL_PROVIDER,
  type ExternalProviderConfig,
} from "./config";
import { getBridge, getModelSidecar } from "./appState";
import {
  dispatchOnGenerate,
  getSchedulerStatus,
  runNow as schedulerRunNow,
} from "./scheduler";
import { isSafeExportPath } from "./exportPathSafety";
import type { SettingsData, ModelStatus } from "./preload";
import { startOAuthFlow, exchangeCodeForTokens, refreshAccessToken, revokeToken } from "./oauthServer";
import * as tokenVault from "./tokenVault";
import * as secretsVault from "./secretsVault";
import {
  deleteCurrentModel,
  detectPlatformInfo,
  downloadModel,
  getInstalledModel,
  isModelInstalled,
  listModelsForPlatform,
  loadManifest,
  planDownload,
  recommendModel,
  resetManifestCache,
  type DownloadProgress,
  type ResolvedModel,
} from "./modelManagement";
import {
  validateExtractedItems,
  type ExtractedItem,
} from "./extractedItemValidation";

// `ExtractedItem` (re-exported for callers that still imported it from
// this module) mirrors the renderer's `src/types/ipc.ts`. The
// validation logic lives in `./extractedItemValidation` so it can be
// unit-tested without Electron.
export type { ExtractedItem };

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

/**
 * Build the allowlist of safe export roots that the IPC handlers will
 * accept absolute paths inside. Computed lazily (per call) rather than
 * captured in a module-level constant because Electron's `app.getPath()`
 * APIs are only safe to call after the `ready` event has fired — and the
 * IPC handlers register against `ipcMain` synchronously at startup but
 * the handlers themselves only execute later, well after `ready`.
 *
 * Roots include `downloads`, `documents`, `desktop`, the user's home
 * directory, the Electron app's `userData` directory, and the OS temp
 * directory. Each of these is a location the user is reasonably expected
 * to be able to write to; everything else (system paths, other users'
 * home directories, etc.) is excluded.
 */
function getSafeExportRoots(): string[] {
  const roots: string[] = [];
  // `app.getPath` throws `Error: ENOENT` for unknown path keys on some
  // platforms (e.g. `desktop` on a headless Linux); swallow per-key so a
  // missing standard folder doesn't disable the whole allowlist.
  for (const key of ["downloads", "documents", "desktop", "home", "userData"]) {
    try {
      const p = app.getPath(key as Parameters<typeof app.getPath>[0]);
      if (p) roots.push(p);
    } catch {
      // skip
    }
  }
  // `os.tmpdir()` is the conventional location for integration tests
  // (and the Electron test harness) to drop ephemeral export artefacts.
  // Without this entry, `os.tmpdir()`-rooted writes would be rejected.
  try {
    roots.push(os.tmpdir());
  } catch {
    // skip
  }
  return roots;
}

/**
 * Issue a minimal request against the configured external LLM provider
 * to verify that the URL is reachable, the API key is accepted, and
 * the model exists. Returns `{ ok: true, latencyMs }` on success and
 * `{ ok: false, error }` on any HTTP-level or network failure.
 *
 * We deliberately keep this small (1-token completion) so the test
 * does not burn user budget on actual generation work.
 */
async function testExternalProviderConnection(
  provider: ExternalProviderConfig,
  apiKey: string,
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const start = Date.now();
  const controller = new AbortController();
  const timeoutMs = Math.max(1, provider.timeoutSecs) * 1000;
  const t = setTimeout(() => controller.abort(), timeoutMs);

  let url: string;
  let headers: Record<string, string>;
  let body: string;

  const apiUrl = provider.apiUrl.replace(/\/+$/, "");
  if (provider.providerType === "anthropic") {
    url = `${apiUrl}/v1/messages`;
    headers = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
    body = JSON.stringify({
      model: provider.modelName,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
  } else {
    // OpenAI-compatible (covers OpenAI, Ollama, vLLM, LM Studio, …)
    url = `${apiUrl}/v1/chat/completions`;
    headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
    body = JSON.stringify({
      model: provider.modelName,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      return { ok: false, error: `Timed out after ${provider.timeoutSecs}s` };
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(t);
  }
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

  ipcMain.handle(
    "sources:getIndexingProgress",
    async (_event, id: string) => {
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeGetIndexingProgress(id);
      }
      throw new Error("Native bridge not available");
    },
  );

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
    async (
      _event,
      id: string,
      format: string,
      contentOverride?: string | null,
    ) => {
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeExportArtifact(id, format, contentOverride ?? null);
      }
      throw new Error("Native bridge not available");
    },
  );

  ipcMain.handle(
    "artifacts:exportToFile",
    async (
      event,
      id: string,
      format: string,
      filePath: string,
      contentOverride?: string | null,
    ) => {
      const bridge = getBridge();
      if (!bridge) {
        throw new Error("Native bridge not available");
      }

      // Resolve the final on-disk path. Three modes (in order of preference):
      //   1) An absolute path supplied by the renderer is honoured only if it
      //      resolves inside the allowlist of safe export roots (Downloads,
      //      Documents, Desktop, the user's home directory, the app's
      //      `userData` directory and the system temp dir). A compromised
      //      renderer cannot request a write to e.g. `/etc/passwd` because
      //      `/etc` is not under any of those roots — `isSafeExportPath`
      //      throws an explicit error in that case. Tests + scripted exports
      //      that use `os.tmpdir()` keep working without change.
      //   2) Otherwise (or if the absolute path was rejected as unsafe),
      //      prompt the user via the native save dialog seeded with the
      //      renderer's suggested filename under ~/Downloads.
      //   3) If the user dismisses the dialog, we return `null` so the
      //      renderer can surface an "Export cancelled" status without
      //      writing any file — matching standard desktop save-dialog UX.
      let resolvedPath: string;
      if (path.isAbsolute(filePath)) {
        if (!isSafeExportPath(filePath, getSafeExportRoots())) {
          // Refuse the request outright instead of silently rewriting the
          // path or showing the user a dialog with a dangerous suggestion.
          // This is the security boundary; making it visible as an error
          // is the point — see BUG_pr-review-job-5a49c7d7ef804edda4f280500e2b1ff0_0003.
          throw new Error(
            `Export path is outside the allowed locations (Downloads, Documents, Desktop, Home, App data, system temp): ${filePath}`,
          );
        }
        resolvedPath = filePath;
      } else {
        const downloads = app.getPath("downloads");
        const suggested = path.join(downloads, filePath || `artifact.${format}`);
        const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
        const result = await (win
          ? dialog.showSaveDialog(win, {
              defaultPath: suggested,
              title: "Export artifact",
            })
          : dialog.showSaveDialog({
              defaultPath: suggested,
              title: "Export artifact",
            }));
        if (result.canceled || !result.filePath) {
          return null;
        }
        resolvedPath = result.filePath;
      }

      // Make sure the parent directory exists before the Rust bridge writes.
      await fsp.mkdir(path.dirname(resolvedPath), { recursive: true });
      bridge.bridgeExportArtifactToFile(
        id,
        format,
        resolvedPath,
        contentOverride ?? null,
      );
      return resolvedPath;
    },
  );

  ipcMain.handle(
    "artifacts:exportTypst",
    async (
      _event,
      req: {
        markup: string;
        format: "pdf" | "svg";
        outputPath?: string;
      },
    ) => {
      // Path safety: same allowlist gate as `artifacts:exportToFile` and
      // `artifacts:exportMarp` — a compromised renderer must not be able to
      // turn the Typst export IPC into a write-anywhere primitive by
      // supplying e.g. `/etc/cron.d/malicious` as the output path. Relative
      // / undefined paths fall through to `runTypstExport`'s temp-file
      // default (which uses `os.tmpdir()`, itself in the allowlist).
      if (req.outputPath && path.isAbsolute(req.outputPath)) {
        if (!isSafeExportPath(req.outputPath, getSafeExportRoots())) {
          throw new Error(
            `Export path is outside the allowed locations (Downloads, Documents, Desktop, Home, App data, system temp): ${req.outputPath}`,
          );
        }
      }
      const { runTypstExport } = await import("./typstExport");
      return runTypstExport({
        markup: req.markup,
        format: req.format,
        outputPath: req.outputPath,
      });
    },
  );

  ipcMain.handle(
    "artifacts:exportMarp",
    async (
      event,
      req: {
        markdown: string;
        format: "pdf" | "pptx" | "html";
        // Either an absolute path (used as-is) OR a suggested filename — in
        // which case we prompt with the native save dialog (matching the
        // `exportToFile` flow) so users always pick where the file lands.
        outputPath: string;
        theme?: string;
        includeNotes?: boolean;
        allowHtml?: boolean;
      },
    ) => {
      let resolvedPath: string;
      if (path.isAbsolute(req.outputPath)) {
        if (!isSafeExportPath(req.outputPath, getSafeExportRoots())) {
          throw new Error(
            `Export path is outside the allowed locations (Downloads, Documents, Desktop, Home, App data, system temp): ${req.outputPath}`,
          );
        }
        resolvedPath = req.outputPath;
      } else {
        const downloads = app.getPath("downloads");
        const fallbackName =
          req.outputPath && req.outputPath.length > 0
            ? req.outputPath
            : `artifact.${req.format}`;
        const suggested = path.join(downloads, fallbackName);
        const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
        const result = await (win
          ? dialog.showSaveDialog(win, {
              defaultPath: suggested,
              title: "Export slides",
            })
          : dialog.showSaveDialog({
              defaultPath: suggested,
              title: "Export slides",
            }));
        // Standard desktop UX: a cancelled save dialog means no file is
        // written. The renderer translates the `null` return into an
        // "Export cancelled" status indicator.
        if (result.canceled || !result.filePath) {
          return null;
        }
        resolvedPath = result.filePath;
      }
      await fsp.mkdir(path.dirname(resolvedPath), { recursive: true });
      const { runMarpExport } = await import("./marpExport");
      await runMarpExport({
        markdown: req.markdown,
        format: req.format,
        outputPath: resolvedPath,
        theme: req.theme,
        includeNotes: req.includeNotes,
        allowHtml: req.allowHtml,
      });
      return resolvedPath;
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

  ipcMain.handle(
    "citations:checkFreshness",
    async (_event, citationId: string) => {
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeCheckCitationFreshness(citationId);
      }
      throw new Error("Native bridge not available");
    },
  );

  ipcMain.handle("citations:replace", async (_event, req: unknown) => {
    const bridge = getBridge();
    if (bridge) {
      // The inline shape MUST match the Rust N-API
      // `ReplaceCitationRequest` struct in
      // `crates/tessera_bridge/src/citations.rs` — in particular,
      // `chunkHash` is required so the new citation can be looked
      // up in the source store on the Rust side.
      return bridge.bridgeReplaceCitation(
        req as {
          artifactId: string;
          citationId: string;
          sourceId: string;
          sourceType: string;
          sourceTitle: string;
          sourceUri: string;
          chunkHash: string;
          page: number | null;
          confidence: number;
        },
      );
    }
    throw new Error("Native bridge not available");
  });

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

  // --- External LLM provider ---
  //
  // Settings (URL, model, etc.) live in the on-disk JSON config so they
  // survive restarts. The API key is *referenced* by `apiKeyRef` but
  // never stored there — it lives encrypted in the OS keychain via
  // `secretsVault`. Renderer code passes the key over IPC only when
  // the user explicitly types/pastes it into the password field.

  ipcMain.handle("externalProvider:get", async () => {
    const config = loadConfig();
    const provider = config.externalProvider ?? {
      ...DEFAULT_EXTERNAL_PROVIDER,
    };
    return {
      ...provider,
      hasApiKey: provider.apiKeyRef
        ? secretsVault.hasSecret(provider.apiKeyRef)
        : false,
    };
  });

  ipcMain.handle(
    "externalProvider:set",
    async (
      _event,
      provider: ExternalProviderConfig,
      apiKey: string | null,
    ) => {
      // Merge with defaults so a partial payload from a renderer of an
      // earlier release still ends up with all required fields.
      const merged: ExternalProviderConfig = {
        ...DEFAULT_EXTERNAL_PROVIDER,
        ...provider,
      };
      updateConfig({ externalProvider: merged });

      if (apiKey === null) {
        // null = leave whatever's in the keychain alone.
      } else if (apiKey === "") {
        // empty string = explicitly forget the key.
        secretsVault.deleteSecret(merged.apiKeyRef);
      } else {
        secretsVault.storeSecret(merged.apiKeyRef, apiKey);
      }

      return {
        ...merged,
        hasApiKey: secretsVault.hasSecret(merged.apiKeyRef),
      };
    },
  );

  ipcMain.handle("externalProvider:test", async () => {
    const config = loadConfig();
    const provider = config.externalProvider;
    if (!provider || !provider.enabled) {
      return { ok: false, error: "External provider is disabled" };
    }
    if (!provider.apiUrl.trim() || !provider.modelName.trim()) {
      return { ok: false, error: "API URL and model name are required" };
    }
    if (!secretsVault.hasSecret(provider.apiKeyRef)) {
      return { ok: false, error: "API key has not been stored" };
    }
    const apiKey = secretsVault.getSecret(provider.apiKeyRef);
    if (!apiKey) {
      return { ok: false, error: "API key has not been stored" };
    }
    try {
      const result = await testExternalProviderConnection(provider, apiKey);
      return result;
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });

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

    // Bind a destroyed-window-safe sender for the token channel. This is
    // the same defense pattern used by `progressEmitter` for the download
    // progress channel: if the user closes the window mid-generation,
    // `webContents.send` would otherwise throw "Object has been
    // destroyed", which propagates through the SSE read loop and out of
    // the IPC handler. The renderer is already gone so the rejection is
    // dropped, but the throw also short-circuits the `finally` cleanup
    // (idle marking + controller reset) on the way out. Routing every
    // `model:token` send through `safeRendererSender` makes the channel
    // best-effort and keeps cleanup deterministic regardless of renderer
    // state. (Devin Review BUG finding 3271137685.)
    const sendToken = safeRendererSender<{ token: string; done: boolean }>(
      event,
      "model:token",
    );
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
            sendToken({ token: "", done: true });
            sentDone = true;
            streamDone = true;
            break;
          }
          try {
            const parsed = JSON.parse(data) as { content?: string; stop?: boolean };
            sendToken({
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
        sendToken({ token: "", done: true });
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
    // Same "live record only" semantics as runtime:planDownload and the
    // runtime:downloadModel fast-path: if active-model.json points at a
    // file that's no longer on disk, treat it as no model installed.
    //
    // Round 10 left this IPC on `getCurrentModel` (raw record) on the
    // theory that a future "ghost record → Re-download" UI would want to
    // see the stale record. That UI doesn't exist today: both
    // ModelRuntimeCard (line 261) and RuntimeStatus key off the truthiness
    // of the result to switch between the "Installed" branch (Start /
    // Delete buttons, Download hidden) and the "no model" branch
    // (Download visible). Exposing the ghost record makes the Download
    // button unreachable without first clicking Delete, which is the
    // exact UX gap finding 3270889829 flags. Stale records get cleaned
    // up on the next downloadModelLocked pass (it clears active-model.json
    // when isModelInstalled returns null but a record still exists), so
    // there's no orphan to manage at this layer. (Devin Review BUG
    // finding 3270889829.)
    getInstalledModel(userDataDir()),
  );

  ipcMain.handle("runtime:planDownload", async (_event, modelId: string) => {
    const requested = findModelOrThrow(modelId);
    // Use `getInstalledModel`, not `getCurrentModel`, so that a stale
    // `active-model.json` record pointing at a manually-deleted file is
    // treated as "no model installed". Otherwise the planner returns
    // `already-installed` and the UI hides the Download button, forcing
    // the user to click "Delete model" to clear the ghost record.
    // (Devin Review BUG finding 3270859596.)
    const current = await getInstalledModel(userDataDir());
    return planDownload(current, requested);
  });

  /**
   * Bind a destroyed-window-safe sender for an IPC channel.
   *
   * Captures the `BrowserWindow` for `event.sender` at IPC entry and
   * returns a closure that pushes payloads on `channel` to that window.
   * The returned function:
   *
   *   - Skips the send if the window has been destroyed (user closed it,
   *     renderer crashed, etc.). `BrowserWindow.fromWebContents` returned
   *     a truthy JS handle whose native backing Electron has since freed,
   *     so optional-chaining `win?.webContents` does NOT short-circuit
   *     — we need an explicit `isDestroyed()` check.
   *   - try/catches the `.send()` call so a transient IPC failure (queue
   *     overflow, renderer crash mid-stream) cannot propagate up and
   *     short-circuit the caller's outer `try { ... } finally { ... }`
   *     cleanup.
   *
   * This is the long-term-correct shape — every IPC handler that streams
   * results back to the renderer should route its sends through this
   * helper instead of reimplementing the guard pattern. Channels that
   * use it today:
   *
   *   - `runtime:downloadProgress` (the download-progress emitter)
   *   - `model:token` (the `model:generate` SSE stream)
   *
   * (Devin Review BUG findings 3270950107 + 3271137685.)
   */
  function safeRendererSender<T>(
    event: Electron.IpcMainInvokeEvent,
    channel: string,
  ): (payload: T) => void {
    const win = BrowserWindow.fromWebContents(event.sender);
    return (payload: T) => {
      if (!win || win.isDestroyed()) return;
      try {
        win.webContents.send(channel, payload);
      } catch (err) {
        console.warn(
          `[tessera] ${channel} emit failed (continuing): ${(err as Error).message}`,
        );
      }
    };
  }

  function progressEmitter(event: Electron.IpcMainInvokeEvent) {
    return safeRendererSender<DownloadProgress>(event, "runtime:downloadProgress");
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
    //
    // The "already installed AND file on disk" check is delegated to
    // `isModelInstalled` so this IPC fast-path and the
    // `downloadModelLocked` fast-path can't drift in what counts as
    // "installed" (Devin Review finding 3270826130). There is still a
    // window between this check and the actual download in which a
    // concurrent caller could move the file out from under us, but
    // (a) `downloadModelLocked` re-checks under the per-userDataDir
    // lock anyway, and (b) the worst case is an unnecessary sidecar
    // restart, not corruption.
    const installed = await isModelInstalled(userDataDir(), requested.id);
    if (installed) {
      return installed;
    }
    // The sidecar-stop runs INSIDE `withDownloadLock` via the
    // `beforeMutation` deps hook. Previously this call lived here in
    // the IPC handler, BEFORE the lock was acquired, which left a race
    // window: a parallel `runtime:downloadModel` invocation could
    // complete its own download in the gap between our sidecar-stop
    // and lock-acquire, and our subsequent eviction would then delete
    // a model the other tab had just successfully installed. Moving
    // it inside the lock makes the entire (stop → evict → download)
    // sequence atomic per userDataDir. (Devin Review INFO finding
    // f37a3c45.)
    return downloadModel(userDataDir(), requested, progressEmitter(event), {
      beforeMutation: stopSidecarIfRunning,
    });
  });

  ipcMain.handle("runtime:deleteModel", async () => {
    // Sidecar-stop is wired through `beforeMutation` so it runs INSIDE
    // the per-userDataDir lock, after `deleteCurrentModel` has verified
    // that there is actually something to delete. See the
    // `runtime:downloadModel` handler above and the `beforeMutation`
    // doc on `DownloadDeps` for the race-window rationale. (Devin
    // Review INFO finding f37a3c45.)
    await deleteCurrentModel(userDataDir(), {
      beforeMutation: stopSidecarIfRunning,
    });
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
      const artifact = bridge.bridgeGenerateFromTemplate(templateId, sourceIds);
      // Fire any `OnGenerate` automations tied to this template
      // immediately, off the request critical path. Awaiting would
      // make the user wait on downstream re-indexes / cascade
      // generations before the editor opens; we deliberately don't
      // surface dispatch errors back to the caller — they're recorded
      // per-automation via `bridgeRecordAutomationRun` and visible on
      // the Automations page.
      void dispatchOnGenerate(templateId).catch((e) => {
        console.error("[ipc] OnGenerate dispatch failed:", e);
      });
      return artifact;
    },
  );

  ipcMain.handle(
    "artifacts:extractTasksDecisions",
    async (_event, sourceId: string) => {
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      const json = bridge.bridgeExtractTasksDecisions(sourceId);
      // Validate at the IPC boundary so a misbehaving Rust bridge never
      // ships shape-violating data to the renderer. The validator
      // throws on non-array input and on 100%-drop input (unambiguous
      // schema regressions); partial drops return valid items + log a
      // single summary. Logic lives in ./extractedItemValidation so it
      // can be exercised without Electron. (Devin Review BUG finding
      // 3270889925.)
      return validateExtractedItems(JSON.parse(json) as unknown, {
        context: sourceId,
        warn: (message) => console.warn(message),
      });
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

  // --- Tasks ---
  //
  // The bridge expects a JSON-encoded `CreateTaskRequest`/`UpdateTaskRequest`
  // because serde defaults and `Option<Option<...>>` don't round-trip
  // cleanly through napi's auto-generated TS bindings. We accept a typed
  // object from the renderer and re-serialize here, so the renderer sees
  // a normal IPC signature while the bridge keeps its strict Rust
  // deserialization (with `parse_opt_rfc3339` / `parse_opt_source_id`
  // validation surfacing parse errors as IPC rejections — see
  // tessera_bridge::tasks BUG_0001 regression tests).
  ipcMain.handle(
    "tasks:create",
    async (
      _event,
      req: {
        title: string;
        description?: string;
        status?: string;
        priority?: string;
        assignee?: string | null;
        dueDate?: string | null;
        sourceId?: string | null;
        extractedItemId?: string | null;
      },
    ) => {
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      // Map camelCase renderer field names to snake_case the bridge expects.
      const payload: Record<string, unknown> = {
        title: req.title,
        description: req.description ?? "",
        status: req.status ?? "todo",
        priority: req.priority ?? "medium",
        assignee: req.assignee ?? null,
        due_date: req.dueDate ?? null,
        source_id: req.sourceId ?? null,
        extracted_item_id: req.extractedItemId ?? null,
      };
      return bridge.bridgeCreateTask(JSON.stringify(payload));
    },
  );

  ipcMain.handle("tasks:list", async () => {
    const bridge = getBridge();
    if (!bridge) throw new Error("Native bridge not available");
    return bridge.bridgeListTasks();
  });

  ipcMain.handle("tasks:get", async (_event, taskId: string) => {
    const bridge = getBridge();
    if (!bridge) throw new Error("Native bridge not available");
    return bridge.bridgeGetTask(taskId);
  });

  ipcMain.handle(
    "tasks:update",
    async (
      _event,
      taskId: string,
      req: {
        title?: string;
        description?: string;
        status?: string;
        priority?: string;
        position?: number;
        // Tri-state semantics preserved from the bridge:
        //   undefined  -> field unchanged
        //   null       -> explicit clear
        //   string     -> set
        assignee?: string | null;
        dueDate?: string | null;
      },
    ) => {
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      const payload: Record<string, unknown> = {};
      if (req.title !== undefined) payload.title = req.title;
      if (req.description !== undefined) payload.description = req.description;
      if (req.status !== undefined) payload.status = req.status;
      if (req.priority !== undefined) payload.priority = req.priority;
      if (req.position !== undefined) payload.position = req.position;
      // `assignee`/`due_date` use the Option<Option<...>> sentinel pattern
      // on the bridge side. Translate JS undefined/null accordingly:
      //   undefined (key omitted) → field unchanged
      //   null                    → explicit clear -> Some(None)
      //   string                  → set            -> Some(Some(s))
      if (req.assignee !== undefined) payload.assignee = req.assignee;
      if (req.dueDate !== undefined) payload.due_date = req.dueDate;
      return bridge.bridgeUpdateTask(taskId, JSON.stringify(payload));
    },
  );

  ipcMain.handle("tasks:delete", async (_event, taskId: string) => {
    const bridge = getBridge();
    if (!bridge) throw new Error("Native bridge not available");
    return bridge.bridgeDeleteTask(taskId);
  });

  ipcMain.handle(
    "tasks:reorder",
    async (_event, status: string, ids: string[]) => {
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      bridge.bridgeReorderTasks(status, ids);
    },
  );

  // --- Automations ---

  ipcMain.handle(
    "automations:create",
    async (
      _event,
      req: {
        name: string;
        trigger: Record<string, unknown>;
        action: Record<string, unknown>;
        enabled?: boolean;
      },
    ) => {
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      const payload = {
        name: req.name,
        trigger_json: JSON.stringify(req.trigger),
        action_json: JSON.stringify(req.action),
        enabled: req.enabled ?? true,
      };
      return bridge.bridgeCreateAutomation(JSON.stringify(payload));
    },
  );

  ipcMain.handle("automations:list", async () => {
    const bridge = getBridge();
    if (!bridge) throw new Error("Native bridge not available");
    return bridge.bridgeListAutomations();
  });

  ipcMain.handle(
    "automations:get",
    async (_event, automationId: string) => {
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      return bridge.bridgeGetAutomation(automationId);
    },
  );

  ipcMain.handle(
    "automations:setEnabled",
    async (_event, automationId: string, enabled: boolean) => {
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      bridge.bridgeSetAutomationEnabled(automationId, enabled);
    },
  );

  ipcMain.handle(
    "automations:delete",
    async (_event, automationId: string) => {
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      return bridge.bridgeDeleteAutomation(automationId);
    },
  );

  // Scheduler control surface used by the AutomationsPage UI: status
  // (running? in-flight? last error?) + manual "tick now" trigger so
  // the user can verify a freshly-saved schedule without waiting up
  // to `DEFAULT_TICK_MS`.
  ipcMain.handle("automations:schedulerStatus", async () => {
    return getSchedulerStatus();
  });

  // `runNow` always results in a fresh tick observable to the caller:
  // if a tick is already in flight, it waits for it and then runs a
  // new one (see scheduler.ts for the full semantics). This means a
  // user clicking "Run Now" never gets the previous tick's stale
  // status returned to them — the promise only resolves after their
  // requested tick has completed.
  ipcMain.handle("automations:runNow", async () => {
    await schedulerRunNow();
    return getSchedulerStatus();
  });

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
