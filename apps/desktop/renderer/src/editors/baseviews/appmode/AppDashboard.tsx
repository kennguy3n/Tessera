/**
 * App-mode dashboard.
 *
 * Renders the base's configured widgets — counts, group-by breakdowns,
 * rollups and a lightweight bar chart — over the live document. All
 * aggregation is delegated to the pure {@link computeWidget} so this
 * file only concerns itself with presentation and (when the user opts
 * into "Edit") a small inline authoring surface for adding / removing /
 * configuring widgets.
 *
 * The chart is hand-rolled SVG via the existing `sheetCharts` layout
 * helpers — no charting dependency is pulled in.
 */
import { useMemo } from "react";
import {
  barLayout,
  chartColorAt,
  hasPlottableData,
  yAxisTicks,
  type ChartData,
} from "../../sheetCharts";
import type {
  BaseAppConfig,
  BaseAppWidget,
  BaseAppWidgetKind,
  BaseDocument,
  BaseField,
  BaseTable,
  RollupAggregation,
} from "../../baseEditorTypes";
import { createWidget } from "./appConfig";
import {
  computeWidget,
  type WidgetDatum,
  type WidgetView,
} from "./dashboardData";

const WIDGET_KINDS: { kind: BaseAppWidgetKind; label: string }[] = [
  { kind: "count", label: "Count" },
  { kind: "group", label: "Group by" },
  { kind: "rollup", label: "Rollup" },
  { kind: "chart", label: "Bar chart" },
];

const AGGREGATIONS: RollupAggregation[] = ["SUM", "AVG", "MIN", "MAX", "COUNT"];

const NUMERIC_TYPES = new Set<BaseField["type"]>([
  "number",
  "currency",
  "percent",
  "rating",
  "duration",
]);

export interface AppDashboardProps {
  doc: BaseDocument;
  app: BaseAppConfig;
  editing: boolean;
  onAppConfigChange: (app: BaseAppConfig) => void;
}

