import { describe, expect, it } from "vitest";

import {
  insertColumnAt,
  insertRowAt,
  removeColumnAt,
  removeRowAt,
} from "../sheetStructureOps";
import type { SheetContent } from "../sheetEditorTypes";

/** A content fixture exercising every column/row-indexed metadata field. */
function fixture(): SheetContent {
  return {
    columns: ["A", "B", "C"],
    rows: [
      ["a0", "b0", "c0"],
      ["a1", "b1", "c1"],
    ],
    formats: {
      "0,0": { bold: true },
      "0,2": { italic: true },
      "1,1": { underline: true },
    },
    validations: {
      "0": { kind: "checkbox" },
      "2": { kind: "list", values: ["x", "y"] },
    },
    conditionalRules: [
      { id: "r-all", column: null, operator: "gt", value: "0", style: {} },
      { id: "r-c2", column: 2, operator: "gt", value: "0", style: {} },
    ],
    columnWidths: [80, 90, 100],
    rowHeights: [20, 24],
    frozenCols: 2,
    frozenRows: 1,
  };
}

describe("removeColumnAt", () => {
  it("drops the column and remaps every column-indexed field", () => {
    const next = removeColumnAt(fixture(), 0);
    expect(next.columns).toEqual(["B", "C"]);
    expect(next.rows).toEqual([
      ["b0", "c0"],
      ["b1", "c1"],
    ]);
    // formats: col 0 dropped, cols 1/2 shift down to 0/1.
    expect(next.formats).toEqual({
      "0,1": { italic: true },
      "1,0": { underline: true },
    });
    // validations: col 0 dropped, col 2 → col 1.
    expect(next.validations).toEqual({ "1": { kind: "list", values: ["x", "y"] } });
    // conditional rule targeting col 2 → col 1; the "all" rule survives.
    expect(next.conditionalRules).toEqual([
      { id: "r-all", column: null, operator: "gt", value: "0", style: {} },
      { id: "r-c2", column: 1, operator: "gt", value: "0", style: {} },
    ]);
    expect(next.columnWidths).toEqual([90, 100]);
    expect(next.frozenCols).toBe(1);
  });

  it("drops a conditional rule whose target column is removed", () => {
    const next = removeColumnAt(fixture(), 2);
    expect(next.conditionalRules).toEqual([
      { id: "r-all", column: null, operator: "gt", value: "0", style: {} },
    ]);
    // validation on col 2 is gone; checkbox on col 0 stays.
    expect(next.validations).toEqual({ "0": { kind: "checkbox" } });
  });

  it("never removes the last remaining column", () => {
    const single: SheetContent = { columns: ["A"], rows: [["a"]] };
    expect(removeColumnAt(single, 0)).toBe(single);
  });

  it("returns the input unchanged for an out-of-range index", () => {
    const c = fixture();
    expect(removeColumnAt(c, 9)).toBe(c);
  });

  it("preserves unrelated workbook fields", () => {
    const c = fixture();
    // A chart referencing column A is unaffected by removing column B, so
    // its object identity is kept (the array is rebuilt by the remap pass).
    c.charts = [{ id: "ch1", type: "bar", range: "A1:A2" }];
    c.namedRanges = [{ name: "foo", range: "A1:A2" }];
    const next = removeColumnAt(c, 1);
    expect(next.charts?.[0]).toBe(c.charts[0]);
    expect(next.namedRanges).toBe(c.namedRanges);
  });
});

