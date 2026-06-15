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
import { LOCALE_FORMAT_PRESETS } from "./localeNumberFormats";
import type { CellCoord } from "./sheetSelection";

export type BoolFormatKey = "bold" | "italic" | "underline";

/** A selectable number-format preset surfaced in the toolbar. */
export interface NumberFormatPreset {
  id: string;
  label: string;
  /** `undefined` clears the number format (General). */
  pattern: string | undefined;
  /**
   * Optional `<optgroup>` label. Ungrouped presets (the common formats)
   * render directly; grouped ones (locale currency / date) cluster under
   * their label. See {@link groupedNumberFormatPresets}.
   */
  group?: string;
}

// Curated presets covering the common Excel/Sheets formats. Patterns are
// expressed in the same grammar the engine (`formulaEngine/format.ts`)
// understands, so anything here is also a valid custom pattern. Negative
// sections (`…;(…)`) render negatives in parentheses; trailing commas scale
// by 1000 (thousands / millions); `@` is the text placeholder.
export const NUMBER_FORMAT_PRESETS: NumberFormatPreset[] = [
  { id: "general", label: "General", pattern: undefined },
  { id: "number", label: "Number (1,234.56)", pattern: "#,##0.00" },
  { id: "integer", label: "Integer (1,235)", pattern: "#,##0" },
  { id: "thousands", label: "Thousands (1,235K)", pattern: '#,##0,"K"' },
  { id: "millions", label: "Millions (1.2M)", pattern: '#,##0.0,,"M"' },
  { id: "percent", label: "Percent (12.34%)", pattern: "0.00%" },
  { id: "percent-int", label: "Percent (12%)", pattern: "0%" },
  { id: "currency", label: "Currency ($1,234.56)", pattern: "$#,##0.00" },
  { id: "currency-int", label: "Currency ($1,235)", pattern: "$#,##0" },
  {
    id: "accounting",
    label: "Accounting (1,234.56)",
    pattern: "#,##0.00;(#,##0.00)",
  },
  { id: "date", label: "Date (2024-01-31)", pattern: "yyyy-mm-dd" },
  { id: "date-us", label: "Date (1/31/2024)", pattern: "m/d/yyyy" },
  { id: "datetime", label: "Date time (2024-01-31 14:30)", pattern: "yyyy-mm-dd hh:mm" },
  { id: "time", label: "Time (14:30:00)", pattern: "hh:mm:ss" },
];

/**
 * The full preset menu: the curated common formats above followed by the
 * locale-aware currency + date presets (Deliverable 3). Kept separate
 * from {@link NUMBER_FORMAT_PRESETS} so the canonical base set — which a
 * formula-engine test renders exhaustively — stays stable, while the
 * grouped toolbar menu and the pattern reverse-lookup operate over
 * everything. Locale patterns never collide with a base pattern (each
 * carries a distinct currency symbol or date layout), so the reverse
 * lookup stays unambiguous.
 */
export const ALL_NUMBER_FORMAT_PRESETS: NumberFormatPreset[] = [
  ...NUMBER_FORMAT_PRESETS,
  ...LOCALE_FORMAT_PRESETS,
];

/** A cluster of presets sharing an `<optgroup>` label (or none). */
export interface NumberFormatPresetGroup {
  /** `undefined` for the ungrouped common presets. */
  label: string | undefined;
  presets: NumberFormatPreset[];
}

/**
 * Cluster presets by their `group`, preserving first-appearance order so
 * the ungrouped common formats stay on top and each locale group follows
 * in declaration order. Lets the toolbar render `<optgroup>`s without
 * duplicating the grouping logic.
 */
export function groupedNumberFormatPresets(
  presets: ReadonlyArray<NumberFormatPreset> = ALL_NUMBER_FORMAT_PRESETS,
): NumberFormatPresetGroup[] {
  const groups: NumberFormatPresetGroup[] = [];
  const byLabel = new Map<string | undefined, NumberFormatPresetGroup>();
  for (const preset of presets) {
    let group = byLabel.get(preset.group);
    if (!group) {
      group = { label: preset.group, presets: [] };
      byLabel.set(preset.group, group);
      groups.push(group);
    }
    group.presets.push(preset);
  }
  return groups;
}

/**
 * The pattern of a known preset, or `undefined` for General / unknown.
 * Used by the toolbar to keep the preset `<select>` and the custom-pattern
 * input in sync without duplicating the lookup.
 */
export function presetPattern(id: string): string | undefined {
  return ALL_NUMBER_FORMAT_PRESETS.find((p) => p.id === id)?.pattern;
}

/**
 * Resolve a number-format string to the matching preset id, or `"custom"`
 * when the cell carries a hand-entered pattern (and `"general"` when unset).
 */
export function presetIdForPattern(pattern: string | undefined): string {
  if (pattern === undefined || pattern === "") return "general";
  const hit = ALL_NUMBER_FORMAT_PRESETS.find((p) => p.pattern === pattern);
  return hit ? hit.id : "custom";
}

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
