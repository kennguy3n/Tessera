/**
 * Built-in sheet templates for the in-editor template gallery.
 *
 * A pure, side-effect-free metadata module (mirrors `slideTemplates.ts`):
 * each template materialises into a {@link SheetTemplateContent} — a
 * structural subset of {@link SheetContent} — carrying column headers,
 * sample rows, live formulas, number formats, and (where it adds value)
 * a chart, conditional-formatting rules, or data-validation. Applying a
 * template replaces the editor's current content with a fresh copy.
 *
 * Authoring note on cell addressing: the grid renders `columns` as the
 * header and `rows` as the data grid, and the formula engine/charts
 * address the data grid only — A1 resolves to `rows[0][0]`. So a formula
 * living in `rows[i]` that references its own row uses the A1 row number
 * `i + 1` (e.g. `rows[0]` uses `=B1-C1`), and a chart range like
 * `"D1:D12"` plots the first twelve data rows of column D.
 */
import type {
  CellFormat,
  ChartSpec,
  ConditionalFormatRule,
  PivotSpec,
  SheetContent,
  SheetNamedRange,
  ValidationMap,
} from "./sheetEditorTypes";

/**
 * Closed union of template categories. Authoring a typo'd category is a
 * compile error, and the gallery's category chips are derived from this
 * list so they can never drift out of sync with the data.
 */
export type SheetTemplateCategory =
  | "Finance"
  | "Sales"
  | "Operations"
  | "Project Management";

export const SHEET_TEMPLATE_CATEGORIES: readonly SheetTemplateCategory[] = [
  "Finance",
  "Sales",
  "Operations",
  "Project Management",
] as const;

/** Sentinel category meaning "show every template" in the gallery filter. */
export const ALL_SHEET_TEMPLATES_CATEGORY = "All" as const;

export type SheetTemplateCategoryFilter =
  | SheetTemplateCategory
  | typeof ALL_SHEET_TEMPLATES_CATEGORY;

/**
 * The materialisable content of a sheet template: the structural subset
 * of {@link SheetContent} a template can carry. Both the built-ins below
 * and a user's "Save as template" capture produce this exact shape, so
 * the gallery, the persistence store, and the portable-file format all
 * share one type.
 */
export interface SheetTemplateContent {
  columns: string[];
  rows: string[][];
  formats?: Record<string, CellFormat>;
  conditionalRules?: ConditionalFormatRule[];
  validations?: ValidationMap;
  charts?: ChartSpec[];
  pivots?: PivotSpec[];
  namedRanges?: SheetNamedRange[];
  columnWidths?: (number | undefined)[];
  rowHeights?: (number | undefined)[];
  frozenRows?: number;
  frozenCols?: number;
}

/** A curated, built-in starter sheet. */
export interface SheetTemplate {
  /** Stable id (also used as the React key and chart/rule id prefix). */
  id: string;
  /** Short human label shown on the gallery card. */
  label: string;
  /** One-line summary shown under the label and matched by search. */
  description: string;
  /** Emoji glyph rendered on the gallery card (dependency-free). */
  icon: string;
  category: SheetTemplateCategory;
  /** Fully-expanded, ready-to-apply content. */
  content: SheetTemplateContent;
}

/**
 * Compact authoring spec for a built-in. `columnFormats` (column index →
 * number-format pattern) is expanded to per-data-row `formats` entries by
 * {@link buildTemplate}; `cellFormats` (explicit `"row,col"` keys) is then
 * merged on top so a totals row can layer bold over a currency column.
 */
interface TemplateSpec {
  id: string;
  label: string;
  description: string;
  icon: string;
  category: SheetTemplateCategory;
  columns: string[];
  rows: string[][];
  columnFormats?: Record<number, string>;
  cellFormats?: Record<string, CellFormat>;
  conditionalRules?: ConditionalFormatRule[];
  validations?: ValidationMap;
  charts?: ChartSpec[];
  pivots?: PivotSpec[];
  frozenRows?: number;
  frozenCols?: number;
}

