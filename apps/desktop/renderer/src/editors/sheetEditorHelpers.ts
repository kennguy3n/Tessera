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
import type {
  CellFormat,
  SheetContent,
  SheetTab,
} from "./sheetEditorTypes";

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
 * Phase 16 Task 13 — in-memory multi-sheet view of a `SheetContent`.
 * Pure-functional: `toWorkbook` always succeeds (the legacy
 * single-sheet shape wraps into one tab named "Sheet1"), and
 * `fromWorkbook` mirrors the active sheet back into the legacy
 * `columns`/`rows` fields so the artifact stays readable by the
 * pre-Phase-16 XLSX exporter and any other downstream tooling that
 * has not yet been updated.
 */
export interface Workbook {
  /** Always at least one sheet; never empty. */
  sheets: SheetTab[];
  /** Zero-based index into `sheets` for the currently-active tab. */
  activeSheetIndex: number;
}

export function toWorkbook(content: SheetContent): Workbook {
  if (content.sheets && content.sheets.length > 0) {
    const activeRaw = content.activeSheetIndex ?? 0;
    const active = Math.min(
      Math.max(0, Math.trunc(activeRaw)),
      content.sheets.length - 1,
    );
    // Defensive deep-copy of sheet metadata so a caller mutation
    // doesn't bleed back into the original `SheetContent`.
    return {
      sheets: content.sheets.map((s) => ({
        name: s.name,
        columns: [...s.columns],
        rows: s.rows.map((r) => [...r]),
        formats: s.formats ? { ...s.formats } : undefined,
      })),
      activeSheetIndex: active,
    };
  }
  return {
    sheets: [
      {
        name: "Sheet1",
        columns: [...content.columns],
        rows: content.rows.map((r) => [...r]),
        formats: content.formats ? { ...content.formats } : undefined,
      },
    ],
    activeSheetIndex: 0,
  };
}

export function fromWorkbook(
  workbook: Workbook,
  baseContent?: SheetContent,
): SheetContent {
  const active =
    workbook.sheets[Math.min(workbook.activeSheetIndex, workbook.sheets.length - 1)];
  const out: SheetContent = {
    ...(baseContent ?? {}),
    columns: [...active.columns],
    rows: active.rows.map((r) => [...r]),
    sheets: workbook.sheets.map((s) => ({
      name: s.name,
      columns: [...s.columns],
      rows: s.rows.map((r) => [...r]),
      formats: s.formats ? { ...s.formats } : undefined,
    })),
    activeSheetIndex: workbook.activeSheetIndex,
    formats: active.formats ? { ...active.formats } : undefined,
  };
  // Legacy single-sheet artifacts keep their compact JSON shape: if
  // the workbook has exactly one default-named sheet, drop the
  // `sheets`/`activeSheetIndex`/`formats` fields so re-saving the
  // artifact doesn't bloat the file or break tools that key on
  // `.sheets` being absent.
  if (
    workbook.sheets.length === 1 &&
    workbook.sheets[0].name === "Sheet1" &&
    !workbook.sheets[0].formats
  ) {
    delete out.sheets;
    delete out.activeSheetIndex;
    delete out.formats;
  }
  return out;
}

/** Look up the per-cell `CellFormat` for `(row, col)` on `sheet`. */
export function getCellFormat(
  sheet: SheetTab,
  row: number,
  col: number,
): CellFormat | undefined {
  return sheet.formats?.[`${row},${col}`];
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
 * Multi-sheet (Phase 16 Task 13): when the artifact contains a
 * `sheets[]` array (or the user has added a second tab in the
 * editor), pass a `Workbook` instead — the resolver routes
 * sheet-qualified refs (`Sheet2!A1`) to the right tab.
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
  return makeWorkbookResolver(toWorkbook(sheet));
}

/**
 * Workbook-aware resolver. The `sheet` arg on `getRaw`/`getEvaluated`
 * (added in Phase 16 Task 13) names a sibling tab; when absent, the
 * lookup targets `workbook.sheets[workbook.activeSheetIndex]`.
 *
 * Returns the shared `visiting` set so the top-level driver can
 * inject it into `defaultContext()` for cycle detection.
 */
