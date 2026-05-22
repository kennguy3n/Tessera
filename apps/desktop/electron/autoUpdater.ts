/**
 * Auto-update integration for packaged Tessera builds (Phase 10).
 *
 * Uses `electron-updater` to:
 *   1. Check the GitHub Releases feed for a newer version on launch
 *      (only when the user has opted in — `config.autoUpdate`).
 *   2. Download the matching artifact in the background.
 *   3. Surface a renderer notification when the download completes so
 *      the user can pick when to restart.
 *
 * Two design points worth calling out:
 *
 *   - Auto-update is a *no-op in dev*. `app.isPackaged` is false when
 *     Electron is launched with a local renderer (`npm run dev`), and
 *     electron-updater also asserts that — calling
 *     `checkForUpdatesAndNotify` outside a packaged build throws. We
 *     short-circuit before we ever touch the module.
 *
 *   - The renderer never talks to electron-updater directly. All
 *     interactions go through the four IPC handlers exposed by
 *     `registerAutoUpdaterIpc()` so the renderer cannot, e.g., pin
 *     itself to a downgrade URL or smuggle a forged feed.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { loadConfig, updateConfig } from "./config";
import { getLogger } from "./logger";
import { assertBoolean } from "./ipc/validate";

interface UpdateStatusEvent {
  status:
    | "idle"
    | "checking"
    | "available"
    | "not-available"
    | "downloading"
    | "downloaded"
    | "error";
  message?: string;
  /** 0–100 download progress percentage. Only populated for "downloading". */
  percent?: number;
  /** Bytes/sec download rate. Only populated for "downloading". */
  bytesPerSecond?: number;
  /** Semver of the new release, if known. */
  newVersion?: string;
}

let lastStatus: UpdateStatusEvent = { status: "idle" };
let registered = false;

function broadcast(status: UpdateStatusEvent): void {
  lastStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("updates:status", status);
    }
  }
}

/**
 * Minimal logger shape `electron-updater` expects when consumers
 * override `autoUpdater.logger`. Declared explicitly so we can drop
 * a structured-logger adapter onto the updater without the previous
 * `as never` cast, which bypassed type checking entirely and would
 * have silently broken if `electron-updater` ever added a required
 * method (e.g. `verbose`). The shape mirrors `electron-log`'s public
 * `LogFunctions` interface (which `electron-updater`'s own
 * `electron-updater/out/Logger.d.ts` recommends as the canonical
 * reference type). All non-`debug` methods are required; `debug` is
 * optional because production loggers commonly drop debug output
 * for cost reasons and `electron-updater` calls it best-effort.
 *
 * See Devin Review wave 20 ANALYSIS: "autoUpdater.ts uses `as never`
 * type assertion to bypass logger type mismatch".
 */
export interface AutoUpdaterLogger {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
  debug?(message?: unknown): void;
}

