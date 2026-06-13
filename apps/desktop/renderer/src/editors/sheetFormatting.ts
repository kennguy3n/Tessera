/**
 * Pure helpers for manual per-cell formatting (bold / italic /
 * underline / alignment / number format).
 *
 * The {@link CellFormat} type and the `applyCellFormat` / `cellFormatStyle`
 * renderers already existed, but nothing let a user *set* a manual
 * format and the grid never read `SheetContent.formats`. These helpers
 * own the (pure, tested) map manipulation; `SheetEditor` stays a thin
 * shell that calls them and persists the result.
 *
 * Format keys are `"row,col"` strings — identical to the unqualified
 * `cellKey(row, col)` shape documented on `SheetTab.formats`.
 */
import type { CellFormat } from "./sheetEditorTypes";
import type { CellCoord } from "./sheetSelection";

export type BoolFormatKey = "bold" | "italic" | "underline";

/** A selectable number-format preset surfaced in the toolbar. */
export interface NumberFormatPreset {
  id: string;
  label: string;
  /** `undefined` clears the number format (General). */
  pattern: string | undefined;
}

export const NUMBER_FORMAT_PRESETS: NumberFormatPreset[] = [
  { id: "general", label: "General", pattern: undefined },
  { id: "number", label: "Number (1,234.56)", pattern: "#,##0.00" },
  { id: "integer", label: "Integer (1,235)", pattern: "#,##0" },
  { id: "percent", label: "Percent (12.34%)", pattern: "0.00%" },
  { id: "currency", label: "Currency ($1,234.56)", pattern: "$#,##0.00" },
  { id: "date", label: "Date (2024-01-31)", pattern: "yyyy-mm-dd" },
];

/** `"row,col"` key for the per-cell format map. */
export function formatKey(row: number, col: number): string {
  return `${row},${col}`;
}

export function getCellFormat(
  formats: Record<string, CellFormat> | undefined,
  row: number,
  col: number,
): CellFormat | undefined {
  return formats?.[formatKey(row, col)];
}

/** True when a format carries no styling and can be dropped from the map. */
function isEmptyFormat(f: CellFormat): boolean {
  return (
    f.numberFormat === undefined &&
    f.align === undefined &&
    !f.bold &&
    !f.italic &&
    !f.underline &&
    f.color === undefined &&
    f.background === undefined
  );
}

/**
 * Normalise a format to its minimal stored shape: falsey booleans and
 * empty strings are dropped so two equivalent formats always serialise
 * identically (and an all-default format becomes `{}` → removed).
 */
function cleanFormat(f: CellFormat): CellFormat {
  const out: CellFormat = {};
  if (f.numberFormat) out.numberFormat = f.numberFormat;
  if (f.align) out.align = f.align;
  if (f.bold) out.bold = true;
  if (f.italic) out.italic = true;
  if (f.underline) out.underline = true;
  if (f.color) out.color = f.color;
  if (f.background) out.background = f.background;
  return out;
}

/**
 * Merge `patch` onto every cell in `cells`, returning a fresh map.
 * Setting a field to `undefined`/`false` clears it. A cell whose format
 * becomes empty is removed; an empty overall map collapses to
 * `undefined` so a sheet with no formats stays byte-identical to its
 * pre-feature JSON.
 */
export function applyFormatPatch(
  formats: Record<string, CellFormat> | undefined,
  cells: ReadonlyArray<CellCoord>,
  patch: Partial<CellFormat>,
): Record<string, CellFormat> | undefined {
  if (cells.length === 0) return formats;
  const next: Record<string, CellFormat> = { ...(formats ?? {}) };
  for (const { row, col } of cells) {
    const key = formatKey(row, col);
    const merged = cleanFormat({ ...next[key], ...patch });
    if (isEmptyFormat(merged)) delete next[key];
    else next[key] = merged;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

/** True iff every cell in the selection already has `key` set. */
export function allCellsHave(
  formats: Record<string, CellFormat> | undefined,
  cells: ReadonlyArray<CellCoord>,
  key: BoolFormatKey,
): boolean {
  if (cells.length === 0) return false;
  return cells.every(({ row, col }) => !!getCellFormat(formats, row, col)?.[key]);
}

/**
 * Toggle a boolean format across the selection. If every cell already
 * has it, clear it everywhere; otherwise set it everywhere — matching
 * the behaviour of a toolbar toggle in Sheets/Excel.
 */
export function toggleBoolFormat(
  formats: Record<string, CellFormat> | undefined,
  cells: ReadonlyArray<CellCoord>,
  key: BoolFormatKey,
): Record<string, CellFormat> | undefined {
  const turnOff = allCellsHave(formats, cells, key);
  return applyFormatPatch(formats, cells, { [key]: turnOff ? false : true });
}
