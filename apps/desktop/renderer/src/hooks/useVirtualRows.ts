import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { RefObject } from "react";
import {
  computeVirtualWindow,
  type VirtualWindow,
} from "../editors/gridVirtualization";

export interface UseVirtualRowsOptions {
  /** Total number of rows in the dataset. */
  rowCount: number;
  /** Uniform row height (px) used for the windowing math. Ignored
   * when a valid `rowOffsets` prefix-sum is supplied. */
  rowHeight: number;
  /** Optional cumulative prefix-sum of row tops (length
   * `rowCount + 1`) for variable-height grids. When provided the
   * window is computed exactly from this geometry instead of the
   * uniform `rowHeight`. */
  rowOffsets?: readonly number[];
  /** Turn windowing on. When `false` the hook reports the full range
   * so small grids render exactly as they did before virtualization. */
  enabled: boolean;
  /** Leading rows that must always render (e.g. frozen Sheet rows). */
  frozenLeadingRows?: number;
  /** Rows rendered beyond the viewport on each side. */
  overscan?: number;
}

/**
 * Track a scroll container's offset + height and derive the slice of
 * rows to render. The heavy lifting lives in the pure
 * [`computeVirtualWindow`]; this hook only wires it to live DOM
 * measurements and a re-render trigger.
 *
 * Usage: attach the returned `onScroll` to the scroll container and
 * render `topPad` / `bottomPad` spacer rows around the slice
 * `[startIndex, endIndex]`.
 *
 * When `enabled` is `false` the window covers every row and both pads
 * are zero, so callers can unconditionally use the same render path
 * for small and large datasets.
 */
export function useVirtualRows(
  scrollRef: RefObject<HTMLElement | null>,
  options: UseVirtualRowsOptions,
): VirtualWindow & { onScroll: () => void } {
  const {
    rowCount,
    rowHeight,
    rowOffsets,
    enabled,
    frozenLeadingRows = 0,
    overscan,
  } = options;

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setViewportHeight(el.clientHeight);
  }, [scrollRef]);

  // Measure on mount and whenever the container resizes so the window
  // tracks viewport changes (panel drags, window resize) without a
  // scroll event.
  useLayoutEffect(() => {
    measure();
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, scrollRef]);

  // Re-measure when the dataset size changes (rows added/removed can
  // shift the viewport's intersection without a scroll).
  useEffect(() => {
    measure();
  }, [measure, rowCount]);

  if (!enabled) {
    return {
      startIndex: frozenLeadingRows,
      endIndex: rowCount - 1,
      topPad: 0,
      bottomPad: 0,
      onScroll: measure,
    };
  }

  const window = computeVirtualWindow({
    scrollTop,
    viewportHeight,
    rowCount,
    rowHeight,
    rowOffsets,
    overscan,
    frozenLeadingRows,
  });

  return { ...window, onScroll: measure };
}
