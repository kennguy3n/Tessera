/**
 * Pure helpers for the Base "app usage" mode configuration.
 *
 * This module is deliberately React-free and side-effect-free so it can
 * be unit-tested in isolation and reused by both the persistence layer
 * (`baseDocumentHelpers`) and the app-mode UI (`AppShell` and friends).
 *
 * Design tenets:
 *   - **Legacy-safe / defensive.** `sanitizeAppConfig` accepts arbitrary
 *     parsed JSON (`unknown`) and always yields a well-formed
 *     {@link BaseAppConfig}; unknown widget kinds / aggregations and
 *     dangling field references degrade rather than throw.
 *   - **Stable references heal.** Single-table bases mint a fresh table
 *     id on every load (see `baseDocumentHelpers.singleTableDocument`),
 *     so {@link reconcileAppConfig} remaps any dangling `tableId` to the
 *     sole table — and drops forms/widgets whose table genuinely no
 *     longer exists in a multi-table base.
 *   - **Mostly derived UI.** {@link derivePages} builds the app nav from
 *     the document itself (a data page per table + the dashboard + each
 *     authored form), so an empty `app` block is still usable.
 */
import { makeRecordId } from "../../baseEditorHelpers";
import { fillableFields, isFormEditableField } from "../formViewHelpers";
import type {
  BaseAppConfig,
  BaseAppDashboard,
  BaseAppForm,
  BaseAppMode,
  BaseAppWidget,
  BaseAppWidgetKind,
  BaseDocument,
  BaseField,
  BaseTable,
  RollupAggregation,
} from "../../baseEditorTypes";

/** Mint an opaque id for a form / widget (shares the record-id generator). */
export function makeAppId(): string {
  return makeRecordId();
}

const WIDGET_KINDS: ReadonlySet<string> = new Set<BaseAppWidgetKind>([
  "count",
  "group",
  "rollup",
  "chart",
]);

