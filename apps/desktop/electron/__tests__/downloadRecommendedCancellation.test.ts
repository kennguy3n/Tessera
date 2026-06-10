/**
 * Tests for the two follow-ups layered onto `downloadRecommendedModel`
 * and the `runtime:cancelDownload` IPC handler:
 *
 *  1. Single resolution — when a caller (the first-launch auto-download)
 *     hands in a pre-resolved `ResolvedModel`, the manifest is NOT
 *     resolved a second time; when no model is supplied (the IPC path),
 *     it resolves exactly once internally.
 *  2. True cancellation — the download registers an `AbortController`
 *     in the per-capability `downloadCancellations` registry for the
 *     lifetime of the transfer, `runtime:cancelDownload` aborts it, and
 *     the controller is deregistered once the call settles.
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

const RESOLVED = {
  id: "text-model-1",
  capability: "text",
  format: "gguf",
  filename: "text-model-1.gguf",
  url: "https://models.example.com/text-model-1.gguf",
  downloadSizeMb: 450,
  diskSizeMb: 450,
};

const RECORD = {
  id: RESOLVED.id,
  capability: "text",
  filename: RESOLVED.filename,
  path: `/tmp/userData/models/${RESOLVED.filename}`,
};

const recommendModelMock = vi.fn(() => RESOLVED);
const downloadModelMock = vi.fn();
const isModelInstalledMock = vi.fn(async () => null);

vi.mock("../modelManagement", () => {
  // Declared INSIDE the factory: `vi.mock` is hoisted above module-scope
  // declarations, so a class defined at file scope is still in its TDZ
  // when the factory runs.
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
  detectPlatformInfo: () => ({ platform: "linux-x64", tier: "mid" }),
  detectComputeBackends: () => [],
  loadManifest: () => ({ models: [RESOLVED] }),
  resetManifestCache: () => undefined,
  recommendModel: (...args: unknown[]) => recommendModelMock(...args),
  downloadModel: (...args: unknown[]) => downloadModelMock(...args),
  deleteCurrentModel: vi.fn(),
  getInstalledModel: vi.fn(),
  getInstalledModels: vi.fn(),
  isCapabilityAvailable: vi.fn(),
  isModelInstalled: (...args: unknown[]) => isModelInstalledMock(...args),
  listModelsForPlatform: () => [],
  planDownload: vi.fn(),
  };
});

vi.mock("../ipc/model", () => ({
  safeRendererSender: () => () => undefined,
}));

import {
  downloadRecommendedModel,
  registerRuntimeHandlers,
} from "../ipc/runtime";
import { downloadCancellations } from "../modelDownloadControl";
import { defaultRateLimiter } from "../ipc/rateLimiter";

function getHandler(
  channel: string,
): (event: unknown, ...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as (event: unknown, ...args: unknown[]) => unknown;
}

beforeEach(() => {
  handleMock.mockClear();
  recommendModelMock.mockClear();
  downloadModelMock.mockReset();
  isModelInstalledMock.mockReset();
  isModelInstalledMock.mockResolvedValue(null);
  downloadCancellations.reset();
  defaultRateLimiter.reset();
});

describe("downloadRecommendedModel — single resolution", () => {
  it("reuses a pre-resolved model and does NOT resolve the manifest again", async () => {
    downloadModelMock.mockResolvedValue(RECORD);

    const record = await downloadRecommendedModel(
      "text",
      () => {},
      RESOLVED as never,
    );

    expect(record).toBe(RECORD);
    // The gate already resolved it; the download phase must not re-resolve.
    expect(recommendModelMock).not.toHaveBeenCalled();
    // The pre-resolved identity is exactly what gets downloaded.
    expect(downloadModelMock).toHaveBeenCalledTimes(1);
    expect(downloadModelMock.mock.calls[0][1]).toBe(RESOLVED);
  });

  it("resolves exactly once internally when no model is supplied", async () => {
    downloadModelMock.mockResolvedValue(RECORD);

    await downloadRecommendedModel("text", () => {});

    // Resolved once (no double resolution between a gate and the download).
    expect(recommendModelMock).toHaveBeenCalledTimes(1);
  });

  it("returns null without downloading when nothing resolves", async () => {
    recommendModelMock.mockReturnValueOnce(null as never);

    const record = await downloadRecommendedModel("text", () => {});

    expect(record).toBeNull();
    expect(downloadModelMock).not.toHaveBeenCalled();
  });
});

describe("downloadRecommendedModel — cancellation registry lifecycle", () => {
  it("registers an AbortController for the slot during the transfer and deregisters after", async () => {
    let capturedSignal: AbortSignal | undefined;
    downloadModelMock.mockImplementation(
      async (_dir: string, _model: unknown, _emit: unknown, deps: { signal?: AbortSignal }) => {
        capturedSignal = deps.signal;
        // Mid-transfer: the slot is active and the signal is live.
        expect(downloadCancellations.isActive("text")).toBe(true);
        expect(deps.signal).toBeInstanceOf(AbortSignal);
        return RECORD;
      },
    );

    await downloadRecommendedModel("text", () => {}, RESOLVED as never);

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    // Deregistered in `finally` once the call settles.
    expect(downloadCancellations.isActive("text")).toBe(false);
  });

  it("registers the controller BEFORE the installed-state probe so a cancel in that gap still aborts", async () => {
    // Hold `isModelInstalled` pending to simulate the async stat being
    // in flight when the user clicks Skip. Before the fix the controller
    // was only registered AFTER this probe resolved, so a cancel landing
    // here found nothing to abort and the download proceeded.
    let releaseProbe: (v: null) => void = () => {};
    isModelInstalledMock.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          releaseProbe = resolve;
        }),
    );
    let sawAbortedSignal: boolean | undefined;
    downloadModelMock.mockImplementation(
      async (
        _dir: string,
        _model: unknown,
        _emit: unknown,
        deps: { signal?: AbortSignal },
      ) => {
        sawAbortedSignal = deps.signal?.aborted === true;
        if (deps.signal?.aborted) throw deps.signal.reason;
        return RECORD;
      },
    );

    const promise = downloadRecommendedModel("text", () => {}, RESOLVED as never);

    // The slot is already active while the probe is still pending.
    expect(downloadCancellations.isActive("text")).toBe(true);
    // Skip during the probe aborts the registered controller.
    expect(downloadCancellations.cancel("text")).toBe(true);
    // Probe now resolves "not installed", so the transfer phase runs —
    // and receives the already-aborted signal, bailing immediately.
    releaseProbe(null);

    await expect(promise).rejects.toBeTruthy();
    expect(sawAbortedSignal).toBe(true);
    expect(downloadCancellations.isActive("text")).toBe(false);
  });

  it("deregisters even when the download throws", async () => {
    downloadModelMock.mockRejectedValue(new Error("disk full"));

    await expect(
      downloadRecommendedModel("text", () => {}, RESOLVED as never),
    ).rejects.toThrow(/disk full/);

    expect(downloadCancellations.isActive("text")).toBe(false);
  });

  it("aborting via the registry signals the in-flight download", async () => {
    let sawAbort = false;
    downloadModelMock.mockImplementation(
      async (_dir: string, _model: unknown, _emit: unknown, deps: { signal?: AbortSignal }) => {
        // Simulate a user clicking Skip mid-transfer.
        const cancelled = downloadCancellations.cancel("text");
        expect(cancelled).toBe(true);
        sawAbort = deps.signal?.aborted === true;
        // The download engine would reject with the abort reason.
        throw deps.signal?.reason;
      },
    );

    await expect(
      downloadRecommendedModel("text", () => {}, RESOLVED as never),
    ).rejects.toBeTruthy();

    expect(sawAbort).toBe(true);
    expect(downloadCancellations.isActive("text")).toBe(false);
  });
});

describe("runtime:cancelDownload handler", () => {
  beforeEach(() => {
    registerRuntimeHandlers();
  });

  it("aborts an in-flight download for the slot and returns true", async () => {
    const handler = getHandler("runtime:cancelDownload");
    const event = { sender: { isDestroyed: () => false } };

    const controller = downloadCancellations.begin("text");

    const result = await handler(event, "text");

    expect(result).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("returns false when nothing is downloading in the slot", async () => {
    const handler = getHandler("runtime:cancelDownload");
    const event = { sender: { isDestroyed: () => false } };

    await expect(handler(event, "text")).resolves.toBe(false);
  });

  it("defaults to the text slot when capability is omitted", async () => {
    const handler = getHandler("runtime:cancelDownload");
    const event = { sender: { isDestroyed: () => false } };

    const controller = downloadCancellations.begin("text");

    await expect(handler(event, undefined)).resolves.toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("only cancels the requested slot, leaving other slots untouched", async () => {
    const handler = getHandler("runtime:cancelDownload");
    const event = { sender: { isDestroyed: () => false } };

    const text = downloadCancellations.begin("text");
    const vision = downloadCancellations.begin("vision");

    await handler(event, "text");

    expect(text.signal.aborted).toBe(true);
    expect(vision.signal.aborted).toBe(false);
  });
});
