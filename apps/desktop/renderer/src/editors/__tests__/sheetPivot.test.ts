import { describe, expect, it } from "vitest";

import {
  PIVOT_BLANK_LABEL,
  PIVOT_TOTAL_LABEL,
  computePivot,
  hasPivotData,
  pivotHasRemovedField,
  shiftPivotForStructuralEdit,
} from "../sheetPivot";
import type { PivotSpec } from "../sheetEditorTypes";

// A small source grid: header row + four data rows.
//   Region | Product | Sales
//   North  | A       | 10
//   North  | B       | 20
//   South  | A       | 30
//   South  | A       | 5
const GRID: string[][] = [
  ["Region", "Product", "Sales"],
  ["North", "A", "10"],
  ["North", "B", "20"],
  ["South", "A", "30"],
  ["South", "A", "5"],
];

const textAt = (r: number, c: number): string => GRID[r]?.[c] ?? "";
const valueAt = (r: number, c: number): number | null => {
  const raw = GRID[r]?.[c] ?? "";
  if (raw.trim() === "") return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
};

const spec = (over: Partial<PivotSpec> = {}): PivotSpec => ({
  id: "p1",
  range: "A1:C5",
  rowField: 0,
  valueField: 2,
  agg: "sum",
  ...over,
});

describe("computePivot — single row field", () => {
  it("sums the value field per row group with margins", () => {
    const r = computePivot(spec(), valueAt, textAt);
    expect(r).not.toBeNull();
    expect(r!.rowLabels).toEqual(["North", "South"]);
    expect(r!.colLabels).toEqual([PIVOT_TOTAL_LABEL]);
    expect(r!.matrix).toEqual([[30], [35]]);
    expect(r!.rowTotals).toEqual([30, 35]);
    expect(r!.colTotals).toEqual([65]);
    expect(r!.grandTotal).toBe(65);
    expect(r!.rowFieldName).toBe("Region");
    expect(r!.valueFieldName).toBe("Sales");
    expect(r!.colFieldName).toBeUndefined();
  });

  it("counts records (COUNTA-style) for the count aggregation", () => {
    const r = computePivot(spec({ agg: "count" }), valueAt, textAt);
    expect(r!.rowTotals).toEqual([2, 2]);
    expect(r!.grandTotal).toBe(4);
  });

  it("computes average / min / max over numeric values", () => {
    const avg = computePivot(spec({ agg: "average" }), valueAt, textAt);
    expect(avg!.rowTotals).toEqual([15, 17.5]);
    const min = computePivot(spec({ agg: "min" }), valueAt, textAt);
    expect(min!.rowTotals).toEqual([10, 5]);
    const max = computePivot(spec({ agg: "max" }), valueAt, textAt);
    expect(max!.rowTotals).toEqual([20, 30]);
  });

  it("min/max fold over a huge single bucket without a spread arg-limit", () => {
    // A bucket can, worst case, hold every data row. `Math.min(...values)`
    // throws a RangeError past the engine's ~65K argument cap; the reduce-based
    // fold must compute the extremes for a bucket far larger than that.
    const n = 200_000;
    const big: string[][] = [["Group", "Value"]];
    for (let i = 0; i < n; i++) big.push(["G", String(i)]);
    const t = (r: number, c: number) => big[r]?.[c] ?? "";
    const v = (r: number, c: number) => {
      const raw = big[r]?.[c] ?? "";
      return raw.trim() === "" ? null : Number(raw);
    };
    const range = `A1:B${n + 1}`;
    const base: PivotSpec = { id: "big", range, rowField: 0, valueField: 1, agg: "min" };
    expect(() => computePivot(base, v, t)).not.toThrow();
    expect(computePivot(base, v, t)!.grandTotal).toBe(0);
    expect(computePivot({ ...base, agg: "max" }, v, t)!.grandTotal).toBe(n - 1);
  });
});

