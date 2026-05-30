/**
 * Phase 17 PR 5 — Base import/export.
 *
 * The artifact-export pipeline already round-trips the raw JSON
 * (`tessera_core::ExportFormat::Json`), which is faithful to the
 * editor's in-memory state but useless for users who want CSV /
 * Excel. The Rust CSV exporter (`crates/tessera_export/src/csv.rs`)
 * was originally written for documents and only emits the artifact's
 * top-level metadata — it doesn't know about field types at all.
 *
 * This module produces:
 *   - **`exportBaseCsv(data)`** — a real records × fields CSV using
 *     the per-field `formatValueForCsv` rules below.  Multi-valued
 *     fields (`multi_select`, `linked_record`, `attachment`) are
 *     flattened with `"; "` (chosen over `","` so the cell remains
 *     readable in Excel without the field needing to be re-quoted).
 *     Linked-record cells render the linked records' display field
 *     (falling back to the id slice the editor itself shows) rather
 *     than the opaque ids, so the CSV is meaningful to a human.
 *     Computed fields (`formula`, `rollup`, `lookup`) are evaluated
 *     against the live records before export so the spreadsheet
 *     receives the *value*, not the formula source.
 *   - **`exportBaseJson(data)`** — pretty-printed `{ fields, records }`
 *     (same shape as the on-disk artifact body, but emitted as a
 *     standalone file rather than wrapped in the artifact envelope).
 *
 * And on the import side:
 *   - **`parseCsvToBase(csv, schema?)`** — parses a CSV blob into a
 *     `BaseContent`.  When a `schema` (existing fields) is supplied,
 *     columns are matched against existing field names so a re-import
 *     of an exported CSV is a structural round-trip; columns the
 *     schema doesn't recognise are added as fresh `text` fields so
 *     no data is dropped.  Each parsed value passes through
 *     `coerceCsvCellToFieldValue` to recover the right runtime type
 *     (numbers, booleans, ISO dates, multi_select splits, etc.).
 *   - **`parseJsonToBase(json)`** — accepts either the canonical
 *     `{ fields, records }` shape OR a bare array of objects (the
 *     shape pandas / google-sheets dump produces), inferring fields
 *     from the keys of the first record in the latter case.
 *
 * The CSV implementation is RFC-4180 compliant (quoted fields with
 * embedded commas / newlines / double-quotes) and is deliberately
 * self-contained — pulling in a heavy CSV library for what amounts
 * to a few hundred lines of well-specified parsing would dwarf the
 * code that actually uses it.  The tokenizer here is the same shape
 * the spreadsheet's CSV import uses, so behaviour is consistent
 * across the two editors.
 */

import { evaluateBaseFormula, formatFormulaResult } from "./baseFormulaEngine";
import {
  aggregateValues,
  lookupValues,
  makeRecordId,
  resolveLinkedRecords,
  isReservedFieldName,
  RESERVED_FIELD_NAMES,
  sanitizeBaseField,
  ensureRecordIds,
} from "./baseEditorHelpers";
import type {
  BaseContent,
  BaseField,
  BaseRecord,
  FieldType,
} from "./baseEditorTypes";

// ─────────────────────────────────────────────────────────────────────
// CSV escape / parse primitives
// ─────────────────────────────────────────────────────────────────────

/**
 * Quote a single CSV cell per RFC-4180:
 *   - Empty / safe strings → unquoted
 *   - Contains comma, quote, CR, or LF → wrapped in `"…"` and any
 *     embedded `"` is doubled.
 *
 * Exported so callers (and tests) can verify the encoding without
 * round-tripping through `exportBaseCsv`.
 */
