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
  parseCellKey,
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

/**
 * The canonical name of the active sheet in a `SheetContent`.
 * Returns `"Sheet1"` for single-sheet content (no `.sheets`
 * field) since that's what `toWorkbook` synthesises. Pulled into
 * its own helper so that callers wiring up `incrementalRecalc`
 * (whose cache + dep-graph keys are qualified) can read cells out
 * using the matching shape without re-implementing the
 * single-sheet fallback inline at every call site.
 */
export function activeSheetName(content: SheetContent): string {
  if (content.sheets && content.sheets.length > 0) {
    const activeRaw = content.activeSheetIndex ?? 0;
    const active = Math.min(
      Math.max(0, Math.trunc(activeRaw)),
      content.sheets.length - 1,
    );
    return content.sheets[active].name;
  }
  return "Sheet1";
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
 *
 * Phase 19 PR 9 — incremental recalculation: callers may pass an
 * external `cache` so it survives between top-level evaluations.
 * When `cache.has(key)` is true at lookup time, the cached value
 * is returned without re-parsing or re-evaluating — that's how
 * `incrementalRecalc` skips work for cells whose value didn't
 * change. The cache map is mutable (the resolver writes new
 * results back into it), so callers should `delete(key)` for
 * dirty cells BEFORE invoking the resolver. The historical
 * single-call shape (no `cache` arg) keeps creating a fresh
 * map each call, matching the prior contract exactly.
 */
export function makeWorkbookResolver(
  workbook: Workbook,
  cache: Map<string, FormulaValue> = new Map<string, FormulaValue>(),
): {
  resolver: CellResolver;
  visiting: Set<string>;
  cache: Map<string, FormulaValue>;
} {
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
      // Resolver-side cycle gate. The evaluator's own cycle check
      // (evaluator.ts:102) only fires when its `cellKey` matches
      // what we put in `visiting`. For unqualified self-references
      // (e.g. cell A1 containing `=A1`), the AST node has
      // `sheet = undefined`, so the evaluator builds the key as
      // `0,0` while the resolver has `sheet1!0,0` in `visiting` —
      // the keys diverge and the evaluator's check misses. Without
      // this guard, the resolver re-enters itself indefinitely and
      // blows the stack. Catching it here makes the resolver the
      // authoritative cycle gate regardless of how the evaluator
      // routes the recursive call.
      if (visiting.has(key)) {
        const err: FormulaValue = {
          kind: "error",
          code: "#CIRCULAR!",
          message: `circular reference at ${key}`,
        };
        cache.set(key, err);
        return err;
      }
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

  return { resolver, visiting, cache };
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
 * Evaluate every formula cell in the active sheet of `sheet` using
 * ONE shared workbook resolver, so intermediate dependencies are
 * computed at most once per render even when many formulas reference
 * the same target. Returns a `Map<cellKey, FormulaValue>` keyed by
 * `"row,col"` (sheet name omitted — callers route through the
 * active sheet).
 *
 * Without this helper, the prior render path called
 * `evaluateSheetFormula(raw, sheet)` per formula cell, building a
 * fresh resolver each time and re-evaluating shared dependencies
 * `N²` times. The resolver returned by `makeWorkbookResolver`
 * already caches per-cell evaluations internally, so we just walk
 * the grid and ask the resolver for each formula cell — it handles
 * dedup and cycle detection.
 */
export function evaluateAllSheetFormulas(
  sheet: SheetContent,
): Map<string, FormulaValue> {
  return evaluateAllWorkbookFormulas(toWorkbook(sheet));
}

/**
 * Workbook flavour of {@link evaluateAllSheetFormulas}: evaluate
 * every formula cell across every tab through one shared resolver.
 * Returns a map keyed by fully qualified cell keys (`"Sheet1!r,c"`).
 * Cross-sheet formulas only re-evaluate their targets the first
 * time they're touched in this pass.
 */
export function evaluateAllWorkbookFormulas(
  workbook: Workbook,
): Map<string, FormulaValue> {
  const cache = new Map<string, FormulaValue>();
  const { resolver } = makeWorkbookResolver(workbook);
  for (const tab of workbook.sheets) {
    for (let r = 0; r < tab.rows.length; r++) {
      const row = tab.rows[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const raw = row[c];
        if (!raw || !raw.startsWith("=")) continue;
        // The resolver caches per-cell evaluations internally, so a
        // formula that depends on another formula resolves through
        // the same cache rather than spawning a fresh evaluation
        // tree. Keep keys local-form for the active sheet (no
        // prefix) so SheetEditor can look them up by `"r,c"`; use
        // the qualified form for other tabs so cross-sheet refs
        // don't collide.
        const localKey =
          tab.name === workbook.sheets[workbook.activeSheetIndex].name
            ? cellKey(r, c)
            : cellKey(r, c, tab.name);
        cache.set(localKey, resolver.getEvaluated(r, c, tab.name));
      }
    }
  }
  return cache;
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
 * Persistent state that {@link incrementalRecalc} threads across
 * SheetEditor renders. The contract:
 *
 *   - `graph`: dep edges for every formula cell currently in the
 *     sheet. Updated incrementally as cells change.
 *   - `cache`: per-cell evaluation results keyed by `cellKey(row,
 *     col)` for the active sheet (matching the legacy single-sheet
 *     key shape `evaluateAllSheetFormulas` returns). Entries are
 *     invalidated for any cell whose raw text changed AND any cell
 *     transitively dependent on a changed cell. Untouched entries
 *     survive untouched — that's the whole point.
 *   - `lastRows`: snapshot of the previous render's `sheet.rows`,
 *     used as the diff baseline. Stored as the array reference,
 *     not a deep copy — the SheetEditor produces new top-level
 *     arrays via `{ ...prev, rows: newRows }` on every edit, so
 *     reference identity is a sufficient "unchanged" signal at the
 *     row level (and we descend cell-by-cell when row refs do
 *     differ).
 *
 * Cells are tracked using fully-qualified `cellKey(row, col,
 * activeName)` keys (`"sheet1!r,c"`) so the dep-graph, the
 * persistent cache, and the resolver's internal visiting set all
 * speak the same shape. The resolver bakes the active sheet into
 * its key shape too, so mixing in unqualified `"r,c"` keys here
 * would silently miss every dep-graph lookup. Reads from outside
 * (e.g. `getCellDisplay` in `SheetEditor`) must use the same
 * `cellKey(row, col, activeName)` shape — see `activeSheetName()`
 * for the canonical name to feed it.
 */
export interface IncrementalRecalcState {
  graph: DependencyGraph;
  cache: Map<string, FormulaValue>;
  lastRows: ReadonlyArray<ReadonlyArray<string>> | null;
}

/** Allocate a fresh `IncrementalRecalcState` for the first render. */
export function makeIncrementalRecalcState(): IncrementalRecalcState {
  return {
    graph: new DependencyGraph(),
    cache: new Map(),
    lastRows: null,
  };
}

/**
 * Recompute every formula cell that's transitively affected by the
 * cells whose raw text changed between `state.lastRows` and
 * `sheet.rows`. The first render (`state.lastRows === null`)
 * recomputes the entire sheet — same cost as the eager pass — and
 * thereafter only the dirty + dependent set is touched.
 *
 * Mutates `state` in place: updates `graph`, `cache`, and
 * `lastRows`. Returns the new `cache` reference so the caller can
 * pass it straight to render. (Returning the same `Map` we wrote
 * into is fine for React — the `useMemo` that owns the state's
 * `useRef` keys on `sheet`, so a render only fires when the sheet
 * actually changed, and `getCellDisplay` reads the cache
 * imperatively.)
 *
 * Why we touch the cache *and* the graph in the same pass:
 *
 *   - A non-formula edit (e.g. `A1` going from `5` → `7`)
 *     invalidates the cache entry for `A1` AND every cell
 *     transitively reading A1. The graph doesn't need a new edge,
 *     but the cache entries downstream are now stale.
 *   - A formula edit (e.g. `A1` going from `5` → `=B1`) ALSO
 *     changes the graph: A1's `dependsOn` set must be updated, or
 *     a future edit to B1 won't know A1 depends on it.
 *   - A formula being deleted (e.g. `=B1` → `5`) drops A1's edges
 *     to keep `usedBy(B1)` from carrying a dangling reference.
 *
 * Cycles (e.g. A1=B1, B1=A1) are detected at evaluation time by
 * the resolver's `visiting` set (returning `#CIRCULAR!`), AND
 * topologically by `graph.recalcOrder`. The latter is needed when
 * the cycle isn't reachable from the edited cell — picking up
 * stale `#CIRCULAR!` values that should stay flagged.
 */
export function incrementalRecalc(
  sheet: SheetContent,
  state: IncrementalRecalcState,
): Map<string, FormulaValue> {
  const { graph, cache, lastRows } = state;
  const prevRows = lastRows;
  const nextRows = sheet.rows;

  // Resolve the active sheet name UP FRONT — every key we build
  // and every graph edge we record needs to be qualified with it
  // so the persistent cache (qualified) and the resolver's
  // internal lookups (qualified) speak the same key shape.
  const activeName = activeSheetName(sheet);

  // Identify dirty cells — those whose raw text changed.
  // First render: every formula / literal cell is dirty (treated as
  // "appeared from nothing"). This costs the same as the eager pass
  // the legacy code does on mount.
  const dirtyKeys = new Set<string>();
  if (prevRows === null) {
    for (let r = 0; r < nextRows.length; r++) {
      const row = nextRows[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        if (row[c] !== undefined && row[c] !== "") {
          dirtyKeys.add(cellKey(r, c, activeName));
        }
      }
    }
  } else {
    // Reference equality on rows is enough to skip whole rows that
    // didn't change — SheetEditor allocates a new row array only on
    // edits to that row. We still descend cell-by-cell when row
    // refs differ because a single-cell edit produces a new row
    // array with most cells reference-equal to the previous values.
    const maxR = Math.max(prevRows.length, nextRows.length);
    for (let r = 0; r < maxR; r++) {
      const prevRow = prevRows[r];
      const nextRow = nextRows[r];
      if (prevRow === nextRow) continue;
      const maxC = Math.max(prevRow?.length ?? 0, nextRow?.length ?? 0);
      for (let c = 0; c < maxC; c++) {
        const prev = prevRow?.[c];
        const next = nextRow?.[c];
        if (prev !== next) dirtyKeys.add(cellKey(r, c, activeName));
      }
    }
    // Cells beyond the new sheet's row count are deletions: drop
    // them from the graph + cache so dangling `usedBy` entries
    // never linger.
    for (let r = nextRows.length; r < prevRows.length; r++) {
      const prevRow = prevRows[r];
      if (!prevRow) continue;
      for (let c = 0; c < prevRow.length; c++) {
        if (prevRow[c] !== undefined && prevRow[c] !== "") {
          dirtyKeys.add(cellKey(r, c, activeName));
        }
      }
    }
  }

  // For every dirty cell, update its graph edges and invalidate its
  // cache entry. The graph update has to land BEFORE we compute the
  // `recalcOrder` below, otherwise a freshly-removed dependency
  // would still appear in `usedBy(target)` and trigger a phantom
  // recompute for a formula that no longer reads the dirty cell.
  //
  // BUT — for *deleted* cells, calling `graph.remove(key)` here
  // also wipes the cell's reverse-index `users[key]` set BEFORE
  // `recalcOrder` runs. The reverse index is exactly what
  // `recalcOrder` walks to find downstream formulas, so without a
  // snapshot the dependents of a deleted cell would silently keep
  // their stale cached values. The fix is to snapshot every
  // deleted key's `usedBy` set into `extraSeeds` BEFORE the
  // `remove` call, then feed those snapshots into `recalcOrder`
  // alongside `dirtyKeys` so the topo walk still finds them.
  //
  // First pass: classify each dirty key as a deletion or a
  // live edit. We need the full set of deletions before snapshotting
  // `usedBy` so that an extraSeed that is itself being deleted
  // (e.g. row 5 dropped — A5 references B5, both deleted) is not
  // re-added as a phantom live cell.
  //
  // Track keys that survived the diff (still exist on the new
  // sheet) so we can drive re-evaluation against them after the
  // graph is in sync. Deletions (raw === undefined) skip
  // evaluation entirely — their dependents are picked up via
  // `recalcOrder` below.
  const liveDirtyKeys: string[] = [];
  const deletedKeys = new Set<string>();
  const extraSeeds = new Set<string>();
  for (const key of dirtyKeys) {
    const { row, col } = parseCellKey(key);
    const raw = nextRows[row]?.[col];
    if (raw === undefined) {
      deletedKeys.add(key);
    }
  }
  for (const key of dirtyKeys) {
    const { row, col } = parseCellKey(key);
    const raw = nextRows[row]?.[col];
    if (raw && raw.startsWith("=")) {
      const parsed = parseFormula(raw);
      // Even on a parse error, drop dependencies — the cell will
      // surface a `#PARSE!` style error at evaluation time, and
      // it has no live references to feed the dep graph.
      graph.setDependencies(
        key,
        parsed.ok
          ? extractReferences(parsed.ast, activeName)
          : new Set<string>(),
      );
      liveDirtyKeys.push(key);
    } else if (raw !== undefined) {
      // Cell still exists but is a literal — clear its outgoing
      // dependencies only. We must NOT call `graph.remove(key)`
      // here: `remove` also wipes the cell's reverse `users[key]`
      // set, which lists the formula cells that read this cell.
      // Wiping it would mean the very next edit to this literal
      // can't find its dependents (e.g. C1=A1+B1 would never
      // recompute when A1's value changes from 1 → 10).
      graph.setDependencies(key, new Set<string>());
      liveDirtyKeys.push(key);
    } else {
      // Cell is genuinely gone (row truncated or column dropped) —
      // safe to fully `remove` so the reverse-index entry doesn't
      // dangle. Skip evaluation: the resolver would otherwise
      // resurrect the entry as `null` on lookup of an undefined
      // cell, leaving a stale "ghost" in the cache.
      //
      // Snapshot `usedBy(key)` BEFORE the remove call so the
      // dependents flow into `recalcOrder` even after `remove`
      // wipes the reverse index. Without this snapshot a formula
      // that references a deleted cell never gets re-evaluated,
      // and keeps its stale cached value. We skip any user that
      // is itself being deleted — re-evaluating a no-longer-existent
      // cell would otherwise resurrect it in the cache as a `null`
      // ghost (see comment above).
      for (const user of graph.usedBy(key)) {
        if (!deletedKeys.has(user)) extraSeeds.add(user);
      }
      graph.remove(key);
    }
    cache.delete(key);
  }

  // Walk the dep graph to find every cell transitively reading a
  // dirty cell. Invalidate their cache entries too — their values
  // depend on inputs that may have changed. Cells in cycles get
  // tagged for `#CIRCULAR!` here.
  //
  // Seeds are `dirtyKeys ∪ extraSeeds`: the dirty keys themselves
  // still need their downstream walked (a formula that read A1
  // and A1 is now `=B1+1` still has `users[A1]` populated), and
  // `extraSeeds` covers the deleted-cell case where the reverse
  // index has been wiped. Using `extraSeeds` as roots (already
  // one hop downstream of the deleted cell) is fine because
  // `recalcOrder` walks `usedBy` from the seeds themselves.
  const allSeeds: Iterable<string> =
    extraSeeds.size === 0
      ? dirtyKeys
      : new Set([...dirtyKeys, ...extraSeeds]);
  const { order: dependentOrder, cyclic } = graph.recalcOrder(allSeeds);
  // The `extraSeeds` are dependents themselves (one hop downstream
  // of the deleted cells), so their cached values must also be
  // invalidated even if they have no further dependents to walk.
  for (const key of extraSeeds) cache.delete(key);
  for (const key of dependentOrder) cache.delete(key);
  for (const key of cyclic) cache.delete(key);

  // Build a resolver that reads through the persistent cache. Cells
  // already in the cache (untouched by this edit) return their
  // cached value without re-parsing or re-evaluating — that's the
  // whole point. Cells we just invalidated will fall through to
  // the parse + evaluate path, which then writes the new value
  // back into the cache.
  const { resolver } = makeWorkbookResolver(toWorkbook(sheet), cache);

  // Re-evaluate dirty cells in dep-graph order. We start with the
  // dirty seeds themselves (they may include literal cells that
  // need a fresh cache entry to feed downstream formulas), then
  // the `extraSeeds` (formula cells whose direct dependency was
  // deleted — every entry in `users[X]` is by construction a
  // formula cell, so they need a fresh `#REF!` / blank-input
  // evaluation), and finally the transitive dependents in
  // topological order so each cell's inputs are already in the
  // cache by the time we ask the resolver for its value. The
  // resolver is recursive so it does not require the
  // `extraSeeds` themselves to be in topological order — any
  // intra-`extraSeeds` dependency is satisfied transparently
  // through the cache.
  const evaluateOne = (key: string): void => {
    const { row, col } = parseCellKey(key);
    resolver.getEvaluated(row, col, activeName);
  };
  for (const key of liveDirtyKeys) evaluateOne(key);
  for (const key of extraSeeds) evaluateOne(key);
  for (const key of dependentOrder) evaluateOne(key);
  // Cells in cycles always resolve to `#CIRCULAR!` regardless of
  // their formula source — the resolver itself surfaces this via
  // the `visiting` set, but for cells in cycles that *weren't*
  // touched by the resolver in this pass (cycle exists but no
  // member is dirty), we ensure the cache reflects the cyclic
  // status.
  for (const key of cyclic) {
    if (!cache.has(key)) {
      cache.set(key, {
        kind: "error",
        code: "#CIRCULAR!",
        message: "circular reference",
      });
    }
  }

  state.lastRows = nextRows;
  return cache;
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
