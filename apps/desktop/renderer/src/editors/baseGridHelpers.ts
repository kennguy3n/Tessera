/**
 * Pure helpers for the Base grid's Airtable-style enhancements:
 * grouping, row coloring, frozen-column geometry, multi-column sort and
 * the column-summary footer. Kept React-free and side-effect-free so
 * the partitioning / color / offset / sort / summary logic can be
 * unit-tested in isolation, mirroring the
 * `baseEditorHelpers` / `baseFormulaEngine` split. `BaseEditor.tsx`
 * stays a thin shell that calls these.
 */
import type {
  BaseField,
  BaseRecord,
  FieldType,
  RollupAggregation,
} from "./baseEditorTypes";

// ──────────────────────────────────────────────────────────────────────
// Grouping
// ──────────────────────────────────────────────────────────────────────

export interface GridGroup {
  /** Stable key for React + collapse-state tracking. */
  key: string;
  /** Human-readable group heading. */
  label: string;
  /** Records in this group, in their incoming (filtered+sorted) order. */
  records: BaseRecord[];
}

/** Sentinel label/key for records whose group value is empty. */
export const EMPTY_GROUP_KEY = "__empty__";
export const EMPTY_GROUP_LABEL = "Empty";

/**
 * Whether a raw cell value should fall into the trailing "Empty"
 * group: `null` / `undefined`, the empty/whitespace string, or an
 * array with no non-empty entries. This is the AUTHORITATIVE emptiness
 * test — grouping keys off the raw value here, never off the rendered
 * label, so a record whose value is literally the string `"Empty"`
 * (e.g. a select option named "Empty") is NOT conflated with genuine
 * blanks.
 */
export function isEmptyGroupValue(value: unknown): boolean {
  if (value == null) return true;
  if (Array.isArray(value)) {
    return value.every((v) => v == null || String(v) === "");
  }
  return String(value).trim() === "";
}

/**
 * Render a single cell value as a group label. Arrays
 * (multi_select / linked_record) join with ", "; null / undefined /
 * "" collapse to the empty sentinel. Numbers and booleans stringify.
 */
export function groupValueLabel(value: unknown): string {
  if (isEmptyGroupValue(value)) return EMPTY_GROUP_LABEL;
  if (Array.isArray(value)) {
    const parts = value
      .map((v) => (v == null ? "" : String(v)))
      .filter((s) => s !== "");
    return parts.join(", ");
  }
  return String(value);
}

/**
 * Partition records by the given field, preserving first-appearance
 * order of both groups and the records within each group. Records
 * with an empty value land in a single trailing "Empty" group (matching
 * Airtable, which sinks blanks to the bottom). When `fieldName` is null
 * or absent, returns a single anonymous group containing every record.
 */
export function buildGroups(
  records: BaseRecord[],
  fieldName: string | null,
): GridGroup[] {
  if (!fieldName) {
    return [{ key: "__all__", label: "", records }];
  }
  const order: string[] = [];
  const byKey = new Map<string, GridGroup>();
  for (const record of records) {
    const raw = record[fieldName];
    const label = groupValueLabel(raw);
    // Derive the bucket key from the RAW value's emptiness, never from
    // the label string — otherwise a real value of "Empty" (matching
    // EMPTY_GROUP_LABEL) would be sunk into the blank catch-all group.
    const key = isEmptyGroupValue(raw) ? EMPTY_GROUP_KEY : label;
    let group = byKey.get(key);
    if (!group) {
      group = { key, label, records: [] };
      byKey.set(key, group);
      order.push(key);
    }
    group.records.push(record);
  }
  // Sink the empty group to the end if present.
  const keys = order.filter((k) => k !== EMPTY_GROUP_KEY);
  if (byKey.has(EMPTY_GROUP_KEY)) keys.push(EMPTY_GROUP_KEY);
  return keys.map((k) => byKey.get(k)!);
}

// ──────────────────────────────────────────────────────────────────────
// Row coloring
// ──────────────────────────────────────────────────────────────────────

/**
 * Curated, accessible palette used to color rows / option chips by a
 * select value. Chosen for adequate contrast against both the light
 * and dark grid backgrounds when used as a thin left strip / soft
 * background tint. HSL so callers can derive a softer background via
 * the same hue.
 */
