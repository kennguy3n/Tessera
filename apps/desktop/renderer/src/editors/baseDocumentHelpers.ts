/**
 * Multi-table Base document model.
 *
 * A base used to be a single `{ fields, records }` blob
 * (`BaseContent`). Airtable's signature capability — linked records
 * BETWEEN tables, with lookup/rollup traversing those links — requires
 * more than one table per base, so the editor now operates on a
 * {@link BaseDocument}: an ordered list of named {@link BaseTable}s
 * plus the id of the table currently being edited.
 *
 * ## Backward compatibility (critical)
 * The on-disk artifact body, the Rust `tessera_export` CSV/JSON path,
 * and every existing test all assume the legacy `{ fields, records }`
 * shape. To avoid a breaking migration:
 *   - `parseBaseDocument` accepts EITHER the legacy shape (wrapped into
 *     a single table) OR the new `{ tables, activeTableId }` shape.
 *   - `serializeBaseDocument` writes the legacy `{ fields, records }`
 *     shape back out whenever the document has exactly one table, and
 *     only emits `{ tables, activeTableId }` once a second table
 *     exists. So a single-table base round-trips byte-compatibly and
 *     nothing downstream changes until the user actually adds a table.
 *
 * Heavy/pure logic lives here with unit tests; `BaseEditor.tsx` stays
 * a thin shell that derives the active table and feeds the existing
 * single-table render path unchanged.
 */
import {
  ensureRecordIds,
  makeRecordId,
  parseBaseContent,
  sanitizeBaseField,
} from "./baseEditorHelpers";
import type {
  BaseContent,
  BaseDocument,
  BaseField,
  BaseRecord,
  BaseTable,
} from "./baseEditorTypes";

/** Mint a fresh opaque table id (same generator as record ids). */
export function makeTableId(): string {
  return makeRecordId();
}

/**
 * A resolver mapping a table id to its {@link BaseTable}, or
 * `undefined` when the id is unknown (e.g. the target table was
 * deleted). Threaded into the cross-table-aware cell renderers and the
 * CSV/JSON exporters so they can follow `linked_record.linkedTableId`
 * into another table without taking a hard dependency on the whole
 * document.
 */
export type BaseTableResolver = (tableId: string) => BaseTable | undefined;

/** Make a stable resolver over a document's tables. */
export function makeTableResolver(doc: BaseDocument): BaseTableResolver {
  const byId = new Map(doc.tables.map((t) => [t.id, t]));
  return (id: string) => byId.get(id);
}

function coerceTable(raw: unknown, fallbackName: string): BaseTable | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Partial<BaseTable>;
  if (!Array.isArray(obj.fields)) return null;
  const fields: BaseField[] = [];
  for (const f of obj.fields as unknown[]) {
    if (f && typeof f === "object" && !Array.isArray(f)) {
      fields.push(sanitizeBaseField(f as BaseField));
    }
  }
  const rawRecords = Array.isArray(obj.records) ? obj.records : [];
  const id = typeof obj.id === "string" && obj.id ? obj.id : makeTableId();
  const name =
    typeof obj.name === "string" && obj.name.trim()
      ? obj.name
      : fallbackName;
  return { id, name, fields, records: ensureRecordIds(rawRecords) };
}

/**
 * Wrap a single {@link BaseContent} into a one-table document. Used by
 * the legacy-migration path and by tests that start from the old
 * shape.
 */
export function singleTableDocument(
  content: BaseContent,
  name = "Table 1",
): BaseDocument {
  const id = makeTableId();
  return {
    tables: [{ id, name, fields: content.fields, records: content.records }],
    activeTableId: id,
  };
}

/**
 * Decode the artifact body into a {@link BaseDocument}.
 *
 * Resolution order:
 *   1. `{ tables: [...], activeTableId }` — the new multi-table shape.
 *      Tables are individually sanitised; a missing/stale
 *      `activeTableId` falls back to the first table.
 *   2. `{ fields, records }` (or empty / non-JSON) — delegated to the
 *      battle-tested `parseBaseContent` and wrapped into a single
 *      table, preserving every legacy default (Name+Status seed, etc.).
 */
