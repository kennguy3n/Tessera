/**
 * Phase 14 Round 11 Devin Review ANALYSIS_0002 — regression
 * coverage for the concurrency-safe `startKchatLocalApiServer()`
 * lifecycle helper in `appState.ts`.
 *
 * Why a dedicated file: the suite in
 * `kchatDesktopIntegration.test.ts` exercises the
 * `KchatLocalApiServer` *class* directly and intentionally avoids
 * importing `appState.ts` (which drags in `electron`, `sidecar`,
 * `dbKey`, `kchatAuth`, etc. — heavy transitive deps unrelated to
 * the loopback-API contract). The race we care about here lives at
 * the *module* layer (the singleton slot + pending-promise slot),
 * so we mock `electron` and `kchatLocalApi` and import the module
 * function in isolation. This keeps the integration suite free of
 * the electron mock while still pinning the structural fix.
 *
 * The race the fix closes: two callers entering
 * `startKchatLocalApiServer()` concurrently both observed
 * `kchatLocalApiServer === null` before either completed
 * `server.start()`. Both constructed a `KchatLocalApiServer`,
 * both called `start()`, both bound a port, and only the second
 * caller's instance was retained in the module slot — the first
 * caller's bound socket leaked for the rest of the process
 * lifetime. The fix stores the in-flight start promise so
 * concurrent callers coalesce onto it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `appState.ts` imports `electron` at module top-level. Replace it
// with the bare-minimum surface the import chain needs to evaluate
// without crashing — `appState.ts` only reads `app` from electron,
// and only at lazy-initialization time (well inside the functions
// we never call from this file).
vi.mock("electron", () => ({
  app: {
    on: vi.fn(),
    off: vi.fn(),
    getPath: (k: string) => `/tmp/tessera-test-${k}`,
    getName: () => "tessera-test",
    getVersion: () => "0.0.0-test",
    getLocale: () => "en-US",
    whenReady: vi.fn().mockReturnValue(new Promise(() => {})),
    setAppUserModelId: vi.fn(),
    setAsDefaultProtocolClient: vi.fn().mockReturnValue(true),
    requestSingleInstanceLock: vi.fn().mockReturnValue(true),
    isPackaged: false,
    quit: vi.fn(),
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(""),
    decryptString: () => "",
  },
  session: {
    defaultSession: {
      webRequest: { onHeadersReceived: vi.fn() },
      cookies: { get: vi.fn().mockResolvedValue([]) },
    },
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  Menu: {
    buildFromTemplate: vi.fn().mockReturnValue({}),
    setApplicationMenu: vi.fn(),
  },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
  net: { fetch: vi.fn() },
}));

// Replace the real `KchatLocalApiServer` with a counted fake.
// The fake exposes:
//   - `constructorCalls` — how many times the singleton helper
//     allocated a server (one is correct; two is the race).
//   - `startResolvers` — a list of `() => void` we can invoke to
//     unblock each fake `start()` independently, so we can hold
//     the first start in-flight while a second caller arrives.
//
// All other exports (`LOCAL_API_CAPABILITIES`, type re-exports,
// `LocalApiError`) are passed through so `appState.ts` evaluates.
interface FakeServer {
  id: number;
  startResolver: () => void;
  startCalled: boolean;
  stopCalled: boolean;
}

const constructorCalls: FakeServer[] = [];

vi.mock("../kchat/kchatLocalApi", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../kchat/kchatLocalApi")>();
  class CountedFakeServer {
    private readonly self: FakeServer;
    constructor() {
      this.self = {
        id: constructorCalls.length + 1,
        startResolver: () => {},
        startCalled: false,
        stopCalled: false,
      };
      constructorCalls.push(this.self);
    }
    start(): Promise<{ port: number; token: string }> {
      this.self.startCalled = true;
      return new Promise<{ port: number; token: string }>((resolveFn) => {
        this.self.startResolver = () => {
          resolveFn({ port: 50_000 + this.self.id, token: "fake-token" });
        };
      });
    }
    stop(): Promise<void> {
      this.self.stopCalled = true;
      return Promise.resolve();
    }
    port(): number | null {
      return this.self.startCalled ? 50_000 + this.self.id : null;
    }
    snapshotForRenderer(): {
      apiServerRunning: boolean;
      apiServerPort: number | null;
      portFilePath: string | null;
      lastExtensionContactAt: string | null;
    } {
      return {
        apiServerRunning: this.self.startCalled,
        apiServerPort: this.self.startCalled ? 50_000 + this.self.id : null,
        portFilePath: null,
        lastExtensionContactAt: null,
      };
    }
  }
  return {
    ...actual,
    KchatLocalApiServer: CountedFakeServer,
  };
});

// Heavy unrelated transitive imports — stub to no-ops so
// `appState.ts` can evaluate without dragging the world in.
vi.mock("../sidecar", () => ({ ModelSidecar: class {} }));
vi.mock("../diffusionSidecar", () => ({
  DiffusionSidecar: class {},
  resolveDiffusionBinary: vi.fn(),
}));
vi.mock("../kchat/kchatAuth", () => ({ KchatAuthService: class {} }));
vi.mock("../kchat/kchatEventForwarder", () => ({
  KchatEventForwarder: class {},
}));
vi.mock("../dbKey", () => ({
  getOrCreateDbKeyAsync: vi.fn(),
  EncryptionUnavailableError: class extends Error {},
}));
vi.mock("../logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describe("startKchatLocalApiServer — singleton + concurrency", () => {
  beforeEach(() => {
    constructorCalls.length = 0;
  });

  afterEach(async () => {
    // Always tear down whatever was started, so the next test
    // begins with a fresh module slot. We import lazily inside
    // each test to make sure mocks above are wired before the
    // module evaluates.
    const { stopKchatLocalApiServer } = await import("../appState");
    await stopKchatLocalApiServer();
  });

  it(
    "coalesces concurrent start() calls onto a single bound server",
    async () => {
      const { startKchatLocalApiServer } = await import("../appState");

      const handlers = {
        status: vi.fn(),
        listSources: vi.fn(),
        ingestChannel: vi.fn(),
        shareArtifact: vi.fn(),
      };

      // Kick off two concurrent starts BEFORE either resolves —
      // this is the race the fix has to close.
      const firstP = startKchatLocalApiServer("/tmp/tessera-test", handlers);
      const secondP = startKchatLocalApiServer("/tmp/tessera-test", handlers);

      // Yield once so any sync portion of both calls (the
      // `kchatLocalApiServer !== null` check and the pending-promise
      // slot assignment) runs. After this yield, exactly one
      // CountedFakeServer must exist: the second caller observed
      // the pending-promise slot and joined it rather than
      // constructing its own.
      await Promise.resolve();
      expect(constructorCalls.length).toBe(1);
      expect(constructorCalls[0]?.startCalled).toBe(true);

      // Unblock the single in-flight start.
      constructorCalls[0]?.startResolver();

      const [first, second] = await Promise.all([firstP, secondP]);
      // Both callers must receive the same instance — not two
      // separately-constructed servers wrapping the same port.
      expect(first).toBe(second);
      // And no second constructor ran while we awaited.
      expect(constructorCalls.length).toBe(1);
    },
  );

  it("returns the cached instance synchronously on a sequential second call", async () => {
    const { startKchatLocalApiServer } = await import("../appState");
    const handlers = {
      status: vi.fn(),
      listSources: vi.fn(),
      ingestChannel: vi.fn(),
      shareArtifact: vi.fn(),
    };

    // Drive a single start through to completion.
    const firstP = startKchatLocalApiServer("/tmp/tessera-test", handlers);
    await Promise.resolve();
    constructorCalls[0]?.startResolver();
    const first = await firstP;
    expect(constructorCalls.length).toBe(1);

    // A second call AFTER the first resolves must hit the cached-
    // instance branch — no new constructor, no new start call.
    const second = await startKchatLocalApiServer(
      "/tmp/tessera-test",
      handlers,
    );
    expect(second).toBe(first);
    expect(constructorCalls.length).toBe(1);
  });

  it(
    "clears the pending-promise slot so a stop during an in-flight start cannot resurrect it",
    async () => {
      const { startKchatLocalApiServer, stopKchatLocalApiServer } =
        await import("../appState");
      const handlers = {
        status: vi.fn(),
        listSources: vi.fn(),
        ingestChannel: vi.fn(),
        shareArtifact: vi.fn(),
      };

      // Start once and drive to completion.
      const firstP = startKchatLocalApiServer("/tmp/tessera-test", handlers);
      await Promise.resolve();
      constructorCalls[0]?.startResolver();
      await firstP;

      // Stop. The module slot is cleared.
      await stopKchatLocalApiServer();
      expect(constructorCalls[0]?.stopCalled).toBe(true);

      // A second start AFTER the stop must construct a NEW
      // server (because the previous slot was cleared). The
      // pending-promise slot must also be clear so it doesn't
      // still hold the previous (resolved) promise and prevent
      // the new construction.
      const secondP = startKchatLocalApiServer(
        "/tmp/tessera-test",
        handlers,
      );
      await Promise.resolve();
      expect(constructorCalls.length).toBe(2);
      constructorCalls[1]?.startResolver();
      await secondP;
    },
  );
});
