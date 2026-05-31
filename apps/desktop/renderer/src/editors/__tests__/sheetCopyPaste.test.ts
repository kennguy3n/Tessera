import { describe, it, expect } from "vitest";
import { applyTSVAt, parseTSV, selectionToTSV } from "../sheetCopyPaste";
import { extendSelection, selectionFromCell } from "../sheetSelection";
import type { SheetTab } from "../sheetEditorTypes";

describe("sheetCopyPaste", () => {
  describe("selectionToTSV", () => {
    it("emits a plain rectangular block as tab-and-newline-joined", () => {
      const rows = [
        ["1", "2", "3"],
        ["4", "5", "6"],
        ["7", "8", "9"],
      ];
      const sel = extendSelection(
        selectionFromCell({ row: 0, col: 0 }),
        { row: 1, col: 1 },
      );
      expect(selectionToTSV(rows, sel)).toBe("1\t2\n4\t5");
    });

    it("quotes cells that contain a tab", () => {
      const rows = [["a\tb", "x"]];
      const sel = extendSelection(
        selectionFromCell({ row: 0, col: 0 }),
        { row: 0, col: 1 },
      );
      expect(selectionToTSV(rows, sel)).toBe('"a\tb"\tx');
    });

    it("quotes cells with embedded newlines or quotes", () => {
      const rows = [["a\nb", 'say "hi"']];
      const sel = extendSelection(
        selectionFromCell({ row: 0, col: 0 }),
        { row: 0, col: 1 },
      );
      expect(selectionToTSV(rows, sel)).toBe('"a\nb"\t"say ""hi"""');
    });

    it("respects reversed-corner selections by normalising", () => {
      const rows = [
        ["1", "2"],
        ["3", "4"],
      ];
      // bottom-right anchor, top-left head
      const sel = extendSelection(
        selectionFromCell({ row: 1, col: 1 }),
        { row: 0, col: 0 },
      );
      expect(selectionToTSV(rows, sel)).toBe("1\t2\n3\t4");
    });
  });

  describe("parseTSV", () => {
    it("parses a plain rectangular TSV block", () => {
      expect(parseTSV("1\t2\n3\t4")).toEqual([
        ["1", "2"],
        ["3", "4"],
      ]);
    });

    it("strips a single trailing newline (Excel adds one)", () => {
      expect(parseTSV("a\tb\n")).toEqual([["a", "b"]]);
    });

    it("preserves embedded tabs inside quoted cells", () => {
      expect(parseTSV('"a\tb"\tc')).toEqual([["a\tb", "c"]]);
    });

    it("preserves embedded newlines inside quoted cells", () => {
      expect(parseTSV('"line1\nline2"\tx')).toEqual([["line1\nline2", "x"]]);
    });

    it("unescapes doubled-quote escape sequence", () => {
      expect(parseTSV('"a""b"')).toEqual([['a"b']]);
    });

    it("handles CRLF line endings (Windows clipboard)", () => {
      expect(parseTSV("1\t2\r\n3\t4")).toEqual([
        ["1", "2"],
        ["3", "4"],
      ]);
    });
  });

  describe("applyTSVAt", () => {
    const baseSheet: SheetTab = {
      name: "Sheet1",
      columns: ["A", "B"],
      rows: [
        ["", ""],
        ["", ""],
      ],
    };

    it("writes TSV values into the sheet starting at the anchor", () => {
      const tsv = parseTSV("X\tY\nZ\tW");
      const next = applyTSVAt(baseSheet, 0, 0, tsv);
      expect(next.rows).toEqual([
        ["X", "Y"],
        ["Z", "W"],
      ]);
    });

    it("grows rows when the paste extends past the grid bottom", () => {
      const tsv = parseTSV("A\nB\nC\nD");
      const next = applyTSVAt(baseSheet, 0, 0, tsv);
      expect(next.rows.length).toBe(4);
      expect(next.rows.map((r) => r[0])).toEqual(["A", "B", "C", "D"]);
    });

    it("grows columns and labels them via the provided helper", () => {
      const tsv = parseTSV("1\t2\t3\t4");
      const next = applyTSVAt(baseSheet, 0, 0, tsv, {
        columnLabelFor: (i) => `Col${i + 1}`,
      });
      expect(next.columns).toEqual(["A", "B", "Col3", "Col4"]);
      expect(next.rows[0]).toEqual(["1", "2", "3", "4"]);
    });

    it("does not mutate the input sheet", () => {
      const tsv = parseTSV("X\tY");
      const before = JSON.stringify(baseSheet);
      applyTSVAt(baseSheet, 0, 0, tsv);
      expect(JSON.stringify(baseSheet)).toBe(before);
    });

    it("preserves reference identity for rows outside the paste range (row-ref optimisation)", () => {
      // Tall sheet (5 rows). Paste a 2-row TSV at anchorRow=1. Rows
      // 0, 3, 4 are outside the paste range and must survive by
      // reference, matching the contract `incrementalRecalc`'s
      // row-skip O(1) `prevRow === nextRow` short-circuit relies on.
      // PR #86 Devin Review ANALYSIS-0002 — paste was the last of the
      // four mutation paths (updateCell, Delete, fill-series, paste)
      // still using the naive clone-all shape.
      const tall: SheetTab = {
        name: "Sheet1",
        columns: ["A", "B"],
        rows: [
          ["r0c0", "r0c1"],
          ["r1c0", "r1c1"],
          ["r2c0", "r2c1"],
          ["r3c0", "r3c1"],
          ["r4c0", "r4c1"],
        ],
      };
      const tsv = parseTSV("X\tY\nZ\tW");
      const next = applyTSVAt(tall, 1, 0, tsv);
      // Rows 1 and 2 hold paste edits — fresh references.
      expect(next.rows[1]).not.toBe(tall.rows[1]);
      expect(next.rows[2]).not.toBe(tall.rows[2]);
      // Rows 0, 3, 4 are untouched — must be the same reference.
      expect(next.rows[0]).toBe(tall.rows[0]);
      expect(next.rows[3]).toBe(tall.rows[3]);
      expect(next.rows[4]).toBe(tall.rows[4]);
    });

    it("preserves the columns array reference when the paste fits within the current column count", () => {
      // No new columns needed → the helper must NOT allocate a new
      // `columns` array. This pins the cheap-path branch — without
      // it, every paste would dirty the columns-derived useMemos
      // (column widths, header rendering) even when columns are
      // untouched.
      const tsv = parseTSV("X\tY");
      const next = applyTSVAt(baseSheet, 0, 0, tsv);
      expect(next.columns).toBe(baseSheet.columns);
    });

    it("allocates a fresh columns array when the paste widens the column count", () => {
      // Sanity counter-test: when columns DO widen, we must allocate
      // a new array (not mutate the input).
      const tsv = parseTSV("1\t2\t3\t4");
      const next = applyTSVAt(baseSheet, 0, 0, tsv);
      expect(next.columns).not.toBe(baseSheet.columns);
      expect(baseSheet.columns).toEqual(["A", "B"]);
    });
  });
});
