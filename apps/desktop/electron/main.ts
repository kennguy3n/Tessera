import { app, BrowserWindow, ipcMain, safeStorage, session } from "electron";
import * as path from "path";
import { registerIpcHandlers } from "./ipc";
import { replayPersistedHybridSearchConfigToBridge } from "./ipc/settings";
import { loadConfig, saveWindowState } from "./config";
import { initAppState, stopAllSidecars, getBridge } from "./appState";
import { detectComputeBackends } from "./modelManagement";
import { reapOrphanedSidecars } from "./sidecarPidRegistry";
import { startScheduler, stopScheduler } from "./scheduler";
import { startBatteryMonitor, stopBatteryMonitor } from "./batteryMonitor";
import { getLogger } from "./logger";
import {
  markEnd,
  markStart,
  logStartupPerfTable,
  coldStartTotalMs,
} from "./startupPerf";
import {
  BRIDGE_STATE_GET_CHANNEL,
  getBridgeStateSnapshot,
  setBridgeState,
} from "./bridgeLifecycle";
// `./autoUpdater` is loaded dynamically inside `whenReady()` (see
// `initAutoUpdater()` call site). Task 1: it pulls in
// `electron-updater` (which itself imports `js-yaml` + `xml2js` +
// http transport), is a no-op in dev (`app.isPackaged === false`),
// and is never needed on the critical-path window-show. Deferring
// the require keeps the cold-start V8 init off the boot wire.
import { cspImageSources } from "./cspImageSources";
import { buildCsp, generateCspNonce } from "./csp";
import {
  registerAssetProtocolScheme,
  registerAssetProtocolHandler,
  assertAssetProtocolSchemeRegistered,
  TESSERA_ASSET_SCHEME,
} from "./assetProtocol";
import {
  initPasswordVaultIfNeeded,
  passwordVaultSaltExists,
  VAULT_INACTIVE_SAFE_STORAGE_AVAILABLE,
} from "./passwordVault";
import {
  attachKchatDeeplinkBridge,
  buildLocalApiHandlers,
  detachKchatDeeplinkBridge,
  getKchatDeeplinkBridge,
  startKchatLocalApiServer,
  stopKchatLocalApiServer,
} from "./appState";
import {
  DeeplinkBridge,
  registerProtocolClient,
} from "./kchat/kchatDeeplinkBridge";

// LW-4: cap the V8 old-space (the GC-managed JS heap) at 512 MB so a
// long session that accumulates document models, fiber trees, and
// cached IPC payloads cannot let the renderer heap balloon unbounded —
// the cap makes V8 collect more aggressively as it approaches the
// ceiling instead of growing RSS. `js-flags` is the only mechanism
// Electron exposes for renderer V8 tuning (there is no per-`BrowserWindow`
// `webPreferences` knob for `--max-old-space-size`), and it must be set
// before `app` is ready, hence this module-top-level call.
//
// It applies process-wide (main + renderers), which is intentional and
// safe: the heavy substrate state lives in the N-API addon's *native*
// Rust allocations, which are off-heap and unaffected by this V8 limit,
// and the main process itself holds very little long-lived JS. 512 MB
// is comfortably above the renderer's working set (well under the
// ≤200 MB idle RSS target, which counts native + heap) while still
// catching runaway growth.
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=512");

// `tessera-asset://` must be registered as a privileged scheme
// BEFORE `app.whenReady` fires — Electron's
// `protocol.registerSchemesAsPrivileged` is a one-shot, ready-state
// gated API. Doing it at module top-level (synchronously, after the
// imports above) puts the call ahead of the `whenReady` chain at the
// bottom of this file. The actual request handler (`protocol.handle`)
// is registered later inside the `whenReady` callback, after the
// user-data directory is known.
registerAssetProtocolScheme();

// register `tessera://` as the default protocol
// handler for this app binary at module load — Electron requires
// `setAsDefaultProtocolClient` to run before `app.whenReady`.
//
// The companion `attachKchatDeeplinkBridge()` call (which wires the
// `open-url` and `second-instance` listeners) is also at module
// top-level, immediately after this block — see the comment on that
// call below for the macOS cold-start rationale. Both calls share
// the same "must run before whenReady" constraint, and they sit
// together at module load so the registration and the dispatch
// listeners can never end up on opposite sides of the ready boundary.
//
// Dev mode (no Electron installer) needs an extra `args` hint so
// the OS knows how to invoke the dev binary; in packaged builds
// `process.argv[1]` is the resource path and is ignored.
if (process.defaultApp && process.argv.length >= 2) {
  registerProtocolClient(app, {
    execPath: process.execPath,
    args: [path.resolve(process.argv[1])],
  });
} else {
  registerProtocolClient(app);
}

// attach the `tessera://` deeplink listeners at
// module top-level — BEFORE `app.whenReady()` resolves. macOS Cocoa
// fires `open-url` very early on cold-start launches triggered by
// a `tessera://` click (the OS launches Tessera *because of* the
// URL), and that event can land before `whenReady` runs the callback
// at the bottom of this file. If the listener is only attached inside
// `whenReady`, Electron's default `open-url` handling runs and the
// URL is silently dropped — the `DeeplinkBridge`'s pre-ready parking
// queue (constructed at `appState.ts` module load) never sees it.
//
// Attaching here mirrors the `setAsDefaultProtocolClient` call above,
// which has the same "must run before whenReady" constraint. The
// `second-instance` listener that `attachKchatDeeplinkBridge` also
// wires is harmless to register early: it only fires on the primary
// instance, which by definition has already passed module-load. The
// bridge consumer is registered later by the renderer; parsed routes
// are parked in the bridge's queue and flushed in FIFO order on
// consumer registration.
attachKchatDeeplinkBridge();

// claim the single-instance lock so the
// Windows/Linux `second-instance` path can pluck `tessera://`
// URLs out of the spawned process's argv. Without this, a
// second launch would silently start a new Electron process
// instead of forwarding the deeplink to the already-running
// primary. macOS uses `open-url` instead and is unaffected by
// this lock.
const acquiredSingleInstanceLock = app.requestSingleInstanceLock();
if (!acquiredSingleInstanceLock) {
  // A primary instance is already running; let it pick up the
  // argv (the OS will fire `second-instance` on the primary).
  // Calling `app.quit()` here is the documented Electron
  // pattern — `whenReady` never resolves in this process.
  app.quit();
} else {
  // scan THIS process's
  // own argv for a `tessera://` URL. On Windows + Linux, when the
  // user clicks a deeplink and Tessera is NOT already running, the
  // OS launches Tessera with the URL appended to `process.argv` —
  // there is no `open-url` event (that's macOS only) and there is
  // no `second-instance` event (that fires on the PRIMARY when a
  // SECOND instance starts later). The primary instance has to
  // pluck the URL out of its own argv during cold-start or the
  // deeplink is silently dropped: Tessera launches, but no
  // navigation happens.
  //
  // macOS is unaffected: Cocoa delivers cold-start URLs via
  // `open-url`, which `attachKchatDeeplinkBridge()` above already
  // wires. Windows/Linux WARM-start is also unaffected: a second
  // launch fires `second-instance` on the primary, which the same
  // bridge handles.
  //
  // The bridge's parking queue (constructed at `appState.ts`
  // module load) holds the parsed route until the renderer
  // consumer registers later in the `whenReady` chain. Calling
  // `ingestRawUrl` here is safe at module load — the bridge
  // exists, and pre-ready routes are exactly what its queue is
  // for.
  const initialDeeplinkUrl = DeeplinkBridge.extractUrlFromArgv(process.argv);
  if (initialDeeplinkUrl !== null) {
    getKchatDeeplinkBridge().ingestRawUrl(initialDeeplinkUrl);
  }
}

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

