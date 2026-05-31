/**
 * Phase 17 PR 4 Task 2 — Base-record formula engine.
 *
 * Reuses the Phase 16 formula engine (`./formulaEngine`) by mapping
 * Airtable-style `{FieldName}` references in a formula source string
 * onto synthetic single-row cell references that the existing
 * tokeniser already understands. This avoids forking the engine for
 * what is, semantically, just a different *resolver*.
 *
 * Strategy
 * ========
 * 1. Build a name→column-letter map from the base's field list, in
 *    declaration order. The implicit "row" is always row 1 because a
 *    base formula always evaluates against a single record.
 * 2. Walk the formula source and replace every `{FieldName}` token
 *    with the corresponding `A1` / `B1` / `AA1` reference. We use a
 *    deliberate non-regex scan so embedded `}` inside string
 *    literals doesn't get mistaken for the end of a reference.
 * 3. Build a `CellResolver` whose `getRaw(0, col)` returns the
 *    record's value at the field that lives in that column. Cell
 *    refs the user might have hand-typed (Excel-style `A1`) are
 *    routed through the same map so both syntaxes Just Work.
 * 4. Call the existing `evaluateFormulaString(...)` and return its
 *    `FormulaValue`.
 *
 * Read-only by contract: rollup/formula/lookup cells are never
 * editable in the grid; the helper exports `evaluateBaseFormula` for
 * cell rendering and `extractFieldRefs` for change-tracking (so a
 * future PR's reactive recompute knows which formula cells to dirty
 * when an upstream field changes).
 */

import {
  evaluateFormulaString,
  isFormulaError,
  makeError,
  type CellResolver,
  type FormulaValue,
} from "./formulaEngine";
import type { BaseField, BaseRecord } from "./baseEditorTypes";

/**
 * Convert a zero-based column index to an Excel-style column letter
 * (0 → A, 25 → Z, 26 → AA, …). Matches the tokeniser's parsing of
 * uppercase identifier runs in CELL_REF tokens, so there is no extra
 * normalisation needed on the engine side.
 */
function columnLetter(col: number): string {
  let n = col;
  let out = "";
  do {
    const rem = n % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * Re-write `{FieldName}` references in `source` into synthetic cell
 * references. Returns the rewritten formula plus the field-index map
 * used (callers like `extractFieldRefs` reuse the same map).
 *
 * Unknown field names are kept as-is; the engine will then surface a
 * `#NAME?` error rather than silently substituting nothing.
 */
export function rewriteFieldRefs(
  source: string,
  fields: BaseField[],
): { rewritten: string; indexByName: Map<string, number> } {
  const indexByName = new Map<string, number>();
  fields.forEach((f, i) => indexByName.set(f.name, i));

  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];

    // Skip over string literals so a `}` inside a quoted string
    // never closes a field reference.
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < source.length) {
        const ch = source[i];
        out += ch;
        i++;
        if (ch === quote) break;
      }
      continue;
    }

    if (c === "{") {
      const close = source.indexOf("}", i + 1);
      if (close === -1) {
        // Unclosed brace — pass through verbatim, evaluator will error.
        out += source.slice(i);
        break;
      }
      const name = source.slice(i + 1, close);
      const idx = indexByName.get(name);
      if (idx === undefined) {
        // Preserve original so the user sees the bad name in errors.
        out += source.slice(i, close + 1);
      } else {
        out += `${columnLetter(idx)}1`;
      }
      i = close + 1;
      continue;
    }

    out += c;
    i++;
  }
  return { rewritten: out, indexByName };
}

/**
 * Extract every `{FieldName}` referenced from `source`, in document
 * order, de-duplicated. Used by upstream dirty-tracking so editing a
 * source field can recompute only its dependents — caller's
 * responsibility, this helper just returns the static dep set.
 */
