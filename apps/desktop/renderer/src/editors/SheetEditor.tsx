import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  activeSheetName,
  evaluateFormula,
  incrementalRecalc,
  makeIncrementalRecalcState,
  parseCSVLines,
  parseSheetContent,
  updateCellInRows,
  updateCellsInRows,
  type CellEdit,
  type IncrementalRecalcState,
} from "./sheetEditorHelpers";
import {
  applyCellFormat,
  cellFormatStyle,
  cellKey,
  isFormulaError,
} from "./formulaEngine";
import type {
  CellFormat,
  ChartSpec,
  ConditionalFormatRule,
  SheetContent,
  SheetNamedRange,
  ValidationMap,
} from "./sheetEditorTypes";
import {
  NUMBER_FORMAT_PRESETS,
  allCellsHave,
  applyFormatPatch,
  getCellFormat,
  toggleBoolFormat,
  type BoolFormatKey,
} from "./sheetFormatting";
import { conditionalStyleForCell } from "./sheetConditionalFormatting";
import { sortSheetByColumn } from "./sheetSort";
import {
  CHECKBOX_FALSE,
  CHECKBOX_TRUE,
  getColumnValidation,
  isValueAllowed,
} from "./sheetDataValidation";
import {
  insertColumnAt,
  insertRowAt,
  removeColumnAt,
  removeRowAt,
} from "./sheetStructureOps";
import { extractChartData } from "./sheetCharts";
import { ConditionalFormatPanel } from "./components/ConditionalFormatPanel";
import { DataValidationPanel } from "./components/DataValidationPanel";
import { NamedRangePanel } from "./components/NamedRangePanel";
import { SheetAiPanel } from "./components/SheetAiPanel";
import { ChartsPanel } from "./components/ChartsPanel";
import { SheetChart } from "./components/SheetChart";
import {
  type CellCoord,
  type Selection,
  addSelection,
  extendSelection,
  moveByArrow,
  normalizeRange,
  selectionCells,
  selectionContains,
  selectionFromCell,
} from "./sheetSelection";
import {
  applyTSVAt,
  parseTSV,
  selectionToTSV,
} from "./sheetCopyPaste";
import { type FillDirection, fillSeries } from "./sheetAutoFill";
import { useVirtualRows } from "../hooks/useVirtualRows";

export type { SheetContent } from "./sheetEditorTypes";

/**
 * Convert a zero-based column index to the A1-style column label
 * shown in the header (and in the formula bar's cell-address
 * box). Pure function with no React deps — exported solely for the
 * formula-bar code path; not used outside this file.
 */
function columnLabel(index: number): string {
  let label = "";
  let n = index;
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  }
  return label;
}

interface SheetEditorProps {
  content: string;
  onSave: (content: string) => void;
  /**
   * Fired synchronously on every edit (no debounce), with the serialized
   * draft content. Used by `ArtifactEditorPage` to track the latest
   * in-progress edits so that exporting an artifact while a debounced
   * save is still pending captures the live editor state instead of the
   * stale last-persisted content.
   */
  onDraftChange?: (content: string) => void;
  autoSaveMs?: number;
}

/** Default per-cell pixel dimensions when no override is set. */
const DEFAULT_COLUMN_WIDTH = 96;
const DEFAULT_ROW_HEIGHT = 24;
const MIN_COLUMN_WIDTH = 32;
const MIN_ROW_HEIGHT = 16;

/**
 * Row count at or above which the grid body is virtualized (only the
 * rows intersecting the viewport are committed to the DOM). Chosen
 * well below the 10K+ "large sheet" target so those sheets always
 * window, and comfortably above any realistic small sheet so the
 * common case keeps its exact prior full-render path.
 */
const VIRTUALIZE_ROW_THRESHOLD = 1000;

