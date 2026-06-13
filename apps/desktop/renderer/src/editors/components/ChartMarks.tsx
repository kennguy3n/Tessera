/**
 * Shared, purely-presentational SVG chart marks (bar / line / pie).
 *
 * Both {@link SheetChart} (sheet editor) and {@link SlideChart} (slide
 * editor) wrap these marks in their own `<svg>` + chrome. All geometry
 * comes from the pure, unit-tested helpers in `sheetCharts.ts`; this
 * component only maps that geometry to themed SVG elements, so it stays
 * a thin shell with no charting dependency to audit.
 *
 * Colours come from design-system tokens (theme-aware where a token
 * exists) so charts honour light/dark and the active accent. Axis / tick
 * marks keep the `sheet-chart-*` class names so a single CSS rule set
 * styles charts in every editor.
 */
import type { ReactNode } from "react";

import type { ChartData } from "../sheetCharts";
import {
  CHART_PAD,
  barLayout,
  chartColorAt,
  lineLayout,
  niceMax,
  pieLayout,
  valueExtent,
} from "../sheetCharts";

export type ChartMarkType = "bar" | "line" | "pie";

interface MarkLayout {
  width: number;
  height: number;
  pad: typeof CHART_PAD;
}

export interface ChartMarksProps {
  type: ChartMarkType;
  data: ChartData;
  width: number;
  height: number;
}

export function ChartMarks({ type, data, width, height }: ChartMarksProps) {
  const layout: MarkLayout = { width, height, pad: CHART_PAD };
  if (type === "pie") return renderPie(data, layout);
  if (type === "line") return renderLine(data, layout);
  return renderBar(data, layout);
}

function axisMax(data: ChartData): number {
  return niceMax(valueExtent(data).max);
}

function renderBar(data: ChartData, layout: MarkLayout) {
  const { bars } = barLayout(data, layout);
  const max = axisMax(data);
  const baselineY = layout.height - layout.pad.bottom;
  return (
    <>
      <line
        x1={layout.pad.left}
        y1={baselineY}
        x2={layout.width - layout.pad.right}
        y2={baselineY}
        className="sheet-chart-axis"
      />
      <text
        x={layout.pad.left - 4}
        y={layout.pad.top + 8}
        className="sheet-chart-tick"
        textAnchor="end"
      >
        {formatTick(max)}
      </text>
      {bars.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={b.y}
          width={b.width}
          height={b.height}
          fill={chartColorAt(b.seriesIndex)}
          rx={1}
        >
          <title>{`${data.labels[b.categoryIndex]}: ${data.series[b.seriesIndex].values[b.categoryIndex]}`}</title>
        </rect>
      ))}
      {renderCategoryLabels(data, layout)}
    </>
  );
}

function renderLine(data: ChartData, layout: MarkLayout) {
  const { lines } = lineLayout(data, layout);
  const max = axisMax(data);
  const baselineY = layout.height - layout.pad.bottom;
  return (
    <>
      <line
        x1={layout.pad.left}
        y1={baselineY}
        x2={layout.width - layout.pad.right}
        y2={baselineY}
        className="sheet-chart-axis"
      />
      <text
        x={layout.pad.left - 4}
        y={layout.pad.top + 8}
        className="sheet-chart-tick"
        textAnchor="end"
      >
        {formatTick(max)}
      </text>
      {lines.map((l) =>
        l.segments.map((seg, si) => (
          <polyline
            key={`${l.seriesIndex}-${si}`}
            points={seg}
            fill="none"
            stroke={chartColorAt(l.seriesIndex)}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )),
      )}
      {lines.map((l) =>
        l.points.map((p, pi) => (
          <circle
            key={`${l.seriesIndex}-pt-${pi}`}
            cx={p.x}
            cy={p.y}
            r={2.5}
            fill={chartColorAt(l.seriesIndex)}
          />
        )),
      )}
      {renderCategoryLabels(data, layout)}
    </>
  );
}

function renderPie(data: ChartData, layout: MarkLayout) {
  const cx = layout.width / 2;
  const cy = layout.height / 2;
  const r = Math.min(layout.width, layout.height) / 2 - 12;
  const slices = pieLayout(data, cx, cy, r);
  return (
    <>
      {slices.map((s) => (
        <path
          key={s.categoryIndex}
          d={s.path}
          fill={chartColorAt(s.categoryIndex)}
          stroke="var(--color-bg-page, #fff)"
          strokeWidth={1}
        >
          <title>{`${data.labels[s.categoryIndex]}: ${s.value} (${Math.round(
            s.fraction * 100,
          )}%)`}</title>
        </path>
      ))}
    </>
  );
}

/** X-axis category labels, thinned so they never overlap. */
function renderCategoryLabels(data: ChartData, layout: MarkLayout) {
  const n = data.labels.length;
  if (n === 0) return null;
  const plotW = layout.width - layout.pad.left - layout.pad.right;
  const y = layout.height - layout.pad.bottom + 12;
  // Cap at ~6 labels to avoid overlap on dense ranges.
  const stride = Math.max(1, Math.ceil(n / 6));
  const out: ReactNode[] = [];
  for (let i = 0; i < n; i += stride) {
    const x = layout.pad.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    out.push(
      <text
        key={i}
        x={x}
        y={y}
        className="sheet-chart-tick"
        textAnchor="middle"
      >
        {truncate(data.labels[i])}
      </text>,
    );
  }
  return <>{out}</>;
}

function truncate(label: string): string {
  return label.length > 6 ? `${label.slice(0, 5)}…` : label;
}

/** Compact numeric tick (e.g. 1500 → "1.5k"). */
function formatTick(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toPrecision(3)}M`;
  if (value >= 1_000) return `${(value / 1_000).toPrecision(3)}k`;
  return String(value);
}