const AGGREGATIONS: ReadonlySet<string> = new Set<RollupAggregation>([
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COUNT",
  "CONCAT",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asTrimmed(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function asMode(v: unknown): BaseAppMode | undefined {
  return v === "builder" || v === "app" ? v : undefined;
}

function asWidgetKind(v: unknown): BaseAppWidgetKind {
  return typeof v === "string" && WIDGET_KINDS.has(v)
    ? (v as BaseAppWidgetKind)
    : "count";
}

function asAggregation(v: unknown): RollupAggregation | undefined {
  return typeof v === "string" && AGGREGATIONS.has(v)
    ? (v as RollupAggregation)
    : undefined;
}

/** An empty-but-valid config: no forms, no widgets, opens in builder mode. */
export function emptyAppConfig(): BaseAppConfig {
  return { forms: [], dashboard: { widgets: [] } };
}

function sanitizeForm(raw: unknown, index: number): BaseAppForm | null {
  if (!isRecord(raw)) return null;
  return {
    id: asTrimmed(raw.id) ?? makeAppId(),
    name: asTrimmed(raw.name) ?? `Form ${index + 1}`,
    tableId: typeof raw.tableId === "string" ? raw.tableId : "",
    fieldNames: asStringArray(raw.fieldNames),
    description: asTrimmed(raw.description),
    submitLabel: asTrimmed(raw.submitLabel),
  };
}

function sanitizeWidget(raw: unknown): BaseAppWidget | null {
  if (!isRecord(raw)) return null;
  return {
    id: asTrimmed(raw.id) ?? makeAppId(),
    kind: asWidgetKind(raw.kind),
    tableId: typeof raw.tableId === "string" ? raw.tableId : "",
    title: asTrimmed(raw.title),
    groupByField: asTrimmed(raw.groupByField),
    valueField: asTrimmed(raw.valueField),
    aggregation: asAggregation(raw.aggregation),
  };
}

/**
 * Coerce arbitrary parsed JSON into a well-formed {@link BaseAppConfig},
 * or `undefined` when the input carries no `app` object at all (so a
 * legacy base stays `app`-less and opens in builder mode).
 */
export function sanitizeAppConfig(raw: unknown): BaseAppConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const formsRaw = Array.isArray(raw.forms) ? raw.forms : [];
  const forms: BaseAppForm[] = [];
  formsRaw.forEach((f, i) => {
    const form = sanitizeForm(f, i);
    if (form) forms.push(form);
  });

  const dashRaw = isRecord(raw.dashboard) ? raw.dashboard : {};
  const widgetsRaw = Array.isArray(dashRaw.widgets) ? dashRaw.widgets : [];
  const widgets: BaseAppWidget[] = [];
  widgetsRaw.forEach((w) => {
    const widget = sanitizeWidget(w);
    if (widget) widgets.push(widget);
  });

  const dashboard: BaseAppDashboard = {
    title: asTrimmed(dashRaw.title),
    widgets,
  };

  return {
    name: asTrimmed(raw.name),
    defaultMode: asMode(raw.defaultMode),
    forms,
    dashboard,
  };
}

/**
 * Resolve a stored `tableId` against the live document:
 *   - exact match wins;
 *   - a single-table base heals any dangling id to its sole table
 *     (single-table ids are regenerated each load);
 *   - otherwise `undefined` (the referenced table was deleted).
 */
export function resolveTableId(
  doc: BaseDocument,
  tableId: string,
): string | undefined {
  if (doc.tables.some((t) => t.id === tableId)) return tableId;
  if (doc.tables.length === 1) return doc.tables[0].id;
  return undefined;
}

function reconcileForm(
  form: BaseAppForm,
  doc: BaseDocument,
): BaseAppForm | null {
  const tableId = resolveTableId(doc, form.tableId);
  if (!tableId) return null;
  const table = doc.tables.find((t) => t.id === tableId);
  const valid = new Set(
    (table?.fields ?? [])
      .filter((f) => isFormEditableField(f))
      .map((f) => f.name),
  );
  return {
    ...form,
    tableId,
    fieldNames: form.fieldNames.filter((n) => valid.has(n)),
  };
}

function reconcileWidget(
  widget: BaseAppWidget,
  doc: BaseDocument,
): BaseAppWidget | null {
  const tableId = resolveTableId(doc, widget.tableId);
  if (!tableId) return null;
  const table = doc.tables.find((t) => t.id === tableId);
  const names = new Set((table?.fields ?? []).map((f) => f.name));
  return {
    ...widget,
    tableId,
    groupByField:
      widget.groupByField && names.has(widget.groupByField)
        ? widget.groupByField
        : undefined,
    valueField:
      widget.valueField && names.has(widget.valueField)
        ? widget.valueField
        : undefined,
  };
}

/**
 * Remap/drop a config's table & field references against the current
 * document. Forms/widgets pointing at a missing table are dropped
 * (multi-table) or healed onto the sole table (single-table); field
 * references that no longer exist are cleared so the widget/form
 * degrades to a safe default instead of rendering against a ghost
 * field.
 */
export function reconcileAppConfig(
  app: BaseAppConfig,
  doc: BaseDocument,
): BaseAppConfig {
  const forms: BaseAppForm[] = [];
  for (const f of app.forms) {
    const r = reconcileForm(f, doc);
    if (r) forms.push(r);
  }
  const widgets: BaseAppWidget[] = [];
  for (const w of app.dashboard.widgets) {
    const r = reconcileWidget(w, doc);
    if (r) widgets.push(r);
  }
  return {
    name: app.name,
    defaultMode: app.defaultMode,
    forms,
    dashboard: { title: app.dashboard.title, widgets },
  };
}

/**
 * Whether a config carries enough to be worth persisting. An empty
 * config (no forms, no widgets, no custom name, builder default) is NOT
 * meaningful, so a base that merely toggled into app mode and back stays
 * byte-compatible with its legacy body.
 */
export function isMeaningfulAppConfig(app: BaseAppConfig | undefined): boolean {
  if (!app) return false;
  return (
    app.forms.length > 0 ||
    app.dashboard.widgets.length > 0 ||
    app.dashboard.title !== undefined ||
    app.name !== undefined ||
    app.defaultMode === "app"
  );
}

/** The mode a base should OPEN in (legacy / app-less ⇒ builder). */
export function initialAppMode(doc: BaseDocument): BaseAppMode {
  return doc.app?.defaultMode === "app" ? "app" : "builder";
}

/**
 * The fields a form actually renders: its chosen subset (in the stored
 * order), or — when no subset is chosen — every fillable field of the
 * table. Always filtered to currently-fillable fields so a field that
 * became computed (e.g. converted to a formula) silently drops out.
 */
export function formFields(table: BaseTable, form: BaseAppForm): BaseField[] {
  const fillable = fillableFields(table.fields);
  if (form.fieldNames.length === 0) return fillable;
  const byName = new Map(fillable.map((f) => [f.name, f]));
  const out: BaseField[] = [];
  for (const name of form.fieldNames) {
    const f = byName.get(name);
    if (f) out.push(f);
  }
  return out;
}

const TITLE_NAME_HINTS = ["title", "name", "label", "subject"];

/**
 * Pick the field that best labels a record in a list / detail header:
 * a field literally named title/name/label/subject first, else the
 * first plain-text field, else simply the first field. Returns `null`
 * for an empty schema.
 */
export function titleFieldName(fields: BaseField[]): string | null {
  for (const hint of TITLE_NAME_HINTS) {
    const found = fields.find((f) => f.name.toLowerCase() === hint);
    if (found) return found.name;
  }
  const text = fields.find((f) => f.type === "text" || f.type === "long_text");
  if (text) return text.name;
  return fields[0]?.name ?? null;
}

/** A human label for a record, used by list rows and detail headers. */
export function recordTitle(
  fields: BaseField[],
  record: Record<string, unknown>,
): string {
  const name = titleFieldName(fields);
  if (name) {
    const raw = record[name];
    if (raw != null && String(raw).trim() !== "") return String(raw).trim();
  }
  return "Untitled";
}

/** A navigable page in the app shell's left nav. */
export type AppPage =
  | { kind: "dashboard"; id: string; label: string }
  | { kind: "data"; id: string; label: string; tableId: string }
  | {
      kind: "form";
      id: string;
      label: string;
      formId: string;
      tableId: string;
    };

export const DASHBOARD_PAGE_ID = "dashboard";
export const dataPageId = (tableId: string): string => `data:${tableId}`;
export const formPageId = (formId: string): string => `form:${formId}`;

/**
 * Build the app nav. Always: a Dashboard page + one data page per
 * table; then a form page per authored form (whose table still exists,
 * guaranteed by {@link reconcileAppConfig}). The result is fully derived
 * so an empty config still yields a usable app.
 */
export function derivePages(doc: BaseDocument, app: BaseAppConfig): AppPage[] {
  const pages: AppPage[] = [
    {
      kind: "dashboard",
      id: DASHBOARD_PAGE_ID,
      label: app.dashboard.title?.trim() || "Dashboard",
    },
  ];
  for (const t of doc.tables) {
    pages.push({
      kind: "data",
      id: dataPageId(t.id),
      label: t.name,
      tableId: t.id,
    });
  }
  for (const f of app.forms) {
    pages.push({
      kind: "form",
      id: formPageId(f.id),
      label: f.name.trim() || "Untitled form",
      formId: f.id,
      tableId: f.tableId,
    });
  }
  return pages;
}

/**
 * Propagate a field rename into the app config so a form's chosen field
 * subset and a widget's group/value references survive a rename instead
 * of being silently dropped by {@link reconcileAppConfig}. Only forms /
 * widgets whose table resolves to `tableId` are touched. Returns the
 * same reference when nothing changed so callers can skip a write.
 */
export function renameFieldInAppConfig(
  app: BaseAppConfig,
  doc: BaseDocument,
  tableId: string,
  oldName: string,
  newName: string,
): BaseAppConfig {
  if (oldName === newName) return app;
  let dirty = false;
  const targets = (ref: string): boolean =>
    resolveTableId(doc, ref) === tableId;

  const forms = app.forms.map((f) => {
    if (!targets(f.tableId) || !f.fieldNames.includes(oldName)) return f;
    dirty = true;
    return {
      ...f,
      fieldNames: f.fieldNames.map((n) => (n === oldName ? newName : n)),
    };
  });

  const widgets = app.dashboard.widgets.map((w) => {
    if (!targets(w.tableId)) return w;
    const nextGroup = w.groupByField === oldName ? newName : w.groupByField;
    const nextValue = w.valueField === oldName ? newName : w.valueField;
    if (nextGroup === w.groupByField && nextValue === w.valueField) return w;
    dirty = true;
    return { ...w, groupByField: nextGroup, valueField: nextValue };
  });

  if (!dirty) return app;
  return {
    ...app,
    forms,
    dashboard: { ...app.dashboard, widgets },
  };
}

/** A new form targeting `tableId` (shows every fillable field by default). */
export function createForm(table: BaseTable, name?: string): BaseAppForm {
  return {
    id: makeAppId(),
    name: name?.trim() || `${table.name} form`,
    tableId: table.id,
    fieldNames: [],
  };
}

/** A new dashboard widget of `kind` over `tableId`, with sane defaults. */
export function createWidget(
  kind: BaseAppWidgetKind,
  table: BaseTable,
): BaseAppWidget {
  const widget: BaseAppWidget = { id: makeAppId(), kind, tableId: table.id };
  if (kind === "group" || kind === "chart") {
    const firstGroupable = table.fields.find(
      (f) =>
        f.type === "select" ||
        f.type === "checkbox" ||
        f.type === "text" ||
        f.type === "user",
    );
    widget.groupByField = firstGroupable?.name;
  }
  if (kind === "rollup" || kind === "chart") {
    widget.aggregation = kind === "rollup" ? "SUM" : "COUNT";
    const firstNumber = table.fields.find(
      (f) =>
        f.type === "number" ||
        f.type === "currency" ||
        f.type === "percent" ||
        f.type === "rating",
    );
    widget.valueField = firstNumber?.name;
  }
  return widget;
}