/**
 * Install the session-level Content-Security-Policy handler. Called
 * exactly once from `app.whenReady` — NOT from `createWindow()`.
 *
 * The CSP is registered on `session.defaultSession.webRequest`, which
 * is a process-wide singleton: a single registration applies to every
 * `BrowserWindow` created against the default session, including the
 * password-prompt window opened by `maybeInitPasswordVault` BEFORE
 * the main window exists, and any future re-creation of the main
 * window via the `app.on("activate")` macOS path.
 *
 * Previously this was registered inside `createWindow()`. Each call
 * to `onHeadersReceived` replaces the previous handler (it's not
 * additive) so duplication was harmless, but the per-window
 * registration created two subtle smells:
 *
 *   1. The password-prompt window (opened before `createWindow()`)
 *      had no CSP applied to its requests at all. The prompt loads
 *      a `data:` URL which Electron's `webRequest` does not fire
 *      `onHeadersReceived` for, so the practical effect was zero —
 *      but a future change to file:// or http:// loading for the
 *      prompt would have silently bypassed the policy.
 *   2. On macOS, `app.on("activate")` re-runs `createWindow()` when
 *      the user clicks the dock icon after closing every window.
 *      The per-call re-registration was redundant work.
 *
 * Hoisting to `app.whenReady` is the structurally correct fix: the
 * CSP is now a session-level invariant established before any
 * BrowserWindow is constructed.
 */
/**
 * Per-session CSP nonce. Generated exactly once at `app.whenReady`
 * time (see `installContentSecurityPolicy` call site) so:
 *
 *   1. The same nonce can be passed to the CSP header AND threaded
 *      through `webPreferences.additionalArguments` so the preload
 *      script can expose it to the renderer.
 *   2. Re-loads of the renderer (devtools refresh, `app.activate`
 *      re-mount on macOS) reuse the same nonce — the CSP header is
 *      re-emitted on every response and would not match a freshly
 *      rotated nonce that the (already-loaded) preload still held.
 *   3. Per-session is enough — there is no cross-session attacker
 *      in our threat model. The nonce's job is to make a future
 *      regression that introduces `'unsafe-inline'` impossible at
 *      the CSP layer, not to defeat a same-origin XSS chain (we
 *      already disallow `eval`, inline scripts, and arbitrary HTML
 *      rendering of untrusted strings).
 */
let cspNonce = "";

export function getCspNonce(): string {
  return cspNonce;
}

/**
 * Cold-start perf smoke mode, toggled by `TESSERA_PERF_SMOKE=1`.
 *
 * Used only by the CI cold-start gate (`scripts/coldStartGate.mjs` →
 * `.github/workflows/ci.yml`) to measure boot-to-first-render without
 * a human at the keyboard. When enabled the boot path:
 *
 *   - loads the *built* renderer bundle (`renderer-dist/index.html`)
 *     instead of the Vite dev server, since the gate runs against a
 *     production `npm run build` and there is no dev server to attach
 *     to (see `createWindow`); and
 *   - skips the interactive password-vault prompt that would
 *     otherwise block forever on a headless runner with no OS keyring
 *     (see `maybeInitPasswordVault`); and
 *   - prints a single machine-readable `TESSERA_COLD_START_MS=<n>`
 *     line and quits once the first frame is shown (see the
 *     `ready-to-show` handler in `createWindow`).
 *
 * It changes NOTHING in a normal run — every guard is behind this
 * env check — so it cannot affect production startup behaviour.
 */
const PERF_SMOKE = process.env.TESSERA_PERF_SMOKE === "1";

function installContentSecurityPolicy(): void {
  // The CSP `img-src` widening below includes `tessera-asset:` as a
  // recognised source. Chromium will silently strip that source if
  // the scheme is not registered as privileged before the app's
  // ready state resolves — at which point every
  // `<img src="tessera-asset://generated-images/...">` would fail
  // with no obvious error in the log. Devin Review PR #38 pass-N 📝
  // finding `ANALYSIS_pr-review-job-7e44dd41…_0005` correctly noted
  // the dependency was comment-documented but not programmatically
  // enforced; this assertion makes the dependency a startup-time
  // invariant. If a future refactor deletes the
  // `registerAssetProtocolScheme()` call at the top of this file,
  // the app fails fast at boot with an explicit error rather than
  // shipping a renderer that silently 403s every generated image.
  assertAssetProtocolSchemeRegistered();

  const isDev = !app.isPackaged;
  // Generate the per-session nonce on first install. Subsequent
  // calls (none today, but guard for future re-init) reuse the
  // existing value so the renderer's exposed nonce stays valid.
  if (!cspNonce) {
    cspNonce = generateCspNonce();
  }
  const cspHeaderValue = buildCsp({
    isDev,
    nonce: cspNonce,
    imageSources: cspImageSources,
    assetScheme: TESSERA_ASSET_SCHEME,
  });
  session.defaultSession.webRequest.onHeadersReceived((_details, callback) => {
    callback({
      responseHeaders: {
        ..._details.responseHeaders,
        // img-src enumerates the image CDNs of each first-class
        // connected provider via `cspImageSources` rather than the
        // wildcard `https:` that would allow any HTTPS host. See
        // `apps/desktop/electron/cspImageSources.ts` for the
        // single source of truth. `tessera-asset:` is the custom
        // protocol registered by `assetProtocol.ts` that serves
        // generated-image files under `<userData>/generated-images/`.
        // The protocol handler enforces a strict prefix check so
        // this `img-src` widening cannot be abused to read arbitrary
        // disk paths. See `csp.ts::buildCsp` for the full directive
        // rationale (script/style nonce, defense-in-depth directives).
        "Content-Security-Policy": [cspHeaderValue],
      },
    });
  });
}

/**
 * Open the main application window.
 *
 * Idempotent on the `mainWindow` module-level reference: if a main
 * window already exists and has not been closed (its `closed` handler
 * nulls the reference), return without creating a second one.
 *
 * This idempotency is load-bearing for the macOS dock-click recovery
 * path: the `app.on("activate", ...)` listener is registered BEFORE
 * `await maybeInitPasswordVault()` so a dock click during the
 * password prompt is not silently dropped. If the activate listener
 * fires during the brief window between the prompt closing and
 * `whenReady` resuming, it calls `createWindow()` early — which then
 * makes the subsequent unconditional `createWindow()` call at the
 * end of `whenReady` a safe no-op. Without this guard, the early
 * activate would leave the user with a duplicate main window.
 *
 * Note: the password-prompt window is a separate `BrowserWindow`
 * that does NOT touch `mainWindow`, so the check here correctly
 * distinguishes "main window already open" from "any window open".
 */
