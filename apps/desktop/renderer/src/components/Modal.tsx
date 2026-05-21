import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
} from "react";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /**
   * When true (default) clicking the overlay backdrop closes the
   * modal. Set to false for "must confirm or cancel" dialogs (e.g.
   * destructive deletes).
   */
  closeOnOverlayClick?: boolean;
}

// CSS selector covering every element that can normally receive
// keyboard focus. Used by the focus trap and the "restore focus"
// fallback when the modal mounts.
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  closeOnOverlayClick = true,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Element that had focus before the modal opened, so we can
  // restore it on close per WAI-ARIA Authoring Practices.
  const previousActiveRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      // Focus trap: cycle Tab/Shift+Tab between focusable children.
      if (e.key === "Tab" && dialogRef.current) {
        const focusables =
          dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
        if (focusables.length === 0) {
          e.preventDefault();
          dialogRef.current.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && (active === first || active === dialogRef.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [isOpen, onClose],
  );

  useEffect(() => {
    if (!isOpen) return;
    previousActiveRef.current = document.activeElement as HTMLElement | null;
    document.addEventListener("keydown", handleKeyDown);
    // Defer focus to give the modal a frame to render.
    const t = setTimeout(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = dialog.querySelectorAll<HTMLElement>(
        FOCUSABLE_SELECTOR,
      );
      if (focusables.length > 0) focusables[0].focus();
      else dialog.focus();
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", handleKeyDown);
      const prev = previousActiveRef.current;
      if (prev && typeof prev.focus === "function") prev.focus();
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay"
      onClick={() => {
        if (closeOnOverlayClick) onClose();
      }}
    >
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 className="modal-title" id={titleId}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
