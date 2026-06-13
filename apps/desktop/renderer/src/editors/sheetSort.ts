/**
 * Pure row-sorting logic for the `SheetEditor`.
 *
 * Sorting reorders whole data rows by a key column, matching Google
 * Sheets' "Sort sheet by column A → Z / Z → A". Keeping every cell of
 * a row together (all columns move as a unit) is what users expect for
 * a data table and means per-cell formats only need their *row*
 * component remapped — the column is unchanged.
 *
 * The comparison is type-aware:
 *   - blank cells always sort last, in both directions (Sheets rule);
 *   - two numbers compare numerically;
 *   - a number sorts before text (ascending);
 *   - two strings use a locale, numeric-aware, case-insensitive
 *     comparison so `item2` precedes `item10`.
 *
 * Formulas are compared by the value the caller supplies through
 * `valueAt` (the editor passes each cell's *displayed* result), so a
 * column of `=…` formulas sorts by what the user sees rather than by
 * raw formula text. The raw cell strings are what actually move, so
 * formulas are preserved verbatim.
 *
 * Kept dependency-free and synchronous so it unit-tests in isolation
 * and the React component stays a thin caller.
 */
import type { CellFormat } from "./sheetEditorTypes";

/** Whether a cell's text counts as blank for sort purposes. */
function isBlank(value: string): boolean {
  return value.trim() === "";
}

/** Parse a cell as a finite number, or `null` when it is not numeric. */
function asNumber(value: string): number | null {
  const t = value.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compare two non-blank cell values in ascending order. Numbers sort
 * before text; two numbers compare numerically; two strings use a
 * locale, numeric-aware, case-insensitive comparison. Exported for
 * direct unit testing.
 */
export function compareNonBlank(a: string, b: string): number {
  const an = asNumber(a);
  const bn = asNumber(b);
  if (an !== null && bn !== null) return an - bn;
  if (an !== null) return -1;
  if (bn !== null) return 1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export interface SortResult {
  /** Rows in their new order. */
  rows: string[][];
  /** Remapped per-cell formats, or `undefined` when none were given. */
  formats?: Record<string, CellFormat>;
  /**
   * Per-row heights permuted to follow their data row, or `undefined`
   * when none were given. A custom height set on a row travels with that
   * row exactly as its formats do, so the two never drift apart.
   */
  rowHeights?: (number | undefined)[];
}

/**
 * Return the row permutation that sorts `rows` by `col`. Exposed so the
 * caller (and tests) can reason about the move without materialising
 * new arrays. The result is a stable order: rows comparing equal keep
 * their original relative position, and blanks are pushed to the end
 * regardless of `ascending`.
 *
 * `valueAt(row)` supplies the comparison key for a row's key column;
 * it defaults to the raw cell text but lets the editor pass an
 * evaluated/displayed value for formula cells.
 */
export function sortOrder(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  col: number,
  ascending: boolean,
  valueAt?: (row: number) => string,
): number[] {
  const key = valueAt ?? ((row: number) => rows[row]?.[col] ?? "");
  const order = rows.map((_, i) => i);
  order.sort((i, j) => {
    const a = key(i);
    const b = key(j);
    const aBlank = isBlank(a);
    const bBlank = isBlank(b);
    if (aBlank && bBlank) return i - j;
    if (aBlank) return 1;
    if (bBlank) return -1;
    const cmp = compareNonBlank(a, b);
    const directed = ascending ? cmp : -cmp;
    return directed !== 0 ? directed : i - j;
  });
  return order;
}

/**
 * Sort every data row of `rows` by `col`, moving whole rows (all
 * columns) and remapping `formats` so each cell's format follows its
 * row. Returns fresh arrays/maps and never mutates the inputs.
 */
export function sortSheetByColumn(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  formats: Record<string, CellFormat> | undefined,
  col: number,
  ascending: boolean,
  valueAt?: (row: number) => string,
  rowHeights?: ReadonlyArray<number | undefined>,
): SortResult {
  const order = sortOrder(rows, col, ascending, valueAt);
  const nextRows = order.map((orig) => [...rows[orig]]);
  const result: SortResult = { rows: nextRows };

  // Permute per-row heights so a custom height stays attached to the
  // data row it was set on (the height at original row `orig` lands at
  // its new index). Holes are preserved as `undefined`. Trailing holes
  // are trimmed so an all-default array round-trips to `undefined`.
  if (rowHeights && rowHeights.some((h) => h !== undefined)) {
    const moved = order.map((orig) => rowHeights[orig]);
    let end = moved.length;
    while (end > 0 && moved[end - 1] === undefined) end -= 1;
    if (end > 0) result.rowHeights = moved.slice(0, end);
  }

  if (!formats || Object.keys(formats).length === 0) {
    return result;
  }

  // origRow -> newRow, so a format at "origRow,c" moves to "newRow,c".
  const newRowOf = new Map<number, number>();
  order.forEach((orig, idx) => newRowOf.set(orig, idx));

  const nextFormats: Record<string, CellFormat> = {};
  for (const [k, v] of Object.entries(formats)) {
    const comma = k.indexOf(",");
    const r = Number(k.slice(0, comma));
    const c = k.slice(comma + 1);
    const nr = newRowOf.get(r) ?? r;
    nextFormats[`${nr},${c}`] = v;
  }
  result.formats = nextFormats;
  return result;
}
