/**
 * Column data-validation manager.
 *
 * A toolbar-toggled panel that lists the columns with a validation rule
 * (dropdown list or checkbox) and lets the user add, edit, or remove
 * them. Controlled component: every mutation hands a fresh
 * `ValidationMap` (or `undefined` when empty) to `onChange`, which
 * `SheetEditor` persists. Heavy logic lives in `sheetDataValidation.ts`;
 * this component is a thin shell over those pure helpers.
 */
import { useMemo, useState } from "react";

import { parseListValues, setColumnValidation } from "../sheetDataValidation";
import type { DataValidation, ValidationMap } from "../sheetEditorTypes";

export interface DataValidationPanelProps {
  columns: string[];
  validations: ValidationMap;
  onChange: (validations: ValidationMap | undefined) => void;
  onClose: () => void;
}

type DraftKind = "list" | "checkbox";

/** Display label for a column: its header text, or a 1-based fallback. */
function colLabel(columns: string[], col: number): string {
  const header = columns[col]?.trim();
  return header && header !== "" ? header : `Column ${col + 1}`;
}

export function DataValidationPanel({
  columns,
  validations,
  onChange,
  onClose,
}: DataValidationPanelProps) {
  const [draftCol, setDraftCol] = useState(0);
  const [draftKind, setDraftKind] = useState<DraftKind>("list");
  const [draftValues, setDraftValues] = useState("");

  // Columns that already carry a rule, in column order.
  const entries = useMemo(
    () =>
      Object.keys(validations)
        .map((k) => ({ col: Number(k), rule: validations[k] }))
        .filter((e) => Number.isInteger(e.col) && e.col < columns.length)
        .sort((a, b) => a.col - b.col),
    [validations, columns.length],
  );

  const parsedDraft = parseListValues(draftValues);
  const canAdd = draftKind === "checkbox" || parsedDraft.length > 0;

  const apply = (col: number, rule: DataValidation | null) => {
    onChange(setColumnValidation(validations, col, rule));
  };

  const addRule = () => {
    if (!canAdd) return;
    const rule: DataValidation =
      draftKind === "checkbox"
        ? { kind: "checkbox" }
        : { kind: "list", values: parsedDraft };
    apply(draftCol, rule);
    setDraftValues("");
  };

  return (
    <section
      className="sheet-cf-panel sheet-dv-panel"
      data-testid="sheet-dv-panel"
      aria-label="Data validation"
    >
      <div className="sheet-cf-header">
        <span className="sheet-cf-title">Data validation</span>
        <button
          type="button"
          className="btn-sm"
          onClick={onClose}
          aria-label="Close data validation"
        >
          ×
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="sheet-cf-empty" data-testid="sheet-dv-empty">
          No data-validation rules yet. Make a column a dropdown (e.g.{" "}
          <code>Paid, Unpaid, Pending</code>) or a checkbox to constrain what
          can be entered.
        </p>
      ) : (
        <ul className="sheet-cf-list">
          {entries.map(({ col, rule }) => (
            <li
              key={col}
              className="sheet-cf-rule sheet-dv-row"
              data-testid={`sheet-dv-row-${col}`}
            >
              <span className="sheet-dv-col">{colLabel(columns, col)}</span>
              <span className="sheet-dv-kind">
                {rule.kind === "checkbox"
                  ? "Checkbox"
                  : `Dropdown: ${rule.values.join(", ")}`}
              </span>
              <button
                type="button"
                className="btn-sm danger sheet-cf-remove"
                onClick={() => apply(col, null)}
                aria-label={`Remove validation on column ${colLabel(columns, col)}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="sheet-dv-add sheet-cf-rule">
        <label className="sheet-cf-field">
          <span className="sheet-cf-label">Column</span>
          <select
            aria-label="Validation column"
            value={draftCol}
            onChange={(e) => setDraftCol(Number(e.target.value))}
          >
            {columns.map((_, i) => (
              <option key={i} value={i}>
                {colLabel(columns, i)}
              </option>
            ))}
          </select>
        </label>
        <label className="sheet-cf-field">
          <span className="sheet-cf-label">Type</span>
          <select
            aria-label="Validation type"
            value={draftKind}
            onChange={(e) => setDraftKind(e.target.value as DraftKind)}
          >
            <option value="list">Dropdown</option>
            <option value="checkbox">Checkbox</option>
          </select>
        </label>
        {draftKind === "list" && (
          <label className="sheet-cf-field">
            <span className="sheet-cf-label">Values (comma-separated)</span>
            <input
              type="text"
              aria-label="Dropdown values"
              value={draftValues}
              placeholder="Paid, Unpaid, Pending"
              onChange={(e) => setDraftValues(e.target.value)}
            />
          </label>
        )}
        <button
          type="button"
          className="btn-sm"
          data-testid="sheet-dv-add"
          disabled={!canAdd}
          onClick={addRule}
        >
          Apply
        </button>
      </div>
    </section>
  );
}
