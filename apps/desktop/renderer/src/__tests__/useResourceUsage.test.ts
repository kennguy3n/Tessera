import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useResourceUsage } from "../hooks/useResourceUsage";
import type { ResourceUsage } from "../types/ipc";

function snapshot(rssMb: number): ResourceUsage {
  return {
    resourceMode: "lightweight",
    memory: {
      rssBytes: rssMb * 1024 * 1024,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
    },
    slm: {
      text: { running: false, endpoint: null },
      vision: { running: false, endpoint: null },
      imagegen: { state: "unloaded" },
    },
    connections: { writers: 1, readers: 2 },
    indexing: { deferredForMemory: false, pressure: null },
    battery: {
      hasBattery: false,
      isOnBattery: false,
      isCharging: true,
      percent: null,
      gating: false,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  window.tessera.resources.getUsage = vi
    .fn()
    .mockResolvedValue(snapshot(180));
});

describe("useResourceUsage", () => {
  it("returns null until the first snapshot resolves, then the value", async () => {
    window.tessera.resources.getUsage = vi
      .fn()
      .mockResolvedValue(snapshot(200));
    const { result } = renderHook(() => useResourceUsage());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.memory.rssBytes).toBe(200 * 1024 * 1024);
  });

  it("does not poll when disabled", async () => {
    const getUsage = vi.fn().mockResolvedValue(snapshot(180));
    window.tessera.resources.getUsage = getUsage;
    const { result } = renderHook(() => useResourceUsage(false));
    // Give any (incorrectly armed) microtasks a chance to run.
    await Promise.resolve();
    expect(result.current).toBeNull();
    expect(getUsage).not.toHaveBeenCalled();
  });

  it("re-polls on the interval and never stacks calls", async () => {
    vi.useFakeTimers();
    const getUsage = vi.fn().mockResolvedValue(snapshot(180));
    window.tessera.resources.getUsage = getUsage;
    renderHook(() => useResourceUsage(true, 2000));
    // First tick fires immediately on mount.
    await act(async () => {
      await Promise.resolve();
    });
    expect(getUsage).toHaveBeenCalledTimes(1);
    // The next poll is only armed after the previous settled.
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(getUsage).toHaveBeenCalledTimes(2);
  });

  it("keeps polling after a failed snapshot (fail-open)", async () => {
    vi.useFakeTimers();
    const getUsage = vi
      .fn()
      .mockRejectedValueOnce(new Error("bridge not ready"))
      .mockResolvedValue(snapshot(150));
    window.tessera.resources.getUsage = getUsage;
    const { result } = renderHook(() => useResourceUsage(true, 1000));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull(); // first call threw
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current?.memory.rssBytes).toBe(150 * 1024 * 1024);
  });
});
