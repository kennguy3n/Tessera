/**
 * Pure data-validation logic for the `SheetEditor`.
 *
 * A validation is attached to a whole column (matching the common
 * "this column is a status dropdown / a checkbox" case) and is keyed by
 * the column's zero-based index. Two kinds are supported, mirroring the
 * high-value Google Sheets rules:
 *
 *   - `list`     — the cell must hold one of a fixed set of values; the
 *                  editor renders it as a dropdown.
 *   - `checkbox` — the cell is `TRUE`/`FALSE`; the editor renders a
 *                  checkbox.
 *
 * Kept dependency-free so it unit-tests in isolation and the React
 * component stays a thin caller. All mutators are immutable and return
 * a fresh map (or `undefined` when the map empties) so a sheet with no
 * validations stays byte-identical to its pre-feature JSON.
 */
import type { DataValidation, ValidationMap } from "./sheetEditorTypes";

/** The two literal values a checkbox cell may hold (besides blank). */
export const CHECKBOX_TRUE = "TRUE";
export const CHECKBOX_FALSE = "FALSE";

/** Read the validation attached to a column, if any. */
export function getColumnValidation(
  validations: ValidationMap | undefined,
  col: number,
): DataValidation | undefined {
  return validations?.[String(col)];
}

/**
 * Attach (or with `null`, clear) a column's validation, returning a
 * fresh map. Returns `undefined` when the result is empty so callers
 * can drop the field entirely.
 */
export function setColumnValidation(
  validations: ValidationMap | undefined,
  col: number,
  validation: DataValidation | null,
): ValidationMap | undefined {
  const next: ValidationMap = { ...(validations ?? {}) };
  if (validation === null) {
    delete next[String(col)];
  } else {
    next[String(col)] = validation;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

/**
 * Parse a user-typed dropdown specification (comma-separated) into a
 * clean, de-duplicated, order-preserving list of non-empty values.
 */
export function parseListValues(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of input.split(",")) {
    const v = part.trim();
    if (v === "" || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Whether `value` satisfies `validation`. A blank cell is always
 * allowed (validation constrains entered values, it doesn't force a
 * value). List membership is case-sensitive to match the stored
 * options; checkbox accepts only the two canonical literals.
 */
export function isValueAllowed(
  validation: DataValidation,
  value: string,
): boolean {
  if (value === "") return true;
  if (validation.kind === "checkbox") {
    return value === CHECKBOX_TRUE || value === CHECKBOX_FALSE;
  }
  return validation.values.includes(value);
}
