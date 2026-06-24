import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ToastContext } from "./toastContext";
import type { Toast as ToastShape, ToastType } from "./toastContext";

let toastCounter = 0;

/**
 * toast notification polish.
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

// Reducer state combines `visible` (the rendered slice, capped at
// MAX_VISIBLE_TOASTS) and `queued` (FIFO overflow waiting for a slot
// to open) into a single record. Both `add` and `dismiss` produce
// the next state in a SINGLE pure transition — including promoting
// the head of `queued` into `visible` when a slot opens — so we
// never need to nest one state setter inside another's updater.
//
// Devin Review PR #70: the previous implementation called
// `setQueued` from inside `setVisible`'s updater. Under React 19
// `<StrictMode>` (enabled in `main.tsx`), state updaters are
// double-invoked in development to surface impurities. The nested
// `setQueued((q) => [...q, toast])` ran twice — and the second
// invocation received the already-updated queue, appending the same
// toast a second time. Symptom: in dev mode, a toast queued while
// three were visible appeared TWICE when a slot freed up. A single
// reducer transition is the architecturally correct fix because the
// reducer body is pure-by-construction (no side effects, returns the
// next state) and StrictMode's double-invoke is safe by design.
interface ToastState {
  visible: ToastShape[];
  queued: ToastShape[];
}

type ToastAction =
  | { type: "add"; toast: ToastShape }
  | { type: "dismiss"; id: number };

const INITIAL_TOAST_STATE: ToastState = { visible: [], queued: [] };

function toastReducer(state: ToastState, action: ToastAction): ToastState {
  switch (action.type) {
    case "add": {
      if (state.visible.length < MAX_VISIBLE_TOASTS) {
        return {
          visible: [...state.visible, action.toast],
          queued: state.queued,
        };
      }
      return {
        visible: state.visible,
        queued: [...state.queued, action.toast],
      };
    }
    case "dismiss": {
      // Remove the toast from whichever bucket it lives in. If it was
      // in `visible`, promote the head of `queued` (if any) into the
      // freed slot. Both operations are part of the SAME transition
      // so the FIFO promotion is deterministic and atomic — no
      // separate "watch visible.length, then setQueued" effect can
      // race against a second dismiss landing in the same frame.
      const wasVisible = state.visible.some((t) => t.id === action.id);
      const nextVisible = state.visible.filter((t) => t.id !== action.id);
      // Also strip from queued in the (rare) case where a caller
      // dismisses an id that's only in the queue — keeps the
      // invariant "dismissed id appears in neither bucket" simple.
      let nextQueued = state.queued.filter((t) => t.id !== action.id);
      if (
        wasVisible &&
        nextVisible.length < MAX_VISIBLE_TOASTS &&
        nextQueued.length > 0
      ) {
        const [promoted, ...rest] = nextQueued;
        nextVisible.push(promoted);
        nextQueued = rest;
      }
      return { visible: nextVisible, queued: nextQueued };
    }
  }
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(toastReducer, INITIAL_TOAST_STATE);
  const { visible } = state;
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
        timersRef.current.delete(toast.id);
        dispatch({ type: "dismiss", id: toast.id });
      }, ms);
      timersRef.current.set(toast.id, timer);
    },
    [clearTimer],
  );

  const dismissToast = useCallback(
    (id: number) => {
      clearTimer(id);
      dispatch({ type: "dismiss", id });
    },
    [clearTimer],
  );

  const addToast = useCallback((message: string, type: ToastType = "info") => {
    toastCounter += 1;
    const id = toastCounter;
    dispatch({ type: "add", toast: { id, message, type } });
  }, []);

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
    (id: number) => (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissToast(id);
      }
    },
    [dismissToast],
  );

  const handleDismissClick = useCallback(
    (id: number) => (event: MouseEvent<HTMLButtonElement>) => {
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
