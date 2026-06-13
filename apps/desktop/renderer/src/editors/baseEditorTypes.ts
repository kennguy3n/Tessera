/**
 * Pure type declarations for `BaseEditor` and its companion modules.
 *
 * Lives in a third file (neither the component file nor the helpers
 * file) so the component and helpers can each import these types
 * directly without creating a runtime cycle. This is almost entirely
 * compile-time-erased declarations; the one deliberate exception is the
 * handful of reserved record-key `const`s below (`RECORD_*_KEY`), which
 * the {@link BaseRecord} interface uses as computed property keys and so
 * must live in the same module as the type that depends on them. They
 * are zero-import `as const` string literals (trivially tree-shakeable),
 * so they introduce no runtime cycle.
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
  | "auto_number"
  // Collaborator / metadata parity. `user` stores a free-text
  // collaborator name (local-first — there is no central identity
  // directory in Tessera, so the value is a name/email string). The
  // two `*_time` types are computed: they READ the record's
  // intrinsic created/modified timestamp metadata
  // (`RECORD_CREATED_KEY` / `RECORD_MODIFIED_KEY`) and never store
  // their own value — exactly like Airtable's "Created time" /
  // "Last modified time" fields.
  | "user"
  | "created_time"
  | "modified_time";

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
   * `linked_record` — name of the field on the *target* records used
   * to render a human-readable chip label (falling back to a short id
   * slice when unset or empty). The target table is given by
   * {@link linkedTableId}.
   */
  linkedDisplayField?: string;

  /**
   * `linked_record` — id of the {@link BaseTable} this field links
   * to. When **absent**, the link targets records in the *same*
   * table (the original single-table behaviour, preserved for
   * backward compatibility with bases authored before multi-table
   * support). When present, the link points at records in a
   * different table within the same {@link BaseDocument}, which is
   * the signature Airtable capability — and `rollup` / `lookup`
   * fields that reference this `linked_record` field traverse into
   * that target table to aggregate / display `targetField`.
   */
  linkedTableId?: string;

  /**
   * `date` — when true the cell captures a time component as well as
   * a calendar day (rendered via `datetime-local`, stored as an ISO
   * `YYYY-MM-DDTHH:mm` string). When false / absent the cell is a
   * plain date (`YYYY-MM-DD`), the original behaviour.
   */
  dateIncludeTime?: boolean;

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
 * A single table within a {@link BaseDocument}. A table is exactly a
 * named {@link BaseContent} plus a stable opaque `id` that
 * `linked_record` fields in *other* tables reference via
 * {@link BaseField.linkedTableId}. The id is never user-visible and
 * never reused (same contract as a record id).
 */
export interface BaseTable extends BaseContent {
  id: string;
  name: string;
}

/**
 * The multi-table document model. A base is an ordered list of
 * tables plus a pointer to the table the editor is currently
 * showing.
 *
 * Backward compatibility: a base authored before multi-table support
 * was serialized as a bare {@link BaseContent} (`{ fields, records }`).
 * `parseBaseDocument` migrates that shape into a single-table
 * document on load, and `serializeBaseDocument` writes the legacy
 * `{ fields, records }` shape back out whenever the document has
 * exactly one table — so single-table bases round-trip byte-compatibly
 * and downstream consumers (the Rust `tessera_export` CSV/JSON path,
 * existing artifacts) keep working unchanged. The richer
 * `{ tables, activeTableId }` shape is only emitted once a second
 * table exists.
 */
export interface BaseDocument {
  tables: BaseTable[];
  activeTableId: string;
}

/**
 * A comment on a record, shown in the expand-record modal's
 * comments/activity timeline. Local-first: `author` is a free-text
 * name (Tessera has no central identity directory), `createdAt` is
 * an ISO timestamp.
 */
export interface BaseComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

/**
 * Reserved per-record metadata keys. These live alongside the user's
 * field values in the record object but are NEVER treated as fields
 * (not rendered as columns, not exported as CSV columns, not
 * assignable as a field name — see `RESERVED_FIELD_NAMES`). They back
 * the `created_time` / `modified_time` field types and the
 * expand-record comments/activity timeline.
 */
export const RECORD_ID_KEY = "id" as const;
export const RECORD_CREATED_KEY = "__created" as const;
export const RECORD_MODIFIED_KEY = "__modified" as const;
export const RECORD_COMMENTS_KEY = "__comments" as const;

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
  /** ISO timestamp set once when the record is created (optional for
   *  legacy records authored before metadata existed). */
  [RECORD_CREATED_KEY]?: string;
  /** ISO timestamp updated on every cell edit. */
  [RECORD_MODIFIED_KEY]?: string;
  /** Comments timeline for the expand-record modal. */
  [RECORD_COMMENTS_KEY]?: BaseComment[];
  [fieldName: string]: unknown;
}