interface AutoUpdaterModule {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: AutoUpdaterLogger | null;
  on(event: string, cb: (...args: unknown[]) => void): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

let cachedUpdater: AutoUpdaterModule | null = null;

/**
 * Lazily resolve `electron-updater`. Failures (e.g. running unpackaged
 * in dev, or the module missing in a non-Electron unit-test runtime)
 * are returned to the caller as `null` so they can decide whether to
 * surface a "not supported" status or just silently skip.
 */
function getUpdater(): AutoUpdaterModule | null {
  if (cachedUpdater) return cachedUpdater;
  try {
    // require() (not dynamic import) — this module is CommonJS in the
    // Electron main process and we want the failure to be synchronous.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("electron-updater") as {
      autoUpdater: AutoUpdaterModule;
    };
    const updater = mod.autoUpdater;
    // electron-updater logs to a hard-coded console by default.
    // Redirect to our structured logger so update events end up in the
    // same file the user can ship for diagnostics.
    const adapter: AutoUpdaterLogger = {
      info: (m: unknown) => getLogger().info("autoUpdater", { msg: String(m) }),
      warn: (m: unknown) => getLogger().warn("autoUpdater", { msg: String(m) }),
      error: (m: unknown) =>
        getLogger().error("autoUpdater", { msg: String(m) }),
      debug: () => {
        /* drop — we forward warn/error/info; debug-level chatter is
           intentionally suppressed because electron-updater logs every
           HTTP redirect at debug, which would dwarf user-actionable
           events in `~/.tessera/logs/tessera.log`. */
      },
    };
    updater.logger = adapter;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    cachedUpdater = updater;
    return updater;
  } catch (err) {
    getLogger().warn("autoUpdater.unavailable", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function attachListenersOnce(updater: AutoUpdaterModule): void {
  if (registered) return;
  registered = true;

  updater.on("checking-for-update", () => {
    broadcast({ status: "checking" });
  });
  updater.on("update-available", (info: unknown) => {
    const version =
      info && typeof info === "object" && "version" in info
        ? String((info as { version: unknown }).version)
        : undefined;
    broadcast({ status: "available", newVersion: version });
  });
  updater.on("update-not-available", () => {
    broadcast({ status: "not-available" });
  });
  updater.on("download-progress", (progress: unknown) => {
    if (progress && typeof progress === "object") {
      const p = progress as { percent?: number; bytesPerSecond?: number };
      broadcast({
        status: "downloading",
        percent: p.percent,
        bytesPerSecond: p.bytesPerSecond,
      });
    } else {
      broadcast({ status: "downloading" });
    }
  });
  updater.on("update-downloaded", (info: unknown) => {
    const version =
      info && typeof info === "object" && "version" in info
        ? String((info as { version: unknown }).version)
        : undefined;
    broadcast({ status: "downloaded", newVersion: version });
  });
  updater.on("error", (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    broadcast({ status: "error", message });
  });
}

/**
 * Called once during `app.whenReady()`. Hooks the updater listeners
 * and, if the user has opted in, triggers an initial check.
 *
 * Safe to call in dev — the function early-returns when
 * `app.isPackaged` is false.
 */
export function initAutoUpdater(): void {
  if (!app.isPackaged) {
    return;
  }
  const updater = getUpdater();
  if (!updater) return;
  attachListenersOnce(updater);
  const config = loadConfig();
  if (config.autoUpdate) {
    updater.checkForUpdates().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      broadcast({ status: "error", message });
    });
  }
}

/**
 * Register the four `updates:*` IPC channels (called by the central
 * `registerIpcHandlers()` so the auto-updater integrates with the
 * same lifecycle as every other IPC surface).
 */
export function registerAutoUpdaterIpc(): void {
  // Idempotent registration. ipcMain.handle throws if a channel is
  // already registered, which would crash on the second call (e.g.
  // a test that mounts the IPC layer twice, or a hot-reload path).
  // Removing first makes registration safe regardless of prior state
  // and removes any reliance on a test-only `_resetForTests` helper
  // to keep things in sync.
  const channels = [
    "updates:status",
    "updates:check",
    "updates:install",
    "updates:getAutoUpdateEnabled",
    "updates:setAutoUpdateEnabled",
  ];
  for (const ch of channels) {
    try {
      ipcMain.removeHandler(ch);
    } catch {
      // Channel wasn't registered yet; ignore.
    }
  }

  ipcMain.handle("updates:status", async () => lastStatus);

  ipcMain.handle("updates:check", async () => {
    if (!app.isPackaged) {
      const status: UpdateStatusEvent = {
        status: "not-available",
        message: "Auto-update is disabled in development builds",
      };
      lastStatus = status;
      return status;
    }
    const updater = getUpdater();
    if (!updater) {
      const status: UpdateStatusEvent = {
        status: "error",
        message: "electron-updater module is unavailable",
      };
      lastStatus = status;
      return status;
    }
    attachListenersOnce(updater);
    try {
      await updater.checkForUpdates();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status: UpdateStatusEvent = { status: "error", message };
      lastStatus = status;
      return status;
    }
    return lastStatus;
  });

  ipcMain.handle("updates:install", async () => {
    const updater = getUpdater();
    if (!updater) {
      return { ok: false, message: "Updater unavailable" };
    }
    // quitAndInstall throws if no update is staged — guard explicitly
    // so we return a structured error rather than crashing the main
    // process.
    if (lastStatus.status !== "downloaded") {
      return {
        ok: false,
        message: `No update is ready to install (current status: ${lastStatus.status})`,
      };
    }
    updater.quitAndInstall();
    return { ok: true };
  });

  ipcMain.handle("updates:getAutoUpdateEnabled", async () => {
    return loadConfig().autoUpdate;
  });

  ipcMain.handle(
    "updates:setAutoUpdateEnabled",
    async (_event, enabled: unknown) => {
      // Match the validator pattern every other IPC handler uses
      // (handlers.ts assertString / assertProvider / etc.). The
      // previous `Boolean(enabled)` coercion happened to be safe, but
      // mixing coercion with assertion across the surface makes it
      // harder to reason about what "validated" means — a renderer
      // bug that passes `"true"` (string) would silently set the
      // config to `true` under coercion, while every other handler
      // would reject it loudly. Reject loudly here too. See Devin
      // Review wave 10 ANALYSIS_0004.
      const value = assertBoolean(enabled, "enabled");
      updateConfig({ autoUpdate: value });
      return loadConfig().autoUpdate;
    },
  );
}

/**
 * Exported for unit testing — lets us reset state between runs.
 * Tests should call this from `beforeEach`; the IPC handler
 * registration itself is now idempotent (see `registerAutoUpdaterIpc`)
 * so forgetting to call this won't crash subsequent registration
 * attempts, only leak event listeners on the cached updater module.
 */
export function _resetForTests(): void {
  registered = false;
  cachedUpdater = null;
  lastStatus = { status: "idle" };
}
