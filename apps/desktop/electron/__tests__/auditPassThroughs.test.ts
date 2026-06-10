/**
 * Audit trail completeness.
 *
 * Cross-cutting tests verifying that the JS-side IPC handlers route
 * their security-relevant lifecycle events through the new
 * `bridgeLog*` audit pass-throughs on `NativeBridge`:
 *
 *   - `connectors:authenticate` → `bridgeLogConnectorConnected`
 *   - `connectors:sync`         → `bridgeLogConnectorSynced` (only
 *                                  when the result is `"synced"`,
 *                                  NOT on `"offline"`)
 *   - `connectors:disconnect`   → `bridgeLogConnectorDisconnected`
 *                                  with the `filesRemoved` count
 *                                  returned by the per-connector
 *                                  disconnect impl
 *   - `model:start`             → `bridgeLogModelStarted`
 *   - `model:stop`              → `bridgeLogModelStopped` with
 *                                  the `"user-requested"` reason
 *                                  (IPC is only reachable from the
 *                                  renderer, so it's user-initiated
 *                                  by construction)
 *   - `settings:update`         → `bridgeLogSettingsChanged` per
 *                                  changed field, with array fields
 *                                  logged as counts (never verbatim,
 *                                  to keep audit rows bounded)
 *   - `externalProvider:set`    → `bridgeLogSettingsChanged` per
 *                                  field with secret-safe envelopes
 *                                  (`apiKey` action: "stored" /
 *                                  "cleared" / "unchanged"; URL and
 *                                  apiKeyRef NOT logged)
 *
 * The bridge itself is mocked because the Rust addon isn't loadable
 * in the vitest JS runtime; the contract under test is the JS-side
 * "audit call shape and timing", not the audit-store persistence
 * (that's covered by the cargo tests in `tessera_audit::logger`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const captured = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
    getAppPath: vi.fn().mockReturnValue("/tmp"),
  },
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      captured.set(channel, listener);
    },
    removeHandler: (channel: string) => {
      captured.delete(channel);
    },
  },
  BrowserWindow: {
    fromWebContents: () => null,
  },
}));

// The `appState` module loads the native addon eagerly via
// `resolveNativeAddon`. We replace it with a stub whose `getBridge`
// returns the per-test mock so every audit call is observable.
const bridgeMock = {
  bridgeLogConnectorConnected: vi.fn(),
  bridgeLogConnectorSynced: vi.fn(),
  bridgeLogConnectorDisconnected: vi.fn(),
  bridgeLogModelStarted: vi.fn(),
  bridgeLogModelStopped: vi.fn(),
  bridgeLogSettingsChanged: vi.fn(),
};

vi.mock("../appState", () => ({
  getBridge: () => bridgeMock,
  getModelSidecar: () => sidecarMock,
  // LW-1: model:start now lazily constructs via ensureModelSidecar.
  // The mock returns the same stub so the audit assertions are
  // unchanged.
  ensureModelSidecar: () => sidecarMock,
  // LW-2: model:start calls enforceSidecarExclusivity before start.
  // No-op stub here — single-sidecar exclusion has its own test.
  enforceSidecarExclusivity: vi.fn().mockResolvedValue(undefined),
}));

const sidecarMock = {
  isRunning: false,
  setModelPath: vi.fn(),
  start: vi.fn().mockResolvedValue(undefined),
  // After `start()` returns, IPC handlers gate the next bridge call on
  // `waitForReady()` to avoid the spawn-vs-listener race. Tests resolve it `true` by default;
  // the handler only short-circuits to its error branch when the gate
  // returns `false`, and these audit tests verify the success path.
  waitForReady: vi.fn().mockResolvedValue(true),
  stop: vi.fn().mockResolvedValue(undefined),
};

// `config.ts` reads `app.getPath('userData')` at module-load time so
// the stub above must be in place before it imports. We also stub
// secretsVault because `externalProvider:set` writes through it.
vi.mock("../secretsVault", () => ({
  storeSecret: vi.fn(),
  deleteSecret: vi.fn(),
  getSecret: vi.fn(),
  hasSecret: vi.fn().mockReturnValue(true),
}));

vi.mock("../config", () => ({
  DEFAULT_EXTERNAL_PROVIDER: {
    enabled: false,
    providerType: "openai",
    apiUrl: "https://api.openai.com/v1",
    apiKeyRef: "external-provider",
    modelName: "gpt-4o-mini",
    maxTokens: 4096,
    temperature: 0.2,
    timeoutSecs: 60,
    maxRetries: 3,
  },
  loadConfig: () => ({
    theme: "dark",
    defaultExportFormat: "markdown",
    ignorePatterns: [],
    watchPatterns: [],
  }),
  updateConfig: vi.fn(),
}));

import { registerSettingsHandlers } from "../ipc/settings";
import { registerModelHandlers } from "../ipc/model";

beforeEach(() => {
  captured.clear();
  bridgeMock.bridgeLogConnectorConnected.mockClear();
  bridgeMock.bridgeLogConnectorSynced.mockClear();
  bridgeMock.bridgeLogConnectorDisconnected.mockClear();
  bridgeMock.bridgeLogModelStarted.mockClear();
  bridgeMock.bridgeLogModelStopped.mockClear();
  bridgeMock.bridgeLogSettingsChanged.mockClear();
  sidecarMock.isRunning = false;
  sidecarMock.setModelPath.mockClear();
  sidecarMock.start.mockClear();
  sidecarMock.waitForReady.mockClear();
  // Reset the resolved value because earlier tests in the file
  // (or future ones) may flip it to `false` to exercise the
  // not-ready error branch. The afterEach `vi.restoreAllMocks()`
  // wipes the implementation set in the `sidecarMock` declaration,
  // so re-establish the default-success values here.
  sidecarMock.waitForReady.mockResolvedValue(true);
  sidecarMock.stop.mockClear();
  sidecarMock.stop.mockResolvedValue(undefined);
  sidecarMock.start.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const listener = captured.get(channel);
  if (!listener) throw new Error(`No handler captured for channel "${channel}"`);
  // The real `ipcMain.handle` passes `{ sender }` as the first arg;
  // pass a noop event object so handlers that don't read `event` work.
  return listener({} as unknown, ...args);
}

describe("model:* IPC handlers — audit pass-throughs", () => {
  it("logs model:start with the validated model path", async () => {
    registerModelHandlers();
    await invoke("model:start", "/models/llama-3.gguf");
    expect(sidecarMock.start).toHaveBeenCalled();
    expect(bridgeMock.bridgeLogModelStarted).toHaveBeenCalledWith(
      "/models/llama-3.gguf",
    );
  });

  it("does NOT log model:stop when the sidecar wasn't running", async () => {
    registerModelHandlers();
    sidecarMock.isRunning = false;
    await invoke("model:stop");
    expect(sidecarMock.stop).not.toHaveBeenCalled();
    expect(bridgeMock.bridgeLogModelStopped).not.toHaveBeenCalled();
  });

  it("logs model:stop with the 'user-requested' reason when actually stopping", async () => {
    registerModelHandlers();
    sidecarMock.isRunning = true;
    await invoke("model:stop");
    expect(sidecarMock.stop).toHaveBeenCalled();
    expect(bridgeMock.bridgeLogModelStopped).toHaveBeenCalledWith(
      "user-requested",
    );
  });

  it("model:start audit failure does NOT propagate to the IPC caller", async () => {
    bridgeMock.bridgeLogModelStarted.mockImplementationOnce(() => {
      throw new Error("audit store unavailable");
    });
    registerModelHandlers();
    await expect(
      invoke("model:start", "/models/llama-3.gguf"),
    ).resolves.not.toThrow();
    // The model still started — the audit failure is swallowed.
    expect(sidecarMock.start).toHaveBeenCalled();
  });

  it("stops the half-started sidecar when waitForReady times out so the next model:start re-spawns cleanly instead of silently no-opping", async () => {
    // Regression test for Devin Review follow-up
    // (ANALYSIS_pr-review-job-095e635be43f4af68e37c59e0af14838_0001).
    // After start() flips _isRunning=true, a readiness timeout
    // would leave the flag stuck and cause the early-return at
    // the top of the model:start handler to silently no-op the
    // next attempt. The handler must call stop() before throwing
    // so subsequent attempts begin from a clean state and the
    // user actually sees a re-attempt instead of a phantom
    // "model already started" outcome.
    sidecarMock.waitForReady.mockResolvedValueOnce(false);
    registerModelHandlers();
    await expect(
      invoke("model:start", "/models/llama-3.gguf"),
    ).rejects.toThrow(/failed to become ready/i);
    expect(sidecarMock.start).toHaveBeenCalled();
    expect(sidecarMock.stop).toHaveBeenCalledTimes(1);
    // Audit must NOT fire when the sidecar never became ready —
    // we'd otherwise log a "model started" event for a sidecar
    // that didn't actually serve a single request.
    expect(bridgeMock.bridgeLogModelStarted).not.toHaveBeenCalled();
  });
});

describe("settings:update IPC — audit pass-throughs", () => {
  it("logs one row per scalar field the renderer sent", async () => {
    registerSettingsHandlers();
    await invoke("settings:update", {
      theme: "dark",
      defaultExportFormat: "markdown",
    });
    const calls = bridgeMock.bridgeLogSettingsChanged.mock.calls;
    expect(calls).toContainEqual(["theme", "dark"]);
    expect(calls).toContainEqual(["defaultExportFormat", "markdown"]);
    // Array fields not sent → not logged.
    expect(calls.find((c) => c[0] === "ignorePatterns")).toBeUndefined();
    expect(calls.find((c) => c[0] === "watchPatterns")).toBeUndefined();
  });

  it("logs array fields by count, never verbatim", async () => {
    registerSettingsHandlers();
    await invoke("settings:update", {
      ignorePatterns: ["*.tmp", "node_modules/**", ".git/**"],
      watchPatterns: ["src/**/*.ts"],
    });
    const calls = bridgeMock.bridgeLogSettingsChanged.mock.calls;
    expect(calls).toContainEqual(["ignorePatterns", "3 pattern(s)"]);
    expect(calls).toContainEqual(["watchPatterns", "1 pattern(s)"]);
    // None of the call arguments leaks a raw pattern body.
    for (const [, value] of calls) {
      expect(value).not.toContain("*.tmp");
      expect(value).not.toContain("node_modules");
      expect(value).not.toContain("src/");
    }
  });

  it("does NOT log fields the renderer omitted", async () => {
    registerSettingsHandlers();
    await invoke("settings:update", { theme: "light" });
    const calls = bridgeMock.bridgeLogSettingsChanged.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["theme", "light"]);
  });
});

