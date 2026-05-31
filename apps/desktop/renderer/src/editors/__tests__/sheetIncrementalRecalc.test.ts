/**
 * Phase 19 PR 9 — incremental recalculation pinning tests for the
 * SheetEditor render path. The legacy pre-PR-9 code rebuilt the
 * cellCache from scratch on every render; PR 9 persists a
 * DependencyGraph + per-cell result cache across renders and only
 * recomputes the dirty + transitively-dependent set.
 *
 * These tests pin the contract that
 *   (a) cached values survive a no-op render,
 *   (b) editing a leaf cell invalidates only its transitive
 *       dependents (NOT siblings),
 *   (c) a formula-source change updates both the cache AND the
 *       dep graph,
 *   (d) cycles surface `#CIRCULAR!` and stay cyclic on the next
 *       render until broken,
 *   (e) deletion of a formula cell drops its graph edges so
 *       future edits to the (now-orphan) referenced cell don't
 *       phantom-recalculate it.
 *
 * We assert against the cache MAP directly (not the rendered UI) so
 * the tests stay deterministic and fast — they exercise the same
 * `incrementalRecalc` the SheetEditor `useMemo` wires up, but
 * without any React render machinery in the middle.
 */
import { describe, expect, it } from "vitest";
import {
  incrementalRecalc,
  makeIncrementalRecalcState,
  updateCellInRows,
  updateCellsInRows,
} from "../sheetEditorHelpers";
import { cellKey, isFormulaError } from "../formulaEngine";
import type { SheetContent } from "../sheetEditorTypes";

/**
 * Cache + dep-graph keys are fully qualified (`"sheet1!r,c"`), so
 * test helpers thread the active sheet name through cellKey to
 * match what `incrementalRecalc` writes. For single-sheet content
 * (every fixture here), the name is always `"Sheet1"`.
 */
const ACTIVE = "Sheet1";
const key = (r: number, c: number): string => cellKey(r, c, ACTIVE);

/**
 * Build a `SheetContent` from a row-major 2-D string array. Keeps
 * the test fixtures readable inline.
 */
function sheet(rows: string[][]): SheetContent {
  const cols = Math.max(...rows.map((r) => r.length));
  const columns: string[] = [];
  for (let i = 0; i < cols; i++) {
    columns.push(String.fromCharCode(65 + i));
  }
  return { columns, rows };
}

/**
 * Edit one cell in `sheet` and return a freshly-allocated
 * `SheetContent`. The result has a new top-level `rows` array AND
 * a new row array for the edited row, matching how SheetEditor
 * actually produces edits — preserves reference-equality for
 * untouched rows so the diff's row-level early-out kicks in.
 */
function setCell(
  source: SheetContent,
  row: number,
  col: number,
  value: string,
): SheetContent {
  const nextRows = source.rows.map((r, ri) => {
    if (ri !== row) return r;
    const copy = [...r];
    while (copy.length <= col) copy.push("");
    copy[col] = value;
    return copy;
  });
  return { ...source, rows: nextRows };
}

/**
 * Read a cell's evaluated value from the cache as a plain JS value.
 * Errors collapse to their `#XXX!` code so an equality assertion
 * is one line.
 */
function valAt(
  cache: ReturnType<typeof incrementalRecalc>,
  row: number,
  col: number,
): unknown {
  const v = cache.get(key(row, col));
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (isFormulaError(v)) return v.code;
  return v;
}

