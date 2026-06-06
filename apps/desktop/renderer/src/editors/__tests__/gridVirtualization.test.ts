/**
 * Unit tests for the grid row-virtualization math
 * ([`computeVirtualWindow`]). These cover the pure windowing layer
 * the Sheet and Base grids delegate to: which row indices to render
 * for a given scroll offset, and the spacer heights that preserve the
 * scrollbar geometry around them.
 *
 * The central invariant asserted throughout is that the rendered rows
 * plus both spacers always account for the full virtual content
 * height (`rowCount * rowHeight`), so the scrollbar never jumps.
 */
import { describe, it, expect } from "vitest";
import {
  computeVirtualWindow,
  DEFAULT_OVERSCAN,
} from "../gridVirtualization";

/** Rendered-row span (inclusive) implied by a window result. */
function renderedRowCount(start: number, end: number): number {
  return end < start ? 0 : end - start + 1;
}

describe("computeVirtualWindow", () => {
  it("renders the full range when the dataset is empty", () => {
    const w = computeVirtualWindow({
      scrollTop: 0,
      viewportHeight: 500,
      rowCount: 0,
      rowHeight: 20,
    });
    expect(w).toEqual({ startIndex: 0, endIndex: -1, topPad: 0, bottomPad: 0 });
  });

  it("renders everything when the viewport height is unknown (jsdom / hidden)", () => {
    // clientHeight is 0 in a non-laid-out container; the window must
    // not collapse to zero rows or the grid would render blank.
    const rowCount = 5000;
    const w = computeVirtualWindow({
      scrollTop: 0,
      viewportHeight: 0,
      rowCount,
      rowHeight: 24,
    });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(rowCount - 1);
    expect(w.topPad).toBe(0);
    expect(w.bottomPad).toBe(0);
  });

  it("renders everything when rowHeight is non-positive", () => {
    const w = computeVirtualWindow({
      scrollTop: 100,
      viewportHeight: 500,
      rowCount: 100,
      rowHeight: 0,
    });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(99);
  });

  it("windows to the viewport-intersecting rows plus overscan at the top", () => {
    const rowHeight = 20;
    const w = computeVirtualWindow({
      scrollTop: 0,
      viewportHeight: 200, // 10 rows visible
      rowCount: 1000,
      rowHeight,
      overscan: 4,
    });
    // First visible row is 0, so start clamps to 0 (can't go negative).
    expect(w.startIndex).toBe(0);
    // last visible = floor(200/20) = 10, + overscan 4 = 14.
    expect(w.endIndex).toBe(14);
    expect(w.topPad).toBe(0);
    expect(w.bottomPad).toBe((1000 - 1 - 14) * rowHeight);
  });

  it("windows around a mid-list scroll offset with symmetric overscan", () => {
    const rowHeight = 20;
    const overscan = 5;
    const scrollTop = 4000; // firstVisible = 200
    const viewportHeight = 400; // 20 rows tall → lastVisible = 220
    const w = computeVirtualWindow({
      scrollTop,
      viewportHeight,
      rowCount: 1000,
      rowHeight,
      overscan,
    });
    expect(w.startIndex).toBe(200 - overscan);
    expect(w.endIndex).toBe(220 + overscan);
    expect(w.topPad).toBe((200 - overscan) * rowHeight);
    expect(w.bottomPad).toBe((1000 - 1 - (220 + overscan)) * rowHeight);
  });

  it("preserves total scroll height: topPad + rendered + bottomPad === rowCount*rowHeight", () => {
    const rowHeight = 18;
    const rowCount = 12345;
    const w = computeVirtualWindow({
      scrollTop: 50_000,
      viewportHeight: 640,
      rowCount,
      rowHeight,
    });
    const rendered = renderedRowCount(w.startIndex, w.endIndex);
    expect(w.topPad + rendered * rowHeight + w.bottomPad).toBe(
      rowCount * rowHeight,
    );
  });

  it("clamps the window to the last row when scrolled to the bottom", () => {
    const rowHeight = 25;
    const rowCount = 400;
    const w = computeVirtualWindow({
      scrollTop: rowCount * rowHeight, // scrolled past the end
      viewportHeight: 300,
      rowCount,
      rowHeight,
    });
    expect(w.endIndex).toBe(rowCount - 1);
    expect(w.bottomPad).toBe(0);
    expect(w.startIndex).toBeLessThanOrEqual(w.endIndex);
  });

  it("always keeps frozen leading rows out of the window and pads from after them", () => {
    const rowHeight = 20;
    const frozen = 3;
    const w = computeVirtualWindow({
      scrollTop: 2000, // firstVisible = 100
      viewportHeight: 200,
      rowCount: 1000,
      rowHeight,
      overscan: 2,
      frozenLeadingRows: frozen,
    });
    expect(w.startIndex).toBeGreaterThanOrEqual(frozen);
    // topPad measures the gap *after* the frozen block.
    expect(w.topPad).toBe((w.startIndex - frozen) * rowHeight);
  });

  it("never lets the window start before the frozen block even at scrollTop 0", () => {
    const w = computeVirtualWindow({
      scrollTop: 0,
      viewportHeight: 200,
      rowCount: 1000,
      rowHeight: 20,
      frozenLeadingRows: 5,
    });
    expect(w.startIndex).toBe(5);
    expect(w.topPad).toBe(0);
  });

  it("yields an empty window when every row is frozen", () => {
    const w = computeVirtualWindow({
      scrollTop: 0,
      viewportHeight: 200,
      rowCount: 4,
      rowHeight: 20,
      frozenLeadingRows: 4,
    });
    expect(renderedRowCount(w.startIndex, w.endIndex)).toBe(0);
    expect(w.topPad).toBe(0);
    expect(w.bottomPad).toBe(0);
  });

  it("clamps an over-large frozen count to the row count", () => {
    const w = computeVirtualWindow({
      scrollTop: 0,
      viewportHeight: 200,
      rowCount: 4,
      rowHeight: 20,
      frozenLeadingRows: 99,
    });
    expect(renderedRowCount(w.startIndex, w.endIndex)).toBe(0);
  });

  it("defaults the overscan when none is provided", () => {
    const rowHeight = 20;
    const w = computeVirtualWindow({
      scrollTop: 4000, // firstVisible = 200
      viewportHeight: 200,
      rowCount: 1000,
      rowHeight,
    });
    expect(w.startIndex).toBe(200 - DEFAULT_OVERSCAN);
  });
});

