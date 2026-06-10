/**
 * Rate-limit gate on the `runtime:downloadRecommended` IPC handler
 * (Session 5, Step 1 + 6).
 *
 * The recommended-model install is reachable from the renderer (the
 * ModelDownloadBanner "Retry" button). Like the sibling outbound /
 * expensive channels, the handler consumes a token from
 * `defaultRateLimiter` at the top of its body so a buggy or compromised
 * renderer cannot hammer the channel with cheap-but-unbounded manifest
 * reads + install-state stats that all funnel into the per-slot download
 * lock. The first-launch auto-download path is unaffected because it
 * calls `downloadRecommendedModel` directly in the main process,
 * bypassing this IPC handler entirely.
 *
 * The configured profile is 1 token / 5s (no burst), so the first call
 * in a window passes and the immediate second call trips the gate. We
 * force the model manifest to resolve no candidate so the handler body
 * is a cheap no-op (`downloadRecommendedModel` returns null) and the
 * test exercises ONLY the rate-limit gate, not the download machinery.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const handleMock = vi.fn();
const removeHandlerMock = vi.fn();

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/userData") },
  ipcMain: {
    handle: (...args: unknown[]) => handleMock(...args),
    removeHandler: (...args: unknown[]) => removeHandlerMock(...args),
  },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));

vi.mock("../appState", () => ({
  getModelSidecar: () => null,
}));

// Partial mock of modelManagement: `recommendModel` returns null so
// `resolveRecommendedModel` (and therefore `downloadRecommendedModel`)
// short-circuits to null without touching the filesystem or network.
// `parseModelCapability` must round-trip "text" so `coerceCapability`
// accepts the input before the rate-limit gate is reached.
vi.mock("../modelManagement", () => ({
  ALL_MODEL_CAPABILITIES: ["text", "vision", "imagegen"],
  parseModelCapability: (s: string) =>
    s === "text" || s === "vision" || s === "imagegen" ? s : null,
  detectPlatformInfo: () => ({ platform: "linux-x64", tier: "mid" }),
  detectComputeBackends: () => [],
  loadManifest: () => ({ models: [] }),
  resetManifestCache: () => undefined,
  recommendModel: () => null,
  downloadModel: vi.fn(),
  deleteCurrentModel: vi.fn(),
  getInstalledModel: vi.fn(),
  getInstalledModels: vi.fn(),
  isCapabilityAvailable: vi.fn(),
  isModelInstalled: vi.fn(),
  listModelsForPlatform: () => [],
  planDownload: vi.fn(),
}));

// `progressEmitter` wraps this; a no-op sender keeps the handler body
// from reaching into a real BrowserWindow.
vi.mock("../ipc/model", () => ({
  safeRendererSender: () => () => undefined,
}));

import { registerRuntimeHandlers } from "../ipc/runtime";
import { defaultRateLimiter, RateLimitError } from "../ipc/rateLimiter";

function getHandler(
  channel: string,
): (event: unknown, ...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as (event: unknown, ...args: unknown[]) => unknown;
}

describe("runtime:downloadRecommended rate limit", () => {
  beforeEach(() => {
    handleMock.mockClear();
    defaultRateLimiter.reset();
    registerRuntimeHandlers();
  });

  it("allows the first call but rejects an immediate second within the window", async () => {
    const handler = getHandler("runtime:downloadRecommended");
    const event = { sender: { isDestroyed: () => false } };

    // First call: bucket starts full (1 token). The manifest resolves no
    // candidate so the body is a cheap no-op returning null.
    await expect(handler(event, "text")).resolves.toBeNull();

    // Second call in the same 5s window: the per-slot bucket is empty, so
    // the shared limiter throws RateLimitError naming the capability key.
    await expect(handler(event, "text")).rejects.toBeInstanceOf(RateLimitError);
    await expect(handler(event, "text")).rejects.toThrow(
      /runtime:downloadRecommended:text/,
    );
  });

  it("keys the budget per capability slot and independently from downloadModel", async () => {
    const recommended = getHandler("runtime:downloadRecommended");
    const event = { sender: { isDestroyed: () => false } };

    // Exhaust the text slot's budget.
    await recommended(event, "text");
    await expect(recommended(event, "text")).rejects.toBeInstanceOf(
      RateLimitError,
    );

    // A different slot has its own bucket, so it still passes (the
    // manifest resolves no candidate, so the body is a cheap null no-op).
    await expect(recommended(event, "vision")).resolves.toBeNull();

    // Distinct per-capability keys are tracked; neither the undiscriminated
    // channel name nor downloadModel's bucket is ever used here.
    expect(
      defaultRateLimiter.inspect("runtime:downloadRecommended:text"),
    ).toBeDefined();
    expect(
      defaultRateLimiter.inspect("runtime:downloadRecommended:vision"),
    ).toBeDefined();
    expect(
      defaultRateLimiter.inspect("runtime:downloadRecommended"),
    ).toBeUndefined();
    expect(defaultRateLimiter.inspect("runtime:downloadModel")).toBeUndefined();
  });
});
