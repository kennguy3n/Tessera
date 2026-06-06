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
import { cellFormatStyle, cellKey, isFormulaError } from "./formulaEngine";
import type {
  ConditionalFormatRule,
  SheetContent,
} from "./sheetEditorTypes";
import { conditionalStyleForCell } from "./sheetConditionalFormatting";
import { ConditionalFormatPanel } from "./components/ConditionalFormatPanel";
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
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const formulaBarRef = useRef<HTMLInputElement>(null);
  const gridWrapperRef = useRef<HTMLDivElement>(null);
  const lastSavedRef = useRef(content);

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
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
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
      const colName = columnLabel(prev.columns.length);
      const updated: SheetContent = {
        columns: [...prev.columns, colName],
        rows: prev.rows.map((r) => [...r, ""]),
      };
      debouncedSave(updated);
      return updated;
    });
  }, [debouncedSave]);

  const removeColumn = useCallback(
    (colIdx: number) => {
      setSheet((prev) => {
        if (prev.columns.length <= 1) return prev;
        const updated: SheetContent = {
          columns: prev.columns.filter((_, i) => i !== colIdx),
          rows: prev.rows.map((r) => r.filter((_, i) => i !== colIdx)),
        };
        debouncedSave(updated);
        return updated;
      });
    },
    [debouncedSave],
  );

  const addRow = useCallback(() => {
    setSheet((prev) => {
      const updated: SheetContent = {
        ...prev,
        rows: [...prev.rows, new Array(prev.columns.length).fill("")],
      };
      debouncedSave(updated);
      return updated;
    });
  }, [debouncedSave]);

  const removeRow = useCallback(
    (rowIdx: number) => {
      setSheet((prev) => {
        const updated: SheetContent = {
          ...prev,
          rows: prev.rows.filter((_, i) => i !== rowIdx),
        };
        debouncedSave(updated);
        return updated;
      });
    },
    [debouncedSave],
  );

  const startEdit = (rowIdx: number, colIdx: number) => {
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
    if (!value.startsWith("=")) return value;
    const cached = cellCache.get(cellKey(rowIdx, colIdx, activeName));
    if (cached === undefined) {
      // Shouldn't happen — `cellCache` is built from the same
      // `sheet` we're rendering — but fall back to a one-off
      // evaluation rather than rendering the raw formula text.
      return String(evaluateFormula(value, sheet));
    }
    if (cached === null) return "";
    if (isFormulaError(cached)) return cached.code;
    return String(cached);
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
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sheet.columnWidths, debouncedSave],
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
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sheet.rowHeights, debouncedSave],
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
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
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
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, sheet, debouncedSave],
  );

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
      </div>

      {cfOpen && (
        <ConditionalFormatPanel
          rules={sheet.conditionalRules ?? []}
          columns={sheet.columns}
          onChange={setConditionalRules}
          onClose={() => setCfOpen(false)}
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
                      {isEditing ? (
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