export function extractFieldRefs(source: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== quote) i++;
      i++;
      continue;
    }
    if (c === "{") {
      const close = source.indexOf("}", i + 1);
      if (close === -1) break;
      const name = source.slice(i + 1, close);
      if (!seen.has(name)) {
        seen.add(name);
        refs.push(name);
      }
      i = close + 1;
      continue;
    }
    i++;
  }
  return refs;
}

/**
 * Evaluate a base formula against a single record. Returns the
 * engine's typed `FormulaValue` (the caller decides how to render
 * `null` / error sentinels into the cell).
 *
 * `currentFieldName` (optional) is the formula-field whose source we
 * are evaluating. When supplied it seeds the cycle-detection set so
 * that a self-reference (`{Total}` inside the formula stored on the
 * field named `Total`) and mutual references between formula fields
 * are caught and reported as `#CIRCULAR!` instead of recursing until
 * the JS call stack overflows.
 */
export function evaluateBaseFormula(
  source: string,
  fields: BaseField[],
  record: BaseRecord,
  currentFieldName?: string,
): FormulaValue {
  const seed = currentFieldName ? new Set<string>([currentFieldName]) : new Set<string>();
  return evaluateBaseFormulaInner(source, fields, record, seed);
}

/**
 * Internal recursive entry point. Threads `visiting` (the set of
 * formula-field names currently on the evaluation stack) so the
 * inner resolver can short-circuit cycles before the engine recurses
 * back through `getEvaluated`. Exported for tests; the public
 * surface is `evaluateBaseFormula`.
 */
export function evaluateBaseFormulaInner(
  source: string,
  fields: BaseField[],
  record: BaseRecord,
  visiting: Set<string>,
): FormulaValue {
  if (!source || !source.trim()) return null;
  const { rewritten } = rewriteFieldRefs(source, fields);

  const resolver: CellResolver = {
    getRaw(row, col): string | undefined {
      if (row !== 0) return undefined;
      const field = fields[col];
      if (!field) return undefined;
      const v = record[field.name];
      if (v == null) return undefined;
      if (Array.isArray(v)) return v.join(", ");
      return String(v);
    },
    getEvaluated(row, col): FormulaValue {
      if (row !== 0) return null;
      const field = fields[col];
      if (!field) return null;
      // Nested base-formula references: re-evaluate inline, but
      // first guard against direct self-reference and mutual
      // recursion between formula fields. Without this the engine
      // would call `getEvaluated` back into here forever and blow
      // the JS call stack (see PR #78 Devin Review BUG_0002).
      if (field.type === "formula" && field.formula) {
        if (visiting.has(field.name)) {
          return makeError(
            "#CIRCULAR!",
            `Formula field "${field.name}" participates in a circular reference`,
          );
        }
        const nextVisiting = new Set(visiting);
        nextVisiting.add(field.name);
        return evaluateBaseFormulaInner(
          field.formula,
          fields,
          record,
          nextVisiting,
        );
      }
      const raw = record[field.name];
      if (raw == null) return null;
      if (typeof raw === "number" || typeof raw === "boolean") return raw;
      if (Array.isArray(raw)) return raw.join(", ");
      if (typeof raw === "string") {
        // Coerce numeric strings so `{Price} * {Quantity}` works on
        // text-typed columns the user filled with numbers. `Number.isFinite`
        // (rather than `!Number.isNaN`) rejects the literal strings
        // `"Infinity"` and `"-Infinity"` — those parse to numeric
        // `Infinity` and would otherwise propagate as a real numeric
        // infinity through arithmetic, mirroring how the sheet
        // engine's evaluator does the same coercion check.
        const trimmed = raw.trim();
        if (trimmed !== "" && Number.isFinite(Number(trimmed))) {
          return Number(trimmed);
        }
        return raw;
      }
      return null;
    },
  };

  try {
    return evaluateFormulaString(rewritten, resolver);
  } catch (err) {
    return makeError(
      "#ERR!",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Render a `FormulaValue` as the string the user sees in the cell. */
export function formatFormulaResult(value: FormulaValue): string {
  if (value == null) return "";
  if (isFormulaError(value)) return value.code;
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return value;
}
