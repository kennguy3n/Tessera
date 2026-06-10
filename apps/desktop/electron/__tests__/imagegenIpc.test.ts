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
const sidecarStopMock = vi.fn().mockResolvedValue(undefined);
const sidecarWaitForReadyMock = vi.fn().mockResolvedValue(true);
const markGenerationActiveMock = vi.fn();
const markGenerationIdleMock = vi.fn();
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
  stop: () => sidecarStopMock(),
  waitForReady: (timeoutMs?: number) => sidecarWaitForReadyMock(timeoutMs),
  markGenerationActive: () => markGenerationActiveMock(),
  markGenerationIdle: () => markGenerationIdleMock(),
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

// the IPC handler now
// distinguishes loading / loaded / failed / unloaded lifecycle
// states. Tests can override `diffusionSidecarStateStub` to assert
// the per-state error message is surfaced.
let diffusionSidecarStateStub: {
  state: "unloaded" | "loading" | "loaded" | "failed";
  error: Error | null;
} = { state: "unloaded", error: null };
vi.mock("../appState", () => ({
  getBridge: () => bridgeStub,
  isBridgeAvailable: () => bridgeStub !== null,
  getDiffusionSidecar: () => diffusionSidecarStub,
  // LW-1: `ensureDiffusionSidecarRunning` now demand-loads via the
  // async accessor. It resolves to the same (possibly null) slot the
  // synchronous peek returns, so the state-driven message branches
  // (loading / failed / unloaded) below remain exercised by setting
  // `diffusionSidecarStub = null` + `diffusionSidecarStateStub`.
  ensureDiffusionSidecar: () => Promise.resolve(diffusionSidecarStub),
  getDiffusionSidecarState: () => diffusionSidecarStateStub,
  // LW-2: ensureDiffusionSidecarRunning calls enforceSidecarExclusivity
  // before start. No-op stub — single-sidecar exclusion has its own
  // dedicated test in resourceMode.test.ts.
  enforceSidecarExclusivity: vi.fn().mockResolvedValue(undefined),
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

  it("falls back to a deterministic id for pure-dot inputs that would traverse via path.join", () => {
    // Dots are in the allowed character class for the sanitiser, so
    // the regex stripping passes them through. Without the pure-dot
    // guard, `path.join(userData, "generated-images", "..")` resolves
    // to `userData` itself, escaping the containment subdirectory.
    expect(sanitiseArtifactId(".")).toBe("unknown-artifact");
    expect(sanitiseArtifactId("..")).toBe("unknown-artifact");
    expect(sanitiseArtifactId("...")).toBe("unknown-artifact");
    expect(sanitiseArtifactId("....")).toBe("unknown-artifact");
  });

  it("preserves inputs that contain dots but are not pure-dot", () => {
    // The pure-dot guard must not over-strip legitimate filenames.
    expect(sanitiseArtifactId("v1.0.2")).toBe("v1.0.2");
    expect(sanitiseArtifactId(".hidden")).toBe(".hidden");
    expect(sanitiseArtifactId("a..b")).toBe("a..b");
  });
});

describe("imagegen IPC handlers", () => {
  beforeEach(() => {
    handleMock.mockClear();
    removeHandlerMock.mockClear();
    setModelPathMock.mockClear();
    sidecarStartMock.mockClear();
    sidecarStopMock.mockClear();
    sidecarStopMock.mockResolvedValue(undefined);
    sidecarWaitForReadyMock.mockClear();
    sidecarWaitForReadyMock.mockResolvedValue(true);
    markGenerationActiveMock.mockClear();
    markGenerationIdleMock.mockClear();
    bridgeGenerateImageMock.mockReset();
    getInstalledModelMock.mockReset();
    detectPlatformInfoMock.mockReset();
    detectComputeBackendsMock.mockReset();
    isCapabilityAvailableMock.mockReset();
    sidecarIsRunning = false;
    diffusionSidecarStub = sidecarStub;
    bridgeStub = { bridgeGenerateImage: bridgeGenerateImageMock };

    // Realpath the tmpdir prefix before mkdtemp — on macOS
    // `os.tmpdir()` returns `/var/folders/...` which is a symlink to
    // `/private/var/folders/...`. `path.resolve` does not follow
    // symlinks but `fs.realpathSync.native` does. Production code in
    // both `pathToAssetUrl` (assetProtocol.ts) and the imagegen
    // handler's `generatedRoot` derives from the same `userDataDir()`
    // call today, so the `startsWith(allowedRoot + path.sep)` check
    // is symlink-stable by construction — but matching the
    // `assetProtocol.test.ts:135` discipline (which DOES realpath
    // explicitly) future-proofs this test against a refactor that
    // makes the two derivations source from different APIs (e.g. one
    // through `app.getPath('userData')` and one through a hand-rolled
    // `path.join(os.homedir(), ...)` that doesn't go through
    // Electron's symlink-resolved cache). Devin Review pass-N 📝
    // finding flagged the inconsistency.
    const tmpBase = fs.realpathSync.native(os.tmpdir());
    userDataDirValue = fs.mkdtempSync(
      path.join(tmpBase, "tessera-imagegen-test-"),
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

    it("rejects when waitForReady times out so the next imagegen:generate doesn't race the listener bind with ECONNREFUSED", async () => {
      // Regression test for:
      // sd-server's ~15-30 s cold-start can outlast the readiness
      // budget on slow disks / GPU-starved hosts. start() returns
      // immediately after spawn(), so without the explicit
      // waitForReady gate `bridgeGenerateImage` would race the
      // HTTP bind and reject with ECONNREFUSED. The handler must
      // surface a clear "failed to become ready" error so the UI
      // can show a useful message instead of a generic network
      // failure.
      getInstalledModelMock.mockResolvedValue({ path: "/m/flux.gguf" });
      sidecarWaitForReadyMock.mockResolvedValueOnce(false);
      await expect(ensureDiffusionSidecarRunning()).rejects.toThrow(
        /failed to become ready/i,
      );
      expect(sidecarStartMock).toHaveBeenCalledWith(true);
    });

    it("stops the half-started sidecar when waitForReady times out so the next ensure call re-spawns from a clean state", async () => {
      // Regression test for Devin Review follow-up (ANALYSIS_pr-review-job-095e635be43f4af68e37c59e0af14838_0001):
      // start() flips `_isRunning=true` the moment spawn() returns,
      // but if the HTTP listener never binds, leaving the flag set
      // would cause the early-return at the top of
      // ensureDiffusionSidecarRunning to silently no-op the next
      // attempt — hiding the readiness failure from the user and
      // letting the subsequent imagegen:generate race ECONNREFUSED
      // against the dead sd-server we already gave up on. The
      // ensure helper must call stop() to reset the flag before
      // throwing the "failed to become ready" error.
      getInstalledModelMock.mockResolvedValue({ path: "/m/flux.gguf" });
      sidecarWaitForReadyMock.mockResolvedValueOnce(false);
      await expect(ensureDiffusionSidecarRunning()).rejects.toThrow(
        /failed to become ready/i,
      );
      expect(sidecarStopMock).toHaveBeenCalledTimes(1);
    });

    it("swallows a stop() failure during the not-ready cleanup so the user-visible error is the readiness timeout, not the stop error", async () => {
      // If sd-server already crashed before waitForReady noticed,
      // stop() may reject (signalling a dead PID, IPC race, etc.).
      // The ensure helper must surface the readiness timeout —
      // which is the actionable diagnostic for the user — not the
      // incidental stop failure.
      getInstalledModelMock.mockResolvedValue({ path: "/m/flux.gguf" });
      sidecarWaitForReadyMock.mockResolvedValueOnce(false);
      sidecarStopMock.mockRejectedValueOnce(new Error("already dead"));
      await expect(ensureDiffusionSidecarRunning()).rejects.toThrow(
        /failed to become ready/i,
      );
      expect(sidecarStopMock).toHaveBeenCalledTimes(1);
    });

    it("rejects with structured error when no model is installed", async () => {
      getInstalledModelMock.mockResolvedValue(null);
      await expect(ensureDiffusionSidecarRunning()).rejects.toThrow(
        /No image-generation model installed/,
      );
    });

    it("rejects with a loading-state message when the diffusion module import is still in flight", async () => {
      diffusionSidecarStub = null;
      diffusionSidecarStateStub = { state: "loading", error: null };
      await expect(ensureDiffusionSidecarRunning()).rejects.toThrow(
        /still warming up/,
      );
    });

    it("rejects with a failed-state message instructing the user to restart when the module import threw", async () => {
      diffusionSidecarStub = null;
      diffusionSidecarStateStub = {
        state: "failed",
        error: new Error("ENOENT: sd-server binary missing"),
      };
      await expect(ensureDiffusionSidecarRunning()).rejects.toThrow(
        /unavailable until the app is restarted.*sd-server binary missing/,
      );
    });

    it("rejects with the bridge-missing message when the slot was never loaded (unloaded state)", async () => {
      diffusionSidecarStub = null;
      diffusionSidecarStateStub = { state: "unloaded", error: null };
      await expect(ensureDiffusionSidecarRunning()).rejects.toThrow(
        /native bridge has not been initialised/,
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
        assetUrl: string;
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
      // The handler MUST also return a `tessera-asset://` URL so the
      // renderer can drop it into `<img src>` without computing the
      // mapping itself. Pin the shape directly: must start with the
      // `generated-images` host and end with the same filename the
      // on-disk path uses. Pass-1 advisory note: this assertion was
      // missing and Devin Review flagged it as a gap.
      expect(out.assetUrl.startsWith("tessera-asset://generated-images/")).toBe(
        true,
      );
      expect(out.assetUrl).toContain("art-001/");
      expect(out.assetUrl.endsWith(path.basename(out.path))).toBe(true);
    });

    it("brackets the bridge call with markGenerationActive / markGenerationIdle so the idle monitor cannot kill mid-generation", async () => {
      // Regression for the BUG_pr-review-job-..._0001 finding: the
      // diffusion sidecar's idle monitor checks
      // `_generationActiveCount === 0` before unloading, so a
      // 10–30 s generation that doesn't increment the counter
      // races the 30 s idle window and dies mid-sample.
      getInstalledModelMock.mockResolvedValue({ path: "/m/flux.gguf" });
      bridgeGenerateImageMock.mockImplementation(async () => {
        // While the bridge call is parked, markGenerationActive
        // MUST already have fired and markGenerationIdle MUST NOT
        // have fired yet. This is the invariant the idle monitor
        // relies on.
        expect(markGenerationActiveMock).toHaveBeenCalledTimes(1);
        expect(markGenerationIdleMock).toHaveBeenCalledTimes(0);
        return {
          pngBytes: pngBytesStub(),
          seed: BigInt(99),
        };
      });
      const handler = getHandler("imagegen:generate");
      await handler({}, validInput());
      // After the bridge resolves and the finally block runs,
      // both bracket calls must have fired exactly once each so
      // the counter returns to zero for the next request.
      expect(markGenerationActiveMock).toHaveBeenCalledTimes(1);
      expect(markGenerationIdleMock).toHaveBeenCalledTimes(1);
    });

    it("releases markGenerationIdle even when the bridge throws", async () => {
      // Without the finally block, a bridge rejection would leak
      // an `_generationActiveCount` increment, permanently
      // blocking the idle monitor from ever reclaiming VRAM
      // until a successful generation re-paired the count.
      getInstalledModelMock.mockResolvedValue({ path: "/m/flux.gguf" });
      bridgeGenerateImageMock.mockRejectedValue(new Error("sd-server died"));
      const handler = getHandler("imagegen:generate");
      await expect(handler({}, validInput())).rejects.toThrow(/sd-server died/);
      expect(markGenerationActiveMock).toHaveBeenCalledTimes(1);
      expect(markGenerationIdleMock).toHaveBeenCalledTimes(1);
    });

    it("does not call markGenerationIdle when the handler fails before the sidecar is reached", async () => {
      // If `ensureDiffusionSidecarRunning` throws (no model
      // installed, capability gating, etc.), we never
      // incremented the counter — calling Idle anyway would
      // drive the count negative on the next legitimate run.
      getInstalledModelMock.mockResolvedValue(null);
      const handler = getHandler("imagegen:generate");
      await expect(handler({}, validInput())).rejects.toThrow(
        /No image-generation model installed/,
      );
      expect(markGenerationActiveMock).toHaveBeenCalledTimes(0);
      expect(markGenerationIdleMock).toHaveBeenCalledTimes(0);
    });

    it("does not escape generated-images even when artifactId is a pure-dot traversal", async () => {
      // Without the sanitiser fix, artifactId=".." would
      // `path.join(userData, "generated-images", "..")` to the
      // `userData` root, dumping the PNG outside its containment
      // directory. The fix rejects pure-dot inputs at the sanitiser
      // level AND verifies the resolved directory stays under
      // `<userData>/generated-images/` before writing.
      getInstalledModelMock.mockResolvedValue({ path: "/m/flux.gguf" });
      bridgeGenerateImageMock.mockResolvedValue({
        pngBytes: pngBytesStub(),
        seed: BigInt(42),
      });
      const handler = getHandler("imagegen:generate");
      const out = (await handler(
        {},
        { ...validInput(), artifactId: ".." },
      )) as { path: string };
      const fallbackDir = path.join(
        userDataDirValue,
        "generated-images",
        "unknown-artifact",
      );
      expect(out.path.startsWith(fallbackDir + path.sep)).toBe(true);
      // Defence-in-depth: the resolved file MUST live under the
      // generated-images root, never directly in userData.
      const generatedRoot = path.resolve(
        userDataDirValue,
        "generated-images",
      );
      expect(out.path.startsWith(generatedRoot + path.sep)).toBe(true);
      const writtenInRoot = await fsp.readdir(userDataDirValue);
      // No stray PNGs should land at the userData root.
      expect(
        writtenInRoot.some((entry) => entry.endsWith(".png")),
      ).toBe(false);
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

    it("clamps a negative BigInt seed to 0 instead of round-tripping a signed value", async () => {
      // Devin Review PR #38 pass-7 📝 finding: the original
      // clamp `seedBig <= BigInt(Number.MAX_SAFE_INTEGER)` lets
      // negative values through because every negative BigInt
      // satisfies the upper bound. The current Rust bridge
      // constructs the BigInt with `sign_bit: false` from a u64,
      // so a negative seed here would mean the bridge contract
      // changed — but the existing clamp's silent acceptance of
      // negative values would round-trip a negative seed straight
      // into the editor's hero-image JSON, where the renderer's
      // `sanitizeHeroImage` would then reject it on reload and
      // the image would silently vanish after a save-reload
      // cycle. Tighten the clamp to also reject `< 0n`. Pin the
      // behaviour against a regression even though the current
      // bridge contract makes the case unreachable.
      getInstalledModelMock.mockResolvedValue({ path: "/m/flux.gguf" });
      bridgeGenerateImageMock.mockResolvedValue({
        pngBytes: pngBytesStub(),
        seed: BigInt(-1),
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
