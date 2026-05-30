/**
 * Pure parsers / formula evaluator for `SheetEditor`. Extracted out
 * of the component file so React Fast Refresh can preserve editor
 * state across HMR edits. Types are imported from `./sheetEditorTypes`
 * (a dedicated type-only module), so there is no runtime cycle
 * with the component file: both this helpers module and the
 * component module independently consume types from the third file,
 * breaking the would-be A↔B dependency edge.
 *
 * As of Phase 16 PR 1, `evaluateFormula` is a thin wrapper around
 * the real formula engine in `./formulaEngine/`. It preserves the
 * historical return-type (`string | number | boolean`) so existing
 * callers (and the on-disk artifact format) keep working unchanged.
 * Callers that need the full structured `FormulaValue` (including
 * `FormulaError` objects with a `code` and `message`) should call
 * `evaluateSheetFormula` instead.
 */
import {
  DependencyGraph,
  cellKey,
  defaultContext,
  evaluate,
  extractReferences,
  isFormulaError,
  parseFormula,
  type AstNode,
  type CellResolver,
  type FormulaValue,
} from "./formulaEngine";
import type { SheetContent } from "./sheetEditorTypes";

/** Parse CSV text respecting RFC 4180 quoted fields (handles commas inside quotes). */
export function parseCSVLines(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  while (i < text.length) {
    const row: string[] = [];
    while (i < text.length) {
      if (text[i] === '"') {
        // Quoted field
        i++;
        let field = "";
        while (i < text.length) {
          if (text[i] === '"') {
            if (i + 1 < text.length && text[i + 1] === '"') {
              field += '"';
              i += 2;
            } else {
              i++;
              break;
            }
          } else {
            field += text[i];
            i++;
          }
        }
        row.push(field);
      } else {
        // Unquoted field
        let field = "";
        while (
          i < text.length &&
          text[i] !== "," &&
          text[i] !== "\n" &&
          text[i] !== "\r"
        ) {
          field += text[i];
          i++;
        }
        row.push(field);
      }
      if (i < text.length && text[i] === ",") {
        i++;
      } else {
        break;
      }
    }
    // Skip line ending
    if (i < text.length && text[i] === "\r") i++;
    if (i < text.length && text[i] === "\n") i++;
    rows.push(row);
  }
  return rows;
}

/**
 * Decode the artifact's serialized JSON body into the in-memory
 * SheetContent shape the editor mounts. Falls back to a 3×3
 * default grid if the body is empty or malformed JSON.
 *
 * Exported so unit tests can pin this independently of the
 * SheetEditor's render pipeline (full component renders pull in
 * the IPC bridge and a chain of focus / clipboard side effects).
 */
export function parseSheetContent(content: string): SheetContent {
  if (!content) {
    return {
      columns: ["A", "B", "C"],
      rows: [
        ["", "", ""],
        ["", "", ""],
        ["", "", ""],
      ],
    };
  }
  try {
    const parsed = JSON.parse(content) as SheetContent;
    if (parsed.columns && Array.isArray(parsed.columns)) {
      return parsed;
    }
  } catch {
    // Not JSON
  }
  return {
    columns: ["A", "B", "C"],
    rows: [
      ["", "", ""],
      ["", "", ""],
      ["", "", ""],
    ],
  };
}

/**
 * Promote a raw cell-text value to a typed `FormulaValue` for the
 * resolver. Mirrors how Excel/Google Sheets interpret untyped cell
 * input: bare numbers become numbers, `TRUE`/`FALSE` become
 * booleans, everything else stays a string (blank → `null`).
 *
 * Quoted strings (`"foo"`) are NOT unquoted — Excel preserves the
 * quotes when they are part of the literal cell text.
 *
 * Exported so the React component (which renders the same value
 * in the formula bar) stays in sync.
 */
export function literalFromCellText(raw: string | undefined): FormulaValue {
  if (raw === undefined || raw === "") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return raw;
  const upper = trimmed.toUpperCase();
  if (upper === "TRUE") return true;
  if (upper === "FALSE") return false;
  const n = Number(trimmed);
  if (Number.isFinite(n)) return n;
  return raw;
}

/**
 * Build a `CellResolver` + shared visiting/cache state over a
 * `SheetContent`. The resolver:
 *   - caches per-cell `FormulaValue`s so `=A1+A1` doesn't
 *     quadratically re-evaluate
 *   - shares ONE visiting set across the whole top-level
 *     evaluation, which is how chains like `A1=B1`, `B1=A1` get
 *     promoted to `#CIRCULAR!` instead of stack-overflowing.
 *
 * The shared visiting set is returned alongside the resolver so the
 * top-level driver (`evaluateSheetFormula`) can hand it to
 * `defaultContext()` instead of having the resolver clobber it on
 * each recursive call.
 */
