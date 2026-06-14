/**
 * Pure charting logic for the `SheetEditor`.
 *
 * A chart binds to an A1 value range (and an optional label range) on
 * the active sheet and is re-derived from live cell values on every
 * render — formulas resolve through the caller-supplied `valueAt`, so a
 * chart of `=B2*1.1` tracks the computed result, not the formula text.
 *
 * This module owns the (pure, dependency-free, unit-tested) work:
 *   - parse / normalise an A1 range,
 *   - extract numeric series + category labels from the grid,
 *   - compute the SVG geometry for bar / line / pie marks.
 *
 * The React layer (`SheetChart`, `ChartsPanel`) is a thin shell that
 * feeds these helpers a `valueAt` accessor and renders the returned
 * geometry. Keeping it framework-free means the maths is testable in
 * isolation and there is no charting dependency to audit.
 */
import type { ChartSpec } from "./sheetEditorTypes";
import { parseCellRef } from "./sheetEditorHelpers";

/** A normalised, zero-based rectangular range. */
export interface RangeRect {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** A single plotted series (one column of the value range). */
export interface ChartSeries {
  /** Display name (the column's A1 letter, or a header cell). */
  name: string;
  /** One value per category; `null` for blank / non-numeric cells. */
  values: (number | null)[];
}

export interface ChartData {
  labels: string[];
  series: ChartSeries[];
}

/** Accessor returning a cell's numeric value, or `null` if not numeric. */
export type NumericValueAt = (row: number, col: number) => number | null;
/** Accessor returning a cell's displayed text (for labels / headers). */
export type TextValueAt = (row: number, col: number) => string;

/** Convert a zero-based column index to its A1 letter (0 → "A"). */
export function columnLetter(index: number): string {
  let label = "";
  let n = index;
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  }
  return label;
}

/**
 * Parse an A1 range (`"A1"`, `"A1:C10"`, reversed `"C10:A1"`) into a
 * normalised {@link RangeRect}. Returns `null` for malformed input.
 * Absolute markers (`$A$1`, `$A$1:$C$10`) are accepted and ignored — a
 * chart range is always relative to the active sheet, so the `$` carries
 * no extra meaning here, but users routinely paste Excel-style absolute
 * references. Sheet-qualified prefixes (`Sheet1!A1`) are not accepted —
 * charts bind to the active sheet only.
 */
export function parseA1Range(range: string): RangeRect | null {
  const trimmed = range.trim();
  if (trimmed === "") return null;
  // Strip `$` absolute markers before delegating to the bare-ref parser.
  const cellOf = (token: string) =>
    parseCellRef(token.replace(/\$/g, "").toUpperCase());
  const parts = trimmed.split(":");
  if (parts.length === 1) {
    const cell = cellOf(parts[0]);
    if (!cell) return null;
    return { r1: cell.row, c1: cell.col, r2: cell.row, c2: cell.col };
  }
  if (parts.length !== 2) return null;
  const a = cellOf(parts[0]);
  const b = cellOf(parts[1]);
  if (!a || !b) return null;
  return {
    r1: Math.min(a.row, b.row),
    c1: Math.min(a.col, b.col),
    r2: Math.max(a.row, b.row),
    c2: Math.max(a.col, b.col),
  };
}

/** Serialise a normalised {@link RangeRect} back to an A1 range string. */
export function formatA1Range(rect: RangeRect): string {
  const a = `${columnLetter(rect.c1)}${rect.r1 + 1}`;
  if (rect.r1 === rect.r2 && rect.c1 === rect.c2) return a;
  return `${a}:${columnLetter(rect.c2)}${rect.r2 + 1}`;
}

/**
 * Rewrite a chart's A1 range when a column (`axis: "col"`) or row
 * (`axis: "row"`) is inserted (`delta: 1`) or removed (`delta: -1`) at
 * zero-based index `at`, mirroring Excel's reference-adjustment rules:
 *
 *   - an insert at or before the range shifts it; an insert *inside* the
 *     range widens it to include the new blank line,
 *   - a removal of an interior or edge line shrinks the range,
 *   - removing the range's only line on that axis collapses it to the
 *     `"#REF!"` sentinel (the chart then renders its empty state).
 *
 * Unparseable input is returned unchanged so a malformed range a user is
 * still typing is never silently mangled.
 */
