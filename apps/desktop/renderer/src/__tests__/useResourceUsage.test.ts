import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useResourceUsage } from "../hooks/useResourceUsage";
import type { ResourceUsage } from "../types/ipc";

type Cb = () => void;
let suspendCbs: Cb[] = [];
let resumeCbs: Cb[] = [];
function installLifecycle() {
  suspendCbs = [];
  resumeCbs = [];
  window.tessera.appLifecycle = {
    onSuspend: vi.fn((cb: Cb) => {
      suspendCbs.push(cb);
      return () => {};
    }),
    onResume: vi.fn((cb: Cb) => {
      resumeCbs.push(cb);
      return () => {};
    }),
  };
}
function fireSuspend() {
  suspendCbs.forEach((cb) => cb());
}
function fireResume() {
  resumeCbs.forEach((cb) => cb());
}

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

  it("pauses polling on window suspend and resumes on show", async () => {
    vi.useFakeTimers();
    installLifecycle();
    const getUsage = vi.fn().mockResolvedValue(snapshot(180));
    window.tessera.resources.getUsage = getUsage;
    renderHook(() => useResourceUsage(true, 1000));

    // Mount fires once immediately.
    await act(async () => {
      await Promise.resolve();
    });
    expect(getUsage).toHaveBeenCalledTimes(1);

    // Hidden window: no further polls, however long it stays hidden.
    act(() => fireSuspend());
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(getUsage).toHaveBeenCalledTimes(1);

    // Shown again: polls immediately, then resumes on the interval.
    act(() => fireResume());
    await act(async () => {
      await Promise.resolve();
    });
    expect(getUsage).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(getUsage).toHaveBeenCalledTimes(3);
  });

  it("does not run overlapping loops after suspend/resume straddles an in-flight poll", async () => {
    vi.useFakeTimers();
    installLifecycle();
    // First poll hangs so suspend+resume both land while it is in flight.
    let resolveFirst: (v: ResourceUsage) => void = () => {};
    const getUsage = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ResourceUsage>((res) => {
            resolveFirst = res;
          }),
      )
      .mockResolvedValue(snapshot(160));
    window.tessera.resources.getUsage = getUsage;
    renderHook(() => useResourceUsage(true, 1000));

    // Mount tick is in flight (1 call, unsettled).
    await act(async () => {
      await Promise.resolve();
    });
    expect(getUsage).toHaveBeenCalledTimes(1);

    // Suspend then resume while the first poll is still pending. Resume
    // starts a fresh loop (call #2); the stale in-flight poll must die.
    act(() => fireSuspend());
    act(() => fireResume());
    await act(async () => {
      await Promise.resolve();
    });
    expect(getUsage).toHaveBeenCalledTimes(2);

    // Let the original hung poll settle — it must NOT re-arm a timer.
    await act(async () => {
      resolveFirst(snapshot(999));
      await Promise.resolve();
    });

    // Exactly one loop is live: a single interval advance => one new call.
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(getUsage).toHaveBeenCalledTimes(3);
  });
});
