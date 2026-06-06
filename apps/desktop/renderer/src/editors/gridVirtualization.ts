/**
 * Row virtualization math for the Sheet and Base grids.
 *
 * Large grids (10K+ rows) become unusable if every row is committed
 * to the DOM: layout, paint, and React reconciliation all scale with
 * the node count. The fix is to render only the rows that intersect
 * the scroll viewport (plus a small overscan margin) and replace the
 * off-screen rows with two spacer elements whose heights preserve the
 * scrollbar geometry.
 *
 * This module is the pure, framework-agnostic core of that scheme:
 * given the current scroll offset and viewport height it returns the
 * index range to render and the padding above / below it. Keeping it
 * free of React / DOM makes the (fiddly) arithmetic unit-testable
 * without a renderer.
 *
 * Coordinate model: by default every row is treated as `rowHeight`
 * pixels tall, so the total virtual content height is
 * `rowCount * rowHeight`. Grids with per-row custom heights (e.g. a
 * Sheet with resized rows) can instead pass `rowOffsets` — a
 * cumulative prefix-sum of row tops — and the windowing math becomes
 * exact: the rendered slice and spacer heights are derived from the
 * real geometry via binary search, so the scrollbar position no
 * longer drifts for resized rows.
 *
 * Frozen leading rows (a Sheet feature) are always rendered so they
 * can stay pinned via CSS `position: sticky`; the window therefore
 * only ever covers indices `[frozenLeadingRows, rowCount)`, and the
 * top padding measures the gap *between* the frozen block and the
 * first windowed row.
 */

/** Rows rendered beyond the viewport on each side to avoid blank
 * flashes during fast scrolls. */
export const DEFAULT_OVERSCAN = 8;

export interface VirtualWindowInput {
  /** Scroll offset of the scroll container, in pixels. */
  scrollTop: number;
  /** Visible height of the scroll container, in pixels. */
  viewportHeight: number;
  /** Total number of rows in the dataset. */
  rowCount: number;
  /** Uniform row height used for spacing math, in pixels. Must be > 0.
   * Ignored when a valid `rowOffsets` is supplied. */
  rowHeight: number;
  /**
   * Optional cumulative prefix-sum of row tops for variable-height
   * grids. Must have length `rowCount + 1`: `rowOffsets[i]` is the
   * pixel offset of the top of row `i`, `rowOffsets[0]` is `0`, and
   * `rowOffsets[rowCount]` is the total content height. When present
   * (and well-formed) the window is computed exactly from this
   * geometry; otherwise the uniform `rowHeight` model is used.
   */
  rowOffsets?: readonly number[];
  /** Extra rows rendered above and below the viewport. */
  overscan?: number;
  /** Leading rows that are always rendered (e.g. frozen Sheet rows). */
  frozenLeadingRows?: number;
}

export interface VirtualWindow {
  /** First windowed (non-frozen) row to render, inclusive. */
  startIndex: number;
  /** Last windowed row to render, inclusive. `startIndex - 1` when the
   * window is empty (e.g. every row is frozen, or `rowCount` is 0). */
  endIndex: number;
  /** Spacer height (px) between the frozen block and `startIndex`. */
  topPad: number;
  /** Spacer height (px) below `endIndex` to the end of the dataset. */
  bottomPad: number;
}

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/**
 * Largest index `i` in `[0, hi]` whose offset is `<= value`, via
 * binary search over the monotonically non-decreasing `offsets`.
 * Returns `0` when even `offsets[0]` exceeds `value` (offsets[0] is
 * always 0, so this only happens for negative `value`). Used to find
 * the row that contains a given pixel coordinate.
 */
function lastIndexAtOrBelow(
  offsets: readonly number[],
  value: number,
  hi: number,
): number {
  let lo = 0;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= value) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * `rowOffsets` is only usable when it is a well-formed prefix-sum for
 * the dataset: length `rowCount + 1`. A mismatch (stale array mid-
 * resize) falls back to the uniform model rather than indexing out of
 * bounds.
 */
function hasValidOffsets(
  rowOffsets: readonly number[] | undefined,
  rowCount: number,
): rowOffsets is readonly number[] {
  return Array.isArray(rowOffsets) && rowOffsets.length === rowCount + 1;
}

