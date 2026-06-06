/**
 * Auto-update integration for packaged Tessera builds.
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
 *     interactions go through the five IPC handlers exposed by
 *     `registerAutoUpdaterIpc()` (`updates:status`, `updates:check`,
 *     `updates:install`, `updates:getAutoUpdateEnabled`,
 *     `updates:setAutoUpdateEnabled`) so the renderer cannot, e.g.,
 *     pin itself to a downgrade URL or smuggle a forged feed. See
 *     `docs/IPC_AUDIT.md` ("Updates (auto-updater)" table) for the
 *     authoritative inventory.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { loadConfig, updateConfig } from "./config";
import { getLogger } from "./logger";
import { assertBoolean } from "./ipc/validate";
import { recordCounter } from "./telemetrySink";
import {
  SignatureVerificationResult,
  verifyUpdateSignature,
} from "./updaterSignature";

interface UpdateStatusEvent {
  status:
    | "idle"
    | "checking"
    | "available"
    | "not-available"
    | "downloading"
    | "downloaded"
    | "error"
    | "signature-rejected";
  message?: string;
  /** 0–100 download progress percentage. Only populated for "downloading". */
  percent?: number;
  /** Bytes/sec download rate. Only populated for "downloading". */
  bytesPerSecond?: number;
  /** Semver of the new release, if known. */
  newVersion?: string;
  /**
   * Populated whenever a verification attempt has run for the
   * currently-staged artifact. The renderer surfaces this in the
   * Settings → Updates panel so users can see WHY a signed-update
   * enforcement run rejected an artifact (vs. a generic "error").
   *
   * Mirrors the shape of `SignatureVerificationResult` so callers
   * receive the structured `reason` enum without us re-flattening it
   * into a string.
   */
  signature?: SignatureVerificationResult;
}

let lastStatus: UpdateStatusEvent = { status: "idle" };
let registered = false;
/**
 * Per-staged-artifact verification cache. Populated by the
 * `update-downloaded` handler immediately after the artifact lands on
 * disk; consulted by the `updates:install` handler so a previously
 * rejected artifact cannot be force-installed via a second IPC call.
 *
 * Reset to `null` when `electron-updater` starts a new download (the
 * `download-progress` event) so a freshly-started download doesn't
 * inherit a stale `ok: true` from a previous run.
 */
let lastSignatureCheck: SignatureVerificationResult | null = null;

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
  /**
   * When false (the electron-updater default), the updater performs a
   * blockmap-based *differential* download: it fetches the new
   * release's `.blockmap`, diffs it against the currently-installed
   * artifact, and downloads only the changed blocks over HTTP range
   * requests. We set this explicitly so the intent is visible at the
   * call site and a future refactor can't silently flip it to a
   * full-artifact download. Differential download is a no-op fallback
   * to a full download when no blockmap is published or the target
   * format doesn't support it (e.g. macOS dmg), so setting it is
   * always safe.
   */
  disableDifferentialDownload: boolean;
  logger: AutoUpdaterLogger | null;
  on(event: string, cb: (...args: unknown[]) => void): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

let cachedUpdater: AutoUpdaterModule | null = null;

/**
 * Apply Tessera's canonical electron-updater configuration to a
 * freshly-resolved updater instance. Extracted from `getUpdater` so it
 * can be unit-tested directly: the real module is CommonJS + packaged-
 * only and can't be `require()`d (let alone mocked through `require`)
 * in the test runtime, so a test that drove `getUpdater()` would just
 * hit the catch path and assert nothing.
 */