function createWindow(): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    // Already open from a previous call (e.g. activate listener
    // fired first). Bring it to the foreground so the user-visible
    // result of "click dock icon" is consistent with the macOS
    // expectation of bringing the app's window forward.
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }
  markStart("window-show");
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
      // Thread the per-session nonce through to the preload script
      // so it can `contextBridge.exposeInMainWorld("tesseraCspNonce",
      // …)` for the renderer's `<style nonce={…}>` blocks. We pass
      // it as `--tessera-csp-nonce=<value>` rather than a plain
      // value so the preload can grep `process.argv` by prefix
      // without depending on positional order.
      additionalArguments: [`--tessera-csp-nonce=${cspNonce}`],
    },
  });

  // Record the window-show measure on `ready-to-show` (the standard
  // Electron signal for "the renderer has produced its first paint")
  // rather than on `BrowserWindow` construction, which only allocates
  // the native handle. Then surface the full boot-perf table to the
  // logger so cold-start regressions are visible without attaching a
  // profiler. The handler is `once` so re-loads (devtools refresh)
  // don't accumulate measures.
  mainWindow.once("ready-to-show", () => {
    markEnd("window-show");
    try {
      logStartupPerfTable((event, payload) => {
        getLogger().info(event, payload);
      });
    } catch (err) {
      // Logging the perf table is best-effort; never crash startup.
      console.warn(
        "[Tessera] startup-perf log failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    if (PERF_SMOKE) {
      // First frame is on screen: this is the boot-to-first-render
      // instant. Emit the total cold-start duration on a single
      // machine-readable line for `scripts/coldStartGate.cjs` to
      // parse, then tear the process down.
      //
      // `app.exit(0)`, NOT `app.quit()`: quit runs the async
      // `will-quit` sidecar-cleanup path (event.preventDefault() +
      // deferred re-quit). On a headless runner with no bridge and no
      // sidecars that path can leave the process lingering after the
      // marker is already on stdout, so the gate would sit out its
      // whole timeout waiting for an exit that comes minutes later.
      // `app.exit` skips before-quit/will-quit and terminates at once
      // — the right semantics for a one-shot boot probe. The write
      // callback flushes the marker to the pipe before we exit so the
      // line is never truncated.
      const totalMs = coldStartTotalMs();
      process.stdout.write(
        `TESSERA_COLD_START_MS=${totalMs === null ? "null" : totalMs.toFixed(2)}\n`,
        () => app.exit(0),
      );
    }
  });

  // In perf-smoke mode load the built renderer bundle, not the Vite
  // dev server: the cold-start gate runs against `npm run build`
  // output with no dev server listening on :5173, and pointing at a
  // dead URL would never fire `ready-to-show`.
  const isDev = !app.isPackaged && !PERF_SMOKE;
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

  // LW-4: tell the renderer to pause/resume its recurring polls when the
  // window's visibility changes. `hide` covers minimize-to-tray (LW-9)
  // and macOS `app.hide()`; `minimize` covers the taskbar/dock minimize.
  // `show`/`restore` are the inverse. We route every event through
  // `setRendererSuspended`, which de-dupes via a transition flag so the
  // renderer never receives a redundant suspend-while-suspended or a
  // resume it didn't need (e.g. the `show` that fires on first paint).
  mainWindow.on("hide", () => setRendererSuspended(true));
  mainWindow.on("minimize", () => setRendererSuspended(true));
  mainWindow.on("show", () => setRendererSuspended(false));
  mainWindow.on("restore", () => setRendererSuspended(false));
}

/**
 * Whether the renderer is currently in the suspended (window-hidden)
 * state. Module-scoped so {@link setRendererSuspended} can emit the
 * `app:suspend` / `app:resume` IPC only on an actual transition — the
 * underlying BrowserWindow events (`hide`/`minimize`/`show`/`restore`)
 * can fire redundantly (e.g. `show` on first paint, or `minimize`
 * followed by `hide`), and the renderer should see one clean edge.
 */
let rendererSuspended = false;

