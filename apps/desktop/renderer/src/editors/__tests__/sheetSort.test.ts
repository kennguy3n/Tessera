import { describe, expect, it } from "vitest";

import { compareNonBlank, sortOrder, sortSheetByColumn } from "../sheetSort";
import type { CellFormat } from "../sheetEditorTypes";

describe("compareNonBlank", () => {
  it("compares two numbers numerically", () => {
    expect(compareNonBlank("2", "10")).toBeLessThan(0);
    expect(compareNonBlank("10", "2")).toBeGreaterThan(0);
    expect(compareNonBlank("3", "3")).toBe(0);
  });

  it("sorts numbers before text", () => {
    expect(compareNonBlank("5", "apple")).toBeLessThan(0);
    expect(compareNonBlank("apple", "5")).toBeGreaterThan(0);
  });

  it("uses numeric-aware, case-insensitive string comparison", () => {
    expect(compareNonBlank("item2", "item10")).toBeLessThan(0);
    expect(compareNonBlank("Apple", "apple")).toBe(0);
  });
});

describe("sortOrder", () => {
  const rows = [["b"], ["a"], ["c"]];

  it("returns an ascending permutation", () => {
    expect(sortOrder(rows, 0, true)).toEqual([1, 0, 2]);
  });

  it("returns a descending permutation", () => {
    expect(sortOrder(rows, 0, false)).toEqual([2, 0, 1]);
  });

  it("keeps blanks last in both directions and is stable", () => {
    const withBlanks = [["b"], [""], ["a"], [""]];
    // Blanks (rows 1, 3) trail the sorted non-blanks, preserving their
    // original relative order.
    expect(sortOrder(withBlanks, 0, true)).toEqual([2, 0, 1, 3]);
    expect(sortOrder(withBlanks, 0, false)).toEqual([0, 2, 1, 3]);
  });

  it("supports a custom value accessor (e.g. evaluated formulas)", () => {
    const formulaRows = [["=1+1"], ["=10"], ["=5"]];
    const display = ["2", "10", "5"];
    expect(sortOrder(formulaRows, 0, true, (r) => display[r])).toEqual([
      0, 2, 1,
    ]);
  });
});

describe("sortSheetByColumn", () => {
  it("moves whole rows together", () => {
    const rows = [
      ["b", "2"],
      ["a", "1"],
      ["c", "3"],
    ];
    const result = sortSheetByColumn(rows, undefined, 0, true);
    expect(result.rows).toEqual([
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ]);
    expect(result.formats).toBeUndefined();
  });

  it("does not mutate the input rows", () => {
    const rows = [["b"], ["a"]];
    const snapshot = JSON.parse(JSON.stringify(rows));
    sortSheetByColumn(rows, undefined, 0, true);
    expect(rows).toEqual(snapshot);
  });

  it("remaps per-cell formats to follow their row", () => {
    const rows = [["b"], ["a"], ["c"]];
    const formats: Record<string, CellFormat> = {
      "0,0": { bold: true }, // on "b" -> moves to new row 1
      "1,0": { italic: true }, // on "a" -> moves to new row 0
    };
    const result = sortSheetByColumn(rows, formats, 0, true);
    expect(result.rows).toEqual([["a"], ["b"], ["c"]]);
    expect(result.formats).toEqual({
      "1,0": { bold: true },
      "0,0": { italic: true },
    });
  });
});
