import {
  useCallback,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { SplitDirection } from "../utils/paneTree";

interface PaneSplitterProps {
  /** The parent split's direction. `row` ⇒ a vertical handle the user
   *  drags left/right; `column` ⇒ a horizontal handle dragged up/down. */
  direction: SplitDirection;
  /** Percentage (0–100) of the *leading* adjacent pane, for
   *  `aria-valuenow` and the accessible value text. */
  valueNow: number;
  /** Human label naming the two panes the handle sits between. */
  label: string;
  /** Called with the pointer's fraction (0–1) along the split axis as
   *  the user drags. */
  onDragTo(fraction: number): void;
  /** Called for keyboard nudges: `-1` shrinks the leading pane, `+1`
   *  grows it (by a fixed step). */
  onStep(delta: -1 | 1): void;
}

/**
 * Accessible, theme-tokened resize handle between two panes.
 *
 * Implemented as a WAI-ARIA `separator` (`role="separator"`,
 * `aria-orientation`, `aria-valuemin/max/now`) so screen readers
 * announce it and keyboard users can resize with the arrow keys — not
 * just the pointer. Pointer dragging uses pointer capture so a fast
 * drag that leaves the handle keeps resizing. All visuals come from
 * design tokens; the (cursor) affordance is the only motion and it
 * respects `prefers-reduced-motion` via the consuming stylesheet.
 */
export default function PaneSplitter({
  direction,
  valueNow,
  label,
  onDragTo,
  onStep,
}: PaneSplitterProps): ReactNode {
  const draggingRef = useRef(false);

  const axisFraction = useCallback(
    (clientX: number, clientY: number, handle: HTMLElement): number => {
      const parent = handle.parentElement;
      if (!parent) return 0.5;
      const rect = parent.getBoundingClientRect();
      const f =
        direction === "row"
          ? (clientX - rect.left) / rect.width
          : (clientY - rect.top) / rect.height;
      return Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0.5;
    },
    [direction],
  );

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    // Only the primary button initiates a resize.
    if (e.button !== 0) return;
    e.preventDefault();
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      onDragTo(axisFraction(e.clientX, e.clientY, e.currentTarget));
    },
    [axisFraction, onDragTo],
  );

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const grow = direction === "row" ? "ArrowRight" : "ArrowDown";
      const shrink = direction === "row" ? "ArrowLeft" : "ArrowUp";
      if (e.key === grow) {
        e.preventDefault();
        onStep(1);
      } else if (e.key === shrink) {
        e.preventDefault();
        onStep(-1);
      }
    },
    [direction, onStep],
  );

  return (
    <div
      className={`workspace-splitter workspace-splitter-${direction}`}
      role="separator"
      tabIndex={0}
      aria-orientation={direction === "row" ? "vertical" : "horizontal"}
      aria-label={`Resize ${label}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(valueNow)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    >
      <span className="workspace-splitter-grip" aria-hidden="true" />
    </div>
  );
}
