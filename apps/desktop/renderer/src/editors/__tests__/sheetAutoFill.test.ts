import { describe, it, expect } from "vitest";
import { fillSeries, shiftFormulaRefs } from "../sheetAutoFill";

describe("sheetAutoFill", () => {
  describe("numeric series", () => {
    it("extends a two-cell linear progression downward by step 1", () => {
      expect(fillSeries(["1", "2"], 3, "down")).toEqual(["3", "4", "5"]);
    });

    it("extends a two-cell linear progression with step 2", () => {
      expect(fillSeries(["2", "4"], 3, "down")).toEqual(["6", "8", "10"]);
    });

    it("single-cell numeric source counts up by 1 in down direction", () => {
      expect(fillSeries(["5"], 3, "down")).toEqual(["6", "7", "8"]);
    });

    it("single-cell numeric source counts down by 1 in up direction", () => {
      expect(fillSeries(["5"], 3, "up")).toEqual(["4", "3", "2"]);
    });

    it("averages non-uniform diffs across the source range", () => {
      // 1 → 4 (step 3), 4 → 7 (step 3): step = 3
      expect(fillSeries(["1", "4", "7"], 2, "down")).toEqual(["10", "13"]);
    });

    it("supports decimal step sizes", () => {
      expect(fillSeries(["1", "1.5"], 2, "down")).toEqual(["2", "2.5"]);
    });
  });

  describe("formula series", () => {
    it("shifts relative cell references downward", () => {
      // Source =A1+1 at row 0; fill row 1, 2 → A2+1, A3+1
      const out = fillSeries(["=A1+1"], 2, "down");
      expect(out).toEqual(["=A2+1", "=A3+1"]);
    });

    it("shifts relative cell references rightward", () => {
      const out = fillSeries(["=A1+1"], 2, "right");
      expect(out).toEqual(["=B1+1", "=C1+1"]);
    });

    it("preserves absolute markers on $-locked components", () => {
      const out = fillSeries(["=$A$1*B1+$C2"], 2, "down");
      expect(out).toEqual(["=$A$1*B2+$C3", "=$A$1*B3+$C4"]);
    });

    it("emits #REF! when the shifted reference would go negative", () => {
      // =A1 at row 0; fill upward → row -1 is out of bounds
      const out = fillSeries(["=A1+1"], 1, "up");
      expect(out).toEqual(["=#REF!+1"]);
    });

    it("alternates pattern when source has multiple formulas", () => {
      // [=A1, =B1] filled down by 2 → [=A3, =B3, =A5, =B5]
      // (each row repeats the seed pattern shifted by source.length)
      const out = fillSeries(["=A1", "=B1"], 4, "down");
      expect(out).toEqual(["=A3", "=B3", "=A5", "=B5"]);
    });
  });

  describe("shiftFormulaRefs (direct)", () => {
    it("returns identity when delta is zero", () => {
      expect(shiftFormulaRefs("=A1+B1", 0, 0)).toBe("=A1+B1");
    });

    it("handles formulas with ranges", () => {
      expect(shiftFormulaRefs("=SUM(A1:A3)", 1, 0)).toBe("=SUM(A2:A4)");
    });

    it("preserves operators and whitespace verbatim", () => {
      expect(shiftFormulaRefs("=A1 + B1", 0, 1)).toBe("=B1 + C1");
    });

    it("handles multi-letter columns past Z", () => {
      // Column AA is index 26
      expect(shiftFormulaRefs("=Z1", 0, 1)).toBe("=AA1");
    });
  });

  describe("date series", () => {
    it("extends ISO dates by 1 day from a single source", () => {
      expect(fillSeries(["2024-01-01"], 3, "down")).toEqual([
        "2024-01-02",
        "2024-01-03",
        "2024-01-04",
      ]);
    });

    it("detects 7-day step from two consecutive sources", () => {
      expect(fillSeries(["2024-01-01", "2024-01-08"], 2, "down")).toEqual([
        "2024-01-15",
        "2024-01-22",
      ]);
    });

    it("crosses month and year boundaries correctly", () => {
      expect(fillSeries(["2024-12-30"], 4, "down")).toEqual([
        "2024-12-31",
        "2025-01-01",
        "2025-01-02",
        "2025-01-03",
      ]);
    });
  });

  describe("cycle / copy fallback", () => {
    it("repeats text values modulo source length", () => {
      expect(fillSeries(["foo", "bar"], 5, "down")).toEqual([
        "foo",
        "bar",
        "foo",
        "bar",
        "foo",
      ]);
    });

    it("falls through to copy when sources mix text and numbers", () => {
      expect(fillSeries(["foo", "1"], 3, "down")).toEqual(["foo", "1", "foo"]);
    });

    it("returns empty array when length is zero", () => {
      expect(fillSeries(["1", "2"], 0, "down")).toEqual([]);
    });
  });
});