/** Cumulative prefix-sum of row tops (length `heights.length + 1`). */
function offsetsFromHeights(heights: number[]): number[] {
  const out = new Array<number>(heights.length + 1);
  out[0] = 0;
  for (let i = 0; i < heights.length; i++) out[i + 1] = out[i] + heights[i];
  return out;
}

describe("computeVirtualWindow — variable row heights (rowOffsets)", () => {
  it("derives the window from real geometry, not the uniform rowHeight", () => {
    // 1000 rows, all 50px tall, but `rowHeight` lies and says 20.
    // Without rowOffsets the window would be computed at the wrong
    // scale; with rowOffsets it must reflect the true 50px rows.
    const heights = Array.from({ length: 1000 }, () => 50);
    const rowOffsets = offsetsFromHeights(heights);
    const w = computeVirtualWindow({
      scrollTop: 5000, // true firstVisible = 5000/50 = 100
      viewportHeight: 500, // 10 rows visible → lastVisible = 110
      rowCount: 1000,
      rowHeight: 20, // deliberately wrong; must be ignored
      rowOffsets,
      overscan: 4,
    });
    expect(w.startIndex).toBe(100 - 4);
    expect(w.endIndex).toBe(110 + 4);
    // topPad is the exact pixel gap to startIndex, not start*20.
    expect(w.topPad).toBe(rowOffsets[w.startIndex]);
  });

  it("preserves the exact-height invariant for non-uniform rows", () => {
    // Heights vary per row so the uniform model would drift.
    const heights = Array.from({ length: 500 }, (_, i) =>
      20 + (i % 7) * 6,
    );
    const rowOffsets = offsetsFromHeights(heights);
    const total = rowOffsets[heights.length];
    const w = computeVirtualWindow({
      scrollTop: 3210,
      viewportHeight: 640,
      rowCount: heights.length,
      rowHeight: 24,
      rowOffsets,
      frozenLeadingRows: 3,
    });
    const frozenPx = rowOffsets[3];
    let renderedPx = 0;
    for (let i = w.startIndex; i <= w.endIndex; i++) renderedPx += heights[i];
    // frozen + topPad + rendered + bottomPad must equal total height
    // exactly, so the scrollbar geometry never drifts.
    expect(frozenPx + w.topPad + renderedPx + w.bottomPad).toBe(total);
  });

  it("includes the row that straddles the scroll offset (no drift)", () => {
    // A tall row early on shifts every later row's true position.
    const heights = [200, ...Array.from({ length: 999 }, () => 20)];
    const rowOffsets = offsetsFromHeights(heights);
    // scrollTop lands inside row 5: top(5) = 200 + 4*20 = 280.
    const w = computeVirtualWindow({
      scrollTop: 285,
      viewportHeight: 100,
      rowCount: heights.length,
      rowHeight: 20,
      rowOffsets,
      overscan: 0,
    });
    expect(w.startIndex).toBe(5);
  });

  it("falls back to the uniform model when rowOffsets length mismatches", () => {
    // Stale prefix-sum (wrong length) must not index out of bounds;
    // it should behave exactly like the uniform path.
    const stale = [0, 20, 40]; // length 3, but rowCount is 1000
    const withStale = computeVirtualWindow({
      scrollTop: 4000,
      viewportHeight: 200,
      rowCount: 1000,
      rowHeight: 20,
      rowOffsets: stale,
      overscan: 4,
    });
    const uniform = computeVirtualWindow({
      scrollTop: 4000,
      viewportHeight: 200,
      rowCount: 1000,
      rowHeight: 20,
      overscan: 4,
    });
    expect(withStale).toEqual(uniform);
  });
});