export function shiftRangeForStructuralEdit(
  range: string,
  axis: "row" | "col",
  at: number,
  delta: 1 | -1,
): string {
  const rect = parseA1Range(range);
  if (!rect) return range;
  let lo = axis === "col" ? rect.c1 : rect.r1;
  let hi = axis === "col" ? rect.c2 : rect.r2;
  if (delta === -1) {
    // Remove line `at`: every line after it shifts down by one and the
    // removed line itself disappears. Each endpoint is recomputed
    // independently from the originals (no in-place mutation), so the
    // result never depends on statement order:
    //   - a line strictly after `at` moves down one (`x - 1`),
    //   - a line before `at` is untouched,
    //   - `lo === at` keeps `lo` (the next line slides into slot `at`),
    //   - `hi === at` drops `hi` to `at - 1` (the previous line).
    // When the surviving start passes the surviving end the range's only
    // line on this axis is gone, so it collapses to `#REF!`.
    const newLo = lo > at ? lo - 1 : lo;
    const newHi = hi >= at ? hi - 1 : hi;
    if (newLo > newHi) return "#REF!";
    lo = newLo;
    hi = newHi;
  } else {
    if (lo >= at) lo += 1;
    if (hi >= at) hi += 1;
  }
  const shifted: RangeRect =
    axis === "col"
      ? { r1: rect.r1, c1: lo, r2: rect.r2, c2: hi }
      : { r1: lo, c1: rect.c1, r2: hi, c2: rect.c2 };
  return formatA1Range(shifted);
}

/**
 * Extract chart data from the grid. Each column of the value range
 * becomes a series; each row becomes a category. When `useFirstRowAsHeader`
 * is set, the first row supplies series names and is excluded from the
 * data; otherwise series are named by their A1 column letter.
 *
 * Labels come from the (optional) label range's first column, aligned to
 * the data rows; missing labels fall back to a 1-based index.
 */
export function extractChartData(
  spec: ChartSpec,
  valueAt: NumericValueAt,
  textAt: TextValueAt,
): ChartData | null {
  const rect = parseA1Range(spec.range);
  if (!rect) return null;

  const header = spec.useFirstRowAsHeader === true;
  const firstDataRow = header ? rect.r1 + 1 : rect.r1;
  if (firstDataRow > rect.r2) return { labels: [], series: [] };

  const labelRect = spec.labelRange ? parseA1Range(spec.labelRange) : null;

  const rowCount = rect.r2 - firstDataRow + 1;
  const labels: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    if (labelRect) {
      const lr = labelRect.r1 + i;
      const text = lr <= labelRect.r2 ? textAt(lr, labelRect.c1).trim() : "";
      labels.push(text !== "" ? text : String(i + 1));
    } else {
      labels.push(String(i + 1));
    }
  }

  const series: ChartSeries[] = [];
  for (let c = rect.c1; c <= rect.c2; c++) {
    const name = header
      ? textAt(rect.r1, c).trim() || columnLetter(c)
      : columnLetter(c);
    const values: (number | null)[] = [];
    for (let r = firstDataRow; r <= rect.r2; r++) {
      values.push(valueAt(r, c));
    }
    series.push({ name, values });
  }
  return { labels, series };
}

/** True when the data has at least one finite numeric value to plot. */
export function hasPlottableData(data: ChartData): boolean {
  return data.series.some((s) => s.values.some((v) => v !== null));
}

/**
 * Round `value` up to a visually pleasant axis maximum (1/2/5 × 10ⁿ).
 * Always returns a strictly positive number so downstream scaling never
 * divides by zero.
 */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const pow = Math.pow(10, exp);
  const frac = value / pow;
  let nice: number;
  if (frac <= 1) nice = 1;
  else if (frac <= 2) nice = 2;
  else if (frac <= 5) nice = 5;
  else nice = 10;
  return nice * pow;
}

/** The numeric span [min, max] across every series value (blanks ignored). */
export function valueExtent(data: ChartData): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const s of data.series) {
    for (const v of s.values) {
      if (v === null) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min)) return { min: 0, max: 0 };
  return { min, max };
}

export interface BarRect {
  x: number;
  y: number;
  width: number;
  height: number;
  seriesIndex: number;
  categoryIndex: number;
}

export interface ChartLayout {
  width: number;
  height: number;
  /** Plot area inset (axis gutter). */
  pad: { top: number; right: number; bottom: number; left: number };
}

const DEFAULT_PAD = { top: 8, right: 8, bottom: 20, left: 32 };

