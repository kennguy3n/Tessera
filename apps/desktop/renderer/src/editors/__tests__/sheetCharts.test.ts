import { describe, expect, it } from "vitest";

import {
  CHART_PAD,
  barLayout,
  extractChartData,
  hasPlottableData,
  lineLayout,
  niceMax,
  parseA1Range,
  pieLayout,
  valueExtent,
  type ChartData,
  type ChartLayout,
} from "../sheetCharts";
import type { ChartSpec } from "../sheetEditorTypes";

const LAYOUT: ChartLayout = { width: 320, height: 200, pad: CHART_PAD };

/** A 3-row × 2-col grid accessor used across the extraction tests. */
function gridAccessors(
  cells: (number | string | null)[][],
): {
  valueAt: (r: number, c: number) => number | null;
  textAt: (r: number, c: number) => string;
} {
  return {
    valueAt: (r, c) => {
      const v = cells[r]?.[c];
      return typeof v === "number" ? v : null;
    },
    textAt: (r, c) => {
      const v = cells[r]?.[c];
      return v === null || v === undefined ? "" : String(v);
    },
  };
}

describe("parseA1Range", () => {
  it("parses a single cell", () => {
    expect(parseA1Range("B2")).toEqual({ r1: 1, c1: 1, r2: 1, c2: 1 });
  });

  it("parses a multi-cell range", () => {
    expect(parseA1Range("A1:C10")).toEqual({ r1: 0, c1: 0, r2: 9, c2: 2 });
  });

  it("normalises a reversed range", () => {
    expect(parseA1Range("C10:A1")).toEqual({ r1: 0, c1: 0, r2: 9, c2: 2 });
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseA1Range("  a1:b2 ")).toEqual({ r1: 0, c1: 0, r2: 1, c2: 1 });
  });

  it("rejects malformed input", () => {
    expect(parseA1Range("")).toBeNull();
    expect(parseA1Range("xyz")).toBeNull();
    expect(parseA1Range("A1:B2:C3")).toBeNull();
    expect(parseA1Range("Sheet1!A1")).toBeNull();
  });
});

describe("extractChartData", () => {
  const spec = (over: Partial<ChartSpec>): ChartSpec => ({
    id: "c1",
    type: "bar",
    range: "A1:A3",
    ...over,
  });

  it("extracts a single column as one series named by its letter", () => {
    const { valueAt, textAt } = gridAccessors([[10], [20], [30]]);
    const data = extractChartData(spec({ range: "A1:A3" }), valueAt, textAt);
    expect(data).toEqual({
      labels: ["1", "2", "3"],
      series: [{ name: "A", values: [10, 20, 30] }],
    });
  });

  it("extracts multiple columns as separate series", () => {
    const { valueAt, textAt } = gridAccessors([
      [10, 1],
      [20, 2],
    ]);
    const data = extractChartData(spec({ range: "A1:B2" }), valueAt, textAt);
    expect(data?.series).toEqual([
      { name: "A", values: [10, 20] },
      { name: "B", values: [1, 2] },
    ]);
  });

  it("uses the first row as series names when requested", () => {
    const { valueAt, textAt } = gridAccessors([
      ["Sales", "Cost"],
      [10, 4],
      [20, 6],
    ]);
    const data = extractChartData(
      spec({ range: "A1:B3", useFirstRowAsHeader: true }),
      valueAt,
      textAt,
    );
    expect(data?.series.map((s) => s.name)).toEqual(["Sales", "Cost"]);
    expect(data?.series[0].values).toEqual([10, 20]);
  });

  it("pulls labels from a label range, falling back to an index", () => {
    const cells = [
      ["Jan", 10],
      ["", 20],
    ];
    const { valueAt, textAt } = gridAccessors(cells);
    const data = extractChartData(
      spec({ range: "B1:B2", labelRange: "A1:A2" }),
      valueAt,
      textAt,
    );
    expect(data?.labels).toEqual(["Jan", "2"]);
  });

  it("marks blank / non-numeric cells as null", () => {
    const { valueAt, textAt } = gridAccessors([[10], ["x"], [null]]);
    const data = extractChartData(spec({ range: "A1:A3" }), valueAt, textAt);
    expect(data?.series[0].values).toEqual([10, null, null]);
  });

  it("returns empty data for a header-only range", () => {
    const { valueAt, textAt } = gridAccessors([["H"]]);
    const data = extractChartData(
      spec({ range: "A1:A1", useFirstRowAsHeader: true }),
      valueAt,
      textAt,
    );
    expect(data).toEqual({ labels: [], series: [] });
  });

  it("returns null for a malformed range", () => {
    const { valueAt, textAt } = gridAccessors([[1]]);
    expect(extractChartData(spec({ range: "nope" }), valueAt, textAt)).toBeNull();
  });
});

