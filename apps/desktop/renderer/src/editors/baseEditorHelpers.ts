/**
 * Pure parsers + computed-field helpers for `BaseEditor`'s artifact body.
 *
 * Extracted out of `BaseEditor.tsx` so the component file's exports
 * are all components — required for React Fast Refresh to preserve
 * editor state across HMR edits. Types are imported from
 * `./baseEditorTypes` (a dedicated type-only module), so there is no
 * runtime cycle with the component file: both this helpers module
 * and the component module independently consume types from the
 * third file, breaking the would-be A↔B dependency edge.
 *
 * Phase 17 PR 4 additions:
 *   - record IDs (`ensureRecordIds`) so `linked_record` fields can
 *     point at a stable identifier rather than a brittle row index
 *   - `aggregateValues` for rollup fields
 *   - `lookupValues` for lookup fields
 *   - `computeAutoNumber` for the auto_number field type
 *   - `RESERVED_FIELD_NAMES` / `isReservedFieldName` guard against
 *     user-named fields colliding with `BaseRecord` reserved keys
 *     (currently just `id`; see `addField` / `removeField` /
 *     `AddFieldDialog.submit` in `BaseEditor.tsx`)
 */
import type {
  BaseContent,
  BaseField,
  BaseRecord,
  RollupAggregation,
} from "./baseEditorTypes";

/**
 * Names the user must not assign to a field. `id` is the stable
 * per-record identifier produced by `makeRecordId()` and consumed by
 * linked_record / rollup / lookup; shadowing or deleting it would
 * orphan every cross-record reference on the next save/reload.
 *
 * Kept here (next to `makeRecordId`) so the invariant lives in the
 * same module as the function that mints the identifier.
 */
export const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set(["id"]);

export function isReservedFieldName(name: string): boolean {
  return RESERVED_FIELD_NAMES.has(name.trim());
}

/**
 * Produce a short opaque record id. Uses crypto.getRandomValues when
 * available, with a Math.random fallback for environments without it
 * (the fallback is good enough for an editor that's only ever local).
 */
export function makeRecordId(): string {
  const bytes = new Uint8Array(8);
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.getRandomValues === "function"
  ) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Mutate-free pass that guarantees every record carries a stable `id`.
 * Records that already have an id keep theirs (round-trip safety);
 * legacy records loaded from artifacts that pre-date PR 4 are
 * assigned one on first parse so linked_record can reference them.
 *
 * Defensive: hand-edited JSON can carry `[null, 42, "oops"]`-style
 * arrays even after `parseBaseContent` has coerced the *outer* value
 * to an array. We drop any element that isn't a plain object — a
 * primitive or null has no fields to preserve and would crash the
 * spread on the next line — and re-key every survivor so callers can
 * treat the return value as `BaseRecord[]` without further checks.
 */
export function ensureRecordIds(records: unknown[]): BaseRecord[] {
  let changed = false;
  const out: BaseRecord[] = [];
  for (const r of records) {
    if (typeof r !== "object" || r === null || Array.isArray(r)) {
      // Drop primitives, null, and arrays — none can be turned into a
      // valid record without inventing field values out of thin air.
      changed = true;
      continue;
    }
    const rec = r as BaseRecord;
    if (typeof rec.id === "string" && rec.id) {
      out.push(rec);
      continue;
    }
    changed = true;
    out.push({ ...rec, id: makeRecordId() });
  }
  // Preserve referential identity when the input was already
  // well-formed — keeps `useState` initializers stable across HMR.
  return changed ? out : (records as BaseRecord[]);
}

/**
 * Sanitize a single field config loaded from JSON. The `AddFieldDialog`
 * validates user-typed numbers up front, but hand-edited or migrated
 * artifacts can carry out-of-range / wrong-typed values that would
 * otherwise crash a render (e.g. `Number.toFixed(-1)` throws a
 * `RangeError`). This pass normalizes every numeric config to a safe
 * representable value so downstream cell renderers can trust the
 * inputs they receive.
 *
 * Exported so unit tests can pin the contract independently of the
 * parser entry point.
 */
export function sanitizeBaseField(field: BaseField): BaseField {
  let out: BaseField | null = null;
  // percentPrecision: ECMAScript spec accepts only 0..100 for
  // `Number.prototype.toFixed` and we round to integer; in practice
  // anything past 20 fractional digits is meaningless for a percent
  // value, so we cap at 20 to keep the input field's `step` attribute
  // a representable float.
  if (field.percentPrecision !== undefined) {
    const raw = Number(field.percentPrecision);
    if (!Number.isFinite(raw)) {
      out = out ?? { ...field };
      delete out.percentPrecision;
    } else {
      const clamped = Math.max(0, Math.min(20, Math.floor(raw)));
      if (clamped !== field.percentPrecision) {
        out = out ?? { ...field };
        out.percentPrecision = clamped;
      }
    }
  }
  return out ?? field;
}

/**
 * Decode the artifact's serialized JSON body into the in-memory
 * BaseContent shape the editor mounts. Falls back to a
 * two-field (Name + Status) default when the body is empty or
 * not valid JSON. Every field is run through `sanitizeBaseField`
 * and a non-array `records` is coerced to `[]`, so callers can
 * treat the return value as fully normalized.
 *
 * Exported so unit tests can pin this independently of the
 * BaseEditor's full render pipeline.
 */
