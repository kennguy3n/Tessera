import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ToastContext } from "./toastContext";
import type { Toast as ToastShape, ToastType } from "./toastContext";

let toastCounter = 0;

/** Auto-dismiss timeout per toast type, in milliseconds:
 *  - info / success: 5s
 *  - error: 10s so users have time to read the message
 */
const AUTO_DISMISS_MS: Record<ToastType, number> = {
  info: 5000,
  success: 5000,
  error: 10000,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastShape[]>([]);
  // Track timers so a manual dismiss cancels the pending auto-dismiss
  // and removing a toast doesn't leave a leaking setTimeout behind.
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismissToast = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (message: string, type: ToastType = "info") => {
      toastCounter += 1;
      const id = toastCounter;
      setToasts((prev) => [...prev, { id, message, type }]);
      const timer = setTimeout(() => dismissToast(id), AUTO_DISMISS_MS[type]);
      timersRef.current.set(id, timer);
    },
    [dismissToast],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  // Stabilise the context value so consumers that include `toast` in
  // a `useEffect` dependency array do not re-run their effect every
  // time a toast is added or dismissed (which churns `toasts` state
  // and would otherwise produce a fresh `{ addToast, dismissToast }`
  // object literal on every render of this provider).
  //
  // `addToast` and `dismissToast` are both already `useCallback`-
  // stable (their dependency arrays only contain other stable
  // callbacks), so memoising the wrapper object on the same deps
  // collapses the provider value to a single reference for the
  // lifetime of the provider. Found by Devin Review (fifteenth-pass
  // ANALYSIS_0005): the previous inline-object pattern caused
  // `KchatSettingsCard`'s team-fetch effect to re-issue `listTeams`
  // every time an unrelated component added a toast, even though the
  // toast callbacks themselves had not actually changed.
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
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast toast-${toast.type}`}
            role={toast.type === "error" ? "alert" : "status"}
          >
            <span className="toast-message">{toast.message}</span>
            <button
              type="button"
              className="toast-dismiss"
              aria-label="Dismiss notification"
              onClick={() => dismissToast(toast.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
