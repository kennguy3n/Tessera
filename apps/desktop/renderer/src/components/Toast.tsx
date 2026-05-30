import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ToastContext } from "./toastContext";
import type { Toast as ToastShape, ToastType } from "./toastContext";

let toastCounter = 0;

/**
 * Phase 15 Task 21 — toast notification polish.
 *
 * Behaviour matrix expected by the task spec:
 *   * `success` / `info` auto-dismiss after 5s.
 *   * `error` PERSISTS until the user dismisses it. Errors are too
 *     important to silently disappear — surfacing one only to lose it
 *     three seconds later is worse than not surfacing it at all.
 *   * Max 3 toasts visible at once. New toasts arriving while 3 are
 *     already on screen QUEUE behind the current set; whenever a
 *     visible toast is dismissed (manual or auto), the next queued
 *     entry takes its slot. This guarantees the user never sees a
 *     wall of notifications stacking past the viewport.
 *   * Keyboard-accessible: hovering a toast PAUSES its auto-dismiss
 *     timer (the user is reading it), focusing it transfers DOM focus
 *     into the toast region (so the dismiss button is one Tab away),
 *     and `Escape` while a toast is focused dismisses that toast.
 */
const AUTO_DISMISS_MS: Record<ToastType, number | null> = {
  info: 5000,
  success: 5000,
  // `null` means "no auto-dismiss" — error toasts persist until the
  // user explicitly clicks × or presses Escape on the focused toast.
  error: null,
};

/**
 * Maximum number of toasts rendered to the DOM at any time. Additional
 * toasts queue (FIFO) and surface as visible slots open up. Keeps the
 * stack predictable for keyboard navigation (Tab cycles through at
 * most 3 toasts) and prevents the container from growing past the
 * viewport on rapid error bursts (e.g. flaky sync).
 */
const MAX_VISIBLE_TOASTS = 3;

/**
 * Single state atom holding BOTH the visible (DOM-rendered, capped at
 * `MAX_VISIBLE_TOASTS`) toasts AND the FIFO overflow queue. Collapsing
 * the two arrays into one object lets every state transition
 * (add/dismiss/promote) happen in a single functional `setQueueState`
 * call whose updater can read `s.visible.length` and `s.queued` from a
 * consistent snapshot — eliminating the prior pattern of calling
 * `setQueued` from inside `setVisible`'s updater, which is undocumented
 * in React and could break in future versions even though it works
 * correctly under React 18's automatic batching.
 *
 * The two arrays remain conceptually distinct (queued items don't own
 * timers, only visible ones do); the single-atom representation is
 * purely about making the updates atomic.
 */
