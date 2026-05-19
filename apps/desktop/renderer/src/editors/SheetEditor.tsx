import { useState, useCallback, useRef, useEffect } from "react";

export interface SheetContent {
  columns: string[];
  rows: string[][];
}

interface SheetEditorProps {
  content: string;
  onSave: (content: string) => void;
  autoSaveMs?: number;
}

export default function SheetEditor({
  content,
  onSave,
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
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        const json = JSON.stringify(data);
        lastSavedRef.current = json;
        onSave(json);
      }, autoSaveMs);
    },
    [onSave, autoSaveMs],
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
      const lines = csvText.trim().split("\n");
      if (lines.length === 0) return;
      const headers = lines[0].split(",").map((h) => h.trim());
      const rows = lines.slice(1).map((line) =>
        line.split(",").map((cell) => cell.trim()),
      );
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

function parseSheetContent(content: string): SheetContent {
  if (!content) {
    return { columns: ["A", "B", "C"], rows: [["", "", ""], ["", "", ""], ["", "", ""]] };
  }
  try {
    const parsed = JSON.parse(content) as SheetContent;
    if (parsed.columns && Array.isArray(parsed.columns)) {
      return parsed;
    }
  } catch {
    // Not JSON
  }
  return { columns: ["A", "B", "C"], rows: [["", "", ""], ["", "", ""], ["", "", ""]] };
}

function evaluateFormula(formula: string, sheet: SheetContent): string | number {
  const expr = formula.slice(1).trim().toUpperCase();

  const rangeMatch = expr.match(/^(SUM|AVERAGE|COUNT|MIN|MAX)\(([A-Z]+\d+):([A-Z]+\d+)\)$/);
  if (!rangeMatch) return "#ERR";

  const [, func, startRef, endRef] = rangeMatch;
  const startCell = parseCellRef(startRef);
  const endCell = parseCellRef(endRef);
  if (!startCell || !endCell) return "#REF";

  const values: number[] = [];
  for (let r = startCell.row; r <= endCell.row; r++) {
    for (let c = startCell.col; c <= endCell.col; c++) {
      const raw = sheet.rows[r]?.[c] ?? "";
      const num = parseFloat(raw);
      if (!isNaN(num)) values.push(num);
    }
  }

  if (values.length === 0) return 0;

  switch (func) {
    case "SUM":
      return values.reduce((a, b) => a + b, 0);
    case "AVERAGE":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "COUNT":
      return values.length;
    case "MIN":
      return Math.min(...values);
    case "MAX":
      return Math.max(...values);
    default:
      return "#ERR";
  }
}

function parseCellRef(ref: string): { row: number; col: number } | null {
  const match = ref.match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  const col = match[1].split("").reduce((acc, c) => acc * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const row = parseInt(match[2], 10) - 1;
  return { row, col };
}