export default function SheetEditor({
  content,
  onSave,
  onDraftChange,
  autoSaveMs = 2000,
}: SheetEditorProps) {
  const [sheet, setSheet] = useState<SheetContent>(() => parseSheetContent(content));
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  // full selection model (anchor + primary range
  // + disjoint extras). `activeCell` is derived from
  // `selection.anchor` so existing call-sites that only need a
  // single coord (formula bar, edit dispatch) keep working without
  // a refactor.
  const [selection, setSelection] = useState<Selection | null>(null);
  const activeCell: CellCoord | null = selection?.anchor ?? null;
  const [editValue, setEditValue] = useState("");
  // context-menu state: { kind, index, x, y }
  // backs the right-click freeze menu. `null` when no menu open.
  const [contextMenu, setContextMenu] = useState<{
    kind: "row" | "col";
    index: number;
    x: number;
    y: number;
  } | null>(null);
  // Conditional-formatting rules editor visibility.
  const [cfOpen, setCfOpen] = useState(false);
  // Named-range manager visibility.
  const [nrOpen, setNrOpen] = useState(false);
  // AI assistant panel visibility.
  const [aiOpen, setAiOpen] = useState(false);
  // Data-validation manager visibility.
  const [dvOpen, setDvOpen] = useState(false);
  // Charts manager visibility.
  const [chartsOpen, setChartsOpen] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const formulaBarRef = useRef<HTMLInputElement>(null);
  const gridWrapperRef = useRef<HTMLDivElement>(null);
  const lastSavedRef = useRef(content);
  // Teardown callbacks for in-flight pointer drags (column/row resize,
  // auto-fill). Each drag attaches window-level mousemove/mouseup
  // listeners that normally detach on mouseup; if the editor unmounts
  // mid-drag those would otherwise stay bound to `window` and keep
  // firing against a torn-down grid. We register each drag's teardown
  // here and run any still-pending ones on unmount.
  const dragTeardownsRef = useRef<Set<() => void>>(new Set());

  const debouncedSave = useCallback(
    (data: SheetContent) => {
      const json = JSON.stringify(data);
      // Publish the draft immediately so the parent (ArtifactEditorPage)
      // can capture it for export even before the debounced save fires.
      onDraftChange?.(json);
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        lastSavedRef.current = json;
        onSave(json);
      }, autoSaveMs);
    },
    [onSave, onDraftChange, autoSaveMs],
  );

  useEffect(() => {
    const dragTeardowns = dragTeardownsRef.current;
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      // Detach any drag listeners left bound to `window` by an
      // interaction that was still in progress when the editor
      // unmounted (e.g. mouse button held while navigating away).
      for (const teardown of [...dragTeardowns]) teardown();
      dragTeardowns.clear();
    };
  }, []);

  // Sync external content prop changes (e.g., version restore)
  useEffect(() => {
    if (content !== lastSavedRef.current) {
      setSheet(parseSheetContent(content));
      lastSavedRef.current = content;
    }
  }, [content]);

  useEffect(() => {
    if (!editingCell || !inputRef.current) return;
    // Don't steal focus when the user is actively typing in the
    // formula bar — that bar drives `editingCell` via onChange, so
    // a naive .focus() would yank focus out of it on every keystroke.
    // Only move focus into the in-cell input when nothing in the
    // formula bar (or any other input) currently holds focus.
    if (
      formulaBarRef.current &&
      document.activeElement === formulaBarRef.current
    ) {
      return;
    }
    inputRef.current.focus();
  }, [editingCell]);

  const updateCell = useCallback(
    (rowIdx: number, colIdx: number, value: string) => {
      setSheet((prev) => {
        // `updateCellInRows` preserves every untouched row's reference
        // identity. The previous shape (`prev.rows.map((r) => [...r])`)
        // cloned EVERY row on every single-cell edit, defeating
        // `incrementalRecalc`'s O(1) `prevRow === nextRow` short-circuit
        // and forcing the dirty diff into O(rows × cols) cell-by-cell
        // comparison even for a one-character keystroke. With the
        // helper, only the edited row is freshly allocated; the rest
        // survive by reference, so the diff cost stays at O(cols of
        // edited row) per keystroke. Devin Review PR #83.
        const newRows = updateCellInRows(
          prev.rows,
          prev.columns.length,
          rowIdx,
          colIdx,
          value,
        );
        const updated = { ...prev, rows: newRows };
        debouncedSave(updated);
        return updated;
      });
    },
    [debouncedSave],
  );

  const addColumn = useCallback(() => {
    setSheet((prev) => {
      // Append a fresh column via the structural helper so every
      // column-indexed field (formats / validations / conditional rules
      // / widths / freeze) is carried over — a bare rebuild used to wipe
      // all sheet metadata on every "+ Column".
      const updated = insertColumnAt(
        prev,
        prev.columns.length,
        columnLabel(prev.columns.length),
      );
      debouncedSave(updated);
      return updated;
    });
  }, [debouncedSave]);

  const removeColumn = useCallback(
    (colIdx: number) => {
      setSheet((prev) => {
        // Preserves all metadata and shifts every column-indexed key
        // past `colIdx` down by one (no silent data loss, no stale keys).
        const updated = removeColumnAt(prev, colIdx);
        if (updated === prev) return prev;
        debouncedSave(updated);
        return updated;
      });
    },
    [debouncedSave],
  );

  const addRow = useCallback(() => {
    setSheet((prev) => {
      const updated = insertRowAt(prev, prev.rows.length);
      debouncedSave(updated);
      return updated;
    });
  }, [debouncedSave]);

  const removeRow = useCallback(
    (rowIdx: number) => {
      setSheet((prev) => {
        const updated = removeRowAt(prev, rowIdx);
        if (updated === prev) return prev;
        debouncedSave(updated);
        return updated;
      });
    },
    [debouncedSave],
  );

  const startEdit = (rowIdx: number, colIdx: number) => {
    // Checkbox cells are toggled via their checkbox, never text-edited.
    if (
      getColumnValidation(sheet.validations, colIdx)?.kind === "checkbox"
    ) {
      return;
    }
    const value = sheet.rows[rowIdx]?.[colIdx] ?? "";
    setEditingCell({ row: rowIdx, col: colIdx });
    setSelection(selectionFromCell({ row: rowIdx, col: colIdx }));
    setEditValue(value);
  };

  /**
   * Mouse-click dispatcher. Modifier keys steer the selection
   * model:
   *   - plain click: collapse to a single cell
   *   - shift+click: extend the primary range, preserving anchor
   *   - ctrl/cmd+click: add a disjoint extra range
   *   - plain re-click on the active cell: promote to edit mode
   */
  const selectCell = (
    rowIdx: number,
    colIdx: number,
    modifiers: { shift?: boolean; ctrl?: boolean } = {},
  ) => {
    const target: CellCoord = { row: rowIdx, col: colIdx };
    if (modifiers.shift && selection) {
      setSelection(extendSelection(selection, target));
      return;
    }
    if (modifiers.ctrl && selection) {
      setSelection(addSelection(selection, target));
      return;
    }
    if (
      activeCell &&
      activeCell.row === rowIdx &&
      activeCell.col === colIdx &&
      !editingCell
    ) {
      startEdit(rowIdx, colIdx);
      return;
    }
    setSelection(selectionFromCell(target));
  };

  const commitEdit = () => {
    if (editingCell) {
      updateCell(editingCell.row, editingCell.col, editValue);
      setEditingCell(null);
    }
  };

  // Apply a value typed into the formula bar to the active cell.
  // This is the keyboard/Enter path; blur also commits via
  // onBlur on the input. Tests rely on the Enter handler.
  const commitFormulaBar = useCallback(
    (raw: string) => {
      if (!activeCell) return;
      updateCell(activeCell.row, activeCell.col, raw);
    },
    [activeCell, updateCell],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!editingCell) return;
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      commitEdit();
      // Excel-style post-commit navigation:
      // Enter → down, Tab → right, Shift+Tab → left.
      const row = editingCell.row;
      const col = editingCell.col;
      if (e.key === "Tab") {
        const nextCol = e.shiftKey ? col - 1 : col + 1;
        if (nextCol >= 0 && nextCol < sheet.columns.length) {
          setSelection(selectionFromCell({ row, col: nextCol }));
        } else if (!e.shiftKey && row + 1 < sheet.rows.length) {
          setSelection(selectionFromCell({ row: row + 1, col: 0 }));
        }
      } else if (e.key === "Enter") {
        const nextRow = e.shiftKey ? row - 1 : row + 1;
        if (nextRow >= 0 && nextRow < sheet.rows.length) {
          setSelection(selectionFromCell({ row: nextRow, col }));
        }
      }
    } else if (e.key === "Escape") {
      setEditingCell(null);
    }
  };

  /**
   * grid-level keyboard handler. Active only
   * when no cell is currently in edit mode; arrow keys move the
   * selection, shift+arrow extends, Enter promotes to edit, plain
   * letter/digit keypress also promotes to edit and seeds the
   * value with the pressed char (Excel UX).
   */
  const handleGridKeyDown = (e: React.KeyboardEvent) => {
    if (editingCell) return;
    if (!selection) return;
    const isArrow =
      e.key === "ArrowUp" ||
      e.key === "ArrowDown" ||
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight";
    if (isArrow) {
      e.preventDefault();
      const maxRow = Math.max(0, sheet.rows.length - 1);
      const maxCol = Math.max(0, sheet.columns.length - 1);
      setSelection(
        moveByArrow(
          selection,
          e.key as "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight",
          maxRow,
          maxCol,
          e.shiftKey,
        ),
      );
      return;
    }
    if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      const { row, col } = selection.anchor;
      startEdit(row, col);
      return;
    }
    // A printable single character that isn't a modifier-shortcut
    // promotes the active cell into edit mode, seeding the value
    // with the typed character (matches Excel's overwrite UX).
    if (
      e.key.length === 1 &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
      const { row, col } = selection.anchor;
      // Checkbox-validated cells are never free-text editable; typing a
      // character must not bypass the same guard `startEdit` applies on
      // Enter/F2 (it would otherwise overwrite TRUE/FALSE with junk).
      // Space toggles the box, matching the checkbox's own affordance.
      if (getColumnValidation(sheet.validations, col)?.kind === "checkbox") {
        if (e.key === " ") {
          const cur = sheet.rows[row]?.[col] ?? "";
          updateCell(row, col, cur === CHECKBOX_TRUE ? CHECKBOX_FALSE : CHECKBOX_TRUE);
        }
        return;
      }
      setEditingCell({ row, col });
      setEditValue(e.key);
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      // Clear every cell in the current selection (primary +
      // extras). One state update so the debounced save fires
      // once per Delete keystroke, not once per cleared cell.
      //
      // `updateCellsInRows` preserves reference identity for
      // every row that doesn't intersect the selection — so a
      // Delete on a single-row selection in a 10k-row sheet
      // touches one row's reference, not 10k. Same row-skip
      // optimisation `incrementalRecalc` relies on.
      const cells = selectionCells(selection);
      // Filter to in-bounds cells so we don't auto-extend on
      // Delete (semantically wrong — Delete clears existing
      // cells, it doesn't materialise new ones beyond the
      // current grid).
      setSheet((prev) => {
        const edits: CellEdit[] = [];
        for (const { row, col } of cells) {
          const targetRow = prev.rows[row];
          if (targetRow && col < targetRow.length) {
            edits.push({ row, col, value: "" });
          }
        }
        if (edits.length === 0) return prev;
        const newRows = updateCellsInRows(
          prev.rows,
          prev.columns.length,
          edits,
        );
        const updated = { ...prev, rows: newRows };
        debouncedSave(updated);
        return updated;
      });
    }
  };

  // Memoize the evaluated value of every formula cell across
  // renders using incremental recalculation.
  //
  // Pre-PR-9 path : every render rebuilt the
  // entire `cellCache` from scratch by walking every formula cell
  // and calling the workbook resolver. The resolver's internal
  // cache prevented O(N²) re-evaluation within a single render,
  // but a sheet with thousands of formulas still re-parsed and
  // re-evaluated every one of them on every keystroke — even
  // single-cell edits that touched a single literal.
  //
  // PR-9 path: persist a `DependencyGraph` + per-cell result cache
  // across renders in a `useRef`. On each `sheet` change,
  // `incrementalRecalc` diffs the new rows against the previous
  // snapshot to find dirty cells, then re-evaluates ONLY the
  // dirty seeds and the cells transitively reading them. Untouched
  // formulas hit the cache and return in O(1). For a 10k-formula
  // sheet where the user types in one cell, the work drops from
  // O(10k) to O(1 + |dependents|) per keystroke.
  //
  // The state is held in a `useRef` (not `useState`) because
  // mutating the cache during render would otherwise trigger an
  // infinite re-render loop. The cache is read imperatively by
  // `getCellDisplay` below; React doesn't need to know about
  // cache writes since the sheet state itself is what changes and
  // drives re-renders.
  const recalcState = useRef<IncrementalRecalcState>(
    makeIncrementalRecalcState(),
  );
  const cellCache = useMemo(
    () => incrementalRecalc(sheet, recalcState.current),
    [sheet],
  );
  // The active sheet's canonical name — keeps the `getCellDisplay`
  // lookup keyed identically to the qualified keys
  // `incrementalRecalc` writes into the cache. Memoised on the
  // `sheet` reference to avoid an extra workbook synthesis on every
  // render.
  const activeName = useMemo(() => activeSheetName(sheet), [sheet]);

  const getCellDisplay = (
    value: string,
    rowIdx: number,
    colIdx: number,
  ): string => {
    const fmt = getCellFormat(sheet.formats, rowIdx, colIdx);
    if (!value.startsWith("=")) {
      // Literals only route through the format engine when a number
      // format is set, so plain text renders byte-for-byte as typed.
      return fmt?.numberFormat ? applyCellFormat(value, fmt) : value;
    }
    let cached = cellCache.get(cellKey(rowIdx, colIdx, activeName));
    if (cached === undefined) {
      // Shouldn't happen — `cellCache` is built from the same
      // `sheet` we're rendering — but fall back to a one-off
      // evaluation rather than rendering the raw formula text.
      cached = evaluateFormula(value, sheet);
    }
    if (cached === null) return "";
    if (isFormulaError(cached)) return cached.code;
    return fmt?.numberFormat ? applyCellFormat(cached, fmt) : String(cached);
  };

  // Raw text of the currently-active cell, surfaced in the formula
  // bar above the grid. Defaults to the empty string when nothing
  // is selected, matching Excel.
  const formulaBarValue = useMemo(() => {
    if (!activeCell) return "";
    return sheet.rows[activeCell.row]?.[activeCell.col] ?? "";
  }, [activeCell, sheet]);

  const activeAddress = useMemo(() => {
    if (!activeCell) return "";
    return `${columnLabel(activeCell.col)}${activeCell.row + 1}`;
  }, [activeCell]);

  const importCSV = useCallback(
    (csvText: string) => {
      const lines = parseCSVLines(csvText.trim());
      if (lines.length === 0) return;
      const headers = lines[0].map((h) => h.trim());
      const rows = lines.slice(1).map((row) => row.map((cell) => cell.trim()));
      const updated: SheetContent = { columns: headers, rows };
      setSheet(updated);
      debouncedSave(updated);
    },
    [debouncedSave],
  );

  // Replace the active sheet's conditional-formatting rules and persist.
  // An empty array drops the field entirely so a sheet with no rules
  // stays byte-identical to its pre-feature JSON.
  const setConditionalRules = useCallback(
    (rules: ConditionalFormatRule[]) => {
      setSheet((prev) => {
        const next: SheetContent = { ...prev };
        if (rules.length === 0) delete next.conditionalRules;
        else next.conditionalRules = rules;
        debouncedSave(next);
        return next;
      });
    },
    [debouncedSave],
  );

  // Replace the workbook's named ranges and persist. An empty array
  // drops the field so a workbook with no names stays byte-identical
  // to its pre-feature JSON.
  const setNamedRanges = useCallback(
    (ranges: SheetNamedRange[]) => {
      setSheet((prev) => {
        const next: SheetContent = { ...prev };
        if (ranges.length === 0) delete next.namedRanges;
        else next.namedRanges = ranges;
        debouncedSave(next);
        return next;
      });
    },
    [debouncedSave],
  );

  // Replace the active sheet's data-validation rules and persist. An
  // empty/undefined map drops the field so a sheet with no validations
  // stays byte-identical to its pre-feature JSON.
  const setValidations = useCallback(
    (validations: ValidationMap | undefined) => {
      setSheet((prev) => {
        const next: SheetContent = { ...prev };
        if (!validations || Object.keys(validations).length === 0)
          delete next.validations;
        else next.validations = validations;
        debouncedSave(next);
        return next;
      });
    },
    [debouncedSave],
  );

  // Replace the sheet's charts and persist. An empty array drops the
  // field so a sheet with no charts stays byte-identical to its
  // pre-feature JSON.
  const setCharts = useCallback(
    (charts: ChartSpec[]) => {
      setSheet((prev) => {
        const next: SheetContent = { ...prev };
        if (charts.length === 0) delete next.charts;
        else next.charts = charts;
        debouncedSave(next);
        return next;
      });
    },
    [debouncedSave],
  );

  // Numeric value of a cell for charting: a formula's computed result
  // (via the recalc cache) or a literal parsed as a number; `null` for
  // blanks, text, booleans, and errors so they're skipped in plots.
  const chartValueAt = useCallback(
    (row: number, col: number): number | null => {
      const raw = sheet.rows[row]?.[col] ?? "";
      if (raw === "") return null;
      if (raw.startsWith("=")) {
        let cached = cellCache.get(cellKey(row, col, activeName));
        if (cached === undefined) cached = evaluateFormula(raw, sheet);
        return typeof cached === "number" && Number.isFinite(cached)
          ? cached
          : null;
      }
      const n = Number(raw.trim());
      return raw.trim() !== "" && Number.isFinite(n) ? n : null;
    },
    [sheet, cellCache, activeName],
  );

  // Displayed text of a cell for chart labels / headers.
  const chartTextAt = useCallback(
    (row: number, col: number): string =>
      getCellDisplay(sheet.rows[row]?.[col] ?? "", row, col),
    // getCellDisplay closes over `sheet`/`cellCache`; depend on `sheet`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sheet],
  );

  // Each chart's live data, re-derived whenever the sheet changes. The
  // pure extractor never throws on a bad range — it yields empty data,
  // which `SheetChart` renders as a friendly "no data" state.
  const renderedCharts = useMemo(
    () =>
      (sheet.charts ?? []).map((spec) => ({
        spec,
        data:
          extractChartData(spec, chartValueAt, chartTextAt) ?? {
            labels: [],
            series: [],
          },
      })),
    [sheet.charts, chartValueAt, chartTextAt],
  );

  // Apply a manual-format patch to every cell in the current selection
  // (falls back to the active cell). Used by the format toolbar.
  const applySelectionFormat = useCallback(
    (patch: Partial<CellFormat>) => {
      const cells = selection
        ? selectionCells(selection)
        : activeCell
          ? [activeCell]
          : [];
      if (cells.length === 0) return;
      setSheet((prev) => {
        const nextFormats = applyFormatPatch(prev.formats, cells, patch);
        const next: SheetContent = { ...prev };
        if (nextFormats) next.formats = nextFormats;
        else delete next.formats;
        debouncedSave(next);
        return next;
      });
    },
    [selection, activeCell, debouncedSave],
  );

  // Toggle a boolean format (bold/italic/underline) across the
  // selection: on if any cell lacks it, off when all already have it.
  const toggleSelectionFormat = useCallback(
    (key: BoolFormatKey) => {
      const cells = selection
        ? selectionCells(selection)
        : activeCell
          ? [activeCell]
          : [];
      if (cells.length === 0) return;
      setSheet((prev) => {
        const nextFormats = toggleBoolFormat(prev.formats, cells, key);
        const next: SheetContent = { ...prev };
        if (nextFormats) next.formats = nextFormats;
        else delete next.formats;
        debouncedSave(next);
        return next;
      });
    },
    [selection, activeCell, debouncedSave],
  );

  // Whether the whole selection currently carries a boolean format —
  // drives the toolbar button's pressed state.
  const selectionHas = useCallback(
    (key: BoolFormatKey): boolean => {
      const cells = selection
        ? selectionCells(selection)
        : activeCell
          ? [activeCell]
          : [];
      return allCellsHave(sheet.formats, cells, key);
    },
    [selection, activeCell, sheet.formats],
  );

  // Number-format of the active cell, for the toolbar's format <select>.
  const activeNumberFormat = useMemo(() => {
    if (!activeCell) return undefined;
    return getCellFormat(sheet.formats, activeCell.row, activeCell.col)
      ?.numberFormat;
  }, [activeCell, sheet.formats]);

  // Insert an (already-validated) formula into the active cell. Used by
  // the AI assistant — the formula has passed `validateGeneratedFormula`
  // before reaching here, so this never blind-writes unparseable text.
  const insertFormulaIntoActiveCell = useCallback(
    (formula: string) => {
      const target = activeCell;
      if (!target) return;
      updateCell(target.row, target.col, formula);
    },
    [activeCell, updateCell],
  );

  // A1-style reference of the current selection's primary range
  // (e.g. `A1:C10`, or just `B2` for a single cell). Fed to the AI
  // assistant as grounding context.
  const selectionRef = useMemo(() => {
    if (!selection) return undefined;
    const { r1, c1, r2, c2 } = normalizeRange(selection.primary);
    const a = `${columnLabel(c1)}${r1 + 1}`;
    const b = `${columnLabel(c2)}${r2 + 1}`;
    return a === b ? a : `${a}:${b}`;
  }, [selection]);

  // ----------------------------------------------------------------
  // copy / paste via the system clipboard.
  // ----------------------------------------------------------------

  const copySelection = useCallback(async () => {
    if (!selection) return;
    const tsv = selectionToTSV(sheet.rows, selection);
    // `navigator.clipboard.writeText` requires a secure context;
    // jsdom (test env) shims it via `document.execCommand`, so we
    // fall back when the modern API isn't available.
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(tsv);
      }
    } catch {
      // Permissions blocked — swallow; user can still copy via
      // browser-native shortcut.
    }
  }, [selection, sheet.rows]);

  const pasteAt = useCallback(
    (tsv: string) => {
      if (!activeCell) return;
      const parsed = parseTSV(tsv);
      if (parsed.length === 0) return;
      setSheet((prev) => {
        const fakeTab = {
          name: "__active",
          columns: prev.columns,
          rows: prev.rows,
        };
        const next = applyTSVAt(fakeTab, activeCell.row, activeCell.col, parsed, {
          columnLabelFor: columnLabel,
        });
        const updated: SheetContent = {
          ...prev,
          columns: next.columns,
          rows: next.rows,
        };
        debouncedSave(updated);
        return updated;
      });
    },
    [activeCell, debouncedSave],
  );

  // Wire Ctrl/Cmd+C and Ctrl/Cmd+V at the grid level. Listening
  // on the grid (not document) keeps the shortcuts scoped — the
  // shortcut only triggers when focus is inside the SheetEditor.
  const handleClipboardKey = useCallback(
    (e: KeyboardEvent) => {
      const wrapper = gridWrapperRef.current;
      if (!wrapper) return;
      if (!wrapper.contains(document.activeElement)) return;
      if (editingCell) return; // let the cell input handle text-edit Ctrl+C/V
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        void copySelection();
      } else if (e.key === "v" || e.key === "V") {
        e.preventDefault();
        navigator.clipboard
          ?.readText?.()
          .then((text) => pasteAt(text))
          .catch(() => {
            /* permissions blocked — ignore */
          });
      }
    },
    [copySelection, editingCell, pasteAt],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleClipboardKey);
    return () => document.removeEventListener("keydown", handleClipboardKey);
  }, [handleClipboardKey]);

  // ----------------------------------------------------------------
  // column / row resize via drag handles.
  // ----------------------------------------------------------------

  // Wire up a window-level pointer drag with guaranteed teardown.
  // `onMove` runs for every mousemove; `onCommit` (optional) runs once
  // on mouseup after the listeners are detached. The teardown is also
  // registered in `dragTeardownsRef` so an unmount mid-drag tears the
  // listeners down too — preventing a zombie handler from firing
  // against an unmounted grid.
  const beginPointerDrag = useCallback(
    (onMove: (ev: MouseEvent) => void, onCommit?: () => void) => {
      const teardown = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", handleUp);
        dragTeardownsRef.current.delete(teardown);
      };
      const handleUp = () => {
        teardown();
        onCommit?.();
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", handleUp);
      dragTeardownsRef.current.add(teardown);
    },
    [],
  );

  const beginColumnResize = useCallback(
    (colIdx: number, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth =
        sheet.columnWidths?.[colIdx] ?? DEFAULT_COLUMN_WIDTH;
      const onMove = (ev: MouseEvent) => {
        const newWidth = Math.max(
          MIN_COLUMN_WIDTH,
          startWidth + (ev.clientX - startX),
        );
        setSheet((prev) => {
          const widths = [...(prev.columnWidths ?? [])];
          while (widths.length <= colIdx) widths.push(undefined);
          widths[colIdx] = newWidth;
          const updated = { ...prev, columnWidths: widths };
          debouncedSave(updated);
          return updated;
        });
      };
      beginPointerDrag(onMove);
    },
    [sheet.columnWidths, debouncedSave, beginPointerDrag],
  );

  const beginRowResize = useCallback(
    (rowIdx: number, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startY = e.clientY;
      const startHeight =
        sheet.rowHeights?.[rowIdx] ?? DEFAULT_ROW_HEIGHT;
      const onMove = (ev: MouseEvent) => {
        const newHeight = Math.max(
          MIN_ROW_HEIGHT,
          startHeight + (ev.clientY - startY),
        );
        setSheet((prev) => {
          const heights = [...(prev.rowHeights ?? [])];
          while (heights.length <= rowIdx) heights.push(undefined);
          heights[rowIdx] = newHeight;
          const updated = { ...prev, rowHeights: heights };
          debouncedSave(updated);
          return updated;
        });
      };
      beginPointerDrag(onMove);
    },
    [sheet.rowHeights, debouncedSave, beginPointerDrag],
  );

  // ----------------------------------------------------------------
  // freeze rows / columns via right-click menu.
  // ----------------------------------------------------------------

  const freezeAt = useCallback(
    (kind: "row" | "col", index: number) => {
      setSheet((prev) => {
        const updated: SheetContent =
          kind === "row"
            ? { ...prev, frozenRows: index + 1 }
            : { ...prev, frozenCols: index + 1 };
        debouncedSave(updated);
        return updated;
      });
      setContextMenu(null);
    },
    [debouncedSave],
  );

  const unfreeze = useCallback(() => {
    setSheet((prev) => {
      const updated = { ...prev, frozenRows: 0, frozenCols: 0 };
      debouncedSave(updated);
      return updated;
    });
    setContextMenu(null);
  }, [debouncedSave]);

  // ----------------------------------------------------------------
  // sort all data rows by a column (Sheets' "Sort sheet A→Z / Z→A").
  // ----------------------------------------------------------------

  const sortByColumn = useCallback(
    (col: number, ascending: boolean) => {
      setSheet((prev) => {
        // Sort by each cell's underlying value, not its formatted
        // display: a formula sorts by its evaluated result, and a
        // currency-formatted number sorts numerically rather than by
        // the `$1,234.50` string.
        const sortKeyAt = (row: number): string => {
          const raw = prev.rows[row]?.[col] ?? "";
          if (!raw.startsWith("=")) return raw;
          const cached =
            cellCache.get(cellKey(row, col, activeName)) ??
            evaluateFormula(raw, prev);
          if (cached === null) return "";
          if (isFormulaError(cached)) return cached.code;
          return String(cached);
        };
        const { rows, formats } = sortSheetByColumn(
          prev.rows,
          prev.formats,
          col,
          ascending,
          sortKeyAt,
        );
        const next: SheetContent = { ...prev, rows };
        if (formats) next.formats = formats;
        else delete next.formats;
        debouncedSave(next);
        return next;
      });
      setContextMenu(null);
    },
    [cellCache, activeName, debouncedSave],
  );

  // Close the context menu on any outside click. Listening on
  // document with a capture-phase handler is the most reliable
  // pattern — React onClick wouldn't fire for clicks outside the
  // menu element.
  useEffect(() => {
    if (!contextMenu) return;
    const onAnyClick = () => setContextMenu(null);
    document.addEventListener("mousedown", onAnyClick);
    return () => document.removeEventListener("mousedown", onAnyClick);
  }, [contextMenu]);

  // ----------------------------------------------------------------
  // auto-fill drag from the selection handle.
  // ----------------------------------------------------------------

  /**
   * Apply an auto-fill given a finalised direction + length. Pure
   * sheet mutation — does not interact with selection state
   * (selection extension to cover the new range happens separately).
   */
  const applyAutoFill = useCallback(
    (direction: FillDirection, length: number) => {
      if (!selection) return;
      const { r1, c1, r2, c2 } = normalizeRange(selection.primary);
      setSheet((prev) => {
        // Collect every (row, col, value) write the fill produces
        // FIRST, then hand the batch to `updateCellsInRows`. This
        // preserves reference identity for every row outside the
        // fill range — so a vertical fill on a 3-column selection
        // in a 10k-row sheet only allocates fresh arrays for the
        // rows it actually touches, not all 10k. The source reads
        // come from `prev.rows` (the pre-edit state) so we never
        // race with our own writes.
        const edits: CellEdit[] = [];
        if (direction === "down" || direction === "up") {
          // Vertical fill: each column gets its own source slice
          // + filled series.
          for (let col = c1; col <= c2; col++) {
            const source: string[] = [];
            for (let row = r1; row <= r2; row++) {
              source.push(prev.rows[row]?.[col] ?? "");
            }
            const filled = fillSeries(source, length, direction);
            for (let i = 0; i < length; i++) {
              const targetRow =
                direction === "down" ? r2 + 1 + i : r1 - 1 - i;
              if (targetRow < 0) continue;
              edits.push({ row: targetRow, col, value: filled[i] });
            }
          }
        } else {
          // Horizontal fill: each row gets its own source slice +
          // filled series.
          for (let row = r1; row <= r2; row++) {
            const source: string[] = [];
            for (let col = c1; col <= c2; col++) {
              source.push(prev.rows[row]?.[col] ?? "");
            }
            const filled = fillSeries(source, length, direction);
            for (let i = 0; i < length; i++) {
              const targetCol =
                direction === "right" ? c2 + 1 + i : c1 - 1 - i;
              if (targetCol < 0) continue;
              edits.push({ row, col: targetCol, value: filled[i] });
            }
          }
        }
        if (edits.length === 0) return prev;
        // Widen the column header array when a rightward fill
        // extends past the current right edge. Without this the
        // newly-filled cells would land in `rows[r]` past
        // `columns.length`, and the grid renderer (which iterates
        // `sheet.columns.map(...)`) would silently drop them — data
        // written, nothing displayed. Devin Review PR #86
        // (pre-existing latent bug). `down`/`up`/`left`
        // never grow `columns`, so they skip this branch.
        let columns = prev.columns;
        if (direction === "right") {
          const maxTargetCol = c2 + length;
          if (maxTargetCol >= prev.columns.length) {
            columns = [...prev.columns];
            while (columns.length <= maxTargetCol) {
              columns.push(columnLabel(columns.length));
            }
          }
        }
        const newRows = updateCellsInRows(
          prev.rows,
          columns.length,
          edits,
        );
        const updated = { ...prev, columns, rows: newRows };
        debouncedSave(updated);
        return updated;
      });
      // Extend the selection's primary range to cover the new
      // fill region so subsequent operations apply to the whole
      // visible series.
      setSelection((prev) => {
        if (!prev) return prev;
        const { r1, c1, r2, c2 } = normalizeRange(prev.primary);
        const newRange =
          direction === "down"
            ? extendSelection(prev, { row: r2 + length, col: c2 })
            : direction === "up"
              ? extendSelection(prev, { row: Math.max(0, r1 - length), col: c2 })
              : direction === "right"
                ? extendSelection(prev, { row: r2, col: c2 + length })
                : extendSelection(prev, { row: r2, col: Math.max(0, c1 - length) });
        return newRange;
      });
    },
    [selection, debouncedSave],
  );

  const beginAutoFill = useCallback(
    (e: React.MouseEvent) => {
      if (!selection) return;
      e.preventDefault();
      e.stopPropagation();
      const { r1, c1, r2, c2 } = normalizeRange(selection.primary);
      // Track-but-don't-commit until mouse-up; we just need the
      // final hover target. Find the cell under (x,y) via DOM
      // ancestry — each <td> is annotated with data-row/data-col
      // for exactly this lookup.
      let hoverRow = r2;
      let hoverCol = c2;
      const onMove = (ev: MouseEvent) => {
        // `elementFromPoint` is a layout-dependent DOM API that isn't
        // available in every environment (e.g. jsdom). Guard so a
        // mousemove that arrives without it simply doesn't update the
        // hover target rather than throwing.
        if (typeof document.elementFromPoint !== "function") return;
        const target = document.elementFromPoint(
          ev.clientX,
          ev.clientY,
        );
        const td = target?.closest("td[data-row]");
        if (!td) return;
        const row = Number(td.getAttribute("data-row"));
        const col = Number(td.getAttribute("data-col"));
        if (!Number.isFinite(row) || !Number.isFinite(col)) return;
        hoverRow = row;
        hoverCol = col;
      };
      const onCommit = () => {
        // Determine fill direction + length from the hover target.
        let direction: FillDirection | null = null;
        let length = 0;
        if (hoverRow > r2) {
          direction = "down";
          length = hoverRow - r2;
        } else if (hoverRow < r1) {
          direction = "up";
          length = r1 - hoverRow;
        } else if (hoverCol > c2) {
          direction = "right";
          length = hoverCol - c2;
        } else if (hoverCol < c1) {
          direction = "left";
          length = c1 - hoverCol;
        }
        if (!direction || length === 0) return;
        applyAutoFill(direction, length);
      };
      beginPointerDrag(onMove, onCommit);
    },
    [selection, applyAutoFill, beginPointerDrag],
  );

  // Helpers used in render — derived state only.
  const colWidth = (i: number): number =>
    sheet.columnWidths?.[i] ?? DEFAULT_COLUMN_WIDTH;
  const rowHeight = (i: number): number =>
    sheet.rowHeights?.[i] ?? DEFAULT_ROW_HEIGHT;
  const isFrozenCol = (i: number): boolean =>
    (sheet.frozenCols ?? 0) > i;
  const isFrozenRow = (i: number): boolean =>
    (sheet.frozenRows ?? 0) > i;
  // For sticky positioning we need the cumulative `left` / `top`
  // offset of each frozen index. Memoised against the relevant
  // dimension arrays so we don't reduce them on every cell.
  const frozenColLefts = useMemo(() => {
    const out: number[] = [];
    let cum = 0;
    for (let i = 0; i < sheet.columns.length; i++) {
      out.push(cum);
      cum += colWidth(i);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet.columns.length, sheet.columnWidths]);
  const frozenRowTops = useMemo(() => {
    const out: number[] = [];
    let cum = 0;
    for (let i = 0; i < sheet.rows.length; i++) {
      out.push(cum);
      cum += rowHeight(i);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet.rows.length, sheet.rowHeights]);

  // When any row has been resized away from the default height, the
  // uniform virtualization model would drift the scrollbar. Build a
  // cumulative prefix-sum of row tops (length `rows.length + 1`,
  // ending in the total content height) so the windowing math is exact.
  // When every row is the default height the uniform model is already
  // exact, so we pass `undefined` and keep the cheaper path.
  const hasCustomRowHeights = useMemo(
    () =>
      !!sheet.rowHeights &&
      sheet.rowHeights.some((h) => !!h && h !== DEFAULT_ROW_HEIGHT),
    [sheet.rowHeights],
  );
  const rowOffsets = useMemo<number[] | undefined>(() => {
    if (!hasCustomRowHeights) return undefined;
    const out = new Array<number>(sheet.rows.length + 1);
    out[0] = 0;
    for (let i = 0; i < sheet.rows.length; i++) {
      out[i + 1] = out[i] + rowHeight(i);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet.rows.length, sheet.rowHeights, hasCustomRowHeights]);

  // ── row virtualization ────────────────────────────────────────
  // Window the body for large sheets so only the rows near the
  // viewport are in the DOM. `useVirtualRows` reports the full range
  // (and zero padding) when disabled, so the small-sheet render path
  // is byte-for-byte unchanged.
  const frozenRowCount = Math.min(sheet.frozenRows ?? 0, sheet.rows.length);
  const virtualizeRows = sheet.rows.length >= VIRTUALIZE_ROW_THRESHOLD;
  const {
    startIndex: rowWindowStart,
    endIndex: rowWindowEnd,
    topPad: rowTopPad,
    bottomPad: rowBottomPad,
    onScroll: onGridScroll,
  } = useVirtualRows(gridWrapperRef, {
    rowCount: sheet.rows.length,
    rowHeight: DEFAULT_ROW_HEIGHT,
    rowOffsets,
    enabled: virtualizeRows,
    frozenLeadingRows: frozenRowCount,
  });

  type RowRenderItem =
    | { type: "row"; ri: number }
    | { type: "spacer"; key: string; height: number };
  const rowRenderPlan = useMemo<RowRenderItem[]>(() => {
    const plan: RowRenderItem[] = [];
    if (!virtualizeRows) {
      for (let i = 0; i < sheet.rows.length; i++) {
        plan.push({ type: "row", ri: i });
      }
      return plan;
    }
    // Frozen leading rows always render so they can stay pinned.
    for (let i = 0; i < frozenRowCount; i++) {
      plan.push({ type: "row", ri: i });
    }
    if (rowTopPad > 0) {
      plan.push({
        type: "spacer",
        key: "sheet-virtual-top-pad",
        height: rowTopPad,
      });
    }
    for (let i = rowWindowStart; i <= rowWindowEnd; i++) {
      plan.push({ type: "row", ri: i });
    }
    if (rowBottomPad > 0) {
      plan.push({
        type: "spacer",
        key: "sheet-virtual-bottom-pad",
        height: rowBottomPad,
      });
    }
    return plan;
  }, [
    virtualizeRows,
    sheet.rows.length,
    frozenRowCount,
    rowTopPad,
    rowBottomPad,
    rowWindowStart,
    rowWindowEnd,
  ]);

  return (
    <div
      className="sheet-editor"
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
    >
      <div className="sheet-toolbar">
        <button type="button" className="btn-sm" onClick={addColumn}>
          + Column
        </button>
        <button type="button" className="btn-sm" onClick={addRow}>
          + Row
        </button>
        <button
          type="button"
          className="btn-sm"
          onClick={() => {
            const csv = window.prompt("Paste CSV content:");
            if (csv) importCSV(csv);
          }}
        >
          Import CSV
        </button>
        <button
          type="button"
          className={cfOpen ? "btn-sm active" : "btn-sm"}
          aria-pressed={cfOpen}
          data-testid="sheet-conditional-format-toggle"
          onClick={() => setCfOpen((open) => !open)}
        >
          Conditional formatting
          {sheet.conditionalRules && sheet.conditionalRules.length > 0
            ? ` (${sheet.conditionalRules.length})`
            : ""}
        </button>
        <button
          type="button"
          className={nrOpen ? "btn-sm active" : "btn-sm"}
          aria-pressed={nrOpen}
          data-testid="sheet-named-ranges-toggle"
          onClick={() => setNrOpen((open) => !open)}
        >
          Named ranges
          {sheet.namedRanges && sheet.namedRanges.length > 0
            ? ` (${sheet.namedRanges.length})`
            : ""}
        </button>
        <button
          type="button"
          className={aiOpen ? "btn-sm active" : "btn-sm"}
          aria-pressed={aiOpen}
          data-testid="sheet-ai-toggle"
          onClick={() => setAiOpen((open) => !open)}
        >
          AI assistant
        </button>
        <button
          type="button"
          className={dvOpen ? "btn-sm active" : "btn-sm"}
          aria-pressed={dvOpen}
          data-testid="sheet-data-validation-toggle"
          onClick={() => setDvOpen((open) => !open)}
        >
          Data validation
          {sheet.validations && Object.keys(sheet.validations).length > 0
            ? ` (${Object.keys(sheet.validations).length})`
            : ""}
        </button>
        <button
          type="button"
          className={chartsOpen ? "btn-sm active" : "btn-sm"}
          aria-pressed={chartsOpen}
          data-testid="sheet-charts-toggle"
          onClick={() => setChartsOpen((open) => !open)}
        >
          Charts
          {sheet.charts && sheet.charts.length > 0
            ? ` (${sheet.charts.length})`
            : ""}
        </button>
      </div>

      <div
        className="sheet-toolbar sheet-format-toolbar"
        role="toolbar"
        aria-label="Cell formatting"
      >
        <button
          type="button"
          className={selectionHas("bold") ? "btn-sm active" : "btn-sm"}
          aria-pressed={selectionHas("bold")}
          aria-label="Bold"
          title="Bold"
          data-testid="sheet-format-bold"
          disabled={!activeCell}
          onClick={() => toggleSelectionFormat("bold")}
        >
          <strong>B</strong>
        </button>
        <button
          type="button"
          className={selectionHas("italic") ? "btn-sm active" : "btn-sm"}
          aria-pressed={selectionHas("italic")}
          aria-label="Italic"
          title="Italic"
          data-testid="sheet-format-italic"
          disabled={!activeCell}
          onClick={() => toggleSelectionFormat("italic")}
        >
          <em>I</em>
        </button>
        <button
          type="button"
          className={selectionHas("underline") ? "btn-sm active" : "btn-sm"}
          aria-pressed={selectionHas("underline")}
          aria-label="Underline"
          title="Underline"
          data-testid="sheet-format-underline"
          disabled={!activeCell}
          onClick={() => toggleSelectionFormat("underline")}
        >
          <span style={{ textDecoration: "underline" }}>U</span>
        </button>
        <span className="sheet-toolbar-sep" aria-hidden="true" />
        <label className="sheet-format-field">
          <select
            aria-label="Horizontal alignment"
            data-testid="sheet-format-align"
            disabled={!activeCell}
            value={
              activeCell
                ? getCellFormat(sheet.formats, activeCell.row, activeCell.col)
                    ?.align ?? "left"
                : "left"
            }
            onChange={(e) =>
              applySelectionFormat({
                align: e.target.value as CellFormat["align"],
              })
            }
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </label>
        <label className="sheet-format-field">
          <select
            aria-label="Number format"
            data-testid="sheet-format-number"
            disabled={!activeCell}
            value={
              NUMBER_FORMAT_PRESETS.find(
                (p) => p.pattern === activeNumberFormat,
              )?.id ?? "general"
            }
            onChange={(e) => {
              const preset = NUMBER_FORMAT_PRESETS.find(
                (p) => p.id === e.target.value,
              );
              applySelectionFormat({ numberFormat: preset?.pattern });
            }}
          >
            {NUMBER_FORMAT_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {cfOpen && (
        <ConditionalFormatPanel
          rules={sheet.conditionalRules ?? []}
          columns={sheet.columns}
          onChange={setConditionalRules}
          onClose={() => setCfOpen(false)}
        />
      )}

      {nrOpen && (
        <NamedRangePanel
          ranges={sheet.namedRanges ?? []}
          selectionRef={selectionRef}
          onChange={setNamedRanges}
          onClose={() => setNrOpen(false)}
        />
      )}

      {dvOpen && (
        <DataValidationPanel
          columns={sheet.columns}
          validations={sheet.validations ?? {}}
          onChange={setValidations}
          onClose={() => setDvOpen(false)}
        />
      )}

      {chartsOpen && (
        <ChartsPanel
          charts={sheet.charts ?? []}
          selectionRef={selectionRef}
          onChange={setCharts}
          onClose={() => setChartsOpen(false)}
        />
      )}

      {aiOpen && (
        <SheetAiPanel
          columns={sheet.columns}
          rows={sheet.rows}
          activeCellRef={activeAddress || undefined}
          activeFormula={formulaBarValue}
          selectionRef={selectionRef}
          onInsertFormula={insertFormulaIntoActiveCell}
          onClose={() => setAiOpen(false)}
        />
      )}

      <div className="sheet-formula-bar" data-testid="sheet-formula-bar">
        <span
          className="sheet-formula-bar-address"
          data-testid="sheet-formula-bar-address"
        >
          {activeAddress || "\u00a0"}
        </span>
        <span className="sheet-formula-bar-fx" aria-hidden="true">
          fx
        </span>
        <input
          ref={formulaBarRef}
          className="sheet-formula-bar-input"
          data-testid="sheet-formula-bar-input"
          aria-label="Formula bar"
          value={
            editingCell &&
            activeCell &&
            editingCell.row === activeCell.row &&
            editingCell.col === activeCell.col
              ? editValue
              : formulaBarValue
          }
          disabled={!activeCell}
          onChange={(e) => {
            if (!activeCell) return;
            if (
              !editingCell ||
              editingCell.row !== activeCell.row ||
              editingCell.col !== activeCell.col
            ) {
              setEditingCell(activeCell);
            }
            setEditValue(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitFormulaBar(
                editingCell &&
                  activeCell &&
                  editingCell.row === activeCell.row &&
                  editingCell.col === activeCell.col
                  ? editValue
                  : formulaBarValue,
              );
              setEditingCell(null);
            } else if (e.key === "Escape") {
              setEditingCell(null);
            }
          }}
          onBlur={() => {
            if (
              editingCell &&
              activeCell &&
              editingCell.row === activeCell.row &&
              editingCell.col === activeCell.col
            ) {
              commitFormulaBar(editValue);
              setEditingCell(null);
            }
          }}
        />
      </div>

      <div
        className="sheet-grid-wrapper"
        ref={gridWrapperRef}
        tabIndex={0}
        onKeyDown={handleGridKeyDown}
        onScroll={onGridScroll}
        style={{ flex: 1, minHeight: 0, overflow: "auto" }}
      >
        <table className="sheet-grid">
          <thead>
            <tr>
              <th className="sheet-row-number">#</th>
              {sheet.columns.map((col, ci) => {
                const frozen = isFrozenCol(ci);
                const stickyStyle: React.CSSProperties = frozen
                  ? {
                      position: "sticky",
                      left: frozenColLefts[ci],
                      zIndex: 3,
                      background: "var(--color-bg-secondary, #f5f5f5)",
                    }
                  : {};
                return (
                  <th
                    key={ci}
                    className={`sheet-col-header${frozen ? " frozen" : ""}`}
                    style={{ width: colWidth(ci), ...stickyStyle }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({
                        kind: "col",
                        index: ci,
                        x: e.clientX,
                        y: e.clientY,
                      });
                    }}
                  >
                    <span>{col}</span>
                    <button
                      type="button"
                      className="sheet-col-remove"
                      onClick={() => removeColumn(ci)}
                      title="Remove column"
                    >
                      x
                    </button>
                    <span
                      className="sheet-col-resize-handle"
                      data-testid={`sheet-col-resize-${ci}`}
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize column ${col}`}
                      onMouseDown={(e) => beginColumnResize(ci, e)}
                      style={{
                        position: "absolute",
                        right: 0,
                        top: 0,
                        width: 4,
                        height: "100%",
                        cursor: "col-resize",
                        userSelect: "none",
                      }}
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rowRenderPlan.map((item) => {
              if (item.type === "spacer") {
                return (
                  <tr
                    key={item.key}
                    data-testid={item.key}
                    aria-hidden="true"
                  >
                    <td
                      colSpan={sheet.columns.length + 1}
                      style={{ height: item.height, padding: 0, border: "none" }}
                    />
                  </tr>
                );
              }
              const ri = item.ri;
              const row = sheet.rows[ri];
              const rowFrozen = isFrozenRow(ri);
              return (
              <tr
                key={ri}
                style={{ height: rowHeight(ri) }}
              >
                <td
                  className={`sheet-row-number${rowFrozen ? " frozen" : ""}`}
                  style={
                    rowFrozen
                      ? {
                          position: "sticky",
                          top: frozenRowTops[ri],
                          zIndex: 2,
                          background:
                            "var(--color-bg-secondary, #f5f5f5)",
                        }
                      : {}
                  }
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({
                      kind: "row",
                      index: ri,
                      x: e.clientX,
                      y: e.clientY,
                    });
                  }}
                >
                  {ri + 1}
                  <button
                    type="button"
                    className="sheet-row-remove"
                    onClick={() => removeRow(ri)}
                    title="Remove row"
                  >
                    x
                  </button>
                  <span
                    className="sheet-row-resize-handle"
                    data-testid={`sheet-row-resize-${ri}`}
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label={`Resize row ${ri + 1}`}
                    onMouseDown={(e) => beginRowResize(ri, e)}
                    style={{
                      position: "absolute",
                      bottom: 0,
                      left: 0,
                      height: 4,
                      width: "100%",
                      cursor: "row-resize",
                      userSelect: "none",
                    }}
                  />
                </td>
                {sheet.columns.map((_, ci) => {
                  const isEditing =
                    editingCell?.row === ri && editingCell?.col === ci;
                  const isActive =
                    activeCell?.row === ri && activeCell?.col === ci;
                  const isSelected = selection
                    ? selectionContains(selection, ri, ci)
                    : false;
                  const isFillHandle =
                    selection &&
                    !isEditing &&
                    (() => {
                      const { r2, c2 } = normalizeRange(
                        selection.primary,
                      );
                      return ri === r2 && ci === c2;
                    })();
                  const rawValue = row[ci] ?? "";
                  const displayValue = getCellDisplay(rawValue, ri, ci);
                  // Column data-validation (dropdown / checkbox), if any.
                  const validation = getColumnValidation(
                    sheet.validations,
                    ci,
                  );
                  const invalidValue =
                    validation !== undefined &&
                    !isValueAllowed(validation, rawValue);
                  // Conditional formatting reacts to the *displayed*
                  // value (computed result for formulas), translated
                  // through the same `cellFormatStyle` used by manual
                  // cell formats so styling stays consistent.
                  const conditionalStyle = cellFormatStyle(
                    conditionalStyleForCell(
                      sheet.conditionalRules,
                      ci,
                      displayValue,
                    ),
                  );
                  // Manual per-cell format (bold/align/colour/number).
                  // Conditional rules overlay it, matching Sheets.
                  const manualStyle = cellFormatStyle(
                    getCellFormat(sheet.formats, ri, ci),
                  );
                  const colFrozen = isFrozenCol(ci);
                  // Frozen cells need an OPAQUE background so scrolled
                  // content doesn't show through. Use the conditional-
                  // formatting colour when a rule matches (it's a solid
                  // colour) so the highlight stays visible on frozen
                  // rows/cols; otherwise fall back to the page colour.
                  // The shorthand `background` would otherwise reset the
                  // `backgroundColor` set by `conditionalStyle`.
                  const frozenBackground =
                    typeof conditionalStyle.backgroundColor === "string"
                      ? conditionalStyle.backgroundColor
                      : typeof manualStyle.backgroundColor === "string"
                        ? manualStyle.backgroundColor
                        : "var(--color-bg-page, #ffffff)";
                  const stickyStyle: React.CSSProperties =
                    colFrozen
                      ? {
                          position: "sticky",
                          left: frozenColLefts[ci],
                          zIndex: rowFrozen ? 3 : 1,
                          background: frozenBackground,
                        }
                      : rowFrozen
                        ? {
                            position: "sticky",
                            top: frozenRowTops[ri],
                            zIndex: 1,
                            background: frozenBackground,
                          }
                        : {};
                  return (
                    <td
                      key={ci}
                      data-row={ri}
                      data-col={ci}
                      data-testid={`sheet-cell-${ri}-${ci}`}
                      className={[
                        "sheet-cell",
                        isEditing ? "editing" : "",
                        isActive ? "active" : "",
                        isSelected ? "selected" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={{
                        width: colWidth(ci),
                        position: "relative",
                        ...manualStyle,
                        ...conditionalStyle,
                        outline: isSelected
                          ? "1px solid var(--color-primary, #1a73e8)"
                          : isActive
                            ? "2px solid var(--color-primary, #1a73e8)"
                            : undefined,
                        ...stickyStyle,
                      }}
                      onClick={(e) =>
                        selectCell(ri, ci, {
                          shift: e.shiftKey,
                          ctrl: e.ctrlKey || e.metaKey,
                        })
                      }
                      onDoubleClick={() => startEdit(ri, ci)}
                    >
                      {validation?.kind === "checkbox" ? (
                        <input
                          type="checkbox"
                          className="sheet-cell-checkbox"
                          data-testid={`sheet-checkbox-${ri}-${ci}`}
                          checked={rawValue === CHECKBOX_TRUE}
                          aria-label={`${columnLabel(ci)}${ri + 1} checkbox`}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() =>
                            updateCell(
                              ri,
                              ci,
                              rawValue === CHECKBOX_TRUE
                                ? CHECKBOX_FALSE
                                : CHECKBOX_TRUE,
                            )
                          }
                        />
                      ) : isEditing && validation?.kind === "list" ? (
                        <select
                          className="sheet-cell-select"
                          data-testid={`sheet-select-${ri}-${ci}`}
                          aria-label={`${columnLabel(ci)}${ri + 1} value`}
                          autoFocus
                          value={
                            validation.values.includes(rawValue)
                              ? rawValue
                              : ""
                          }
                          onChange={(e) => {
                            updateCell(ri, ci, e.target.value);
                            setEditingCell(null);
                          }}
                          onBlur={() => setEditingCell(null)}
                        >
                          <option value="">(blank)</option>
                          {validation.values.map((v) => (
                            <option key={v} value={v}>
                              {v}
                            </option>
                          ))}
                        </select>
                      ) : isEditing ? (
                        <input
                          ref={inputRef}
                          className="sheet-cell-input"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={handleKeyDown}
                        />
                      ) : (
                        <span className="sheet-cell-display">
                          {displayValue}
                        </span>
                      )}
                      {invalidValue && !isEditing && (
                        <span
                          className="sheet-dv-invalid"
                          data-testid={`sheet-dv-invalid-${ri}-${ci}`}
                          aria-label="Value not allowed by data validation"
                          title="Value not in the column's allowed list"
                          style={{
                            position: "absolute",
                            top: 0,
                            right: 0,
                            width: 0,
                            height: 0,
                            borderTop:
                              "6px solid var(--color-danger, #d93025)",
                            borderLeft: "6px solid transparent",
                          }}
                        />
                      )}
                      {isFillHandle && (
                        <span
                          className="sheet-fill-handle"
                          data-testid={`sheet-fill-handle-${ri}-${ci}`}
                          aria-label="Auto-fill drag handle"
                          role="button"
                          tabIndex={-1}
                          onMouseDown={beginAutoFill}
                          style={{
                            position: "absolute",
                            right: -4,
                            bottom: -4,
                            width: 8,
                            height: 8,
                            background:
                              "var(--color-primary, #1a73e8)",
                            border: "1px solid white",
                            cursor: "crosshair",
                            zIndex: 4,
                          }}
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {renderedCharts.length > 0 && (
        <div
          className="sheet-charts-strip"
          data-testid="sheet-charts-strip"
          aria-label="Charts"
        >
          {renderedCharts.map(({ spec, data }) => (
            <SheetChart
              key={spec.id}
              spec={spec}
              data={data}
              onRemove={() =>
                setCharts((sheet.charts ?? []).filter((c) => c.id !== spec.id))
              }
            />
          ))}
        </div>
      )}

      {contextMenu && (
        <ul
          className="sheet-context-menu"
          data-testid="sheet-context-menu"
          role="menu"
          style={{
            position: "fixed",
            top: contextMenu.y,
            left: contextMenu.x,
            zIndex: 1000,
            background: "var(--color-bg-page, #fff)",
            border: "1px solid var(--color-border, #ccc)",
            padding: "4px 0",
            margin: 0,
            listStyle: "none",
            minWidth: 200,
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {contextMenu.kind === "col" && (
            <>
              <li
                role="menuitem"
                data-testid="sheet-sort-asc"
                style={{ padding: "4px 12px", cursor: "pointer" }}
                onClick={() => sortByColumn(contextMenu.index, true)}
              >
                Sort sheet A → Z
              </li>
              <li
                role="menuitem"
                data-testid="sheet-sort-desc"
                style={{ padding: "4px 12px", cursor: "pointer" }}
                onClick={() => sortByColumn(contextMenu.index, false)}
              >
                Sort sheet Z → A
              </li>
              <li
                aria-hidden="true"
                style={{
                  height: 1,
                  margin: "4px 0",
                  background: "var(--color-border, #ccc)",
                }}
              />
            </>
          )}
          <li
            role="menuitem"
            style={{ padding: "4px 12px", cursor: "pointer" }}
            onClick={() =>
              freezeAt(contextMenu.kind, contextMenu.index)
            }
          >
            Freeze up to this {contextMenu.kind === "row" ? "row" : "column"}
          </li>
          <li
            role="menuitem"
            style={{ padding: "4px 12px", cursor: "pointer" }}
            onClick={unfreeze}
          >
            Unfreeze all
          </li>
        </ul>
      )}
    </div>
  );
}