type ToastQueueState = {
  readonly visible: ReadonlyArray<ToastShape>;
  readonly queued: ReadonlyArray<ToastShape>;
};
const EMPTY_QUEUE_STATE: ToastQueueState = { visible: [], queued: [] };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [queueState, setQueueState] =
    useState<ToastQueueState>(EMPTY_QUEUE_STATE);
  const { visible, queued } = queueState;
  // Track timers per visible toast so manual dismiss cancels the
  // pending auto-dismiss and unmounting doesn't leak a setTimeout.
  // Errors don't have a timer (they persist), so the map may be
  // sparse w.r.t. `visible`.
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const clearTimer = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const startTimer = useCallback(
    (toast: ToastShape) => {
      const ms = AUTO_DISMISS_MS[toast.type];
      if (ms === null) return;
      // Replace any existing timer (e.g. mouseleave restart) so we
      // never accumulate parallel timers for the same toast.
      clearTimer(toast.id);
      const timer = setTimeout(() => {
        // Defer to dismissToast below by toggling the visible state
        // inline — we can't reference `dismissToast` here because of
        // declaration order. The inline removal mirrors what the
        // public callback does for the visible array.
        timersRef.current.delete(toast.id);
        setQueueState((s) => ({
          ...s,
          visible: s.visible.filter((t) => t.id !== toast.id),
        }));
      }, ms);
      timersRef.current.set(toast.id, timer);
    },
    [clearTimer],
  );

  const dismissToast = useCallback(
    (id: number) => {
      clearTimer(id);
      // Single atomic update — drop the toast from BOTH arrays in
      // case it briefly straddled the visible/queued boundary on a
      // double-dismiss. One functional updater means React sees one
      // consistent transition.
      setQueueState((s) => ({
        visible: s.visible.filter((t) => t.id !== id),
        queued: s.queued.filter((t) => t.id !== id),
      }));
    },
    [clearTimer],
  );

  const addToast = useCallback((message: string, type: ToastType = "info") => {
    toastCounter += 1;
    const id = toastCounter;
    const toast: ToastShape = { id, message, type };
    // Decide visible-vs-queued from the SAME snapshot we are
    // returning, in ONE functional updater. No nested setters.
    setQueueState((s) => {
      if (s.visible.length < MAX_VISIBLE_TOASTS) {
        return { ...s, visible: [...s.visible, toast] };
      }
      return { ...s, queued: [...s.queued, toast] };
    });
  }, []);

  // Whenever `visible` shrinks below the cap AND `queued` has
  // pending entries, promote the head of the queue into `visible`.
  // This effect is the single place the queue drains, so the
  // FIFO order is deterministic and we never race against
  // multiple dismisses landing in the same frame.
  useEffect(() => {
    if (visible.length < MAX_VISIBLE_TOASTS && queued.length > 0) {
      // Single atomic update — `s.queued` is the freshest snapshot in
      // case another add/dismiss interleaved before this effect ran.
      setQueueState((s) => {
        if (
          s.visible.length >= MAX_VISIBLE_TOASTS ||
          s.queued.length === 0
        ) {
          return s;
        }
        const promoteCount = Math.min(
          MAX_VISIBLE_TOASTS - s.visible.length,
          s.queued.length,
        );
        return {
          visible: [...s.visible, ...s.queued.slice(0, promoteCount)],
          queued: s.queued.slice(promoteCount),
        };
      });
    }
  }, [visible.length, queued]);

  // Start (or restart) auto-dismiss timers when a toast becomes
  // visible. Tracked in a ref so we know which toasts already have
  // a timer attached and don't double-schedule one.
  const knownIdsRef = useRef(new Set<number>());
  useEffect(() => {
    const seen = new Set<number>();
    for (const toast of visible) {
      seen.add(toast.id);
      if (!knownIdsRef.current.has(toast.id)) {
        startTimer(toast);
      }
    }
    knownIdsRef.current = seen;
    // Cleanup: cancel timers for any toast that has disappeared
    // from the visible set. The dismiss path already clears its
    // own timer, but this catches the case where a queued toast
    // was filtered out before it ever became visible.
    for (const [id] of timersRef.current) {
      if (!seen.has(id)) {
        clearTimer(id);
      }
    }
  }, [visible, startTimer, clearTimer]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  // Pause auto-dismiss while the user hovers / focuses a toast so
  // an error-adjacent info message they're trying to read doesn't
  // vanish under their cursor. On mouseleave / blur we restart the
  // timer from the full duration — slightly generous, but matches
  // the user-expected "reset on interaction" semantics of every
  // major toast library (Sonner, react-hot-toast, Material UI).
  const handlePause = useCallback(
    (id: number) => () => {
      clearTimer(id);
    },
    [clearTimer],
  );

  const handleResume = useCallback(
    (id: number) => () => {
      const toast = visible.find((t) => t.id === id);
      if (toast) startTimer(toast);
    },
    [visible, startTimer],
  );

  // Escape on a focused toast dismisses that specific toast (not the
  // whole stack — a user pressing Escape in a confirmation modal
  // would also dismiss any open toasts otherwise).
  const handleKeyDown = useCallback(
    (id: number) =>
      (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          dismissToast(id);
        }
      },
    [dismissToast],
  );

  const handleDismissClick = useCallback(
    (id: number) =>
      (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        dismissToast(id);
      },
    [dismissToast],
  );

  // Stabilise the context value so consumers that include the
  // returned object in a `useEffect` dependency array do not re-run
  // their effect every time a toast is added or dismissed. Both
  // callbacks are already `useCallback`-stable on internal-only
  // deps, so the memo collapses to a single reference for the
  // provider's lifetime.
  const ctxValue = useMemo(
    () => ({ addToast, dismissToast }),
    [addToast, dismissToast],
  );

  return (
    <ToastContext.Provider value={ctxValue}>
      {children}
      <div
        className="toast-container"
        role="region"
        aria-label="Notifications"
        aria-live="polite"
      >
        {visible.map((toast) => (
          <div
            key={toast.id}
            className={`toast toast-${toast.type}`}
            role={toast.type === "error" ? "alert" : "status"}
            tabIndex={0}
            onMouseEnter={handlePause(toast.id)}
            onMouseLeave={handleResume(toast.id)}
            onFocus={handlePause(toast.id)}
            onBlur={handleResume(toast.id)}
            onKeyDown={handleKeyDown(toast.id)}
          >
            <span className="toast-message">{toast.message}</span>
            <button
              type="button"
              className="toast-dismiss"
              aria-label="Dismiss notification"
              onClick={handleDismissClick(toast.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