function setRendererSuspended(suspended: boolean): void {
  if (suspended === rendererSuspended) return;
  rendererSuspended = suspended;
  // `mainWindow` may already be torn down (`closed`) when a late event
  // arrives; `isDestroyed()` guards the webContents access.
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(suspended ? "app:suspend" : "app:resume");
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
 * Ordering inside `app.whenReady`:
 *
 *   - `registerIpcHandlers` runs BEFORE this prompt awaits. This is a
 *     defense-in-depth move for the macOS dock-click recovery path:
 *     if Cocoa fires `activate` during the prompt and the listener
 *     creates the main window synchronously, the renderer it loads
 *     must find every `ipcRenderer.invoke(...)` channel already
 *     wired. Registering handlers earlier than the vault prompt is
 *     safe because handlers do not read vault state at registration
 *     time — they consult vault state lazily when invoked. See the
 *     inline comment at the `registerIpcHandlers()` call site in
 *     `whenReady` for the full rationale.
 *   - `startScheduler` and `createWindow` run AFTER this prompt
 *     resolves. The scheduler ticks every 30s and may need to read
 *     OAuth tokens (which live in the password-vault on keyringless
 *     platforms), and `createWindow` loads the renderer which may
 *     immediately invoke vault-dependent IPCs on startup — both
 *     therefore wait for the vault to be ready (or unambiguously
 *     unavailable) before they start.
 */
async function maybeInitPasswordVault(): Promise<void> {
  // The cold-start gate runs on a headless runner with no OS keyring,
  // so `safeStorage` is unavailable and the prompt below would open a
  // BrowserWindow and block forever waiting for input. Skip it: the
  // gate only measures boot-to-first-render and never touches a
  // vault-encrypted secret.
  if (PERF_SMOKE) return;
  if (safeStorage.isEncryptionAvailable()) return;
  try {
    // Inspect the `{ active, reason? }` result rather than treating
    // any non-throw as success. The outer `safeStorage.isEncryptionAvailable()`
    // guard at the top of this function makes the `active=false`
    // branch unreachable in practice (the inner check inside
    // `initPasswordVaultIfNeeded` would only short-circuit if keyring
    // availability flipped between the two checks — TOCTOU window),
    // but pinning the result-shape here keeps this caller
    // self-documenting and future-proof against either: (a) the
    // outer guard being removed, (b) `initPasswordVaultIfNeeded`
    // adding a new "skipped because <reason>" path. The success log
    // now only fires when the vault is actually unlocked.
    const result = await initPasswordVaultIfNeeded({
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      existingVault: passwordVaultSaltExists(),
    });
    if (result.active) {
      console.log(
        "[Tessera] Password vault unlocked — OAuth tokens and secrets will be encrypted with the user-supplied password.",
      );
    } else if (result.reason === VAULT_INACTIVE_SAFE_STORAGE_AVAILABLE) {
      // TOCTOU race: the OS keyring daemon became available between
      // the outer `safeStorage.isEncryptionAvailable()` guard at the
      // top of this function and the inner re-check inside
      // `initPasswordVaultIfNeeded`. This is NOT a vault failure —
      // safeStorage is now available so the existing OS-keyring path
      // takes over; the password vault is simply not needed. The
      // previous unconditional warning ("token / secret writes will
      // fail until the vault is unlocked or the OS keyring becomes
      // available") was actively misleading here because the keyring
      // IS available.
      console.log(
        "[Tessera] OS keyring became available during startup — " +
          "using safeStorage; password vault not needed.",
      );
    } else {
      // Other `active=false` reasons (today none exist, but the type
      // signature accommodates future ones e.g. "prompt suppressed by
      // policy") still warrant the "writes will fail" warning because
      // safeStorage was unavailable AND the password vault did not
      // unlock. The `result.reason` (if any) is included to aid
      // debugging.
      console.warn(
        "[Tessera] Password vault prompt completed without activating the vault" +
          (result.reason ? ` (${result.reason})` : "") +
          " — token / secret writes will fail until the vault is unlocked or the OS keyring becomes available.",
      );
    }
  } catch (err) {
    console.warn(
      "[Tessera] Password vault prompt declined or failed — token / secret writes will fail until the vault is unlocked or the OS keyring becomes available.",
      err,
    );
  }
}

/**
 * Listen on every WebContents created in the app and surface CSP
 * violations to the main-process stderr as `[Tessera CSP]` warnings.
 *
 * Background: when the user pastes an arbitrary image URL into a
 * Base record (`apps/desktop/renderer/src/editors/baseviews/GalleryView.tsx`
 * renders it from a configured `url` field), or when a future feature
 * loads a third-party asset, the CSP narrowing in `cspImageSources.ts`
 * may block it. Chromium emits `Refused to load the … because it
 * violates the following Content Security Policy directive: …` to the
 * renderer's devtools console — which is invisible to users who never
 * open devtools. A user filing a "broken image" bug would have no
 * obvious cause.
 *
 * This listener re-emits those CSP errors with a structured
 * `[Tessera CSP]` prefix on the main-process log, so:
 *
 *   1. The bug is observable in `tessera.log` / electron-builder
 *      packaging logs without devtools.
 *   2. The `Refused to load` URL is captured, telling the maintainer
 *      exactly which CDN host needs to be added to `cspImageSources.ts`.
 *   3. We don't have to inject a `securitypolicyviolation` listener
 *      into every page (which would require a preload contract); the
 *      `console-message` event sees every CSP log Chromium emits.
 *
 * Performance: `console-message` is debounced to bursts of identical
 * messages so a runaway page that triggers thousands of CSP blocks
 * doesn't flood the log. We cache the last 50 unique CSP messages and
 * drop duplicates. Eviction is true FIFO via a `Map` (which preserves
 * insertion order per ECMAScript spec), so a long-running session
 * with a slowly-rotating set of violations doesn't periodically
 * re-log the same earliest messages — only the oldest unique entry
 * is dropped when the cap is hit.
 */
const cspLogSeen = new Map<string, true>();
const CSP_LOG_DEDUP_LIMIT = 50;
function installCSPDevtoolsLogger(): void {
  app.on("web-contents-created", (_event, contents) => {
    // WebContents emits `console-message` with positional args:
    //   (event, level, message, line, sourceId)
    // (NOT the Event2 MessageDetails shape used by ServiceWorkers in
    // newer Electron — different overload entirely.) `level` is
    // numeric: 0=verbose, 1=info, 2=warning, 3=error.
    contents.on("console-message", (_emEvent, level, message) => {
      // Match warning (2) and error (3) — Chromium logs CSP
      // violations at one of these levels. Match the modern
      // "Refused to load" prefix OR the literal "Content Security
      // Policy" phrase to be defensive against Chromium upstream
      // rewording.
      if (level < 2) return;
      if (
        !message.includes("Content Security Policy") &&
        !message.startsWith("Refused to")
      ) {
        return;
      }
      // Dedup so a thrashing page doesn't flood the log. The Map is
      // capped to avoid unbounded memory growth on a long-running app.
      // True FIFO via Map insertion-order iteration: drop the OLDEST
      // unique entry when the cap is hit, not clear the whole cache.
      // This keeps recently-seen violations suppressed while still
      // making room for new ones.
      if (cspLogSeen.has(message)) return;
      if (cspLogSeen.size >= CSP_LOG_DEDUP_LIMIT) {
        // Map keys iterate in insertion order per ECMAScript spec
        // (see ECMA-262 sec 24.1.1.4). The first key yielded by
        // `keys()` is the oldest entry; delete it to make room.
        const oldest = cspLogSeen.keys().next().value;
        if (oldest !== undefined) {
          cspLogSeen.delete(oldest);
        }
      }
      cspLogSeen.set(message, true);
      console.warn(`[Tessera CSP] ${message}`);
    });
  });
}

/**
 * Whether the app's main window has been created at least once.
 *
 * Guard for the `window-all-closed` handler. Before this flag flips
 * true, the only BrowserWindow that may exist is the modal password
 * prompt opened by `maybeInitPasswordVault`. If the user dismisses
 * that prompt via the OS title-bar X button BEFORE `createWindow()`
 * runs, the `closed` event on the prompt window synchronously triggers
 * `window-all-closed` (because the prompt was the only window in
 * existence). Without this guard, `app.quit()` fires and tears down
 * the app before the rejection microtask chain from
 * `maybeInitPasswordVault` can return control to `createWindow()` —
 * the documented "log warning, continue" recovery path becomes
 * unreachable on non-macOS platforms.
 *
 * The Cancel button path happened to survive prior to this fix
 * because `onCancel` defers `win.close()` via `setImmediate`, giving
 * the main process time to schedule `createWindow()` before the
 * window count hits zero. But that survival was incidental — the
 * `setImmediate` was there to flush the IPC `send` to the renderer,
 * not to defer `window-all-closed`. The X-button close path is
 * synchronous and would always kill the app.
 *
 * Setting `appInitComplete = true` only after `createWindow()` runs
 * makes the recovery path bullet-proof for both close routes.
 */
let appInitComplete = false;

/**
 * LW-8 (cold-start budget): initialise the native bridge and every
 * bridge-dependent service OFF the cold-start critical path.
 *
 * Called via `void initBridgeAndServices()` AFTER `createWindow()` so
 * the renderer can paint its "Loading workspace…" skeleton while this
 * runs. The heavy `initAppState()` (SQLCipher open + tombstone replay +
 * FTS purge) is the work being moved off the boot wire here.
 *
 * Lifecycle reporting:
 *   - on success, broadcasts `setBridgeState("ready")` so the renderer
 *     hydrates the real app shell;
 *   - on failure, broadcasts `setBridgeState("error", …)` so the
 *     renderer can surface a "workspace failed to open" state instead
 *     of hanging on the skeleton forever.
 *
 * This function NEVER throws: it is invoked with `void` from the boot
 * sequence (so an unhandled rejection would otherwise be silent), and a
 * bridge-init failure must degrade gracefully, not crash the process.
 */
async function initBridgeAndServices(): Promise<void> {
  try {
    // Initialise the native bridge + SQLCipher key. Runs AFTER the
    // vault is unlocked (the `await maybeInitPasswordVault()` in
    // `whenReady` precedes the `void initBridgeAndServices()` call) so
    // that on keyringless platforms `getOrCreateDbKeyAsync` can wrap the
    // SQLCipher key under the vault key instead of throwing
    // `EncryptionUnavailableError`.
    markStart("bridge-init");
    await initAppState();
    const bridgeInitMs = markEnd("bridge-init");
    // Log bridge-init timing as its own structured event. The cold-start
    // headline TOTAL (`startup-perf`'s `totalMs`, anchored on the
    // `window-show` end via `firstRenderEndMs` in `startupPerf.ts`)
    // INTENTIONALLY excludes bridge-init, since that work is off the
    // cold-start critical path now (LW-8). NB: the table's informational
    // `stages` list can still show a `bridge-init` row when init happens
    // to finish before first paint — only the headline `totalMs` metric
    // excludes it. Without this dedicated event a bridge-init regression
    // — SQLCipher open + tombstone replay + FTS purge getting slower —
    // would be invisible to the structured logs / fleet monitoring.
    // `markEnd` returns `null` only when perf marks are disabled (e.g.
    // some test envs), so we skip the event rather than log a
    // meaningless value.
    if (bridgeInitMs !== null) {
      getLogger().info("startup.bridgeInit", {
        durationMs: Math.round(bridgeInitMs * 100) / 100,
      });
    }
  } catch (err) {
    markEnd("bridge-init");
    const message = err instanceof Error ? err.message : String(err);
    getLogger().error("bridge.init.failed", { message });
    // Surface the failure to the renderer (it leaves the skeleton and
    // shows an error state) rather than wedging boot on a half-open
    // bridge.
    setBridgeState("error", { error: message });
    return;
  }
  // Replay the persisted hybrid retrieval config into the live Rust
  // `SourceManager`. Must run AFTER `initAppState` brings the bridge up
  // (otherwise it races the bridge being ready and silently no-ops via
  // `getBridge() === null`). A failure is logged but not fatal: the
  // user can re-tune in Settings; the engine uses its compiled defaults.
  try {
    replayPersistedHybridSearchConfigToBridge();
  } catch (err) {
    console.warn(
      "[Tessera] Failed to replay persisted hybrid search config:",
      err,
    );
  }
  // LW-3: begin polling battery state so the scheduler and
  // `model:generate` can defer synthesis when the device is on a low
  // battery. The probe runs on a 60s unref'd timer (never holds the
  // event loop open) and fails open — desktops / AC / unknown state
  // report "AC always" and never gate. Started before the scheduler so
  // the first tick already has a battery reading to consult. Lives here
  // (off the cold-start critical path) alongside the rest of the
  // bridge-dependent services rather than in the boot wire.
  startBatteryMonitor();
  // Start the automations scheduler now that the bridge backs its
  // dispatch. It ticks every 30s in the main process, dispatching due
  // `Schedule` automations directly against the native bridge. See
  // `scheduler.ts` for the run-control protocol.
  //
  // Guard it so this function honours its "NEVER throws" contract
  // structurally, not just by knowledge that `startScheduler` can't
  // throw today: a failure to start the scheduler is non-fatal to the
  // UI (the bridge IS up), and we MUST still reach `setBridgeState(
  // "ready")` below — otherwise the renderer would hang on the skeleton
  // forever, the exact failure mode this lifecycle exists to avoid.
  try {
    startScheduler();
  } catch (err) {
    getLogger().error("scheduler.start.failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  // Bridge + services are up: tell every renderer to hydrate.
  // `setBridgeState` swallows its own per-window broadcast failures
  // internally (see `bridgeLifecycle.ts`), so this final step cannot
  // throw — the contract holds end-to-end.
  setBridgeState("ready");
}

// Record the `app-ready` start anchor at module-load — i.e. as close
// as we can get to the V8 main bundle entrypoint inside the Electron
// process. The end mark is recorded inside the `whenReady` callback
// so the resulting measure captures the entire Electron-internal
// "ready up the GPU + IPC machinery" window. The other stage marks
// then nest under this one.
markStart("app-ready");

app.whenReady().then(async () => {
  markEnd("app-ready");
  // DB-key + password-vault unification.
  //
  // Boot ordering for the at-rest-encryption stack is now:
  //
  //   1. Install the session-level CSP and CSP devtools logger,
  //      so even the password-prompt BrowserWindow is loaded
  //      under the production CSP.
  //   2. Register the macOS `activate` listener so a dock click
  //      during the password prompt cannot get silently dropped.
  //   3. Register every IPC handler (`registerIpcHandlers`)
  //      BEFORE the password prompt awaits, so that even if
  //      Cocoa fires `activate` and the listener above
  //      synchronously opens the main window, the renderer
  //      finds every channel wired (defense-in-depth against a
  //      future refactor that splits the await chain).
  //   4. `await maybeInitPasswordVault()` — if `safeStorage` is
  //      unavailable on this platform, prompts the user for a
  //      vault password, runs PBKDF2-SHA256 (600k iterations) and
  //      caches the derived AES-256-GCM key in module-local
  //      memory.
  //   5. `await initAppState()` — calls
  //      `getOrCreateDbKeyAsync()`. The new async key path is
  //      vault-aware: when `safeStorage` is unavailable AND the
  //      vault was unlocked in step 4, the SQLCipher 256-bit
  //      cipher key is wrapped under the vault key and persisted
  //      with the `TSPV` magic. Subsequent launches dispatch on
  //      that magic to read back via the vault rather than
  //      `safeStorage`. See `dbKey.ts:getOrCreateDbKeyAsync` for
  //      the full dispatch matrix.
  //
  // Migration of legacy keyringless installs:
  // `tessera.db` is on disk as plaintext (no `db.key` file). On
  // the next launch, the vault prompt fires (step 4), a fresh
  // 256-bit key is generated and vault-wrapped (step 5), and the
  // Rust bridge's `open_shared_with_key` calls `sqlcipher_export`
  // to transparently re-encrypt the DB. The migration is
  // automatic — no consent UI needed because the user is
  // strictly UPGRADING from unencrypted to encrypted (no data
  // loss / lockout risk if the vault password is forgotten:
  // they still have the plaintext DB before migration runs, and
  // the migration only succeeds atomically when the new cipher
  // key is committed to disk).
  //
  // Note: `initAppState()` is called LATER in this block, AFTER
  // `maybeInitPasswordVault()` has cached the vault key. See the
  // call site below for the full sequencing rationale.

  // reap any sidecar processes left orphaned by a
  // hard-crash of the prior Tessera launch BEFORE we attempt to
  // spawn our own sidecars in `initAppState`. The reaper is
  // safe-by-default (it cross-checks PID + binary basename before
  // delivering SIGKILL and refuses to kill anything that doesn't
  // match the recorded sidecar identity, see
  // `sidecarPidRegistry.ts` for the contract).
  //
  // Why this position in the boot sequence: it must run BEFORE any
  // sidecar.start() can fire (otherwise we'd race the reaper
  // against our own freshly-spawned PIDs) but AFTER `app.whenReady`
  // because `app.getPath("userData")` is unstable before then.
  // `initAppState` (which spawns sidecars on first model use) runs
  // strictly later in this block, so the ordering holds.
  try {
    const outcome = await reapOrphanedSidecars();
    if (outcome.killed.length > 0) {
      console.log(
        `[tessera] sidecar reaper killed ${outcome.killed.length} orphan(s) from prior launch:`,
        outcome.killed,
      );
    }
    if (outcome.skipped.length > 0) {
      console.log(
        `[tessera] sidecar reaper skipped ${outcome.skipped.length} entry(ies):`,
        outcome.skipped,
      );
    }
  } catch (e) {
    // Reaper failure must NOT block startup — the worst case is we
    // bind on a stale port and the user sees a "sidecar already
    // running" toast, which is strictly less bad than the app
    // failing to launch.
    console.warn("[tessera] sidecar reaper failed:", e);
  }
  // Install the session-level CSP BEFORE any window (including the
  // password prompt) is created, so the policy is in effect for
  // every page load — not just for windows created after the main
  // app shell. See `installContentSecurityPolicy` for rationale.
  installContentSecurityPolicy();
  // Wire up the `tessera-asset://` request handler so the renderer
  // can load files under `<userData>/generated-images/` via
  // `<img src="tessera-asset://generated-images/<artifactId>/<file>">`.
  // Registered AFTER the CSP handler (so the CSP is in place for
  // the very first load) and BEFORE any window is created (so the
  // first paint of the main window already has the protocol live).
  registerAssetProtocolHandler(app.getPath("userData"));
  // Surface CSP violations to the main-process log so users who
  // never open devtools can still discover why their pasted image
  // URL was blocked. See `installCSPDevtoolsLogger` for rationale.
  // Installed AFTER the CSP header so the listener is in place
  // before any WebContents starts loading.
  installCSPDevtoolsLogger();
  // Install the macOS `activate` listener BEFORE `await
  // maybeInitPasswordVault()`. Rationale: on macOS, if the user
  // dismisses the password prompt and clicks the dock icon during
  // the brief window between the rejection propagating and
  // `createWindow()` running below, the click is dispatched
  // synchronously by Cocoa. Without the listener already installed,
  // the click is silently dropped — the app appears hung until the
  // main window auto-opens moments later. Registering the listener
  // here makes the recovery path bullet-proof.
  //
  // Safety while the password prompt is open: the prompt is itself a
  // `BrowserWindow`, so `BrowserWindow.getAllWindows().length === 0`
  // is false and the listener no-ops. The duplicate-window race is
  // also closed by `createWindow()` checking the existing-window set
  // before constructing a new one (see `createWindow` docstring) —
  // so even if Cocoa fires `activate` after the prompt closes but
  // before this `whenReady` callback resumes, the handler safely
  // creates the main window early; the `createWindow()` call below
  // then finds it already open and returns.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
  // Register IPC handlers BEFORE the password-vault prompt awaits,
  // so that even if Cocoa fires `activate` and the listener above
  // synchronously creates the main window early (see the comment on
  // the listener for when that can happen), the renderer it loads
  // will find every `ipcRenderer.invoke(...)` channel already wired
  // and will not see "No handler registered for 'foo'" errors.
  //
  // This is a defense-in-depth move: today, the standard JS
  // microtask ordering guarantees that the microtask continuation
  // after the password-vault await (which used to call
  // `registerIpcHandlers`) runs to completion BEFORE any pending
  // macrotask like `activate` is dispatched, so the race window is
  // zero. But if a future refactor adds a second `await` between
  // the password-vault step and IPC registration, that ordering
  // guarantee breaks silently and the renderer can load against a
  // half-wired IPC surface. Pinning IPC registration before the
  // password-vault await closes that latent hazard structurally
  // instead of relying on the event-loop contract.
  //
  // Safety: `registerIpcHandlers` only calls
  // `ipcMain.handle(channel, …)` for each IPC route — it does NOT
  // read from `passwordVault`, `tokenVault`, or `secretsVault` at
  // registration time. The vault-aware paths inside each handler
  // consult vault state lazily when the handler is invoked, so
  // moving registration above the vault prompt does not break the
  // "vault is ready before handlers run" invariant — it only
  // strengthens the "handlers are registered before any renderer
  // can call them" invariant.
  registerIpcHandlers();
  // LW-8: register the bridge-readiness query channel here, alongside
  // the domain handlers and BEFORE any window is created, so the very
  // first thing the renderer does on mount — ask "is the bridge ready
  // yet?" so it knows whether to keep showing the skeleton — always
  // finds a live handler. The matching `app:bridgeState` push events
  // are emitted by `setBridgeState()` from `initBridgeAndServices()`.
  // This is a tiny module-singleton read with no bridge dependency, so
  // it answers correctly even while `initAppState()` is still running.
  ipcMain.handle(BRIDGE_STATE_GET_CHANNEL, () => getBridgeStateSnapshot());
  // start the localhost API server the .kcz
  // extension installed in KChat Desktop talks to. Runs AFTER
  // `registerIpcHandlers()` because the handlers populate the
  // sources / ingest / share-artifact slots inside `appState.ts`
  // — starting the server earlier would expose an HTTP surface
  // that returns 503 for every state-changing route.
  try {
    await startKchatLocalApiServer(
      app.getPath("userData"),
      buildLocalApiHandlers(),
    );
  } catch (err) {
    // Treat a bind failure as soft: the .kcz extension surface is
    // a convenience, not a correctness requirement. Tessera still
    // runs against KChat via PAT.
    getLogger().error("kchatLocalApiServer.start failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  // Snapshot the active safeStorage backend and emit one boot-time
  // log entry + `keychain.backend.<name>` telemetry counter. Runs
  // AFTER `app.whenReady` (so `safeStorage.isEncryptionAvailable()`
  // returns truthful values on Linux) and BEFORE
  // `maybeInitPasswordVault()` so the password vault prompt and any
  // subsequent vault writes already have the boot backend recorded
  // for forensic visibility. Idempotent — a second call returns the
  // cached snapshot.
  try {
    const { captureBackendAtBoot } = await import("./keychainAcl");
    captureBackendAtBoot();
  } catch (err) {
    getLogger().warn("keychain.backend.capture_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  // Run the vault prompt BEFORE creating the window / bridge init so
  // that when `getOrCreateDbKeyAsync()` checks `passwordVaultActive()`,
  // the vault key (if any) is already cached. On non-keyringless
  // platforms `maybeInitPasswordVault` is a synchronous no-op, so it
  // adds nothing to the cold-start path that the gate measures; on
  // keyringless platforms the modal prompt must resolve before we open
  // the store anyway, so it correctly stays ahead of the window.
  await maybeInitPasswordVault();
  // LW-8 (cold-start budget): WINDOW FIRST.
  //
  // The boot path used to be `… → await initAppState() → createWindow()`,
  // so the first paint the cold-start gate measures could not happen
  // until the SQLCipher open + tombstone replay + FTS purge inside
  // `initAppState()` had finished — that I/O-bound work dominated
  // boot-to-first-render. We now create the window immediately: the
  // renderer paints a lightweight "Loading workspace…" skeleton (which
  // has no bridge dependency), and the heavy bridge init runs OFF the
  // critical path in `initBridgeAndServices()` below, signalling the
  // renderer to hydrate via `setBridgeState("ready")`. See
  // `bridgeLifecycle.ts` for the readiness contract.
  createWindow();
  appInitComplete = true;
  // Kick off bridge init + every bridge-dependent service in the
  // background. `void` (NOT `await`): boot-to-first-render must never
  // wait on it. `initBridgeAndServices` reports `ready`/`error` to the
  // renderer itself and swallows its own failures, so an unhandled
  // rejection can never escape here.
  void initBridgeAndServices();
  // Kick off the auto-update check. No-op in dev (app.isPackaged ==
  // false) and silently disabled when the user has unchecked
  // "Automatically check for updates" in Settings.
  //
  // dynamic `import()` so the `electron-updater`
  // module graph (~600 KB of YAML + XML + HTTP transport code) does
  // not load on the cold-start critical path. We `void` the promise
  // so the boot sequence does not block on the update check; any
  // failure is logged via the auto-updater's own error handling.
  //
  // The same dynamic import also registers the `updates:*` IPC
  // channels — moved out of `registerIpcHandlers()` (in `ipc.ts`) so
  // the heavy module graph is genuinely deferred. The renderer never
  // calls a `updates:*` channel during the first window-paint so the
  // brief gap between IPC handler registration and the renderer
  // becoming reachable is invisible in production. See the doc
  // comment in `ipc.ts` for the rationale.
  void import("./autoUpdater")
    .then(({ initAutoUpdater, registerAutoUpdaterIpc }) => {
      registerAutoUpdaterIpc();
      initAutoUpdater();
    })
    .catch((err: unknown) => {
      // Devin Review BUG (PR #69): if the dynamic
      // import rejects we previously logged the error and returned,
      // which left the `updates:*` IPC channels unregistered for
      // the whole session. The renderer's "Check for updates"
      // button in Settings would then reject with an opaque
      // "No handler registered for 'updates:check'" error.
      //
      // Architecturally correct recovery: register fallback
      // handlers that return a meaningful `status: "error"` shape
      // so the renderer can surface "Auto-updater is unavailable:
      // <reason>" instead of crashing. The fallbacks match the
      // real handlers' return contract (same shape as
      // `UpdateStatusEvent`) so the renderer's reducer doesn't
      // need a separate code path.
      const message = err instanceof Error ? err.message : String(err);
      getLogger().error("autoUpdater.dynamicImport failed", { message });
      const reason = `Auto-updater failed to initialise: ${message}`;
      const errorStatus = { status: "error" as const, message: reason };
      // `idempotentHandle` semantics inline: if `ipc.ts` decides
      // to register `updates:*` synchronously in the future, the
      // remove+handle pair below stays safe.
      const handleFallback = (channel: string, handler: () => unknown) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async () => handler());
      };
      handleFallback("updates:status", () => errorStatus);
      handleFallback("updates:check", () => errorStatus);
      handleFallback("updates:install", () => errorStatus);
      handleFallback("updates:getAutoUpdateEnabled", () => false);
      handleFallback("updates:setAutoUpdateEnabled", () => {
        throw new Error(reason);
      });
    });

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

  // Note: the `app.on("activate", ...)` listener is registered
  // EARLIER in this `whenReady` callback (before `await
  // maybeInitPasswordVault()`) so the dock-click recovery path is
  // live throughout the password prompt. Keeping it hoisted there
  // — not duplicated here — is intentional. See the comment block
  // at the registration site.
});

app.on("window-all-closed", () => {
  // Suppress the quit if the main window hasn't been opened yet. See
  // the `appInitComplete` docstring above for the full scenario —
  // tldr: dismissing the modal password prompt fires
  // `window-all-closed` before `createWindow()` ever runs, and we
  // want the rest of startup to continue so the user sees the main
  // window with a clear "vault unavailable" state instead of the
  // app silently dying.
  if (!appInitComplete) return;
  if (process.platform !== "darwin") {
    app.quit();
  }
});

/**
 * Test-only: reset the init flag so unit tests can simulate fresh
 * app startup. Kept in the production bundle (not gated by NODE_ENV)
 * for the same reason as `_resetForTests` in `autoUpdater.ts` — it's
 * a single-purpose, side-effect-free internal hook with no
 * security implications.
 */
export function _resetAppInitForTests(): void {
  appInitComplete = false;
}

/**
 * Test-only: mark startup as complete without running it. Lets the
 * `window-all-closed` regression test exercise the "post-init" path.
 */
export function _markAppInitCompleteForTests(): void {
  appInitComplete = true;
}

/**
 * Test-only: read the init flag.
 */
export function _appInitCompleteForTests(): boolean {
  return appInitComplete;
}

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

/**
 * Reset the will-quit deduplication latch.
 *
 * The `schedulerShutdownStarted` flag exists to make the will-quit
 * handler idempotent under repeated `app.quit()` calls (the deferred
 * `app.quit()` inside the async cleanup re-emits `will-quit`, so the
 * handler MUST short-circuit on the second emission to avoid stopping
 * the scheduler twice and double-awaiting the sidecar drain). Tests
 * call this between cases to start each case from a clean state.
 *
 * Production code never calls this — the flag is set exactly once
 * per process lifetime and the process exits immediately after.
 */
export function _resetWillQuitLatchForTests(): void {
  schedulerShutdownStarted = false;
}

/**
 * The will-quit handler body, lifted out of the inline callback so the
 * vitest suite can drive the integration directly (the inline callback
 * captures `app` from "electron", which makes mocking `app.quit()`
 * awkward; the exported function takes `app.quit` as an explicit
 * dependency).
 *
 * Returns the cleanup promise so tests can await it. Production callers
 * (the `app.on("will-quit")` registration below) fire-and-forget the
 * returned promise — Electron only cares that `event.preventDefault()`
 * was called synchronously and that `app.quit()` is eventually re-fired.
 *
 * Behaviour contract (verified by `__tests__/willQuit.test.ts`):
 *
 *   1. Calls `event.preventDefault()` synchronously so Electron defers
 *      the quit until our async cleanup finishes.
 *   2. Stops the scheduler FIRST so no new bridge calls start while
 *      the sidecars are being torn down.
 *   3. Drains text + vision + diffusion sidecars via `stopAllSidecars`.
 *   4. Calls `app.quit()` in a `finally` block so a throw in either
 *      step still terminates the process.
 *   5. A throw in `stopScheduler` does NOT skip `stopAllSidecars` —
 *      the two `try` blocks are sequential, not nested.
 *   6. Reentrant `will-quit` emissions (from the deferred `app.quit()`)
 *      no-op via the `schedulerShutdownStarted` latch.
 */
export async function handleWillQuit(
  event: { preventDefault: () => void },
  deps: {
    stopScheduler: () => Promise<void>;
    stopAllSidecars: () => Promise<void>;
    // Take the kchat localhost-API shutdown and the
    // deeplink-bridge detach via
    // dep-injection so this function follows the same testability
    // pattern as the existing scheduler / sidecar drains. The
    // production caller passes the real implementations; the
    // will-quit tests can inject spies and verify ordering against
    // the other shutdown steps.
    stopKchatLocalApi: () => Promise<void>;
    detachKchatDeeplinkBridge: () => void;
    /**
     * graceful database checkpoint, run after the
     * scheduler and every sidecar have been drained so no further
     * writes can land in the WAL between our checkpoint and process
     * exit. Optional so existing willQuit tests don't have to wire
     * a new mock just to keep compiling; production passes the real
     * bridge dispose closure (see the `app.on("will-quit")`
     * registration below).
     */
    disposeBridge?: () => void;
    /**
     * Stop the LW-3 battery poll timer. Injected (like the other
     * shutdown steps) rather than called as a direct import so the
     * will-quit tests can spy on it and assert its ordering relative
     * to the scheduler / sidecar drains. Optional so existing tests
     * that don't wire it keep compiling; production passes the real
     * `stopBatteryMonitor`. It is synchronous and never-throwing, so
     * it runs up front, outside the async-drain try/catch blocks.
     */
    stopBatteryMonitor?: () => void;
    quit: () => void;
  },
): Promise<void> {
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
  // LW-3: stop the battery poll timer first. It's an unref'd interval
  // (can't itself block exit) but stopping it here prevents a stacked
  // interval when a test harness re-launches the main process, mirroring
  // why we clear the scheduler interval up front. Synchronous and
  // never-throwing, so it sits outside the async-drain try/catch blocks.
  // Injected via `deps` for the same testability reason as every other
  // step (the `?.` keeps callers that don't wire it working).
  deps.stopBatteryMonitor?.();
  // Outer `try/finally` guarantees `deps.quit()` runs even if one of
  // the inner `console.error` calls were to throw (e.g. a custom
  // `console` override in a future test/wrapper). The two inner
  // `try/catch` blocks remain sequential — a throw in `stopScheduler`
  // must NOT skip `stopAllSidecars`, since each represents an
  // independent shutdown responsibility (the indexer tick AND the
  // sidecar drain must both be attempted on every quit).
  //
  // Before this refactor, `deps.quit()` was attached to the inner
  // `finally` of the second `try` block only — a (pathological)
  // throw from `console.error` in the FIRST `catch` would skip the
  // second block entirely and the process would hang forever waiting
  // for an `app.quit()` that never fires. `console.error` doesn't
  // throw in practice, but pinning the bullet-proof guarantee in code
  // (rather than relying on Node.js implementation details) matches
  // the docstring's "in a `finally` block so a throw in either step
  // still terminates the process" promise.
  try {
    try {
      await deps.stopScheduler();
    } catch (e) {
      // We're already on the quit path — log and continue rather than
      // hang the process indefinitely on a misbehaving tick.
      console.error("[tessera] scheduler shutdown failed:", e);
    }
    try {
      // Drain text + vision + diffusion sidecars gracefully (SIGTERM
      // with a 5 s SIGKILL fallback inside each sidecar) BEFORE
      // calling `app.quit()`. Without this, every sidecar would only
      // get the synchronous `process.on("exit")` SIGKILL fallback,
      // which is correct for orphan-prevention but skips any cache
      // flush / clean shutdown that llama-server / sd-server want
      // to do on SIGTERM. Errors are swallowed (logged inside
      // `stopAllSidecars`) so a hung sidecar can't block app exit.
      await deps.stopAllSidecars();
    } catch (e) {
      console.error("[tessera] sidecar shutdown failed:", e);
    }
    try {
      // stop the localhost API server and remove
      // the port-file so a future Tessera launch on a different
      // port doesn't have to race a stale discovery file.
      await deps.stopKchatLocalApi();
    } catch (e) {
      console.error("[tessera] kchatLocalApi shutdown failed:", e);
    }
    try {
      // detach the deeplink listeners so a
      // re-launched main process (test harness) does not stack
      // duplicates.
      deps.detachKchatDeeplinkBridge();
    } catch (e) {
      console.error("[tessera] kchatDeeplink detach failed:", e);
    }
    try {
      // run `PRAGMA wal_checkpoint(TRUNCATE)` LAST,
      // after the scheduler and every sidecar have been drained, so
      // no further writes can land in the WAL between our checkpoint
      // and the process exit. This keeps the on-disk file self-
      // contained: backup tooling, copy / sync utilities, and the
      // next cold start all see a single `.db` with an empty
      // `.db-wal` rather than having to replay frames out of the WAL
      // on next open. Optional in the deps contract so existing
      // tests don't have to wire a new spy.
      deps.disposeBridge?.();
    } catch (e) {
      console.error("[tessera] bridge dispose failed:", e);
    }
  } finally {
    deps.quit();
  }
}

app.on("will-quit", (event) => {
  // Attach a `.catch()` so an exception thrown inside `handleWillQuit`
  // (the pathological "logger throws inside the scheduler catch" case
  // pinned by `willQuit.test.ts`'s
  // "calls app.quit() even when a logger inside the scheduler catch throws"
  // test) doesn't surface as an `unhandledRejection`. The outer
  // `try { … } finally { deps.quit() }` inside `handleWillQuit`
  // guarantees `app.quit()` has already fired by the time control
  // reaches this `.catch()`, so the process is on its way out
  // anyway — we just log the original error so a post-mortem can
  // see what broke. Using `void` alone would let the rejection
  // bubble up to `process.on("unhandledRejection")` (registered at
  // `main.ts:31`), which is functionally equivalent but produces
  // a noisier log line right at shutdown.
  handleWillQuit(event, {
    stopScheduler,
    stopAllSidecars,
    stopBatteryMonitor,
    stopKchatLocalApi: stopKchatLocalApiServer,
    detachKchatDeeplinkBridge,
    disposeBridge: () => {
      // graceful DB checkpoint, called last so the
      // WAL is folded into the main file before the process exits.
      // `getBridge()` returns `null` if `init_bridge` never ran
      // successfully (early boot crash, headless test environment),
      // in which case there is no WAL to checkpoint and skipping is
      // correct.
      const bridge = getBridge();
      if (bridge && typeof bridge.bridgeDispose === "function") {
        bridge.bridgeDispose();
      }
    },
    quit: () => app.quit(),
  }).catch((e) => {
    console.error("[tessera] handleWillQuit rejected during quit:", e);
  });
});
