import { app, BrowserWindow, session } from "electron";
import * as path from "path";
import { registerIpcHandlers } from "./ipc";
import { loadConfig, saveWindowState } from "./config";
import { initAppState } from "./appState";
import { detectComputeBackends } from "./modelManagement";
import { startScheduler, stopScheduler } from "./scheduler";

let mainWindow: BrowserWindow | null = null;

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
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; ${connectSrc}`,
        ],
      },
    });
  });
  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    // The Electron main bundle is emitted to `apps/desktop/dist-electron/`
    // (see `tsconfig.electron.json` `outDir`) and the renderer bundle is
    // emitted to `apps/desktop/renderer-dist/` (see `vite.config.ts`
    // `build.outDir`). At runtime `__dirname` resolves to the directory
    // containing the running `main.js`, i.e. `…/dist-electron/`, so the
    // renderer entrypoint is one level up at `../renderer-dist/index.html`.
    // The four `packaging/**/electron-builder*.yml` configs ship both
    // directories under those exact names, so this path is correct both
    // when running `electron .` against a local `npm run build` and inside
    // the packaged AppImage / .deb / .rpm / .dmg / .exe artifacts.
    mainWindow.loadFile(
      path.join(__dirname, "../renderer-dist/index.html"),
    );
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

app.whenReady().then(() => {
  initAppState();
  registerIpcHandlers();
  // Start the automations scheduler. Runs in the main process and
  // ticks every 30s, dispatching due `Schedule` automations directly
  // against the native bridge (i.e. without bouncing through the
  // renderer). See `scheduler.ts` for the run-control protocol.
  startScheduler();
  createWindow();

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
  // before any user interaction. (Devin Review INFO finding
  // b10fe43e — synchronous execFileSync inside async IPC handlers.)
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

app.on("before-quit", () => {
  // Stop the scheduler before the process exits so an in-flight tick
  // doesn't outlive the bridge's mutexes (the panic that produces is
  // ugly and would scare users on slow disks).
  stopScheduler();
});
