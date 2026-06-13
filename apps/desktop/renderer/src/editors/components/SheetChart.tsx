/**
 * Renders a single {@link ChartSpec} as inline SVG, bound to data the
 * parent has already extracted from the live grid. All geometry comes
 * from the pure helpers in `sheetCharts.ts`; this component only maps
 * that geometry to themed SVG marks, so it stays a thin shell.
 *
 * Colours come from design-system tokens (theme-aware where a token
 * exists) so charts honour light/dark and the active accent. The SVG is
 * exposed to assistive tech as a single labelled image.
 */
import type { ChartData } from "../sheetCharts";
import { chartColorAt, hasPlottableData } from "../sheetCharts";
import type { ChartSpec } from "../sheetEditorTypes";
import { ChartMarks } from "./ChartMarks";

const WIDTH = 320;
const HEIGHT = 200;

export interface SheetChartProps {
  spec: ChartSpec;
  data: ChartData;
  onRemove: () => void;
}

export function SheetChart({ spec, data, onRemove }: SheetChartProps) {
  const title = spec.title?.trim() || `${spec.type} chart`;
  const empty = !hasPlottableData(data);

  return (
    <figure
      className="sheet-chart"
      data-testid={`sheet-chart-${spec.id}`}
      aria-label={`${title} (${spec.type})`}
    >
      <figcaption className="sheet-chart-head">
        <span className="sheet-chart-title" title={spec.range}>
          {title}
        </span>
        <button
          type="button"
          className="btn-sm sheet-chart-remove"
          aria-label={`Remove ${title}`}
          data-testid={`sheet-chart-remove-${spec.id}`}
          onClick={onRemove}
        >
          ✕
        </button>
      </figcaption>

      {empty ? (
        <p
          className="sheet-chart-empty"
          data-testid={`sheet-chart-empty-${spec.id}`}
        >
          No numeric data in {spec.range}.
        </p>
      ) : (
        <svg
          className="sheet-chart-svg"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={`${title}: ${spec.type} chart of ${spec.range}`}
          preserveAspectRatio="xMidYMid meet"
        >
          <ChartMarks
            type={spec.type}
            data={data}
            width={WIDTH}
            height={HEIGHT}
          />
        </svg>
      )}

      {data.series.length > 1 || spec.type === "pie" ? (
        <ul className="sheet-chart-legend" aria-hidden="true">
          {spec.type === "pie"
            ? data.labels.map((label, i) => (
                <li key={i}>
                  <span
                    className="sheet-chart-swatch"
                    style={{ background: chartColorAt(i) }}
                  />
                  {label}
                </li>
              ))
            : data.series.map((s, i) => (
                <li key={s.name + i}>
                  <span
                    className="sheet-chart-swatch"
                    style={{ background: chartColorAt(i) }}
                  />
                  {s.name}
                </li>
              ))}
        </ul>
      ) : null}
    </figure>
  );
}
