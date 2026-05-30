import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  buildSheetDependencyGraph,
  evaluateFormula,
  evaluateSheetFormula,
  parseCSVLines,
  parseSheetContent,
} from "./sheetEditorHelpers";
import {
  cellKey,
  isFormulaError,
  type FormulaValue,
} from "./formulaEngine";
import type { SheetContent } from "./sheetEditorTypes";

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

export default function SheetEditor({
  content,
  onSave,
  onDraftChange,
  autoSaveMs = 2000,
}: SheetEditorProps) {
  const [sheet, setSheet] = useState<SheetContent>(() => parseSheetContent(content));
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  // `activeCell` is the cell whose raw formula appears in the formula bar.
  // It moves on single click (selection) and on edit commit.
  const [activeCell, setActiveCell] = useState<{ row: number; col: number } | null>(null);
  const [editValue, setEditValue] = useState("");
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const formulaBarRef = useRef<HTMLInputElement>(null);
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
        const newRows = prev.rows.map((r) => [...r]);
        while (newRows.length <= rowIdx) {
          newRows.push(new Array(prev.columns.length).fill(""));
        }
        while (newRows[rowIdx].length <= colIdx) {
          newRows[rowIdx].push("");
        }
        newRows[rowIdx][colIdx] = value;
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
    setActiveCell({ row: rowIdx, col: colIdx });
    setEditValue(value);
  };

  /**
   * Select a cell without entering edit mode. The selected cell's
   * raw text is mirrored into the formula bar so the user can
   * inspect formulas without a double-click. Re-clicking the
   * already-active cell promotes it into edit mode.
   */
  const selectCell = (rowIdx: number, colIdx: number) => {
    if (
      activeCell &&
      activeCell.row === rowIdx &&
      activeCell.col === colIdx &&
      !editingCell
    ) {
      startEdit(rowIdx, colIdx);
      return;
    }
    setActiveCell({ row: rowIdx, col: colIdx });
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
      if (e.key === "Tab") {
        const nextCol = editingCell.col + 1;
        if (nextCol < sheet.columns.length) {
          startEdit(editingCell.row, nextCol);
        } else if (editingCell.row + 1 < sheet.rows.length) {
          startEdit(editingCell.row + 1, 0);
        }
      }
    } else if (e.key === "Escape") {
      setEditingCell(null);
    }
  };

  // Memoize the evaluated value of every formula cell once per
  // render pass. The previous implementation called
  // `evaluateFormula` per-cell from render, which built a fresh
  // resolver+cache for each cell — so a sheet with N formulas all
  // referencing the same A1 re-parsed A1 N times. We now build a
  // single shared resolver (via `evaluateSheetFormula`'s underlying
  // cache) and walk every formula cell once, keyed by the same
  // `cellKey(row, col)` the dependency graph uses.
  //
  // The dependency graph itself is built alongside the cache (a)
  // to keep both representations in lockstep for future
  // incremental-recalc work, and (b) so we can detect references to
  // cells outside `sheet.rows` length and still surface them.
  const cellCache = useMemo(() => {
    const cache = new Map<string, FormulaValue>();
    // Building the graph also parses each formula and exposes
    // structural info we'll need when wiring incremental recalc in
    // a later PR. It's cheap (string compare + tokenize) and we
    // already need to walk every cell either way.
    buildSheetDependencyGraph(sheet);
    for (let ri = 0; ri < sheet.rows.length; ri++) {
      const row = sheet.rows[ri];
      if (!row) continue;
      for (let ci = 0; ci < row.length; ci++) {
        const raw = row[ci];
        if (!raw || !raw.startsWith("=")) continue;
        cache.set(cellKey(ri, ci), evaluateSheetFormula(raw, sheet));
      }
    }
    return cache;
  }, [sheet]);

  const getCellDisplay = (
    value: string,
    rowIdx: number,
    colIdx: number,
  ): string => {
    if (!value.startsWith("=")) return value;
    const cached = cellCache.get(cellKey(rowIdx, colIdx));
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

  return (
    <div className="sheet-editor">
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
      </div>

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

      <div className="sheet-grid-wrapper">
        <table className="sheet-grid">
          <thead>
            <tr>
              <th className="sheet-row-number">#</th>
              {sheet.columns.map((col, ci) => (
                <th key={ci} className="sheet-col-header">
                  <span>{col}</span>
                  <button
                    type="button"
                    className="sheet-col-remove"
                    onClick={() => removeColumn(ci)}
                    title="Remove column"
                  >
                    x
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, ri) => (
              <tr key={ri}>
                <td className="sheet-row-number">
                  {ri + 1}
                  <button
                    type="button"
                    className="sheet-row-remove"
                    onClick={() => removeRow(ri)}
                    title="Remove row"
                  >
                    x
                  </button>
                </td>
                {sheet.columns.map((_, ci) => {
                  const isEditing =
                    editingCell?.row === ri && editingCell?.col === ci;
                  const isActive =
                    activeCell?.row === ri && activeCell?.col === ci;
                  const rawValue = row[ci] ?? "";
                  return (
                    <td
                      key={ci}
                      className={`sheet-cell ${isEditing ? "editing" : ""} ${
                        isActive ? "active" : ""
                      }`}
                      onClick={() => selectCell(ri, ci)}
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
                          {getCellDisplay(rawValue, ri, ci)}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
