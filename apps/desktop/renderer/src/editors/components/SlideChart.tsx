/**
 * Renders a slide `chart` block as inline SVG.
 *
 * Unlike {@link SheetChart}, a slide chart is self-contained: its data
 * lives in the block's text DSL (parsed by `parseSlideChart`), not in a
 * live sheet range. The actual geometry + SVG marks are shared with the
 * sheet editor via {@link ChartMarks}, so there is a single, unit-tested
 * source of charting maths and no charting dependency to audit.
 *
 * Text-only / token-driven: no `innerHTML`, colours come from design
 * tokens, and the SVG is exposed to assistive tech as a single labelled
 * image with per-mark `<title>` tooltips inherited from `ChartMarks`.
 */
import type { ChartData } from "../sheetCharts";
import { chartColorAt, hasPlottableData } from "../sheetCharts";
import { ChartMarks, type ChartMarkType } from "./ChartMarks";

const WIDTH = 360;
const HEIGHT = 220;

export interface SlideChartProps {
  type: ChartMarkType;
  data: ChartData;
  title?: string;
}

export function SlideChart({ type, data, title }: SlideChartProps) {
  const heading = title?.trim() || `${type} chart`;
  if (!hasPlottableData(data)) {
    return (
      <div className="slide-chart-empty" role="status">
        No numeric data to chart yet.
      </div>
    );
  }
  const categoryLegend = type === "pie" || type === "donut";
  const showLegend = data.series.length > 1 || categoryLegend;
  return (
    <figure className="slide-chart" aria-label={`${heading} (${type})`}>
      {title?.trim() ? (
        <figcaption className="slide-chart-title">{title.trim()}</figcaption>
      ) : null}
      <svg
        className="slide-chart-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${heading}: ${type} chart`}
        preserveAspectRatio="xMidYMid meet"
      >
        <ChartMarks type={type} data={data} width={WIDTH} height={HEIGHT} />
      </svg>
      {showLegend ? (
        <ul className="sheet-chart-legend" aria-hidden="true">
          {categoryLegend
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