export function parseBaseDocument(content: string): BaseDocument {
  if (content) {
    try {
      const parsed = JSON.parse(content) as Partial<BaseDocument>;
      if (parsed && Array.isArray(parsed.tables)) {
        const tables: BaseTable[] = [];
        parsed.tables.forEach((t, i) => {
          const table = coerceTable(t, `Table ${i + 1}`);
          if (table) tables.push(table);
        });
        if (tables.length > 0) {
          const activeTableId =
            typeof parsed.activeTableId === "string" &&
            tables.some((t) => t.id === parsed.activeTableId)
              ? parsed.activeTableId
              : tables[0].id;
          return { tables, activeTableId };
        }
      }
    } catch {
      // Not JSON, or not the multi-table shape — fall through to the
      // legacy single-table parser below.
    }
  }
  // Legacy / empty / non-JSON path: reuse the existing parser verbatim
  // so all of its normalisation + defaults are preserved.
  return singleTableDocument(parseBaseContent(content));
}

/**
 * Serialize a {@link BaseDocument} back to the artifact body string.
 *
 * Single-table documents emit the legacy `{ fields, records }` shape
 * (dropping the synthetic table id/name) so the output is identical to
 * what the pre-multi-table editor produced — keeping the Rust export
 * path and existing artifacts working. Multi-table documents emit the
 * full `{ tables, activeTableId }` shape.
 */
export function serializeBaseDocument(doc: BaseDocument): string {
  if (doc.tables.length === 1) {
    const t = doc.tables[0];
    const legacy: BaseContent = { fields: t.fields, records: t.records };
    return JSON.stringify(legacy);
  }
  return JSON.stringify(doc);
}

/** Look up the active table; falls back to the first table if the
 *  pointer is somehow stale (defensive — `parseBaseDocument` keeps it
 *  consistent, but in-memory mutations route through the helpers below
 *  which also keep it consistent). */
export function getActiveTable(doc: BaseDocument): BaseTable {
  return (
    doc.tables.find((t) => t.id === doc.activeTableId) ?? doc.tables[0]
  );
}

/**
 * Replace the active table's `{ fields, records }` with `content`,
 * returning a new document. The table id/name are preserved. This is
 * the single write path the editor's mutation callbacks funnel
 * through, so the rest of the editor can keep thinking in terms of a
 * single `BaseContent`.
 */
export function updateActiveTable(
  doc: BaseDocument,
  content: BaseContent,
): BaseDocument {
  return {
    ...doc,
    tables: doc.tables.map((t) =>
      t.id === doc.activeTableId
        ? { ...t, fields: content.fields, records: content.records }
        : t,
    ),
  };
}

