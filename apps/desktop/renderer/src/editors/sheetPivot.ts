/**
 * Pure pivot-table logic for the `SheetEditor`.
 *
 * A pivot binds to an A1 source range whose first row is a header, then
 * cross-tabulates the rows by a chosen row field (and an optional column
 * field), aggregating a value field with one of a small set of functions
 * (sum / count / average / min / max). Like charts, a pivot is re-derived
 * from live cell values on every render — formulas resolve through the
 * caller-supplied accessors, so a pivot over `=B2*1.1` tracks the
 * computed result, not the formula text.
 *
 * This module owns the (pure, dependency-free, unit-tested) work:
 *   - aggregate the records into a cross-tab matrix with margins,
 *   - shift the field/range references under structural grid edits.
 *
 * The React layer (`PivotPanel`, `SheetPivot`) is a thin shell that
 * feeds these helpers `valueAt`/`textAt` accessors and renders the
 * returned grid. Keeping it framework-free means the maths is testable
 * in isolation and there is no pivot dependency to audit.
 */
import {
  columnLetter,
  formatA1Range,
  parseA1Range,
  shiftRangeForStructuralEdit,
  type NumericValueAt,
  type RangeRect,
  type TextValueAt,
} from "./sheetCharts";
import type { PivotAggregation, PivotSpec } from "./sheetEditorTypes";

/** Label shown for records whose group-field cell is empty. */
export const PIVOT_BLANK_LABEL = "(blank)";
/** Header used for the single column when a pivot has no column field. */
export const PIVOT_TOTAL_LABEL = "Total";

/** Human-readable name for each aggregation, used in headers and the UI. */
export const PIVOT_AGG_LABELS: Record<PivotAggregation, string> = {
  sum: "Sum",
  count: "Count",
  average: "Average",
  min: "Min",
  max: "Max",
};

/**
 * A fully-computed pivot ready to render: distinct row/column group
 * labels (in first-seen order), the aggregated value matrix, and the
 * row / column / grand margins. A `null` matrix or margin cell means the
 * bucket has no data to aggregate (rendered blank).
 */
export interface PivotResult {
  rowLabels: string[];
  colLabels: string[];
  /** `matrix[r][c]` aligns with `rowLabels[r]` / `colLabels[c]`. */
  matrix: (number | null)[][];
  rowTotals: (number | null)[];
  colTotals: (number | null)[];
  grandTotal: number | null;
  /** Header label of the row field (from the source range's header row). */
  rowFieldName: string;
  /** Header label of the column field, or `undefined` when single-column. */
  colFieldName?: string;
  /** Header label of the value field. */
  valueFieldName: string;
  agg: PivotAggregation;
}

/** Mutable per-bucket accumulator: numeric values plus a populated count. */
interface Bucket {
  values: number[];
  /** Records whose value-field cell was non-empty (drives `count`). */
  count: number;
}

function emptyBucket(): Bucket {
  return { values: [], count: 0 };
}

/** Apply an aggregation to a bucket; `null` when there is nothing to show. */
function aggregate(agg: PivotAggregation, b: Bucket | undefined): number | null {
  if (!b) return null;
  if (agg === "count") return b.count;
  if (b.values.length === 0) return null;
  switch (agg) {
    case "sum":
      return b.values.reduce((a, v) => a + v, 0);
    case "average":
      return b.values.reduce((a, v) => a + v, 0) / b.values.length;
    case "min":
      // Reduce rather than `Math.min(...b.values)`: a single bucket can, in
      // the worst case, hold every data row, and the argument-spread form has
      // a JS engine cap (~65K args in V8) that would throw on very large
      // sheets. The fold is O(n) with no argument-count ceiling.
      return b.values.reduce((a, v) => (v < a ? v : a), b.values[0]);
    case "max":
      return b.values.reduce((a, v) => (v > a ? v : a), b.values[0]);
    default:
      return null;
  }
}

/**
 * Push one record's value into a bucket: a finite number contributes to
 * the numeric aggregations, and any non-empty cell contributes to the
 * record `count` (mirroring a spreadsheet pivot's COUNTA-style count).
 */
function pushRecord(b: Bucket, value: number | null, nonEmpty: boolean): void {
  if (value !== null) b.values.push(value);
  if (nonEmpty) b.count += 1;
}

/** Resolve a header label for a grid column, falling back to its letter. */
function headerLabel(textAt: TextValueAt, headerRow: number, col: number): string {
  const text = textAt(headerRow, col).trim();
  return text !== "" ? text : columnLetter(col);
}

/**
 * Cross-tabulate the source range into a {@link PivotResult}. Returns
 * `null` only when the range itself is unparseable; an in-range field
 * index that points outside the range, or a range with no data rows,
 * yields an empty-but-valid result so the renderer can show its empty
 * state rather than crash.
 *
 * Group labels preserve first-seen order (stable, not alphabetic) so the
 * pivot reflects the source ordering — matching user expectation for
 * already-sorted data. The pass is O(records): each data row touches its
 * cell bucket and the row / column / grand accumulators exactly once.
 */