export default function AppDashboard({
  doc,
  app,
  editing,
  onAppConfigChange,
}: AppDashboardProps) {
  const widgets = app.dashboard.widgets;

  const setWidgets = (next: BaseAppWidget[]) =>
    onAppConfigChange({
      ...app,
      dashboard: { ...app.dashboard, widgets: next },
    });

  const updateWidget = (id: string, patch: Partial<BaseAppWidget>) =>
    setWidgets(widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)));

  const removeWidget = (id: string) =>
    setWidgets(widgets.filter((w) => w.id !== id));

  const addWidget = (kind: BaseAppWidgetKind) => {
    const table = doc.tables[0];
    if (!table) return;
    setWidgets([...widgets, createWidget(kind, table)]);
  };

  return (
    <div className="base-app-dashboard" data-testid="base-app-dashboard">
      <div className="base-app-dashboard-bar">
        {editing ? (
          <label className="base-app-field base-app-dashboard-title-edit">
            <span>Dashboard title</span>
            <input
              type="text"
              value={app.dashboard.title ?? ""}
              placeholder="Dashboard"
              onChange={(e) =>
                onAppConfigChange({
                  ...app,
                  dashboard: {
                    ...app.dashboard,
                    title:
                      e.target.value.trim() === "" ? undefined : e.target.value,
                  },
                })
              }
            />
          </label>
        ) : (
          <h2 className="base-app-dashboard-title">
            {app.dashboard.title?.trim() || "Dashboard"}
          </h2>
        )}
      </div>

      {editing && (
        <div className="base-app-widget-add" data-testid="base-app-widget-add">
          <span className="base-app-widget-add-label">Add widget:</span>
          {WIDGET_KINDS.map((w) => (
            <button
              key={w.kind}
              type="button"
              className="btn-sm"
              onClick={() => addWidget(w.kind)}
            >
              + {w.label}
            </button>
          ))}
        </div>
      )}

      {widgets.length === 0 ? (
        <p className="base-app-empty">
          {editing
            ? "Add a widget to start summarising this base."
            : "No dashboard widgets yet."}
        </p>
      ) : (
        <div className="base-app-widget-grid">
          {widgets.map((widget) => (
            <WidgetCard
              key={widget.id}
              widget={widget}
              doc={doc}
              editing={editing}
              onChange={(patch) => updateWidget(widget.id, patch)}
              onRemove={() => removeWidget(widget.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface WidgetCardProps {
  widget: BaseAppWidget;
  doc: BaseDocument;
  editing: boolean;
  onChange: (patch: Partial<BaseAppWidget>) => void;
  onRemove: () => void;
}

function WidgetCard({
  widget,
  doc,
  editing,
  onChange,
  onRemove,
}: WidgetCardProps) {
  const view = useMemo(() => computeWidget(widget, doc), [widget, doc]);
  return (
    <section className="base-app-widget" data-testid="base-app-widget">
      <header className="base-app-widget-head">
        <h3 className="base-app-widget-title">{view.title}</h3>
        {editing && (
          <button
            type="button"
            className="btn-sm base-app-danger"
            aria-label="Remove widget"
            onClick={onRemove}
          >
            ×
          </button>
        )}
      </header>
      {editing && (
        <WidgetEditor widget={widget} doc={doc} onChange={onChange} />
      )}
      <WidgetBody view={view} />
    </section>
  );
}

function WidgetBody({ view }: { view: WidgetView }) {
  switch (view.kind) {
    case "count":
      return (
        <div className="base-app-widget-metric">
          <span className="base-app-widget-number">{view.count}</span>
          <span className="base-app-widget-caption">records</span>
        </div>
      );
    case "rollup":
      return (
        <div className="base-app-widget-metric">
          <span className="base-app-widget-number">{view.display || "—"}</span>
          <span className="base-app-widget-caption">{view.caption}</span>
        </div>
      );
    case "group":
      return <GroupList rows={view.rows} total={view.total} />;
    case "chart":
      return <BarChart rows={view.rows} seriesName={view.seriesName} />;
    case "invalid":
      return <p className="base-app-widget-hint">{view.reason}</p>;
  }
}

function GroupList({ rows, total }: { rows: WidgetDatum[]; total: number }) {
  if (rows.length === 0) {
    return <p className="base-app-widget-hint">No data yet.</p>;
  }
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0) || 1;
  return (
    <ul className="base-app-group-list">
      {rows.map((r) => (
        <li key={r.label} className="base-app-group-row">
          <span className="base-app-group-label" title={r.label}>
            {r.label}
          </span>
          <span className="base-app-group-bar-track" aria-hidden>
            <span
              className="base-app-group-bar-fill"
              style={{ width: `${(r.value / max) * 100}%` }}
            />
          </span>
          <span className="base-app-group-value">{r.value}</span>
        </li>
      ))}
      {total > 0 && (
        <li className="base-app-group-total">
          <span className="base-app-group-label">Total</span>
          <span />
          <span className="base-app-group-value">{total}</span>
        </li>
      )}
    </ul>
  );
}

const CHART_W = 480;
const CHART_H = 220;
const CHART_PAD = { top: 8, right: 8, bottom: 56, left: 36 };

function BarChart({
  rows,
  seriesName,
}: {
  rows: WidgetDatum[];
  seriesName: string;
}) {
  const data: ChartData = useMemo(
    () => ({
      labels: rows.map((r) => r.label),
      series: [{ name: seriesName, values: rows.map((r) => r.value) }],
    }),
    [rows, seriesName],
  );
  const { bars, max } = useMemo(
    () => barLayout(data, { width: CHART_W, height: CHART_H, pad: CHART_PAD }),
    [data],
  );

  if (!hasPlottableData(data)) {
    return <p className="base-app-widget-hint">No data yet.</p>;
  }

  const ticks = yAxisTicks(max);
  const plotBottom = CHART_H - CHART_PAD.bottom;
  const plotTop = CHART_PAD.top;
  const plotH = plotBottom - plotTop;
  const groupW =
    rows.length > 0
      ? (CHART_W - CHART_PAD.left - CHART_PAD.right) / rows.length
      : 0;

  return (
    <svg
      className="base-app-chart"
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      role="img"
      aria-label={`${seriesName} bar chart`}
      data-testid="base-app-chart"
      preserveAspectRatio="xMidYMid meet"
    >
      {ticks.map((t) => {
        const y = plotBottom - (t / max) * plotH;
        return (
          <g key={t}>
            <line
              x1={CHART_PAD.left}
              y1={y}
              x2={CHART_W - CHART_PAD.right}
              y2={y}
              className="base-app-chart-grid"
            />
            <text
              x={CHART_PAD.left - 4}
              y={y + 3}
              className="base-app-chart-axis"
              textAnchor="end"
            >
              {Number.isInteger(t) ? t : t.toFixed(1)}
            </text>
          </g>
        );
      })}
      {bars.map((bar) => (
        <rect
          key={`${bar.categoryIndex}-${bar.seriesIndex}`}
          x={bar.x}
          y={bar.y}
          width={bar.width}
          height={bar.height}
          fill={chartColorAt(bar.seriesIndex)}
          rx={2}
        />
      ))}
      {data.labels.map((label, ci) => {
        const cx = CHART_PAD.left + ci * groupW + groupW / 2;
        return (
          <text
            key={label}
            x={cx}
            y={plotBottom + 14}
            className="base-app-chart-axis"
            textAnchor="end"
            transform={`rotate(-35 ${cx} ${plotBottom + 14})`}
          >
            {label.length > 14 ? `${label.slice(0, 13)}…` : label}
          </text>
        );
      })}
    </svg>
  );
}

interface WidgetEditorProps {
  widget: BaseAppWidget;
  doc: BaseDocument;
  onChange: (patch: Partial<BaseAppWidget>) => void;
}

function WidgetEditor({ widget, doc, onChange }: WidgetEditorProps) {
  const table: BaseTable | undefined = doc.tables.find(
    (t) => t.id === widget.tableId,
  );
  const fields = table?.fields ?? [];
  const numericFields = fields.filter((f) => NUMERIC_TYPES.has(f.type));
  const needsGroup = widget.kind === "group" || widget.kind === "chart";
  const needsValue = widget.kind === "rollup" || widget.kind === "chart";

  return (
    <div className="base-app-widget-editor">
      <label className="base-app-field">
        <span>Title</span>
        <input
          type="text"
          value={widget.title ?? ""}
          placeholder="Auto"
          onChange={(e) => onChange({ title: e.target.value })}
        />
      </label>
      <label className="base-app-field">
        <span>Table</span>
        <select
          value={widget.tableId}
          onChange={(e) =>
            onChange({
              tableId: e.target.value,
              groupByField: undefined,
              valueField: undefined,
            })
          }
        >
          {doc.tables.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {needsGroup && (
        <label className="base-app-field">
          <span>Group by</span>
          <select
            value={widget.groupByField ?? ""}
            onChange={(e) =>
              onChange({ groupByField: e.target.value || undefined })
            }
          >
            <option value="">—</option>
            {fields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {needsValue && (
        <label className="base-app-field">
          <span>Value</span>
          <select
            value={widget.valueField ?? ""}
            onChange={(e) =>
              onChange({ valueField: e.target.value || undefined })
            }
          >
            <option value="">{widget.kind === "chart" ? "Count" : "—"}</option>
            {numericFields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {(widget.kind === "rollup" || widget.kind === "chart") && (
        <label className="base-app-field">
          <span>Aggregation</span>
          <select
            value={
              widget.aggregation ?? (widget.kind === "rollup" ? "SUM" : "COUNT")
            }
            onChange={(e) =>
              onChange({ aggregation: e.target.value as RollupAggregation })
            }
          >
            {AGGREGATIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