describe("incrementalRecalc", () => {
  it("first render evaluates every formula and caches the result", () => {
    const initial = sheet([
      ["1", "2", "=A1+B1"],
      ["3", "4", "=A2+B2"],
    ]);
    const state = makeIncrementalRecalcState();
    const cache = incrementalRecalc(initial, state);

    expect(valAt(cache, 0, 0)).toBe(1);
    expect(valAt(cache, 0, 1)).toBe(2);
    expect(valAt(cache, 0, 2)).toBe(3);
    expect(valAt(cache, 1, 0)).toBe(3);
    expect(valAt(cache, 1, 1)).toBe(4);
    expect(valAt(cache, 1, 2)).toBe(7);
  });

  it("second render with reference-identical rows is a no-op", () => {
    const initial = sheet([
      ["1", "2", "=A1+B1"],
    ]);
    const state = makeIncrementalRecalcState();
    const first = incrementalRecalc(initial, state);
    const firstC = first.get(key(0, 2));

    // Same `rows` reference — diff should find zero dirty cells.
    const second = incrementalRecalc(initial, state);
    const secondC = second.get(key(0, 2));
    expect(secondC).toBe(firstC); // Same FormulaValue reference.
    expect(valAt(second, 0, 2)).toBe(3);
  });

  it("editing a leaf cell re-evaluates only its dependents", () => {
    const initial = sheet([
      ["1", "2", "=A1+B1", "=B1*2"], // C1 depends on A1; D1 depends on B1.
    ]);
    const state = makeIncrementalRecalcState();
    const first = incrementalRecalc(initial, state);
    const firstD = first.get(key(0, 3)); // D1 value reference.

    // Change A1 → 10. C1 must recompute (now 12); D1 must NOT
    // recompute (still 4, same reference in the cache).
    const edited = setCell(initial, 0, 0, "10");
    const second = incrementalRecalc(edited, state);

    expect(valAt(second, 0, 0)).toBe(10);
    expect(valAt(second, 0, 2)).toBe(12);
    expect(valAt(second, 0, 3)).toBe(4);
    expect(second.get(key(0, 3))).toBe(firstD);
  });

  it("transitive recomputation walks deep dependency chains", () => {
    // A1 → B1 → C1 → D1 — a 4-deep chain. Editing A1 must
    // propagate through every step.
    const initial = sheet([
      ["1", "=A1+1", "=B1+1", "=C1+1"],
    ]);
    const state = makeIncrementalRecalcState();
    incrementalRecalc(initial, state);

    const edited = setCell(initial, 0, 0, "10");
    const cache = incrementalRecalc(edited, state);
    expect(valAt(cache, 0, 0)).toBe(10);
    expect(valAt(cache, 0, 1)).toBe(11);
    expect(valAt(cache, 0, 2)).toBe(12);
    expect(valAt(cache, 0, 3)).toBe(13);
  });

  it("siblings sharing a parent are NOT cross-invalidated", () => {
    // C1 and D1 both read A1. Editing E1 (independent) must NOT
    // invalidate C1 or D1.
    const initial = sheet([
      ["1", "0", "=A1*2", "=A1*3", "5"],
    ]);
    const state = makeIncrementalRecalcState();
    const first = incrementalRecalc(initial, state);
    const firstC = first.get(key(0, 2));
    const firstD = first.get(key(0, 3));

    const edited = setCell(initial, 0, 4, "50"); // E1: independent of C1/D1.
    const second = incrementalRecalc(edited, state);
    expect(second.get(key(0, 2))).toBe(firstC);
    expect(second.get(key(0, 3))).toBe(firstD);
    expect(valAt(second, 0, 4)).toBe(50);
  });

  it("changing a formula's source updates BOTH cache and dep graph", () => {
    // C1 = A1+B1 initially. Change C1 to read only A1. After the
    // change, editing B1 must NOT invalidate C1.
    const initial = sheet([
      ["1", "2", "=A1+B1"],
    ]);
    const state = makeIncrementalRecalcState();
    incrementalRecalc(initial, state);

    const swapped = setCell(initial, 0, 2, "=A1");
    const afterSwap = incrementalRecalc(swapped, state);
    expect(valAt(afterSwap, 0, 2)).toBe(1);

    const cFreshRef = afterSwap.get(key(0, 2));
    const edited = setCell(swapped, 0, 1, "999"); // Edit B1.
    const final = incrementalRecalc(edited, state);
    expect(final.get(key(0, 2))).toBe(cFreshRef); // C1 unchanged.
    expect(valAt(final, 0, 1)).toBe(999);
  });

  it("formula → literal: dropped edges don't cause phantom recompute", () => {
    // C1 starts as =A1+B1. Change to literal 99. Edit A1 → must
    // NOT recompute C1 (C1 has no edges any more).
    const initial = sheet([
      ["1", "2", "=A1+B1"],
    ]);
    const state = makeIncrementalRecalcState();
    incrementalRecalc(initial, state);

    const literalised = setCell(initial, 0, 2, "99");
    const afterLit = incrementalRecalc(literalised, state);
    expect(valAt(afterLit, 0, 2)).toBe(99);

    const cRef = afterLit.get(key(0, 2));
    const edited = setCell(literalised, 0, 0, "10");
    const final = incrementalRecalc(edited, state);
    // C1's literal value is untouched (same cache reference).
    expect(final.get(key(0, 2))).toBe(cRef);
    expect(valAt(final, 0, 0)).toBe(10);
  });

  it("literal → formula: new edges fire downstream invalidation", () => {
    // C1 starts as literal 99. Change to =A1. Then edit A1 → C1
    // must recompute.
    const initial = sheet([
      ["1", "2", "99"],
    ]);
    const state = makeIncrementalRecalcState();
    incrementalRecalc(initial, state);

    const formulised = setCell(initial, 0, 2, "=A1");
    const afterForm = incrementalRecalc(formulised, state);
    expect(valAt(afterForm, 0, 2)).toBe(1);

    const edited = setCell(formulised, 0, 0, "42");
    const final = incrementalRecalc(edited, state);
    expect(valAt(final, 0, 2)).toBe(42);
  });

  it("circular references surface #CIRCULAR! and stay flagged across renders", () => {
    // A1 = B1, B1 = A1.
    const initial = sheet([
      ["=B1", "=A1"],
    ]);
    const state = makeIncrementalRecalcState();
    const cache1 = incrementalRecalc(initial, state);
    expect(valAt(cache1, 0, 0)).toBe("#CIRCULAR!");
    expect(valAt(cache1, 0, 1)).toBe("#CIRCULAR!");

    // No edit: cache should keep the cyclic status (no spontaneous
    // healing).
    const cache2 = incrementalRecalc(initial, state);
    expect(valAt(cache2, 0, 0)).toBe("#CIRCULAR!");
    expect(valAt(cache2, 0, 1)).toBe("#CIRCULAR!");

    // Break the cycle: B1 = 5. A1 should now evaluate to 5.
    const fixed = setCell(initial, 0, 1, "5");
    const cache3 = incrementalRecalc(fixed, state);
    expect(valAt(cache3, 0, 1)).toBe(5);
    expect(valAt(cache3, 0, 0)).toBe(5);
  });

  it("parse errors don't keep stale edges in the graph", () => {
    // C1 starts =A1+B1, then user mid-types '=A1+' (parse error),
    // then resolves to '=A1+B1' again. Stale edges from the broken
    // state must not double-up.
    const initial = sheet([
      ["1", "2", "=A1+B1"],
    ]);
    const state = makeIncrementalRecalcState();
    incrementalRecalc(initial, state);

    const broken = setCell(initial, 0, 2, "=A1+");
    incrementalRecalc(broken, state);

    const repaired = setCell(broken, 0, 2, "=A1+B1");
    const final = incrementalRecalc(repaired, state);
    expect(valAt(final, 0, 2)).toBe(3);

    // Editing B1 should still propagate (graph edge B1 → C1 is
    // back in place).
    const after = setCell(repaired, 0, 1, "10");
    const cache = incrementalRecalc(after, state);
    expect(valAt(cache, 0, 2)).toBe(11);
  });

  it("row-reference equality short-circuits unchanged rows", () => {
    // SheetEditor preserves row reference identity for untouched
    // rows. With 10 rows and a single edit on row 5, only row 5's
    // cells should land in the dirty set. We can't observe the
    // dirty set directly, but we CAN observe that other rows'
    // FormulaValue references survive the render.
    const initial = sheet(
      Array.from({ length: 10 }, (_, r) => [
        String(r),
        String(r * 2),
        `=A${r + 1}+B${r + 1}`,
      ]),
    );
    const state = makeIncrementalRecalcState();
    const first = incrementalRecalc(initial, state);
    const refs = Array.from({ length: 10 }, (_, r) =>
      first.get(key(r, 2)),
    );

    // Edit only row 5 column 0 → 100. Row-5 C must update; every
    // other row's C must keep the SAME FormulaValue reference.
    const edited = setCell(initial, 5, 0, "100");
    const second = incrementalRecalc(edited, state);
    for (let r = 0; r < 10; r++) {
      if (r === 5) {
        expect(valAt(second, r, 2)).toBe(110); // 100 + 10
      } else {
        expect(second.get(key(r, 2))).toBe(refs[r]); // Same ref.
      }
    }
  });

  it("shrinking the sheet removes dropped cells from the graph + cache", () => {
    // Start with 2 rows, then delete the second row. The cache
    // entries for the deleted cells must be cleared so a future
    // edit elsewhere doesn't see them as live dependents.
    const initial = sheet([
      ["1", "=A1"],
      ["2", "=A2"],
    ]);
    const state = makeIncrementalRecalcState();
    incrementalRecalc(initial, state);

    const shrunk: SheetContent = { ...initial, rows: [initial.rows[0]] };
    const cache = incrementalRecalc(shrunk, state);
    expect(cache.has(key(1, 0))).toBe(false);
    expect(cache.has(key(1, 1))).toBe(false);
    expect(valAt(cache, 0, 1)).toBe(1);
  });

  it("dependent of a deleted cell is re-evaluated, not left stale", () => {
    // Regression: `graph.remove(key)` wipes `users[key]` BEFORE
    // `recalcOrder(dirtyKeys)` walks it, so the dependents of a
    // freshly-deleted cell were silently skipped. Fix snapshots
    // `usedBy(key)` before the remove call and feeds the snapshot
    // into `recalcOrder` as additional seeds.
    //
    // Scenario: B1 reads A1 + A2 (sums column A). Shrink the sheet
    // to drop row 1, deleting A2. B1's cache must update from 30
    // to 10 (since A2 is now blank). Note: the resolver re-caches
    // the deleted cell as `null` when B1 walks A2 during eval,
    // so we assert on B1's value (the actual stale-cache bug),
    // not on A2's cache presence.
    const initial = sheet([
      ["10", "=A1+A2"],
      ["20"],
    ]);
    const state = makeIncrementalRecalcState();
    const before = incrementalRecalc(initial, state);
    expect(valAt(before, 0, 1)).toBe(30);

    const shrunk: SheetContent = { ...initial, rows: [initial.rows[0]] };
    const after = incrementalRecalc(shrunk, state);
    // Without the snapshot+reseed fix, B1 would still report 30.
    expect(valAt(after, 0, 1)).toBe(10);
  });

  it("transitive dependents of a deleted cell are also re-evaluated", () => {
    // Two-deep chain: A2 is referenced by B1, which is referenced
    // by C1. Delete A2 (shrink to 1 row). Both B1 and C1 must
    // recompute, even though `usedBy(A2)` only directly names B1.
    // `recalcOrder` walks B1 → C1 transitively from the extraSeed.
    const initial = sheet([
      ["10", "=A1+A2", "=B1*10"],
      ["20"],
    ]);
    const state = makeIncrementalRecalcState();
    const before = incrementalRecalc(initial, state);
    expect(valAt(before, 0, 1)).toBe(30);
    expect(valAt(before, 0, 2)).toBe(300);

    const shrunk: SheetContent = { ...initial, rows: [initial.rows[0]] };
    const after = incrementalRecalc(shrunk, state);
    expect(valAt(after, 0, 1)).toBe(10);
    expect(valAt(after, 0, 2)).toBe(100);
  });

  it("self-reference surfaces #CIRCULAR! and recovers when broken", () => {
    const initial = sheet([
      ["=A1"],
    ]);
    const state = makeIncrementalRecalcState();
    const cache = incrementalRecalc(initial, state);
    expect(valAt(cache, 0, 0)).toBe("#CIRCULAR!");

    const fixed = setCell(initial, 0, 0, "5");
    const after = incrementalRecalc(fixed, state);
    expect(valAt(after, 0, 0)).toBe(5);
  });
});

