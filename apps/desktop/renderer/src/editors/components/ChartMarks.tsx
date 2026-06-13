/**
 * Shared, purely-presentational SVG chart marks.
 *
 * Both {@link SheetChart} (sheet editor) and {@link SlideChart} (slide
 * editor) wrap these marks in their own `<svg>` + chrome. All geometry
 * comes from the pure, unit-tested helpers in `sheetCharts.ts`; this
 * component only maps that geometry to themed SVG elements, so it stays
 * a thin shell with no charting dependency to audit.
 *
 * Supported marks: bar, line, area, scatter, combo (bars + line on one
 * shared axis), pie, and donut. The cartesian marks (everything except
 * pie/donut) share a multi-tick y-axis with light gridlines and thinned
 * x-axis category labels.
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
  areaLayout,
  barLayout,
  categoryX,
  chartColorAt,
  lineLayout,
  niceMax,
  pieLayout,
  valueExtent,
  yAxisTicks,
} from "../sheetCharts";

export type ChartMarkType =
  | "bar"
  | "line"
  | "area"
  | "scatter"
  | "combo"
  | "pie"
  | "donut";

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
  switch (type) {
    case "pie":
      return renderPie(data, layout, false);
    case "donut":
      return renderPie(data, layout, true);
    case "line":
      return renderLine(data, layout);
    case "area":
      return renderArea(data, layout);
    case "scatter":
      return renderScatter(data, layout);
    case "combo":
      return renderCombo(data, layout);
    default:
      return renderBar(data, layout);
  }
}

function axisMax(data: ChartData): number {
  return niceMax(valueExtent(data).max);
}

function plotSize(layout: MarkLayout): { plotW: number; plotH: number } {
  return {
    plotW: layout.width - layout.pad.left - layout.pad.right,
    plotH: layout.height - layout.pad.top - layout.pad.bottom,
  };
}

/**
 * Horizontal gridlines + value labels at evenly spaced y ticks. The
 * zero tick doubles as the baseline axis (drawn darker); the rest are
 * faint gridlines so the eye can read magnitudes off the plot.
 */
function renderYAxis(layout: MarkLayout, max: number) {
  const { plotW, plotH } = plotSize(layout);
  const ticks = yAxisTicks(max, 4);
  return (
    <>
      {ticks.map((t, i) => {
        const y =
          layout.pad.top + plotH - (max > 0 ? (t / max) * plotH : 0);
        return (
          <g key={i}>
            <line
              x1={layout.pad.left}
              y1={y}
              x2={layout.pad.left + plotW}
              y2={y}
              className={i === 0 ? "sheet-chart-axis" : "sheet-chart-grid"}
            />
            <text
              x={layout.pad.left - 4}
              y={y + 3}
              className="sheet-chart-tick"
              textAnchor="end"
            >
              {formatTick(t)}
            </text>
          </g>
        );
      })}
    </>
  );
}

function renderBar(data: ChartData, layout: MarkLayout) {
  const { bars, max } = barLayout(data, layout);
  return (
    <>
      {renderYAxis(layout, max)}
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
      {renderCategoryLabels(data, layout, "band")}
    </>
  );
}

function renderLine(data: ChartData, layout: MarkLayout) {
  const { lines, max } = lineLayout(data, layout);
  return (
    <>
      {renderYAxis(layout, max)}
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
      {renderCategoryLabels(data, layout, "edge")}
    </>
  );
}

function renderArea(data: ChartData, layout: MarkLayout) {
  const { areas, max } = areaLayout(data, layout);
  return (
    <>
      {renderYAxis(layout, max)}
      {areas.map((a) =>
        a.fills.map((d, fi) => (
          <path
            key={`${a.seriesIndex}-fill-${fi}`}
            d={d}
            fill={chartColorAt(a.seriesIndex)}
            fillOpacity={0.18}
            stroke="none"
          />
        )),
      )}
      {areas.map((a) =>
        a.segments.map((seg, si) => (
          <polyline
            key={`${a.seriesIndex}-${si}`}
            points={seg}
            fill="none"
            stroke={chartColorAt(a.seriesIndex)}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )),
      )}
      {areas.map((a) =>
        a.points.map((p, pi) => (
          <circle
            key={`${a.seriesIndex}-pt-${pi}`}
            cx={p.x}
            cy={p.y}
            r={2.5}
            fill={chartColorAt(a.seriesIndex)}
          />
        )),
      )}
      {renderCategoryLabels(data, layout, "edge")}
    </>
  );
}