describe("externalProvider:set IPC — audit pass-throughs", () => {
  const baseProvider = {
    enabled: true,
    providerType: "openai_compatible",
    apiUrl: "https://my.private.proxy/v1",
    apiKeyRef: "external-provider",
    modelName: "gpt-4o-mini",
    maxTokens: 4096,
    temperature: 0.2,
    timeoutSecs: 60,
    maxRetries: 3,
  };

  it("logs enabled / providerType / modelName but NEVER the apiUrl or apiKeyRef", async () => {
    registerSettingsHandlers();
    await invoke("externalProvider:set", baseProvider, null);
    const calls = bridgeMock.bridgeLogSettingsChanged.mock.calls;
    expect(calls).toContainEqual(["externalProvider.enabled", "true"]);
    expect(calls).toContainEqual([
      "externalProvider.providerType",
      "openai_compatible",
    ]);
    expect(calls).toContainEqual([
      "externalProvider.modelName",
      "gpt-4o-mini",
    ]);
    // Defence-in-depth: the URL and the keychain identifier MUST
    // NEVER appear in any audit call as a field name OR as a value.
    for (const [field, value] of calls) {
      expect(field).not.toContain("apiUrl");
      expect(field).not.toContain("apiKeyRef");
      expect(value).not.toContain("my.private.proxy");
      expect(value).not.toContain("external-provider");
    }
  });

  it("logs apiKey action 'stored' when a non-empty key is provided", async () => {
    registerSettingsHandlers();
    await invoke("externalProvider:set", baseProvider, "sk-test-1234");
    const calls = bridgeMock.bridgeLogSettingsChanged.mock.calls;
    expect(calls).toContainEqual(["externalProvider.apiKey", "stored"]);
    // The secret itself never reaches the audit pass-through.
    for (const [, value] of calls) {
      expect(value).not.toContain("sk-test-1234");
    }
  });

  it("logs apiKey action 'cleared' for empty-string apiKey", async () => {
    registerSettingsHandlers();
    await invoke("externalProvider:set", baseProvider, "");
    expect(bridgeMock.bridgeLogSettingsChanged.mock.calls).toContainEqual([
      "externalProvider.apiKey",
      "cleared",
    ]);
  });

  it("logs apiKey action 'unchanged' for null apiKey", async () => {
    registerSettingsHandlers();
    await invoke("externalProvider:set", baseProvider, null);
    expect(bridgeMock.bridgeLogSettingsChanged.mock.calls).toContainEqual([
      "externalProvider.apiKey",
      "unchanged",
    ]);
  });
});