describe("updateCellInRows (row-reference preservation)", () => {
  // The whole point of this helper is to feed `incrementalRecalc`
  // the shape it expects: a *new* top-level array (so React sees a
  // fresh `rows` ref and commits a render) where the edited row is
  // freshly cloned AND every other row is the same reference that
  // was passed in. If the helper accidentally regresses to a
  // full-deep clone (the pre-fix shape was
  // `prev.rows.map((r) => [...r])`), `incrementalRecalc`'s
  // O(1) `prevRow === nextRow` short-circuit silently breaks and
  // the dirty diff balloons to O(rows × cols) per keystroke.
  // Devin Review PR #83 ANALYSIS-0002.

  it("preserves the original reference for every row except the edited one", () => {
    const r0 = ["1", "2", "3"];
    const r1 = ["4", "5", "6"];
    const r2 = ["7", "8", "9"];
    const rows: string[][] = [r0, r1, r2];

    const next = updateCellInRows(rows, 3, 1, 0, "X");

    // Edited row is a fresh array …
    expect(next[1]).not.toBe(r1);
    // … but the other two rows survive by reference.
    expect(next[0]).toBe(r0);
    expect(next[2]).toBe(r2);
    // The actual edit landed in the right cell.
    expect(next[1][0]).toBe("X");
    // Sibling cells in the edited row are still correct.
    expect(next[1][1]).toBe("5");
    expect(next[1][2]).toBe("6");
  });

  it("returns a new top-level rows array (React-friendly setSheet)", () => {
    const rows: string[][] = [
      ["a", "b"],
      ["c", "d"],
    ];
    const next = updateCellInRows(rows, 2, 0, 1, "Z");
    // setState requires a new array ref to commit a render.
    expect(next).not.toBe(rows);
    // And the edit landed.
    expect(next[0][1]).toBe("Z");
    expect(next[1]).toBe(rows[1]);
  });

  it("appends blank rows when the edit lands past the current end", () => {
    // SheetEditor lets the user edit row 4 of an empty 2-row
    // sheet; the helper must auto-extend with blank rows so the
    // intermediate rows aren't `undefined`.
    const rows: string[][] = [
      ["1", "2", "3"],
      ["4", "5", "6"],
    ];
    const next = updateCellInRows(rows, 3, 3, 1, "new");

    expect(next.length).toBe(4);
    // Original two rows preserved by reference.
    expect(next[0]).toBe(rows[0]);
    expect(next[1]).toBe(rows[1]);
    // Auto-extended row at index 2 is blank with the right width.
    expect(next[2]).toEqual(["", "", ""]);
    // The edited row at index 3 carries the new value.
    expect(next[3][1]).toBe("new");
  });

  it("extends the target row when the edited column is past the row's end", () => {
    // The same auto-extend behavior applies horizontally: editing
    // a cell past the row's current width pads the row out.
    const r0: string[] = ["a"];
    const rows: string[][] = [r0];
    const next = updateCellInRows(rows, 3, 0, 2, "Q");

    // Edited row is a fresh array (not r0).
    expect(next[0]).not.toBe(r0);
    expect(next[0]).toEqual(["a", "", "Q"]);
  });

  it("feeds incrementalRecalc the row-skip optimisation correctly", () => {
    // End-to-end pinning: a single-cell edit on row 1 must NOT
    // cause `incrementalRecalc` to descend into rows 0 or 2's
    // cells. We can't observe the inner loop directly, but we
    // CAN assert the cache state is correctly updated for the
    // edited row and unchanged for the others.
    const initial = sheet([
      ["1", "=A1*2"],
      ["10", "=A2*2"],
      ["100", "=A3*2"],
    ]);
    const state = makeIncrementalRecalcState();
    const before = incrementalRecalc(initial, state);
    expect(valAt(before, 0, 1)).toBe(2);
    expect(valAt(before, 1, 1)).toBe(20);
    expect(valAt(before, 2, 1)).toBe(200);

    // Edit A2 from "10" to "50" using the helper. Row 0 and row 2
    // must survive by reference; only row 1 should be a fresh array.
    const editedRows = updateCellInRows(initial.rows, 2, 1, 0, "50");
    expect(editedRows[0]).toBe(initial.rows[0]);
    expect(editedRows[2]).toBe(initial.rows[2]);

    const next: SheetContent = { ...initial, rows: editedRows };
    const after = incrementalRecalc(next, state);
    // Edited cell + its dependent recompute.
    expect(valAt(after, 1, 0)).toBe(50);
    expect(valAt(after, 1, 1)).toBe(100);
    // Untouched rows' formulas stay at their previous values.
    expect(valAt(after, 0, 1)).toBe(2);
    expect(valAt(after, 2, 1)).toBe(200);
  });
});