function configureUpdater(updater: AutoUpdaterModule): void {
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
  // Enable blockmap-based delta updates by leaving electron-updater's
  // differential download ON (its `disable*` flag set to false). The
  // updater then fetches only the blocks that changed between the
  // installed artifact and the new release, which on a patch-level bump
  // is a small fraction of the full installer.
  updater.disableDifferentialDownload = false;
}

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
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above comment
    const mod = require("electron-updater") as {
      autoUpdater: AutoUpdaterModule;
    };
    const updater = mod.autoUpdater;
    configureUpdater(updater);
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
    // Reset the signature cache as soon as a new download starts so
    // a previously-verified artifact's `ok: true` cannot leak into
    // the next install attempt. Without this reset, an attacker who
    // could swap the downloaded file on disk between the `downloaded`
    // event and the `updates:install` call would inherit the cached
    // pass from the prior (legitimate) download.
    lastSignatureCheck = null;
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
    const event =
      info && typeof info === "object"
        ? (info as { version?: unknown; downloadedFile?: unknown })
        : {};
    const version =
      typeof event.version === "string" || typeof event.version === "number"
        ? String(event.version)
        : undefined;
    const downloadedFile =
      typeof event.downloadedFile === "string"
        ? event.downloadedFile
        : undefined;

    // Verify the artifact signature BEFORE broadcasting "downloaded".
    // If enforcement is on AND verification fails, we broadcast
    // `signature-rejected` instead of `downloaded` so the renderer
    // never offers an Install button for an artifact we don't trust.
    const config = loadConfig();
    if (config.enforceUpdateSignature) {
      if (!downloadedFile) {
        // electron-updater always sets this in modern versions; if
        // it's missing we treat the artifact as unverifiable rather
        // than blindly trusting it.
        const reason =
          "electron-updater did not surface the downloaded file path; " +
          "cannot verify signature. Refusing to stage update.";
        lastSignatureCheck = {
          ok: false,
          reason: "verifier-error",
          message: reason,
        };
        getLogger().error("autoUpdater.signature.unverifiable", {
          version,
          reason,
        });
        recordCounter("update.signature_fail");
        broadcast({
          status: "signature-rejected",
          newVersion: version,
          message: reason,
          signature: lastSignatureCheck,
        });
        return;
      }
      const result = verifyUpdateSignature(downloadedFile);
      lastSignatureCheck = result;
      if (!result.ok) {
        // Special-case the "no anchors configured" state. Until the
        // release pipeline ships its first signed artifact,
        // UPDATER_TRUST_ANCHORS is empty and verification cannot run.
        // Treating that as `signature-rejected` would silently break
        // every auto-update for every user on a fresh install, because
        // the config default for `enforceUpdateSignature` is true.
        // Instead, log a WARN (so operators see this in telemetry),
        // record the skipped counter, and fall through to broadcast
        // `downloaded` so users still get updates. The install gate
        // below treats the same `reason: "no-trust-anchors"` value as
        // "skip with warning" rather than "block", preserving the
        // defense-in-depth path: every OTHER `ok: false` reason
        // (verification-failed, signature-missing, signature-malformed,
        // verifier-error) still blocks install.
        if (result.reason === "no-trust-anchors") {
          getLogger().warn("autoUpdater.signature.skipped_no_anchors", {
            version,
            downloadedFile,
            message: result.message,
          });
          recordCounter("update.signature_skipped_no_anchors");
          broadcast({
            status: "downloaded",
            newVersion: version,
            signature: result,
          });
          return;
        }
        getLogger().error("autoUpdater.signature.rejected", {
          version,
          downloadedFile,
          reason: result.reason,
          message: result.message,
        });
        recordCounter("update.signature_fail");
        broadcast({
          status: "signature-rejected",
          newVersion: version,
          message: result.message,
          signature: result,
        });
        return;
      }
      getLogger().info("autoUpdater.signature.verified", {
        version,
        downloadedFile,
        anchorIndex: result.anchorIndex,
      });
      recordCounter("update.signature_pass");
      broadcast({
        status: "downloaded",
        newVersion: version,
        signature: result,
      });
      return;
    }

    // Enforcement disabled — surface the same status the previous
    // (pre-Ed25519) implementation did. We do NOT short-circuit on
    // `app.isPackaged` here because the caller has already opted out
    // of signature checking via config and we want consistent
    // behaviour for that opt-out across dev and packaged builds.
    lastSignatureCheck = null;
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
 * Register the five `updates:*` IPC channels (`updates:status`,
 * `updates:check`, `updates:install`, `updates:getAutoUpdateEnabled`,
 * `updates:setAutoUpdateEnabled` — see the `channels` list below and
 * `docs/IPC_AUDIT.md` ("Updates (auto-updater)" table) for the
 * authoritative inventory). Called by the central
 * `registerIpcHandlers()` so the auto-updater integrates with the
 * same lifecycle as every other IPC surface.
 *
 * `updates:status` is dual-purpose: it serves as both the
 * `ipcMain.handle` pull endpoint registered here (returning the
 * cached `lastStatus`) and the `webContents.send` broadcast channel
 * driven by `broadcast(...)` whenever the underlying
 * `electron-updater` emits an event. `docs/IPC_AUDIT.md` lists it in
 * both the Updates table and the "Renderer-bound emit channels"
 * table so a security reviewer sees both surfaces.
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
    // Re-check the signature gate at install time. The state we
    // consult here is set by the `update-downloaded` handler above
    // and is reset on every new download (`download-progress`), so
    // an attacker who can call `updates:install` cannot bypass a
    // signature rejection by waiting until lastStatus drifts.
    //
    // We only insist on a positive verification result when
    // enforcement is on; otherwise the field may legitimately be
    // null (verification was skipped) and we let install proceed.
    const config = loadConfig();
    if (config.enforceUpdateSignature) {
      // Special-case the no-trust-anchors state (symmetric with the
      // `update-downloaded` handler above). When the release pipeline
      // has not yet shipped its first signed artifact, refusing the
      // install would silently break auto-updates for every user.
      // Log a WARN so operators still see this skip in telemetry,
      // then allow the install. Every OTHER failure reason
      // (verification-failed, signature-missing, signature-malformed,
      // verifier-error) continues to block install — the
      // defense-in-depth against a tampered artifact / artifact swap
      // is preserved.
      if (
        lastSignatureCheck &&
        !lastSignatureCheck.ok &&
        lastSignatureCheck.reason === "no-trust-anchors"
      ) {
        getLogger().warn("autoUpdater.install.skipped_no_anchors", {
          message: lastSignatureCheck.message,
        });
      } else if (!lastSignatureCheck || !lastSignatureCheck.ok) {
        const reason =
          lastSignatureCheck?.message ??
          "Signature verification has not run for the staged artifact; " +
            "refusing to install. This usually means the artifact was " +
            "replaced on disk after download.";
        return { ok: false, message: reason };
      }
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
      // would reject it loudly. Reject loudly here too.
      const value = assertBoolean(enabled, "enabled");
      updateConfig({ autoUpdate: value });
      return loadConfig().autoUpdate;
    },
  );
}