const GRID_COLOR_PALETTE: ReadonlyArray<string> = [
  "#2563eb", // blue
  "#16a34a", // green
  "#d97706", // amber
  "#dc2626", // red
  "#7c3aed", // violet
  "#0891b2", // cyan
  "#db2777", // pink
  "#65a30d", // lime
  "#ea580c", // orange
  "#0d9488", // teal
];

/**
 * Deterministically map a label to a palette color. The same label
 * always yields the same color across renders and sessions (pure hash
 * → palette index), so a given select option keeps a stable color
 * without us having to persist a color per option.
 *
 * This maps off the label STRING alone, so it deliberately does NOT
 * special-case `EMPTY_GROUP_LABEL` ("Empty") — a record whose value is
 * literally "Empty" is a real option and gets a stable color like any
 * other. Emptiness gating lives upstream in `rowColor`, which checks the
 * RAW value via `isEmptyGroupValue` (matching `buildGroups`) so genuine
 * blanks get no color. The `null` / `""` guard here is purely defensive.
 */
export function colorForLabel(label: string): string | null {
  if (label == null || label === "") {
    return null;
  }
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % GRID_COLOR_PALETTE.length;
  return GRID_COLOR_PALETTE[idx];
}

/** Color for a record's value in the color-by field, or null. */
export function rowColor(
  record: BaseRecord,
  fieldName: string | null,
): string | null {
  if (!fieldName) return null;
  const raw = record[fieldName];
  // Gate emptiness on the RAW value (same predicate as `buildGroups`),
  // never on the rendered label — otherwise a real value of "Empty"
  // would be treated as blank and lose its color strip.
  if (isEmptyGroupValue(raw)) return null;
  return colorForLabel(groupValueLabel(raw));
}

// ──────────────────────────────────────────────────────────────────────
// Frozen columns
// ──────────────────────────────────────────────────────────────────────

/** Fixed width (px) assigned to a frozen data column so sticky `left`
 *  offsets are deterministic regardless of content. */
export const FROZEN_COL_WIDTH = 180;
/** Width of the leading select-checkbox utility column. */
export const SELECT_COL_WIDTH = 36;
/** Width of the leading row-number utility column. */
export const ROWNUM_COL_WIDTH = 44;

/**
 * Clamp a requested frozen-field count to what the schema can support
 * (never freeze every column — at least one must scroll, and never
 * negative).
 */
export function clampFrozenCount(
  requested: number,
  fieldCount: number,
): number {
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  const max = Math.max(0, fieldCount - 1);
  return Math.min(Math.floor(requested), max);
}

/**
 * Compute the cumulative `left` offset (px) for each sticky column
 * when `frozenCount` leading data columns are frozen. Index 0 = select
 * column, 1 = row-number column, 2..(frozenCount+1) = frozen data
 * columns. Returns one offset per sticky column.
 */
export function frozenLeftOffsets(frozenCount: number): number[] {
  const offsets: number[] = [];
  if (frozenCount <= 0) return offsets;
  let left = 0;
  offsets.push(left); // select
  left += SELECT_COL_WIDTH;
  offsets.push(left); // row number
  left += ROWNUM_COL_WIDTH;
  for (let i = 0; i < frozenCount; i++) {
    offsets.push(left);
    left += FROZEN_COL_WIDTH;
  }
  return offsets;
}

// ──────────────────────────────────────────────────────────────────────
// Multi-column sort
// ──────────────────────────────────────────────────────────────────────

export type SortDir = "asc" | "desc";

/** One level of an ordered, multi-column sort (Airtable's "Sort by … then by …"). */
export interface SortRule {
  field: string;
  dir: SortDir;
}

/**
 * Apply a header click to the current sort stack and return the next one.
 *
 * Two interaction modes, matching Airtable:
 *   - `additive` (shift / cmd-click): build a multi-level sort. If the
 *     field is already a level, toggle just that level's direction in
 *     place (preserving its priority); otherwise append it as the
 *     lowest-priority level, ascending.
 *   - plain click: the field becomes the sole sort. Clicking the field
 *     that is *already* the sole sort toggles its direction; clicking a
 *     different field (or when a multi-level sort is active) resets to a
 *     single ascending sort on that field.
 *
 * Always returns a new array (callers replace state wholesale).
 */
