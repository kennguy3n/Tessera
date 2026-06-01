/**
 * Pure type declarations for `BaseEditor` and its companion modules.
 *
 * Lives in a third file (neither the component file nor the helpers
 * file) so the component and helpers can each import these types
 * directly without creating a runtime cycle. Compile-time-erased
 * declarations only — no value-level code lives here, by design.
 *
 * expansion: 15 new field types covering Airtable
 * parity (multi_select, formula, linked_record, rollup, lookup,
 * attachment, long_text, email, phone, currency, percent, rating,
 * duration, auto_number, plus the existing 6 from PR 0).
 *
 * Most types still store a plain primitive (`number | string |
 * boolean`); the structural types — `multi_select`, `linked_record`,
 * `attachment` — store `string[]`. Computed types (`formula`,
 * `rollup`, `lookup`) carry their derivation config on the field
 * definition itself; the *value* in the record is whatever the engine
 * resolves at render time (we don't persist computed values to avoid
 * staleness).
 */

export type FieldType =
  // Phase 0 primitives
  | "text"
  | "number"
  | "date"
  | "select"
  | "checkbox"
  | "url"
  //
  | "multi_select"
  //
  | "formula"
  // Tasks 3-5
  | "linked_record"
  | "rollup"
  | "lookup"
  //
  | "attachment"
  //
  | "long_text"
  // simple typed inputs
  | "email"
  | "phone"
  | "currency"
  | "percent"
  | "rating"
  | "duration"
  | "auto_number";

/**
 * Aggregation kinds supported by rollup fields. Names mirror the
 * spreadsheet functions a user already knows, so the field-config UI
 * doesn't need a separate vocabulary.
 */
export type RollupAggregation =
  | "SUM"
  | "AVG"
  | "MIN"
  | "MAX"
  | "COUNT"
  | "CONCAT";

export interface BaseField {
  name: string;
  type: FieldType;

  /** `select` / `multi_select` — choices the user picks from. */
  options?: string[];

  /**
   * `formula` — the formula source (without the leading `=`).
   * Field references use the curly-brace Airtable syntax,
   * e.g. `{Price} * {Quantity}`.
   */
  formula?: string;

  /**
   * `linked_record` — name of the (same-base) field this record
   * points to. For MVP the target is always the implicit `id` on
   * peer records in the *same* base; the field config stores the
   * displayed-name field so the chips show meaningful labels.
   */
  linkedDisplayField?: string;

  /**
   * `rollup` / `lookup` — name of the `linked_record` field whose
   * links we follow.
   */
  linkedField?: string;

  /**
   * `rollup` / `lookup` — name of the field on the linked
   * records to aggregate (rollup) or display (lookup).
   */
  targetField?: string;

  /** `rollup` only — how to combine the gathered values. */
  aggregation?: RollupAggregation;

  /** `currency` — ISO 4217 / symbol (defaults to `$`). */
  currencySymbol?: string;

  /** `percent` — integer count of decimal digits to render (default 0). */
  percentPrecision?: number;
}

export interface BaseContent {
  fields: BaseField[];
  records: BaseRecord[];
}

/**
 * A record carries an implicit `id` so other records can link to it
 * across the same base. The id is opaque (we use a short random
 * string) — never user-visible, never reordered, never reused. All
 * other fields are stored as `Record<string, unknown>` keyed by the
 * field's `name`.
 *
 * Persistence: `id` is serialized into the JSON body alongside the
 * field values, so a round-trip preserves linkages.
 */
export interface BaseRecord {
  id: string;
  [fieldName: string]: unknown;
}
