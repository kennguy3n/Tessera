/**
 * Pure structural edits (insert / remove a column or row) for the
 * `SheetEditor`.
 *
 * The grid carries column- and row-indexed metadata — per-cell
 * `formats` (`"row,col"` keys), column-scoped `validations` (`"col"`
 * keys), `conditionalRules` (a `column` index), `columnWidths`,
 * `rowHeights`, and the `frozenRows`/`frozenCols` counts. Naively
 * splicing `columns`/`rows` while leaving that metadata untouched both
 * (a) drops fields that aren't explicitly carried over and (b) leaves
 * surviving entries keyed to the wrong index once everything after the
 * edit point shifts.
 *
 * These helpers do the full remap in one place so every caller stays
 * consistent and the logic is unit-testable without React. They always
 * return a fresh `SheetContent`, preserving any unrelated fields
 * (`sheets`, `activeSheetIndex`, `namedRanges`, `charts`, …) via spread.
 *
 * Out of scope (documented limitation): A1 string references inside
 * `namedRanges` and `charts` are NOT rewritten when a column/row is
 * inserted or removed — matching the fact that those features bind to
 * textual ranges the user authored. A future pass could shift / `#REF!`
 * them the way Excel does.
 */
import type {
  CellFormat,
  ConditionalFormatRule,
  DataValidation,
  SheetContent,
  ValidationMap,
} from "./sheetEditorTypes";

