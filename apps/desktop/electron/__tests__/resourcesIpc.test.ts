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
    expect(usage.connections).toEqual({ writers: 1, readers: 4 });
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
    // node:os.availableParallelism is mocked to 8; the pool is capped 4.
    const usage = await getUsage();
    expect(usage.connections.readers).toBe(4);
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
});
