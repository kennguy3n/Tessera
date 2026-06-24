/**
 * Workbook named-range manager.
 *
 * A toolbar-toggled panel that lists the workbook's named ranges and
 * lets the user add, edit, and delete them. Controlled component: every
 * mutation hands a fresh array to `onChange`, which `SheetEditor`
 * persists. Validation is delegated to the engine's `validateNamedRange`
 * so the rules stay in one place; invalid rows surface an inline error
 * and are not silently dropped while the user is typing.
 */
import { useCallback, useState } from "react";

import { validateNamedRange } from "../formulaEngine";
import type { SheetNamedRange } from "../sheetEditorTypes";

export interface NamedRangePanelProps {
  ranges: SheetNamedRange[];
  /** A1 reference of the current selection, prefilled into a new row. */
  selectionRef?: string;
  onChange: (ranges: SheetNamedRange[]) => void;
  onClose: () => void;
}

export function NamedRangePanel({
  ranges,
  selectionRef,
  onChange,
  onClose,
}: NamedRangePanelProps) {
  const [draftName, setDraftName] = useState("");
  const [draftRange, setDraftRange] = useState(selectionRef ?? "");

  const updateRange = useCallback(
    (index: number, patch: Partial<SheetNamedRange>) => {
      onChange(ranges.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    },
    [ranges, onChange],
  );

  const removeRange = useCallback(
    (index: number) => {
      onChange(ranges.filter((_, i) => i !== index));
    },
    [ranges, onChange],
  );

  const draftError = validateNamedRange({ name: draftName, range: draftRange });
  const duplicate = ranges.some(
    (r) => r.name.toLowerCase() === draftName.trim().toLowerCase(),
  );
  const canAdd = draftName.trim() !== "" && draftError === null && !duplicate;

  const addRange = useCallback(() => {
    if (!canAdd) return;
    onChange([...ranges, { name: draftName.trim(), range: draftRange.trim() }]);
    setDraftName("");
    setDraftRange("");
  }, [canAdd, ranges, onChange, draftName, draftRange]);

  return (
    <section
      className="sheet-cf-panel sheet-nr-panel"
      data-testid="sheet-nr-panel"
      aria-label="Named ranges"
    >
      <div className="sheet-cf-header">
        <span className="sheet-cf-title">Named ranges</span>
        <button
          type="button"
          className="btn-sm"
          onClick={onClose}
          aria-label="Close named ranges"
        >
          ×
        </button>
      </div>

      {ranges.length === 0 ? (
        <p className="sheet-cf-empty" data-testid="sheet-nr-empty">
          No named ranges yet. Name a range (e.g. <code>Revenue</code> →{" "}
          <code>B2:B100</code>) to use it in formulas like{" "}
          <code>=SUM(Revenue)</code>.
        </p>
      ) : (
        <ul className="sheet-cf-list">
          {ranges.map((range, idx) => {
            // Surface a duplicate-name error when editing an existing
            // row collides with another row (case-insensitive). The
            // draft row guards on add, but inline edits bypass that, so
            // the collision is flagged here rather than silently
            // last-wins'd by `buildNamesMap`.
            const norm = range.name.trim().toLowerCase();
            const isDuplicate =
              norm !== "" &&
              ranges.some(
                (other, j) =>
                  j !== idx && other.name.trim().toLowerCase() === norm,
              );
            const error =
              validateNamedRange(range) ??
              (isDuplicate ? "Duplicate name — names must be unique." : null);
            return (
              <li
                key={idx}
                className="sheet-cf-rule sheet-nr-row"
                data-testid={`sheet-nr-row-${idx}`}
              >
                <label className="sheet-cf-field">
                  <span className="sheet-cf-label">Name</span>
                  <input
                    type="text"
                    value={range.name}
                    aria-label={`Name for range ${idx + 1}`}
                    onChange={(e) => updateRange(idx, { name: e.target.value })}
                  />
                </label>
                <label className="sheet-cf-field">
                  <span className="sheet-cf-label">Range</span>
                  <input
                    type="text"
                    value={range.range}
                    aria-label={`Reference for range ${idx + 1}`}
                    onChange={(e) =>
                      updateRange(idx, { range: e.target.value })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="btn-sm danger sheet-cf-remove"
                  onClick={() => removeRange(idx)}
                  aria-label={`Delete named range ${range.name || idx + 1}`}
                >
                  Delete
                </button>
                {error && (
                  <p className="sheet-nr-error" role="alert">
                    {error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="sheet-nr-add">
        <label className="sheet-cf-field">
          <span className="sheet-cf-label">New name</span>
          <input
            type="text"
            value={draftName}
            aria-label="New named-range name"
            placeholder="Revenue"
            onChange={(e) => setDraftName(e.target.value)}
          />
        </label>
        <label className="sheet-cf-field">
          <span className="sheet-cf-label">Range</span>
          <input
            type="text"
            value={draftRange}
            aria-label="New named-range reference"
            placeholder="B2:B100"
            onChange={(e) => setDraftRange(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn-sm primary"
          onClick={addRange}
          disabled={!canAdd}
          data-testid="sheet-nr-add"
        >
          Add
        </button>
        {draftName.trim() !== "" && duplicate && (
          <p className="sheet-nr-error" role="alert">
            A range named “{draftName.trim()}” already exists.
          </p>
        )}
        {draftName.trim() !== "" && draftError && !duplicate && (
          <p className="sheet-nr-error" role="alert">
            {draftError}
          </p>
        )}
      </div>
    </section>
  );
}