/**
 * Lay out grouped vertical bars. Negative values are clamped to the
 * zero baseline (the chart targets non-negative business data; a fuller
 * negative-axis treatment is deferred). Returns one rect per
 * (category, series) with a numeric value.
 *
 * `maxOverride` forces the axis maximum instead of deriving it from this
 * data — used by the combo mark so its bars and line share one scale. A
 * non-positive override is ignored (it would make every `v / max` blow up to
 * Infinity/NaN); we fall back to the derived `niceMax`, which is always ≥ 1.
 */
export function barLayout(
  data: ChartData,
  layout: ChartLayout,
  maxOverride?: number,
): { bars: BarRect[]; max: number } {
  const pad = layout.pad;
  const plotW = layout.width - pad.left - pad.right;
  const plotH = layout.height - pad.top - pad.bottom;
  const { max: rawMax } = valueExtent(data);
  const max =
    maxOverride !== undefined && maxOverride > 0
      ? maxOverride
      : niceMax(rawMax);
  const categories = data.labels.length;
  const seriesN = data.series.length;
  const bars: BarRect[] = [];
  if (categories === 0 || seriesN === 0 || plotW <= 0 || plotH <= 0) {
    return { bars, max };
  }
  const groupW = plotW / categories;
  const barGap = groupW * 0.15;
  const barW = (groupW - barGap) / seriesN;
  for (let ci = 0; ci < categories; ci++) {
    for (let si = 0; si < seriesN; si++) {
      const v = data.series[si].values[ci];
      if (v === null || v <= 0) continue;
      const h = (v / max) * plotH;
      const x = pad.left + ci * groupW + barGap / 2 + si * barW;
      const y = pad.top + (plotH - h);
      bars.push({
        x,
        y,
        width: Math.max(0, barW - 1),
        height: h,
        seriesIndex: si,
        categoryIndex: ci,
      });
    }
  }
  return { bars, max };
}

export interface LinePath {
  seriesIndex: number;
  /** SVG `points` string for a `<polyline>` (blanks break the line). */
  segments: string[];
  points: { x: number; y: number }[];
}

export interface LineLayoutOptions {
  /** Force the axis maximum (combo charts share one scale across marks). */
  maxOverride?: number;
  /**
   * Horizontal placement of category points:
   *   - `"edge"` (default): first point at the left axis, last at the right
   *     edge — the natural look for a standalone line/area chart.
   *   - `"band"`: points centred in each category band, so a line overlaid
   *     on bars (combo) lines up with the middle of each bar group.
   */
  align?: "edge" | "band";
}

/**
 * X coordinate of category `ci` for the chosen alignment. Shared by the
 * line / area / scatter marks so they all sit on the same grid.
 */
export function categoryX(
  ci: number,
  categories: number,
  plotLeft: number,
  plotW: number,
  align: "edge" | "band" = "edge",
): number {
  if (categories <= 0) return plotLeft;
  if (align === "band") return plotLeft + ((ci + 0.5) / categories) * plotW;
  if (categories === 1) return plotLeft + plotW / 2;
  return plotLeft + (ci / (categories - 1)) * plotW;
}

/**
 * Lay out one polyline per series. Blank values split the series into
 * multiple `segments` (a gap rather than a misleading straight line
 * across missing data).
 */
export function lineLayout(
  data: ChartData,
  layout: ChartLayout,
  opts: LineLayoutOptions = {},
): { lines: LinePath[]; max: number } {
  const pad = layout.pad;
  const plotW = layout.width - pad.left - pad.right;
  const plotH = layout.height - pad.top - pad.bottom;
  const { max: rawMax } = valueExtent(data);
  // A non-positive override would divide every point by ≤ 0; ignore it and use
  // the derived `niceMax` (always ≥ 1). See `barLayout` for the rationale.
  const max =
    opts.maxOverride !== undefined && opts.maxOverride > 0
      ? opts.maxOverride
      : niceMax(rawMax);
  const categories = data.labels.length;
  const lines: LinePath[] = [];
  if (categories === 0 || plotW <= 0 || plotH <= 0) {
    return { lines, max };
  }
  data.series.forEach((s, si) => {
    const points: { x: number; y: number }[] = [];
    const segments: string[] = [];
    let current: string[] = [];
    for (let ci = 0; ci < categories; ci++) {
      const v = s.values[ci];
      if (v === null) {
        if (current.length > 0) {
          segments.push(current.join(" "));
          current = [];
        }
        continue;
      }
      const x = categoryX(ci, categories, pad.left, plotW, opts.align);
      const y = pad.top + (plotH - (v / max) * plotH);
      points.push({ x, y });
      current.push(`${x},${y}`);
    }
    if (current.length > 0) segments.push(current.join(" "));
    lines.push({ seriesIndex: si, segments, points });
  });
  return { lines, max };
}

