import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSuspendablePolling } from "../hooks/useSuspendablePolling";

// Drives the LW-4 suspend/resume contract directly: we replace the
// global `appLifecycle` mock (see `setup.ts`) with capturing fakes so a
// test can fire the suspend/resume callbacks the main process would
// normally send over IPC, and assert the interval pauses/resumes.

type Cb = () => void;

let suspendCbs: Cb[];
let resumeCbs: Cb[];
let offSuspend: ReturnType<typeof vi.fn>;
let offResume: ReturnType<typeof vi.fn>;

function fireSuspend() {
  suspendCbs.forEach((cb) => cb());
}
function fireResume() {
  resumeCbs.forEach((cb) => cb());
}

describe("useSuspendablePolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    suspendCbs = [];
    resumeCbs = [];
    offSuspend = vi.fn();
    offResume = vi.fn();
    window.tessera.appLifecycle = {
      onSuspend: vi.fn((cb: Cb) => {
        suspendCbs.push(cb);
        return offSuspend;
      }),
      onResume: vi.fn((cb: Cb) => {
        resumeCbs.push(cb);
        return offResume;
      }),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the callback on the interval while visible", () => {
    const cb = vi.fn();
    renderHook(() => useSuspendablePolling(cb, 1000));

    expect(cb).not.toHaveBeenCalled(); // no immediate
    vi.advanceTimersByTime(3000);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("runs once immediately when `immediate` is set", () => {
    const cb = vi.fn();
    renderHook(() => useSuspendablePolling(cb, 1000, { immediate: true }));

    expect(cb).toHaveBeenCalledTimes(1); // mount tick
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("pauses on suspend and resumes on resume", () => {
    const cb = vi.fn();
    renderHook(() => useSuspendablePolling(cb, 1000));

    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);

    fireSuspend();
    vi.advanceTimersByTime(5000);
    // No further ticks while suspended.
    expect(cb).toHaveBeenCalledTimes(1);

    fireResume();
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("re-runs immediately on resume when `immediate` is set", () => {
    const cb = vi.fn();
    renderHook(() => useSuspendablePolling(cb, 1000, { immediate: true }));

    expect(cb).toHaveBeenCalledTimes(1); // mount immediate
    fireSuspend();
    vi.advanceTimersByTime(3000);
    expect(cb).toHaveBeenCalledTimes(1);

    fireResume();
    expect(cb).toHaveBeenCalledTimes(2); // immediate re-run on resume
  });

  it("does not leak a second interval on a redundant resume", () => {
    const cb = vi.fn();
    renderHook(() => useSuspendablePolling(cb, 1000));

    // Resume while already running must be a no-op (no double interval).
    fireResume();
    fireResume();
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does nothing while `enabled` is false", () => {
    const cb = vi.fn();
    renderHook(() => useSuspendablePolling(cb, 1000, { enabled: false }));

    vi.advanceTimersByTime(5000);
    expect(cb).not.toHaveBeenCalled();
    // No subscription is registered when disabled.
    expect(window.tessera.appLifecycle.onSuspend).not.toHaveBeenCalled();
  });

  it("clears the interval and unsubscribes on unmount", () => {
    const cb = vi.fn();
    const { unmount } = renderHook(() => useSuspendablePolling(cb, 1000));

    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);

    unmount();
    expect(offSuspend).toHaveBeenCalledTimes(1);
    expect(offResume).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(1); // no ticks after unmount
  });

  it("always invokes the latest callback without restarting the interval", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ fn }: { fn: () => void }) => useSuspendablePolling(fn, 1000),
      { initialProps: { fn: first } },
    );

    vi.advanceTimersByTime(1000);
    expect(first).toHaveBeenCalledTimes(1);

    rerender({ fn: second });
    vi.advanceTimersByTime(1000);
    // The interval kept running (not torn down by the new closure) and
    // now calls the latest callback.
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
