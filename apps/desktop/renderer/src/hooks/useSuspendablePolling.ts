import { useEffect, useRef } from "react";

/**
 * Options for {@link useSuspendablePolling}.
 */
export interface SuspendablePollingOptions {
  /**
   * When `false` the hook does nothing (no interval, no subscription).
   * Lets a caller gate polling on a precondition (e.g. a feature being
   * available) without violating the rules-of-hooks by conditionally
   * calling the hook. Defaults to `true`.
   */
  enabled?: boolean;
  /**
   * Run the callback once immediately when polling (re)starts — on mount
   * and on every resume. Use this for the common "fetch now, then every
   * N ms" pattern so the first paint after mount/show isn't blank or
   * stale. Defaults to `false`.
   */
  immediate?: boolean;
}

/**
 * Run `callback` every `intervalMs` while the window is visible,
 * automatically pausing when the main process reports the window has
 * been hidden (minimized, minimized-to-tray, or `app.hide()` on macOS)
 * and resuming when it becomes visible again (LW-4).
 *
 * Why this exists: Electron's default background throttling only *slows*
 * renderer timers, it doesn't stop them — a hidden window still wakes up
 * to fire status polls (model status, runtime/connector status, …) that
 * are pointless while nothing is on screen. Pausing them outright is the
 * renderer half of the "zero background cost when idle" principle and,
 * combined with the main process stopping sidecars, keeps a
 * minimized-to-tray Tessera near its ≤100 MB target.
 *
 * The hook subscribes to `window.tessera.appLifecycle` suspend/resume
 * signals. On suspend it clears the interval; on resume it restarts it
 * (re-running the callback immediately when `immediate` is set, so the
 * UI re-syncs to whatever changed while hidden). Unmount clears the
 * interval and removes both listeners.
 *
 * The latest `callback` is captured in a ref, so passing a fresh inline
 * closure each render does NOT tear down and recreate the interval — the
 * interval lifecycle depends only on `intervalMs`, `enabled`, and
 * `immediate`. This mirrors the well-known `useInterval` pattern.
 *
 * @example
 *   useSuspendablePolling(pollStatus, 5000, { immediate: true });
 */
export function useSuspendablePolling(
  callback: () => void,
  intervalMs: number,
  options?: SuspendablePollingOptions,
): void {
  const { enabled = true, immediate = false } = options ?? {};

  const savedCallback = useRef(callback);
  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;
    const tick = () => savedCallback.current();

    const start = (runNow: boolean) => {
      // Guard against double-start: a redundant resume (or a resume that
      // arrives while we're already running) must not leak a second
      // interval. The main process de-dupes transitions, but defending
      // here keeps the hook correct regardless of upstream behaviour.
      if (intervalId !== null) return;
      if (runNow) tick();
      intervalId = setInterval(tick, intervalMs);
    };
    const stop = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    // Start optimistically: the renderer has no synchronous "is the
    // window hidden right now" flag, and the overwhelmingly common case
    // is mounting while visible. If the window is in fact hidden, the
    // pending suspend signal stops the interval on the next tick of the
    // event loop — at most one extra poll fires.
    start(immediate);

    const lifecycle =
      typeof window !== "undefined" ? window.tessera?.appLifecycle : undefined;
    const offSuspend = lifecycle?.onSuspend(() => stop());
    // Re-running immediately on resume (when `immediate`) refreshes data
    // that may have gone stale while the window was hidden.
    const offResume = lifecycle?.onResume(() => start(immediate));

    return () => {
      stop();
      offSuspend?.();
      offResume?.();
    };
  }, [enabled, intervalMs, immediate]);
}
