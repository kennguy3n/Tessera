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
import { useMemo } from "react";

import type { ChartData } from "../sheetCharts";
import {
  CHART_PAD,
  barLayout,
  hasPlottableData,
  lineLayout,
  niceMax,
  pieLayout,
  valueExtent,
} from "../sheetCharts";
import type { ChartSpec } from "../sheetEditorTypes";

const WIDTH = 320;
const HEIGHT = 200;

/**
 * Series palette. `--color-primary` tracks the active accent; the rest
 * are fixed, WCAG-legible hues that read on both light and dark
 * surfaces. Slices/series cycle through the list.
 */
const SERIES_COLORS = [
  "var(--color-primary)",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#0ea5e9",
  "#ec4899",
  "#14b8a6",
];

function colorAt(i: number): string {
  return SERIES_COLORS[i % SERIES_COLORS.length];
}

export interface SheetChartProps {
  spec: ChartSpec;
  data: ChartData;
  onRemove: () => void;
}

export function SheetChart({ spec, data, onRemove }: SheetChartProps) {
  const layout = useMemo(
    () => ({ width: WIDTH, height: HEIGHT, pad: CHART_PAD }),
    [],
  );

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
        <p className="sheet-chart-empty" data-testid={`sheet-chart-empty-${spec.id}`}>
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
          {spec.type === "pie"
            ? renderPie(data, layout)
            : spec.type === "line"
              ? renderLine(data, layout)
              : renderBar(data, layout)}
        </svg>
      )}

      {data.series.length > 1 || spec.type === "pie" ? (
        <ul className="sheet-chart-legend" aria-hidden="true">
          {spec.type === "pie"
            ? data.labels.map((label, i) => (
                <li key={i}>
                  <span
                    className="sheet-chart-swatch"
                    style={{ background: colorAt(i) }}
                  />
                  {label}
                </li>
              ))
            : data.series.map((s, i) => (
                <li key={s.name + i}>
                  <span
                    className="sheet-chart-swatch"
                    style={{ background: colorAt(i) }}
                  />
                  {s.name}
                </li>
              ))}
        </ul>
      ) : null}
    </figure>
  );
}

function axisMax(data: ChartData): number {
  return niceMax(valueExtent(data).max);
}

function renderBar(
  data: ChartData,
  layout: { width: number; height: number; pad: typeof CHART_PAD },
) {
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
          fill={colorAt(b.seriesIndex)}
          rx={1}
        >
          <title>{`${data.labels[b.categoryIndex]}: ${data.series[b.seriesIndex].values[b.categoryIndex]}`}</title>
        </rect>
      ))}
      {renderCategoryLabels(data, layout)}
    </>
  );
}

function renderLine(
  data: ChartData,
  layout: { width: number; height: number; pad: typeof CHART_PAD },
) {
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
            stroke={colorAt(l.seriesIndex)}
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
            fill={colorAt(l.seriesIndex)}
          />
        )),
      )}
      {renderCategoryLabels(data, layout)}
    </>
  );
}

function renderPie(
  data: ChartData,
  layout: { width: number; height: number; pad: typeof CHART_PAD },
) {
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
          fill={colorAt(s.categoryIndex)}
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
function renderCategoryLabels(
  data: ChartData,
  layout: { width: number; height: number; pad: typeof CHART_PAD },
) {
  const n = data.labels.length;
  if (n === 0) return null;
  const plotW = layout.width - layout.pad.left - layout.pad.right;
  const y = layout.height - layout.pad.bottom + 12;
  // Cap at ~6 labels to avoid overlap on dense ranges.
  const stride = Math.max(1, Math.ceil(n / 6));
  const out: React.ReactNode[] = [];
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
