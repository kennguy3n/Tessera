/**
 * Phase 18 Task 20: context-menu open/close state hook.
 *
 * Lives in `hooks/` (not next to the `<ContextMenu>` component) so
 * Vite's fast-refresh boundary stays clean — a TSX file that
 * exports both a React component AND a hook trips the
 * `react-refresh/only-export-components` rule.
 *
 * Pages call this once per anchor element, spread the returned
 * `triggerProps` onto the right-click target, and render
 * `<ContextMenu>` with the returned `isOpen` / `position` /
 * `close` values.
 */

import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useMemo,
  useState,
} from "react";

export interface UseContextMenuResult {
  isOpen: boolean;
  position: { x: number; y: number } | null;
  open: (event: ReactMouseEvent) => void;
  close: () => void;
  triggerProps: {
    onContextMenu: (event: ReactMouseEvent) => void;
  };
}

export function useContextMenu(): UseContextMenuResult {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );

  const open = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    setPosition({ x: event.clientX, y: event.clientY });
  }, []);

  const close = useCallback(() => setPosition(null), []);

  const triggerProps = useMemo(() => ({ onContextMenu: open }), [open]);

  return {
    isOpen: position !== null,
    position,
    open,
    close,
    triggerProps,
  };
}