export interface AreaPath {
  seriesIndex: number;
  /** One filled `<path>` `d` per contiguous run of values (blanks split). */
  fills: string[];
  /** The line drawn on top of each fill (a `<polyline>` `points` string). */
  segments: string[];
  points: { x: number; y: number }[];
}

/**
 * Lay out a filled area per series: the same polyline as {@link lineLayout}
 * but each contiguous run is closed down to the zero baseline so it can be
 * painted as a translucent region. Blanks break the fill (no bridge across
 * missing data), matching the line mark.
 */
export function areaLayout(
  data: ChartData,
  layout: ChartLayout,
  opts: LineLayoutOptions = {},
): { areas: AreaPath[]; max: number } {
  const pad = layout.pad;
  const plotW = layout.width - pad.left - pad.right;
  const plotH = layout.height - pad.top - pad.bottom;
  const { max: rawMax } = valueExtent(data);
  // Ignore a non-positive override (same guard as `barLayout`/`lineLayout`):
  // it would make `v / max` blow up to Infinity/NaN or invert the scale.
  const max =
    opts.maxOverride !== undefined && opts.maxOverride > 0
      ? opts.maxOverride
      : niceMax(rawMax);
  const baselineY = pad.top + plotH;
  const categories = data.labels.length;
  const areas: AreaPath[] = [];
  if (categories === 0 || plotW <= 0 || plotH <= 0) {
    return { areas, max };
  }
  data.series.forEach((s, si) => {
    const points: { x: number; y: number }[] = [];
    const segments: string[] = [];
    const fills: string[] = [];
    let run: { x: number; y: number }[] = [];
    const flush = () => {
      if (run.length === 0) return;
      segments.push(run.map((p) => `${p.x},${p.y}`).join(" "));
      const first = run[0];
      const last = run[run.length - 1];
      const d =
        `M ${first.x} ${baselineY} ` +
        run.map((p) => `L ${p.x} ${p.y}`).join(" ") +
        ` L ${last.x} ${baselineY} Z`;
      fills.push(d);
      run = [];
    };
    for (let ci = 0; ci < categories; ci++) {
      const v = s.values[ci];
      if (v === null) {
        flush();
        continue;
      }
      const x = categoryX(ci, categories, pad.left, plotW, opts.align);
      const y = pad.top + (plotH - (v / max) * plotH);
      points.push({ x, y });
      run.push({ x, y });
    }
    flush();
    areas.push({ seriesIndex: si, fills, segments, points });
  });
  return { areas, max };
}

export interface ScatterDot {
  seriesIndex: number;
  categoryIndex: number;
  /** The plotted value (kept so the renderer can label the dot). */
  value: number;
  x: number;
  y: number;
}

/**
 * Lay out one dot per non-blank value, mirroring {@link lineLayout}'s
 * coordinate maths but without connecting the points. Kept here (rather than
 * inline in the React mark) so every chart's geometry lives in this pure,
 * unit-tested module and the renderer stays a thin shell. Blank values are
 * skipped — a scatter has nothing to draw for a missing point and must not
 * bridge across it.
 */
export function scatterLayout(
  data: ChartData,
  layout: ChartLayout,
  opts: LineLayoutOptions = {},
): { dots: ScatterDot[]; max: number } {
  const pad = layout.pad;
  const plotW = layout.width - pad.left - pad.right;
  const plotH = layout.height - pad.top - pad.bottom;
  const { max: rawMax } = valueExtent(data);
  // Same non-positive-override guard as the line/area/bar layouts: a ≤ 0 max
  // would send every `v / max` to Infinity/NaN or invert the scale.
  const max =
    opts.maxOverride !== undefined && opts.maxOverride > 0
      ? opts.maxOverride
      : niceMax(rawMax);
  const categories = data.labels.length;
  const dots: ScatterDot[] = [];
  if (categories === 0 || plotW <= 0 || plotH <= 0) {
    return { dots, max };
  }
  data.series.forEach((s, si) => {
    for (let ci = 0; ci < categories; ci++) {
      const v = s.values[ci];
      if (v === null) continue;
      const x = categoryX(ci, categories, pad.left, plotW, opts.align);
      const y = pad.top + (plotH - (v / max) * plotH);
      dots.push({ seriesIndex: si, categoryIndex: ci, value: v, x, y });
    }
  });
  return { dots, max };
}

/**
 * Evenly spaced y-axis tick values from 0 to `max` (inclusive), used to
 * draw gridlines + labels. Returns `count + 1` values; falls back to a
 * single `[0]` tick for a non-positive axis.
 */
