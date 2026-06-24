import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useBridgeReady } from "../hooks/useBridgeReady";
import type { BridgeStateView } from "../types/ipc";

/**
 * LW-8 (cold-start budget): renderer-side bridge-readiness hook.
 *
 * The hook must (a) start on the skeleton (`initializing`) when a
 * lifecycle surface exists, (b) advance on the live push event, (c)
 * close the race where the `ready` event fired before the renderer
 * subscribed (via the snapshot read), and (d) fail OPEN to `ready` when
 * no lifecycle surface exists at all so an old preload / partial mock
 * can never wedge the user on the skeleton forever.
 */
type Listener = (s: BridgeStateView) => void;

function installLifecycle(opts: {
  snapshot: BridgeStateView | (() => Promise<BridgeStateView>);
}) {
  const listeners: Listener[] = [];
  const unsubscribe = vi.fn();
  const onBridgeState = vi.fn((cb: Listener) => {
    listeners.push(cb);
    return unsubscribe;
  });
  const getBridgeState = vi.fn(() =>
    typeof opts.snapshot === "function"
      ? opts.snapshot()
      : Promise.resolve(opts.snapshot),
  );
  (window.tessera as unknown as { lifecycle: unknown }).lifecycle = {
    getBridgeState,
    onBridgeState,
  };
  return {
    emit: (s: BridgeStateView) =>
      act(() => {
        listeners.forEach((l) => l(s));
      }),
    onBridgeState,
    getBridgeState,
    unsubscribe,
  };
}

afterEach(() => {
  delete (window.tessera as unknown as { lifecycle?: unknown }).lifecycle;
  vi.clearAllMocks();
});

describe("useBridgeReady", () => {
  it("starts on the skeleton (initializing) while the snapshot is pending", () => {
    // A snapshot that never resolves keeps us in initializing.
    installLifecycle({
      snapshot: () => new Promise<BridgeStateView>(() => {}),
    });
    const { result } = renderHook(() => useBridgeReady());
    expect(result.current.state).toBe("initializing");
    expect(result.current.isReady).toBe(false);
  });

  it("advances to ready on the live push event", async () => {
    const lc = installLifecycle({
      snapshot: () => new Promise<BridgeStateView>(() => {}),
    });
    const { result } = renderHook(() => useBridgeReady());
    expect(result.current.state).toBe("initializing");
    lc.emit({ state: "ready", error: null });
    await waitFor(() => expect(result.current.isReady).toBe(true));
  });

  it("surfaces an error transition with its reason", async () => {
    const lc = installLifecycle({
      snapshot: () => new Promise<BridgeStateView>(() => {}),
    });
    const { result } = renderHook(() => useBridgeReady());
    lc.emit({ state: "error", error: "open_store failed" });
    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.error).toBe("open_store failed");
    expect(result.current.isReady).toBe(false);
  });

  it("closes the race: a ready snapshot resolves even if no event fires", async () => {
    installLifecycle({ snapshot: { state: "ready", error: null } });
    const { result } = renderHook(() => useBridgeReady());
    await waitFor(() => expect(result.current.isReady).toBe(true));
  });

  it("does not let a stale 'initializing' snapshot clobber a ready event", async () => {
    // Snapshot resolves to initializing AFTER the event already moved
    // us to ready — the live event must win.
    let resolveSnap: (s: BridgeStateView) => void = () => {};
    const lc = installLifecycle({
      snapshot: () =>
        new Promise<BridgeStateView>((r) => {
          resolveSnap = r;
        }),
    });
    const { result } = renderHook(() => useBridgeReady());
    lc.emit({ state: "ready", error: null });
    await waitFor(() => expect(result.current.isReady).toBe(true));
    // Late snapshot says "still initializing" — must be ignored.
    act(() => resolveSnap({ state: "initializing", error: null }));
    await Promise.resolve();
    expect(result.current.isReady).toBe(true);
  });

  it("fails open to ready when no lifecycle surface exists", () => {
    // No lifecycle installed (afterEach deleted it). The hook must not
    // wedge the user on the skeleton.
    expect(
      (window.tessera as unknown as { lifecycle?: unknown }).lifecycle,
    ).toBeUndefined();
    const { result } = renderHook(() => useBridgeReady());
    expect(result.current.state).toBe("ready");
    expect(result.current.isReady).toBe(true);
  });

  it("detaches its listener on unmount", () => {
    const lc = installLifecycle({
      snapshot: () => new Promise<BridgeStateView>(() => {}),
    });
    const { unmount } = renderHook(() => useBridgeReady());
    expect(lc.onBridgeState).toHaveBeenCalledTimes(1);
    unmount();
    expect(lc.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
