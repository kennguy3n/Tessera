/**
 * Chart manager.
 *
 * A toolbar-toggled panel that lists the sheet's charts and lets the
 * user add or remove them. Controlled component: every mutation hands a
 * fresh `ChartSpec[]` to `onChange`, which `SheetEditor` persists.
 * Range parsing/validation is delegated to the pure `parseA1Range`
 * helper so the panel stays a thin shell.
 */
import { useCallback, useState } from "react";

import { parseA1Range } from "../sheetCharts";
import type { ChartSpec, ChartType } from "../sheetEditorTypes";

export interface ChartsPanelProps {
  charts: ChartSpec[];
  /** A1 reference of the current selection, prefilled into a new chart. */
  selectionRef?: string;
  onChange: (charts: ChartSpec[]) => void;
  onClose: () => void;
}

/** Best-effort unique id; `randomUUID` where available, else a fallback. */
function newChartId(): string {
  const c =
    typeof globalThis !== "undefined"
      ? (globalThis.crypto as Crypto | undefined)
      : undefined;
  if (c?.randomUUID) return `chart-${c.randomUUID()}`;
  return `chart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const TYPE_LABELS: Record<ChartType, string> = {
  bar: "Bar",
  line: "Line",
  pie: "Pie",
};

export function ChartsPanel({
  charts,
  selectionRef,
  onChange,
  onClose,
}: ChartsPanelProps) {
  const [draftType, setDraftType] = useState<ChartType>("bar");
  const [draftRange, setDraftRange] = useState(selectionRef ?? "");
  const [draftLabels, setDraftLabels] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftHeader, setDraftHeader] = useState(false);

  const rangeValid = parseA1Range(draftRange) !== null;
  const labelsValid =
    draftLabels.trim() === "" || parseA1Range(draftLabels) !== null;
  const canAdd = rangeValid && labelsValid;

  const removeChart = useCallback(
    (id: string) => {
      onChange(charts.filter((c) => c.id !== id));
    },
    [charts, onChange],
  );

  const addChart = useCallback(() => {
    if (!canAdd) return;
    const spec: ChartSpec = {
      id: newChartId(),
      type: draftType,
      range: draftRange.trim(),
    };
    const title = draftTitle.trim();
    if (title !== "") spec.title = title;
    const labels = draftLabels.trim();
    if (labels !== "") spec.labelRange = labels;
    if (draftHeader) spec.useFirstRowAsHeader = true;
    onChange([...charts, spec]);
    setDraftTitle("");
  }, [
    canAdd,
    charts,
    onChange,
    draftType,
    draftRange,
    draftTitle,
    draftLabels,
    draftHeader,
  ]);

  return (
    <section
      className="sheet-cf-panel sheet-charts-panel"
      data-testid="sheet-charts-panel"
      aria-label="Charts"
    >
      <div className="sheet-cf-header">
        <span className="sheet-cf-title">Charts</span>
        <button
          type="button"
          className="btn-sm"
          onClick={onClose}
          aria-label="Close charts"
        >
          ×
        </button>
      </div>

      {charts.length === 0 ? (
        <p className="sheet-cf-empty" data-testid="sheet-charts-empty">
          No charts yet. Select a range (e.g. <code>B2:B10</code>), pick a
          type, and add a chart bound to that range.
        </p>
      ) : (
        <ul className="sheet-cf-list">
          {charts.map((c) => (
            <li
              key={c.id}
              className="sheet-cf-rule sheet-dv-row"
              data-testid={`sheet-charts-row-${c.id}`}
            >
              <span className="sheet-dv-col">
                {c.title?.trim() || `${TYPE_LABELS[c.type]} chart`}
              </span>
              <span className="sheet-dv-kind">
                {TYPE_LABELS[c.type]} · {c.range}
                {c.labelRange ? ` · labels ${c.labelRange}` : ""}
              </span>
              <button
                type="button"
                className="btn-sm danger sheet-cf-remove"
                onClick={() => removeChart(c.id)}
                aria-label={`Remove ${c.title?.trim() || "chart"}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="sheet-dv-add sheet-cf-rule">
        <label className="sheet-cf-field">
          <span className="sheet-cf-label">Type</span>
          <select
            aria-label="Chart type"
            value={draftType}
            onChange={(e) => setDraftType(e.target.value as ChartType)}
          >
            <option value="bar">Bar</option>
            <option value="line">Line</option>
            <option value="pie">Pie</option>
          </select>
        </label>
        <label className="sheet-cf-field">
          <span className="sheet-cf-label">Value range</span>
          <input
            aria-label="Value range"
            data-testid="sheet-charts-range"
            placeholder="B2:B10"
            value={draftRange}
            onChange={(e) => setDraftRange(e.target.value)}
          />
        </label>
        <label className="sheet-cf-field">
          <span className="sheet-cf-label">Label range (optional)</span>
          <input
            aria-label="Label range"
            data-testid="sheet-charts-labels"
            placeholder="A2:A10"
            value={draftLabels}
            onChange={(e) => setDraftLabels(e.target.value)}
          />
        </label>
        <label className="sheet-cf-field">
          <span className="sheet-cf-label">Title (optional)</span>
          <input
            aria-label="Chart title"
            data-testid="sheet-charts-title"
            placeholder="Revenue"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
          />
        </label>
        <label className="sheet-cf-check">
          <input
            type="checkbox"
            aria-label="First row is a header"
            checked={draftHeader}
            onChange={(e) => setDraftHeader(e.target.checked)}
          />
          <span>First row is series names</span>
        </label>
        <button
          type="button"
          className="btn-sm primary"
          data-testid="sheet-charts-add"
          disabled={!canAdd}
          onClick={addChart}
        >
          Add chart
        </button>
        {!rangeValid && draftRange.trim() !== "" && (
          <span className="sheet-cf-error" role="alert">
            Enter a valid A1 range, e.g. B2:B10.
          </span>
        )}
        {rangeValid && !labelsValid && (
          <span className="sheet-cf-error" role="alert">
            Label range must be a valid A1 range.
          </span>
        )}
      </div>
    </section>
  );
}
