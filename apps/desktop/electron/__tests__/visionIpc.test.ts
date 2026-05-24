/**
 * Integration tests for the `vision:*` IPC channels.
 *
 * The Rust bridge is mocked (the `.node` addon is built per platform
 * and isn't available in the vitest sandbox) but the test exercises
 * the real:
 *   1. `VisionDescribeSchema` strict validation (mode enum, max-tokens
 *      bounds, strict-mode rejection of extra fields).
 *   2. Sidecar lifecycle wiring (the handler reads the installed
 *      vision-slot record, populates --mmproj from `mmprojPath`,
 *      appends `--parallel 1` on low-tier hosts, and skips
 *      `start()` when already running).
 *   3. Error surface (no model installed / missing mmproj / bridge
 *      unavailable each surface a distinct message).
 *   4. Rate limiter consumption (the 1 token/s + burst-of-5 budget
 *      defined in `RATE_LIMIT_PROFILES["vision:describe"]`).
 *   5. `buildVisionExtraArgs` standalone shape (argv order, --ctx-size
 *      emitted only when contextLength is positive).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const handleMock = vi.fn();
const removeHandlerMock = vi.fn();
const setModelPathMock = vi.fn();
const setExtraArgsMock = vi.fn();
const sidecarStartMock = vi.fn();
const sidecarStopMock = vi.fn().mockResolvedValue(undefined);
const sidecarWaitForReadyMock = vi.fn().mockResolvedValue(true);
const markGenerationActiveMock = vi.fn();
const markGenerationIdleMock = vi.fn();
const bridgeVisionDescribeMock = vi.fn();
const getInstalledModelMock = vi.fn();
const detectPlatformInfoMock = vi.fn();
// Tracks which paths the mocked `fs/promises.access` should treat as
// existing. The handler stat-checks the mmproj companion (in addition
// to the main weights, which `getInstalledModel` already covers) so
// `vision:isAvailable` can report `false` when the projector vanishes
// between download and probe. Tests opt files in / out by mutating
// this set in beforeEach + per-test setup.
const accessiblePaths = new Set<string>();

let sidecarIsRunning = false;
const sidecarStub = {
  get isRunning() {
    return sidecarIsRunning;
  },
  get endpoint() {
    return "http://127.0.0.1:8385";
  },
  setModelPath: (p: string) => setModelPathMock(p),
  setExtraArgs: (args: string[]) => setExtraArgsMock(args),
  start: (resetRetries?: boolean) => sidecarStartMock(resetRetries),
  stop: () => sidecarStopMock(),
  waitForReady: (timeoutMs?: number) => sidecarWaitForReadyMock(timeoutMs),
  markGenerationActive: () => markGenerationActiveMock(),
  markGenerationIdle: () => markGenerationIdleMock(),
};

let bridgeStub: unknown = {
  bridgeVisionDescribe: bridgeVisionDescribeMock,
};
let visionSidecarStub: typeof sidecarStub | null = sidecarStub;

vi.mock("electron", () => ({
  ipcMain: {
    handle: (...args: unknown[]) => handleMock(...args),
    removeHandler: (...args: unknown[]) => removeHandlerMock(...args),
  },
  app: {
    getPath: (which: string) => {
      if (which === "userData") return "/tmp/vision-ipc-test-userdata";
      throw new Error(`unexpected getPath: ${which}`);
    },
  },
  BrowserWindow: { fromWebContents: () => null },
}));

vi.mock("../appState", () => ({
  getBridge: () => bridgeStub,
  isBridgeAvailable: () => bridgeStub !== null,
  getVisionSidecar: () => visionSidecarStub,
}));

vi.mock("fs/promises", async () => {
  // Real fs/promises is wrapped so the handler can `await fsp.access`
  // against deterministic test paths without touching the host
  // filesystem. Anything in `accessiblePaths` resolves; anything
  // else rejects with an ENOENT-shaped error so the handler's
  // catch-block path executes exactly as it would in production.
  const actual = await vi.importActual<typeof import("fs/promises")>(
    "fs/promises",
  );
  return {
    ...actual,
    access: vi.fn(async (p: string) => {
      if (accessiblePaths.has(p)) return;
      const err = new Error(`ENOENT: no such file or directory, access '${p}'`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    }),
  };
});

vi.mock("../modelManagement", async () => {
  const actual = await vi.importActual<
    typeof import("../modelManagement")
  >("../modelManagement");
  return {
    ...actual,
    getInstalledModel: (...args: unknown[]) => getInstalledModelMock(...args),
    detectPlatformInfo: () => detectPlatformInfoMock(),
  };
});

import {
  buildVisionExtraArgs,
  ensureVisionSidecarRunning,
  registerVisionHandlers,
} from "../ipc/vision";
import { defaultRateLimiter } from "../ipc/rateLimiter";

function getHandler(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as (event: unknown, ...args: unknown[]) => unknown;
}

describe("buildVisionExtraArgs", () => {
  it("includes --mmproj and skips --parallel for medium/high tier", () => {
    const args = buildVisionExtraArgs("/m/proj.gguf", "medium", null);
    expect(args).toEqual(["--mmproj", "/m/proj.gguf"]);
  });

  it("appends --parallel 1 on low tier to halve KV-cache budget", () => {
    const args = buildVisionExtraArgs("/p", "low", null);
    expect(args).toEqual(["--mmproj", "/p", "--parallel", "1"]);
  });

  it("emits --ctx-size only when contextLength is positive", () => {
    expect(buildVisionExtraArgs("/p", "high", 4096)).toEqual([
      "--mmproj",
      "/p",
      "--ctx-size",
      "4096",
    ]);
    // Zero / negative / null all suppress --ctx-size (defer to GGUF default).
    expect(buildVisionExtraArgs("/p", "high", 0)).toEqual(["--mmproj", "/p"]);
    expect(buildVisionExtraArgs("/p", "high", null)).toEqual(["--mmproj", "/p"]);
    expect(buildVisionExtraArgs("/p", "high", undefined)).toEqual([
      "--mmproj",
      "/p",
    ]);
  });
});

describe("vision IPC handlers", () => {
  beforeEach(() => {
    handleMock.mockClear();
    removeHandlerMock.mockClear();
    setModelPathMock.mockClear();
    setExtraArgsMock.mockClear();
    sidecarStartMock.mockClear();
    sidecarStopMock.mockClear();
    sidecarStopMock.mockResolvedValue(undefined);
    sidecarWaitForReadyMock.mockClear();
    sidecarWaitForReadyMock.mockResolvedValue(true);
    markGenerationActiveMock.mockClear();
    markGenerationIdleMock.mockClear();
    bridgeVisionDescribeMock.mockClear();
    getInstalledModelMock.mockReset();
    detectPlatformInfoMock.mockReset();
    sidecarIsRunning = false;
    visionSidecarStub = sidecarStub;
    bridgeStub = { bridgeVisionDescribe: bridgeVisionDescribeMock };
    accessiblePaths.clear();
    // Default fixtures: the mmproj paths used by the
    // "model + mmproj present" tests below are always on disk.
    // Individual tests that exercise the missing-file path
    // delete from this set after beforeEach runs.
    accessiblePaths.add("/m/proj.gguf");
    accessiblePaths.add("/m/smolproj.gguf");
    defaultRateLimiter.reset();
    sidecarStartMock.mockResolvedValue(undefined);
    detectPlatformInfoMock.mockReturnValue({
      platform: "linux-x64",
      platformLabel: "Linux x64",
      totalRamGb: 32,
      tier: "high",
      tierLabel: "High",
      computeBackends: ["cpu", "cuda"],
      preferredFormat: "gguf",
    });
    registerVisionHandlers();
  });

  afterEach(() => {
    defaultRateLimiter.reset();
  });

  describe("vision:isAvailable", () => {
    it("returns true when bridge + model + mmproj are all present", async () => {
      getInstalledModelMock.mockResolvedValue({
        path: "/m/qwen.gguf",
        mmprojPath: "/m/proj.gguf",
      });
      const handler = getHandler("vision:isAvailable");
      await expect(handler({})).resolves.toBe(true);
    });

    it("returns false when no model is installed", async () => {
      getInstalledModelMock.mockResolvedValue(null);
      const handler = getHandler("vision:isAvailable");
      await expect(handler({})).resolves.toBe(false);
    });

    it("returns false when model is installed but mmproj is missing", async () => {
      getInstalledModelMock.mockResolvedValue({
        path: "/m/qwen.gguf",
        mmprojPath: undefined,
      });
      const handler = getHandler("vision:isAvailable");
      await expect(handler({})).resolves.toBe(false);
    });

    it("returns false when native bridge is unavailable", async () => {
      bridgeStub = null;
      getInstalledModelMock.mockResolvedValue({
        path: "/m/qwen.gguf",
        mmprojPath: "/m/proj.gguf",
      });
      const handler = getHandler("vision:isAvailable");
      await expect(handler({})).resolves.toBe(false);
    });

    it("returns false when mmproj path is populated but the file no longer exists on disk", async () => {
      // Regression guard for Devin Review BUG_0001: vision-GGUF
      // installs are two-file (main weights + mmproj projector) but
      // `getInstalledModel` only stat-checks the main weights. If
      // the mmproj is deleted, quarantined by AV, or wiped by a
      // partial disk fault while the main weights remain, the
      // probe must report false so the renderer hides the
      // "Describe image" button rather than letting the click
      // resolve to a confusing llama-server startup failure.
      getInstalledModelMock.mockResolvedValue({
        path: "/m/qwen.gguf",
        mmprojPath: "/m/proj.gguf",
      });
      // Remove the projector from the simulated filesystem AFTER
      // beforeEach has populated it; main weights stay accessible.
      accessiblePaths.delete("/m/proj.gguf");
      const handler = getHandler("vision:isAvailable");
      await expect(handler({})).resolves.toBe(false);
    });
  });

  describe("ensureVisionSidecarRunning", () => {
    it("starts the sidecar with --mmproj on the first call", async () => {
      getInstalledModelMock.mockResolvedValue({
        path: "/m/qwen.gguf",
        mmprojPath: "/m/proj.gguf",
      });
      await ensureVisionSidecarRunning();
      expect(setModelPathMock).toHaveBeenCalledWith("/m/qwen.gguf");
      expect(setExtraArgsMock).toHaveBeenCalledWith([
        "--mmproj",
        "/m/proj.gguf",
      ]);
      expect(sidecarStartMock).toHaveBeenCalledWith(true);
    });

    it("appends --parallel 1 on low-tier hosts", async () => {
      detectPlatformInfoMock.mockReturnValue({
        platform: "linux-x64",
        platformLabel: "Linux x64",
        totalRamGb: 4,
        tier: "low",
        tierLabel: "Low",
        computeBackends: ["cpu"],
        preferredFormat: "gguf",
      });
      getInstalledModelMock.mockResolvedValue({
        path: "/m/smol.gguf",
        mmprojPath: "/m/smolproj.gguf",
      });
      await ensureVisionSidecarRunning();
      expect(setExtraArgsMock).toHaveBeenCalledWith([
        "--mmproj",
        "/m/smolproj.gguf",
        "--parallel",
        "1",
      ]);
    });

    it("is a no-op when sidecar is already running", async () => {
      sidecarIsRunning = true;
      await ensureVisionSidecarRunning();
      expect(setModelPathMock).not.toHaveBeenCalled();
      expect(setExtraArgsMock).not.toHaveBeenCalled();
      expect(sidecarStartMock).not.toHaveBeenCalled();
    });

    it("rejects with structured error when no model is installed", async () => {
      getInstalledModelMock.mockResolvedValue(null);
      await expect(ensureVisionSidecarRunning()).rejects.toThrow(
        /No vision model installed/,
      );
    });

    it("rejects when waitForReady times out so the IPC caller sees an actionable error instead of a silent ECONNREFUSED on the next describe call", async () => {
      // Regression test for Devin Review ANALYSIS_0005: spawn()
      // succeeds but the HTTP listener never binds (slow disk,
      // OOM during model load, sigchld lost). Production code
      // must surface this as a structured error rather than
      // returning a half-started sidecar that the next
      // vision:describe will hit with ECONNREFUSED.
      getInstalledModelMock.mockResolvedValue({
        path: "/m/qwen.gguf",
        mmprojPath: "/m/proj.gguf",
      });
      sidecarWaitForReadyMock.mockResolvedValueOnce(false);
      await expect(ensureVisionSidecarRunning()).rejects.toThrow(
        /failed to become ready/i,
      );
      // start() still got called — the failure is in the readiness
      // probe, not the spawn itself, so the rejection message is
      // about readiness specifically.
      expect(sidecarStartMock).toHaveBeenCalledWith(true);
    });

    it("stops the half-started sidecar when waitForReady times out so the next ensure call re-spawns from a clean state", async () => {
      // Regression test for Devin Review follow-up
      // (ANALYSIS_pr-review-job-095e635be43f4af68e37c59e0af14838_0001).
      // start() flips _isRunning=true the moment spawn() returns;
      // if waitForReady then times out, leaving the flag set
      // would make the next ensureVisionSidecarRunning early-return
      // and silently no-op. The handler must stop the sidecar
      // before throwing so subsequent attempts re-spawn cleanly.
      getInstalledModelMock.mockResolvedValue({
        path: "/m/qwen.gguf",
        mmprojPath: "/m/proj.gguf",
      });
      sidecarWaitForReadyMock.mockResolvedValueOnce(false);
      await expect(ensureVisionSidecarRunning()).rejects.toThrow(
        /failed to become ready/i,
      );
      expect(sidecarStopMock).toHaveBeenCalledTimes(1);
    });

    it("swallows a stop() failure during the not-ready cleanup so the user-visible error remains the readiness timeout", async () => {
      getInstalledModelMock.mockResolvedValue({
        path: "/m/qwen.gguf",
        mmprojPath: "/m/proj.gguf",
      });
      sidecarWaitForReadyMock.mockResolvedValueOnce(false);
      sidecarStopMock.mockRejectedValueOnce(new Error("already dead"));
      await expect(ensureVisionSidecarRunning()).rejects.toThrow(
        /failed to become ready/i,
      );
      expect(sidecarStopMock).toHaveBeenCalledTimes(1);
    });

    it("rejects with structured error when mmproj is missing", async () => {
      getInstalledModelMock.mockResolvedValue({
        path: "/m/qwen.gguf",
        mmprojPath: undefined,
      });
      await expect(ensureVisionSidecarRunning()).rejects.toThrow(
        /missing its multimodal projector/,
      );
    });

    it("rejects with structured error when mmproj path is set but file is gone from disk", async () => {
      // Symmetrical defence-in-depth to the `vision:isAvailable`
      // stat (Devin Review BUG_0001). If the renderer somehow
      // calls `vision:describe` despite the probe returning false
      // (e.g. stale UI state, race with a delete), the handler
      // surfaces a structured message rather than letting
      // llama-server fail with a cryptic mmproj-load error.
      getInstalledModelMock.mockResolvedValue({
        path: "/m/qwen.gguf",
        mmprojPath: "/m/proj.gguf",
      });
      accessiblePaths.delete("/m/proj.gguf");
      await expect(ensureVisionSidecarRunning()).rejects.toThrow(
        /projector file is missing/,
      );
      // Critically, we must NOT have called start() — the sidecar
      // would refuse anyway, but ensuring we short-circuit early
      // saves the multi-second startup grace period.
      expect(sidecarStartMock).not.toHaveBeenCalled();
    });

    it("rejects when the vision sidecar slot is null", async () => {
      visionSidecarStub = null;
      await expect(ensureVisionSidecarRunning()).rejects.toThrow(
        /not initialised/,
      );
    });
  });

  describe("vision:describe", () => {
    it("validates and forwards the call to the bridge", async () => {
      getInstalledModelMock.mockResolvedValue({
        path: "/m/qwen.gguf",
        mmprojPath: "/m/proj.gguf",
      });
      bridgeVisionDescribeMock.mockResolvedValue({
        content: "A cat on a desk.",
        stop: true,
        tokensPredicted: 24,
        tokensEvaluated: 1024,
      });

      const handler = getHandler("vision:describe");
      const out = await handler(
        {},
        {
          imagePath: "/imgs/cat.png",
          mode: "describe",
        },
      );
      expect(out).toEqual({
        content: "A cat on a desk.",
        stop: true,
        tokensPredicted: 24,
        tokensEvaluated: 1024,
      });
      expect(bridgeVisionDescribeMock).toHaveBeenCalledWith(
        "http://127.0.0.1:8385",
        "/imgs/cat.png",
        "describe",
        512, // default for "describe" mode
      );
    });

    it("uses the per-mode default token budget when caller omits maxTokens", async () => {
      getInstalledModelMock.mockResolvedValue({
        path: "/m/qwen.gguf",
        mmprojPath: "/m/proj.gguf",
      });
      bridgeVisionDescribeMock.mockResolvedValue({
        content: "",
        stop: true,
        tokensPredicted: 0,
        tokensEvaluated: 0,
      });
      const handler = getHandler("vision:describe");
      await handler({}, { imagePath: "/i", mode: "ocr" });
      expect(bridgeVisionDescribeMock).toHaveBeenLastCalledWith(
        "http://127.0.0.1:8385",
        "/i",
        "ocr",
        2048,
      );
      await handler({}, { imagePath: "/i", mode: "chart" });
      expect(bridgeVisionDescribeMock).toHaveBeenLastCalledWith(
        "http://127.0.0.1:8385",
        "/i",
        "chart",
        1024,
      );
    });

    it("honours an explicit maxTokens override", async () => {
      getInstalledModelMock.mockResolvedValue({
        path: "/m/qwen.gguf",
        mmprojPath: "/m/proj.gguf",
      });
      bridgeVisionDescribeMock.mockResolvedValue({
        content: "",
        stop: true,
        tokensPredicted: 0,
        tokensEvaluated: 0,
      });
      const handler = getHandler("vision:describe");
      await handler({}, { imagePath: "/i", mode: "describe", maxTokens: 256 });
      expect(bridgeVisionDescribeMock).toHaveBeenLastCalledWith(
        "http://127.0.0.1:8385",
        "/i",
        "describe",
        256,
      );
    });

    it("brackets the bridge call with markGenerationActive / markGenerationIdle", async () => {
      // Companion to the diffusion sidecar regression: the
      // vision sidecar uses `ModelSidecar`'s idle monitor (60 s
      // window) which only refrains from unloading while
      // `_generationActiveCount > 0`. OCR on big images can push
      // past 60 s on slow hosts; without bracketing the sidecar
      // would die mid-completion.
      getInstalledModelMock.mockResolvedValue({
        path: "/m/qwen.gguf",
        mmprojPath: "/m/proj.gguf",
      });
      bridgeVisionDescribeMock.mockImplementation(async () => {
        expect(markGenerationActiveMock).toHaveBeenCalledTimes(1);
        expect(markGenerationIdleMock).toHaveBeenCalledTimes(0);
        return {
          content: "ok",
          stop: true,
          tokensPredicted: 1,
          tokensEvaluated: 1,
        };
      });
      const handler = getHandler("vision:describe");
      await handler({}, { imagePath: "/i", mode: "describe" });
      expect(markGenerationActiveMock).toHaveBeenCalledTimes(1);
      expect(markGenerationIdleMock).toHaveBeenCalledTimes(1);
    });

    it("releases markGenerationIdle even when the bridge throws", async () => {
      getInstalledModelMock.mockResolvedValue({
        path: "/m/qwen.gguf",
        mmprojPath: "/m/proj.gguf",
      });
      bridgeVisionDescribeMock.mockRejectedValue(
        new Error("vision sidecar died"),
      );
      const handler = getHandler("vision:describe");
      await expect(
        handler({}, { imagePath: "/i", mode: "describe" }),
      ).rejects.toThrow(/vision sidecar died/);
      expect(markGenerationActiveMock).toHaveBeenCalledTimes(1);
      expect(markGenerationIdleMock).toHaveBeenCalledTimes(1);
    });

    it("rejects unknown modes with zod's error message", async () => {
      const handler = getHandler("vision:describe");
      await expect(
        handler({}, { imagePath: "/i", mode: "translate" }),
      ).rejects.toThrow(/(Invalid|enum|mode)/);
    });

    it("rejects extra fields (strict-mode schema)", async () => {
      const handler = getHandler("vision:describe");
      await expect(
        handler(
          {},
          { imagePath: "/i", mode: "describe", quality: "high" },
        ),
      ).rejects.toThrow();
    });

    it("rejects maxTokens above 2048", async () => {
      const handler = getHandler("vision:describe");
      await expect(
        handler({}, { imagePath: "/i", mode: "ocr", maxTokens: 5000 }),
      ).rejects.toThrow();
    });

    it("trips the rate limiter after exhausting the burst budget", async () => {
      getInstalledModelMock.mockResolvedValue({
        path: "/m/qwen.gguf",
        mmprojPath: "/m/proj.gguf",
      });
      bridgeVisionDescribeMock.mockResolvedValue({
        content: "",
        stop: true,
        tokensPredicted: 0,
        tokensEvaluated: 0,
      });
      const handler = getHandler("vision:describe");
      // Default burst = tokensPerInterval(1) when burst is unset, but
      // vision:describe explicitly sets burst=5. So calls 1-5 must
      // succeed and call 6 must throw.
      for (let i = 0; i < 5; i++) {
        await handler({}, { imagePath: "/i", mode: "describe" });
      }
      await expect(
        handler({}, { imagePath: "/i", mode: "describe" }),
      ).rejects.toThrow(/Rate limit/);
    });
  });
});
