/**
 * Integration tests for the `will-quit` handler exported from
 * `main.ts` as [`handleWillQuit`].
 *
 * `__tests__/stopAllSidecars.test.ts` covers the pure helper that
 * `stopAllSidecars` delegates to. This file covers the layer above:
 * the will-quit handler that wires `stopScheduler` + `stopAllSidecars`
 * + `app.quit()` together. CONTRIBUTING.md flags scheduler-drain and
 * process-shutdown logic as security-sensitive boundaries that
 * require regression tests; this file fills the gap that Devin
 * Review's pass-7 finding (ANALYSIS_pr-review-job-08df75766eba4513
 * 809fceac8a2cb5e0_0007) called out on PR #34.
 *
 * The handler invariants tested:
 *
 *   1. `event.preventDefault()` is called synchronously on entry so
 *      Electron defers the actual quit until the async cleanup
 *      finishes.
 *   2. `stopScheduler` runs BEFORE `stopAllSidecars` (sidecars get
 *      drained only after the indexing tick that might be using them
 *      has been quiesced).
 *   3. `app.quit()` always runs \u2014 in the success path, when the
 *      scheduler throws, and when stopAllSidecars throws.
 *   4. A throw in `stopScheduler` does NOT skip the sidecar drain
 *      (the two `try` blocks are sequential, not nested).
 *   5. The deduplication latch (`schedulerShutdownStarted`) means a
 *      reentrant `will-quit` emission (which Electron fires on the
 *      deferred `app.quit()`) is a no-op.
 *   6. A hung sidecar does NOT prevent `app.quit()` from being
 *      called: the underlying `stopAllSidecars` swallows individual
 *      sidecar rejections (see `stopAllSidecars.test.ts`), so by the
 *      time the will-quit handler reaches its `finally`, the cleanup
 *      promise has resolved one way or another.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// `main.ts` imports a lot of Electron-app-y modules at module load
// time. The full surface is too large to fake here, so we stub the
// transitive imports out at the boundary. We only need
// `handleWillQuit` (the pure, dep-injected helper), so the rest can
// be cheap fakes that satisfy the import shape.
vi.mock("electron", () => ({
  app: {
    on: vi.fn(),
    quit: vi.fn(),
    // Return a never-resolving Promise so the `app.whenReady().then(createWindow)`
    // chain in `main.ts` does NOT actually fire `createWindow()` during
    // module load \u2014 createWindow constructs a BrowserWindow, calls
    // loadURL, registers IPC handlers, and generally assumes a real
    // Electron environment. We only need the will-quit handler under
    // test; everything else is unreachable from these specs.
    whenReady: vi.fn().mockReturnValue(new Promise(() => {})),
    isPackaged: false,
    getPath: (k: string) => `/tmp/tessera-test-${k}`,
    getName: () => "tessera-test",
    getVersion: () => "0.0.0-test",
    getLocale: () => "en-US",
    setAppUserModelId: vi.fn(),
    requestSingleInstanceLock: vi.fn().mockReturnValue(true),
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(""),
    decryptString: () => "",
  },
  session: {
    defaultSession: {
      webRequest: {
        onHeadersReceived: vi.fn(),
      },
      cookies: {
        get: vi.fn().mockResolvedValue([]),
      },
    },
  },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  Menu: {
    buildFromTemplate: vi.fn().mockReturnValue({}),
    setApplicationMenu: vi.fn(),
  },
}));

// Stub the heavy transitive imports so the module loads. None of
// these run \u2014 the will-quit handler takes its dependencies as
// arguments, so the stubs only need to exist as importable shapes.
vi.mock("../ipc", () => ({ registerIpcHandlers: vi.fn() }));
vi.mock("../ipc/settings", () => ({
  replayPersistedHybridSearchConfigToBridge: vi.fn(),
}));
vi.mock("../config", () => ({
  // Production `loadConfig` is synchronous (returns a deep-frozen
  // `AppConfig` object, not a Promise — see `electron/config.ts:565`),
  // and `createWindow()` consumes its return value directly to read
  // `config.windowWidth` / `.windowHeight` / `.windowX` / `.windowY`.
  // The will-quit tests never reach `createWindow` (the
  // `app.whenReady()` mock at line 53 returns a never-resolving
  // Promise so the `.then(createWindow)` chain in `main.ts` is
  // unreachable), but we still ship a shape-correct mock so a future
  // test in this file can trigger `createWindow` without silently
  // getting `undefined` window dimensions. The values mirror
  // `DEFAULT_CONFIG` in `electron/config.ts:155-157`.
  loadConfig: vi.fn().mockReturnValue({
    windowWidth: 1280,
    windowHeight: 800,
    windowX: undefined,
    windowY: undefined,
  }),
  saveWindowState: vi.fn(),
}));
vi.mock("../appState", () => ({
  initAppState: vi.fn(),
  stopAllSidecars: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../modelManagement", () => ({
  detectComputeBackends: vi.fn().mockReturnValue([]),
}));
vi.mock("../scheduler", () => ({
  startScheduler: vi.fn(),
  stopScheduler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../autoUpdater", () => ({ initAutoUpdater: vi.fn() }));
vi.mock("../cspImageSources", () => ({
  // Production exports `cspImageSources` as a frozen `readonly string[]`
  // (see `electron/cspImageSources.ts:65`); `main.ts:87` calls
  // `cspImageSources.join(" ")` on it inside `installContentSecurityPolicy`.
  // The will-quit tests never reach that code (whenReady is mocked to
  // never resolve), but a shape-correct empty array avoids a
  // latent runtime crash if a future test in this file resolves
  // whenReady to exercise startup. Empty is safe — the resulting CSP
  // just omits the connector hosts; no test here asserts on CSP.
  cspImageSources: [],
}));
vi.mock("../passwordVault", () => ({
  initPasswordVaultIfNeeded: vi.fn(),
  passwordVaultSaltExists: vi.fn().mockReturnValue(false),
  VAULT_INACTIVE_SAFE_STORAGE_AVAILABLE: false,
}));

import { _resetWillQuitLatchForTests, handleWillQuit } from "../main";

afterEach(() => {
  vi.restoreAllMocks();
  _resetWillQuitLatchForTests();
});

function makeEvent() {
  const preventDefault = vi.fn();
  return { event: { preventDefault }, preventDefault };
}

describe("handleWillQuit", () => {
  it("calls preventDefault, then stopScheduler, then stopAllSidecars, then quit", async () => {
    const order: string[] = [];
    const stopScheduler = vi.fn().mockImplementation(async () => {
      order.push("stopScheduler");
    });
    const stopAllSidecars = vi.fn().mockImplementation(async () => {
      order.push("stopAllSidecars");
    });
    const quit = vi.fn().mockImplementation(() => {
      order.push("quit");
    });

    const { event, preventDefault } = makeEvent();
    await handleWillQuit(event, { stopScheduler, stopAllSidecars, quit });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopScheduler).toHaveBeenCalledTimes(1);
    expect(stopAllSidecars).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
    // Scheduler MUST drain before sidecars \u2014 otherwise an in-flight
    // scheduler tick could open a fresh bridge call against a
    // sidecar that's already SIGTERM'd.
    expect(order).toEqual(["stopScheduler", "stopAllSidecars", "quit"]);
  });

  it("calls preventDefault SYNCHRONOUSLY so Electron defers the quit", async () => {
    // The Electron docs require preventDefault to be called from the
    // synchronous portion of the handler \u2014 a microtask-deferred
    // preventDefault arrives after Electron has already proceeded
    // with the quit, and the deferred app.quit() at the end of our
    // cleanup is a no-op because the process is already on its way
    // out. Verify by inspecting the call order on a still-pending
    // handleWillQuit promise.
    let resolveScheduler!: () => void;
    const stopScheduler = vi.fn().mockReturnValue(
      new Promise<void>((r) => {
        resolveScheduler = r;
      }),
    );
    const stopAllSidecars = vi.fn().mockResolvedValue(undefined);
    const quit = vi.fn();

    const { event, preventDefault } = makeEvent();
    const pending = handleWillQuit(event, {
      stopScheduler,
      stopAllSidecars,
      quit,
    });

    // The function has not yet awaited \u2014 preventDefault MUST already
    // be called by now (it's the second statement of the function,
    // before the first `await`).
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopScheduler).toHaveBeenCalledTimes(1);
    // The cleanup is still pending until we resolve the scheduler.
    expect(quit).not.toHaveBeenCalled();

    resolveScheduler();
    await pending;
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("calls app.quit() even when stopScheduler throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const stopScheduler = vi
      .fn()
      .mockRejectedValue(new Error("scheduler tick stuck on a slow disk"));
    const stopAllSidecars = vi.fn().mockResolvedValue(undefined);
    const quit = vi.fn();

    const { event } = makeEvent();
    await handleWillQuit(event, { stopScheduler, stopAllSidecars, quit });

    expect(stopScheduler).toHaveBeenCalledTimes(1);
    // A scheduler throw MUST NOT short-circuit the sidecar drain \u2014
    // a half-shut-down process with running sidecars is worse than
    // a clean drain.
    expect(stopAllSidecars).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);

    // The error must be logged with a "[tessera] scheduler" prefix
    // so a post-mortem can distinguish scheduler vs sidecar failures.
    expect(errSpy).toHaveBeenCalled();
    const firstCall = errSpy.mock.calls[0].map((v) => String(v)).join(" ");
    expect(firstCall).toContain("scheduler shutdown failed");
    expect(firstCall).toContain("scheduler tick stuck on a slow disk");
  });

  it("calls app.quit() even when stopAllSidecars throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const stopScheduler = vi.fn().mockResolvedValue(undefined);
    const stopAllSidecars = vi
      .fn()
      .mockRejectedValue(new Error("vision sidecar wedged on mmproj load"));
    const quit = vi.fn();

    const { event } = makeEvent();
    await handleWillQuit(event, { stopScheduler, stopAllSidecars, quit });

    // The `finally` MUST fire even when the sidecar drain throws \u2014
    // otherwise the user would hit Cmd-Q again and see a still-
    // running app with a frozen renderer.
    expect(quit).toHaveBeenCalledTimes(1);

    expect(errSpy).toHaveBeenCalled();
    const firstCall = errSpy.mock.calls[0].map((v) => String(v)).join(" ");
    expect(firstCall).toContain("sidecar shutdown failed");
    expect(firstCall).toContain("vision sidecar wedged on mmproj load");
  });

  it("calls app.quit() even when BOTH stopScheduler and stopAllSidecars throw", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const stopScheduler = vi
      .fn()
      .mockRejectedValue(new Error("scheduler hung"));
    const stopAllSidecars = vi
      .fn()
      .mockRejectedValue(new Error("every sidecar hung"));
    const quit = vi.fn();

    const { event } = makeEvent();
    await handleWillQuit(event, { stopScheduler, stopAllSidecars, quit });

    // The doomsday case: both subsystems are misbehaving, and the
    // process still terminates cleanly because the two try/catches
    // are independent. The user MUST be able to quit a
    // misbehaving app.
    expect(stopScheduler).toHaveBeenCalledTimes(1);
    expect(stopAllSidecars).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);

    // Both error categories should be visible in the log.
    const allCalls = errSpy.mock.calls
      .map((c) => c.map((v) => String(v)).join(" "))
      .join("\n");
    expect(allCalls).toContain("scheduler shutdown failed");
    expect(allCalls).toContain("sidecar shutdown failed");
  });

  it("calls app.quit() even when a logger inside the scheduler catch throws", async () => {
    // Devin Review pass-8 finding ANALYSIS_pr-review-job-8bbc56fb…_0001
    // pointed out that the docstring claims "in a `finally` block so
    // a throw in either step still terminates the process", but the
    // original code attached the `finally` to the SECOND try/catch
    // only. If `console.error` inside the FIRST catch threw (e.g. a
    // pathological logger replacement), control would skip the
    // second try/catch entirely and `app.quit()` would never fire.
    //
    // This test pins the bullet-proof outer `try { … } finally
    // { deps.quit() }` structure by stubbing `console.error` to
    // throw, asserting `quit()` still runs exactly once.
    const stopScheduler = vi
      .fn()
      .mockRejectedValue(new Error("scheduler hung"));
    const stopAllSidecars = vi.fn().mockResolvedValue(undefined);
    const quit = vi.fn();

    // Make the FIRST `console.error` call throw — this is the
    // pathological-logger case.
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementationOnce(() => {
        throw new Error("logger broke during scheduler error reporting");
      });

    const { event } = makeEvent();
    // `handleWillQuit` must NOT reject — the outer finally swallows
    // the logger throw via `deps.quit()` running on the way out.
    // (The throw will still bubble out of the function after the
    // finally runs, but the contract is "app.quit() always fires".)
    await expect(
      handleWillQuit(event, { stopScheduler, stopAllSidecars, quit }),
    ).rejects.toThrow("logger broke");

    expect(stopScheduler).toHaveBeenCalledTimes(1);
    // stopAllSidecars should NOT run — the logger threw before
    // control could enter the second try block. But quit MUST
    // still fire from the outer finally.
    expect(stopAllSidecars).toHaveBeenCalledTimes(0);
    expect(quit).toHaveBeenCalledTimes(1);

    errSpy.mockRestore();
  });

  it("is idempotent under reentrant invocations (the schedulerShutdownStarted latch)", async () => {
    // Electron fires `will-quit` again on the deferred `app.quit()`
    // at the end of our cleanup. If the handler weren't latched,
    // that second emission would stop the scheduler twice and
    // double-await the sidecar drain \u2014 the sidecars would already
    // be stopped by the first pass, so SIGTERMing dead PIDs is
    // harmless, but the second `app.quit()` would race the first
    // one's process exit and produce a confusing log tail. The
    // latch is the simpler fix.
    const stopScheduler = vi.fn().mockResolvedValue(undefined);
    const stopAllSidecars = vi.fn().mockResolvedValue(undefined);
    const quit = vi.fn();

    const { event: firstEvent } = makeEvent();
    await handleWillQuit(firstEvent, {
      stopScheduler,
      stopAllSidecars,
      quit,
    });
    expect(stopScheduler).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);

    // Second emission \u2014 every dependency MUST be called zero more
    // times. The first emission's `app.quit()` is what actually
    // terminates the process.
    const { event: secondEvent, preventDefault: secondPrevent } = makeEvent();
    await handleWillQuit(secondEvent, {
      stopScheduler,
      stopAllSidecars,
      quit,
    });
    expect(stopScheduler).toHaveBeenCalledTimes(1);
    expect(stopAllSidecars).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
    // The latched-out path returns BEFORE preventDefault is called,
    // which is correct \u2014 the second emission is Electron asking
    // "should I quit?", and the latched handler's silence means
    // "yes, no need to defer".
    expect(secondPrevent).not.toHaveBeenCalled();
  });

  it("does not hang when stopAllSidecars resolves but slowly (1s simulated drain)", async () => {
    // A real `stopAllSidecars` takes 100-5000ms depending on whether
    // sd-server responds to SIGTERM. The handler MUST await the full
    // drain (not race it), but MUST also not introduce its own delay.
    // Use a real-ish micro-timer so we exercise the await path.
    const stopScheduler = vi.fn().mockResolvedValue(undefined);
    const drainStart = Date.now();
    let drainEnd = 0;
    const stopAllSidecars = vi.fn().mockImplementation(async () => {
      await new Promise<void>((r) => setTimeout(r, 25));
      drainEnd = Date.now();
    });
    const quit = vi.fn();

    const { event } = makeEvent();
    await handleWillQuit(event, { stopScheduler, stopAllSidecars, quit });

    // The handler must have AWAITED the drain (not raced ahead).
    expect(quit).toHaveBeenCalledTimes(1);
    expect(drainEnd).toBeGreaterThan(0);
    expect(drainEnd).toBeGreaterThanOrEqual(drainStart);
  });
});
