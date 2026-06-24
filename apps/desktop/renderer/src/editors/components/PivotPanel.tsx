/**
 * Pivot-table manager.
 *
 * A toolbar-toggled panel that lists the sheet's pivots and lets the user
 * add or remove them. Controlled component: every mutation hands a fresh
 * `PivotSpec[]` to `onChange`, which `SheetEditor` persists. Range parsing
 * is delegated to the pure `parseA1Range` helper; field pickers are driven
 * by the columns the parsed range spans, labelled via `columnLabelAt` so
 * the panel stays a thin shell over live header text.
 */
import { useCallback, useMemo, useState } from "react";

import { parseA1Range } from "../sheetCharts";
import { PIVOT_AGG_LABELS } from "../sheetPivot";
import type { PivotAggregation, PivotSpec } from "../sheetEditorTypes";

export interface PivotPanelProps {
  pivots: PivotSpec[];
  /** A1 reference of the current selection, prefilled into a new pivot. */
  selectionRef?: string;
  /**
   * Human label for a grid column, e.g. `"A · Region"`. `headerRow` lets the
   * caller resolve the name from a pivot's own source-range header row rather
   * than always the grid's first row.
   */
  columnLabelAt: (col: number, headerRow?: number) => string;
  onChange: (pivots: PivotSpec[]) => void;
  onClose: () => void;
}