function renderScatter(data: ChartData, layout: MarkLayout) {
  const max = axisMax(data);
  const { plotW, plotH } = plotSize(layout);
  const categories = data.labels.length;
  const dots: ReactNode[] = [];
  data.series.forEach((s, si) => {
    s.values.forEach((v, ci) => {
      if (v === null) return;
      const x = categoryX(ci, categories, layout.pad.left, plotW, "edge");
      const y = layout.pad.top + (plotH - (v / max) * plotH);
      dots.push(
        <circle
          key={`${si}-${ci}`}
          cx={x}
          cy={y}
          r={3.5}
          fill={chartColorAt(si)}
          fillOpacity={0.85}
        >
          <title>{`${data.labels[ci]}: ${v}`}</title>
        </circle>,
      );
    });
  });
  return (
    <>
      {renderYAxis(layout, max)}
      {dots}
      {renderCategoryLabels(data, layout, "edge")}
    </>
  );
}

/**
 * Combo: the first series as bars, every remaining series as a band-
 * aligned line. Both marks share one y-axis (the nice-rounded maximum
 * across all series) so the bars and line are directly comparable.
 */
function renderCombo(data: ChartData, layout: MarkLayout) {
  const max = axisMax(data);
  const barData: ChartData = { labels: data.labels, series: data.series.slice(0, 1) };
  const lineData: ChartData = { labels: data.labels, series: data.series.slice(1) };
  const { bars } = barLayout(barData, layout, max);
  const { lines } = lineLayout(lineData, layout, { maxOverride: max, align: "band" });
  return (
    <>
      {renderYAxis(layout, max)}
      {bars.map((b, i) => (
        <rect
          key={`bar-${i}`}
          x={b.x}
          y={b.y}
          width={b.width}
          height={b.height}
          fill={chartColorAt(0)}
          rx={1}
        >
          <title>{`${data.labels[b.categoryIndex]}: ${data.series[0].values[b.categoryIndex]}`}</title>
        </rect>
      ))}
      {lines.map((l) =>
        l.segments.map((seg, si) => (
          <polyline
            key={`line-${l.seriesIndex}-${si}`}
            points={seg}
            fill="none"
            stroke={chartColorAt(l.seriesIndex + 1)}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )),
      )}
      {lines.map((l) =>
        l.points.map((p, pi) => (
          <circle
            key={`line-${l.seriesIndex}-pt-${pi}`}
            cx={p.x}
            cy={p.y}
            r={2.5}
            fill={chartColorAt(l.seriesIndex + 1)}
          />
        )),
      )}
      {renderCategoryLabels(data, layout, "band")}
    </>
  );
}

function renderPie(data: ChartData, layout: MarkLayout, donut: boolean) {
  const cx = layout.width / 2;
  const cy = layout.height / 2;
  const r = Math.min(layout.width, layout.height) / 2 - 12;
  const innerRadius = donut ? r * 0.58 : 0;
  const slices = pieLayout(data, cx, cy, r, innerRadius);
  return (
    <>
      {slices.map((s) => (
        <path
          key={s.categoryIndex}
          d={s.path}
          fill={chartColorAt(s.categoryIndex)}
          fillRule="evenodd"
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

/**
 * X-axis category labels, thinned so they never overlap. `align` mirrors
 * the marks: bars/combo sit in the centre of a category band (`"band"`),
 * while line/area/scatter points sit on the axis ticks (`"edge"`), so the
 * label sits directly under its mark in both cases.
 */
function renderCategoryLabels(
  data: ChartData,
  layout: MarkLayout,
  align: "edge" | "band",
) {
  const n = data.labels.length;
  if (n === 0) return null;
  const plotW = layout.width - layout.pad.left - layout.pad.right;
  const y = layout.height - layout.pad.bottom + 12;
  // Cap at ~6 labels to avoid overlap on dense ranges.
  const stride = Math.max(1, Math.ceil(n / 6));
  const out: ReactNode[] = [];
  for (let i = 0; i < n; i += stride) {
    const x = categoryX(i, n, layout.pad.left, plotW, align);
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
  return String(Number(value.toFixed(2)));
}
