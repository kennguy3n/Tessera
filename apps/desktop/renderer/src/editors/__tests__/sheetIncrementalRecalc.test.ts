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
