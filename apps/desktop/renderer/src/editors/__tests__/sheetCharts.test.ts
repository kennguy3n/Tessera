import { describe, expect, it } from "vitest";

import {
  CHART_PAD,
  areaLayout,
  barLayout,
  categoryX,
  extractChartData,
  formatA1Range,
  hasPlottableData,
  lineLayout,
  niceMax,
  parseA1Range,
  pieLayout,
  scatterLayout,
  shiftRangeForStructuralEdit,
  valueExtent,
  yAxisTicks,
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

  it("accepts $-qualified absolute references", () => {
    expect(parseA1Range("$A$1")).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 });
    expect(parseA1Range("$A$1:$C$10")).toEqual({ r1: 0, c1: 0, r2: 9, c2: 2 });
    expect(parseA1Range("$b$2:c3")).toEqual({ r1: 1, c1: 1, r2: 2, c2: 2 });
  });

  it("rejects malformed input", () => {
    expect(parseA1Range("")).toBeNull();
    expect(parseA1Range("xyz")).toBeNull();
    expect(parseA1Range("A1:B2:C3")).toBeNull();
    expect(parseA1Range("Sheet1!A1")).toBeNull();
  });
});

describe("formatA1Range", () => {
  it("serialises a single cell and a range", () => {
    expect(formatA1Range({ r1: 0, c1: 0, r2: 0, c2: 0 })).toBe("A1");
    expect(formatA1Range({ r1: 0, c1: 0, r2: 9, c2: 2 })).toBe("A1:C10");
  });

  it("round-trips through parseA1Range", () => {
    for (const r of ["A1", "B2:D5", "A1:C10"]) {
      expect(formatA1Range(parseA1Range(r)!)).toBe(r);
    }
  });
});