export function cycleSort(
  sorts: readonly SortRule[],
  field: string,
  additive: boolean,
): SortRule[] {
  const existing = sorts.find((s) => s.field === field);
  if (additive) {
    if (existing) {
      return sorts.map((s) =>
        s.field === field
          ? { field, dir: s.dir === "asc" ? "desc" : "asc" }
          : s,
      );
    }
    return [...sorts, { field, dir: "asc" }];
  }
  // Plain click: collapse to a single sort on `field`.
  if (sorts.length === 1 && sorts[0].field === field) {
    return [{ field, dir: sorts[0].dir === "asc" ? "desc" : "asc" }];
  }
  return [{ field, dir: "asc" }];
}

/**
 * Stable, multi-level sort. `getKey(record, field)` resolves the
 * comparison string for a field (the caller supplies the same
 * display-vs-raw resolution the cells use, so computed/timestamp
 * columns sort correctly). Keys are compared with a numeric-aware
 * locale compare so "2" precedes "10". Levels are applied in order;
 * the first non-equal level decides. Returns a new array; the input is
 * not mutated. `[].sort` is a stable sort in modern engines, so records
 * equal on every level keep their incoming order.
 */
export function sortRecordsByRules<T>(
  records: readonly T[],
  sorts: readonly SortRule[],
  getKey: (record: T, field: string) => string,
): T[] {
  if (sorts.length === 0) return [...records];
  const out = [...records];
  out.sort((a, b) => {
    for (const { field, dir } of sorts) {
      const cmp = getKey(a, field).localeCompare(getKey(b, field), undefined, {
        numeric: true,
      });
      if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
    }
    return 0;
  });
  return out;
}

/** Drop sort levels whose field no longer exists. Returns the same
 *  reference when nothing changed so React can skip re-rendering. */
export function pruneSorts(
  sorts: readonly SortRule[],
  validFieldNames: ReadonlySet<string>,
): SortRule[] {
  const kept = sorts.filter((s) => validFieldNames.has(s.field));
  return kept.length === sorts.length ? (sorts as SortRule[]) : kept;
}

/** Rewrite a renamed field across every sort level. Returns the same
 *  reference when the field wasn't used as a sort key. */
export function renameSortField(
  sorts: readonly SortRule[],
  oldName: string,
  newName: string,
): SortRule[] {
  if (!sorts.some((s) => s.field === oldName)) return sorts as SortRule[];
  return sorts.map((s) => (s.field === oldName ? { ...s, field: newName } : s));
}

// ──────────────────────────────────────────────────────────────────────
// Column summary footer
// ──────────────────────────────────────────────────────────────────────

/** Field types whose stored / displayed value is meaningfully numeric,
 *  so SUM / AVG / MIN / MAX make sense in the summary footer. Every
 *  other type only offers a non-empty count. `auto_number` is computed
 *  (its sequence value resolves via the display path) but is still a
 *  number, so it belongs here. */
const NUMERIC_SUMMARY_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  "number",
  "currency",
  "percent",
  "rating",
  "duration",
  "auto_number",
]);

/**
 * Which summary aggregations a column of the given type offers. COUNT
 * (rendered as "Filled" — the number of non-empty cells) applies to
 * every type; numeric types additionally offer SUM/AVG/MIN/MAX. CONCAT
 * is intentionally excluded — it belongs to rollups, not a footer.
 */
export function summaryKindsForFieldType(type: FieldType): RollupAggregation[] {
  return NUMERIC_SUMMARY_TYPES.has(type)
    ? ["SUM", "AVG", "MIN", "MAX", "COUNT"]
    : ["COUNT"];
}

/** Short footer labels for each aggregation. COUNT is "Filled" because
 *  `aggregateValues("COUNT")` counts non-empty cells, matching
 *  Airtable's "Filled" summary rather than a raw row count. */
export const SUMMARY_LABELS: Record<RollupAggregation, string> = {
  SUM: "Sum",
  AVG: "Avg",
  MIN: "Min",
  MAX: "Max",
  COUNT: "Filled",
  CONCAT: "List",
};

/**
 * Footer label for a summary aggregation, specialised per field type. A
 * checkbox's COUNT counts only CHECKED cells (see {@link checkboxSummaryInput}),
 * so it reads "Checked" rather than the generic "Filled" — which would be
 * misleading since every checkbox row, checked or not, holds a value.
 */
