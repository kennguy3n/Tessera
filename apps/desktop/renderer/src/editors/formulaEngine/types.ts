/**
 * Phase 16 — formula-engine shared types.
 *
 * Pure type declarations only (no runtime exports). Lives in its own
 * file so the tokenizer / parser / evaluator / dependency graph / function
 * modules can each import them directly without forming a runtime cycle
 * with one another.
 *
 * Excel-compatible error sentinels are exported as a discriminated union
 * (`FormulaError`) and as a `FormulaErrorCode` string set. Cell values
 * that flow through the evaluator are represented as
 * `number | string | boolean | null | FormulaError` — `null` represents
 * an empty cell (not yet evaluated / blank in the grid), distinct from
 * the empty string `""` (which is a valid user-entered text value).
 */

/** Excel/Google-Sheets-style error codes. */
export const FORMULA_ERROR_CODES = [
  "#ERR!",
  "#REF!",
  "#NAME?",
  "#VALUE!",
  "#DIV/0!",
  "#NUM!",
  "#N/A",
  "#CIRCULAR!",
] as const;

export type FormulaErrorCode = (typeof FORMULA_ERROR_CODES)[number];

export interface FormulaError {
  /** Discriminator for `FormulaValue`. */
  readonly kind: "error";
  /** Excel-style sentinel string the user sees in the cell. */
  readonly code: FormulaErrorCode;
  /** Human-readable diagnostic (logged / shown on hover). */
  readonly message: string;
}

export function makeError(
  code: FormulaErrorCode,
  message: string,
): FormulaError {
  return { kind: "error", code, message };
}

export function isFormulaError(value: unknown): value is FormulaError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "error" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

/** A single resolved cell value. `null` represents a blank cell. */
export type FormulaValue =
  | number
  | string
  | boolean
  | null
  | FormulaError;

/** Zero-based cell coordinate. */
export interface CellRef {
  readonly row: number;
  readonly col: number;
}

/** Cell reference with absolute/relative qualifiers (`$A$1`, `A$1`, etc.). */
export interface CellRefNode extends CellRef {
  readonly absoluteCol: boolean;
  readonly absoluteRow: boolean;
}

/**
 * A 2-D range over the active grid. Both endpoints are zero-based and
 * inclusive. `start.row <= end.row` and `start.col <= end.col` are
 * normalised by the parser so the evaluator never has to sort.
 */
export interface RangeRef {
  readonly start: CellRefNode;
  readonly end: CellRefNode;
}

/**
 * The evaluator reads cell values through this interface so it stays
 * independent of the React state shape and lets the upcoming
 * cross-sheet / base-formula features inject their own resolvers
 * (e.g. multi-sheet workbook, base-record field references).
 */
export interface CellResolver {
  /** Look up the raw text of a cell at `(row, col)`. */
  getRaw(row: number, col: number): string | undefined;
  /**
   * Return the currently-cached evaluated value of a cell, or `null`
   * if the cell is blank. The evaluator calls this for references
   * inside a formula; cells whose own evaluation is still in
   * progress are how circular references are detected (see
   * `EvaluationContext.visiting`).
   */
  getEvaluated(row: number, col: number): FormulaValue;
}