export function csvEscapeCell(value: string): string {
  if (value === "") return "";
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Tokenise a CSV blob into a 2-D string matrix.
 *
 * Implements the full RFC-4180 grammar:
 *   - Fields delimited by `,`
 *   - Rows delimited by `CRLF`, `LF`, or `CR`
 *   - Fields may be wrapped in `"…"`; embedded `"` is doubled
 *   - A trailing newline does NOT produce an extra empty row
 *
 * Returns `[]` for blank input.  Throws on malformed input
 * (unterminated quoted field).
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      // A quote only opens a quoted field at the start of a cell —
      // a stray `"` in the middle of an unquoted cell is treated
      // as a literal character (matches Excel's lenient parser).
      if (cell === "") {
        inQuotes = true;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }

    if (ch === ",") {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      // Consume CRLF as a single row separator.
      if (ch === "\r" && text[i + 1] === "\n") {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    cell += ch;
    i += 1;
  }

  if (inQuotes) {
    throw new Error("Unterminated quoted field in CSV input");
  }

  // Flush the final cell / row unless the trailing character was a
  // line break (in which case we already pushed the row).
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────
// Per-field-type value formatting (record → CSV cell)
// ─────────────────────────────────────────────────────────────────────

/**
 * Cells that store an array are joined with `; ` (semicolon + space).
 * Chosen so the result is human-readable in Excel without further
 * quoting; commas inside an option label would otherwise force the
 * cell to be wrapped in quotes for every multi-valued row, hurting
 * legibility.
 */
const ARRAY_JOIN = "; ";

/**
 * Format a single field/value pair for CSV export. The `record` and
 * `allRecords` / `allFields` are needed for computed types (formula,
 * rollup, lookup) and linked_record (which resolves to the display
 * field on the target).
 *
 * Returns the *raw* string — the caller is responsible for
 * `csvEscapeCell()`-ing before joining into a row.
 */
export function formatValueForCsv(
  field: BaseField,
  record: BaseRecord,
  allRecords: BaseRecord[],
  allFields: BaseField[],
): string {
  const value = record[field.name];

  switch (field.type) {
    case "text":
    case "long_text":
    case "email":
    case "phone":
    case "url":
    case "date":
    case "select":
      return value == null ? "" : String(value);

    case "number":
      if (value == null || value === "") return "";
      return Number.isFinite(Number(value)) ? String(Number(value)) : "";

    case "checkbox":
      // `true` / `false` survives Excel round-trips and re-parses
      // unambiguously via `coerceCsvCellToFieldValue`.
      return value ? "true" : "false";

    case "currency": {
      if (value == null || value === "") return "";
      const n = Number(value);
      if (!Number.isFinite(n)) return "";
      const symbol = field.currencySymbol ?? "$";
      return `${symbol}${n.toFixed(2)}`;
    }

    case "percent": {
      if (value == null || value === "") return "";
      const n = Number(value);
      if (!Number.isFinite(n)) return "";
      // Defense-in-depth clamp to the same [0, 20] range that
      // `sanitizeBaseField` enforces on parse. `parseBaseContent` is
      // the canonical normaliser, but the export path runs against
      // *live* `data.fields`, which can drift if a future field-edit
      // path forgets to re-sanitize, or if a hand-crafted JSON import
      // ever slips past sanitisation. `Number.prototype.toFixed`
      // throws `RangeError` for arguments outside [0, 100]; clamping
      // here turns a hostile config into harmless extra precision
      // instead of a thrown export.
      const raw = Math.max(0, Math.floor(field.percentPrecision ?? 0));
      const digits = Math.min(20, raw);
      return `${(n * 100).toFixed(digits)}%`;
    }

    case "rating":
      return value == null ? "" : String(Math.max(0, Math.floor(Number(value))));

    case "duration": {
      // h:mm — same display the cell uses.
      if (value == null || value === "") return "";
      const minutes = Math.max(0, Math.floor(Number(value)));
      if (!Number.isFinite(minutes)) return "";
      const hh = Math.floor(minutes / 60);
      const mm = minutes % 60;
      return `${hh}:${String(mm).padStart(2, "0")}`;
    }

    case "auto_number": {
      // Mirrors the cell's 1-based display so the CSV row number
      // matches what the user saw in the grid.
      const idx = allRecords.indexOf(record);
      return idx >= 0 ? String(idx + 1) : "";
    }

    case "multi_select":
    case "attachment":
      // Already stored as `string[]` by the editor; flatten with
      // `; ` so a CSV-aware re-import (`coerceCsvCellToFieldValue`)
      // can recover the original array.
      if (!Array.isArray(value)) return "";
      return value.filter((v) => typeof v === "string").join(ARRAY_JOIN);

    case "linked_record": {
      // Render the display field (or the same 6-char id slice the
      // chip shows) — opaque 16-hex ids in a CSV would be
      // hostile to the human reading the export.
      if (!Array.isArray(value)) return "";
      const ids = value.filter((v): v is string => typeof v === "string");
      const linked = resolveLinkedRecords(ids, allRecords);
      const display = field.linkedDisplayField;
      return linked
        .map((r) =>
          display && r[display] != null
            ? String(r[display])
            : r.id.slice(0, 6),
        )
        .join(ARRAY_JOIN);
    }

    case "formula": {
      const src = field.formula ?? "";
      // Pass `field.name` so the engine's cycle detector seeds
      // the visiting set with this field, matching how the live
      // FormulaCell evaluates.
      const result = evaluateBaseFormula(src, allFields, record, field.name);
      return formatFormulaResult(result);
    }

    case "rollup": {
      // Replicate the cell-render path: follow the linked_record
      // field on this record, resolve the linked records, pluck
      // the target field's values, and aggregate. A missing /
      // misconfigured config yields the same `#REF!` sentinel the
      // cell would show.
      const linkedFieldName = field.linkedField;
      const targetFieldName = field.targetField;
      const aggregation = field.aggregation ?? "CONCAT";
      if (!linkedFieldName || !targetFieldName) return "";
      const linkedFieldDef = allFields.find((f) => f.name === linkedFieldName);
      if (!linkedFieldDef || linkedFieldDef.type !== "linked_record") {
        return "#REF!";
      }
      const ids = record[linkedFieldName];
      const linkedRecords = resolveLinkedRecords(ids, allRecords);
      const values = linkedRecords.map((r) => r[targetFieldName]);
      return aggregateValues(values, aggregation);
    }

    case "lookup": {
      const linkedFieldName = field.linkedField;
      const targetFieldName = field.targetField;
      if (!linkedFieldName || !targetFieldName) return "";
      const linkedFieldDef = allFields.find((f) => f.name === linkedFieldName);
      if (!linkedFieldDef || linkedFieldDef.type !== "linked_record") {
        return "#REF!";
      }
      const ids = record[linkedFieldName];
      const linkedRecords = resolveLinkedRecords(ids, allRecords);
      return lookupValues(linkedRecords, targetFieldName);
    }

    default: {
      // Exhaustive guard — TypeScript will flag any new field type
      // added to `FieldType` that doesn't have a CSV formatter.
      const _exhaustive: never = field.type;
      return _exhaustive;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Exporters
// ─────────────────────────────────────────────────────────────────────

/**
 * Serialize the entire base to CSV. Computed columns (formula /
 * rollup / lookup) are evaluated against the live records so the
 * export carries values rather than formula sources.
 *
 * The CSV starts with a single header row (one column per field) and
 * uses CRLF line endings — Excel on Windows handles LF correctly but
 * some downstream tools (Numbers, older versions of Outlook's CSV
 * preview) only respect CRLF.
 */
export function exportBaseCsv(data: BaseContent): string {
  const { fields, records } = data;
  const header = fields.map((f) => csvEscapeCell(f.name)).join(",");
  const rows = records.map((record) =>
    fields
      .map((field) =>
        csvEscapeCell(formatValueForCsv(field, record, records, fields)),
      )
      .join(","),
  );
  return [header, ...rows].join("\r\n");
}

/**
 * Serialize the entire base to a stable, indented JSON blob.
 * Identical shape to the artifact body, so users can re-paste the
 * file into a future "Import → JSON" without any munging.
 */
export function exportBaseJson(data: BaseContent): string {
  return JSON.stringify(data, null, 2);
}

// ─────────────────────────────────────────────────────────────────────
// Importers
// ─────────────────────────────────────────────────────────────────────

/**
 * Convert a single raw CSV string into the runtime value the field
 * expects. Field type drives the coercion: numbers parse via
 * `Number()`, dates pass through as ISO strings (we don't validate
 * here — the cell renders the literal), checkboxes accept the usual
 * truthy/falsy text values, multi-valued fields split on `;` and
 * trim whitespace.
 *
 * Returns `null` for an empty cell on any nullable field (everything
 * except `auto_number`, which is computed at render time anyway).
 */
export function coerceCsvCellToFieldValue(
  raw: string,
  type: FieldType,
): unknown {
  const trimmed = raw.trim();

  switch (type) {
    case "text":
    case "long_text":
    case "email":
    case "phone":
    case "url":
    case "date":
    case "select":
      return trimmed === "" ? null : trimmed;

    case "number":
      if (trimmed === "") return null;
      return Number.isFinite(Number(trimmed)) ? Number(trimmed) : null;

    case "checkbox": {
      if (trimmed === "") return false;
      const lower = trimmed.toLowerCase();
      return lower === "true" || lower === "yes" || lower === "1";
    }

    case "currency": {
      if (trimmed === "") return null;
      // Strip a leading currency symbol (and grouping commas) so
      // "$1,234.56" round-trips back to 1234.56.
      const stripped = trimmed.replace(/^[^\d.-]+/, "").replace(/,/g, "");
      const n = Number(stripped);
      return Number.isFinite(n) ? n : null;
    }

    case "percent": {
      if (trimmed === "") return null;
      const stripped = trimmed.replace(/%$/, "");
      const n = Number(stripped);
      // Stored as a fraction (0.5 for 50%), inverting the export
      // transform.
      return Number.isFinite(n) ? n / 100 : null;
    }

    case "rating": {
      if (trimmed === "") return null;
      const n = Number(trimmed);
      return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
    }

    case "duration": {
      if (trimmed === "") return null;
      const m = trimmed.match(/^(\d+):(\d{1,2})$/);
      if (!m) return null;
      const h = Number(m[1]);
      const min = Number(m[2]);
      if (!Number.isFinite(h) || !Number.isFinite(min) || min >= 60) {
        return null;
      }
      return h * 60 + min;
    }

    case "auto_number":
      // Auto-number is recomputed at render time from row position,
      // so an imported value would be ignored.  Returning `null`
      // keeps the JSON small.
      return null;

    case "multi_select":
    case "attachment":
      if (trimmed === "") return [];
      return trimmed
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

    case "linked_record":
      // CSV exports linked records as display labels, not ids — a
      // CSV-only import can't recover the link target without a
      // back-reference table.  We import as an empty array and
      // expect the user to re-link, rather than guessing.
      return [];

    case "formula":
    case "rollup":
    case "lookup":
      // Computed fields don't store values — the engine recomputes
      // on every render.  Importing a value would be ignored.
      return null;

    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

/**
 * Parse a CSV blob into a fully-typed `BaseContent`.
 *
 * @param csv     The raw CSV text (UTF-8).
 * @param schema  Optional existing field definitions. Columns whose
 *                header matches an existing field name re-use that
 *                field's type and config; unknown columns are added
 *                as fresh `text` fields so nothing is silently
 *                dropped.
 *
 * Reserved column names (`id`) are passed through to the record's
 * `id` rather than becoming a user field — this keeps record-level
 * linkage stable across a round-trip.  Records without an `id`
 * column get a fresh one via `makeRecordId()`.
 */
export function parseCsvToBase(
  csv: string,
  schema?: BaseField[],
): BaseContent {
  const rows = parseCsv(csv);
  if (rows.length === 0) return { fields: [], records: [] };

  const headers = rows[0];
  if (headers.length === 0) return { fields: [], records: [] };

  // Build the field list: keep schema field configs where the
  // header name matches; otherwise mint a text field.  The `id`
  // column is excluded — it's a record-level property, not a
  // user-visible field.
  //
  // Field names must be unique across the resulting BaseContent —
  // every downstream consumer (the `renameField` uniqueness check,
  // the per-field filter map keyed by name, every `fields.find` /
  // `data.fields.some` lookup, JSON keys on each record) assumes
  // that. CSV headers can legitimately collide (`Name,Name`, or a
  // malformed export that lost a column), so disambiguate with a
  // ` (2)` / ` (3)` … suffix instead of silently importing a
  // half-broken schema. The renamed column still pulls from the
  // correct CSV column — the column index is preserved on
  // `fieldForColumn` so cell values never get shuffled.
  const fields: BaseField[] = [];
  const fieldForColumn: (BaseField | null)[] = [];
  const usedNames = new Set<string>();

  // Pre-scan the trimmed header list so the disambiguator knows
  // about *every* deliberate name, including ones that appear
  // later in the row. This is what stops a header sequence like
  // `Name, Name, Name (2)` from producing `["Name", "Name (2)",
  // "Name (2) (2)"]` — the second `Name` would steal the third
  // column's deliberate name. Looking ahead lets us pick `Name
  // (3)` for the duplicate and let column 3 keep `Name (2)`.
  const allHeaderNames = new Set<string>(headers.map((h) => h.trim()));

  /**
   * Append a numeric suffix (` (2)`, ` (3)`, …) to `base` until the
   * result is not already in use AND does not collide with any
   * other deliberately-named header. Starting at `(2)` matches the
   * convention macOS Finder, Windows Explorer, and Google Drive all
   * use for collisions, so it reads as obvious to a user looking
   * at the imported schema.
   */
  const uniquify = (base: string): string => {
    if (!usedNames.has(base)) return base;
    let i = 2;
    while (
      usedNames.has(`${base} (${i})`) ||
      allHeaderNames.has(`${base} (${i})`)
    ) {
      i += 1;
    }
    return `${base} (${i})`;
  };

  for (const header of headers) {
    const name = header.trim();
    if (isReservedFieldName(name)) {
      fieldForColumn.push(null);
      continue;
    }
    const fromSchema = schema?.find((f) => f.name === name);
    const finalName = uniquify(name);
    // Only re-use the schema field config when the header matched
    // it AND we didn't have to rename it for uniqueness — a
    // renamed column is no longer logically the same field.
    const field: BaseField =
      fromSchema && finalName === name
        ? fromSchema
        : { name: finalName, type: "text" };
    fields.push(field);
    fieldForColumn.push(field);
    usedNames.add(finalName);
  }

  // Locate the (optional) `id` column once — header layout is
  // immutable across the row scan, so doing this per row would be
  // O(rows × headers) for no benefit.
  const idColumnIndex = headers.findIndex((h) => h.trim() === "id");

  const records: BaseRecord[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    // Skip rows that are entirely blank — Excel exports often
    // include a trailing empty line, and we don't want to mint
    // empty records for those.
    if (row.every((cell) => cell.trim() === "")) continue;

    const carriedId =
      idColumnIndex >= 0 ? row[idColumnIndex]?.trim() : undefined;

    const record: BaseRecord = {
      id: carriedId && carriedId.length > 0 ? carriedId : makeRecordId(),
    };

    for (let c = 0; c < headers.length; c += 1) {
      const field = fieldForColumn[c];
      if (!field) continue;
      const raw = row[c] ?? "";
      record[field.name] = coerceCsvCellToFieldValue(raw, field.type);
    }

    records.push(record);
  }

  return { fields, records };
}

/**
 * Parse a JSON blob into a `BaseContent`.
 *
 * Accepts two shapes:
 *   1. The canonical `{ fields, records }` — same shape we export.
 *   2. A bare array of records (`[{key: val, …}, …]`) — pandas /
 *      Google Sheets / `JSON.stringify(rows)` dump shape.  Fields
 *      are inferred from the union of keys in the first record,
 *      typed as `text` (the importer can't know the original type).
 *
 * Throws on malformed JSON.  Records without an `id` get a fresh
 * one; the `id` key is never added as a user field.
 */
export function parseJsonToBase(jsonText: string): BaseContent {
  const parsed: unknown = JSON.parse(jsonText);

  // Shape 2: bare array of objects.
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { fields: [], records: [] };
    const first = parsed[0];
    if (typeof first !== "object" || first === null) {
      throw new Error(
        "JSON array must contain objects, got: " + typeof first,
      );
    }
    // Filter out primitives / null / arrays once, up front, so the
    // field-harvest loop AND the record-build loop can trust every
    // remaining element is a plain object. The field-harvest loop
    // already had this guard (round 1 PR-#79 review), but the
    // record-build `.map` on line 660 read `row.id` without
    // re-filtering — a non-object slipped through `[{...valid...},
    // null]` would crash with `Cannot read properties of null` at
    // import time. Doing the filter once also means `ensureRecordIds`
    // (which we delegate to below for the ID-stamping) only ever
    // sees the same survivors, matching what the artifact loader
    // (`parseBaseContent`) does.
    const cleanRows = (parsed as unknown[]).filter(
      (row): row is Record<string, unknown> =>
        typeof row === "object" && row !== null && !Array.isArray(row),
    );
    const seen = new Set<string>();
    const fields: BaseField[] = [];
    for (const row of cleanRows) {
      for (const key of Object.keys(row)) {
        if (RESERVED_FIELD_NAMES.has(key)) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        fields.push({ name: key, type: "text" });
      }
    }
    const records: BaseRecord[] = cleanRows.map((row) => {
      const id =
        typeof row.id === "string" && row.id.length > 0
          ? row.id
          : makeRecordId();
      const record: BaseRecord = { id };
      for (const field of fields) {
        record[field.name] = row[field.name] ?? null;
      }
      return record;
    });
    return { fields, records };
  }

  // Shape 1: canonical {fields, records}.
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("JSON body must be an object or an array");
  }
  const obj = parsed as { fields?: unknown; records?: unknown };
  if (!Array.isArray(obj.fields) || !Array.isArray(obj.records)) {
    throw new Error(
      "JSON object must have `fields` (array) and `records` (array)",
    );
  }
  // Every imported field goes through `sanitizeBaseField` — the same
  // pass `parseBaseContent` runs on the artifact's stored JSON. Without
  // this, a hand-edited or third-party JSON could land with e.g.
  // `percentPrecision: 200` and crash the very next CSV export
  // (`Number.prototype.toFixed` throws above 100). Sanitising on every
  // entry point — not just the artifact loader — keeps `data.fields`
  // trustworthy for every downstream consumer (cell renderers, the CSV
  // exporter, the formula engine), so they can assume the invariants
  // hold instead of each re-clamping defensively.
  const fields = (obj.fields as BaseField[]).map(sanitizeBaseField);
  // Route records through `ensureRecordIds` — the same defensive
  // pass `parseBaseContent` runs. Plain-`.map` over the array would
  // throw `TypeError: Cannot read properties of null (reading 'id')`
  // the moment a hand-edited / third-party canonical JSON contains a
  // `null` slot in `records`, leaking a raw TypeError to the import
  // dialog instead of a useful error — or, worse, silently producing
  // a broken `BaseRecord[]`. `ensureRecordIds` drops non-objects,
  // re-stamps missing IDs, and preserves referential identity when
  // the input was already well-formed, so the canonical-JSON path
  // now matches the artifact-loader path in robustness.
  const records = ensureRecordIds(obj.records as unknown[]);
  return { fields, records };
}