/**
 * Variable-height window: derive the rendered slice and spacer heights
 * directly from the cumulative `rowOffsets`, so the scrollbar geometry
 * is exact for grids with resized rows.
 */
function computeVariableWindow(
  scrollTop: number,
  viewportHeight: number,
  rowCount: number,
  rowOffsets: readonly number[],
  overscan: number,
  frozen: number,
): VirtualWindow {
  const lastIndex = rowCount - 1;
  const total = rowOffsets[rowCount];

  const firstVisible = lastIndexAtOrBelow(rowOffsets, scrollTop, lastIndex);
  const lastVisible = lastIndexAtOrBelow(
    rowOffsets,
    scrollTop + viewportHeight,
    lastIndex,
  );

  const startIndex = clamp(firstVisible - overscan, frozen, lastIndex);
  const endIndex = clamp(lastVisible + overscan, startIndex, lastIndex);

  const topPad = rowOffsets[startIndex] - rowOffsets[frozen];
  const bottomPad = total - rowOffsets[endIndex + 1];

  return { startIndex, endIndex, topPad, bottomPad };
}

/**
 * Compute the slice of rows to render and the surrounding spacer
 * heights for a vertically-scrolled, uniform-height virtual list.
 *
 * The result always satisfies the invariant
 *   topPad + bottomPad + (rendered rows) * rowHeight === rowCount * rowHeight
 * (treating frozen rows as rendered), so the scroll height is exact
 * regardless of where the window lands.
 *
 * Degenerate inputs are handled defensively so callers can pass raw
 * DOM measurements without guarding:
 *   - `rowCount <= 0` → empty window, no padding.
 *   - `viewportHeight <= 0` (e.g. an unmeasured / display:none
 *     container, common under jsdom) → render the full range so the
 *     grid never collapses to nothing.
 *   - `rowHeight <= 0` → treated as the full range (can't divide).
 */
export function computeVirtualWindow(input: VirtualWindowInput): VirtualWindow {
  const { scrollTop, viewportHeight, rowCount, rowHeight } = input;
  const overscan = Math.max(0, input.overscan ?? DEFAULT_OVERSCAN);
  const frozen = clamp(input.frozenLeadingRows ?? 0, 0, Math.max(0, rowCount));

  if (rowCount <= 0) {
    return { startIndex: 0, endIndex: -1, topPad: 0, bottomPad: 0 };
  }

  // No windowable rows left once the frozen block is removed.
  if (frozen >= rowCount) {
    return { startIndex: frozen, endIndex: frozen - 1, topPad: 0, bottomPad: 0 };
  }

  const lastIndex = rowCount - 1;

  // Can't window without a measured viewport: render everything from
  // the first non-frozen row to the end (common under jsdom / a
  // display:none container). Both pads are zero here.
  if (viewportHeight <= 0) {
    return { startIndex: frozen, endIndex: lastIndex, topPad: 0, bottomPad: 0 };
  }

  // Variable-height grids supply a cumulative prefix-sum; use the exact
  // geometry so the scrollbar does not drift for resized rows.
  if (hasValidOffsets(input.rowOffsets, rowCount)) {
    return computeVariableWindow(
      scrollTop,
      viewportHeight,
      rowCount,
      input.rowOffsets,
      overscan,
      frozen,
    );
  }

  // Uniform model: can't divide by a non-positive height.
  if (rowHeight <= 0) {
    return { startIndex: frozen, endIndex: lastIndex, topPad: 0, bottomPad: 0 };
  }

  const firstVisible = Math.floor(scrollTop / rowHeight);
  const lastVisible = Math.floor((scrollTop + viewportHeight) / rowHeight);

  const startIndex = clamp(firstVisible - overscan, frozen, lastIndex);
  const endIndex = clamp(lastVisible + overscan, startIndex, lastIndex);

  const topPad = (startIndex - frozen) * rowHeight;
  const bottomPad = (lastIndex - endIndex) * rowHeight;

  return { startIndex, endIndex, topPad, bottomPad };
}
