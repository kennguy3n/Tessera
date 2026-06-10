import { useEffect, useState } from "react";
import type { BridgeStateView } from "../types/ipc";

/**
 * LW-8 (cold-start budget): observe the native bridge's boot-time
 * readiness so the app shell can paint a "Loading workspace…" skeleton
 * while `initAppState()` runs OFF the cold-start critical path, then
 * hydrate the moment the bridge is up.
 *
 * The hook resolves the current state two ways so it can never miss the
 * transition:
 *
 *   1. It subscribes to the `app:bridgeState` push event (main →
 *      renderer) for the live `initializing → ready`/`error` transition.
 *   2. On mount it ALSO reads the current snapshot via
 *      `lifecycle.getBridgeState()`. The bridge can finish initialising
 *      before the renderer subscribes (the skeleton paints fast; the
 *      store open is the slow part — but on a warm machine it can be the
 *      other way round), in which case the push event already fired with
 *      no listener. The snapshot read closes that race.
 *
 * Fail-safe: if the `lifecycle` API is missing (e.g. an old preload, or
 * a test harness that mocks only part of `window.tessera`), the hook
 * reports `ready` rather than hanging the user on the skeleton forever.
 * A wedged-on-skeleton app is strictly worse than optimistically
 * mounting — the worst case is the app's own IPC calls surface their
 * own "bridge not ready" errors, which the pages already handle.
 */
export interface BridgeReady {
  /** The latest known bridge lifecycle state. */
  readonly state: BridgeStateView["state"];
  /** Failure reason; non-null only when `state === "error"`. */
  readonly error: string | null;
  /** Convenience flag: the app shell may mount its real content. */
  readonly isReady: boolean;
}

const READY: BridgeStateView = { state: "ready", error: null };

export function useBridgeReady(): BridgeReady {
  const [view, setView] = useState<BridgeStateView>(() => {
    // SSR / test guard: no window means nothing to wait on.
    if (typeof window === "undefined" || !window.tessera?.lifecycle) {
      return READY;
    }
    return { state: "initializing", error: null };
  });

  useEffect(() => {
    const lifecycle = window.tessera?.lifecycle;
    if (!lifecycle) {
      // No lifecycle surface to observe — already optimistically ready
      // from the initializer; nothing to subscribe to.
      return;
    }

    let disposed = false;

    // (1) Live transitions. Keep the disposer so we detach on unmount.
    const unsubscribe = lifecycle.onBridgeState((next) => {
      if (!disposed) setView(next);
    });

    // (2) Snapshot read to cover a transition that fired before we
    // subscribed. We only let the snapshot ADVANCE the state out of
    // `initializing`; if a live event already moved us to ready/error
    // first, a stale "still initializing" snapshot must not clobber it.
    void lifecycle
      .getBridgeState()
      .then((snapshot) => {
        if (disposed) return;
        setView((prev) => (prev.state === "initializing" ? snapshot : prev));
      })
      .catch(() => {
        // A failed snapshot read is non-fatal: the push subscription
        // still delivers the transition. Don't surface an error state
        // for a query failure — that would conflate "couldn't ask" with
        // "bridge failed to open".
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  return {
    state: view.state,
    error: view.error,
    isReady: view.state === "ready",
  };
}
