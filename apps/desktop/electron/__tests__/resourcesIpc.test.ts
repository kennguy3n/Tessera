/**
 * Tests for the `resources:getUsage` IPC handler (LW-12).
 *
 * The handler is a pure aggregation point: it reads live state from the
 * model sidecars (LW-1), the resource mode (LW-2), the battery monitor
 * (LW-3) and the indexing RSS watchdog (LW-7), plus the main-process
 * memory footprint, and returns one structured-clone-safe snapshot. We
 * stub every subsystem and assert:
 *
 *   1. The snapshot maps each subsystem's state onto the documented
 *      shape (running sidecars expose their endpoint; a never-started
 *      sidecar reports stopped without being constructed).
 *   2. The read-pool count mirrors `min(parallelism, MAX_READ_POOL_SIZE)`.
 *   3. The watchdog `pressure` is `null` before the first sample and a
 *      full reading once present.
 *   4. The handler never throws back at the renderer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const captured = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      captured.set(channel, listener);
    },
    removeHandler: (channel: string) => {
      captured.delete(channel);
    },
  },
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    availableParallelism: () => 8, // > MAX_READ_POOL_SIZE so the cap bites
  };
});

const getModelSidecar = vi.fn();
const getVisionSidecar = vi.fn();
const getDiffusionSidecarState = vi.fn();
vi.mock("../appState", () => ({
  getModelSidecar: () => getModelSidecar(),
  getVisionSidecar: () => getVisionSidecar(),
  getDiffusionSidecarState: () => getDiffusionSidecarState(),
}));

const getBatteryStatus = vi.fn();
const isBatteryLow = vi.fn();
vi.mock("../batteryMonitor", () => ({
  getBatteryStatus: () => getBatteryStatus(),
  isBatteryLow: () => isBatteryLow(),
}));

const isIndexingDeferredForMemory = vi.fn();
const memoryPressureSnapshot = vi.fn();
vi.mock("../memoryWatchdog", () => ({
  isIndexingDeferredForMemory: () => isIndexingDeferredForMemory(),
  memoryPressureSnapshot: () => memoryPressureSnapshot(),
}));

const loadConfig = vi.fn();
vi.mock("../config", () => ({
  loadConfig: () => loadConfig(),
}));

import { registerResourcesHandlers } from "../ipc/resources";
import type { ResourceUsage } from "../../shared/types";

async function getUsage(): Promise<ResourceUsage> {
  const listener = captured.get("resources:getUsage");
  if (!listener) throw new Error("resources:getUsage not registered");
  return listener({} as unknown) as Promise<ResourceUsage>;
}

beforeEach(() => {
  captured.clear();
  vi.clearAllMocks();
  // Conservative idle defaults; individual tests override.
  getModelSidecar.mockReturnValue(null);
  getVisionSidecar.mockReturnValue(null);
  getDiffusionSidecarState.mockReturnValue({ state: "unloaded" });
  getBatteryStatus.mockReturnValue({
    hasBattery: false,
    isOnBattery: false,
    isCharging: true,
    percent: null,
  });
  isBatteryLow.mockReturnValue(false);
  isIndexingDeferredForMemory.mockReturnValue(false);
  memoryPressureSnapshot.mockReturnValue(null);
  loadConfig.mockReturnValue({ resourceMode: "lightweight" });
  registerResourcesHandlers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resources:getUsage IPC handler", () => {
  it("registers the channel", () => {
    expect(captured.has("resources:getUsage")).toBe(true);
  });

  it("reports a fully-idle lightweight box", async () => {
    const usage = await getUsage();
    expect(usage.resourceMode).toBe("lightweight");
    expect(usage.slm).toEqual({
      text: { running: false, endpoint: null },
      vision: { running: false, endpoint: null },
      imagegen: { state: "unloaded" },
    });
    expect(usage.connections).toEqual({ writers: 1, readers: 2 });
    expect(usage.indexing).toEqual({
      deferredForMemory: false,
      pressure: null,
    });
    expect(usage.battery).toEqual({
      hasBattery: false,
      isOnBattery: false,
      isCharging: true,
      percent: null,
      gating: false,
    });
    // Real process memory — just assert it is a positive number.
    expect(usage.memory.rssBytes).toBeGreaterThan(0);
  });

  it("exposes a running sidecar's endpoint and the diffusion state", async () => {
    getModelSidecar.mockReturnValue({
      isRunning: true,
      endpoint: "http://127.0.0.1:8384",
    });
    getVisionSidecar.mockReturnValue({ isRunning: false, endpoint: "x" });
    getDiffusionSidecarState.mockReturnValue({ state: "loaded" });
    const usage = await getUsage();
    expect(usage.slm.text).toEqual({
      running: true,
      endpoint: "http://127.0.0.1:8384",
    });
    // Not running → endpoint is normalised to null regardless of input.
    expect(usage.slm.vision).toEqual({ running: false, endpoint: null });
    expect(usage.slm.imagegen.state).toBe("loaded");
  });

  it("caps the read-pool count at MAX_READ_POOL_SIZE", async () => {
    // node:os.availableParallelism is mocked to 8; the pool is capped 2
    // (MAX_READ_POOL_SIZE, mirroring the Rust source of truth).
    const usage = await getUsage();
    expect(usage.connections.readers).toBe(2);
  });

  it("passes through a full watchdog pressure sample when present", async () => {
    isIndexingDeferredForMemory.mockReturnValue(true);
    memoryPressureSnapshot.mockReturnValue({
      paused: true,
      rssBytes: 520 * 1024 * 1024,
      highWaterMarkBytes: 500 * 1024 * 1024,
      lowWaterMarkBytes: 400 * 1024 * 1024,
    });
    const usage = await getUsage();
    expect(usage.indexing.deferredForMemory).toBe(true);
    expect(usage.indexing.pressure).toEqual({
      paused: true,
      rssBytes: 520 * 1024 * 1024,
      highWaterMarkBytes: 500 * 1024 * 1024,
      lowWaterMarkBytes: 400 * 1024 * 1024,
    });
  });

  it("surfaces active battery gating", async () => {
    getBatteryStatus.mockReturnValue({
      hasBattery: true,
      isOnBattery: true,
      isCharging: false,
      percent: 12,
    });
    isBatteryLow.mockReturnValue(true);
    const usage = await getUsage();
    expect(usage.battery).toEqual({
      hasBattery: true,
      isOnBattery: true,
      isCharging: false,
      percent: 12,
      gating: true,
    });
  });

  it("reflects the performance resource mode", async () => {
    loadConfig.mockReturnValue({ resourceMode: "performance" });
    const usage = await getUsage();
    expect(usage.resourceMode).toBe("performance");
  });

  // A transparency surface must never destabilise the app it reports
  // on. The module contract promises each sub-read is defended and
  // degrades to a conservative default; these assert that at runtime —
  // a throw in any one subsystem blanks only its own section (to a
  // fail-open default) while every other section still reports, and the
  // poll resolves rather than rejecting.
  describe("never throws back at the renderer (defended sub-reads)", () => {
    beforeEach(() => {
      // Silence the intentional warn() the defend() helper logs.
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    it("degrades resourceMode to lightweight when loadConfig throws, keeping other sections", async () => {
      loadConfig.mockImplementation(() => {
        throw new Error("config read failed");
      });
      getModelSidecar.mockReturnValue({
        isRunning: true,
        endpoint: "http://127.0.0.1:8384",
      });
      const usage = await getUsage();
      expect(usage.resourceMode).toBe("lightweight");
      // The unrelated SLM section is unaffected by the config throw.
      expect(usage.slm.text).toEqual({
        running: true,
        endpoint: "http://127.0.0.1:8384",
      });
    });

    it("isolates a per-sidecar peek failure to that capability only", async () => {
      // A healthy running text model + loaded imagegen must stay visible
      // even when the vision peek throws — the vision slot alone falls
      // back to stopped, the other two report their real state.
      getModelSidecar.mockReturnValue({
        isRunning: true,
        endpoint: "http://127.0.0.1:8384",
      });
      getDiffusionSidecarState.mockReturnValue({ state: "loaded" });
      getVisionSidecar.mockImplementation(() => {
        throw new Error("sidecar registry corrupt");
      });
      const usage = await getUsage();
      expect(usage.slm).toEqual({
        text: { running: true, endpoint: "http://127.0.0.1:8384" },
        vision: { running: false, endpoint: null },
        imagegen: { state: "loaded" },
      });
      // Other sections still report normally.
      expect(usage.resourceMode).toBe("lightweight");
    });

    it("degrades indexing to fail-open (admitted) when the watchdog throws", async () => {
      isIndexingDeferredForMemory.mockImplementation(() => {
        throw new Error("watchdog not running");
      });
      const usage = await getUsage();
      expect(usage.indexing).toEqual({
        deferredForMemory: false,
        pressure: null,
      });
    });

    it("degrades battery to gating-off when the battery read throws", async () => {
      getBatteryStatus.mockImplementation(() => {
        throw new Error("power source probe failed");
      });
      const usage = await getUsage();
      expect(usage.battery).toEqual({
        hasBattery: false,
        isOnBattery: false,
        isCharging: false,
        percent: null,
        gating: false,
      });
    });

    it("resolves a complete snapshot even when every subsystem throws", async () => {
      vi.spyOn(process, "memoryUsage").mockImplementation(() => {
        throw new Error("x");
      });
      loadConfig.mockImplementation(() => {
        throw new Error("x");
      });
      getModelSidecar.mockImplementation(() => {
        throw new Error("x");
      });
      getVisionSidecar.mockImplementation(() => {
        throw new Error("x");
      });
      getDiffusionSidecarState.mockImplementation(() => {
        throw new Error("x");
      });
      isIndexingDeferredForMemory.mockImplementation(() => {
        throw new Error("x");
      });
      memoryPressureSnapshot.mockImplementation(() => {
        throw new Error("x");
      });
      getBatteryStatus.mockImplementation(() => {
        throw new Error("x");
      });
      isBatteryLow.mockImplementation(() => {
        throw new Error("x");
      });
      const usage = await getUsage();
      expect(usage).toEqual({
        resourceMode: "lightweight",
        memory: {
          rssBytes: 0,
          heapUsedBytes: 0,
          heapTotalBytes: 0,
          externalBytes: 0,
        },
        slm: {
          text: { running: false, endpoint: null },
          vision: { running: false, endpoint: null },
          imagegen: { state: "unloaded" },
        },
        // readPoolSize stays live — it has its own internal guard.
        connections: { writers: 1, readers: 2 },
        indexing: { deferredForMemory: false, pressure: null },
        battery: {
          hasBattery: false,
          isOnBattery: false,
          isCharging: false,
          percent: null,
          gating: false,
        },
      });
    });
  });
});