/** Best-effort unique id; `randomUUID` where available, else a fallback. */
function newPivotId(): string {
  const c =
    typeof globalThis !== "undefined"
      ? (globalThis.crypto as Crypto | undefined)
      : undefined;
  if (c?.randomUUID) return `pivot-${c.randomUUID()}`;
  return `pivot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const AGG_ORDER: PivotAggregation[] = ["sum", "count", "average", "min", "max"];

export function PivotPanel({
  pivots,
  selectionRef,
  columnLabelAt,
  onChange,
  onClose,
}: PivotPanelProps) {
  const [draftRange, setDraftRange] = useState(selectionRef ?? "");
  const [draftRow, setDraftRow] = useState<number | null>(null);
  const [draftCol, setDraftCol] = useState<number | null>(null);
  const [draftValue, setDraftValue] = useState<number | null>(null);
  const [draftAgg, setDraftAgg] = useState<PivotAggregation>("sum");
  const [draftTitle, setDraftTitle] = useState("");

  // Columns the parsed range spans; the field pickers choose from these.
  // `parseA1Range` returns a fresh object each render, so the memo keys off the
  // scalar `draftRange` string it derives from — keying off `rect` would defeat
  // memoisation (new reference every render) and recompute on unrelated edits.
  const rect = parseA1Range(draftRange);
  const headerRow = rect?.r1 ?? 0;
  const columns = useMemo(() => {
    if (!rect) return [] as number[];
    const cols: number[] = [];
    for (let c = rect.c1; c <= rect.c2; c++) cols.push(c);
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftRange]);

  // Label a pivot's field, reading from that pivot's own header row. A field
  // whose column was removed by a structural edit carries the `-1` sentinel —
  // surface that explicitly instead of an empty/garbled label.
  const fieldLabel = useCallback(
    (col: number, rangeHeaderRow: number): string =>
      col < 0 ? "(removed column)" : columnLabelAt(col, rangeHeaderRow),
    [columnLabelAt],
  );

  // Effective field selections: fall back to the first / last columns of
  // the range so a valid range always yields an addable pivot.
  const rowField =
    draftRow !== null && columns.includes(draftRow) ? draftRow : columns[0];
  const valueField =
    draftValue !== null && columns.includes(draftValue)
      ? draftValue
      : (columns[columns.length - 1] ?? columns[0]);
  const colField =
    draftCol !== null && columns.includes(draftCol) ? draftCol : null;

  const canAdd = rect !== null && columns.length > 0;

  const removePivot = useCallback(
    (id: string) => {
      onChange(pivots.filter((p) => p.id !== id));
    },
    [pivots, onChange],
  );

  const addPivot = useCallback(() => {
    if (!canAdd || rowField === undefined || valueField === undefined) return;
    const spec: PivotSpec = {
      id: newPivotId(),
      range: draftRange.trim(),
      rowField,
      valueField,
      agg: draftAgg,
    };
    if (colField !== null) spec.colField = colField;
    const title = draftTitle.trim();
    if (title !== "") spec.title = title;
    onChange([...pivots, spec]);
    setDraftTitle("");
  }, [
    canAdd,
    pivots,
    onChange,
    draftRange,
    rowField,
    valueField,
    colField,
    draftAgg,
    draftTitle,
  ]);

  return (
    <section
      className="sheet-cf-panel sheet-pivot-panel"
      data-testid="sheet-pivot-panel"
      aria-label="Pivot tables"
    >
      <div className="sheet-cf-header">
        <span className="sheet-cf-title">Pivot tables</span>
        <button
          type="button"
          className="btn-sm"
          onClick={onClose}
          aria-label="Close pivot tables"
        >
          ×
        </button>
      </div>

      {pivots.length === 0 ? (
        <p className="sheet-cf-empty" data-testid="sheet-pivot-empty">
          No pivots yet. Select a range with a header row (e.g.{" "}
          <code>A1:D100</code>), choose the row / value fields, and add a pivot
          summarising that data.
        </p>
      ) : (
        <ul className="sheet-cf-list">
          {pivots.map((p) => (
            <li
              key={p.id}
              className="sheet-cf-rule sheet-dv-row"
              data-testid={`sheet-pivot-row-${p.id}`}
            >
              <span className="sheet-dv-col">{p.title?.trim() || "Pivot"}</span>
              <span className="sheet-dv-kind">
                {PIVOT_AGG_LABELS[p.agg]} of{" "}
                {fieldLabel(p.valueField, parseA1Range(p.range)?.r1 ?? 0)} ·{" "}
                {p.range}
              </span>
              <button
                type="button"
                className="btn-sm danger sheet-cf-remove"
                onClick={() => removePivot(p.id)}
                aria-label={`Remove ${p.title?.trim() || "pivot"}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="sheet-dv-add sheet-cf-rule">
        <label className="sheet-cf-field">
          <span className="sheet-cf-label">Source range</span>
          <input
            aria-label="Source range"
            data-testid="sheet-pivot-range"
            placeholder="A1:D100"
            value={draftRange}
            onChange={(e) => setDraftRange(e.target.value)}
          />
        </label>
        <label className="sheet-cf-field">
          <span className="sheet-cf-label">Rows</span>
          <select
            aria-label="Row field"
            data-testid="sheet-pivot-rowfield"
            disabled={!canAdd}
            value={rowField ?? ""}
            onChange={(e) => setDraftRow(Number(e.target.value))}
          >
            {columns.map((c) => (
              <option key={c} value={c}>
                {columnLabelAt(c, headerRow)}
              </option>
            ))}
          </select>
        </label>
        <label className="sheet-cf-field">
          <span className="sheet-cf-label">Columns (optional)</span>
          <select
            aria-label="Column field"
            data-testid="sheet-pivot-colfield"
            disabled={!canAdd}
            value={colField ?? ""}
            onChange={(e) =>
              setDraftCol(e.target.value === "" ? null : Number(e.target.value))
            }
          >
            <option value="">None</option>
            {columns.map((c) => (
              <option key={c} value={c}>
                {columnLabelAt(c, headerRow)}
              </option>
            ))}
          </select>
        </label>
        <label className="sheet-cf-field">
          <span className="sheet-cf-label">Values</span>
          <select
            aria-label="Value field"
            data-testid="sheet-pivot-valuefield"
            disabled={!canAdd}
            value={valueField ?? ""}
            onChange={(e) => setDraftValue(Number(e.target.value))}
          >
            {columns.map((c) => (
              <option key={c} value={c}>
                {columnLabelAt(c, headerRow)}
              </option>
            ))}
          </select>
        </label>
        <label className="sheet-cf-field">
          <span className="sheet-cf-label">Summarise by</span>
          <select
            aria-label="Aggregation"
            data-testid="sheet-pivot-agg"
            value={draftAgg}
            onChange={(e) => setDraftAgg(e.target.value as PivotAggregation)}
          >
            {AGG_ORDER.map((a) => (
              <option key={a} value={a}>
                {PIVOT_AGG_LABELS[a]}
              </option>
            ))}
          </select>
        </label>
        <label className="sheet-cf-field">
          <span className="sheet-cf-label">Title (optional)</span>
          <input
            aria-label="Pivot title"
            data-testid="sheet-pivot-title"
            placeholder="Sales by region"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn-sm primary"
          data-testid="sheet-pivot-add"
          disabled={!canAdd}
          onClick={addPivot}
        >
          Add pivot
        </button>
        {!canAdd && draftRange.trim() !== "" && (
          <span className="sheet-cf-error" role="alert">
            Enter a valid A1 range, e.g. A1:D100.
          </span>
        )}
      </div>
    </section>
  );
}