export function summaryLabel(
  kind: RollupAggregation,
  type: FieldType,
): string {
  if (kind === "COUNT" && type === "checkbox") return "Checked";
  return SUMMARY_LABELS[kind];
}

/**
 * Map a raw checkbox cell to the value the summary footer feeds into
 * `aggregateValues`. A checkbox defaults to `false` — a non-empty value —
 * so a plain `COUNT` of non-empty cells would always equal the visible row
 * count rather than the number of *checked* rows. Collapsing unchecked
 * cells to `""` (empty) makes `COUNT` count only checked cells, matching
 * Airtable's checkbox summary. Only `true` counts; `false`, `undefined`,
 * and any legacy value are treated as unchecked.
 */
export function checkboxSummaryInput(value: unknown): true | "" {
  return value === true ? true : "";
}

/**
 * Format a non-negative integer count of minutes as `h:mm`. Mirrors the
 * `duration` cell renderer so the summary footer reads the same as the
 * column it sums. Clamps negatives to 0 (a JSON-loaded stray negative
 * would otherwise print `-2:-30`, since JS `%` keeps the dividend sign)
 * and floors fractional minutes (an AVG can land on `90.5`).
 */
export function formatDurationMinutes(value: unknown): string {
  if (value == null) return "";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "";
  const safe = Math.max(0, Math.floor(n));
  const hh = Math.floor(safe / 60);
  const mm = safe % 60;
  return `${hh}:${String(mm).padStart(2, "0")}`;
}

/**
 * Render a raw `aggregateValues` result for the footer. COUNT / CONCAT
 * pass through verbatim (an integer count of filled cells, a joined
 * list) regardless of field type — a "Filled: 6" must never be dressed
 * up as `$6` or `600%`. Numeric aggregations come back as a
 * full-precision `String(number)` (e.g. "0.30000000000000004"); these
 * are formatted to match how the column's *cells* display, so a SUM of
 * cells reading "50%" + "30%" shows "80%" rather than the raw "0.8":
 *   - `currency` → `${symbol}` + grouped, 2 fraction digits
 *   - `percent`  → value ×100, `percentPrecision` digits, `%` suffix
 *   - `duration` → minutes as `h:mm`
 *   - everything else → grouped, ≤2 fraction digits
 * An empty numeric result (MIN/MAX over a column with no numbers)
 * renders as an em dash.
 */
export function formatSummaryValue(
  kind: RollupAggregation,
  raw: string,
  field?: Pick<BaseField, "type" | "currencySymbol" | "percentPrecision">,
): string {
  if (kind === "COUNT" || kind === "CONCAT") return raw;
  if (raw === "") return "—";
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  switch (field?.type) {
    case "currency": {
      const symbol = field.currencySymbol ?? "$";
      return `${symbol}${n.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    }
    case "percent": {
      // Re-clamp to `toFixed`'s [0,100] domain (defence in depth — the
      // parser already clamps `percentPrecision` to [0,20]) so an
      // in-memory mutation can't throw a RangeError mid-render.
      const digits = Math.min(20, Math.max(0, Math.floor(field.percentPrecision ?? 0)));
      return `${(n * 100).toFixed(digits)}%`;
    }
    case "duration":
      return formatDurationMinutes(n);
    default:
      return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
}

/** Drop summaries for columns that no longer exist. Returns the same
 *  reference when nothing changed. */
export function pruneColumnSummaries(
  summaries: Readonly<Record<string, RollupAggregation>>,
  validFieldNames: ReadonlySet<string>,
): Record<string, RollupAggregation> {
  let dirty = false;
  const next: Record<string, RollupAggregation> = {};
  for (const [field, kind] of Object.entries(summaries)) {
    if (validFieldNames.has(field)) next[field] = kind;
    else dirty = true;
  }
  return dirty ? next : (summaries as Record<string, RollupAggregation>);
}

/** Rewrite a renamed field's summary key. Returns the same reference
 *  when the field had no summary. */
export function renameColumnSummaryKey(
  summaries: Readonly<Record<string, RollupAggregation>>,
  oldName: string,
  newName: string,
): Record<string, RollupAggregation> {
  if (!(oldName in summaries)) {
    return summaries as Record<string, RollupAggregation>;
  }
  const { [oldName]: carried, ...rest } = summaries;
  return { ...rest, [newName]: carried };
}
