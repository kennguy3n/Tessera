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
  FieldType,
  RollupAggregation,
} from "./baseEditorTypes";
import type { BaseViewConfig } from "./baseviews/types";

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
 * Apply a `oldName` → `newName` rename across every field-name pointer
 * a single `BaseField` can hold: `linkedField`, `targetField`,
 * `linkedDisplayField`, plus the field's own `name`. The `formula`
 * source is left untouched here — callers should re-run
 * `renameFieldInFormula` separately because the formula scanner is
 * defined alongside the rest of the formula machinery and we do not
 * want a runtime dependency from this module into the formula engine.
 *
 * The pointer rewrite applies **to every field**, including the one
 * being renamed. A self-referential pointer is unusual but not
 * impossible (e.g., a hand-edited JSON payload, or a future refactor
 * where a rollup targets its own field), and the rename contract is
 * meant to be atomic — every `*FieldName` pointer that used to spell
 * `oldName` must read `newName` after this call, with no leftover
 * reference. Returns the same `field` reference (by identity) when
 * nothing changed, so React can skip re-renders downstream.
 *
 * Exported so unit tests can pin the cross-pointer contract without
 * standing up the full `BaseEditor` render pipeline (which the prior
 * integration-test attempt found brittle).
 */
export function applyFieldRename(
  field: BaseField,
  oldName: string,
  newName: string,
): BaseField {
  let out: BaseField | null = null;
  if (field.linkedField === oldName) {
    out = out ?? { ...field };
    out.linkedField = newName;
  }
  if (field.targetField === oldName) {
    out = out ?? { ...field };
    out.targetField = newName;
  }
  if (field.linkedDisplayField === oldName) {
    out = out ?? { ...field };
    out.linkedDisplayField = newName;
  }
  if (field.name === oldName) {
    out = out ?? { ...field };
    out.name = newName;
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
      // `parsed.fields` is array-checked but individual elements
      // are unvalidated user input. Hand-edited JSON like
      // `fields: [null, {…}]` or `fields: [42, "oops", {…}]`
      // would crash `sanitizeBaseField(null)` on its first
      // `field.percentPrecision` access. Drop primitives / null /
      // arrays at the per-element level — the survivors are real
      // objects so the type assertion is sound.
      const sanitizedFields: BaseField[] = [];
      for (const raw of parsed.fields as unknown[]) {
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          sanitizedFields.push(sanitizeBaseField(raw as BaseField));
        }
      }
      return {
        fields: sanitizedFields,
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

// ─────────────────────────────────────────────────────────────────────
// Per-field-type filter matcher
// ─────────────────────────────────────────────────────────────────────

/**
 * Field types whose **stored** value is either `null` or a raw
 * source string — the value the user sees comes from a render-time
 * computation against other fields / the record's position in the
 * grid.
 *
 *   - `formula` / `rollup` / `lookup` — derive from other fields.
 *   - `auto_number` — derives from the record's index in
 *     `data.records`; the stored value is always `null` (see
 *     `getDefaultValue` in `BaseEditor.tsx`).
 *
 * Filter + sort paths in the grid view must compute the display
 * string for these types before comparing — comparing the *stored*
 * value would hit `null` for every row on `auto_number`, and the
 * formula *source* (rather than its evaluated result) for the
 * other three.  Centralising the predicate here keeps the four
 * type names from drifting between callers (a Devin Review
 * finding on PR #79 caught the filter path having only three of
 * the four).
 */
export function isComputedFieldType(type: FieldType): boolean {
  return (
    type === "formula" ||
    type === "rollup" ||
    type === "lookup" ||
    type === "auto_number"
  );
}

/**
 * The user-facing filter for the grid is a single text input per
 * column. We want that input to feel right for the underlying field
 * type without forcing the user to learn a query DSL:
 *
 *   - **Numeric** types (`number`, `currency`, `rating`, `duration`):
 *     support comparison operators `>`, `>=`, `<`, `<=`, `=`
 *     (e.g. `>10`, `<=5`). A bare numeric input is treated as
 *     `equals`. A non-numeric input falls back to substring on the
 *     rendered string so the column doesn't become un-filterable.
 *     **Null / undefined stored values never match a numeric filter**
 *     (so "0" or ">=0" on an empty cell hides the row rather than
 *     reporting a false positive — `Number(null) === 0` would
 *     otherwise lie).
 *   - **Duration**: stored as integer minutes (`65` = 1h05m) but
 *     displayed and edited as `h:mm` (`1:05`). The filter accepts
 *     **both** formats so the user can type either what they see in
 *     the cell (`>1:30`) or raw minutes (`>90`). An operand
 *     containing `:` is parsed as `h:mm` (so `>1:30` becomes ">90
 *     minutes"); a bare integer is treated as minutes. Mixed-format
 *     comparisons therefore agree — `>1:30` and `>90` filter the
 *     same rows. Devin Review PR #79 round 12 (ANALYSIS_…_0003)
 *     flagged the UX mismatch: previously typing `>1` against a cell
 *     showing `1:05` meant ">1 minute" instead of the expected
 *     ">1 hour", silently matching every non-empty row.
 *   - **Percent**: stored as a fraction (`0.5` = 50%) but the user
 *     thinks in display percentages. The filter operand is rescaled
 *     so `>10` means ">10%", matching what the placeholder hints at.
 *   - **Checkbox**: matches `true` / `false` (case-insensitive), or
 *     `1` / `0`.
 *   - **Multi-valued** types (`multi_select`, `attachment`,
 *     `linked_record`): the filter matches if ANY element of the
 *     stored array contains the search term (case-insensitive).
 *   - **Date**: substring on the ISO string the cell stores.
 *   - **Text-like**, **select**: case-insensitive substring on the
 *     stored string.
 *   - **Computed** types (`formula`, `rollup`, `lookup`,
 *     `auto_number`): callers compute the **display string** for
 *     the record (typically via `formatValueForCsv`) and pass it as
 *     `displayValue`. Numeric comparison operators (`>`, `<=`,
 *     etc.) then parse that display string as a number; everything
 *     else falls back to case-insensitive substring on the same
 *     string.  This makes `auto_number > 5` behave the way the
 *     placeholder text (`e.g. >10`) promises, because the matcher
 *     no longer sees `null` / `0` for every row. **Empty display
 *     strings never match a numeric filter** — same `Number("")===0`
 *     guard as the stored-value branch.
 *
 * Empty filter strings always match, so a half-typed filter on one
 * column doesn't accidentally hide every row.
 */
/**
 * Float-safe equality for filter `=` comparisons.
 *
 * Strict `===` is the fast path everywhere else in the codebase, but
 * the percent filter has a unique footgun: the stored value is a
 * fraction (`0.333`) and the user types a display percentage (`33.3`),
 * which we rescale via `n / 100`. `33.3 / 100` evaluates to
 * `0.33300000000000002` in IEEE-754, so `0.333 === 33.3 / 100` is
 * `false` and the user's `=33.3` filter would silently match zero rows
 * — confusing because the value clearly *is* 33.3% in the grid.
 *
 * We use a relative epsilon of `1e-9 * max(|a|, |b|, 1)`. The `1`
 * floor in the `max(…)` means the *minimum* tolerance is `1e-9` (never
 * narrower), so two values that differ by less than ~1 ppb still
 * compare equal even when both are near zero. Above magnitude 1 the
 * tolerance scales with the operands so a single multiply / divide's
 * rounding error never makes equality lie at any magnitude.
 *
 * `1e-9` is small enough that any two values the user would consider
 * visually distinct still compare unequal (the percent filter renders
 * at most ~6 digits of precision; rating / duration / currency at most
 * 2), while large enough to collapse a single multiply/divide's
 * rounding error. Percent / number / currency / rating / duration all
 * share this comparator so behaviour is consistent across types.
 *
 * Devin Review on PR #79 round 8 (ANALYSIS_…_0001) flagged the strict
 * equality as a likely user-visible bug on common percentages like
 * 33.3% / 16.7% / 12.5% (the last is exact but the first two are not).
 * Round 9 (ANALYSIS_…_0003) flagged the docstring saying "1e-12
 * absolute floor near zero" while the code actually used a 1e-9 floor
 * via the `Math.max(…, 1)` term — fixed to match the implementation.
 */
export function numbersApproxEqual(a: number, b: number): boolean {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= 1e-9 * scale;
}

/**
 * Parse a duration **filter operand** into integer minutes. Accepts
 * the two formats a user is likely to type into the per-column filter
 * box for a `duration` field:
 *
 *   - **`h:mm`** (e.g. `1:30`) — matches the cell display, so a user
 *     can copy what they see in the grid (`1:05`) directly into the
 *     filter (`=1:05`, `>=1:05`, etc.). Minutes are validated to be
 *     `0 <= mm < 60`; `1:75` is rejected (returns `NaN`) rather than
 *     silently interpreted as `2:15` — the user has clearly typed
 *     something that isn't a real clock-style duration.
 *   - **bare integer minutes** (e.g. `90`) — for power users who
 *     think in minutes and don't want to do the h:mm arithmetic.
 *     `90` and `1:30` therefore filter the same rows.
 *
 * Returns `NaN` for any other input (empty string, fractional minutes,
 * negatives with an `h:mm`, anything non-numeric) so the caller can
 * fall through to the substring branch instead of silently filtering
 * against `0`. We deliberately do **not** accept a bare decimal like
 * `1.5` here: duration storage is integer-minutes-only and there's no
 * visual cue in the cell that would lead a user to type `>1.5`, so
 * letting it pass would just mask a typo. (Power users who want
 * half-minute granularity can type `>90` for ">1.5 hours".)
 *
 * Kept aligned with `coerceCsvCellToFieldValue`'s duration branch in
 * `baseImportExport.ts` (same `^(\d+):(\d{1,2})$` shape, same `min < 60`
 * guard) so the filter and the importer agree on what counts as a
 * valid clock-style operand.
 */
export function parseDurationFilterOperand(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") return NaN;
  if (trimmed.includes(":")) {
    const m = trimmed.match(/^(\d+):(\d{1,2})$/);
    if (!m) return NaN;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(min) || min >= 60) {
      return NaN;
    }
    return h * 60 + min;
  }
  // Bare integer minutes (no fractional component — duration storage
  // is integer-minutes-only, so a fractional operand would never
  // exact-match anything anyway and is more likely a typo than intent).
  const m = trimmed.match(/^-?\d+$/);
  if (!m) return NaN;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : NaN;
}

export function matchesFilter(
  fieldType: FieldType,
  value: unknown,
  filter: string,
  displayValue?: string,
): boolean {
  const f = filter.trim();
  if (f === "") return true;

  // Computed types: caller passes the rendered string. Numeric
  // comparison operators against an `auto_number` column should
  // behave the same as on a plain numeric column (the placeholder
  // text encourages `>5` etc.), so we run the operator-prefix
  // parser against the display string first and fall back to
  // substring matching for non-numeric inputs / non-numeric
  // displays.
  if (isComputedFieldType(fieldType)) {
    const target = displayValue ?? "";
    // `Number("")` is `0`, which would make every empty-display row
    // match `"0"` / `">=0"` / `"<1"` etc. Treat an empty display
    // string as "no value here" and short-circuit before any
    // numeric comparison can produce a false positive. The substring
    // fall-through below would also lie on a literal empty filter
    // input, but `f === ""` is already filtered out above so this
    // only fires when the user typed something. The companion
    // `target.trim() === ""` covers `" "`-only display strings
    // emitted by formatters that pad with a non-breaking space.
    const targetEmpty = target.trim() === "";
    const m = f.match(/^\s*(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
      if (targetEmpty) return false;
      const op = m[1];
      const operand = Number(m[2]);
      const n = Number(target);
      if (Number.isFinite(n) && Number.isFinite(operand)) {
        switch (op) {
          case ">":
            return n > operand;
          case ">=":
            return n >= operand;
          case "<":
            return n < operand;
          case "<=":
            return n <= operand;
          case "=":
            return numbersApproxEqual(n, operand);
        }
      }
      // Operator parse hit, but the displayed value isn't numeric —
      // a `>10` on a formula returning `"hello"` should hide the
      // row, not silently fall back to substring matching.
      return false;
    }
    if (targetEmpty) return false;
    const bare = Number(f);
    if (Number.isFinite(bare)) {
      const n = Number(target);
      if (Number.isFinite(n)) return numbersApproxEqual(n, bare);
    }
    return target.toLowerCase().includes(f.toLowerCase());
  }

  // Multi-valued types: match if ANY element contains the filter.
  if (
    fieldType === "multi_select" ||
    fieldType === "attachment" ||
    fieldType === "linked_record"
  ) {
    if (!Array.isArray(value)) return false;
    const needle = f.toLowerCase();
    return value.some(
      (v) => typeof v === "string" && v.toLowerCase().includes(needle),
    );
  }

  // Checkbox: literal true/false/1/0.
  if (fieldType === "checkbox") {
    const lower = f.toLowerCase();
    const truthy = lower === "true" || lower === "1" || lower === "yes";
    const falsy = lower === "false" || lower === "0" || lower === "no";
    if (!truthy && !falsy) return false;
    return Boolean(value) === truthy;
  }

  // Numeric types: support operator prefixes.
  // `auto_number` is intentionally excluded — it's a computed
  // type and handled by the `isComputedFieldType` branch above.
  // Its stored value is always `null`, so reading
  // `Number(value)` here would compare `0` to whatever the user
  // typed and hide every row, which was the bug Devin Review
  // flagged on PR #79 (BUG_pr-review-job-…-0001).
  const numericTypes: FieldType[] = [
    "number",
    "currency",
    "percent",
    "rating",
    "duration",
  ];
  if (numericTypes.includes(fieldType)) {
    // An empty cell (`null`/`undefined`/`""`) should never match a
    // numeric filter — `Number(null) === 0` and `Number("") === 0`
    // both lie, so without this guard the filter `"0"` (or `">=0"`,
    // `"<1"`, etc.) would highlight every empty row. The old filter
    // code that this matcher replaced had an explicit `if (val ==
    // null) return false;` and the unit tests only happened to
    // cover `> 0` (which returns `false` for the wrong reason —
    // `0 > 0` is false). Devin Review caught this on PR #79
    // (BUG_pr-review-job-b04adfa7…-0001).
    if (value === null || value === undefined || value === "") return false;
    // For `percent` the stored value is a fraction (`0.5` = 50%) but
    // the user thinks (and sees) in display percentages. Rescale the
    // user's operand so `>10` means ">10%" — matching what the
    // type-aware filter placeholder (`"e.g. >10"`) advertises. Devin
    // Review flagged this on PR #79 (ANALYSIS_pr-review-job-b04…-0006).
    const scaleOperand = (n: number): number =>
      fieldType === "percent" ? n / 100 : n;
    // For `duration` the stored value is integer minutes (`65` = 1h05m)
    // but the cell renders as `h:mm` (`1:05`). A user looking at
    // `1:05` and typing `>1` would otherwise get ">1 minute" (every
    // non-empty row matches), not the obviously-intended ">1 hour".
    // `parseDurationFilterOperand` accepts either `1:30` (h:mm —
    // matches the cell display) or `90` (raw minutes — power users)
    // and returns minutes in both cases, so the comparison below is
    // always against the stored integer-minutes representation.
    // Devin Review PR #79 round 12 (ANALYSIS_…_0003).
    const parseOperand = (s: string): number =>
      fieldType === "duration"
        ? parseDurationFilterOperand(s)
        : Number(s);
    // For `percent` columns *also* accept a trailing `%` on the
    // user's operand — the displayed value carries one (`50%`), so
    // it's the most natural thing for a user to type. Without this
    // the regex below misses `>50%` and `Number("50%") = NaN` flips
    // the filter into substring mode against `"0.5"`, which silently
    // returns nothing. Devin Review PR #79 round 10
    // (ANALYSIS_…_0004) flagged the silent fall-through. Stripping
    // is gated on `fieldType === "percent"` so `>10%` against a
    // plain `number` column still falls through to substring
    // (preserving the explicit type contract).
    const normalisedFilter =
      fieldType === "percent" ? f.replace(/%\s*$/, "").trim() : f;
    // Stripping a trailing `%` can leave an empty operand if the user
    // typed just `%` with nothing else. Without this guard,
    // `Number("") === 0` would silently turn the filter into `= 0%`
    // and match every zero-valued row — a confusing footgun on what
    // is obviously a half-typed filter. Treat empty-after-strip as
    // "no numeric intent" and fall through to the substring branch
    // (which won't match `%` against a fraction render like `"0.5"`).
    // Devin Review PR #79 round 11 (ANALYSIS_…_0004) flagged this.
    if (normalisedFilter === "") return false;
    // Match `>=`, `<=`, `>`, `<`, `=` then the operand.  For
    // `duration` we accept `h:mm` as well as a bare number (e.g.
    // `>1:30`); for every other numeric type the operand is a plain
    // decimal (`>10`, `<=5.5`).  Splitting the operator from the
    // operand and delegating operand parsing to `parseOperand` keeps
    // the duration / non-duration paths sharing the same comparison
    // pipeline.
    const operandPattern =
      fieldType === "duration"
        ? "(\\d+:\\d{1,2}|-?\\d+(?:\\.\\d+)?)"
        : "(-?\\d+(?:\\.\\d+)?)";
    const m = normalisedFilter.match(
      new RegExp(`^\\s*(>=|<=|>|<|=)\\s*${operandPattern}\\s*$`),
    );
    if (m) {
      const op = m[1];
      const parsed = parseOperand(m[2]);
      const operand = scaleOperand(parsed);
      const n = Number(value);
      if (!Number.isFinite(n) || !Number.isFinite(operand)) return false;
      switch (op) {
        case ">":
          return n > operand;
        case ">=":
          return n >= operand;
        case "<":
          return n < operand;
        case "<=":
          return n <= operand;
        case "=":
          return numbersApproxEqual(n, operand);
      }
    }
    // Bare operand → equals (with type-specific parsing: h:mm for
    // duration, decimal for everything else, then percent rescaling).
    const bare = parseOperand(normalisedFilter);
    if (Number.isFinite(bare)) {
      const n = Number(value);
      return Number.isFinite(n) && numbersApproxEqual(n, scaleOperand(bare));
    }
    // Non-numeric filter on a numeric column: fall back to substring
    // on the rendered string so users can still find a value.
    return String(value ?? "")
      .toLowerCase()
      .includes(f.toLowerCase());
  }

  // Everything else (text, long_text, email, phone, url, date,
  // select): case-insensitive substring on the stored string.
  if (value == null) return false;
  return String(value).toLowerCase().includes(f.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────
// View-state stale-pointer cleanup
// ─────────────────────────────────────────────────────────────────────

/**
 * The six `BaseViewConfig` keys that store a field-name pointer. Kept
 * here (next to `pruneViewStateAgainstFields`) so the list is
 * enumerated **once** across the codebase — `BaseEditor.renameField`
 * and `BaseEditor.dropStaleViewState` both consume this constant
 * instead of redeclaring it inline, so adding a new field-name
 * pointer in `BaseViewConfig` (e.g. a "color by" field) only needs to
 * be added here once and both call sites pick it up.
 *
 * Devin Review on PR #79 flagged the duplication between rename and
 * import paths.
 */
export const VIEW_CONFIG_FIELD_POINTERS: ReadonlyArray<keyof BaseViewConfig> = [
  "kanbanGroupField",
  "calendarDateField",
  "timelineStartField",
  "timelineEndField",
  "galleryCoverField",
  "titleField",
];

/**
 * After replacing the entire Base content via import (or any other
 * schema-changing operation), drop sort / filter / view-config state
 * that points at fields that no longer exist.
 *
 * Returns a tuple of `[nextSortField, nextFilters, nextViewConfig]`.
 * Each entry preserves referential equality with its input when
 * nothing changed, so React `setX(prev => helperReturn[i])` calls
 * don't trigger unnecessary re-renders.
 *
 * Without this:
 *   - the grid header would still show a typed-in filter on a column
 *     that no longer exists and the sort indicator would point at
 *     nothing;
 *   - Kanban / Calendar / Timeline / Gallery would silently render
 *     empty because they call
 *     `fields.find((f) => f.name === config.kanbanGroupField)` and
 *     miss when the imported schema dropped that field.
 *
 * `filteredAndSorted` already tolerates the stale state (missing
 * fields are skipped), but the UI looks broken until the user
 * manually clears each one. Devin Review on PR #79 flagged this in
 * two rounds — sort+filter in round 3, viewConfig in round 4 — so
 * we own the entire cleanup in one helper now.
 */
export function pruneViewStateAgainstFields(
  fields: BaseField[],
  prev: {
    sortField: string | null;
    filters: Record<string, string>;
    viewConfig: BaseViewConfig;
  },
): {
  sortField: string | null;
  filters: Record<string, string>;
  viewConfig: BaseViewConfig;
} {
  const names = new Set(fields.map((f) => f.name));

  // Sort pointer.
  const nextSort =
    prev.sortField !== null && !names.has(prev.sortField)
      ? null
      : prev.sortField;

  // Filter map: keep entries whose key still exists.
  let filtersDirty = false;
  const nextFilters: Record<string, string> = {};
  for (const [k, v] of Object.entries(prev.filters)) {
    if (names.has(k)) {
      nextFilters[k] = v;
    } else {
      filtersDirty = true;
    }
  }

  // View-config: null out every pointer whose target was dropped.
  let viewDirty = false;
  const nextView: BaseViewConfig = { ...prev.viewConfig };
  for (const k of VIEW_CONFIG_FIELD_POINTERS) {
    const ref = prev.viewConfig[k];
    if (ref !== null && !names.has(ref)) {
      nextView[k] = null;
      viewDirty = true;
    }
  }

  return {
    sortField: nextSort,
    filters: filtersDirty ? nextFilters : prev.filters,
    viewConfig: viewDirty ? nextView : prev.viewConfig,
  };
}
