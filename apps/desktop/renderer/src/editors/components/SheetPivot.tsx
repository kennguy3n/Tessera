/**
 * Renders a computed {@link PivotResult} as an accessible HTML table,
 * bound to data the parent has already cross-tabulated via the pure
 * `computePivot` helper. This component is a thin shell: it only maps the
 * result's labels / matrix / margins to table cells and formats numbers
 * for display.
 *
 * A trailing row-totals column is shown only when the pivot has a column
 * field (otherwise it would duplicate the single value column); the
 * grand-total row is always shown.
 */
import type { PivotResult } from "../sheetPivot";
import { PIVOT_AGG_LABELS, PIVOT_TOTAL_LABEL, hasPivotData } from "../sheetPivot";
import type { PivotSpec } from "../sheetEditorTypes";

export interface SheetPivotProps {
  spec: PivotSpec;
  result: PivotResult | null;
  onRemove: () => void;
}

/** Format an aggregated number compactly; blanks render as an empty cell. */
function formatCell(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  // Integers print as-is; fractional results are rounded to 2 dp so an
  // average like 17.5 stays readable without trailing float noise.
  const rounded = Number.isInteger(value)
    ? value
    : Math.round(value * 100) / 100;
  return rounded.toLocaleString();
}

export function SheetPivot({ spec, result, onRemove }: SheetPivotProps) {
  const title = spec.title?.trim() || "Pivot";
  const empty = !hasPivotData(result);
  const showRowTotals = result?.colFieldName !== undefined;

  return (
    <figure
      className="sheet-pivot"
      data-testid={`sheet-pivot-${spec.id}`}
      aria-label={`${title} (pivot table)`}
    >
      <figcaption className="sheet-pivot-head">
        <span className="sheet-pivot-title" title={spec.range}>
          {title}
        </span>
        <button
          type="button"
          className="btn-sm sheet-pivot-remove"
          aria-label={`Remove ${title}`}
          data-testid={`sheet-pivot-remove-${spec.id}`}
          onClick={onRemove}
        >
          ✕
        </button>
      </figcaption>

      {empty || !result ? (
        <p
          className="sheet-pivot-empty"
          data-testid={`sheet-pivot-empty-${spec.id}`}
        >
          No data to summarise in {spec.range}.
        </p>
      ) : (
        <table className="sheet-pivot-table">
          <caption className="sheet-pivot-caption">
            {PIVOT_AGG_LABELS[result.agg]} of {result.valueFieldName} by{" "}
            {result.rowFieldName}
            {result.colFieldName ? ` and ${result.colFieldName}` : ""}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="sheet-pivot-corner">
                {result.rowFieldName}
              </th>
              {result.colLabels.map((label, ci) => (
                <th scope="col" key={`c-${ci}`} className="sheet-pivot-colhead">
                  {label}
                </th>
              ))}
              {showRowTotals && (
                <th scope="col" className="sheet-pivot-colhead sheet-pivot-total">
                  {PIVOT_TOTAL_LABEL}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {result.rowLabels.map((rowLabel, ri) => (
              <tr key={`r-${ri}`}>
                <th scope="row" className="sheet-pivot-rowhead">
                  {rowLabel}
                </th>
                {result.colLabels.map((_, ci) => (
                  <td key={`cell-${ri}-${ci}`} className="sheet-pivot-cell">
                    {formatCell(result.matrix[ri]?.[ci] ?? null)}
                  </td>
                ))}
                {showRowTotals && (
                  <td className="sheet-pivot-cell sheet-pivot-total">
                    {formatCell(result.rowTotals[ri] ?? null)}
                  </td>
                )}
              </tr>
            ))}
            <tr className="sheet-pivot-total-row">
              <th scope="row" className="sheet-pivot-rowhead sheet-pivot-total">
                {PIVOT_TOTAL_LABEL}
              </th>
              {result.colTotals.map((total, ci) => (
                <td key={`ct-${ci}`} className="sheet-pivot-cell sheet-pivot-total">
                  {formatCell(total)}
                </td>
              ))}
              {showRowTotals && (
                <td className="sheet-pivot-cell sheet-pivot-total">
                  {formatCell(result.grandTotal)}
                </td>
              )}
            </tr>
          </tbody>
        </table>
      )}
    </figure>
  );
}