describe("updateCellsInRows (multi-edit row-reference preservation)", () => {
  // Same row-ref preservation contract as `updateCellInRows`, but for
  // bulk-edit paths (Delete/Backspace clears + fill-series). Each row
  // that holds at least one edit gets cloned exactly once; everything
  // else survives by reference.

  it("clones each touched row exactly once when multiple edits land on the same row", () => {
    const rows = [
      ["1", "2", "3"],
      ["4", "5", "6"],
    ];
    const next = updateCellsInRows(rows, 3, [
      { row: 0, col: 0, value: "X" },
      { row: 0, col: 1, value: "Y" },
      { row: 0, col: 2, value: "Z" },
    ]);
    // Edited row is a fresh array …
    expect(next[0]).not.toBe(rows[0]);
    // … but the un-touched row survives by reference.
    expect(next[1]).toBe(rows[1]);
    // All three edits land on the same cloned row.
    expect(next[0]).toEqual(["X", "Y", "Z"]);
  });

  it("preserves reference identity for every row not in the edit set", () => {
    // Sparse edit pattern: edit row 0 and row 3, leave rows 1, 2, 4 alone.
    const rows = [
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
      ["g", "h"],
      ["i", "j"],
    ];
    const next = updateCellsInRows(rows, 2, [
      { row: 0, col: 1, value: "B" },
      { row: 3, col: 0, value: "G" },
    ]);
    // The two edited rows are fresh.
    expect(next[0]).not.toBe(rows[0]);
    expect(next[3]).not.toBe(rows[3]);
    // The three untouched rows are the same reference.
    expect(next[1]).toBe(rows[1]);
    expect(next[2]).toBe(rows[2]);
    expect(next[4]).toBe(rows[4]);
    // Edits landed correctly.
    expect(next[0]).toEqual(["a", "B"]);
    expect(next[3]).toEqual(["G", "h"]);
  });

  it("preserves every row by reference when given an empty edits list", () => {
    // No edits → the helper still mints a fresh top-level array
    // (slice is cheap, and a consistent return shape simplifies the
    // caller). Every row is the same reference. SheetEditor's
    // Delete handler additionally short-circuits with
    // `if (edits.length === 0) return prev` to avoid even the slice
    // cost when no in-bounds cells were targeted.
    const rows = [
      ["1", "2"],
      ["3", "4"],
    ];
    const next = updateCellsInRows(rows, 2, []);
    expect(next[0]).toBe(rows[0]);
    expect(next[1]).toBe(rows[1]);
    expect(next.length).toBe(rows.length);
  });

  it("auto-extends rows/cols past current bounds (fill-series scenario)", () => {
    // Vertical fill from a 2-row source down into rows 2 and 3 of a
    // 2-row sheet — matches the actual fill-series shape.
    const rows = [
      ["1"],
      ["2"],
    ];
    const next = updateCellsInRows(rows, 1, [
      { row: 2, col: 0, value: "3" },
      { row: 3, col: 0, value: "4" },
    ]);
    expect(next.length).toBe(4);
    // Original two rows survive by reference.
    expect(next[0]).toBe(rows[0]);
    expect(next[1]).toBe(rows[1]);
    // Auto-extended rows are fresh arrays with the new values.
    expect(next[2]).toEqual(["3"]);
    expect(next[3]).toEqual(["4"]);
  });
});
