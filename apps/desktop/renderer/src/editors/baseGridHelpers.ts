/**
 * Pure helpers for the Base grid's Airtable-style enhancements:
 * grouping, row coloring, and frozen-column geometry. Kept React-free
 * and side-effect-free so the partitioning / color / offset logic can
 * be unit-tested in isolation, mirroring the
 * `baseEditorHelpers` / `baseFormulaEngine` split. `BaseEditor.tsx`
 * stays a thin shell that calls these.
 */
import type { BaseRecord } from "./baseEditorTypes";

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
 * Render a single cell value as a group label. Arrays
 * (multi_select / linked_record) join with ", "; null / undefined /
 * "" collapse to the empty sentinel. Numbers and booleans stringify.
 */
export function groupValueLabel(value: unknown): string {
  if (value == null) return EMPTY_GROUP_LABEL;
  if (Array.isArray(value)) {
    const parts = value
      .map((v) => (v == null ? "" : String(v)))
      .filter((s) => s !== "");
    return parts.length === 0 ? EMPTY_GROUP_LABEL : parts.join(", ");
  }
  const s = String(value);
  return s.trim() === "" ? EMPTY_GROUP_LABEL : s;
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
    const label = groupValueLabel(record[fieldName]);
    const key = label === EMPTY_GROUP_LABEL ? EMPTY_GROUP_KEY : label;
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
 * without us having to persist a color per option. Empty values get no
 * color (returns null).
 */
export function colorForLabel(label: string): string | null {
  if (label == null || label === "" || label === EMPTY_GROUP_LABEL) {
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
  return colorForLabel(groupValueLabel(record[fieldName]));
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