describe("computePivot — cross-tab with a column field", () => {
  it("builds a matrix keyed by both fields, blanks where empty", () => {
    const r = computePivot(spec({ colField: 1 }), valueAt, textAt);
    expect(r!.rowLabels).toEqual(["North", "South"]);
    // First-seen column order: A appears before B.
    expect(r!.colLabels).toEqual(["A", "B"]);
    expect(r!.colFieldName).toBe("Product");
    expect(r!.matrix).toEqual([
      [10, 20], // North: A=10, B=20
      [35, null], // South: A=30+5, B=none → blank
    ]);
    expect(r!.rowTotals).toEqual([30, 35]);
    expect(r!.colTotals).toEqual([45, 20]);
    expect(r!.grandTotal).toBe(65);
  });
});

describe("computePivot — edge cases", () => {
  it("labels empty group cells as (blank)", () => {
    const grid = [
      ["Region", "Sales"],
      ["", "5"],
      ["North", "7"],
    ];
    const t = (r: number, c: number) => grid[r]?.[c] ?? "";
    const v = (r: number, c: number) => {
      const raw = grid[r]?.[c] ?? "";
      const n = Number(raw.trim());
      return raw.trim() !== "" && Number.isFinite(n) ? n : null;
    };
    const r = computePivot(
      { id: "p", range: "A1:B3", rowField: 0, valueField: 1, agg: "sum" },
      v,
      t,
    );
    expect(r!.rowLabels).toEqual([PIVOT_BLANK_LABEL, "North"]);
    expect(r!.rowTotals).toEqual([5, 7]);
  });

  it("returns null for an unparseable range", () => {
    expect(computePivot(spec({ range: "not-a-range" }), valueAt, textAt)).toBeNull();
  });

  it("returns an empty-but-valid result when a field is outside the range", () => {
    const r = computePivot(spec({ valueField: 9 }), valueAt, textAt);
    expect(r).not.toBeNull();
    expect(r!.rowLabels).toEqual([]);
    expect(hasPivotData(r)).toBe(false);
  });

  it("returns an empty result when the range has no data rows", () => {
    const r = computePivot(spec({ range: "A1:C1" }), valueAt, textAt);
    expect(r!.rowLabels).toEqual([]);
    expect(hasPivotData(r)).toBe(false);
  });
});

describe("shiftPivotForStructuralEdit", () => {
  it("shifts range + fields right when a column is inserted before them", () => {
    const next = shiftPivotForStructuralEdit(
      spec({ colField: 1 }),
      "col",
      0,
      1,
    );
    expect(next.range).toBe("B1:D5");
    expect(next.rowField).toBe(1);
    expect(next.colField).toBe(2);
    expect(next.valueField).toBe(3);
  });

  it("shifts fields left when an earlier column is removed", () => {
    // rowField=1, valueField=2; removing column 0 (before both) slides each
    // left by one and shrinks the range.
    const next = shiftPivotForStructuralEdit(
      spec({ rowField: 1, valueField: 2 }),
      "col",
      0,
      -1,
    );
    expect(next.range).toBe("A1:B5");
    expect(next.rowField).toBe(0);
    expect(next.valueField).toBe(1);
  });

  it("invalidates a field whose column is removed", () => {
    // Remove column 1 (the colField). rowField(0) stays, valueField(2)→1.
    const next = shiftPivotForStructuralEdit(spec({ colField: 1 }), "col", 1, -1);
    expect(next.rowField).toBe(0);
    expect(next.valueField).toBe(1);
    expect(next.colField).toBeUndefined();
  });

  it("only shifts the range (not column fields) on a row edit", () => {
    const next = shiftPivotForStructuralEdit(spec({ colField: 1 }), "row", 0, 1);
    expect(next.range).toBe("A2:C6");
    expect(next.rowField).toBe(0);
    expect(next.colField).toBe(1);
    expect(next.valueField).toBe(2);
  });

  it("flags a required field collapsed to the -1 sentinel via pivotHasRemovedField", () => {
    // Removing the rowField's own column (col 0) collapses it to -1.
    const removed = shiftPivotForStructuralEdit(spec({ rowField: 0 }), "col", 0, -1);
    expect(removed.rowField).toBe(-1);
    expect(pivotHasRemovedField(removed)).toBe(true);
    // A healthy spec (and one that only lost its optional colField) is not flagged.
    expect(pivotHasRemovedField(spec())).toBe(false);
    const colOnly = shiftPivotForStructuralEdit(spec({ colField: 1 }), "col", 1, -1);
    expect(pivotHasRemovedField(colOnly)).toBe(false);
  });
});
