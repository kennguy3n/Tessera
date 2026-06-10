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
    // `main.ts` registers the `tessera://` deeplink
    // scheme before `whenReady` resolves. The will-quit tests
    // never exercise the deeplink path (they hold `whenReady`
    // pending), but the scheme registration runs during module
    // evaluation, so the mock has to expose this method.
    setAsDefaultProtocolClient: vi.fn().mockReturnValue(true),
    off: vi.fn(),
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
  // `main.ts` now imports `assetProtocol.ts` at module load and
  // synchronously calls `registerAssetProtocolScheme()` (which
  // forwards to `protocol.registerSchemesAsPrivileged`). The
  // will-quit tests never reach the handler installation path
  // (`whenReady` is stubbed to a never-resolving Promise), but the
  // scheme-registration call DOES run during module evaluation, so
  // the mock must expose `protocol` as an importable shape
  // otherwise the module load throws `No "protocol" export is
  // defined on the "electron" mock`. `net` is included for the
  // same reason — it's imported by `assetProtocol.ts` even though
  // its `net.fetch` is unreachable here.
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
  net: {
    fetch: vi.fn(),
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
  // `main.ts` now calls
  // `attachKchatDeeplinkBridge()` at module top-level (so macOS
  // cold-start `open-url` events aren't lost). The stub must be a
  // callable vi.fn so module load completes; the will-quit tests
  // never reach the deeplink path themselves.
  attachKchatDeeplinkBridge: vi.fn(),
  // Defense in depth: stub the other `appState` exports that
  // `main.ts` imports. They currently live inside the `whenReady`
  // callback (which the test stubs to never resolve), so they are
  // not invoked at module-load today. Stubbing them costs nothing
  // and prevents a future top-level call from silently breaking
  // this test.
  detachKchatDeeplinkBridge: vi.fn(),
  startKchatLocalApiServer: vi.fn().mockResolvedValue(undefined),
  stopKchatLocalApiServer: vi.fn().mockResolvedValue(undefined),
  buildLocalApiHandlers: vi.fn().mockReturnValue({}),
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

/**
 * `handleWillQuit` now takes `stopKchatLocalApi` and
 * `detachKchatDeeplinkBridge` via the same dep-injection seam as
 * `stopScheduler` / `stopAllSidecars` / `quit`. Tests that don't
 * specifically care about these two steps (the bulk of the
 * existing suite) get no-op spies so the outer `try/finally`
 * ordering remains the only thing under test.
 * Tests that DO care about the ordering of the new steps build
 * their own deps inline so they can observe the call order.
 */
function makeKchatShutdownDeps(): {
  stopKchatLocalApi: ReturnType<typeof vi.fn>;
  detachKchatDeeplinkBridge: ReturnType<typeof vi.fn>;
} {
  return {
    stopKchatLocalApi: vi.fn().mockResolvedValue(undefined),
    detachKchatDeeplinkBridge: vi.fn(),
  };
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
    await handleWillQuit(event, {
      ...makeKchatShutdownDeps(),
      stopScheduler,
      stopAllSidecars,
      quit,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopScheduler).toHaveBeenCalledTimes(1);
    expect(stopAllSidecars).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
    // Scheduler MUST drain before sidecars \u2014 otherwise an in-flight
    // scheduler tick could open a fresh bridge call against a
    // sidecar that's already SIGTERM'd.
    expect(order).toEqual(["stopScheduler", "stopAllSidecars", "quit"]);
  });

  // Now that the kchat-localhost-API shutdown and the deeplink
  // detach run through the dep-injection seam (rather than as
  // direct module imports), pin the full ordering:
  // scheduler → sidecars →
  // kchatLocalApi → detachDeeplink → quit. Sidecars must drain
  // before the local API server stops because the .kcz extension
  // inside KChat Desktop should be told "Tessera is gone" (via the
  // socket close) AFTER any in-flight sidecar requests have been
  // settled — closing earlier would leave the extension polling a
  // dead socket while Tessera is still drawing CPU cycles. The
  // deeplink detach runs last because it has the smallest blast
  // radius: removing the Electron listeners cannot affect any
  // other shutdown step.
  it(
    "runs the full shutdown order: stopBatteryMonitor → scheduler → sidecars → " +
      "kchatLocalApi → detachDeeplink → disposeBridge → quit",
    async () => {
      const order: string[] = [];
      // Wire EVERY dep — including the two optional ones
      // (`stopBatteryMonitor`, `disposeBridge`) — so this test documents
      // the complete production sequence rather than a subset. The
      // dedicated tests below still pin the battery-monitor-first and
      // disposeBridge-last guarantees in isolation.
      const stopBatteryMonitor = vi.fn().mockImplementation(() => {
        order.push("stopBatteryMonitor");
      });
      const stopScheduler = vi.fn().mockImplementation(async () => {
        order.push("stopScheduler");
      });
      const stopAllSidecars = vi.fn().mockImplementation(async () => {
        order.push("stopAllSidecars");
      });
      const stopKchatLocalApi = vi.fn().mockImplementation(async () => {
        order.push("stopKchatLocalApi");
      });
      const detachKchatDeeplinkBridge = vi.fn().mockImplementation(() => {
        order.push("detachKchatDeeplinkBridge");
      });
      const disposeBridge = vi.fn().mockImplementation(() => {
        order.push("disposeBridge");
      });
      const quit = vi.fn().mockImplementation(() => {
        order.push("quit");
      });

      const { event } = makeEvent();
      await handleWillQuit(event, {
        stopBatteryMonitor,
        stopScheduler,
        stopAllSidecars,
        stopKchatLocalApi,
        detachKchatDeeplinkBridge,
        disposeBridge,
        quit,
      });

      expect(order).toEqual([
        "stopBatteryMonitor",
        "stopScheduler",
        "stopAllSidecars",
        "stopKchatLocalApi",
        "detachKchatDeeplinkBridge",
        "disposeBridge",
        "quit",
      ]);
    },
  );

  // LW-3: `stopBatteryMonitor` is now injected via `deps` (rather than
  // called as a direct module import), so the ordering it documents —
  // "stop the battery poll FIRST, synchronously, before any async
  // drain" — is verifiable here. It is synchronous and never-throwing,
  // so it must land before `stopScheduler` even when the scheduler
  // resolves on a later microtask.
  it("stops the battery monitor first, before the async drains", async () => {
    const order: string[] = [];
    const stopBatteryMonitor = vi.fn().mockImplementation(() => {
      order.push("stopBatteryMonitor");
    });
    const stopScheduler = vi.fn().mockImplementation(async () => {
      order.push("stopScheduler");
    });
    const stopAllSidecars = vi.fn().mockImplementation(async () => {
      order.push("stopAllSidecars");
    });
    const quit = vi.fn().mockImplementation(() => {
      order.push("quit");
    });

    const { event } = makeEvent();
    await handleWillQuit(event, {
      stopBatteryMonitor,
      stopScheduler,
      stopAllSidecars,
      stopKchatLocalApi: vi.fn().mockResolvedValue(undefined),
      detachKchatDeeplinkBridge: vi.fn(),
      quit,
    });

    expect(stopBatteryMonitor).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe("stopBatteryMonitor");
    expect(order).toEqual([
      "stopBatteryMonitor",
      "stopScheduler",
      "stopAllSidecars",
      "quit",
    ]);
  });

  it(
    "calls app.quit() even when stopKchatLocalApi rejects (errors swallowed)",
    async () => {
      const errSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const stopKchatLocalApi = vi
        .fn()
        .mockRejectedValue(new Error("local API hung on socket close"));
      const detachKchatDeeplinkBridge = vi.fn();
      const quit = vi.fn();

      const { event } = makeEvent();
      await handleWillQuit(event, {
        stopScheduler: vi.fn().mockResolvedValue(undefined),
        stopAllSidecars: vi.fn().mockResolvedValue(undefined),
        stopKchatLocalApi,
        detachKchatDeeplinkBridge,
        quit,
      });

      // The local-API shutdown failure MUST NOT skip the deeplink
      // detach OR the outer `app.quit()`. The two new steps each
      // own a `try/catch` and share the outer `finally` with the
      // existing steps, so the doomsday "every step throws" case
      // still terminates the process.
      expect(stopKchatLocalApi).toHaveBeenCalledTimes(1);
      expect(detachKchatDeeplinkBridge).toHaveBeenCalledTimes(1);
      expect(quit).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalled();
      const allCalls = errSpy.mock.calls
        .map((c) => c.map((v) => String(v)).join(" "))
        .join("\n");
      expect(allCalls).toContain("kchatLocalApi shutdown failed");
      expect(allCalls).toContain("local API hung on socket close");
    },
  );

  it(
    "calls app.quit() even when detachKchatDeeplinkBridge throws (errors swallowed)",
    async () => {
      const errSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const detachKchatDeeplinkBridge = vi.fn().mockImplementation(() => {
        throw new Error("deeplink removeListener threw");
      });
      const quit = vi.fn();

      const { event } = makeEvent();
      await handleWillQuit(event, {
        stopScheduler: vi.fn().mockResolvedValue(undefined),
        stopAllSidecars: vi.fn().mockResolvedValue(undefined),
        stopKchatLocalApi: vi.fn().mockResolvedValue(undefined),
        detachKchatDeeplinkBridge,
        quit,
      });

      // The deeplink detach is the LAST inner step, so a throw
      // from it must still let the outer `finally` fire `quit()`.
      expect(detachKchatDeeplinkBridge).toHaveBeenCalledTimes(1);
      expect(quit).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalled();
      const allCalls = errSpy.mock.calls
        .map((c) => c.map((v) => String(v)).join(" "))
        .join("\n");
      expect(allCalls).toContain("kchatDeeplink detach failed");
      expect(allCalls).toContain("deeplink removeListener threw");
    },
  );

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
      ...makeKchatShutdownDeps(),
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
    await handleWillQuit(event, {
      ...makeKchatShutdownDeps(),
      stopScheduler,
      stopAllSidecars,
      quit,
    });

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
    await handleWillQuit(event, {
      ...makeKchatShutdownDeps(),
      stopScheduler,
      stopAllSidecars,
      quit,
    });

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
    await handleWillQuit(event, {
      ...makeKchatShutdownDeps(),
      stopScheduler,
      stopAllSidecars,
      quit,
    });

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
    // `handleWillQuit` WILL reject with the logger's error — JS
    // `finally` doesn't swallow exceptions, it just guarantees the
    // `finally` body runs and then re-throws whatever was in flight.
    // The contract this test pins is NOT "no rejection" — it's
    // "`deps.quit()` still fires before the rejection propagates".
    // The `.rejects.toThrow("logger broke")` matcher below asserts
    // the rejection escapes the function (so any caller using
    // `.catch()` can still observe and log it); the `expect(quit)`
    // matcher further down asserts the outer finally fired first.
    await expect(
      handleWillQuit(event, {
        ...makeKchatShutdownDeps(),
        stopScheduler,
        stopAllSidecars,
        quit,
      }),
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
      ...makeKchatShutdownDeps(),
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
      ...makeKchatShutdownDeps(),
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
    await handleWillQuit(event, {
      ...makeKchatShutdownDeps(),
      stopScheduler,
      stopAllSidecars,
      quit,
    });

    // The handler must have AWAITED the drain (not raced ahead).
    expect(quit).toHaveBeenCalledTimes(1);
    expect(drainEnd).toBeGreaterThan(0);
    expect(drainEnd).toBeGreaterThanOrEqual(drainStart);
  });
});
