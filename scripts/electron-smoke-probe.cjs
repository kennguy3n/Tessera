/*
 * Phase 15 Task 16 — Electron main-process smoke probe.
 *
 * Loaded into the installed Tessera app's main process via
 * `--require=...electron-smoke-probe.cjs` (see scripts/Dockerfile.smoke).
 *
 * Race semantics: a deadline timer (TESSERA_SMOKE_TIMEOUT_SECS, default 30s)
 * runs in parallel with the `app.whenReady()` promise + an IPC round-trip
 * against the `sources:list` channel. Whichever resolves first decides the
 * exit code:
 *
 *   * `ready` event fires AND `sources:list` returns within deadline →
 *     write a single-line `{"smoke":"ok",...}` marker to stdout and call
 *     `app.quit()` so the container exits 0.
 *
 *   * deadline expires first → write a `{"smoke":"fail","reason":"timeout"}`
 *     marker and call `process.exit(70)` (sysexits EX_SOFTWARE).
 *
 *   * any thrown error → write a `{"smoke":"fail","reason":...}` marker and
 *     `process.exit(70)`.
 *
 * The marker is the single source of truth for the harness's pass/fail
 * decision (the harness greps for `"smoke":"ok"`). We deliberately do not
 * rely on `app.quit()`'s exit code alone, because Electron's quit path can
 * succeed (exit 0) even after a renderer crash.
 */

const TIMEOUT_SECS = Number(process.env.TESSERA_SMOKE_TIMEOUT_SECS || 30);

function emit(obj) {
  // Single-line JSON so the harness's grep is unambiguous.
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function die(reason, detail) {
  emit({ smoke: "fail", reason, detail: String(detail || "") });
  // sysexits EX_SOFTWARE — distinct from Electron's own non-zero codes.
  process.exit(70);
}

// We deliberately require `electron` lazily — at the time --require runs,
// the electron module is available because we're inside the main process
// already.
let electron;
try {
  electron = require("electron");
} catch (e) {
  die("electron-require-failed", e && e.message);
}

const { app, ipcMain, BrowserWindow } = electron;

if (!app || typeof app.whenReady !== "function") {
  die("electron-app-missing");
}

const deadline = setTimeout(() => {
  die("timeout", `waited ${TIMEOUT_SECS}s for ready + IPC round-trip`);
}, TIMEOUT_SECS * 1000);
deadline.unref();

app
  .whenReady()
  .then(async () => {
    let ipcOk = false;
    try {
      // Resolve the production handler that the renderer would normally
      // invoke via `ipcRenderer.invoke("sources:list")`. The handler is
      // registered by `apps/desktop/electron/ipc.ts` during the bridge
      // init phase, which finishes before `whenReady` resolves.
      //
      // We can't directly call `ipcMain.handle`'s callback (it's private),
      // so we synthesize a minimal sender stub and invoke through Electron's
      // own invocation surface: a hidden BrowserWindow whose webContents
      // round-trips `sources:list` and resolves a promise back here.
      // Devin Review PR #70 ANALYSIS_0001: the probe renderer needs
      // `require("electron")` to reach `ipcRenderer`. That global is
      // only present when `nodeIntegration: true` AND `sandbox: false`
      // — with `nodeIntegration: false` the require() throws
      // `ReferenceError: require is not defined`, the catch returns
      // `{ ok: false }`, and the probe always exits 70 (i.e. the
      // smoke test was never actually exercising the IPC channel).
      // Enabling nodeIntegration is safe here because (a) the only
      // content ever loaded is `about:blank` — no untrusted markup,
      // no remote URL, no preload — and (b) this script is invoked
      // exclusively from the Linux smoke harness, never from the
      // production app entry. The alternative (a preload script that
      // exposes a probe-only API) adds packaging complexity (the
      // preload would have to be copied into the installed
      // resources/ tree) for no security benefit in this specific
      // hidden, about:blank-only window.
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
          sandbox: false,
        },
      });
      // Load `about:blank` so the renderer is ready to invoke. We don't
      // need any actual UI for the probe.
      await win.loadURL("about:blank");
      const result = await win.webContents.executeJavaScript(`
        (async () => {
          try {
            const { ipcRenderer } = require("electron");
            const out = await ipcRenderer.invoke("sources:list");
            return { ok: true, kind: Array.isArray(out) ? "array" : typeof out };
          } catch (e) {
            return { ok: false, message: String(e && e.message || e) };
          }
        })()
      `);
      ipcOk = !!(result && result.ok);
      if (!ipcOk) {
        die("ipc-round-trip-failed", result && result.message);
      }
      emit({ smoke: "ok", channel: "sources:list", returned: result.kind });
    } catch (e) {
      die("ipc-fixture-failed", e && e.message);
    } finally {
      clearTimeout(deadline);
      // Defer quit so stdout flush settles before the process exits.
      setImmediate(() => app.quit());
    }
  })
  .catch((e) => die("when-ready-rejected", e && e.message));