export function computePivot(
  spec: PivotSpec,
  valueAt: NumericValueAt,
  textAt: TextValueAt,
): PivotResult | null {
  const rect = parseA1Range(spec.range);
  if (!rect) return null;

  const headerRow = rect.r1;
  const rowFieldName = headerLabel(textAt, headerRow, spec.rowField);
  const valueFieldName = headerLabel(textAt, headerRow, spec.valueField);
  const hasColField =
    spec.colField !== undefined &&
    spec.colField >= rect.c1 &&
    spec.colField <= rect.c2;
  const colFieldName = hasColField
    ? headerLabel(textAt, headerRow, spec.colField as number)
    : undefined;

  const base: PivotResult = {
    rowLabels: [],
    colLabels: hasColField ? [] : [PIVOT_TOTAL_LABEL],
    matrix: [],
    rowTotals: [],
    colTotals: [],
    grandTotal: null,
    rowFieldName,
    valueFieldName,
    agg: spec.agg,
  };
  if (colFieldName !== undefined) base.colFieldName = colFieldName;

  // A field index outside the range, or no data rows, → empty result.
  const fieldsInRange =
    spec.rowField >= rect.c1 &&
    spec.rowField <= rect.c2 &&
    spec.valueField >= rect.c1 &&
    spec.valueField <= rect.c2;
  if (!fieldsInRange || headerRow + 1 > rect.r2) return base;

  const rowIndex = new Map<string, number>();
  const colIndex = new Map<string, number>();
  if (!hasColField) colIndex.set(PIVOT_TOTAL_LABEL, 0);

  const cellBuckets: Bucket[][] = [];
  const rowBuckets: Bucket[] = [];
  const colBuckets: Bucket[] = hasColField ? [] : [emptyBucket()];
  const grand = emptyBucket();

  const internRow = (label: string): number => {
    let i = rowIndex.get(label);
    if (i === undefined) {
      i = rowIndex.size;
      rowIndex.set(label, i);
      base.rowLabels.push(label);
      rowBuckets.push(emptyBucket());
      cellBuckets.push([]);
    }
    return i;
  };
  const internCol = (label: string): number => {
    if (!hasColField) return 0;
    let i = colIndex.get(label);
    if (i === undefined) {
      i = colIndex.size;
      colIndex.set(label, i);
      base.colLabels.push(label);
      colBuckets.push(emptyBucket());
    }
    return i;
  };

  for (let r = headerRow + 1; r <= rect.r2; r++) {
    const rowLabel = textAt(r, spec.rowField).trim() || PIVOT_BLANK_LABEL;
    const colLabel = hasColField
      ? textAt(r, spec.colField as number).trim() || PIVOT_BLANK_LABEL
      : PIVOT_TOTAL_LABEL;
    const ri = internRow(rowLabel);
    const ci = internCol(colLabel);
    const value = valueAt(r, spec.valueField);
    const nonEmpty = textAt(r, spec.valueField).trim() !== "";

    let cell = cellBuckets[ri][ci];
    if (!cell) {
      cell = emptyBucket();
      cellBuckets[ri][ci] = cell;
    }
    pushRecord(cell, value, nonEmpty);
    pushRecord(rowBuckets[ri], value, nonEmpty);
    pushRecord(colBuckets[ci], value, nonEmpty);
    pushRecord(grand, value, nonEmpty);
  }

  const colCount = base.colLabels.length;
  base.matrix = base.rowLabels.map((_, ri) => {
    const cells = cellBuckets[ri];
    return Array.from({ length: colCount }, (_, ci) =>
      aggregate(spec.agg, cells[ci]),
    );
  });
  base.rowTotals = base.rowLabels.map((_, ri) =>
    aggregate(spec.agg, rowBuckets[ri]),
  );
  base.colTotals = base.colLabels.map((_, ci) =>
    aggregate(spec.agg, colBuckets[ci]),
  );
  base.grandTotal = aggregate(spec.agg, grand);
  return base;
}

/** True when the pivot produced at least one row group to display. */
export function hasPivotData(result: PivotResult | null): boolean {
  return result !== null && result.rowLabels.length > 0;
}

/**
 * True when a structural edit removed a column one of the pivot's *required*
 * fields pointed at, leaving the `-1` sentinel {@link shiftPivotForStructuralEdit}
 * assigns. Such a pivot can't be computed until the user re-points it, so the
 * UI distinguishes this from an ordinary "no data" range and prompts a fix.
 * (An optional `colField` is dropped outright when removed, so only the
 * mandatory `rowField` / `valueField` can carry the sentinel.)
 */
export function pivotHasRemovedField(spec: PivotSpec): boolean {
  return spec.rowField < 0 || spec.valueField < 0;
}

/**
 * Shift a pivot's range and its field column indices under a column/row
 * insert or removal, keeping the references aligned with the data the
 * way {@link shiftRangeForStructuralEdit} does for charts. A field whose
 * column is removed (or whose range collapses) is marked invalid with
 * the `-1` sentinel so the renderer falls back to its empty state.
 */
export function shiftPivotForStructuralEdit(
  spec: PivotSpec,
  axis: "row" | "col",
  at: number,
  delta: 1 | -1,
): PivotSpec {
  const range = shiftRangeForStructuralEdit(spec.range, axis, at, delta);
  // Row edits never move column-keyed fields; only the range row extent.
  if (axis === "row") {
    return range === spec.range ? spec : { ...spec, range };
  }
  const shiftCol = (col: number): number => {
    if (col < 0) return col; // already invalid
    if (delta === 1) return col >= at ? col + 1 : col;
    if (col === at) return -1; // this column was removed
    return col > at ? col - 1 : col;
  };
  const next: PivotSpec = {
    ...spec,
    range,
    rowField: shiftCol(spec.rowField),
    valueField: shiftCol(spec.valueField),
  };
  if (spec.colField !== undefined) {
    const c = shiftCol(spec.colField);
    if (c < 0) delete next.colField;
    else next.colField = c;
  }
  return next;
}

/** Re-export so callers can build/serialise ranges without two imports. */
export { formatA1Range, parseA1Range, type RangeRect };
