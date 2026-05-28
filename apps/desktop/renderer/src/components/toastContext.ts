/**
 * Toast context + `useToast` consumer hook.
 *
 * Extracted out of `Toast.tsx` so the component file's only export
 * is the `ToastProvider` component — this is the configuration
 * React Fast Refresh requires to preserve provider state across
 * HMR edits. With the hook colocated alongside the provider, every
 * save would force the entire app subtree to remount (losing
 * KChat connection state, toast queue, modal state, etc).
 *
 * `ToastContextValue` + `Toast` shape are also exported here so
 * `Toast.tsx` and consumers import from the same source.
 */
import { createContext, useContext } from "react";

export type ToastType = "success" | "error" | "info";

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

export interface ToastContextValue {
  addToast: (message: string, type?: ToastType) => void;
  dismissToast: (id: number) => void;
}

export const ToastContext = createContext<ToastContextValue>({
  addToast: () => {},
  dismissToast: () => {},
});

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}
