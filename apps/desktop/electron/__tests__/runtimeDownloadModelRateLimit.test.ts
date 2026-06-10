/**
 * Rate-limit gate on the `runtime:downloadModel` IPC handler.
 *
 * `runtime:downloadModel` is reachable from the renderer (the per-slot
 * model panels in Settings → Models). Like its sibling
 * `runtime:downloadRecommended` and the other expensive channels, the
 * handler now consumes a token from `defaultRateLimiter` before the
 * manifest read + install-state stat, making the rate limiter's
 * documented "safety net" for this channel real. The per-slot download
 * lock still serialises the actual mutation; this just rejects abusive
 * *start* attempts cheaply.
 *
 * The budget is keyed PER capability slot (`runtime:downloadModel:
 * <capability>`) so a legitimate burst across slots (text then vision)
 * is never throttled — only repeated starts on the SAME slot are. These
 * tests pin both properties.
 *
 * We mock the model lookup so a known text/vision model resolves, and
 * make `isModelInstalled` report the model as already installed so the
 * handler returns BEFORE touching the download machinery — the test
 * exercises ONLY the rate-limit gate.
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

const TEXT_MODEL = { id: "text-model-v1", capability: "text" };
const VISION_MODEL = { id: "vision-model-v1", capability: "vision" };

// `findModelOrThrow` resolves via `listModelsForPlatform`; we return both
// a text and a vision model so the per-capability discriminator can be
// exercised. `isModelInstalled` resolves truthy so the handler returns
// the existing record immediately after the rate-limit gate, never
// reaching `downloadModel`.
vi.mock("../modelManagement", () => {
  // `modelDownloadControl` (loaded transitively via `runtime.ts`) imports
  // `DownloadAbortedError` from this module; the mock must export it so the
  // binding is a real constructor rather than `undefined`. Declared inside
  // the factory because `vi.mock` is hoisted above file-scope declarations.
  class FakeAbortedError extends Error {
    constructor(message = "Download aborted") {
      super(message);
      this.name = "DownloadAbortedError";
    }
  }
  return {
    ALL_MODEL_CAPABILITIES: ["text", "vision", "imagegen"],
    DownloadAbortedError: FakeAbortedError,
    isDownloadAbortedError: (err: unknown) =>
      err instanceof FakeAbortedError ||
      (typeof err === "object" &&
        err !== null &&
        (err as { name?: unknown }).name === "AbortError"),
    parseModelCapability: (s: string) =>
      s === "text" || s === "vision" || s === "imagegen" ? s : null,
    detectPlatformInfo: () => ({
      platform: "linux-x64",
      platformLabel: "Linux x64",
      tier: "mid",
    }),
    detectComputeBackends: () => [],
    loadManifest: () => ({ models: [TEXT_MODEL, VISION_MODEL] }),
    resetManifestCache: () => undefined,
    recommendModel: () => null,
    downloadModel: vi.fn(),
    deleteCurrentModel: vi.fn(),
    getInstalledModel: vi.fn(),
    getInstalledModels: vi.fn(),
    isCapabilityAvailable: vi.fn(),
    isModelInstalled: vi.fn().mockResolvedValue({ modelId: "installed" }),
    listModelsForPlatform: () => [TEXT_MODEL, VISION_MODEL],
    planDownload: vi.fn(),
  };
});

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

describe("runtime:downloadModel rate limit", () => {
  beforeEach(() => {
    handleMock.mockClear();
    defaultRateLimiter.reset();
    registerRuntimeHandlers();
  });

  it("allows the first start but rejects an immediate second on the same slot", async () => {
    const handler = getHandler("runtime:downloadModel");
    const event = { sender: { isDestroyed: () => false } };

    // First start: bucket starts full. The model is reported installed so
    // the handler returns the existing record without downloading.
    await expect(handler(event, "text-model-v1")).resolves.toEqual({
      modelId: "installed",
    });

    // Second start in the same 5s window: the per-slot bucket is empty, so
    // the shared limiter throws RateLimitError naming the capability key.
    await expect(handler(event, "text-model-v1")).rejects.toBeInstanceOf(
      RateLimitError,
    );
    await expect(handler(event, "text-model-v1")).rejects.toThrow(
      /runtime:downloadModel:text/,
    );
  });

  it("keys the budget per capability slot (text exhaustion does not block vision)", async () => {
    const handler = getHandler("runtime:downloadModel");
    const event = { sender: { isDestroyed: () => false } };

    // Exhaust the text slot's budget.
    await handler(event, "text-model-v1");
    await expect(handler(event, "text-model-v1")).rejects.toBeInstanceOf(
      RateLimitError,
    );

    // The vision slot has its own bucket, so a download there still passes.
    await expect(handler(event, "vision-model-v1")).resolves.toEqual({
      modelId: "installed",
    });

    // Distinct keys are tracked; the undiscriminated channel name is never
    // used as a bucket key.
    expect(
      defaultRateLimiter.inspect("runtime:downloadModel:text"),
    ).toBeDefined();
    expect(
      defaultRateLimiter.inspect("runtime:downloadModel:vision"),
    ).toBeDefined();
    expect(defaultRateLimiter.inspect("runtime:downloadModel")).toBeUndefined();
  });
});