describe("shiftRangeForStructuralEdit", () => {
  it("shifts a range right when a column is inserted before it", () => {
    expect(shiftRangeForStructuralEdit("B1:B3", "col", 0, 1)).toBe("C1:C3");
  });

  it("widens a range when a column is inserted inside it", () => {
    expect(shiftRangeForStructuralEdit("A1:C3", "col", 1, 1)).toBe("A1:D3");
  });

  it("leaves a range untouched when the insert is after it", () => {
    expect(shiftRangeForStructuralEdit("A1:B3", "col", 5, 1)).toBe("A1:B3");
  });

  it("shifts a range left when an earlier column is removed", () => {
    expect(shiftRangeForStructuralEdit("C1:C3", "col", 0, -1)).toBe("B1:B3");
  });

  it("shrinks a range when an interior column is removed", () => {
    expect(shiftRangeForStructuralEdit("A1:C3", "col", 1, -1)).toBe("A1:B3");
  });

  it("collapses to #REF! when the range's only column is removed", () => {
    expect(shiftRangeForStructuralEdit("B1:B3", "col", 1, -1)).toBe("#REF!");
  });

  it("shrinks from the start when the range's first column is removed", () => {
    // lo === at with hi > at: the next column slides into slot `at`, so
    // the range keeps its left edge and loses one column.
    expect(shiftRangeForStructuralEdit("A1:C3", "col", 0, -1)).toBe("A1:B3");
  });

  it("shrinks from the end when the range's last column is removed", () => {
    // hi === at with lo < at: the right edge drops to the previous column.
    expect(shiftRangeForStructuralEdit("A1:C3", "col", 2, -1)).toBe("A1:B3");
  });

  it("applies the same rules on the row axis", () => {
    expect(shiftRangeForStructuralEdit("A2:C2", "row", 0, 1)).toBe("A3:C3");
    expect(shiftRangeForStructuralEdit("A1:C5", "row", 2, -1)).toBe("A1:C4");
    expect(shiftRangeForStructuralEdit("A3:C3", "row", 2, -1)).toBe("#REF!");
  });

  it("returns unparseable input unchanged", () => {
    expect(shiftRangeForStructuralEdit("not-a-range", "col", 0, 1)).toBe(
      "not-a-range",
    );
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

  it("carves an inner hole when innerRadius > 0 (donut)", () => {
    const data: ChartData = {
      labels: ["a", "b"],
      series: [{ name: "A", values: [3, 1] }],
    };
    const solid = pieLayout(data, 50, 50, 40);
    const donut = pieLayout(data, 50, 50, 40, 20);
    expect(donut).toHaveLength(2);
    // A solid wedge moves to the centre (cx,cy) then lines out to the
    // arc; a donut wedge starts on the outer arc and closes back along
    // the inner radius, so it never moves to the bare centre.
    expect(solid[0].path).toContain("M 50 50 L");
    expect(donut[0].path).toContain("A 20 20");
    expect(donut[0].path).not.toContain("M 50 50 L");
  });

  it("emits two concentric circles for a full-circle donut slice", () => {
    const data: ChartData = {
      labels: ["a"],
      series: [{ name: "A", values: [5] }],
    };
    const [slice] = pieLayout(data, 50, 50, 40, 20);
    expect(slice.fraction).toBe(1);
    expect(slice.path).toContain("A 40 40"); // outer ring
    expect(slice.path).toContain("A 20 20"); // inner ring (hole)
  });
});

describe("categoryX", () => {
  it("spreads edge-aligned points from the left axis to the right edge", () => {
    expect(categoryX(0, 3, 10, 90, "edge")).toBeCloseTo(10);
    expect(categoryX(2, 3, 10, 90, "edge")).toBeCloseTo(100);
    expect(categoryX(1, 3, 10, 90, "edge")).toBeCloseTo(55);
  });

  it("centres band-aligned points within each category slot", () => {
    // 3 categories over a width-90 plot → bands of 30; centres at 15/45/75.
    expect(categoryX(0, 3, 10, 90, "band")).toBeCloseTo(25);
    expect(categoryX(1, 3, 10, 90, "band")).toBeCloseTo(55);
    expect(categoryX(2, 3, 10, 90, "band")).toBeCloseTo(85);
  });

  it("centres a lone edge-aligned point and guards empty input", () => {
    expect(categoryX(0, 1, 10, 90, "edge")).toBeCloseTo(55);
    expect(categoryX(0, 0, 10, 90, "edge")).toBe(10);
  });
});

describe("areaLayout", () => {
  it("closes each run down to the baseline so it can be filled", () => {
    const data: ChartData = {
      labels: ["1", "2"],
      series: [{ name: "A", values: [10, 20] }],
    };
    const { areas, max } = areaLayout(data, LAYOUT);
    expect(areas).toHaveLength(1);
    expect(max).toBe(20);
    expect(areas[0].fills).toHaveLength(1);
    const baselineY = LAYOUT.height - CHART_PAD.bottom;
    // A closed fill path ends with `Z` and touches the baseline.
    expect(areas[0].fills[0].trim().endsWith("Z")).toBe(true);
    expect(areas[0].fills[0]).toContain(`${baselineY}`);
    expect(areas[0].points).toHaveLength(2);
  });

  it("breaks the fill around blanks (no bridge over missing data)", () => {
    const data: ChartData = {
      labels: ["1", "2", "3", "4"],
      series: [{ name: "A", values: [1, null, 3, 4] }],
    };
    const { areas } = areaLayout(data, LAYOUT);
    // One run before the gap, one after → two fills + two line segments.
    expect(areas[0].fills).toHaveLength(2);
    expect(areas[0].segments).toHaveLength(2);
  });
});

describe("scatterLayout", () => {
  it("emits one dot per non-blank value, skipping gaps", () => {
    const data: ChartData = {
      labels: ["1", "2", "3", "4"],
      series: [{ name: "A", values: [1, null, 3, 4] }],
    };
    const { dots, max } = scatterLayout(data, LAYOUT);
    // Three plotted points (the blank is skipped, not bridged).
    expect(dots).toHaveLength(3);
    expect(dots.map((d) => d.categoryIndex)).toEqual([0, 2, 3]);
    // `niceMax(4)` rounds the raw extent up to a clean axis bound.
    expect(max).toBe(niceMax(4));
  });

  it("places dots on the same grid as lineLayout", () => {
    const data: ChartData = {
      labels: ["1", "2", "3"],
      series: [{ name: "A", values: [2, 5, 8] }],
    };
    const scatter = scatterLayout(data, LAYOUT);
    const line = lineLayout(data, LAYOUT);
    // The scatter dots must coincide with the line vertices: both derive
    // x from `categoryX` and y from the shared `v / max` mapping.
    expect(scatter.max).toBe(line.max);
    scatter.dots.forEach((d, i) => {
      expect(d.x).toBeCloseTo(line.lines[0].points[i].x);
      expect(d.y).toBeCloseTo(line.lines[0].points[i].y);
    });
  });

  it("keeps every dot inside the plot rectangle", () => {
    const data: ChartData = {
      labels: ["a", "b", "c"],
      series: [{ name: "A", values: [1, 2, 3] }],
    };
    const { dots } = scatterLayout(data, LAYOUT);
    for (const d of dots) {
      expect(d.x).toBeGreaterThanOrEqual(CHART_PAD.left);
      expect(d.x).toBeLessThanOrEqual(LAYOUT.width - CHART_PAD.right);
      expect(d.y).toBeGreaterThanOrEqual(CHART_PAD.top);
      expect(d.y).toBeLessThanOrEqual(LAYOUT.height - CHART_PAD.bottom);
    }
  });

  it("ignores a non-positive maxOverride (no Infinity/NaN coordinates)", () => {
    const data: ChartData = {
      labels: ["a", "b"],
      series: [{ name: "A", values: [3, 6] }],
    };
    for (const bad of [0, -10]) {
      const { dots } = scatterLayout(data, LAYOUT, { maxOverride: bad });
      for (const d of dots) {
        expect(Number.isFinite(d.x)).toBe(true);
        expect(Number.isFinite(d.y)).toBe(true);
      }
    }
  });
});

describe("lineLayout — combo options", () => {
  it("honours maxOverride so combo marks share one axis", () => {
    const data: ChartData = {
      labels: ["1", "2"],
      series: [{ name: "A", values: [10, 20] }],
    };
    const forced = lineLayout(data, LAYOUT, { maxOverride: 100 });
    expect(forced.max).toBe(100);
    const auto = lineLayout(data, LAYOUT);
    // A larger axis max pushes points lower (further from the top).
    expect(forced.lines[0].points[1].y).toBeGreaterThan(
      auto.lines[0].points[1].y,
    );
  });

  it("band-aligns points so a combo line lines up with bar centres", () => {
    const data: ChartData = {
      labels: ["1", "2"],
      series: [{ name: "A", values: [5, 10] }],
    };
    const plotW = LAYOUT.width - CHART_PAD.left - CHART_PAD.right;
    const { lines } = lineLayout(data, LAYOUT, { align: "band" });
    // First of two band centres = left + 0.25 * plotW.
    expect(lines[0].points[0].x).toBeCloseTo(CHART_PAD.left + 0.25 * plotW);
  });

  it("ignores a non-positive maxOverride and derives a finite axis", () => {
    const data: ChartData = {
      labels: ["1", "2"],
      series: [{ name: "A", values: [10, 20] }],
    };
    for (const bad of [0, -5]) {
      const line = lineLayout(data, LAYOUT, { maxOverride: bad });
      const bar = barLayout(data, LAYOUT, bad);
      const area = areaLayout(data, LAYOUT, { maxOverride: bad });
      expect(line.max).toBeGreaterThanOrEqual(1);
      expect(bar.max).toBeGreaterThanOrEqual(1);
      expect(area.max).toBeGreaterThanOrEqual(1);
      // No Infinity/NaN leaks into the rendered coordinates.
      for (const p of line.lines[0].points) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
      for (const r of bar.bars) {
        expect(Number.isFinite(r.height)).toBe(true);
      }
      for (const p of area.areas[0].points) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    }
  });
});

describe("yAxisTicks", () => {
  it("returns count+1 evenly spaced ticks from 0 to max", () => {
    expect(yAxisTicks(100, 4)).toEqual([0, 25, 50, 75, 100]);
  });

  it("falls back to a single zero tick for a non-positive axis", () => {
    expect(yAxisTicks(0)).toEqual([0]);
    expect(yAxisTicks(-5)).toEqual([0]);
  });
});