/**
 * Test-only hook: inject a fake `electron-updater` module so the
 * integration tests in `__tests__/autoUpdaterSignature.test.ts` can
 * synthesize `update-downloaded` / `download-progress` events without
 * actually requiring the real (CommonJS, packaged-only) module. The
 * fake updater is wired through the same `attachListenersOnce` path
 * the production code uses, so the test exercises the real listener
 * registration and dispatch logic.
 *
 * Production callers MUST NOT invoke this — `getUpdater()` is the
 * sole production entry point for resolving the updater module.
 */
export function _injectUpdaterForTests(updater: AutoUpdaterModule): void {
  cachedUpdater = updater;
  attachListenersOnce(updater);
}

/**
 * Test-only hook exposing the same configuration `getUpdater()` applies
 * to the real module — used to assert the canonical updater settings
 * (notably `disableDifferentialDownload = false`, which enables
 * blockmap delta downloads) without `require()`-ing the packaged-only
 * `electron-updater`.
 *
 * Production callers MUST NOT invoke this.
 */
export function _configureUpdaterForTests(updater: AutoUpdaterModule): void {
  configureUpdater(updater);
}

/**
 * Test-only: directly seed the cached `lastStatus` / `lastSignatureCheck`
 * pair so a regression test can exercise the install-time defense-in-depth
 * gate independently of the `update-downloaded` handler. Without this
 * hook, every `lastSignatureCheck` write goes through the download
 * handler, which couples the two gates and makes it impossible to test
 * the install-gate in isolation (e.g. the case where `lastStatus` is
 * `"downloaded"` but `lastSignatureCheck.ok` is `false` — a state that
 * the download handler ordinarily prevents but that a future refactor
 * could re-introduce).
 *
 * Production callers MUST NOT invoke this.
 */
export function _setInstallGateStateForTests(
  status: UpdateStatusEvent,
  signature: SignatureVerificationResult | null,
): void {
  lastStatus = status;
  lastSignatureCheck = signature;
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
  lastSignatureCheck = null;
}
