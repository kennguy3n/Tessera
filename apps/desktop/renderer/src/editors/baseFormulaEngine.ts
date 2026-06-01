/**
 * Base-record formula engine.
 *
 * Reuses the formula engine (`./formulaEngine`) by mapping
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
 * Token emitted by {@link walkFormulaSource}.
 *
 * `text` — verbatim character(s) the caller should pass through.
 * `ref`  — a `{FieldName}` reference. `raw` is the full original
 *          token including the braces; `name` is the field name
 *          inside the braces (so callers don't all re-substring).
 */
type FormulaToken =
  | { kind: "text"; text: string }
  | { kind: "ref"; raw: string; name: string };

/**
 * Walk a base-formula source and yield a stream of {@link FormulaToken}s,
 * correctly skipping `{` and `}` that appear *inside* single- or
 * double-quoted string literals.
 *
 * String-literal semantics intentionally mirror the underlying formula
 * tokenizer (`formulaEngine/tokenizer.ts`): a string is opened by `"`
 * or `'`, and an embedded delimiter is escaped by **doubling it**
 * (RFC-4180 / Excel convention, e.g. `"a""b"` is the four-char string
 * `a"b`). Backslash is a literal character — the formula engine does
 * **not** treat `\"` as an escape, so this scanner does not either.
 * Keeping the two scanners aligned is what guarantees that
 * `extractFieldRefs`, `rewriteFieldRefs`, `renameFieldInFormula`, and
 * the evaluator/dep-graph all agree on the same notion of "inside a
 * string literal" — otherwise a rename of `{Price}` could rewrite a
 * literal the evaluator was actually reading as code, or vice versa.
 *
 * Centralising the scan in one helper keeps `rewriteFieldRefs`,
 * `extractFieldRefs`, and `BaseEditor.renameField`'s in-place formula
 * rewrite from drifting — historically they each had their own
 * scanner with subtly different rules.
 */
function walkFormulaSource(source: string): FormulaToken[] {
  const tokens: FormulaToken[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf.length > 0) {
      tokens.push({ kind: "text", text: buf });
      buf = "";
    }
  };

  let i = 0;
  let inStr: '"' | "'" | null = null;
  while (i < source.length) {
    const ch = source[i];
    if (inStr) {
      buf += ch;
      if (ch === inStr) {
        // RFC-4180 doubled-quote escape: a literal `"` inside a
        // `"…"` string is written `""` (and similarly `''` for
        // single-quoted sheet names). Consume both characters so
        // the literal stays open.
        if (source[i + 1] === inStr) {
          buf += source[i + 1];
          i += 2;
          continue;
        }
        inStr = null;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === "{") {
      const close = source.indexOf("}", i + 1);
      if (close < 0) {
        // Unclosed brace — pass through verbatim. The evaluator will
        // surface the error itself; this scanner is intentionally
        // lossless.
        buf += source.slice(i);
        break;
      }
      flush();
      tokens.push({
        kind: "ref",
        raw: source.slice(i, close + 1),
        name: source.slice(i + 1, close),
      });
      i = close + 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  flush();
  return tokens;
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
  for (const tok of walkFormulaSource(source)) {
    if (tok.kind === "text") {
      out += tok.text;
      continue;
    }
    const idx = indexByName.get(tok.name);
    out += idx === undefined ? tok.raw : `${columnLetter(idx)}1`;
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
  for (const tok of walkFormulaSource(source)) {
    if (tok.kind !== "ref") continue;
    if (seen.has(tok.name)) continue;
    seen.add(tok.name);
    refs.push(tok.name);
  }
  return refs;
}

/**
 * Rewrite every `{oldName}` reference in `source` to `{newName}`,
 * preserving everything else verbatim. Used by
 * `BaseEditor.renameField` to keep formula sources in lock-step with
 * field renames without forking yet another scanner.
 */
export function renameFieldInFormula(
  source: string | undefined,
  oldName: string,
  newName: string,
): string | undefined {
  if (!source) return source;
  let out = "";
  for (const tok of walkFormulaSource(source)) {
    if (tok.kind === "text") {
      out += tok.text;
      continue;
    }
    out += tok.name === oldName ? `{${newName}}` : tok.raw;
  }
  return out;
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
      // the JS call stack (see PR #78.
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
