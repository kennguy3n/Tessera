/**
 * User-authored sheet templates — pure data model, defensive
 * `localStorage` store, and a portable template-file format.
 *
 * The renderer-only, local-first analogue of `customSlideTemplates.ts`.
 * A built-in {@link SheetTemplate} is a stateless metadata starter; a
 * *user* template captures a saved sheet: `{ id, label, description?,
 * category?, content: SheetTemplateContent }`. The embedded `content`
 * reproduces the captured grid (headers, rows, formulas, formats,
 * charts, conditional rules, validations, freeze) when applied.
 *
 * It mirrors the slide module deliberately so the validation, capping,
 * defensive-parse, and version-guard behaviour stay consistent:
 *
 *   - Store envelope `{ version, templates }` keyed at
 *     {@link CUSTOM_SHEET_TEMPLATES_STORAGE_KEY}; parse NEVER throws and
 *     drops bad / duplicate / foreign-id entries, capped at
 *     {@link MAX_CUSTOM_SHEET_TEMPLATES}.
 *   - Portable envelope `{ format, version, template }` —
 *     {@link SHEET_TEMPLATE_FORMAT}/{@link SHEET_TEMPLATE_VERSION},
 *     DISTINCT from the store envelope and versioned independently.
 *     Import ALWAYS drops the id (a fresh one is minted on save) so an
 *     import is non-destructive and can never overwrite an existing
 *     template.
 *
 * Unlike slides (which delegate to `parseSlideContent`), the sheet model
 * has no single deep validator, so {@link normalizeSheetContent} below is
 * the defensive gate: it rebuilds a clean {@link SheetTemplateContent}
 * field-by-field with total guards, so a hand-edited or corrupt blob can
 * never reach the grid.
 */

import type {
  CellFormat,
  ChartSpec,
  ChartType,
  ConditionalFormatRule,
  ConditionalOperator,
  ConditionalRuleStyle,
  DataValidation,
  PivotAggregation,
  PivotSpec,
  SheetNamedRange,
  ValidationMap,
} from "./sheetEditorTypes";
import {
  SHEET_TEMPLATE_CATEGORIES,
  type SheetTemplateCategory,
  type SheetTemplateContent,
} from "./sheetTemplates";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/** `localStorage` key for the persisted user-template store. */
export const CUSTOM_SHEET_TEMPLATES_STORAGE_KEY =
  "tessera.sheettemplates.custom";

/**
 * Store schema version. Independent of {@link SHEET_TEMPLATE_VERSION}
 * (the portable-file version) — the on-disk store and the shareable file
 * evolve separately. Do NOT bump without a migration story.
 */
const SCHEMA_VERSION = 1;

/**
 * Id prefix marking a template as user-authored. Lets the store reject
 * foreign / tampered ids and keeps custom ids from ever colliding with a
 * built-in {@link SheetTemplate} id.
 */
export const CUSTOM_SHEET_TEMPLATE_ID_PREFIX = "stpl-";

/** Cap on stored user templates; the oldest is dropped on overflow. */
export const MAX_CUSTOM_SHEET_TEMPLATES = 50;

/** Length bound for a template label (collapsed + trimmed). */
export const MAX_TEMPLATE_LABEL = 80;

/** Length bound for a template description (collapsed + trimmed). */
export const MAX_TEMPLATE_DESCRIPTION = 240;

/** Portable-file envelope discriminator. */
export const SHEET_TEMPLATE_FORMAT = "tessera.sheettemplate";

/**
 * Portable-file schema version. Independent of the store
 * {@link SCHEMA_VERSION}. Bump only when the on-file envelope shape
 * changes; the import guard rejects files from a newer version.
 */
export const SHEET_TEMPLATE_VERSION = 1;

/** Hard cap on captured grid dimensions (defence against a runaway blob). */
const MAX_TEMPLATE_COLUMNS = 256;
const MAX_TEMPLATE_ROWS = 5000;

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

/**
 * A user-authored sheet template: a captured sheet plus the gallery
 * metadata used to find + preview it. `content` is a fully-validated
 * {@link SheetTemplateContent}. The shape is intentionally flat + JSON-
 * serialisable.
 */
export interface CustomSheetTemplate {
  /** Custom-namespaced id ({@link CUSTOM_SHEET_TEMPLATE_ID_PREFIX}). */
  id: string;
  /** Display name shown on the gallery card. Always non-empty. */
  label: string;
  /** Optional one-line description; omitted when blank. */
  description?: string;
  /** Optional gallery category; an unknown value degrades to "All". */
  category?: SheetTemplateCategory;
  /** The captured sheet, reproduced verbatim when the template applies. */
  content: SheetTemplateContent;
}

