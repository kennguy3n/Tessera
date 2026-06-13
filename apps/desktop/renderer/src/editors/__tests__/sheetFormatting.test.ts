/**
 * Coverage for the manual per-cell formatting helpers: patch merge,
 * empty-collapse, boolean toggle semantics.
 */
import { describe, expect, it } from "vitest";

import type { CellCoord } from "../sheetSelection";
import {
  allCellsHave,
  applyFormatPatch,
  getCellFormat,
  toggleBoolFormat,
} from "../sheetFormatting";

const cells = (...pairs: [number, number][]): CellCoord[] =>
  pairs.map(([row, col]) => ({ row, col }));

describe("applyFormatPatch", () => {
  it("sets a format on each targeted cell", () => {
    const out = applyFormatPatch(undefined, cells([0, 0], [1, 2]), {
      bold: true,
    });
    expect(getCellFormat(out, 0, 0)).toEqual({ bold: true });
    expect(getCellFormat(out, 1, 2)).toEqual({ bold: true });
  });

  it("merges onto an existing format", () => {
    const a = applyFormatPatch(undefined, cells([0, 0]), { bold: true });
    const b = applyFormatPatch(a, cells([0, 0]), { italic: true });
    expect(getCellFormat(b, 0, 0)).toEqual({ bold: true, italic: true });
  });

  it("clears a field and removes a now-empty cell entry", () => {
    const a = applyFormatPatch(undefined, cells([0, 0]), { bold: true });
    const b = applyFormatPatch(a, cells([0, 0]), { bold: false });
    expect(getCellFormat(b, 0, 0)).toBeUndefined();
    // Whole map collapses to undefined when nothing remains.
    expect(b).toBeUndefined();
  });

  it("sets a number format and clears it via undefined", () => {
    const a = applyFormatPatch(undefined, cells([2, 3]), {
      numberFormat: "$#,##0.00",
    });
    expect(getCellFormat(a, 2, 3)?.numberFormat).toBe("$#,##0.00");
    const b = applyFormatPatch(a, cells([2, 3]), { numberFormat: undefined });
    expect(b).toBeUndefined();
  });

  it("is a no-op for an empty cell list", () => {
    const a = applyFormatPatch(undefined, [], { bold: true });
    expect(a).toBeUndefined();
  });
});

describe("toggleBoolFormat / allCellsHave", () => {
  it("turns the format ON when not all cells have it", () => {
    const start = applyFormatPatch(undefined, cells([0, 0]), { bold: true });
    const out = toggleBoolFormat(start, cells([0, 0], [0, 1]), "bold");
    expect(allCellsHave(out, cells([0, 0], [0, 1]), "bold")).toBe(true);
  });

  it("turns the format OFF when every cell already has it", () => {
    const start = applyFormatPatch(undefined, cells([0, 0], [0, 1]), {
      italic: true,
    });
    const out = toggleBoolFormat(start, cells([0, 0], [0, 1]), "italic");
    expect(allCellsHave(out, cells([0, 0], [0, 1]), "italic")).toBe(false);
  });

  it("allCellsHave is false for an empty selection", () => {
    expect(allCellsHave(undefined, [], "bold")).toBe(false);
  });
});