/** Expand `columnFormats` over every data row, then merge `cellFormats`. */
function expandFormats(
  rowCount: number,
  columnFormats: Record<number, string> | undefined,
  cellFormats: Record<string, CellFormat> | undefined,
): Record<string, CellFormat> | undefined {
  const out: Record<string, CellFormat> = {};
  if (columnFormats) {
    for (const [colStr, pattern] of Object.entries(columnFormats)) {
      const col = Number(colStr);
      for (let row = 0; row < rowCount; row++) {
        out[`${row},${col}`] = { numberFormat: pattern };
      }
    }
  }
  if (cellFormats) {
    for (const [key, fmt] of Object.entries(cellFormats)) {
      out[key] = { ...out[key], ...fmt };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Materialise a {@link TemplateSpec} into a ready-to-apply template. */
function buildTemplate(spec: TemplateSpec): SheetTemplate {
  const content: SheetTemplateContent = {
    columns: spec.columns,
    rows: spec.rows,
  };
  const formats = expandFormats(
    spec.rows.length,
    spec.columnFormats,
    spec.cellFormats,
  );
  if (formats) content.formats = formats;
  if (spec.conditionalRules && spec.conditionalRules.length > 0) {
    content.conditionalRules = spec.conditionalRules;
  }
  if (spec.validations && Object.keys(spec.validations).length > 0) {
    content.validations = spec.validations;
  }
  if (spec.charts && spec.charts.length > 0) content.charts = spec.charts;
  if (spec.pivots && spec.pivots.length > 0) content.pivots = spec.pivots;
  if (spec.frozenRows) content.frozenRows = spec.frozenRows;
  if (spec.frozenCols) content.frozenCols = spec.frozenCols;
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    icon: spec.icon,
    category: spec.category,
    content,
  };
}

// Number-format patterns reused across the built-ins. These are the
// engine's existing TEXT()-style patterns (see formulaEngine/format.ts).
const CURRENCY = "$#,##0.00";
const CURRENCY_WHOLE = "$#,##0";
const PERCENT = "0%";
const INTEGER = "#,##0";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Bold styling layered onto a totals / summary row by `cellFormats`. */
function boldRow(
  rowIndex: number,
  colCount: number,
): Record<string, CellFormat> {
  const out: Record<string, CellFormat> = {};
  for (let col = 0; col < colCount; col++) {
    out[`${rowIndex},${col}`] = { bold: true };
  }
  return out;
}

const MONTHLY_BUDGET = buildTemplate({
  id: "monthly-budget",
  label: "Monthly budget",
  description:
    "Track monthly income, expenses, and net savings with a year-end total and a savings trend chart.",
  icon: "💰",
  category: "Finance",
  columns: ["Month", "Income", "Expenses", "Savings"],
  rows: [
    ...MONTHS.map((month, i) => {
      const row = i + 1;
      return [month, "5200", "3800", `=B${row}-C${row}`];
    }),
    ["Total", "=SUM(B1:B12)", "=SUM(C1:C12)", "=SUM(D1:D12)"],
  ],
  columnFormats: { 1: CURRENCY_WHOLE, 2: CURRENCY_WHOLE, 3: CURRENCY_WHOLE },
  cellFormats: boldRow(12, 4),
  charts: [
    {
      id: "monthly-budget-chart",
      type: "line",
      title: "Net savings by month",
      range: "D1:D12",
      labelRange: "A1:A12",
    },
  ],
});

const CASH_FLOW = buildTemplate({
  id: "cash-flow",
  label: "Cash flow",
  description:
    "Roll opening balance into closing balance each month with live inflow/outflow formulas and a balance chart.",
  icon: "📈",
  category: "Finance",
  columns: [
    "Month",
    "Opening balance",
    "Inflows",
    "Outflows",
    "Closing balance",
  ],
  rows: [
    ["January", "10000", "8200", "6500", "=B1+C1-D1"],
    ["February", "=E1", "7800", "7100", "=B2+C2-D2"],
    ["March", "=E2", "9100", "6900", "=B3+C3-D3"],
    ["April", "=E3", "8600", "7400", "=B4+C4-D4"],
    ["May", "=E4", "9400", "8000", "=B5+C5-D5"],
    ["June", "=E5", "10200", "7600", "=B6+C6-D6"],
  ],
  columnFormats: {
    1: CURRENCY_WHOLE,
    2: CURRENCY_WHOLE,
    3: CURRENCY_WHOLE,
    4: CURRENCY_WHOLE,
  },
  charts: [
    {
      id: "cash-flow-chart",
      type: "line",
      title: "Closing balance",
      range: "E1:E6",
      labelRange: "A1:A6",
    },
  ],
});

const SALES_FORECAST = buildTemplate({
  id: "sales-forecast",
  label: "Sales forecast",
  description:
    "Project revenue per product from units, unit price, and a growth rate, with a revenue-by-product chart.",
  icon: "🧮",
  category: "Sales",
  columns: ["Product", "Units", "Unit price", "Revenue", "Growth", "Forecast"],
  rows: [
    ["Starter plan", "120", "29", "=B1*C1", "0.12", "=D1*(1+E1)"],
    ["Pro plan", "80", "79", "=B2*C2", "0.18", "=D2*(1+E2)"],
    ["Team plan", "45", "149", "=B3*C3", "0.22", "=D3*(1+E3)"],
    ["Enterprise", "12", "599", "=B4*C4", "0.3", "=D4*(1+E4)"],
    ["Total", "=SUM(B1:B4)", "", "=SUM(D1:D4)", "", "=SUM(F1:F4)"],
  ],
  columnFormats: {
    1: INTEGER,
    2: CURRENCY,
    3: CURRENCY,
    4: PERCENT,
    5: CURRENCY,
  },
  cellFormats: boldRow(4, 6),
  charts: [
    {
      id: "sales-forecast-chart",
      type: "bar",
      title: "Revenue by product",
      range: "D1:D4",
      labelRange: "A1:A4",
    },
  ],
});

const PROJECT_TRACKER = buildTemplate({
  id: "project-tracker",
  label: "Project tracker",
  description:
    "Plan tasks with owners, a status dropdown, due dates, and percent-complete — colour-coded by status.",
  icon: "🗂️",
  category: "Project Management",
  columns: ["Task", "Owner", "Status", "Start", "Due", "% Complete"],
  rows: [
    ["Kickoff & scope", "Alex", "Done", "2026-01-05", "2026-01-09", "1"],
    [
      "Design review",
      "Priya",
      "In progress",
      "2026-01-12",
      "2026-01-20",
      "0.6",
    ],
    ["Build feature", "Sam", "In progress", "2026-01-21", "2026-02-10", "0.3"],
    ["QA & polish", "Jordan", "Not started", "2026-02-11", "2026-02-21", "0"],
    ["Launch", "Alex", "Blocked", "2026-02-23", "2026-02-27", "0"],
  ],
  columnFormats: {
    3: "yyyy-mm-dd",
    4: "yyyy-mm-dd",
    5: PERCENT,
  },
  validations: {
    "2": {
      kind: "list",
      values: ["Not started", "In progress", "Blocked", "Done"],
    },
  },
  conditionalRules: [
    {
      id: "project-tracker-done",
      column: 2,
      operator: "eq",
      value: "Done",
      style: { background: "#dcfce7", color: "#166534" },
    },
    {
      id: "project-tracker-blocked",
      column: 2,
      operator: "eq",
      value: "Blocked",
      style: { background: "#fee2e2", color: "#991b1b", bold: true },
    },
  ],
  frozenCols: 1,
});

const INVENTORY_REORDER = buildTemplate({
  id: "inventory-reorder",
  label: "Inventory reorder",
  description:
    "Flag items at or below their reorder point automatically and highlight everything that needs restocking.",
  icon: "📦",
  category: "Operations",
  columns: ["SKU", "Item", "On hand", "Reorder point", "Reorder qty", "Status"],
  rows: [
    ["SKU-001", "Widget A", "12", "20", "50", '=IF(C1<=D1,"REORDER","OK")'],
    ["SKU-002", "Widget B", "64", "30", "40", '=IF(C2<=D2,"REORDER","OK")'],
    ["SKU-003", "Gadget C", "8", "15", "60", '=IF(C3<=D3,"REORDER","OK")'],
    ["SKU-004", "Gadget D", "120", "50", "75", '=IF(C4<=D4,"REORDER","OK")'],
    ["SKU-005", "Cable E", "5", "25", "100", '=IF(C5<=D5,"REORDER","OK")'],
  ],
  columnFormats: { 2: INTEGER, 3: INTEGER, 4: INTEGER },
  conditionalRules: [
    {
      id: "inventory-reorder-flag",
      column: 5,
      operator: "eq",
      value: "REORDER",
      style: { background: "#fee2e2", color: "#991b1b", bold: true },
    },
  ],
});

const KPI_SCORECARD = buildTemplate({
  id: "kpi-scorecard",
  label: "KPI scorecard",
  description:
    "Compare actuals to targets, compute attainment, and grade each KPI on track / at risk / off track.",
  icon: "🎯",
  category: "Operations",
  columns: ["KPI", "Target", "Actual", "Attainment", "Status"],
  rows: [
    [
      "New signups",
      "500",
      "540",
      "=C1/B1",
      '=IF(D1>=1,"On track",IF(D1>=0.8,"At risk","Off track"))',
    ],
    [
      "Activation rate",
      "0.6",
      "0.52",
      "=C2/B2",
      '=IF(D2>=1,"On track",IF(D2>=0.8,"At risk","Off track"))',
    ],
    [
      "Monthly revenue",
      "75000",
      "68000",
      "=C3/B3",
      '=IF(D3>=1,"On track",IF(D3>=0.8,"At risk","Off track"))',
    ],
    [
      "Churn",
      "0.03",
      "0.041",
      "=C4/B4",
      '=IF(D4>=1,"On track",IF(D4>=0.8,"At risk","Off track"))',
    ],
  ],
  columnFormats: { 3: PERCENT },
  conditionalRules: [
    {
      id: "kpi-on-track",
      column: 4,
      operator: "eq",
      value: "On track",
      style: { background: "#dcfce7", color: "#166534" },
    },
    {
      id: "kpi-at-risk",
      column: 4,
      operator: "eq",
      value: "At risk",
      style: { background: "#fef9c3", color: "#854d0e" },
    },
    {
      id: "kpi-off-track",
      column: 4,
      operator: "eq",
      value: "Off track",
      style: { background: "#fee2e2", color: "#991b1b", bold: true },
    },
  ],
});

const EXPENSE_REPORT = buildTemplate({
  id: "expense-report",
  label: "Expense report",
  description:
    "Log expenses by category with a reimbursable checkbox and an auto-summing total row.",
  icon: "🧾",
  category: "Finance",
  columns: ["Date", "Category", "Description", "Amount", "Reimbursable"],
  rows: [
    ["2026-03-01", "Travel", "Taxi to airport", "42.50", "TRUE"],
    ["2026-03-02", "Meals", "Client lunch", "86.20", "TRUE"],
    ["2026-03-03", "Software", "Design tool seat", "29.00", "FALSE"],
    ["2026-03-04", "Lodging", "Hotel (2 nights)", "318.00", "TRUE"],
    ["Total", "", "", "=SUM(D1:D4)", ""],
  ],
  columnFormats: { 0: "yyyy-mm-dd", 3: CURRENCY },
  cellFormats: { ...boldRow(4, 5), "4,0": { bold: true } },
  validations: {
    "1": {
      kind: "list",
      values: ["Travel", "Meals", "Software", "Lodging", "Other"],
    },
    "4": { kind: "checkbox" },
  },
});

export const SHEET_TEMPLATES: readonly SheetTemplate[] = [
  MONTHLY_BUDGET,
  CASH_FLOW,
  SALES_FORECAST,
  PROJECT_TRACKER,
  INVENTORY_REORDER,
  KPI_SCORECARD,
  EXPENSE_REPORT,
];

const TEMPLATE_BY_ID = new Map<string, SheetTemplate>(
  SHEET_TEMPLATES.map((t) => [t.id, t]),
);

/** Look up a built-in template by id. */
export function getSheetTemplate(id: string): SheetTemplate | undefined {
  return TEMPLATE_BY_ID.get(id);
}

/**
 * The minimal shape {@link filterSheetTemplates} needs. Both built-in
 * {@link SheetTemplate}s and user templates satisfy it, so one filter
 * serves the whole gallery.
 */
export interface FilterableSheetTemplate {
  label: string;
  description?: string;
  category?: SheetTemplateCategory;
}

/**
 * Filter templates by category and a free-text query (case-insensitive,
 * matched against label + description + category). Mirrors
 * `filterSlideTemplates` so the two galleries behave identically.
 */
export function filterSheetTemplates<T extends FilterableSheetTemplate>(
  templates: readonly T[],
  category: SheetTemplateCategoryFilter,
  query: string,
): T[] {
  const normalisedQuery = query.trim().toLowerCase();
  return templates.filter((t) => {
    if (category !== ALL_SHEET_TEMPLATES_CATEGORY && t.category !== category) {
      return false;
    }
    if (normalisedQuery.length === 0) return true;
    const haystack =
      `${t.label} ${t.description ?? ""} ${t.category ?? ""}`.toLowerCase();
    return haystack.includes(normalisedQuery);
  });
}

/**
 * Convert a {@link SheetTemplateContent} into a full {@link SheetContent}
 * ready to mount in the editor. Empty optional collections are dropped so
 * the serialised artifact stays byte-identical to legacy single-sheet
 * JSON when a template carries no extras.
 */
export function sheetContentFromTemplate(
  template: SheetTemplateContent,
): SheetContent {
  const content: SheetContent = {
    columns: template.columns.slice(),
    rows: template.rows.map((row) => row.slice()),
  };
  if (template.formats && Object.keys(template.formats).length > 0) {
    content.formats = template.formats;
  }
  if (template.conditionalRules && template.conditionalRules.length > 0) {
    content.conditionalRules = template.conditionalRules;
  }
  if (template.validations && Object.keys(template.validations).length > 0) {
    content.validations = template.validations;
  }
  if (template.charts && template.charts.length > 0) {
    content.charts = template.charts;
  }
  if (template.pivots && template.pivots.length > 0) {
    content.pivots = template.pivots;
  }
  if (template.namedRanges && template.namedRanges.length > 0) {
    content.namedRanges = template.namedRanges;
  }
  if (template.columnWidths && template.columnWidths.length > 0) {
    content.columnWidths = template.columnWidths;
  }
  if (template.rowHeights && template.rowHeights.length > 0) {
    content.rowHeights = template.rowHeights;
  }
  if (template.frozenRows) content.frozenRows = template.frozenRows;
  if (template.frozenCols) content.frozenCols = template.frozenCols;
  return content;
}
