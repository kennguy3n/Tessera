/**
 * cell selection model for the `SheetEditor`.
 *
 * The selection is modelled as a single anchor cell + a primary
 * rectangular range that extends to a "head" cell + an optional
 * list of additional disjoint rectangles for Ctrl+click multi-
 * select. Keeping each rectangle as a (start, end) corner pair
 * (instead of a flat list of {row,col} pairs) keeps the model
 * O(1) for the common click-and-drag-over-1000-cells case.
 *
 * All cell coordinates are zero-based. Ranges are inclusive on
 * both ends (Excel semantics).
 */

/** A single grid cell address (zero-based row + column). */
export interface CellCoord {
  readonly row: number;
  readonly col: number;
}

/**
 * An inclusive rectangular range. Stored as two opposite corners,
 * not normalised — `normalize()` flips them into top-left /
 * bottom-right form when needed (used by iteration / contains).
 */
export interface Range {
  readonly start: CellCoord;
  readonly end: CellCoord;
}

/**
 * The editor's full selection state. Always non-empty: even a
 * single-cell click produces `primary = {start: c, end: c}`. The
 * `anchor` is the corner that stays put when the selection is
 * extended via shift+click / shift+arrow (anchor === primary.start
 * at construction time, but can diverge during extension).
 */
export interface Selection {
  readonly anchor: CellCoord;
  readonly primary: Range;
  readonly extras: ReadonlyArray<Range>;
}

/** Construct a single-cell selection. */
export function selectionFromCell(cell: CellCoord): Selection {
  return {
    anchor: cell,
    primary: { start: cell, end: cell },
    extras: [],
  };
}

/**
 * Extend the primary range so its anchor stays put and its head
 * moves to `head`. Used by shift+click and shift+arrow.
 */
export function extendSelection(sel: Selection, head: CellCoord): Selection {
  return {
    anchor: sel.anchor,
    primary: { start: sel.anchor, end: head },
    extras: sel.extras,
  };
}

/**
 * Move the active cell (anchor + primary collapsed onto a single
 * cell), discarding any extras. Used by plain arrow-key navigation
 * and single click.
 */
export function moveSelection(sel: Selection, head: CellCoord): Selection {
  // Discard the old extras — moving without shift collapses the
  // selection, matching Excel/Google Sheets behaviour.
  void sel;
  return selectionFromCell(head);
}

/**
 * Add a new single-cell range as a disjoint extra (Ctrl+click).
 * The anchor and primary range are preserved; the new cell becomes
 * the most recently added extra.
 */
export function addSelection(sel: Selection, cell: CellCoord): Selection {
  return {
    anchor: sel.anchor,
    primary: sel.primary,
    extras: [...sel.extras, { start: cell, end: cell }],
  };
}

/** Normalise a range into top-left / bottom-right form. */
export function normalizeRange(range: Range): {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
} {
  const r1 = Math.min(range.start.row, range.end.row);
  const r2 = Math.max(range.start.row, range.end.row);
  const c1 = Math.min(range.start.col, range.end.col);
  const c2 = Math.max(range.start.col, range.end.col);
  return { r1, c1, r2, c2 };
}

/** True iff `(row, col)` falls inside any of the selection's ranges. */
export function selectionContains(
  sel: Selection,
  row: number,
  col: number,
): boolean {
  if (rangeContains(sel.primary, row, col)) return true;
  for (const r of sel.extras) if (rangeContains(r, row, col)) return true;
  return false;
}

function rangeContains(range: Range, row: number, col: number): boolean {
  const { r1, r2, c1, c2 } = normalizeRange(range);
  return row >= r1 && row <= r2 && col >= c1 && col <= c2;
}

/**
 * Iterate every cell in the selection in row-major order, skipping
 * duplicates between the primary range and the extras. Used by
 * copy and by the auto-fill detection.
 */
export function selectionCells(sel: Selection): CellCoord[] {
  const seen = new Set<string>();
  const out: CellCoord[] = [];
  const push = (r: number, c: number) => {
    const k = `${r},${c}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ row: r, col: c });
  };
  const emit = (range: Range) => {
    const { r1, r2, c1, c2 } = normalizeRange(range);
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) push(r, c);
    }
  };
  emit(sel.primary);
  for (const x of sel.extras) emit(x);
  return out;
}

/**
 * Compute a new selection after pressing an arrow key from the
 * current `head` (the editing/active cell). Clamps to the grid
 * bounds [0, maxRow] / [0, maxCol]. With `extend=true` the anchor
 * is preserved (shift+arrow); otherwise the selection collapses
 * onto the new cell.
 */
export function moveByArrow(
  sel: Selection,
  key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight",
  maxRow: number,
  maxCol: number,
  extend: boolean,
): Selection {
  const head = extend ? sel.primary.end : sel.anchor;
  let row = head.row;
  let col = head.col;
  if (key === "ArrowUp") row = Math.max(0, row - 1);
  else if (key === "ArrowDown") row = Math.min(maxRow, row + 1);
  else if (key === "ArrowLeft") col = Math.max(0, col - 1);
  else col = Math.min(maxCol, col + 1);
  return extend
    ? extendSelection(sel, { row, col })
    : moveSelection(sel, { row, col });
}
