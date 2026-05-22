import { app, BrowserWindow, safeStorage, session } from "electron";
import * as path from "path";
import { registerIpcHandlers } from "./ipc";
import { loadConfig, saveWindowState } from "./config";
import { initAppState } from "./appState";
import { detectComputeBackends } from "./modelManagement";
import { startScheduler, stopScheduler } from "./scheduler";
import { getLogger } from "./logger";
import { initAutoUpdater } from "./autoUpdater";
import { cspImageSources } from "./cspImageSources";
import { initPasswordVaultIfNeeded, passwordVaultSaltExists } from "./passwordVault";

let mainWindow: BrowserWindow | null = null;

// Catch otherwise-unhandled errors so they end up on disk instead of
// silently crashing the renderer. We deliberately do NOT call
// `app.quit()` here because losing the window kills any in-progress
// user edit — the user would much rather see the crash logged and
// keep their session.
process.on("uncaughtException", (err) => {
  getLogger().error("uncaughtException", {
    message: err.message,
    stack: err.stack,
  });
});
process.on("unhandledRejection", (reason) => {
  getLogger().error("unhandledRejection", {
    reason: reason instanceof Error ? reason.stack : String(reason),
  });
});

function createWindow(): void {
  const config = loadConfig();

  mainWindow = new BrowserWindow({
    width: config.windowWidth,
    height: config.windowHeight,
    x: config.windowX,
    y: config.windowY,
    minWidth: 900,
    minHeight: 600,
    title: "Tessera",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const isDev = !app.isPackaged;

  const connectSrc = isDev
    ? "connect-src 'self' ws://localhost:5173 http://localhost:5173"
    : "connect-src 'self'";
  session.defaultSession.webRequest.onHeadersReceived((_details, callback) => {
    callback({
      responseHeaders: {
        ..._details.responseHeaders,
        "Content-Security-Policy": [
          // img-src enumerates the image CDNs of each first-class
          // connected provider rather than the previous wildcard
          // `https:` which would allow any HTTPS host. The list is
          // tracked in `apps/desktop/electron/cspImageSources.ts` so
          // adding a new connector requires explicitly widening the
          // allow-list in one place. Browser/tab tracking pixels,
          // analytics beacons, and the long-tail of arbitrary HTTPS
          // image hosts that don't belong to a connected provider
          // are blocked. Scripts and connect-src remain locked to
          // 'self', so this only narrows the previous policy.
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: ${cspImageSources.join(" ")}; ${connectSrc}`,
        ],
      },
    });
  });
  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    // The Electron main bundle is emitted to
    // `apps/desktop/dist-electron/electron/` (see `tsconfig.electron.json`
    // — `rootDir: "."` + `include: ["electron", "shared"]` gives the
    // compiler a sibling-rooted layout) and the renderer bundle is
    // emitted to `apps/desktop/renderer-dist/` (see `vite.config.ts`
    // `build.outDir`). At runtime `__dirname` resolves to the directory
    // containing the running `main.js`, i.e. `…/dist-electron/electron/`,
    // so the renderer entrypoint is two levels up at
    // `../../renderer-dist/index.html`.
    // The four `packaging/**/electron-builder*.yml` configs ship both
    // `dist-electron/**/*` and `renderer-dist/**/*`, so this path is
    // correct both when running `electron .` against a local
    // `npm run build` and inside the packaged AppImage / .deb / .rpm /
    // .dmg / .exe artifacts.
    mainWindow.loadFile(path.join(__dirname, "../../renderer-dist/index.html"));
  }

  mainWindow.on("close", () => {
    if (mainWindow) {
      const bounds = mainWindow.getBounds();
      saveWindowState({
        windowX: bounds.x,
        windowY: bounds.y,
        windowWidth: bounds.width,
        windowHeight: bounds.height,
      });
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/**
 * If the OS keyring is unavailable (typically headless Linux without
 * gnome-keyring / kwallet), prompt the user for a vault password and
 * cache the derived key for the session. This unlocks the password
 * fallback in `tokenVault.ts` / `secretsVault.ts` so OAuth tokens
 * and external-provider API keys stay encrypted at rest.
 *
 * Behaviour:
 * - safeStorage available → no-op (existing flow)
 * - safeStorage unavailable, existing vault salt on disk → prompt
 *   for the existing password (single field, no confirm)
 * - safeStorage unavailable, fresh install → prompt for a NEW
 *   password (with confirm field)
 * - User closes the prompt without entering a password → log
 *   warning, continue; vault writes will throw with the actionable
 *   "keyring unavailable" message and reads of password-vault blobs
 *   will fail with a clear "no password cached" message
 *
 * The prompt is shown BEFORE registerIpcHandlers / startScheduler /
 * createWindow so the rest of the app can safely treat the vault as
 * ready (or unambiguously unavailable) without race conditions.
 */
async function maybeInitPasswordVault(): Promise<void> {
  if (safeStorage.isEncryptionAvailable()) return;
  try {
    await initPasswordVaultIfNeeded({
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      existingVault: passwordVaultSaltExists(),
    });
    console.log(
      "[Tessera] Password vault unlocked — OAuth tokens and secrets will be encrypted with the user-supplied password.",
    );
  } catch (err) {
    console.warn(
      "[Tessera] Password vault prompt declined or failed — token / secret writes will fail until the vault is unlocked or the OS keyring becomes available.",
      err,
    );
  }
}

app.whenReady().then(async () => {
  initAppState();
  await maybeInitPasswordVault();
  registerIpcHandlers();
  // Start the automations scheduler. Runs in the main process and
  // ticks every 30s, dispatching due `Schedule` automations directly
  // against the native bridge (i.e. without bouncing through the
  // renderer). See `scheduler.ts` for the run-control protocol.
  startScheduler();
  createWindow();
  // Kick off the auto-update check. No-op in dev (app.isPackaged ==
  // false) and silently disabled when the user has unchecked
  // "Automatically check for updates" in Settings.
  initAutoUpdater();

  // Warm the hardware-detection cache off the critical path. The first
  // call to `detectComputeBackends()` issues `execFileSync` probes for
  // `nvidia-smi`, `vulkaninfo`, and `/opt/rocm` — each up to ~3s — and
  // the result is memoised for the lifetime of the process (see
  // `modelManagement.ts` cache block). Running it once on app-ready
  // means the *first* model-related IPC the user triggers (Settings ->
  // open Model Runtime card, Recommend Model, etc.) doesn't block the
  // main process for several seconds at the exact moment the user is
  // waiting on it. We schedule via `setImmediate` so the first paint
  // of the BrowserWindow runs to completion before the synchronous
  // probes start; the probes then block only the idle event-loop tick
  // before any user interaction.
  setImmediate(() => {
    try {
      detectComputeBackends();
    } catch (err) {
      // Cache warm-up is best-effort. If hardware probes throw (extremely
      // unlikely — they already swallow exec failures internally), the
      // first real IPC call will retry. We log so platform-specific
      // failures (e.g. a sandbox blocking exec) are visible in dev.
      console.warn(
        `[tessera] hardware-detection cache warm-up failed (continuing): ${(err as Error).message}`,
      );
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Guard against the deferred-quit dance re-entering: when we call
// `app.quit()` from inside the `will-quit` handler, Electron re-emits
// `will-quit` and we'd loop infinitely without this flag.
// We deliberately hook `will-quit` rather than `before-quit` because
// `before-quit` fires before any cancellation handlers (renderer
// "are you sure?" dialogs, future plugin quit-blockers, etc.) get a
// chance to call `event.preventDefault()`. If we tore the scheduler
// down on `before-quit` and the quit was then cancelled, we'd be left
// with a running app and a stopped scheduler. `will-quit` fires only
// after every other listener has agreed to quit, so by the time we
// stop the scheduler we know the process is committed to terminating.
let schedulerShutdownStarted = false;

app.on("will-quit", (event) => {
  if (schedulerShutdownStarted) return;
  schedulerShutdownStarted = true;
  // Stop the interval immediately so no NEW ticks start, then wait
  // for any in-flight tick (and its queued follow-up) to finish before
  // tearing down the process. Without this, a slow re-index running
  // when the user quits would have its bridge calls race process
  // teardown, producing an ugly panic on slow disks. We use the
  // `event.preventDefault()` + deferred `app.quit()` pattern Electron
  // documents for async cleanup in quit handlers.
  event.preventDefault();
  void (async () => {
    try {
      await stopScheduler();
    } catch (e) {
      // We're already on the quit path — log and continue rather than
      // hang the process indefinitely on a misbehaving tick.
      console.error("[tessera] scheduler shutdown failed:", e);
    } finally {
      app.quit();
    }
  })();
});
