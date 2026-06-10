import { useEffect, useState } from "react";
import type { ResourceUsage } from "../types/ipc";

/**
 * LW-12: polls `resources:getUsage` every `intervalMs` while `enabled`
 * is true AND the window is visible, returning the most recent snapshot
 * (or `null` until the first response). Drives the Settings →
 * Performance "Resource usage" card.
 *
 * Re-scheduling uses a recursive `setTimeout` rather than `setInterval`
 * so a slow IPC round-trip can never let calls stack up — the next poll
 * is only armed after the previous one settles. (This is why the card
 * can't just use `useSuspendablePolling`, which is `setInterval`-based
 * and would stack `getUsage` calls if the main process ever stalled.)
 *
 * Window-lifecycle suspend/resume is wired in directly so the loop stops
 * while the window is hidden (minimized / minimized-to-tray) and restarts
 * on show — the renderer half of the "zero background cost when idle"
 * principle this dashboard exists to report on. Without it, a minimized
 * app would keep waking every `intervalMs` to refresh a panel nobody is
 * looking at. The `enabled` flag is the caller-level gate (the card
 * mounts/unmounts with the Settings route); suspend/resume is the
 * within-mount gate for visibility.
 *
 * A generation counter guards the async loop: `start()`/`stop()` bump it,
 * and any in-flight `tick` whose generation is stale neither calls
 * `setSnap` nor re-arms the timer. This makes a suspend-then-resume that
 * straddles an in-flight IPC round-trip safe — the old loop dies cleanly
 * and exactly one new loop runs, with no double-polling or post-stop
 * state updates.
 */
export function useResourceUsage(
  enabled = true,
  intervalMs = 2000,
): ResourceUsage | null {
  const [snap, setSnap] = useState<ResourceUsage | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let active = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const tick = async (gen: number) => {
      try {
        const next = await window.tessera.resources.getUsage();
        // Drop the result if we were unmounted or suspended while the
        // round-trip was in flight (stale generation).
        if (cancelled || gen !== generation) return;
        setSnap(next);
      } catch {
        // Swallow and keep polling — the bridge may not be initialised
        // yet (the renderer paints before bridge-init completes, LW-8),
        // and a transparency panel must never surface a hard error.
      }
      // Only the current generation's loop re-arms; a stale tick exits.
      if (!cancelled && gen === generation) {
        timer = setTimeout(() => void tick(gen), intervalMs);
      }
    };

    const start = () => {
      // De-dupe redundant resumes (and the optimistic mount start vs. a
      // resume that races it) so we never run two overlapping loops.
      if (active) return;
      active = true;
      generation += 1;
      clearTimer();
      void tick(generation);
    };
    const stop = () => {
      active = false;
      // Bump the generation so any in-flight tick is invalidated and
      // won't re-arm after it settles.
      generation += 1;
      clearTimer();
    };

    // Start optimistically: the renderer has no synchronous "is the
    // window hidden right now" flag and the common case is mounting while
    // visible. If it is in fact hidden, the pending suspend signal stops
    // the loop on the next event-loop tick (mirrors useSuspendablePolling).
    start();

    const lifecycle =
      typeof window !== "undefined" ? window.tessera?.appLifecycle : undefined;
    const offSuspend = lifecycle?.onSuspend(() => stop());
    const offResume = lifecycle?.onResume(() => start());

    return () => {
      cancelled = true;
      stop();
      offSuspend?.();
      offResume?.();
    };
  }, [enabled, intervalMs]);

  return snap;
}
