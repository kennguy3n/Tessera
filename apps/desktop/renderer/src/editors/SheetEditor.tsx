import { useState, useCallback, useRef, useEffect } from "react";
import {
  evaluateFormula,
  parseCSVLines,
  parseSheetContent,
} from "./sheetEditorHelpers";

export interface SheetContent {
  columns: string[];
  rows: string[][];
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
  const [editValue, setEditValue] = useState("");
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
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
    if (editingCell && inputRef.current) {
      inputRef.current.focus();
    }
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
    setEditValue(value);
  };

  const commitEdit = () => {
    if (editingCell) {
      updateCell(editingCell.row, editingCell.col, editValue);
      setEditingCell(null);
    }
  };

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

  const getCellDisplay = (value: string): string => {
    if (value.startsWith("=")) {
      return String(evaluateFormula(value, sheet));
    }
    return value;
  };

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
                  const rawValue = row[ci] ?? "";
                  return (
                    <td
                      key={ci}
                      className={`sheet-cell ${isEditing ? "editing" : ""}`}
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
                          {getCellDisplay(rawValue)}
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

function columnLabel(index: number): string {
  let label = "";
  let n = index;
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  }
  return label;
}