/** Generate a table name that doesn't collide with an existing one. */
export function uniqueTableName(doc: BaseDocument, base = "Table"): string {
  const existing = new Set(doc.tables.map((t) => t.name));
  for (let i = doc.tables.length + 1; ; i++) {
    const candidate = `${base} ${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}

/** Append a new empty table (one `Name` text field, no records) and
 *  make it active. Returns a new document. */
export function addTable(doc: BaseDocument, name?: string): BaseDocument {
  const id = makeTableId();
  const tableName = name?.trim() || uniqueTableName(doc);
  const table: BaseTable = {
    id,
    name: tableName,
    fields: [{ name: "Name", type: "text" }],
    records: [],
  };
  return { tables: [...doc.tables, table], activeTableId: id };
}

/** Rename a table. No-op (same reference) when the name is unchanged,
 *  empty after trim, or would collide with another table. */
export function renameTable(
  doc: BaseDocument,
  tableId: string,
  name: string,
): BaseDocument {
  const trimmed = name.trim();
  if (trimmed === "") return doc;
  const target = doc.tables.find((t) => t.id === tableId);
  if (!target || target.name === trimmed) return doc;
  if (doc.tables.some((t) => t.id !== tableId && t.name === trimmed)) {
    return doc;
  }
  return {
    ...doc,
    tables: doc.tables.map((t) =>
      t.id === tableId ? { ...t, name: trimmed } : t,
    ),
  };
}

/**
 * Delete a table. Refuses to delete the last remaining table (a base
 * must always have at least one). Also scrubs every other table's
 * `linked_record` fields that targeted the deleted table:
 *   - the field's `linkedTableId` pointer is cleared (so it falls back
 *     to same-table behaviour rather than dangling), and
 *   - every record's stored link ids for that field are emptied (the
 *     target records no longer exist).
 * When the active table is removed, the selection moves to the
 * preceding table.
 */
export function removeTable(doc: BaseDocument, tableId: string): BaseDocument {
  if (doc.tables.length <= 1) return doc;
  const idx = doc.tables.findIndex((t) => t.id === tableId);
  if (idx === -1) return doc;
  const remaining = doc.tables.filter((t) => t.id !== tableId);
  const scrubbed = remaining.map((t) => scrubLinksToTable(t, tableId));
  const activeTableId =
    doc.activeTableId === tableId
      ? (doc.tables[idx - 1] ?? remaining[0]).id
      : doc.activeTableId;
  // `doc.tables[idx - 1]` is `undefined` when idx===0, so the fallback
  // resolves to `remaining[0]` (which excludes the removed table by
  // construction). This guard is purely defensive against an
  // activeTableId that somehow points at a scrubbed table.
  const safeActive = scrubbed.some((t) => t.id === activeTableId)
    ? activeTableId
    : scrubbed[0].id;
  return { tables: scrubbed, activeTableId: safeActive };
}

/** Switch the active table. No-op when already active or unknown. */
export function setActiveTable(
  doc: BaseDocument,
  tableId: string,
): BaseDocument {
  if (doc.activeTableId === tableId) return doc;
  if (!doc.tables.some((t) => t.id === tableId)) return doc;
  return { ...doc, activeTableId: tableId };
}

/**
 * Clear `linked_record` fields in `table` that point at `deletedTableId`:
 * unset their `linkedTableId` and empty their per-record link arrays.
 *
 * Also resets any `rollup` / `lookup` field that *follows* one of those
 * scrubbed links: its `targetField` named a column that lived in the
 * now-deleted table, so we clear `targetField` to return the field to
 * its unconfigured "—" state. (The `linkedField` reference survives —
 * the link itself still exists, silently degrading to a same-table
 * link — so only the dangling target column is stripped, prompting the
 * user to repoint it rather than aggregating a phantom column.)
 *
 * Returns the same reference when nothing referenced the table.
 */
function scrubLinksToTable(
  table: BaseTable,
  deletedTableId: string,
): BaseTable {
  const affected = table.fields.filter(
    (f) => f.type === "linked_record" && f.linkedTableId === deletedTableId,
  );
  if (affected.length === 0) return table;
  const affectedNames = new Set(affected.map((f) => f.name));
  const fields = table.fields.map((f) => {
    if (affectedNames.has(f.name)) return stripLinkedTableId(f);
    if (
      (f.type === "rollup" || f.type === "lookup") &&
      f.linkedField !== undefined &&
      affectedNames.has(f.linkedField) &&
      f.targetField !== undefined
    ) {
      return stripTargetField(f);
    }
    return f;
  });
  const records: BaseRecord[] = table.records.map((r) => {
    let next: BaseRecord | null = null;
    for (const name of affectedNames) {
      if (Array.isArray(r[name]) && (r[name] as unknown[]).length > 0) {
        if (next === null) next = { ...r };
        next[name] = [];
      }
    }
    return next ?? r;
  });
  return { ...table, fields, records };
}

function stripLinkedTableId(field: BaseField): BaseField {
  if (field.linkedTableId === undefined) return field;
  const next = { ...field };
  delete next.linkedTableId;
  return next;
}

function stripTargetField(field: BaseField): BaseField {
  if (field.targetField === undefined) return field;
  const next = { ...field };
  delete next.targetField;
  return next;
}

/**
 * Resolve the records a `linked_record` field links into, given the
 * field, the active table (for same-table links), and a table
 * resolver. When `linkedTableId` is set and resolvable, returns the
 * target table's records; when it's set but unresolvable (table
 * deleted), returns `[]`; when absent, returns `sameTableRecords`
 * (the original single-table behaviour).
 */
export function linkTargetRecords(
  field: BaseField,
  sameTableRecords: BaseRecord[],
  resolver?: BaseTableResolver,
): BaseRecord[] {
  if (field.linkedTableId && resolver) {
    return resolver(field.linkedTableId)?.records ?? [];
  }
  if (field.linkedTableId && !resolver) {
    // A cross-table link with no resolver available — we genuinely
    // can't see the target table, so degrade to empty rather than
    // resolving against the wrong (same) table.
    return [];
  }
  return sameTableRecords;
}

/**
 * Resolve the fields of the table a `linked_record` field targets,
 * used by the field-config UI to offer the right `targetField` /
 * `linkedDisplayField` choices. Same fallback semantics as
 * {@link linkTargetRecords}.
 */
export function linkTargetFields(
  field: BaseField,
  sameTableFields: BaseField[],
  resolver?: BaseTableResolver,
): BaseField[] {
  if (field.linkedTableId && resolver) {
    return resolver(field.linkedTableId)?.fields ?? [];
  }
  if (field.linkedTableId && !resolver) return [];
  return sameTableFields;
}
