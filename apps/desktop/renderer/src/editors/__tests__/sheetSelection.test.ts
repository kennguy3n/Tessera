import { describe, it, expect } from "vitest";
import {
  addSelection,
  extendSelection,
  moveByArrow,
  moveSelection,
  normalizeRange,
  selectionCells,
  selectionContains,
  selectionFromCell,
} from "../sheetSelection";

describe("sheetSelection", () => {
  it("selectionFromCell creates a single-cell selection at the given coord", () => {
    const sel = selectionFromCell({ row: 2, col: 3 });
    expect(sel.anchor).toEqual({ row: 2, col: 3 });
    expect(sel.primary.start).toEqual({ row: 2, col: 3 });
    expect(sel.primary.end).toEqual({ row: 2, col: 3 });
    expect(sel.extras).toEqual([]);
  });

  it("extendSelection moves the head while preserving the anchor", () => {
    const sel = extendSelection(
      selectionFromCell({ row: 1, col: 1 }),
      { row: 4, col: 5 },
    );
    expect(sel.anchor).toEqual({ row: 1, col: 1 });
    expect(sel.primary.start).toEqual({ row: 1, col: 1 });
    expect(sel.primary.end).toEqual({ row: 4, col: 5 });
  });

  it("moveSelection collapses the selection, discarding extras", () => {
    const sel = addSelection(
      extendSelection(selectionFromCell({ row: 0, col: 0 }), {
        row: 3,
        col: 3,
      }),
      { row: 10, col: 10 },
    );
    const moved = moveSelection(sel, { row: 7, col: 7 });
    expect(moved.anchor).toEqual({ row: 7, col: 7 });
    expect(moved.primary.start).toEqual({ row: 7, col: 7 });
    expect(moved.primary.end).toEqual({ row: 7, col: 7 });
    expect(moved.extras).toEqual([]);
  });

  it("addSelection appends a disjoint single-cell extra range", () => {
    const sel = addSelection(
      selectionFromCell({ row: 0, col: 0 }),
      { row: 5, col: 5 },
    );
    expect(sel.extras).toHaveLength(1);
    expect(sel.extras[0].start).toEqual({ row: 5, col: 5 });
    expect(sel.extras[0].end).toEqual({ row: 5, col: 5 });
    // Anchor + primary unchanged.
    expect(sel.anchor).toEqual({ row: 0, col: 0 });
  });

  it("normalizeRange flips bottom-up / right-to-left ranges into TL/BR form", () => {
    const r = normalizeRange({
      start: { row: 5, col: 7 },
      end: { row: 2, col: 3 },
    });
    expect(r).toEqual({ r1: 2, c1: 3, r2: 5, c2: 7 });
  });

  it("selectionContains covers primary AND extras", () => {
    const sel = addSelection(
      extendSelection(selectionFromCell({ row: 0, col: 0 }), {
        row: 2,
        col: 2,
      }),
      { row: 10, col: 10 },
    );
    expect(selectionContains(sel, 1, 1)).toBe(true);
    expect(selectionContains(sel, 10, 10)).toBe(true);
    expect(selectionContains(sel, 5, 5)).toBe(false);
  });

  it("selectionCells walks the union of all ranges with dedup", () => {
    const sel = addSelection(
      extendSelection(selectionFromCell({ row: 0, col: 0 }), {
        row: 1,
        col: 1,
      }),
      { row: 1, col: 1 }, // overlaps with primary
    );
    const cells = selectionCells(sel);
    expect(cells).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
    ]);
  });

  it("moveByArrow without shift collapses to the new cell", () => {
    const sel = selectionFromCell({ row: 1, col: 1 });
    const moved = moveByArrow(sel, "ArrowDown", 10, 10, false);
    expect(moved.anchor).toEqual({ row: 2, col: 1 });
    expect(moved.primary.start).toEqual({ row: 2, col: 1 });
    expect(moved.primary.end).toEqual({ row: 2, col: 1 });
  });

  it("moveByArrow with shift extends from the anchor", () => {
    const sel = selectionFromCell({ row: 1, col: 1 });
    const extended = moveByArrow(sel, "ArrowRight", 10, 10, true);
    expect(extended.anchor).toEqual({ row: 1, col: 1 });
    expect(extended.primary.end).toEqual({ row: 1, col: 2 });
  });

  it("moveByArrow clamps to grid bounds (top edge)", () => {
    const sel = selectionFromCell({ row: 0, col: 0 });
    const moved = moveByArrow(sel, "ArrowUp", 10, 10, false);
    expect(moved.anchor).toEqual({ row: 0, col: 0 });
  });

  it("moveByArrow clamps to grid bounds (right edge)", () => {
    const sel = selectionFromCell({ row: 0, col: 5 });
    const moved = moveByArrow(sel, "ArrowRight", 10, 5, false);
    expect(moved.anchor).toEqual({ row: 0, col: 5 });
  });
});
