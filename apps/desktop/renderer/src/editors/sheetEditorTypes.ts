/**
 * Pure type declarations for `SheetEditor` and its companion modules.
 *
 * Lives in a third file (neither the component file nor the helpers
 * file) so the component and helpers can each import these types
 * directly without creating a runtime cycle. Compile-time-erased
 * declarations only — no value-level code lives here, by design.
 */

/**
 * Phase 15 Task 14: a workbook-level named range. The `name` is the
 * identifier the user (or a formula like `=SUM(Revenue)`) references;
 * `range` is an A1-style cell reference matching the XLSX defined-names
 * spec (e.g. `Sheet1!$B$2:$B$10` or `Sheet1!$A$1`).
 *
 * The struct is serialised to JSON 1:1 so the Rust XLSX exporter can
 * round-trip it via serde — see `tessera_export::xlsx::SheetContent`.
 * Adding optional fields here later must keep the serde struct in sync.
 */
export interface SheetNamedRange {
  name: string;
  range: string;
}

/**
 * Phase 16 Task 14 — per-cell display formatting. Stored separately
 * from the cell's raw text so a `=A1+B1` formula keeps its computed
 * value while the cell renders it as `$1,234.56` or bold-red, etc.
 *
 * Every field is optional — an absent field means "inherit the
 * default" (left-aligned plain text). The renderer applies only the
 * fields that are present.
 */
export interface CellFormat {
  /** Number-format string in the `TEXT()` mini-language */
  numberFormat?: string;
  /** Horizontal alignment override. */
  align?: "left" | "center" | "right";
  /** Bold text. */
  bold?: boolean;
  /** Italic text. */
  italic?: boolean;
  /** Underline text. */
  underline?: boolean;
  /** CSS-compatible foreground colour (`#RRGGBB`). */
  color?: string;
  /** CSS-compatible cell background (`#RRGGBB`). */
  background?: string;
}

/**
 * Phase 16 Task 13 — a single worksheet within a multi-sheet
 * workbook. Backward compatible: the legacy single-sheet
 * `SheetContent` (just `columns`/`rows`) parses into a workbook of
 * one `SheetTab` named "Sheet1".
 */
export interface SheetTab {
  /** Display name; must be unique within the workbook. */
  name: string;
  /** Column header labels (Excel-letter style, A/B/C/...). */
  columns: string[];
  /** Row × column raw cell text. Formulas start with `=`. */
  rows: string[][];
  /**
   * Optional per-cell formatting (Phase 16 Task 14). Keys are
   * `"row,col"` strings; missing entries render plain.
   */
  formats?: Record<string, CellFormat>;
}

export interface SheetContent {
  /**
   * Active sheet's column headers. Required for backward
   * compatibility with all pre-Phase-16 artifacts and the XLSX
   * exporter; mirrors `sheets[activeSheetIndex].columns` when
   * `sheets` is present.
   */
  columns: string[];
  /**
   * Active sheet's row data. Required for backward compatibility;
   * mirrors `sheets[activeSheetIndex].rows` when `sheets` is
   * present.
   */
  rows: string[][];
  /**
   * Phase 16 Task 13 — full multi-sheet workbook. When omitted,
   * the artifact has a single implicit sheet named "Sheet1"
   * containing `columns`/`rows`.
   */
  sheets?: SheetTab[];
  /**
   * Index into `sheets` for the currently-active worksheet.
   * Defaults to `0`. Ignored when `sheets` is absent.
   */
  activeSheetIndex?: number;
  /**
   * Phase 16 Task 14 — per-cell formats for the active (legacy)
   * sheet. When `sheets` is present, prefer the per-sheet
   * `SheetTab.formats` instead. Both are honoured on read for
   * forward-compatibility with documents that store the active
   * sheet's formats at both locations.
   */
  formats?: Record<string, CellFormat>;
  /**
   * Phase 15 Task 14: optional workbook-level named ranges. Persisted on
   * the artifact JSON so the XLSX exporter can emit `<definedName>`
   * entries; the renderer-side Sheet editor does NOT currently surface
   * these to the user (a future task), but the JSON schema is forward-
   * compatible: producers may omit the field entirely (treated as no
   * named ranges), consumers must tolerate missing or empty arrays.
   */
  namedRanges?: SheetNamedRange[];
}
