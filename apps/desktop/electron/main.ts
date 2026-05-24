import { app, BrowserWindow, safeStorage, session } from "electron";
import * as path from "path";
import { registerIpcHandlers } from "./ipc";
import { replayPersistedHybridSearchConfigToBridge } from "./ipc/settings";
import { loadConfig, saveWindowState } from "./config";
import { initAppState, stopAllSidecars } from "./appState";
import { detectComputeBackends } from "./modelManagement";
import { startScheduler, stopScheduler } from "./scheduler";
import { getLogger } from "./logger";
import { initAutoUpdater } from "./autoUpdater";
import { cspImageSources } from "./cspImageSources";
import {
  initPasswordVaultIfNeeded,
  passwordVaultSaltExists,
  VAULT_INACTIVE_SAFE_STORAGE_AVAILABLE,
} from "./passwordVault";

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
function installContentSecurityPolicy(): void {
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

app.whenReady().then(async () => {
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

  // Install the session-level CSP BEFORE any window (including the
  // password prompt) is created, so the policy is in effect for
  // every page load — not just for windows created after the main
  // app shell. See `installContentSecurityPolicy` for rationale.
  installContentSecurityPolicy();
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
  // Run the vault prompt BEFORE `initAppState()` so that when
  // `getOrCreateDbKeyAsync()` checks `passwordVaultActive()`, the
  // vault key (if any) is already cached. On non-keyringless
  // platforms `maybeInitPasswordVault` is a synchronous no-op.
  await maybeInitPasswordVault();
  // Initialise the native bridge + SQLCipher key. Runs AFTER the
  // vault is unlocked so that on keyringless platforms
  // `getOrCreateDbKeyAsync` can wrap the SQLCipher key under the
  // vault key (instead of throwing `EncryptionUnavailableError`
  // and falling back to unencrypted mode as an earlier boot
  // sequence did). See the doc comment at the top of this
  // callback for the full ordering rationale.
  await initAppState();
  // Replay the persisted hybrid retrieval config into the live Rust
  // `SourceManager`. Must run AFTER `initAppState` brings the
  // bridge up (awaiting `initAppState` is what makes that ordering
  // deterministic — placing this call before `initAppState` raced
  // against the bridge being ready and silently no-op'd via
  // `getBridge() === null`). A failure
  // is logged but not fatal: the user can re-tune in Settings,
  // the live engine simply uses its compiled defaults.
  try {
    replayPersistedHybridSearchConfigToBridge();
  } catch (err) {
    console.warn(
      "[Tessera] Failed to replay persisted hybrid search config:",
      err,
    );
  }
  // Start the automations scheduler. Runs in the main process and
  // ticks every 30s, dispatching due `Schedule` automations directly
  // against the native bridge (i.e. without bouncing through the
  // renderer). See `scheduler.ts` for the run-control protocol.
  startScheduler();
  createWindow();
  appInitComplete = true;
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
      await stopAllSidecars();
    } catch (e) {
      console.error("[tessera] sidecar shutdown failed:", e);
    } finally {
      app.quit();
    }
  })();
});