describe("hasPlottableData / valueExtent / niceMax", () => {
  it("detects plottable data", () => {
    expect(
      hasPlottableData({ labels: ["1"], series: [{ name: "A", values: [5] }] }),
    ).toBe(true);
    expect(
      hasPlottableData({
        labels: ["1"],
        series: [{ name: "A", values: [null] }],
      }),
    ).toBe(false);
    expect(hasPlottableData({ labels: [], series: [] })).toBe(false);
  });

  it("computes extent ignoring blanks", () => {
    const data: ChartData = {
      labels: ["1", "2", "3"],
      series: [{ name: "A", values: [3, null, 9] }],
    };
    expect(valueExtent(data)).toEqual({ min: 3, max: 9 });
  });

  it("returns a zero extent for all-blank data", () => {
    expect(
      valueExtent({ labels: ["1"], series: [{ name: "A", values: [null] }] }),
    ).toEqual({ min: 0, max: 0 });
  });

  it("rounds up to a pleasant axis maximum", () => {
    expect(niceMax(8)).toBe(10);
    expect(niceMax(12)).toBe(20);
    expect(niceMax(45)).toBe(50);
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-5)).toBe(1);
  });
});

describe("barLayout", () => {
  it("produces one rect per positive (category, series) value", () => {
    const data: ChartData = {
      labels: ["1", "2"],
      series: [{ name: "A", values: [10, 20] }],
    };
    const { bars, max } = barLayout(data, LAYOUT);
    expect(bars).toHaveLength(2);
    expect(max).toBe(20);
    // Taller value → shorter y (closer to the top).
    expect(bars[1].y).toBeLessThan(bars[0].y);
    // All bars sit within the plot area.
    for (const b of bars) {
      expect(b.x).toBeGreaterThanOrEqual(CHART_PAD.left);
      expect(b.height).toBeGreaterThan(0);
    }
  });

  it("skips blank and non-positive values", () => {
    const data: ChartData = {
      labels: ["1", "2", "3"],
      series: [{ name: "A", values: [null, 0, 5] }],
    };
    const { bars } = barLayout(data, LAYOUT);
    expect(bars).toHaveLength(1);
    expect(bars[0].categoryIndex).toBe(2);
  });
});

describe("lineLayout", () => {
  it("splits a series into segments around blanks", () => {
    const data: ChartData = {
      labels: ["1", "2", "3", "4"],
      series: [{ name: "A", values: [1, null, 3, 4] }],
    };
    const { lines } = lineLayout(data, LAYOUT);
    expect(lines).toHaveLength(1);
    // One point before the gap, two after → two segments.
    expect(lines[0].segments).toHaveLength(2);
    expect(lines[0].points).toHaveLength(3);
  });

  it("centres a single-category point", () => {
    const data: ChartData = {
      labels: ["only"],
      series: [{ name: "A", values: [7] }],
    };
    const { lines } = lineLayout(data, LAYOUT);
    const expectedX =
      CHART_PAD.left + (LAYOUT.width - CHART_PAD.left - CHART_PAD.right) / 2;
    expect(lines[0].points[0].x).toBeCloseTo(expectedX);
  });
});

describe("pieLayout", () => {
  it("creates slices whose fractions sum to 1", () => {
    const data: ChartData = {
      labels: ["a", "b", "c"],
      series: [{ name: "A", values: [1, 2, 1] }],
    };
    const slices = pieLayout(data, 50, 50, 40);
    expect(slices).toHaveLength(3);
    const sum = slices.reduce((acc, s) => acc + s.fraction, 0);
    expect(sum).toBeCloseTo(1);
    expect(slices[1].fraction).toBeCloseTo(0.5);
  });

  it("returns no slices when nothing is positive", () => {
    const data: ChartData = {
      labels: ["a"],
      series: [{ name: "A", values: [0] }],
    };
    expect(pieLayout(data, 50, 50, 40)).toEqual([]);
  });

  it("emits a full-circle path for a single positive value", () => {
    const data: ChartData = {
      labels: ["a", "b"],
      series: [{ name: "A", values: [5, null] }],
    };
    const slices = pieLayout(data, 50, 50, 40);
    expect(slices).toHaveLength(1);
    expect(slices[0].fraction).toBe(1);
    expect(slices[0].path).toContain("A 40 40");
  });
});
