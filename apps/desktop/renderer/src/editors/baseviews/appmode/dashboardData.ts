/**
 * Pure aggregation for the app-mode dashboard.
 *
 * Each {@link BaseAppWidget} is reduced to a {@link WidgetView} — a
 * small, fully-resolved value object the React layer renders without
 * any further data wrangling. All maths reuses the existing,
 * unit-tested base helpers (`buildGroups`, `aggregateValues`) so the
 * dashboard agrees with the grid's group-by and rollup semantics
 * exactly, and so there is a single source of truth for "what does
 * SUM of this column mean".
 */
import { aggregateValues } from "../../baseEditorHelpers";
import { buildGroups } from "../../baseGridHelpers";
import type {
  BaseAppWidget,
  BaseDocument,
  BaseRecord,
  BaseTable,
  RollupAggregation,
} from "../../baseEditorTypes";

/** One labelled magnitude (a bar / a group row). */
export interface WidgetDatum {
  label: string;
  value: number;
}

/** A widget reduced to exactly what its renderer needs. */
export type WidgetView =
  | { kind: "count"; title: string; count: number; tableName: string }
  | {
      kind: "rollup";
      title: string;
      tableName: string;
      caption: string;
      display: string;
    }
  | {
      kind: "group";
      title: string;
      tableName: string;
      rows: WidgetDatum[];
      total: number;
    }
  | {
      kind: "chart";
      title: string;
      tableName: string;
      rows: WidgetDatum[];
      seriesName: string;
    }
  | { kind: "invalid"; title: string; reason: string };

/** Cap categories so a high-cardinality field can't explode the chart. */
const MAX_CHART_CATEGORIES = 20;

function aggregationLabel(agg: RollupAggregation): string {
  switch (agg) {
    case "SUM":
      return "Sum";
    case "AVG":
      return "Average";
    case "MIN":
      return "Min";
    case "MAX":
      return "Max";
    case "COUNT":
      return "Count";
    case "CONCAT":
      return "Concatenation";
  }
}

function defaultTitle(widget: BaseAppWidget, table: BaseTable): string {
  if (widget.title && widget.title.trim() !== "") return widget.title.trim();
  switch (widget.kind) {
    case "count":
      return `${table.name} count`;
    case "group":
      return widget.groupByField
        ? `${table.name} by ${widget.groupByField}`
        : `${table.name} groups`;
    case "rollup":
      return widget.valueField
        ? `${aggregationLabel(widget.aggregation ?? "SUM")} of ${widget.valueField}`
        : `${table.name} rollup`;
    case "chart":
      return widget.groupByField
        ? `${table.name} by ${widget.groupByField}`
        : `${table.name} chart`;
  }
}

/** Numeric value of an aggregation over `values` (non-numeric ⇒ 0). */
function numericAggregate(values: unknown[], agg: RollupAggregation): number {
  const raw = aggregateValues(values, agg);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function groupRows(
  records: BaseRecord[],
  groupByField: string,
  widget: BaseAppWidget,
): WidgetDatum[] {
  const groups = buildGroups(records, groupByField);
  const agg = widget.aggregation ?? "COUNT";
  const useValueField = widget.valueField && agg !== "COUNT";
  return groups.map((g) => ({
    label: g.label,
    value: useValueField
      ? numericAggregate(
          g.records.map((r) => r[widget.valueField as string]),
          agg,
        )
      : g.records.length,
  }));
}

/**
 * Reduce a widget against the live document. Returns an `invalid` view
 * (rather than throwing) whenever the widget points at a missing table
 * or is missing a field it needs, so a half-configured widget renders a
 * friendly hint instead of crashing the dashboard.
 */
export function computeWidget(
  widget: BaseAppWidget,
  doc: BaseDocument,
): WidgetView {
  const table = doc.tables.find((t) => t.id === widget.tableId);
  if (!table) {
    return {
      kind: "invalid",
      title: widget.title?.trim() || "Widget",
      reason: "Its table no longer exists.",
    };
  }
  const title = defaultTitle(widget, table);
  const records = table.records;

  switch (widget.kind) {
    case "count":
      return {
        kind: "count",
        title,
        tableName: table.name,
        count: records.length,
      };

    case "rollup": {
      const agg = widget.aggregation ?? "SUM";
      if (agg === "COUNT" && !widget.valueField) {
        return {
          kind: "rollup",
          title,
          tableName: table.name,
          caption: "Count of records",
          display: String(records.length),
        };
      }
      if (!widget.valueField) {
        return {
          kind: "invalid",
          title,
          reason: "Choose a field to summarise.",
        };
      }
      const values = records.map((r) => r[widget.valueField as string]);
      return {
        kind: "rollup",
        title,
        tableName: table.name,
        caption: `${aggregationLabel(agg)} of ${widget.valueField}`,
        display: aggregateValues(values, agg),
      };
    }

    case "group": {
      if (!widget.groupByField) {
        return {
          kind: "invalid",
          title,
          reason: "Choose a field to group by.",
        };
      }
      const rows = groupRows(records, widget.groupByField, widget);
      const total = rows.reduce((a, r) => a + r.value, 0);
      return { kind: "group", title, tableName: table.name, rows, total };
    }

    case "chart": {
      if (!widget.groupByField) {
        return {
          kind: "invalid",
          title,
          reason: "Choose a field to group by.",
        };
      }
      const agg = widget.aggregation ?? "COUNT";
      const all = groupRows(records, widget.groupByField, widget);
      // Largest categories first, then cap, so the chart stays legible
      // on a wide-cardinality field.
      const rows = [...all]
        .sort((a, b) => b.value - a.value)
        .slice(0, MAX_CHART_CATEGORIES);
      const seriesName =
        agg !== "COUNT" && widget.valueField
          ? `${aggregationLabel(agg)} of ${widget.valueField}`
          : "Count";
      return { kind: "chart", title, tableName: table.name, rows, seriesName };
    }
  }
}