/** Remap a `"row,col"` format map under a column edit. */
function remapFormatsForColumn(
  formats: Record<string, CellFormat> | undefined,
  at: number,
  delta: 1 | -1,
): Record<string, CellFormat> | undefined {
  if (!formats) return undefined;
  const next: Record<string, CellFormat> = {};
  for (const [key, fmt] of Object.entries(formats)) {
    const comma = key.indexOf(",");
    const row = Number(key.slice(0, comma));
    const col = Number(key.slice(comma + 1));
    if (!Number.isInteger(row) || !Number.isInteger(col)) continue;
    if (delta === -1 && col === at) continue; // removed column's cells
    const newCol = col >= at ? col + delta : col;
    next[`${row},${newCol}`] = fmt;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

/** Remap a `"row,col"` format map under a row edit. */
function remapFormatsForRow(
  formats: Record<string, CellFormat> | undefined,
  at: number,
  delta: 1 | -1,
): Record<string, CellFormat> | undefined {
  if (!formats) return undefined;
  const next: Record<string, CellFormat> = {};
  for (const [key, fmt] of Object.entries(formats)) {
    const comma = key.indexOf(",");
    const row = Number(key.slice(0, comma));
    const col = Number(key.slice(comma + 1));
    if (!Number.isInteger(row) || !Number.isInteger(col)) continue;
    if (delta === -1 && row === at) continue; // removed row's cells
    const newRow = row >= at ? row + delta : row;
    next[`${newRow},${col}`] = fmt;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

/** Remap the column-keyed validation map under a column edit. */
function remapValidations(
  validations: ValidationMap | undefined,
  at: number,
  delta: 1 | -1,
): ValidationMap | undefined {
  if (!validations) return undefined;
  const next: ValidationMap = {};
  for (const [key, rule] of Object.entries(validations)) {
    const col = Number(key);
    if (!Number.isInteger(col)) continue;
    if (delta === -1 && col === at) continue; // removed column's rule
    const newCol = col >= at ? col + delta : col;
    next[String(newCol)] = rule as DataValidation;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

/** Remap conditional rules' `column` targets under a column edit. */
function remapConditionalRules(
  rules: ConditionalFormatRule[] | undefined,
  at: number,
  delta: 1 | -1,
): ConditionalFormatRule[] | undefined {
  if (!rules) return undefined;
  const next: ConditionalFormatRule[] = [];
  for (const rule of rules) {
    if (rule.column === null) {
      next.push(rule); // applies to all columns — unaffected
      continue;
    }
    if (delta === -1 && rule.column === at) continue; // target removed
    const newCol = rule.column >= at ? rule.column + delta : rule.column;
    next.push(newCol === rule.column ? rule : { ...rule, column: newCol });
  }
  return next.length === 0 ? undefined : next;
}

/** Splice a sparse pixel-size array (widths / heights). */
function spliceSizes(
  sizes: (number | undefined)[] | undefined,
  at: number,
  delta: 1 | -1,
): (number | undefined)[] | undefined {
  if (!sizes) return undefined;
  const next = [...sizes];
  if (delta === -1) next.splice(at, 1);
  else next.splice(at, 0, undefined);
  // Drop a trailing all-undefined tail so an unset sheet stays compact.
  while (next.length > 0 && next[next.length - 1] === undefined) next.pop();
  return next.length === 0 ? undefined : next;
}

/** Adjust a frozen-count when an index at/before the freeze edge changes. */
function adjustFreeze(
  count: number | undefined,
  at: number,
  delta: 1 | -1,
): number | undefined {
  const n = count ?? 0;
  if (n === 0) return count;
  // Only edits strictly inside the frozen region change its size.
  if (at < n) {
    const next = n + delta;
    return next > 0 ? next : undefined;
  }
  return count;
}

/** Strip a field from an object when the value is `undefined`. */
function withField<K extends keyof SheetContent>(
  target: SheetContent,
  key: K,
  value: SheetContent[K] | undefined,
): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

/**
 * Remove the column at `colIdx`, remapping every column-indexed field.
 * Returns the content unchanged when it would empty the grid (always
 * keep at least one column).
 */
export function removeColumnAt(
  content: SheetContent,
  colIdx: number,
): SheetContent {
  if (colIdx < 0 || colIdx >= content.columns.length) return content;
  if (content.columns.length <= 1) return content;
  const next: SheetContent = { ...content };
  next.columns = content.columns.filter((_, i) => i !== colIdx);
  next.rows = content.rows.map((r) => r.filter((_, i) => i !== colIdx));
  withField(next, "formats", remapFormatsForColumn(content.formats, colIdx, -1));
  withField(next, "validations", remapValidations(content.validations, colIdx, -1));
  withField(
    next,
    "conditionalRules",
    remapConditionalRules(content.conditionalRules, colIdx, -1),
  );
  withField(next, "columnWidths", spliceSizes(content.columnWidths, colIdx, -1));
  withField(next, "frozenCols", adjustFreeze(content.frozenCols, colIdx, -1));
  return next;
}

/**
 * Insert a new column at `colIdx` (use `content.columns.length` to
 * append), shifting every column-indexed field at or after it. The new
 * column starts blank.
 */
export function insertColumnAt(
  content: SheetContent,
  colIdx: number,
  label: string,
): SheetContent {
  const clamped = Math.max(0, Math.min(colIdx, content.columns.length));
  const next: SheetContent = { ...content };
  next.columns = [
    ...content.columns.slice(0, clamped),
    label,
    ...content.columns.slice(clamped),
  ];
  next.rows = content.rows.map((r) => {
    const copy = [...r];
    copy.splice(clamped, 0, "");
    return copy;
  });
  withField(next, "formats", remapFormatsForColumn(content.formats, clamped, 1));
  withField(next, "validations", remapValidations(content.validations, clamped, 1));
  withField(
    next,
    "conditionalRules",
    remapConditionalRules(content.conditionalRules, clamped, 1),
  );
  withField(next, "columnWidths", spliceSizes(content.columnWidths, clamped, 1));
  withField(next, "frozenCols", adjustFreeze(content.frozenCols, clamped, 1));
  return next;
}

/** Remove the row at `rowIdx`, remapping every row-indexed field. */
export function removeRowAt(
  content: SheetContent,
  rowIdx: number,
): SheetContent {
  if (rowIdx < 0 || rowIdx >= content.rows.length) return content;
  const next: SheetContent = { ...content };
  next.rows = content.rows.filter((_, i) => i !== rowIdx);
  withField(next, "formats", remapFormatsForRow(content.formats, rowIdx, -1));
  withField(next, "rowHeights", spliceSizes(content.rowHeights, rowIdx, -1));
  withField(next, "frozenRows", adjustFreeze(content.frozenRows, rowIdx, -1));
  return next;
}

/** Insert a blank row at `rowIdx` (use `content.rows.length` to append). */
export function insertRowAt(
  content: SheetContent,
  rowIdx: number,
): SheetContent {
  const clamped = Math.max(0, Math.min(rowIdx, content.rows.length));
  const next: SheetContent = { ...content };
  const blank = new Array(content.columns.length).fill("");
  next.rows = [
    ...content.rows.slice(0, clamped),
    blank,
    ...content.rows.slice(clamped),
  ];
  withField(next, "formats", remapFormatsForRow(content.formats, clamped, 1));
  withField(next, "rowHeights", spliceSizes(content.rowHeights, clamped, 1));
  withField(next, "frozenRows", adjustFreeze(content.frozenRows, clamped, 1));
  return next;
}
