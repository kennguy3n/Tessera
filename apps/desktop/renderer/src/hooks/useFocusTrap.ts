import { useEffect, useRef, type RefObject } from "react";

// CSS selector covering every element that can normally receive
// keyboard focus. Used by the focus trap to find the first/last
// tabbable descendant and as the "focus the container itself"
// fallback when a modal has no focusable content yet.
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Trap keyboard focus inside an open modal/dialog, per the WAI-ARIA
 * Authoring Practices for the `dialog` pattern:
 *
 *   * On open, remember the element that had focus and move focus to
 *     the first focusable descendant (or the container itself when it
 *     has none yet).
 *   * While open, `Tab` / `Shift+Tab` cycle within the container so
 *     focus can never escape to the inert content behind the modal.
 *   * `Escape` invokes `onClose`. We also `stopPropagation()` so the
 *     keypress doesn't continue on to any `window`-level handler. Note
 *     that — because the listener is on `document` — this does NOT block
 *     other `document` keydown handlers (that would need
 *     `stopImmediatePropagation`); it's safe here because the mutual
 *     exclusion of overlays guarantees no competing Escape handler is
 *     mounted while the trap is active.
 *   * On close, restore focus to the element that opened the modal.
 *
 * The hook is a no-op while `isOpen` is false, so it is safe to call
 * unconditionally at the top of a component that conditionally renders
 * its dialog.
 *
 * @param isOpen        Whether the dialog is currently shown.
 * @param containerRef  Ref to the dialog's focus boundary. The element
 *                      should carry `tabIndex={-1}` so it can receive
 *                      focus as the empty-content fallback.
 * @param onClose       Called when the user presses Escape.
 */
export function useFocusTrap(
  isOpen: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  // Element that had focus before the modal opened, restored on close.
  const previousActiveRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    previousActiveRef.current = document.activeElement as HTMLElement | null;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;
      const focusables =
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length === 0) {
        // Nothing tabbable inside — keep focus pinned to the container
        // rather than letting Tab walk into the inert background.
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || active === container)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    // Defer the initial focus one tick so React's commit phase has
    // mounted the dialog's children before we query for focusables.
    const focusTimer = setTimeout(() => {
      const container = containerRef.current;
      if (!container) return;
      const focusables =
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length > 0) focusables[0].focus();
      else container.focus();
    }, 0);

    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      const previous = previousActiveRef.current;
      if (previous && typeof previous.focus === "function") previous.focus();
    };
  }, [isOpen, containerRef, onClose]);
}
