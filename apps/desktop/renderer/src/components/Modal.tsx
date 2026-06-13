import { type ReactNode, useId, useRef } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";

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

export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  closeOnOverlayClick = true,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  // Focus trap + Escape-to-close + restore-focus-on-close, shared with
  // every other dialog in the app via the hook (see useFocusTrap).
  useFocusTrap(isOpen, dialogRef, onClose);

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