/**
 * Mutable form backing the save / edit / import modal. `category` is a
 * plain string ("" = uncategorised → shows under "All"). A present,
 * custom-namespaced `id` edits in place; its absence (or a foreign id)
 * mints a fresh id — which is what makes import non-destructive.
 */
export interface CustomSheetTemplateDraft {
  id?: string;
  label: string;
  description: string;
  category: string;
  content: SheetTemplateContent;
}

/** Result of building a template from a draft (validation gate). */
export type CustomSheetTemplateBuildResult =
  | { ok: true; template: CustomSheetTemplate }
  | { ok: false; errors: string[] };

/** Result of parsing a portable template file. */
export type SheetTemplateImportResult =
  | { ok: true; draft: CustomSheetTemplateDraft }
  | { ok: false; error: string };

// ─────────────────────────────────────────────────────────────────────
// Small total helpers (mirror customSlideTemplates)
// ─────────────────────────────────────────────────────────────────────

const CATEGORY_SET: ReadonlySet<string> = new Set<string>(
  SHEET_TEMPLATE_CATEGORIES,
);

/** Narrow an arbitrary value to a known {@link SheetTemplateCategory}. */
export function isSheetTemplateCategory(
  value: unknown,
): value is SheetTemplateCategory {
  return typeof value === "string" && CATEGORY_SET.has(value);
}

/** Whether `id` belongs to a user-authored sheet template. */
export function isCustomSheetTemplateId(
  id: string | undefined | null,
): boolean {
  return (
    typeof id === "string" && id.startsWith(CUSTOM_SHEET_TEMPLATE_ID_PREFIX)
  );
}

/**
 * Generate a locally-unique template id. Prefers `crypto.randomUUID`
 * (present in the Electron renderer + jsdom), falling back to a
 * time+random token so it never throws in an exotic host.
 */