export function makeWorkbookResolver(workbook: Workbook): {
  resolver: CellResolver;
  visiting: Set<string>;
} {
  const cache = new Map<string, FormulaValue>();
  const visiting = new Set<string>();
  // Sheet names are matched case-insensitively to mirror Excel /
  // Google Sheets behaviour, but the canonical (case-preserving)
  // name is what we use everywhere downstream (cache keys, dep
  // graph keys, the active-tab swap, the `#REF!` diagnostic).
  const sheetByName = new Map<string, SheetTab>();
  for (const s of workbook.sheets) sheetByName.set(s.name.toLowerCase(), s);
  // `activeName` is the "currently evaluating" sheet (canonical
  // case). It starts at the workbook's active tab and gets swapped
  // to the owning sheet whenever the resolver recurses into a
  // formula on another tab, so that unqualified refs inside *that*
  // formula stay local. We use a single mutable holder rather than
  // a Set so cleanup is O(1) on the recursion exit.
  let activeName = workbook.sheets[workbook.activeSheetIndex].name;

  const lookupTab = (sheet: string | undefined): SheetTab | undefined =>
    sheetByName.get((sheet ?? activeName).toLowerCase());

  const resolver: CellResolver = {
    getRaw(row, col, sheet) {
      return lookupTab(sheet)?.rows[row]?.[col];
    },
    getEvaluated(row, col, sheet) {
      const tab = lookupTab(sheet);
      // Use the canonical sheet name for cache + cycle keys so that
      // case-variant references (e.g. `SHEET1!A1`, `Sheet1!A1`)
      // share a single cache entry instead of producing two
      // independent evaluation paths.
      const canonicalName = tab?.name ?? sheet ?? activeName;
      const key = cellKey(row, col, canonicalName);
      // Cross-sheet reference to a non-existent tab → #REF! (Excel
      // raises this when a sheet is deleted out from under a
      // formula). Cache so a workbook recompute doesn't re-parse
      // the same dangling reference repeatedly.
      if (!tab) {
        if (cache.has(key)) return cache.get(key)!;
        const err: FormulaValue = {
          kind: "error",
          code: "#REF!",
          message: `unknown sheet "${sheet ?? activeName}"`,
        };
        cache.set(key, err);
        return err;
      }
      if (cache.has(key)) return cache.get(key)!;
      const raw = tab.rows[row]?.[col];
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
        visiting.add(key);
        const previousActive = activeName;
        activeName = tab.name;
        try {
          const ctx = defaultContext(resolver, { visiting });
          const v = evaluate(parsed.ast, ctx);
          cache.set(key, v);
          return v;
        } finally {
          activeName = previousActive;
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
 * ~55 functions (math / conditional / logic / text / lookup / date /
 * stats), cell references, nested expressions, and Excel-compatible
 * error sentinels.
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
 * Workbook-aware evaluation. Cross-sheet formulas resolve through
 * the workbook resolver; unqualified refs target the workbook's
 * active sheet.
 */
export function evaluateWorkbookFormula(
  formula: string,
  workbook: Workbook,
): FormulaValue {
  const { resolver, visiting } = makeWorkbookResolver(workbook);
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
 * Workbook-aware dep graph. Keys are fully qualified
 * (`"Sheet1!3,2"`) so cross-sheet dependencies are tracked without
 * collision between same-coordinate cells on different sheets.
 */
export function buildWorkbookDependencyGraph(
  workbook: Workbook,
): DependencyGraph {
  const graph = new DependencyGraph();
  for (const tab of workbook.sheets) {
    for (let r = 0; r < tab.rows.length; r++) {
      const row = tab.rows[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const raw = row[c];
        if (!raw || !raw.startsWith("=")) continue;
        const parsed = parseFormula(raw);
        if (!parsed.ok) continue;
        graph.setDependencies(
          cellKey(r, c, tab.name),
          extractReferences(parsed.ast, tab.name),
        );
      }
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
export function dependenciesOfCell(
  rawText: string | undefined,
  activeSheet?: string,
): Set<string> {
  if (!rawText || !rawText.startsWith("=")) return new Set<string>();
  const parsed = parseFormula(rawText);
  if (!parsed.ok) return new Set<string>();
  return extractReferences(parsed.ast, activeSheet);
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