describe("insertColumnAt", () => {
  it("appends a blank column without shifting existing keys", () => {
    const c = fixture();
    const next = insertColumnAt(c, c.columns.length, "D");
    expect(next.columns).toEqual(["A", "B", "C", "D"]);
    expect(next.rows[0]).toEqual(["a0", "b0", "c0", ""]);
    expect(next.formats).toEqual(c.formats);
    expect(next.validations).toEqual(c.validations);
    expect(next.frozenCols).toBe(2);
  });

  it("shifts every column-indexed field at or after the insert point", () => {
    const next = insertColumnAt(fixture(), 0, "New");
    expect(next.columns).toEqual(["New", "A", "B", "C"]);
    expect(next.rows[0]).toEqual(["", "a0", "b0", "c0"]);
    // formats: all columns shift +1.
    expect(next.formats).toEqual({
      "0,1": { bold: true },
      "0,3": { italic: true },
      "1,2": { underline: true },
    });
    expect(next.validations).toEqual({
      "1": { kind: "checkbox" },
      "3": { kind: "list", values: ["x", "y"] },
    });
    expect(next.conditionalRules?.find((r) => r.id === "r-c2")?.column).toBe(3);
    expect(next.columnWidths).toEqual([undefined, 80, 90, 100]);
    // Inserting inside the frozen region grows it.
    expect(next.frozenCols).toBe(3);
  });
});

describe("removeRowAt", () => {
  it("drops the row and remaps row-indexed fields", () => {
    const next = removeRowAt(fixture(), 0);
    expect(next.rows).toEqual([["a1", "b1", "c1"]]);
    // formats on row 0 dropped, row 1 → row 0.
    expect(next.formats).toEqual({ "0,1": { underline: true } });
    expect(next.rowHeights).toEqual([24]);
    expect(next.frozenRows).toBeUndefined();
  });

  it("returns the input unchanged for an out-of-range index", () => {
    const c = fixture();
    expect(removeRowAt(c, 9)).toBe(c);
  });

  it("refuses to remove the last remaining row", () => {
    const c: SheetContent = { columns: ["A"], rows: [["only"]] };
    expect(removeRowAt(c, 0)).toBe(c);
  });
});

/** A content fixture carrying charts bound to A1 ranges. */
function chartFixture(): SheetContent {
  return {
    columns: ["A", "B", "C"],
    rows: [
      ["1", "2", "3"],
      ["4", "5", "6"],
    ],
    charts: [
      { id: "c1", type: "bar", range: "B1:B2" },
      { id: "c2", type: "line", range: "A1:C2", labelRange: "A1:A2" },
    ],
  };
}

describe("structural edits remap chart ranges", () => {
  it("shifts/shrinks chart ranges when a column is removed", () => {
    const next = removeColumnAt(chartFixture(), 0);
    expect(next.charts).toEqual([
      { id: "c1", type: "bar", range: "A1:A2" },
      { id: "c2", type: "line", range: "A1:B2", labelRange: "#REF!" },
    ]);
  });

  it("shifts/widens chart ranges when a column is inserted", () => {
    const next = insertColumnAt(chartFixture(), 0, "Z");
    expect(next.charts).toEqual([
      { id: "c1", type: "bar", range: "C1:C2" },
      { id: "c2", type: "line", range: "B1:D2", labelRange: "B1:B2" },
    ]);
  });

  it("shifts chart ranges when a row is removed", () => {
    const next = removeRowAt(chartFixture(), 0);
    expect(next.charts?.[0]).toEqual({ id: "c1", type: "bar", range: "B1" });
  });

  it("leaves charts untouched when no chart references the edit", () => {
    const c = chartFixture();
    // Remove the last column (C, index 2): c1 (B) and c2 (A:C) both touch it,
    // so identity isn't expected — instead verify an unrelated insert far to
    // the right keeps the same array reference for unaffected charts.
    const next = insertColumnAt(c, 9, "Z");
    expect(next.charts?.[0]).toBe(c.charts?.[0]);
  });
});

describe("insertRowAt", () => {
  it("inserts a blank row and shifts row-indexed fields", () => {
    const next = insertRowAt(fixture(), 0);
    expect(next.rows[0]).toEqual(["", "", ""]);
    expect(next.rows).toHaveLength(3);
    expect(next.formats).toEqual({
      "1,0": { bold: true },
      "1,2": { italic: true },
      "2,1": { underline: true },
    });
    expect(next.rowHeights).toEqual([undefined, 20, 24]);
    expect(next.frozenRows).toBe(2);
  });

  it("appends at the end without shifting", () => {
    const c = fixture();
    const next = insertRowAt(c, c.rows.length);
    expect(next.rows).toHaveLength(3);
    expect(next.formats).toEqual(c.formats);
  });
});
