/**
 * Pure type declarations for `SheetEditor` and its companion modules.
 *
 * Lives in a third file (neither the component file nor the helpers
 * file) so the component and helpers can each import these types
 * directly without creating a runtime cycle. Compile-time-erased
 * declarations only — no value-level code lives here, by design.
 */

/**
 * a workbook-level named range. The `name` is the
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
 * per-cell display formatting. Stored separately
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
 * A column-scoped data-validation rule. `list` constrains a cell to a
 * fixed set of values (rendered as a dropdown); `checkbox` constrains
 * it to `TRUE`/`FALSE` (rendered as a checkbox). A blank cell always
 * satisfies a rule — validation constrains entered values, it does not
 * force a value.
 *
 * Serialised 1:1 to JSON so the artifact round-trips through
 * `parseSheetContent`/`JSON.stringify`; producers may omit it and
 * consumers must tolerate it being absent.
 */
export type DataValidation =
  | { kind: "list"; values: string[] }
  | { kind: "checkbox" };

/**
 * Column-index → validation map. Keys are the zero-based column index
 * stringified (`"2"`), matching the sparse-keying style used elsewhere
 * in this module. Absent ⇒ the column accepts any value.
 */
export type ValidationMap = Record<string, DataValidation>;

/**
 * Comparison operators a conditional-formatting rule can test a cell's
 * value against. Numeric operators (`gt`/`gte`/`lt`/`lte`) coerce both
 * sides to numbers and never match non-numeric cells; the text
 * operators compare the cell's displayed string. `isEmpty`/`notEmpty`
 * ignore the rule's `value` entirely.
 */
export type ConditionalOperator =
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "eq"
  | "neq"
  | "contains"
  | "notContains"
  | "isEmpty"
  | "notEmpty";

/**
 * A single rule-based cell-styling rule. Rules are evaluated against a
 * cell's *displayed* value (formulas use their computed result), and
 * every matching rule's style is merged onto the cell in array order
 * (later rules win on conflicting properties — a deterministic cascade).
 *
 * `column` scopes the rule to one column by zero-based index; `null`
 * (the default) applies the rule across every column. The `style`
 * reuses the same visual subset of `CellFormat` so the renderer can
 * funnel it through the existing `cellFormatStyle` translator.
 */
export interface ConditionalFormatRule {
  /** Stable id used as the React key and for edit/delete targeting. */
  id: string;
  /** Zero-based column index this rule targets, or `null` for all. */
  column: number | null;
  /** The comparison to perform. */
  operator: ConditionalOperator;
  /** Right-hand operand (ignored by `isEmpty`/`notEmpty`). */
  value: string;
  /** Visual styling applied to a matching cell. */
  style: ConditionalRuleStyle;
}

/**
 * The visual-only slice of {@link CellFormat} a conditional rule may
 * set. Number formatting is intentionally excluded — conditional rules
 * change appearance, not how a value is parsed/serialised.
 *
 * Derived via `Pick` rather than re-declared so it stays compiler-bound
 * to `CellFormat`: if a shared property's type ever changes there, this
 * follows automatically (and passing it to `cellFormatStyle`, which
 * takes `CellFormat`, can never silently drift out of shape).
 */
export type ConditionalRuleStyle = Pick<
  CellFormat,
  "bold" | "italic" | "underline" | "color" | "background"
>;

/**
 * a single worksheet within a multi-sheet
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
   * Optional per-cell formatting. Keys are
   * `"row,col"` strings; missing entries render plain.
   */
  formats?: Record<string, CellFormat>;
  /**
   * Optional rule-based conditional formatting evaluated against each
   * cell's displayed value. Omitted ⇒ no conditional styling.
   */
  conditionalRules?: ConditionalFormatRule[];
  /**
   * Optional column-scoped data-validation rules (dropdown / checkbox),
   * keyed by stringified column index. Omitted ⇒ no validation.
   */
  validations?: ValidationMap;
  /**
   * per-column pixel widths. Sparse: an entry of
   * `undefined` (or an index past the array end) means "use the
   * grid's default column width". Persisted so widths survive
   * reload.
   */
  columnWidths?: (number | undefined)[];
  /**
   * per-row pixel heights, sparse like
   * `columnWidths`.
   */
  rowHeights?: (number | undefined)[];
  /**
   * number of frozen rows from the top (header
   * row excluded). 0 / undefined means no freeze. Frozen rows stay
   * visible while the grid scrolls vertically.
   */
  frozenRows?: number;
  /**
   * number of frozen columns from the left.
   * 0 / undefined means no freeze.
   */
  frozenCols?: number;
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
   * full multi-sheet workbook. When omitted,
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
   * per-cell formats for the active (legacy)
   * sheet. When `sheets` is present, prefer the per-sheet
   * `SheetTab.formats` instead. Both are honoured on read for
   * forward-compatibility with documents that store the active
   * sheet's formats at both locations.
   */
  formats?: Record<string, CellFormat>;
  /**
   * Conditional-formatting rules for the active (legacy) sheet. Stored
   * at the top level so the single-sheet editor round-trips them
   * through plain `JSON.stringify`/`parseSheetContent`; absent ⇒ none.
   */
  conditionalRules?: ConditionalFormatRule[];
  /**
   * Data-validation rules for the active (legacy) sheet, keyed by
   * stringified column index. Stored at the top level so the
   * single-sheet editor round-trips them through plain
   * `JSON.stringify`/`parseSheetContent`; absent ⇒ none.
   */
  validations?: ValidationMap;
  /**
   * optional workbook-level named ranges. Persisted on
   * the artifact JSON so the XLSX exporter can emit `<definedName>`
   * entries; the renderer-side Sheet editor does NOT currently surface
   * these to the user (a future task), but the JSON schema is forward-
   * compatible: producers may omit the field entirely (treated as no
   * named ranges), consumers must tolerate missing or empty arrays.
   */
  namedRanges?: SheetNamedRange[];
  /**
   * Column widths on the legacy / active sheet. Mirrored to/from
   * `sheets[activeSheetIndex].columnWidths` when `sheets` is present.
   */
  columnWidths?: (number | undefined)[];
  /** Row heights, mirror of `columnWidths`. */
  rowHeights?: (number | undefined)[];
  /** Frozen rows on the legacy / active sheet. */
  frozenRows?: number;
  /** Frozen columns on the legacy / active sheet. */
  frozenCols?: number;
}
