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
  const cellOf = (token: string) => parseCellRef(token.replace(/\$/g, "").toUpperCase());
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
    if (lo === at && hi === at) return "#REF!";
    if (lo === at) lo = at + 1; // first surviving line
    if (hi === at) hi = at - 1; // last surviving line
    if (lo > at) lo -= 1;
    if (hi > at) hi -= 1;
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

  const labelRect = spec.labelRange
    ? parseA1Range(spec.labelRange)
    : null;

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
    const name = header ? textAt(rect.r1, c).trim() || columnLetter(c) : columnLetter(c);
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
 */
export function barLayout(
  data: ChartData,
  layout: ChartLayout,
): { bars: BarRect[]; max: number } {
  const pad = layout.pad;
  const plotW = layout.width - pad.left - pad.right;
  const plotH = layout.height - pad.top - pad.bottom;
  const { max: rawMax } = valueExtent(data);
  const max = niceMax(rawMax);
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

/**
 * Lay out one polyline per series. Blank values split the series into
 * multiple `segments` (a gap rather than a misleading straight line
 * across missing data).
 */
export function lineLayout(
  data: ChartData,
  layout: ChartLayout,
): { lines: LinePath[]; max: number } {
  const pad = layout.pad;
  const plotW = layout.width - pad.left - pad.right;
  const plotH = layout.height - pad.top - pad.bottom;
  const { max: rawMax } = valueExtent(data);
  const max = niceMax(rawMax);
  const categories = data.labels.length;
  const lines: LinePath[] = [];
  if (categories === 0 || plotW <= 0 || plotH <= 0) {
    return { lines, max };
  }
  const step = categories === 1 ? 0 : plotW / (categories - 1);
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
      const x = pad.left + (categories === 1 ? plotW / 2 : ci * step);
      const y = pad.top + (plotH - (v / max) * plotH);
      points.push({ x, y });
      current.push(`${x},${y}`);
    }
    if (current.length > 0) segments.push(current.join(" "));
    lines.push({ seriesIndex: si, segments, points });
  });
  return { lines, max };
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
 * Lay out a pie from the FIRST series' values (blanks / non-positive
 * values are dropped). Slices start at 12 o'clock and proceed
 * clockwise. Returns an empty array when nothing sums above zero.
 */
export function pieLayout(
  data: ChartData,
  cx: number,
  cy: number,
  r: number,
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
    const p1 = polar(cx, cy, r, start);
    const p2 = polar(cx, cy, r, end);
    const largeArc = end - start > Math.PI ? 1 : 0;
    // A single full-circle slice can't be drawn with one arc (start ==
    // end); emit a near-complete circle via two half-arcs.
    const path =
      fraction >= 1
        ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.001} ${cy - r} Z`
        : `M ${cx} ${cy} L ${p1.x} ${p1.y} A ${r} ${r} 0 ${largeArc} 1 ${p2.x} ${p2.y} Z`;
    slices.push({
      categoryIndex: ci,
      value: v,
      fraction,
      startAngle: start,
      endAngle: end,
      path,
    });
  });
  return slices;
}

export const CHART_PAD = DEFAULT_PAD;