export function yAxisTicks(max: number, count = 4): number[] {
  if (!(max > 0) || count < 1) return [0];
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) ticks.push((max / count) * i);
  return ticks;
}

export interface PieSlice {
  categoryIndex: number;
  value: number;
  fraction: number;
  startAngle: number;
  endAngle: number;
  /** SVG path `d` for the slice, centred at (cx, cy) with radius r. */
  path: string;
}

/** Cartesian point on a circle for the given angle (0 = 12 o'clock). */
function polar(cx: number, cy: number, r: number, angle: number) {
  return {
    x: cx + r * Math.sin(angle),
    y: cy - r * Math.cos(angle),
  };
}

/**
 * SVG path for one slice of a pie (`innerRadius === 0`) or donut
 * (`innerRadius > 0`). A donut slice is an annulus wedge: out along the
 * outer arc, in across to the inner arc, back along the inner arc (drawn
 * in the opposite sweep so the ring carves out cleanly). The single
 * full-circle case can't be drawn with one arc (start === end), so it is
 * emitted as a near-complete circle (pie) or two concentric near-circles
 * with `fill-rule: evenodd` punching the hole (donut).
 */
function slicePath(
  cx: number,
  cy: number,
  r: number,
  innerRadius: number,
  start: number,
  end: number,
  fraction: number,
): string {
  const largeArc = end - start > Math.PI ? 1 : 0;
  const o1 = polar(cx, cy, r, start);
  const o2 = polar(cx, cy, r, end);
  if (innerRadius > 0) {
    if (fraction >= 1) {
      return (
        `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.001} ${cy - r} Z ` +
        `M ${cx} ${cy - innerRadius} A ${innerRadius} ${innerRadius} 0 1 1 ${cx - 0.001} ${cy - innerRadius} Z`
      );
    }
    const i1 = polar(cx, cy, innerRadius, start);
    const i2 = polar(cx, cy, innerRadius, end);
    return (
      `M ${o1.x} ${o1.y} A ${r} ${r} 0 ${largeArc} 1 ${o2.x} ${o2.y} ` +
      `L ${i2.x} ${i2.y} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${i1.x} ${i1.y} Z`
    );
  }
  if (fraction >= 1) {
    return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.001} ${cy - r} Z`;
  }
  return `M ${cx} ${cy} L ${o1.x} ${o1.y} A ${r} ${r} 0 ${largeArc} 1 ${o2.x} ${o2.y} Z`;
}

/**
 * Lay out a pie from the FIRST series' values (blanks / non-positive
 * values are dropped). Slices start at 12 o'clock and proceed
 * clockwise. Returns an empty array when nothing sums above zero.
 *
 * `innerRadius > 0` produces donut slices (an annulus of that inner
 * radius); the default of `0` keeps the solid-pie geometry unchanged.
 */
export function pieLayout(
  data: ChartData,
  cx: number,
  cy: number,
  r: number,
  innerRadius = 0,
): PieSlice[] {
  const series = data.series[0];
  if (!series) return [];
  const positives = series.values.map((v) => (v !== null && v > 0 ? v : 0));
  const total = positives.reduce((a, b) => a + b, 0);
  if (total <= 0) return [];
  const slices: PieSlice[] = [];
  let angle = 0;
  positives.forEach((v, ci) => {
    if (v <= 0) return;
    const fraction = v / total;
    const start = angle;
    const end = angle + fraction * Math.PI * 2;
    angle = end;
    slices.push({
      categoryIndex: ci,
      value: v,
      fraction,
      startAngle: start,
      endAngle: end,
      path: slicePath(cx, cy, r, innerRadius, start, end, fraction),
    });
  });
  return slices;
}

export const CHART_PAD = DEFAULT_PAD;

/**
 * Series / slice palette shared by every chart renderer. `--color-primary`
 * tracks the active accent; the rest are fixed, WCAG-legible hues that
 * read on both light and dark surfaces. Lives here (the pure charting
 * module) so the React chart components can share one colour source
 * without tripping React Fast Refresh's "components-only export" rule.
 */
export const CHART_SERIES_COLORS: readonly string[] = [
  "var(--color-primary)",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#0ea5e9",
  "#ec4899",
  "#14b8a6",
];

/** Stable colour for the i-th series / slice (cycles through the palette). */
export function chartColorAt(i: number): string {
  return CHART_SERIES_COLORS[i % CHART_SERIES_COLORS.length];
}