export function parseBaseContent(content: string): BaseContent {
  if (!content) {
    return {
      fields: [
        { name: "Name", type: "text" },
        { name: "Status", type: "text" },
      ],
      records: ensureRecordIds([{ id: "", Name: "", Status: "" }]),
    };
  }
  try {
    const parsed = JSON.parse(content) as BaseContent;
    if (parsed.fields && Array.isArray(parsed.fields)) {
      // Hand-edited / migrated JSON can carry `records: null`,
      // `records: {}`, or even `records: "oops"` — coerce to `[]`
      // so `ensureRecordIds` (which calls `.map`) doesn't blow up
      // on the next call.
      const rawRecords = Array.isArray(parsed.records) ? parsed.records : [];
      return {
        fields: parsed.fields.map(sanitizeBaseField),
        records: ensureRecordIds(rawRecords),
      };
    }
  } catch {
    // Not JSON
  }
  return {
    fields: [{ name: "Name", type: "text" }],
    records: ensureRecordIds([{ id: "", Name: content }]),
  };
}

/**
 * Resolve a set of record IDs (the value stored in a `linked_record`
 * cell) back to the corresponding `BaseRecord` objects, in the same
 * order the IDs were given. Unknown IDs are skipped silently — the
 * UI shows a "?" chip for them so the user can clean up dangling
 * references on their next edit.
 */
export function resolveLinkedRecords(
  ids: unknown,
  allRecords: BaseRecord[],
): BaseRecord[] {
  if (!Array.isArray(ids)) return [];
  const byId = new Map(allRecords.map((r) => [r.id, r]));
  const out: BaseRecord[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const rec = byId.get(id);
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * Coerce arbitrary cell content to a finite number, or `null` if the
 * value can't be parsed. Used by SUM/AVG/MIN/MAX/COUNT — values that
 * fail coercion are skipped, matching Excel's behaviour.
 */
function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Aggregate `values` (the raw field values from the linked records)
 * down to a single string the rollup cell will display. Numeric
 * aggregations (SUM/AVG/MIN/MAX) coerce inputs to numbers and
 * skip non-numeric. COUNT counts non-blank values. CONCAT joins as
 * `value1, value2, …` with no coercion.
 */
export function aggregateValues(
  values: unknown[],
  aggregation: RollupAggregation,
): string {
  switch (aggregation) {
    case "COUNT":
      return String(values.filter((v) => v != null && v !== "").length);
    case "CONCAT":
      return values
        .filter((v) => v != null && v !== "")
        .map((v) => (Array.isArray(v) ? v.join(", ") : String(v)))
        .join(", ");
    case "SUM": {
      const nums = values
        .map(asNumber)
        .filter((n): n is number => n !== null);
      return String(nums.reduce((a, b) => a + b, 0));
    }
    case "AVG": {
      const nums = values
        .map(asNumber)
        .filter((n): n is number => n !== null);
      if (nums.length === 0) return "0";
      return String(nums.reduce((a, b) => a + b, 0) / nums.length);
    }
    case "MIN": {
      const nums = values
        .map(asNumber)
        .filter((n): n is number => n !== null);
      if (nums.length === 0) return "";
      return String(Math.min(...nums));
    }
    case "MAX": {
      const nums = values
        .map(asNumber)
        .filter((n): n is number => n !== null);
      if (nums.length === 0) return "";
      return String(Math.max(...nums));
    }
    default:
      return "";
  }
}

/**
 * Pull `targetField` off each linked record and produce the
 * comma-separated string a lookup cell renders. Blanks are dropped
 * so a half-filled link list doesn't render trailing commas.
 */
export function lookupValues(
  linkedRecords: BaseRecord[],
  targetField: string,
): string {
  return linkedRecords
    .map((r) => r[targetField])
    .filter((v) => v != null && v !== "")
    .map((v) => (Array.isArray(v) ? v.join(", ") : String(v)))
    .join(", ");
}

/**
 * Compute the integer auto-number for a record at `recordIndex`
 * given the current record list. Auto-number is 1-based and equals
 * the position of the record in the list — so it stays stable as
 * long as records aren't deleted/reordered. (We don't try to be
 * cleverer than Airtable here; the user can sort by this field to
 * preserve insertion order even after a re-arrange.)
 */
export function computeAutoNumber(
  recordIndex: number,
): number {
  return recordIndex + 1;
}

/**
 * Pull every record whose `linkedFieldName` cell contains
 * `currentRecordId` — i.e. the inverse of a `linked_record` field.
 * Used by rollup/lookup to discover which records to aggregate.
 *
 * Most callers actually iterate the *forward* direction (record A's
 * linked_record field stores B's id, A's rollup field aggregates B
 * via that link). This helper exists for the reverse-lookup
 * direction once we add bidirectional links in a future PR.
 */
export function findRecordsLinkingTo(
  records: BaseRecord[],
  linkedFieldName: string,
  currentRecordId: string,
): BaseRecord[] {
  const out: BaseRecord[] = [];
  for (const r of records) {
    const cell = r[linkedFieldName];
    if (Array.isArray(cell) && cell.includes(currentRecordId)) {
      out.push(r);
    }
  }
  return out;
}
