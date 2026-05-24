/**
 * Integration tests for the `imagegen:*` IPC channels.
 *
 * The Rust bridge and the diffusion sidecar are both mocked because:
 *   - The `.node` addon is built per platform and not available in
 *     the vitest sandbox.
 *   - The sd-server binary is a heavy native dependency that we
 *     would never want to start during unit tests.
 *
 * The test exercises the real:
 *   1. `GenerateImageSchema` strict validation (multiple-of-64
 *      dimension refinement, CFG bounds, prompt-length cap, strict-
 *      mode rejection of extra fields).
 *   2. GPU/tier gating wiring (`isCapabilityAvailable("imagegen")` is
 *      called; low-tier CPU-only hosts return false from
 *      `imagegen:isAvailable` and reject from `imagegen:generate`).
 *   3. Sidecar lifecycle (the handler reads the imagegen-slot record,
 *      sets the model path, calls `start()` once, and reuses an
 *      already-running sidecar).
 *   4. Single-in-flight invariant (a second `imagegen:generate` while
 *      the first is still awaiting the bridge rejects fast).
 *   5. PNG persistence (the returned `pngBytes` Buffer is written to
 *      `<userData>/generated-images/<artifactId>/<n>.png`).
 *   6. `sanitiseArtifactId` defence (renderer-supplied ids cannot
 *      traverse the filesystem boundary).
 *   7. Cancel handler (returns scheduled=true when an in-flight call
 *      is present, scheduled=false otherwise).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

const handleMock = vi.fn();
const removeHandlerMock = vi.fn();
const setModelPathMock = vi.fn();
const sidecarStartMock = vi.fn();
const bridgeGenerateImageMock = vi.fn();
const getInstalledModelMock = vi.fn();
const detectPlatformInfoMock = vi.fn();
const detectComputeBackendsMock = vi.fn();
const isCapabilityAvailableMock = vi.fn();

let sidecarIsRunning = false;
const sidecarStub = {
  get isRunning() {
    return sidecarIsRunning;
  },
  get endpoint() {
    return "http://127.0.0.1:8386";
  },
  setModelPath: (p: string) => setModelPathMock(p),
  start: (resetRetries?: boolean) => sidecarStartMock(resetRetries),
};

let bridgeStub: unknown = {
  bridgeGenerateImage: bridgeGenerateImageMock,
};
let diffusionSidecarStub: typeof sidecarStub | null = sidecarStub;
let userDataDirValue = "";

vi.mock("electron", () => ({
  ipcMain: {
    handle: (...args: unknown[]) => handleMock(...args),
    removeHandler: (...args: unknown[]) => removeHandlerMock(...args),
  },
  app: {
    getPath: (which: string) => {
      if (which === "userData") return userDataDirValue;
      throw new Error(`unexpected getPath: ${which}`);
    },
  },
  BrowserWindow: { fromWebContents: () => null },
}));

vi.mock("../appState", () => ({
  getBridge: () => bridgeStub,
  isBridgeAvailable: () => bridgeStub !== null,
  getDiffusionSidecar: () => diffusionSidecarStub,
}));

vi.mock("../modelManagement", async () => {
  const actual = await vi.importActual<
    typeof import("../modelManagement")
  >("../modelManagement");
  return {
    ...actual,
    getInstalledModel: (...args: unknown[]) => getInstalledModelMock(...args),
    detectPlatformInfo: () => detectPlatformInfoMock(),
    detectComputeBackends: () => detectComputeBackendsMock(),
    isCapabilityAvailable: (...args: unknown[]) =>
      isCapabilityAvailableMock(...args),
  };
});

import {
  ensureDiffusionSidecarRunning,
  probeImagegenAvailable,
  registerImagegenHandlers,
  sanitiseArtifactId,
  _resetImagegenInFlightForTests,
} from "../ipc/imagegen";
import { defaultRateLimiter } from "../ipc/rateLimiter";

function getHandler(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as (event: unknown, ...args: unknown[]) => unknown;
}

describe("sanitiseArtifactId", () => {
  it("preserves alphanumerics + dash/underscore/dot", () => {
    expect(sanitiseArtifactId("artifact_2025-11.v3")).toBe(
      "artifact_2025-11.v3",
    );
  });

  it("strips path traversal attempts", () => {
    expect(sanitiseArtifactId("../../etc/passwd")).toBe("....etcpasswd");
    expect(sanitiseArtifactId("/abs/path/x")).toBe("abspathx");
    expect(sanitiseArtifactId("a/b\\c:d")).toBe("abcd");
  });

  it("falls back to a deterministic id when the input is fully stripped", () => {
    expect(sanitiseArtifactId("/")).toBe("unknown-artifact");
    expect(sanitiseArtifactId("")).toBe("unknown-artifact");
    expect(sanitiseArtifactId("///")).toBe("unknown-artifact");
  });
});

describe("imagegen IPC handlers", () => {
  beforeEach(() => {
    handleMock.mockClear();
    removeHandlerMock.mockClear();
    setModelPathMock.mockClear();
    sidecarStartMock.mockClear();
    bridgeGenerateImageMock.mockReset();
    getInstalledModelMock.mockReset();
    detectPlatformInfoMock.mockReset();
    detectComputeBackendsMock.mockReset();
    isCapabilityAvailableMock.mockReset();
    sidecarIsRunning = false;
    diffusionSidecarStub = sidecarStub;
    bridgeStub = { bridgeGenerateImage: bridgeGenerateImageMock };

    userDataDirValue = fs.mkdtempSync(
      path.join(os.tmpdir(), "tessera-imagegen-test-"),
    );

    defaultRateLimiter.reset();
    _resetImagegenInFlightForTests();
    sidecarStartMock.mockResolvedValue(undefined);
    detectPlatformInfoMock.mockReturnValue({
      platform: "linux-x64",
      platformLabel: "Linux x64",
      totalRamGb: 32,
      tier: "high",
      tierLabel: "High",
      computeBackends: ["cuda"],
      preferredFormat: "gguf",
    });
    detectComputeBackendsMock.mockReturnValue(["cuda"]);
    isCapabilityAvailableMock.mockReturnValue(true);
    registerImagegenHandlers();
  });

  afterEach(() => {
    defaultRateLimiter.reset();
    _resetImagegenInFlightForTests();
    try {
      fs.rmSync(userDataDirValue, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  describe("imagegen:isAvailable", () => {
    it("returns true when bridge + GPU + model are all present", async () => {
      getInstalledModelMock.mockResolvedValue({ path: "/m/flux.gguf" });
      const handler = getHandler("imagegen:isAvailable");
      await expect(handler({})).resolves.toBe(true);
    });

    it("returns false when bridge is unavailable", async () => {
      bridgeStub = null;
      const handler = getHandler("imagegen:isAvailable");
      await expect(handler({})).resolves.toBe(false);
    });

    it("returns false when isCapabilityAvailable returns false (CPU-only host)", async () => {
      isCapabilityAvailableMock.mockReturnValue(false);
      getInstalledModelMock.mockResolvedValue({ path: "/m/flux.gguf" });
      const handler = getHandler("imagegen:isAvailable");
      await expect(handler({})).resolves.toBe(false);
    });

    it("returns false when no model record is installed", async () => {
      getInstalledModelMock.mockResolvedValue(null);
      const handler = getHandler("imagegen:isAvailable");
      await expect(handler({})).resolves.toBe(false);
    });
  });

  describe("probeImagegenAvailable", () => {
    it("matches isCapabilityAvailable result exactly", async () => {
      // GPU + model present.
      getInstalledModelMock.mockResolvedValue({ path: "/m/flux.gguf" });
      await expect(probeImagegenAvailable()).resolves.toBe(true);
      // Flip gating.
      isCapabilityAvailableMock.mockReturnValue(false);
      await expect(probeImagegenAvailable()).resolves.toBe(false);
    });
  });

  describe("ensureDiffusionSidecarRunning", () => {
    it("starts the sidecar with the imagegen-slot model on the first call", async () => {
      getInstalledModelMock.mockResolvedValue({ path: "/m/flux.gguf" });
      await ensureDiffusionSidecarRunning();
      expect(setModelPathMock).toHaveBeenCalledWith("/m/flux.gguf");
      expect(sidecarStartMock).toHaveBeenCalledWith(true);
    });

    it("is a no-op when sidecar is already running", async () => {
      sidecarIsRunning = true;
      await ensureDiffusionSidecarRunning();
      expect(setModelPathMock).not.toHaveBeenCalled();
      expect(sidecarStartMock).not.toHaveBeenCalled();
    });

    it("rejects on CPU-only / low-tier hosts even with a model installed", async () => {
      isCapabilityAvailableMock.mockReturnValue(false);
      detectPlatformInfoMock.mockReturnValue({
        platform: "linux-x64",
        platformLabel: "Linux x64",
        totalRamGb: 4,
        tier: "low",
        tierLabel: "Low",
        computeBackends: ["cpu"],
        preferredFormat: "gguf",
      });
      detectComputeBackendsMock.mockReturnValue(["cpu"]);
      getInstalledModelMock.mockResolvedValue({ path: "/m/flux.gguf" });
      await expect(ensureDiffusionSidecarRunning()).rejects.toThrow(
        /GPU/,
      );
    });

    it("rejects with structured error when no model is installed", async () => {
      getInstalledModelMock.mockResolvedValue(null);
      await expect(ensureDiffusionSidecarRunning()).rejects.toThrow(
        /No image-generation model installed/,
      );
    });

    it("rejects when the diffusion sidecar slot is null", async () => {
      diffusionSidecarStub = null;
      await expect(ensureDiffusionSidecarRunning()).rejects.toThrow(
        /not initialised/,
      );
    });
  });

  describe("imagegen:generate", () => {
    function validInput(): Record<string, unknown> {
      return {
        prompt: "A cosy reading nook",
        width: 1024,
        height: 1024,
        artifactId: "art-001",
      };
    }

    function pngBytesStub(): Buffer {
      // 8-byte PNG signature is enough for the persistence
      // assertion — the handler doesn't validate the body.
      return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }

    it("writes PNG bytes and returns structured metadata", async () => {
      getInstalledModelMock.mockResolvedValue({ path: "/m/flux.gguf" });
      bridgeGenerateImageMock.mockResolvedValue({
        pngBytes: pngBytesStub(),
        seed: BigInt(12345),
      });
      const handler = getHandler("imagegen:generate");
      const out = (await handler({}, validInput())) as {
        path: string;
        seed: number;
        width: number;
        height: number;
        sizeBytes: number;
      };
      expect(out.seed).toBe(12345);
      expect(out.width).toBe(1024);
      expect(out.height).toBe(1024);
      expect(out.sizeBytes).toBe(8);
      // File must be under userData/generated-images/<artifactId>/.
      const artifactDir = path.join(
        userDataDirValue,
        "generated-images",
        "art-001",
      );
      expect(out.path.startsWith(artifactDir + path.sep)).toBe(true);
      expect(out.path.endsWith(".png")).toBe(true);
      const written = await fsp.readFile(out.path);
      expect(written).toEqual(pngBytesStub());
    });

    it("forwards optional sampling overrides to the bridge", async () => {
      getInstalledModelMock.mockResolvedValue({ path: "/m/flux.gguf" });
      bridgeGenerateImageMock.mockResolvedValue({
        pngBytes: pngBytesStub(),
        seed: BigInt(7),
      });
      const handler = getHandler("imagegen:generate");
      await handler(
        {},
        {
          ...validInput(),
          steps: 30,
          cfgScale: 4.5,
          seed: 999,
          negativePrompt: "blurry",
        },
      );
      expect(bridgeGenerateImageMock).toHaveBeenCalledWith(
        "http://127.0.0.1:8386",
        {
          prompt: "A cosy reading nook",
          width: 1024,
          height: 1024,
          steps: 30,
          cfgScale: 4.5,
          seed: 999,
          negativePrompt: "blurry",
        },
      );
    });

    it("rejects dimensions that aren't multiples of 64", async () => {
      const handler = getHandler("imagegen:generate");
      await expect(
        handler({}, { ...validInput(), width: 1000 }),
      ).rejects.toThrow(/multiple of 64/);
    });

    it("rejects dimensions outside the 256-2048 range", async () => {
      const handler = getHandler("imagegen:generate");
      await expect(
        handler({}, { ...validInput(), width: 128 }),
      ).rejects.toThrow();
      await expect(
        handler({}, { ...validInput(), height: 4096 }),
      ).rejects.toThrow();
    });

    it("rejects cfgScale outside the 0-15 range", async () => {
      const handler = getHandler("imagegen:generate");
      await expect(
        handler({}, { ...validInput(), cfgScale: -1 }),
      ).rejects.toThrow();
      await expect(
        handler({}, { ...validInput(), cfgScale: 20 }),
      ).rejects.toThrow();
    });

    it("rejects extra fields (strict-mode schema)", async () => {
      const handler = getHandler("imagegen:generate");
      await expect(
        handler({}, { ...validInput(), style: "anime" }),
      ).rejects.toThrow();
    });

    it("enforces the single in-flight invariant", async () => {
      getInstalledModelMock.mockResolvedValue({ path: "/m/flux.gguf" });
      // Pre-construct a deferred so `releaseFirst` is defined the
      // moment we want to release the hang — assigning it inside
      // `mockImplementationOnce`'s executor would race the first
      // handler call's `await` chain and leave `releaseFirst`
      // undefined when the test tries to call it.
      let releaseFirst!: (v: {
        pngBytes: Buffer;
        seed: bigint;
      }) => void;
      const firstBridgePromise = new Promise<{
        pngBytes: Buffer;
        seed: bigint;
      }>((resolve) => {
        releaseFirst = resolve;
      });
      bridgeGenerateImageMock.mockImplementationOnce(() => firstBridgePromise);
      const handler = getHandler("imagegen:generate");
      const first = handler({}, validInput());
      // Wait until the bridge has actually been invoked so we know
      // `generationInFlight` is set and the first call is parked
      // at the bridge `await`. Without this the second call could
      // race ahead while the first is still inside
      // `ensureDiffusionSidecarRunning`.
      while (bridgeGenerateImageMock.mock.calls.length === 0) {
        await new Promise((r) => setImmediate(r));
      }
      // The second call must reject without waiting on the first.
      await expect(handler({}, validInput())).rejects.toThrow(
        /already in flight/,
      );
      releaseFirst({ pngBytes: pngBytesStub(), seed: BigInt(1) });
      await first;
    });

    it("clamps an out-of-range seed instead of overflowing", async () => {
      getInstalledModelMock.mockResolvedValue({ path: "/m/flux.gguf" });
      // sd-server in theory can return a u64 above 2^53; the
      // handler should fall back to 0 rather than silently round-
      // trip through Number.
      const huge = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(10);
      bridgeGenerateImageMock.mockResolvedValue({
        pngBytes: pngBytesStub(),
        seed: huge,
      });
      const handler = getHandler("imagegen:generate");
      const out = (await handler({}, validInput())) as { seed: number };
      expect(out.seed).toBe(0);
    });

    it("trips the rate limiter on the second call within the 5 s window", async () => {
      getInstalledModelMock.mockResolvedValue({ path: "/m/flux.gguf" });
      bridgeGenerateImageMock.mockResolvedValue({
        pngBytes: pngBytesStub(),
        seed: BigInt(1),
      });
      const handler = getHandler("imagegen:generate");
      await handler({}, validInput());
      // Single-token bucket with no burst override: second call
      // must reject with a rate-limit error.
      await expect(handler({}, validInput())).rejects.toThrow(/Rate limit/);
    });
  });

  describe("imagegen:cancel", () => {
    it("returns scheduled=false when no generation is in flight", async () => {
      const handler = getHandler("imagegen:cancel");
      await expect(handler({})).resolves.toEqual({ scheduled: false });
    });

    it("returns scheduled=true and aborts the in-flight controller", async () => {
      getInstalledModelMock.mockResolvedValue({ path: "/m/flux.gguf" });
      let releaseFirst!: (v: {
        pngBytes: Buffer;
        seed: bigint;
      }) => void;
      const firstBridgePromise = new Promise<{
        pngBytes: Buffer;
        seed: bigint;
      }>((resolve) => {
        releaseFirst = resolve;
      });
      bridgeGenerateImageMock.mockImplementationOnce(() => firstBridgePromise);
      const generateHandler = getHandler("imagegen:generate");
      const cancelHandler = getHandler("imagegen:cancel");
      const inflight = generateHandler({}, {
        prompt: "x",
        width: 1024,
        height: 1024,
        artifactId: "a",
      });
      // Wait until the bridge is actually parked so the cancel
      // call observes the in-flight controller — see the
      // "single in-flight" test for the same rationale.
      while (bridgeGenerateImageMock.mock.calls.length === 0) {
        await new Promise((r) => setImmediate(r));
      }
      const cancelResult = await cancelHandler({});
      expect(cancelResult).toEqual({ scheduled: true });
      releaseFirst({
        pngBytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        seed: BigInt(1),
      });
      // Cancellation surfaces as a rejection from the generate
      // call — the bridge returned bytes but the controller
      // signalled abort before we persisted.
      await expect(inflight).rejects.toThrow(/cancelled/);
    });
  });
});