function makeResolver(sheet: SheetContent): {
  resolver: CellResolver;
  visiting: Set<string>;
} {
  const cache = new Map<string, FormulaValue>();
  const visiting = new Set<string>();
  const resolver: CellResolver = {
    getRaw(row, col) {
      return sheet.rows[row]?.[col];
    },
    getEvaluated(row, col) {
      const key = cellKey(row, col);
      if (cache.has(key)) return cache.get(key)!;
      const raw = sheet.rows[row]?.[col];
      if (raw === undefined) {
        cache.set(key, null);
        return null;
      }
      if (raw.startsWith("=")) {
        const parsed = parseFormula(raw);
        if (!parsed.ok) {
          const err: FormulaValue = {
            kind: "error",
            code: parsed.code,
            message: parsed.message,
          };
          cache.set(key, err);
          return err;
        }
        // Push the cell on the shared visiting set so any nested
        // lookup that points back at us (directly or transitively)
        // is caught by the evaluator's cycle check.
        visiting.add(key);
        try {
          const ctx = defaultContext(resolver, { visiting });
          const v = evaluate(parsed.ast, ctx);
          cache.set(key, v);
          return v;
        } finally {
          visiting.delete(key);
        }
      }
      const v = literalFromCellText(raw);
      cache.set(key, v);
      return v;
    },
  };
  return { resolver, visiting };
}

/**
 * Evaluate a formula expression against the supplied sheet state
 * and return a display-ready value (string / number / boolean).
 * Backed by the full formula engine in `./formulaEngine/` — supports
 * ~30 functions (math / conditional / logic), cell references,
 * nested expressions, and Excel-compatible error sentinels.
 *
 * Returns:
 *   - `number` for numeric results
 *   - `string` for string results, error sentinels (`#REF!`, etc.),
 *     and stringified booleans
 *   - `boolean` for true/false results
 *
 * Blank results (e.g. an empty cell reference) collapse to `""`
 * so the grid renders nothing rather than the literal `null`.
 */
export function evaluateFormula(
  formula: string,
  sheet: SheetContent,
): string | number | boolean {
  const value = evaluateSheetFormula(formula, sheet);
  if (value === null) return "";
  if (isFormulaError(value)) return value.code;
  return value;
}

/**
 * Evaluate `formula` against `sheet` and return the structured
 * `FormulaValue` (so callers can detect errors via `isFormulaError`
 * and render them with a tooltip / colour, instead of squashing to
 * a bare string).
 */
export function evaluateSheetFormula(
  formula: string,
  sheet: SheetContent,
): FormulaValue {
  const { resolver, visiting } = makeResolver(sheet);
  const parsed = parseFormula(formula);
  if (!parsed.ok) {
    return { kind: "error", code: parsed.code, message: parsed.message };
  }
  const ctx = defaultContext(resolver, { visiting });
  return evaluate(parsed.ast, ctx);
}

/**
 * Build a fresh `DependencyGraph` describing every formula cell in
 * `sheet`. Cells whose text starts with `=` are parsed once each;
 * non-formula cells contribute no edges. Used by the SheetEditor
 * to wire incremental recomputation when an edit lands.
 *
 * Returns the populated graph; callers manage further updates via
 * `graph.setDependencies()` as individual cells change.
 */
export function buildSheetDependencyGraph(sheet: SheetContent): DependencyGraph {
  const graph = new DependencyGraph();
  for (let r = 0; r < sheet.rows.length; r++) {
    const row = sheet.rows[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const raw = row[c];
      if (!raw || !raw.startsWith("=")) continue;
      const parsed = parseFormula(raw);
      if (!parsed.ok) continue;
      graph.setDependencies(cellKey(r, c), extractReferences(parsed.ast));
    }
  }
  return graph;
}

/**
 * Convenience: parse a single cell's formula and return the set of
 * cells it depends on. Returns an empty set for non-formula text
 * or syntactically invalid formulas (the cell itself will surface
 * the parse error at evaluation time).
 */
export function dependenciesOfCell(rawText: string | undefined): Set<string> {
  if (!rawText || !rawText.startsWith("=")) return new Set<string>();
  const parsed = parseFormula(rawText);
  if (!parsed.ok) return new Set<string>();
  return extractReferences(parsed.ast);
}

/** Walk `ast` (testing aid). Re-exported from the engine for callers. */
export type { AstNode };

/**
 * Parse an A1-style cell reference (e.g. `A1`, `AA1`, `AZ100`)
 * into a zero-based `{ row, col }` pair, or return `null` if the
 * input doesn't match the `^[A-Z]+\d+$` shape.
 *
 * Exported for unit-test coverage; this is the canonical place
 * cell references are decoded inside the sheet editor.
 */
export function parseCellRef(
  ref: string,
): { row: number; col: number } | null {
  const match = ref.match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  const col =
    match[1].split("").reduce((acc, c) => acc * 26 + c.charCodeAt(0) - 64, 0) -
    1;
  const row = parseInt(match[2], 10) - 1;
  return { row, col };
}