export function newCustomSheetTemplateId(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    return `${CUSTOM_SHEET_TEMPLATE_ID_PREFIX}${c.randomUUID()}`;
  }
  return `${CUSTOM_SHEET_TEMPLATE_ID_PREFIX}${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/** Collapse internal whitespace + trim, then length-bound. */
function collapse(raw: string, max: number): string {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max).trimEnd() : s;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

// ─────────────────────────────────────────────────────────────────────
// Content normalisation (single source of validation, reused on every path)
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_COLUMNS: readonly string[] = ["A", "B", "C"];

const CHART_TYPES: ReadonlySet<string> = new Set<ChartType>([
  "bar",
  "line",
  "area",
  "scatter",
  "combo",
  "pie",
  "donut",
]);

const PIVOT_AGGS: ReadonlySet<string> = new Set<PivotAggregation>([
  "sum",
  "count",
  "average",
  "min",
  "max",
]);

const CONDITIONAL_OPERATORS: ReadonlySet<string> = new Set<ConditionalOperator>(
  [
    "gt",
    "gte",
    "lt",
    "lte",
    "eq",
    "neq",
    "contains",
    "notContains",
    "isEmpty",
    "notEmpty",
  ],
);

/** Coerce a raw cell value to the model's canonical string form. */
function toCellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return "";
}

function normalizeColumns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return DEFAULT_COLUMNS.slice();
  }
  const cols = value
    .slice(0, MAX_TEMPLATE_COLUMNS)
    .map((c) => (typeof c === "string" ? c : toCellText(c)));
  return cols.length > 0 ? cols : DEFAULT_COLUMNS.slice();
}

function normalizeRows(value: unknown, columnCount: number): string[][] {
  if (!Array.isArray(value)) {
    return [Array.from({ length: columnCount }, () => "")];
  }
  return value
    .slice(0, MAX_TEMPLATE_ROWS)
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.slice(0, MAX_TEMPLATE_COLUMNS).map(toCellText));
}

const ALIGN_VALUES: ReadonlySet<string> = new Set(["left", "center", "right"]);

function normalizeCellFormat(value: unknown): CellFormat | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const fmt: CellFormat = {};
  if (typeof rec.numberFormat === "string") fmt.numberFormat = rec.numberFormat;
  if (typeof rec.align === "string" && ALIGN_VALUES.has(rec.align)) {
    fmt.align = rec.align as CellFormat["align"];
  }
  if (rec.bold === true) fmt.bold = true;
  if (rec.italic === true) fmt.italic = true;
  if (rec.underline === true) fmt.underline = true;
  if (typeof rec.color === "string") fmt.color = rec.color;
  if (typeof rec.background === "string") fmt.background = rec.background;
  return Object.keys(fmt).length > 0 ? fmt : null;
}

const FORMAT_KEY_RE = /^\d+,\d+$/;

function normalizeFormats(
  value: unknown,
): Record<string, CellFormat> | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, CellFormat> = {};
  for (const [key, raw] of Object.entries(rec)) {
    if (!FORMAT_KEY_RE.test(key)) continue;
    const fmt = normalizeCellFormat(raw);
    if (fmt) out[key] = fmt;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeRuleStyle(value: unknown): ConditionalRuleStyle {
  const rec = asRecord(value);
  const style: ConditionalRuleStyle = {};
  if (!rec) return style;
  if (rec.bold === true) style.bold = true;
  if (rec.italic === true) style.italic = true;
  if (rec.underline === true) style.underline = true;
  if (typeof rec.color === "string") style.color = rec.color;
  if (typeof rec.background === "string") style.background = rec.background;
  return style;
}

function normalizeConditionalRules(
  value: unknown,
): ConditionalFormatRule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ConditionalFormatRule[] = [];
  for (const raw of value) {
    const rec = asRecord(raw);
    if (!rec) continue;
    if (typeof rec.id !== "string") continue;
    if (
      typeof rec.operator !== "string" ||
      !CONDITIONAL_OPERATORS.has(rec.operator)
    ) {
      continue;
    }
    const column =
      rec.column === null
        ? null
        : typeof rec.column === "number" && Number.isInteger(rec.column)
          ? rec.column
          : null;
    out.push({
      id: rec.id,
      column,
      operator: rec.operator as ConditionalOperator,
      value: typeof rec.value === "string" ? rec.value : "",
      style: normalizeRuleStyle(rec.style),
    });
  }
  return out.length > 0 ? out : undefined;
}

function normalizeValidation(value: unknown): DataValidation | null {
  const rec = asRecord(value);
  if (!rec) return null;
  if (rec.kind === "checkbox") return { kind: "checkbox" };
  if (rec.kind === "list" && Array.isArray(rec.values)) {
    const values = rec.values.filter((v): v is string => typeof v === "string");
    return { kind: "list", values };
  }
  return null;
}

function normalizeValidations(value: unknown): ValidationMap | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: ValidationMap = {};
  for (const [key, raw] of Object.entries(rec)) {
    if (!/^\d+$/.test(key)) continue;
    const validation = normalizeValidation(raw);
    if (validation) out[key] = validation;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeCharts(value: unknown): ChartSpec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ChartSpec[] = [];
  for (const raw of value) {
    const rec = asRecord(raw);
    if (!rec) continue;
    if (typeof rec.id !== "string") continue;
    if (typeof rec.type !== "string" || !CHART_TYPES.has(rec.type)) continue;
    if (typeof rec.range !== "string" || rec.range.length === 0) continue;
    const chart: ChartSpec = {
      id: rec.id,
      type: rec.type as ChartType,
      range: rec.range,
    };
    if (typeof rec.title === "string") chart.title = rec.title;
    if (typeof rec.labelRange === "string") chart.labelRange = rec.labelRange;
    if (rec.useFirstRowAsHeader === true) chart.useFirstRowAsHeader = true;
    out.push(chart);
  }
  return out.length > 0 ? out : undefined;
}

function normalizePivots(value: unknown): PivotSpec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PivotSpec[] = [];
  for (const raw of value) {
    const rec = asRecord(raw);
    if (!rec) continue;
    if (typeof rec.id !== "string") continue;
    if (typeof rec.range !== "string" || rec.range.length === 0) continue;
    if (typeof rec.rowField !== "number" || !Number.isInteger(rec.rowField)) {
      continue;
    }
    if (
      typeof rec.valueField !== "number" ||
      !Number.isInteger(rec.valueField)
    ) {
      continue;
    }
    if (typeof rec.agg !== "string" || !PIVOT_AGGS.has(rec.agg)) continue;
    const pivot: PivotSpec = {
      id: rec.id,
      range: rec.range,
      rowField: rec.rowField,
      valueField: rec.valueField,
      agg: rec.agg as PivotAggregation,
    };
    if (typeof rec.title === "string") pivot.title = rec.title;
    if (typeof rec.colField === "number" && Number.isInteger(rec.colField)) {
      pivot.colField = rec.colField;
    }
    out.push(pivot);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeNamedRanges(value: unknown): SheetNamedRange[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: SheetNamedRange[] = [];
  for (const raw of value) {
    const rec = asRecord(raw);
    if (!rec) continue;
    if (typeof rec.name !== "string" || rec.name.length === 0) continue;
    if (typeof rec.range !== "string" || rec.range.length === 0) continue;
    out.push({ name: rec.name, range: rec.range });
  }
  return out.length > 0 ? out : undefined;
}

function normalizeDimensions(
  value: unknown,
): (number | undefined)[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: (number | undefined)[] = value.map((v) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined,
  );
  return out.some((v) => v !== undefined) ? out : undefined;
}

function normalizeFreeze(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

/**
 * Rebuild an arbitrary value into a clean {@link SheetTemplateContent}.
 * The defensive gate for every path (capture, load, import): each field
 * is validated independently and an invalid one is dropped, so a corrupt
 * or hostile blob degrades to a clean grid rather than reaching the
 * renderer. Empty optional collections are omitted so two equal sheets
 * serialise identically.
 */
export function normalizeSheetContent(content: unknown): SheetTemplateContent {
  const rec = asRecord(content);
  const columns = normalizeColumns(rec?.columns);
  const out: SheetTemplateContent = {
    columns,
    rows: normalizeRows(rec?.rows, columns.length),
  };
  if (!rec) return out;

  const formats = normalizeFormats(rec.formats);
  if (formats) out.formats = formats;
  const conditionalRules = normalizeConditionalRules(rec.conditionalRules);
  if (conditionalRules) out.conditionalRules = conditionalRules;
  const validations = normalizeValidations(rec.validations);
  if (validations) out.validations = validations;
  const charts = normalizeCharts(rec.charts);
  if (charts) out.charts = charts;
  const pivots = normalizePivots(rec.pivots);
  if (pivots) out.pivots = pivots;
  const namedRanges = normalizeNamedRanges(rec.namedRanges);
  if (namedRanges) out.namedRanges = namedRanges;
  const columnWidths = normalizeDimensions(rec.columnWidths);
  if (columnWidths) out.columnWidths = columnWidths;
  const rowHeights = normalizeDimensions(rec.rowHeights);
  if (rowHeights) out.rowHeights = rowHeights;
  const frozenRows = normalizeFreeze(rec.frozenRows);
  if (frozenRows) out.frozenRows = frozenRows;
  const frozenCols = normalizeFreeze(rec.frozenCols);
  if (frozenCols) out.frozenCols = frozenCols;
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Build / draft helpers (single source of validation, reused on load)
// ─────────────────────────────────────────────────────────────────────

/** A fresh, empty draft seeded with the sheet being saved. */
export function emptySheetTemplateDraft(
  content: SheetTemplateContent,
): CustomSheetTemplateDraft {
  return { label: "", description: "", category: "", content };
}

/** Hydrate an editable draft from an existing template (edit in place). */
export function customSheetTemplateToDraft(
  template: CustomSheetTemplate,
): CustomSheetTemplateDraft {
  return {
    id: template.id,
    label: template.label,
    description: template.description ?? "",
    category: template.category ?? "",
    content: template.content,
  };
}

/**
 * Build a draft for duplicating a template: keep the content + metadata
 * but drop the id (so a fresh one is minted) and suffix the label with
 * " (copy)" so the duplicate is distinguishable in the gallery.
 */
export function duplicateSheetTemplateDraft(
  template: CustomSheetTemplate,
): CustomSheetTemplateDraft {
  return {
    label: collapse(`${template.label} (copy)`, MAX_TEMPLATE_LABEL),
    description: template.description ?? "",
    category: template.category ?? "",
    content: template.content,
  };
}

/**
 * Validate + normalise a draft into a {@link CustomSheetTemplate}, or
 * return the validation errors. The single gate every persisted /
 * imported template passes through. A draft carrying a custom-namespaced
 * id edits that template in place; otherwise `idGen` mints a new one.
 */
export function buildCustomSheetTemplate(
  draft: CustomSheetTemplateDraft,
  idGen: () => string = newCustomSheetTemplateId,
): CustomSheetTemplateBuildResult {
  const errors: string[] = [];

  const label = collapse(draft.label, MAX_TEMPLATE_LABEL);
  if (!label) errors.push("Give the template a name.");

  if (errors.length > 0) return { ok: false, errors };

  const template: CustomSheetTemplate = {
    id: isCustomSheetTemplateId(draft.id) ? (draft.id as string) : idGen(),
    label,
    content: normalizeSheetContent(draft.content),
  };

  const description = collapse(draft.description, MAX_TEMPLATE_DESCRIPTION);
  if (description) template.description = description;
  if (isSheetTemplateCategory(draft.category)) {
    template.category = draft.category;
  }

  return { ok: true, template };
}

// ─────────────────────────────────────────────────────────────────────
// List ops (insert/replace, remove, find) — mirror customSlideTemplates
// ─────────────────────────────────────────────────────────────────────

/**
 * Insert `template` or replace the existing one with the same id,
 * preserving order. Enforces {@link MAX_CUSTOM_SHEET_TEMPLATES} by
 * dropping the oldest when a *new* template would overflow — a
 * replacement never trips the cap.
 */
export function upsertCustomSheetTemplate(
  list: ReadonlyArray<CustomSheetTemplate>,
  template: CustomSheetTemplate,
): CustomSheetTemplate[] {
  const idx = list.findIndex((t) => t.id === template.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = template;
    return next;
  }
  const next = [...list, template];
  return next.length > MAX_CUSTOM_SHEET_TEMPLATES
    ? next.slice(next.length - MAX_CUSTOM_SHEET_TEMPLATES)
    : next;
}

/** Remove a template by id (no-op when absent). */
export function removeCustomSheetTemplate(
  list: ReadonlyArray<CustomSheetTemplate>,
  id: string,
): CustomSheetTemplate[] {
  return list.filter((t) => t.id !== id);
}

/** Find a template by id, or `null`. Total — safe with an absent id. */
export function findCustomSheetTemplate(
  list: ReadonlyArray<CustomSheetTemplate>,
  id: string | undefined | null,
): CustomSheetTemplate | null {
  if (id == null) return null;
  return list.find((t) => t.id === id) ?? null;
}

// ─────────────────────────────────────────────────────────────────────
// Defensive parse / serialize / load / save (mirrors customSlideTemplates)
// ─────────────────────────────────────────────────────────────────────

/**
 * Coerce one raw stored object into a valid {@link CustomSheetTemplate},
 * or `null` when unusable. Routes through {@link buildCustomSheetTemplate}
 * so a persisted template reuses the exact same normalisation as the save
 * UI. A stored id that is not custom-namespaced is rejected so a tampered
 * blob cannot shadow a built-in or a foreign entry.
 */
export function parseStoredSheetTemplate(
  value: unknown,
): CustomSheetTemplate | null {
  const rec = asRecord(value);
  if (!rec) return null;
  if (typeof rec.id !== "string" || !isCustomSheetTemplateId(rec.id)) {
    return null;
  }
  if (typeof rec.label !== "string") return null;

  const draft: CustomSheetTemplateDraft = {
    id: rec.id,
    label: rec.label,
    description: typeof rec.description === "string" ? rec.description : "",
    category: isSheetTemplateCategory(rec.category) ? rec.category : "",
    content: normalizeSheetContent(rec.content),
  };
  const result = buildCustomSheetTemplate(draft, () => rec.id as string);
  return result.ok ? result.template : null;
}

/**
 * Defensively parse a raw `localStorage` string into a validated list,
 * or `null` when absent/unusable. Never throws: bad JSON, a wrong schema
 * version, or a non-array `templates` all degrade to `null`;
 * individually-bad or duplicate-id templates are dropped, capped at
 * {@link MAX_CUSTOM_SHEET_TEMPLATES}.
 */
export function parseCustomSheetTemplateStore(
  raw: string | null,
): CustomSheetTemplate[] | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const rec = asRecord(parsed);
  if (!rec) return null;
  if (rec.version !== SCHEMA_VERSION) return null;
  if (!Array.isArray(rec.templates)) return null;

  const out: CustomSheetTemplate[] = [];
  const seen = new Set<string>();
  for (const item of rec.templates) {
    const template = parseStoredSheetTemplate(item);
    if (template && !seen.has(template.id)) {
      seen.add(template.id);
      out.push(template);
      if (out.length >= MAX_CUSTOM_SHEET_TEMPLATES) break;
    }
  }
  return out;
}

/** Serialize a template list to the persisted JSON string (with version). */
export function serializeCustomSheetTemplateStore(
  list: ReadonlyArray<CustomSheetTemplate>,
): string {
  return JSON.stringify({ version: SCHEMA_VERSION, templates: list });
}

/**
 * Load + validate the persisted templates. Returns `[]` (never null)
 * when there is nothing usable, so callers use the result directly.
 * Never throws.
 */
export function loadCustomSheetTemplates(): CustomSheetTemplate[] {
  try {
    return (
      parseCustomSheetTemplateStore(
        window.localStorage.getItem(CUSTOM_SHEET_TEMPLATES_STORAGE_KEY),
      ) ?? []
    );
  } catch {
    return [];
  }
}

/**
 * Persist `list`. Best-effort: silently no-ops if `localStorage` is
 * unavailable or the write is rejected (quota/locked).
 */
export function saveCustomSheetTemplates(
  list: ReadonlyArray<CustomSheetTemplate>,
): void {
  try {
    window.localStorage.setItem(
      CUSTOM_SHEET_TEMPLATES_STORAGE_KEY,
      serializeCustomSheetTemplateStore(list),
    );
  } catch {
    /* localStorage disabled / full — drop the write; UI is unaffected. */
  }
}

// ─────────────────────────────────────────────────────────────────────
// Portable template file (export / import) — mirrors customSlideTemplates
// ─────────────────────────────────────────────────────────────────────

/**
 * A URL/file-safe slug derived from a label, used to name the export
 * file. Non-alphanumerics collapse to single hyphens; the result is
 * length-bounded and never empty.
 */
function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "template";
}

/** Filename for an exported template: `tessera-sheet-template-<slug>.json`. */
export function sheetTemplateFilename(template: CustomSheetTemplate): string {
  return `tessera-sheet-template-${slugify(template.label)}.json`;
}

/**
 * Serialize a template to the portable JSON file body. Wraps it in the
 * `{ format, version, template }` envelope (DISTINCT from the store
 * envelope) and pretty-prints for a human-diffable file. Does NOT mutate
 * the source — `JSON.stringify` only reads.
 */
export function serializeSheetTemplate(template: CustomSheetTemplate): string {
  return JSON.stringify(
    {
      format: SHEET_TEMPLATE_FORMAT,
      version: SHEET_TEMPLATE_VERSION,
      template,
    },
    null,
    2,
  );
}

/**
 * Parse a portable template file into an import draft, or an error. The
 * version guard is hardened exactly like the skill / slide import ones:
 * reject a non-numeric / non-integer / `< 1` version FIRST (so `0`, `-1`,
 * `0.5`, `NaN`, `Infinity` all read as "not valid"), THEN reject a
 * version newer than this build understands.
 *
 * The id is ALWAYS dropped: the returned draft has no `id`, so saving it
 * mints a fresh custom id and an import can never overwrite an existing
 * template. The embedded sheet is validated through
 * {@link normalizeSheetContent} so a corrupt blob degrades safely.
 */
export function parseSheetTemplate(raw: string): SheetTemplateImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "This file isn’t valid JSON." };
  }

  const rec = asRecord(parsed);
  if (!rec || rec.format !== SHEET_TEMPLATE_FORMAT) {
    return { ok: false, error: "This isn’t a Tessera sheet template file." };
  }
  if (
    typeof rec.version !== "number" ||
    !Number.isInteger(rec.version) ||
    rec.version < 1
  ) {
    return {
      ok: false,
      error: "This isn’t a valid Tessera sheet template file.",
    };
  }
  if (rec.version > SHEET_TEMPLATE_VERSION) {
    return {
      ok: false,
      error: "This sheet template was exported by a newer version of Tessera.",
    };
  }

  const templateRec = asRecord(rec.template);
  if (!templateRec || typeof templateRec.label !== "string") {
    return { ok: false, error: "This file doesn’t contain a sheet template." };
  }

  const draft: CustomSheetTemplateDraft = {
    // No `id` — a fresh custom id is minted on save (non-destructive).
    label: templateRec.label,
    description:
      typeof templateRec.description === "string"
        ? templateRec.description
        : "",
    category: isSheetTemplateCategory(templateRec.category)
      ? templateRec.category
      : "",
    content: normalizeSheetContent(templateRec.content),
  };

  const built = buildCustomSheetTemplate(draft);
  if (!built.ok) {
    return {
      ok: false,
      error: built.errors[0] ?? "This sheet template couldn’t be imported.",
    };
  }
  return { ok: true, draft };
}
