import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import KanbanView from "./baseviews/KanbanView";
import CalendarView from "./baseviews/CalendarView";
import TimelineView from "./baseviews/TimelineView";
import GalleryView from "./baseviews/GalleryView";
import FormView from "./baseviews/FormView";
import BaseAiAssistant from "./BaseAiAssistant";
import {
  defaultViewConfig,
  GRID_ROW_HEIGHTS,
  type BaseViewConfig,
  type BaseViewKind,
  type BaseViewProps,
  type GridRowHeight,
} from "./baseviews/types";
import {
  buildGroups,
  rowColor,
  clampFrozenCount,
  frozenLeftOffsets,
  FROZEN_COL_WIDTH,
} from "./baseGridHelpers";
import {
  makeRecordId,
  resolveLinkedRecords,
  aggregateValues,
  lookupValues,
  computeAutoNumber,
  isReservedFieldName,
  matchesFilter,
  applyFieldRename,
  isComputedFieldType,
  VIEW_CONFIG_FIELD_POINTERS,
} from "./baseEditorHelpers";
import {
  parseBaseDocument,
  serializeBaseDocument,
  getActiveTable,
  updateActiveTable,
  setActiveTable,
  addTable,
  removeTable,
  renameTable,
  makeTableResolver,
  linkTargetRecords,
  type BaseTableResolver,
} from "./baseDocumentHelpers";
import {
  withCreatedMeta,
  touchModified,
  stampImportedMeta,
  formatTimestamp,
  addComment,
  removeComment,
  getComments,
} from "./baseRecordMeta";
import {
  evaluateBaseFormula,
  formatFormulaResult,
  renameFieldInFormula,
} from "./baseFormulaEngine";
import {
  exportBaseCsv,
  exportBaseJson,
  formatValueForCsv,
  parseCsvToBase,
  parseJsonToBase,
} from "./baseImportExport";
import type {
  BaseField,
  BaseContent,
  BaseDocument,
  BaseRecord,
  BaseTable,
  FieldType,
  RollupAggregation,
} from "./baseEditorTypes";
import {
  RECORD_CREATED_KEY,
  RECORD_MODIFIED_KEY,
} from "./baseEditorTypes";
import { useVirtualRows } from "../hooks/useVirtualRows";

export type { FieldType, BaseField, BaseContent, BaseRecord } from "./baseEditorTypes";
export type { BaseViewConfig, BaseViewKind } from "./baseviews/types";

/**
 * Record count at or above which the grid view virtualizes its body
 * (only the rows intersecting the viewport are committed to the DOM).
 * Mirrors the Sheet grid's threshold: well under the 10K+ target so
 * large bases always window, and well over any realistic small base
 * so the common case keeps its exact prior full-render path.
 */
const VIRTUALIZE_ROW_THRESHOLD = 1000;

interface BaseEditorProps {
  content: string;
  onSave: (content: string) => void;
  /** See SheetEditor.onDraftChange — published synchronously on every edit. */
  onDraftChange?: (content: string) => void;
  autoSaveMs?: number;
}

export default function BaseEditor({
  content,
  onSave,
  onDraftChange,
  autoSaveMs = 2000,
}: BaseEditorProps) {
  // Both `data` and `viewConfig` need the *same* one-shot parse of
  // `content` at mount time. Calling `parseBaseContent` twice would
  // (a) waste a JSON.parse pass and (b) — more importantly — re-mint
  // a second set of random record IDs that we immediately throw
  // away, making the editor's view of "the records" diverge from
  // the IDs we briefly handed to defaultViewConfig. React guarantees
  // `data` is initialized before the next `useState` call runs, so
  // we can pass the initial data forward through the closure of
  // `viewConfig`'s initializer — a single shared parse, no render-
  // phase ref mutation, no double-invoke surprises under React
  // Strict Mode.
  // The base is a multi-table document. A single-table base parses
  // into a one-table document and serializes back to the legacy
  // `{ fields, records }` shape (see `baseDocumentHelpers`), so
  // existing artifacts and the Rust export path are byte-compatible
  // until the user adds a second table.
  const [doc, setDoc] = useState<BaseDocument>(() =>
    parseBaseDocument(content),
  );
  // `data` is the active table viewed as a plain `BaseContent`, so the
  // entire existing single-table render path below keeps working
  // unchanged. Its identity is stable per `doc`, matching the old
  // `setData` cadence (so downstream `useMemo`s keyed on `data.records`
  // / `data.fields` invalidate exactly when the active table changes).
  const activeTable = useMemo(() => getActiveTable(doc), [doc]);
  const data: BaseContent = activeTable;
  // Resolver used by the cross-table-aware cells / exporters to follow
  // `linked_record.linkedTableId` into another table.
  const tableResolver = useMemo<BaseTableResolver>(
    () => makeTableResolver(doc),
    [doc],
  );
  // Latest-doc ref so `updateData` can fold a new active-table
  // `BaseContent` back into the document without taking `doc` as a
  // dependency (keeping the callback identity-stable like the old
  // `setData`-based version).
  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [showAddField, setShowAddField] = useState(false);
  // Bulk-select state: a Set of record ids the user has ticked. The
  // header checkbox toggles all *currently visible* (post-filter)
  // rows so a filter narrows what "select all" means without the
  // user re-clicking each one.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Field-management dialog state. Drives the "Manage Fields" modal
  // where the user can reorder rows (move-up / move-down) and rename
  // them in-place. Kept here rather than in a sibling component so a
  // future "delete" action can call back into `removeField`.
  const [showManageFields, setShowManageFields] = useState(false);
  const [showAiAssistant, setShowAiAssistant] = useState(false);
  // Collapsed grid groups, tracked by group key. Only consulted when
  // `gridGroupField` is set. Keys are group values from the CURRENT
  // group-by field, so this is cleared whenever the group-by field
  // changes or the active table switches (see `resetViewStateForTable`
  // and the group-by `<select>` handler) — otherwise a key like "Lead"
  // from the old field could leave an unrelated same-named group in the
  // new field unexpectedly collapsed.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  // Import dialogs surface CSV / JSON file pickers. We do NOT auto-
  // trigger from a hidden `<input type="file">` ref because tests
  // need to inject the file contents directly; instead a small modal
  // accepts a paste of the file body, with file-pick on top.
  const [importDialog, setImportDialog] = useState<
    "csv" | "json" | null
  >(null);
  // Keyed by record `id` AND field `name` (NOT by `BaseField` ref or
  // array index). The record id guards against shifting indices when
  // another record is deleted while the modal is open. The field
  // name guards against stale `BaseField` references when the field
  // is removed via ManageFields (`removeField`) while the modal is
  // open — storing a reference would otherwise let the modal render
  // against a field that no longer exists in `data.fields`, allowing
  // an edit to write back a key with no corresponding column.
  const [expandedCell, setExpandedCell] = useState<
    { recordId: string; fieldName: string } | null
  >(null);
  // Stable id of the record shown in the full expand-record modal (all
  // fields + activity/comments). Tracked by id (not index) so other
  // rows being added / removed / reordered never drift the target.
  const [expandedRecordId, setExpandedRecordId] = useState<string | null>(
    null,
  );
  // Active view kind plus per-view config (which field drives kanban
  // columns, which date drives the calendar, etc.). Both are
  // renderer concerns: they're NOT serialized into the artifact
  // JSON, so switching views never dirties the document.
  const [view, setView] = useState<BaseViewKind>("grid");
  // Initial viewConfig closes over the freshly-initialized `data`,
  // sharing the same one-shot parse — no second parseBaseContent
  // call, no ID drift.
  const [viewConfig, setViewConfig] = useState<BaseViewConfig>(() =>
    defaultViewConfig(data.fields),
  );
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef(content);

  const debouncedSave = useCallback(
    (updated: BaseDocument) => {
      const json = serializeBaseDocument(updated);
      onDraftChange?.(json);
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        lastSavedRef.current = json;
        onSave(json);
      }, autoSaveMs);
    },
    [onSave, onDraftChange, autoSaveMs],
  );

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  // If the record OR the field currently behind the expand modal
  // disappears (deleted in the grid, removed via ManageFields, or
  // replaced by an out-of-band content sync), drop `expandedCell`
  // to null. The render path already hides the modal in that case,
  // but the dangling state would otherwise force a `findIndex(...)`
  // -1 miss on every subsequent render until the user clicks Expand
  // again. We can't call setState during render — this is the
  // architecturally correct place for that cleanup. Watching both
  // `data.records` and `data.fields` ensures field-removal and
  // record-removal close the modal symmetrically.
  useEffect(() => {
    if (!expandedCell) return;
    const recordStillExists = data.records.some(
      (r) => r.id === expandedCell.recordId,
    );
    const fieldStillExists = data.fields.some(
      (f) => f.name === expandedCell.fieldName,
    );
    if (!recordStillExists || !fieldStillExists) {
      setExpandedCell(null);
    }
  }, [data.records, data.fields, expandedCell]);

  // Commit a whole-document change (table add/remove/rename/switch).
  // Updates `docRef.current` synchronously so a follow-up call within
  // the same tick sees the latest document.
  const updateDoc = useCallback(
    (nextDoc: BaseDocument) => {
      docRef.current = nextDoc;
      setDoc(nextDoc);
      debouncedSave(nextDoc);
    },
    [debouncedSave],
  );

  // Commit a change to the ACTIVE table's `{ fields, records }`. Folds
  // the new content into the document (preserving every other table)
  // and persists. Keeping this signature identical to the old
  // single-table `updateData` means the entire mutation surface below
  // (addField / removeField / updateCell / import / …) is unchanged.
  const updateData = useCallback(
    (updated: BaseContent) => {
      updateDoc(updateActiveTable(docRef.current, updated));
    },
    [updateDoc],
  );

  // Reset all field-name-keyed view state (sort / filter / selection /
  // per-view config) to match a freshly-activated table. Used by every
  // table-switch path: the active table's columns differ, so retaining
  // the old sort field, filter inputs, selection ids, or viewConfig
  // pointers would dangle against a schema that no longer has them.
  const resetViewStateForTable = useCallback((table: BaseTable) => {
    setSortField(null);
    setSortDir("asc");
    setFilters({});
    setSelectedIds(new Set());
    setExpandedCell(null);
    setCollapsedGroups(new Set());
    setViewConfig(defaultViewConfig(table.fields));
  }, []);

  const handleSwitchTable = useCallback(
    (tableId: string) => {
      if (tableId === docRef.current.activeTableId) return;
      const nextDoc = setActiveTable(docRef.current, tableId);
      updateDoc(nextDoc);
      resetViewStateForTable(getActiveTable(nextDoc));
    },
    [updateDoc, resetViewStateForTable],
  );

  const handleAddTable = useCallback(() => {
    const nextDoc = addTable(docRef.current);
    updateDoc(nextDoc);
    resetViewStateForTable(getActiveTable(nextDoc));
  }, [updateDoc, resetViewStateForTable]);

  const handleRenameTable = useCallback(
    (tableId: string, name: string) => {
      updateDoc(renameTable(docRef.current, tableId, name));
    },
    [updateDoc],
  );

  const handleRemoveTable = useCallback(
    (tableId: string) => {
      const prev = docRef.current;
      // The document model guarantees at least one table; `removeTable`
      // no-ops on the last one. Guard here too so the UI never offers a
      // delete that would empty the base.
      if (prev.tables.length <= 1) return;
      const nextDoc = removeTable(prev, tableId);
      updateDoc(nextDoc);
      // Removing the active table moves activeId; always re-sync view
      // state to whatever table is active afterwards.
      resetViewStateForTable(getActiveTable(nextDoc));
    },
    [updateDoc, resetViewStateForTable],
  );

  const addField = useCallback(
    (field: BaseField) => {
      // Defense in depth: the AddFieldDialog also rejects these,
      // but we re-check here so any future programmatic caller can't
      // shadow `id` (the record-identifier key linked_record /
      // rollup / lookup all depend on) or another existing field.
      if (isReservedFieldName(field.name)) return;
      if (data.fields.some((f) => f.name === field.name)) return;
      const updated: BaseContent = {
        fields: [...data.fields, field],
        records: data.records.map((r) => ({
          ...r,
          [field.name]: getDefaultValue(field.type),
        })),
      };
      updateData(updated);
      setShowAddField(false);
    },
    [data, updateData],
  );

  // ── AI assistant apply paths ──────────────────────────────────────
  // All AI output is parsed + validated in baseAiHelpers BEFORE it
  // reaches these callbacks; they perform the same reserved-name /
  // duplicate-name guards as the manual `addField` path so a model
  // suggestion can never shadow `id` or collide with an existing
  // column.

  // Append a batch of already-validated fields to the active table,
  // skipping reserved or duplicate names (deduped within the batch
  // too). Each new field is seeded across existing records with its
  // type's default value, mirroring `addField`.
  const addFields = useCallback(
    (fields: BaseField[]) => {
      const existing = new Set(data.fields.map((f) => f.name));
      const accepted: BaseField[] = [];
      for (const f of fields) {
        if (isReservedFieldName(f.name)) continue;
        if (existing.has(f.name)) continue;
        existing.add(f.name);
        accepted.push(f);
      }
      if (accepted.length === 0) return;
      const updated: BaseContent = {
        fields: [...data.fields, ...accepted],
        records: data.records.map((r) => {
          const next = { ...r };
          for (const f of accepted) next[f.name] = getDefaultValue(f.type);
          return next;
        }),
      };
      updateData(updated);
    },
    [data, updateData],
  );

  // Create a brand-new table from an AI schema suggestion and switch
  // to it. Reuses the document helpers so single→multi-table
  // promotion + serialization stay consistent.
  const createTableWithFields = useCallback(
    (name: string, fields: BaseField[]) => {
      const cleaned: BaseField[] = [];
      const seen = new Set<string>();
      for (const f of fields) {
        if (isReservedFieldName(f.name) || seen.has(f.name)) continue;
        seen.add(f.name);
        cleaned.push(f);
      }
      if (cleaned.length === 0) return;
      const withTable = addTable(docRef.current, name);
      const newTableId = withTable.activeTableId;
      const populated = withTable.tables.map((t) =>
        t.id === newTableId ? { ...t, fields: cleaned, records: [] } : t,
      );
      const nextDoc = { ...withTable, tables: populated };
      updateDoc(nextDoc);
      resetViewStateForTable(getActiveTable(nextDoc));
    },
    [updateDoc, resetViewStateForTable],
  );

  // Apply AI column-fill results: a map of recordId → value for one
  // field. Only records still present are touched; `touchModified`
  // keeps `modified_time` honest. Returns silently when nothing
  // applies (e.g. every target row was deleted mid-generation).
  const applyCellValues = useCallback(
    (fieldName: string, values: Map<string, unknown>) => {
      if (values.size === 0) return;
      if (!data.fields.some((f) => f.name === fieldName)) return;
      const updated: BaseContent = {
        ...data,
        records: data.records.map((r) =>
          values.has(r.id)
            ? touchModified({ ...r, [fieldName]: values.get(r.id) })
            : r,
        ),
      };
      updateData(updated);
    },
    [data, updateData],
  );

  // Drop sort / filter / view-config pointers that reference fields
  // the current schema doesn't have — used after `removeField`,
  // `handleImportCsv`, and `handleImportJson`. Without this, deleting
  // the field currently used for `sortField` / `kanbanGroupField` /
  // `calendarDateField` leaves the view-config pointing at a name
  // that no longer exists; `filteredAndSorted` tolerates the stale
  // state by skipping the sort, but Kanban / Calendar / Timeline /
  // Gallery silently render empty because they look up
  // `fields.find((f) => f.name === config.kanbanGroupField)` and
  // miss. Devin Review on PR #79 flagged the sort+filter half in
  // round 3, the viewConfig half in round 4, and the
  // `removeField`-doesn't-call-this gap in round 7 — so a single
  // shared helper now owns the entire cleanup and stays symmetric
  // with `renameField`'s pointer-rewrite list. Defined ahead of
  // `removeField` so the `useCallback` dependency array can capture
  // it without hitting TDZ.
  const dropStaleViewState = useCallback((nextFields: BaseField[]) => {
    // Each setter is independent React state, so we read the latest
    // value via the functional-updater signature and run the same
    // prune logic the helper centralises. We can't call
    // `pruneViewStateAgainstFields` once for all three because the
    // three `prev` values live in separate `useState` slots — but the
    // helper still lives in `baseEditorHelpers` (and is unit-tested
    // there) to document the contract, and `renameField` shares the
    // `VIEW_CONFIG_FIELD_POINTERS` constant so both call sites stay
    // in lock-step when a new field-name pointer is added to
    // `BaseViewConfig`.
    const names = new Set(nextFields.map((f) => f.name));
    setSortField((prev) => (prev !== null && !names.has(prev) ? null : prev));
    setFilters((prev) => {
      let dirty = false;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (names.has(k)) {
          out[k] = v;
        } else {
          dirty = true;
        }
      }
      return dirty ? out : prev;
    });
    setViewConfig((prev) => {
      let dirty = false;
      const next: BaseViewConfig = { ...prev };
      for (const k of VIEW_CONFIG_FIELD_POINTERS) {
        const ref = prev[k];
        if (ref !== null && !names.has(ref)) {
          next[k] = null;
          dirty = true;
        }
      }
      return dirty ? next : prev;
    });
  }, []);

  // Sync external content prop changes (e.g., version restore).
  //
  // Hoisted *below* `dropStaleViewState` because the dependency array
  // captures it — referencing the `const` binding at render time before
  // its `useCallback` declaration would hit TDZ. Effects fire in
  // *commit-time* order regardless of declaration order, and this
  // effect doesn't depend on any sibling effects above, so the
  // out-of-place position has no functional consequence.
  useEffect(() => {
    if (content !== lastSavedRef.current) {
      const parsedDoc = parseBaseDocument(content);
      const parsed = getActiveTable(parsedDoc);
      docRef.current = parsedDoc;
      setDoc(parsedDoc);
      lastSavedRef.current = content;
      // Clear `selectedIds` whenever the records are replaced wholesale.
      // The selection is keyed by record id, but a version restore (or
      // any out-of-band content sync) swaps the entire record set —
      // any retained ids would either: (a) silently no-op the bulk
      // toolbar's "Delete N selected" with a misleading count visible
      // until next click, or (b) in the astronomically unlikely 16-hex
      // collision, delete a record the user never intended to select.
      // The expand-modal `expandedCell` is already cleared by another
      // effect for the same reason; do the same for the bulk selection
      // so the post-sync UI is consistent.
      setSelectedIds(new Set());
      // Drop stale view-state pointers (sort / filter / viewConfig) that
      // reference fields the restored schema no longer carries. The
      // grid render path *tolerates* dangling pointers — `sortFieldDef`
      // is undefined and the sort becomes a no-op, `filteredAndSorted`
      // skips missing fields — but the toolbar would still render the
      // stale sort indicator and a now-orphan filter input for a column
      // that doesn't exist any more. Doing this here matches what
      // `removeField` / `handleImportCsv` / `handleImportJson` already
      // do on the internal-mutation paths; the version-restore /
      // external-sync path is the last one that was missing it.
      // Devin Review PR #79 round 11 (ANALYSIS_…_0001) flagged the gap.
      dropStaleViewState(parsed.fields);
    }
  }, [content, dropStaleViewState]);

  const removeField = useCallback(
    (fieldName: string) => {
      // `id` is the stable record identifier; deleting it would
      // strip every record's id and orphan every linked_record
      // reference on the next save/reload cycle.
      if (isReservedFieldName(fieldName)) return;
      const nextFields = data.fields.filter((f) => f.name !== fieldName);
      const updated: BaseContent = {
        fields: nextFields,
        records: data.records.map((r) => {
          const copy = { ...r };
          delete copy[fieldName];
          return copy;
        }),
      };
      updateData(updated);
      // Drop any view-state pointers (sort, filter, kanbanGroup,
      // calendarDate, …) that referenced the deleted field. Routes
      // through the same shared cleanup the import flows use so
      // `removeField`, `handleImportCsv`, and `handleImportJson` stay
      // perfectly symmetric. The column-header `×` button (also
      // wired to `removeField`) inherits the same fix for free.
      dropStaleViewState(nextFields);
    },
    [data, updateData, dropStaleViewState],
  );

  // Move a field one slot up or down in `data.fields`. The grid /
  // gallery / kanban / calendar all iterate `data.fields` in order,
  // so this single ordering controls every view's column / chip /
  // cover-card layout. Records keep the same JSON keys — we never
  // reshape per-record data because field order is presentational.
  const reorderField = useCallback(
    (fieldName: string, direction: "up" | "down") => {
      const idx = data.fields.findIndex((f) => f.name === fieldName);
      if (idx < 0) return;
      const target = direction === "up" ? idx - 1 : idx + 1;
      if (target < 0 || target >= data.fields.length) return;
      const next = [...data.fields];
      [next[idx], next[target]] = [next[target], next[idx]];
      updateData({ ...data, fields: next });
    },
    [data, updateData],
  );

  // Rename a field in place. Renaming touches FIVE places that all
  // have to stay in lock-step. Skip any of them and the rename
  // silently breaks part of the editor:
  //   1. `data.fields[*].name` — the column label.
  //   2. Every `record[oldName]` JSON key → `record[newName]`.
  //   3. Any `linkedField` / `targetField` / `linkedDisplayField`
  //      / `formula` that references the old name. Without (3),
  //      a rollup pointing at "Price" would silently `#REF!` after
  //      the user renamed Price to Cost.
  //   4. UI state: `sortField` (the comparator reads `r[sortField]`,
  //      which becomes `undefined` after step 2 moves the value to
  //      the new key) and `filters` (the filter input is keyed by
  //      field name; the typed text would otherwise vanish even
  //      though the column still exists).
  //   5. Non-grid view state: `viewConfig` holds field-name pointers
  //      (`kanbanGroupField`, `calendarDateField`, …). Without
  //      patching them, Kanban / Calendar / Timeline / Gallery
  //      silently render empty because they call
  //      `fields.find((f) => f.name === config.kanbanGroupField)`
  //      and miss after the rename.
  const renameField = useCallback(
    (oldName: string, newName: string): { ok: true } | { error: string } => {
      const trimmed = newName.trim();
      if (trimmed === "") return { error: "Field name cannot be empty" };
      if (trimmed === oldName) return { ok: true };
      if (isReservedFieldName(trimmed)) {
        return { error: `"${trimmed}" is a reserved name` };
      }
      if (data.fields.some((f) => f.name === trimmed)) {
        return { error: `Field "${trimmed}" already exists` };
      }
      // Rewrite formula sources: replace `{oldName}` → `{newName}`
      // using the shared escape-aware scanner from `baseFormulaEngine`
      // so this in-place rewrite, `rewriteFieldRefs`, and
      // `extractFieldRefs` always agree on what counts as a reference.
      const renameFormula = (src: string | undefined): string | undefined =>
        renameFieldInFormula(src, oldName, trimmed);
      // Two passes per field, both delegating to shared helpers:
      //   (a) `applyFieldRename` rewrites `name` + `linkedField` /
      //       `targetField` / `linkedDisplayField` on every field,
      //       including the renamed field itself (a self-referential
      //       pointer is unusual but not impossible, and the rename
      //       contract is meant to be atomic).
      //   (b) `renameFormula` (a thin wrapper around
      //       `renameFieldInFormula`) rewrites the field's `formula`
      //       source using the same escape-aware token scanner the
      //       evaluator and dep-graph use, so the three paths can
      //       never disagree on what counts as a `{FieldName}`
      //       reference.
      // Both helpers preserve referential identity when nothing
      // changed, so React skips reconciling unchanged fields.
      const nextFields: BaseField[] = data.fields.map((f) => {
        const renamed = applyFieldRename(f, oldName, trimmed);
        if (!renamed.formula) return renamed;
        const rewritten = renameFormula(renamed.formula);
        if (rewritten === renamed.formula) return renamed;
        return { ...renamed, formula: rewritten };
      });
      const nextRecords: BaseRecord[] = data.records.map((r) => {
        if (!(oldName in r)) return r;
        const { [oldName]: carried, ...rest } = r;
        return { ...rest, [trimmed]: carried } as BaseRecord;
      });
      updateData({ fields: nextFields, records: nextRecords });
      // (4) Sort + filter state.
      setSortField((prev) => (prev === oldName ? trimmed : prev));
      setFilters((prev) => {
        if (!(oldName in prev)) return prev;
        const { [oldName]: carriedFilter, ...rest } = prev;
        return { ...rest, [trimmed]: carriedFilter };
      });
      // (5) Per-view configuration. Loop over the known field-name
      // pointers in BaseViewConfig (centralised in
      // `VIEW_CONFIG_FIELD_POINTERS`) so adding a new view (e.g. a
      // "color by" pointer) only needs the field listed once and both
      // rename + import paths pick it up. Bail out with the same
      // reference if nothing changed so React skips the re-render.
      setViewConfig((prev) => {
        let dirty = false;
        const next: BaseViewConfig = { ...prev };
        for (const k of VIEW_CONFIG_FIELD_POINTERS) {
          if (prev[k] === oldName) {
            next[k] = trimmed;
            dirty = true;
          }
        }
        return dirty ? next : prev;
      });
      return { ok: true };
    },
    [data, updateData],
  );

  const addRecord = useCallback(() => {
    const record: BaseRecord = { id: makeRecordId() };
    for (const field of data.fields) {
      record[field.name] = getDefaultValue(field.type);
    }
    const updated: BaseContent = {
      ...data,
      // Stamp `__created` / `__modified` so the `created_time` /
      // `modified_time` field types have a value to render.
      records: [...data.records, withCreatedMeta(record)],
    };
    updateData(updated);
  }, [data, updateData]);

  // Used by Kanban ("+" button on a column header) and Calendar
  // (click an empty day) to add a record pre-populated with the
  // values that put it in the user-intended bucket / day.
  const addRecordWith = useCallback(
    (prefill: Record<string, unknown>) => {
      const record: BaseRecord = { id: makeRecordId() };
      for (const field of data.fields) {
        record[field.name] =
          field.name in prefill
            ? prefill[field.name]
            : getDefaultValue(field.type);
      }
      const updated: BaseContent = {
        ...data,
        records: [...data.records, withCreatedMeta(record)],
      };
      updateData(updated);
    },
    [data, updateData],
  );

  const removeRecord = useCallback(
    (index: number) => {
      const removed = data.records[index];
      const removedId = removed?.id;
      // After dropping the target row, walk every remaining record
      // and strip the deleted id from any `linked_record` field that
      // still points at it. Without this pass the JSON we persist
      // carries dangling ids that re-render to empty chips but
      // silently inflate `rollup` / `lookup` counts if a future
      // record happens to be minted with the same id (16-hex
      // collisions are astronomically unlikely, but the cleanup is
      // also what makes "delete a record" reversible by re-adding
      // its id back).
      const linkedFields = data.fields.filter(
        (f) => f.type === "linked_record",
      );
      const survivors = data.records.filter((_, i) => i !== index);
      const cleaned =
        removedId && linkedFields.length > 0
          ? survivors.map((record) => {
              let next: BaseRecord | null = null;
              for (const field of linkedFields) {
                const v = record[field.name];
                if (!Array.isArray(v)) continue;
                if (!v.includes(removedId)) continue;
                if (next === null) next = { ...record };
                next[field.name] = (v as string[]).filter(
                  (id) => id !== removedId,
                );
              }
              return next ?? record;
            })
          : survivors;
      const updated: BaseContent = {
        ...data,
        records: cleaned,
      };
      updateData(updated);
      // Drop the deleted id from the selection set so a future
      // "Delete Selected" doesn't try to remove a phantom record.
      setSelectedIds((prev) => {
        if (!removedId || !prev.has(removedId)) return prev;
        const next = new Set(prev);
        next.delete(removedId);
        return next;
      });
    },
    [data, updateData],
  );

  // Comment mutations for the expand-record modal. Comments live in the
  // record's `__comments` metadata (see baseRecordMeta). Adding one
  // counts as activity on the record, so the helper also bumps
  // `__modified` (mirroring Airtable's "Last modified time").
  const handleAddComment = useCallback(
    (recordId: string, text: string, author: string) => {
      const trimmed = text.trim();
      if (trimmed === "") return;
      const cur = docRef.current;
      const table = getActiveTable(cur);
      const records = table.records.map((r) =>
        r.id === recordId ? addComment(r, author, trimmed) : r,
      );
      updateData({ ...table, records });
    },
    [updateData],
  );

  const handleRemoveComment = useCallback(
    (recordId: string, commentId: string) => {
      const cur = docRef.current;
      const table = getActiveTable(cur);
      const records = table.records.map((r) =>
        r.id === recordId ? removeComment(r, commentId) : r,
      );
      updateData({ ...table, records });
    },
    [updateData],
  );

  // Bulk delete every record in `selectedIds` *that is currently
  // visible* in the filtered + sorted view (the `removeSelectedRecords`
  // callback + the `visibleSelectedIds` selector are defined further
  // down once `filteredAndSorted` exists — they're declared near here
  // logically but TDZ-blocked until `filteredAndSorted` resolves).
  //
  // **Visibility scoping**: a previously-selected record that has
  // since been filtered out is excluded from the delete so the user
  // can't accidentally erase data they can't see. This matches the
  // header "Select all visible records" intent (selection is scoped
  // to the visible view; bulk delete is symmetric). Hidden ids stay
  // in `selectedIds` so reselecting the filter that brought them
  // back keeps them highlighted. See Devin Review PR #79 round 9
  // (ANALYSIS_…_0004).

  // Export the current Base to a downloadable file. In a browser the
  // Blob/anchor dance is the canonical way to trigger a save without
  // a backend. Tests bypass this entirely via `exportBaseCsv` /
  // `exportBaseJson` on the helper, which is why this stays a thin
  // wrapper.
  const triggerDownload = useCallback(
    (filename: string, body: string, mime: string) => {
      const blob = new Blob([body], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    [],
  );

  const handleExportCsv = useCallback(() => {
    triggerDownload(
      "base.csv",
      // Pass the resolver so cross-table linked/rollup/lookup columns
      // render the target table's display values, not blanks.
      exportBaseCsv(data, tableResolver),
      "text/csv;charset=utf-8",
    );
  }, [data, tableResolver, triggerDownload]);

  const handleExportJson = useCallback(() => {
    triggerDownload(
      "base.json",
      exportBaseJson(data),
      "application/json;charset=utf-8",
    );
  }, [data, triggerDownload]);

  // Importing replaces the entire base content. The dialog confirms
  // before doing so for any non-empty existing base, but the action
  // itself is `updateData` — same debounced-save path as everything
  // else, so undo via version restore still works.
  const handleImportCsv = useCallback(
    (text: string) => {
      // Reuse the *current* fields as a schema so column types are
      // recovered for a re-import of an exported CSV.
      const next = parseCsvToBase(text, data.fields);
      // Stamp `__created` / `__modified` at import time so the
      // created_time / modified_time field types show the import
      // moment (like Airtable) rather than "—" until the first edit.
      // CSV never carries intrinsic metadata, so every row is stamped.
      updateData({ ...next, records: stampImportedMeta(next.records) });
      setImportDialog(null);
      setSelectedIds(new Set());
      dropStaleViewState(next.fields);
    },
    [data.fields, updateData, dropStaleViewState],
  );

  const handleImportJson = useCallback(
    (text: string) => {
      const next = parseJsonToBase(text);
      // Same import-time stamping as CSV. `stampImportedMeta` preserves
      // any `__created` a canonical-shape Tessera JSON round-trip
      // carries, and only stamps rows that lack one (bare arrays / 3rd
      // party files), so a re-import keeps the original creation time.
      updateData({ ...next, records: stampImportedMeta(next.records) });
      setImportDialog(null);
      setSelectedIds(new Set());
      dropStaleViewState(next.fields);
    },
    [updateData, dropStaleViewState],
  );

  const updateCell = useCallback(
    (recordIndex: number, fieldName: string, value: unknown) => {
      const updated: BaseContent = {
        ...data,
        records: data.records.map((r, i) =>
          // `touchModified` refreshes `__modified` (and backfills a
          // missing `__created`) so the `modified_time` field type
          // reflects the edit.
          i === recordIndex
            ? touchModified({ ...r, [fieldName]: value })
            : r,
        ),
      };
      updateData(updated);
    },
    [data, updateData],
  );

  const handleSort = (fieldName: string) => {
    if (sortField === fieldName) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(fieldName);
      setSortDir("asc");
    }
  };

  const filteredAndSorted = useMemo(() => {
    let records = [...data.records];

    // Display-string cache — Devin Review PR #82 round 7
    // ANALYSIS_…_0004. `formatValueForCsv` materialises a formula /
    // rollup / lookup / auto_number result for one (field, record)
    // pair. For `formula` that means evaluating the whole expression
    // (tokenize → parse → walk), which is the expensive case. The
    // previous shape called it inside the filter loop once per
    // computed-field filter row, AND twice per comparator step inside
    // the sort, so a base with N records / M computed filters /
    // a computed sort key paid O((M + log N) · N) evaluations per
    // render. With this cache, every (record, field) pair is computed
    // at most once per render. The cache is sound for the whole
    // `useMemo` because:
    //   1. `data.records` / `data.fields` are captured at the top
    //      and don't mutate mid-render.
    //   2. We key by `(record.id, field.name)` — both stable strings
    //      (record ids are unique by contract, field names are
    //      unique within the schema).
    //   3. `formatValueForCsv` is a pure function of those four
    //      arguments, so identical keys map to identical outputs.
    // Note that we always pass `data.records` (the FULL set) as the
    // third arg so cross-record references (linked_record / rollup /
    // lookup) resolve against the unfiltered population — exactly
    // matching the cell render path, which is the visual the user
    // is filtering against.
    const displayCache = new Map<string, Map<string, string>>();
    const getDisplay = (
      field: BaseField,
      record: BaseRecord,
    ): string => {
      let perRecord = displayCache.get(record.id);
      if (perRecord === undefined) {
        perRecord = new Map<string, string>();
        displayCache.set(record.id, perRecord);
      }
      const cached = perRecord.get(field.name);
      if (cached !== undefined) return cached;
      // `created_time` / `modified_time` must filter + sort against the
      // SAME locale-formatted string the cell shows (e.g. "Jan 1, 2024"),
      // not the raw ISO that `formatValueForCsv` emits for export — else
      // typing "Jan" in the column filter matches nothing. Mirror
      // `TimestampCell` exactly.
      let value: string;
      if (field.type === "created_time" || field.type === "modified_time") {
        const iso =
          record[
            field.type === "created_time"
              ? RECORD_CREATED_KEY
              : RECORD_MODIFIED_KEY
          ];
        value = formatTimestamp(iso, field.dateIncludeTime === true);
      } else {
        value = formatValueForCsv(
          field,
          record,
          data.records,
          data.fields,
          tableResolver,
        );
      }
      perRecord.set(field.name, value);
      return value;
    };

    // Apply per-field filters via the type-aware matcher.
    // Computed types (formula / rollup / lookup / auto_number)
    // need a rendered display string — their stored value is
    // either a source expression (`formula`) or `null`
    // (`auto_number`), so comparing it directly would always
    // miss. `getDisplay` returns the same string the cell renders,
    // memoised across the whole filter+sort pipeline so the second
    // computed-field filter row (and the sort comparator below) hit
    // the cache rather than re-evaluating each formula.
    for (const [fieldName, filterVal] of Object.entries(filters)) {
      if (!filterVal.trim()) continue;
      const field = data.fields.find((f) => f.name === fieldName);
      if (!field) continue;
      records = records.filter((r) => {
        const display = isComputedFieldType(field.type)
          ? getDisplay(field, r)
          : undefined;
        return matchesFilter(field.type, r[fieldName], filterVal, display);
      });
    }

    // Apply sort. For computed types we compare the **display**
    // string (same one the cell renders) — a sort on an
    // `auto_number` column would otherwise be a no-op because the
    // stored value is `null` for every record. Numeric-aware
    // locale-compare keeps "10" after "2" for plain numeric
    // columns and also makes "1", "2", …, "10" sort correctly on
    // computed columns whose display happens to be numeric.
    //
    // EXCEPTION: `created_time` / `modified_time` must sort
    // CHRONOLOGICALLY, but their display string is a locale date
    // ("Jan 15, 2024") that `localeCompare` would order
    // alphabetically ("Apr" < "Jan"). Sort those on the raw ISO
    // timestamp instead, which is lexicographically chronological by
    // construction. The filter path above still uses the locale
    // display so typing "Jan" matches the cell text.
    if (sortField) {
      const sortFieldDef = data.fields.find((f) => f.name === sortField);
      const sortIsComputed =
        sortFieldDef !== undefined && isComputedFieldType(sortFieldDef.type);
      const sortIsTimestamp =
        sortFieldDef !== undefined &&
        (sortFieldDef.type === "created_time" ||
          sortFieldDef.type === "modified_time");
      const displayFor = (r: BaseRecord): string => {
        if (sortIsTimestamp && sortFieldDef) {
          const iso =
            r[
              sortFieldDef.type === "created_time"
                ? RECORD_CREATED_KEY
                : RECORD_MODIFIED_KEY
            ];
          return typeof iso === "string" ? iso : "";
        }
        if (sortIsComputed && sortFieldDef) {
          return getDisplay(sortFieldDef, r);
        }
        const raw = r[sortField];
        return raw == null ? "" : String(raw);
      };
      records.sort((a, b) => {
        const va = displayFor(a);
        const vb = displayFor(b);
        const cmp = va.localeCompare(vb, undefined, {
          numeric: true,
        });
        return sortDir === "asc" ? cmp : -cmp;
      });
    }

    return records;
  }, [data.records, data.fields, filters, sortField, sortDir, tableResolver]);

  // See the visibility-scoping commentary higher up — this is the
  // implementation half. `visibleSelectedIds` is the intersection of
  // `selectedIds` and the currently-visible filtered+sorted view;
  // `removeSelectedRecords` deletes only those and drops them from
  // the selection set, leaving any hidden ids alone so they reappear
  // selected when the filter changes back.
  const visibleSelectedIds = useMemo(() => {
    const out = new Set<string>();
    for (const record of filteredAndSorted) {
      if (selectedIds.has(record.id)) out.add(record.id);
    }
    return out;
  }, [filteredAndSorted, selectedIds]);

  const removeSelectedRecords = useCallback(() => {
    if (visibleSelectedIds.size === 0) return;
    const toRemove = visibleSelectedIds;
    const linkedFields = data.fields.filter(
      (f) => f.type === "linked_record",
    );
    const survivors = data.records.filter((r) => !toRemove.has(r.id));
    const cleaned =
      linkedFields.length > 0
        ? survivors.map((record) => {
            let next: BaseRecord | null = null;
            for (const field of linkedFields) {
              const v = record[field.name];
              if (!Array.isArray(v)) continue;
              const filtered = (v as string[]).filter(
                (id) => !toRemove.has(id),
              );
              if (filtered.length === v.length) continue;
              if (next === null) next = { ...record };
              next[field.name] = filtered;
            }
            return next ?? record;
          })
        : survivors;
    updateData({ ...data, records: cleaned });
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of toRemove) next.delete(id);
      return next;
    });
  }, [data, visibleSelectedIds, updateData]);

  // Pre-built `id → original index` map so the grid row render is
  // O(1) per row instead of O(n) via `data.records.indexOf(record)`.
  // Brute-force `indexOf` made the grid render O(n²) in the number of
  // records — negligible for typical bases, but a clear bottleneck
  // at scale (10k records => 10^8 ops on every keystroke). Lifting
  // it into its own memo keyed on `data.records` means we only
  // rebuild the map when records add/remove/reorder, not on every
  // filter/sort/edit. Keyed by `record.id` (not by object reference)
  // so any code path that reconstructs the record object (e.g. JSON
  // round-trip in tests) still resolves to the original position.
  const recordIndexById = useMemo(() => {
    const m = new Map<string, number>();
    data.records.forEach((r, i) => m.set(r.id, i));
    return m;
  }, [data.records]);

  // ── grid row virtualization ───────────────────────────────────
  // Large bases (10K+ records) blow up the DOM if every row renders;
  // window the grid body to the rows near the viewport. The hook
  // reports the full range with zero padding when disabled, so small
  // bases — and every existing test — keep the prior full render.
  const gridScrollRef = useRef<HTMLDivElement>(null);

  // ── grid display knobs (row height / group / color / frozen) ──────
  // All persisted in `viewConfig`. Each is re-validated against the
  // live schema so a pointer to a deleted field degrades gracefully
  // (dropStaleViewState also prunes these, but a defensive re-check
  // here keeps the grid correct even mid-edit).
  const gridRowHeightPx =
    GRID_ROW_HEIGHTS[viewConfig.gridRowHeight] ?? GRID_ROW_HEIGHTS.short;
  const gridGroupField =
    viewConfig.gridGroupField &&
    data.fields.some((f) => f.name === viewConfig.gridGroupField)
      ? viewConfig.gridGroupField
      : null;
  const gridColorField =
    viewConfig.gridColorField &&
    data.fields.some((f) => f.name === viewConfig.gridColorField)
      ? viewConfig.gridColorField
      : null;
  const frozenCount = clampFrozenCount(
    viewConfig.gridFrozenCount,
    data.fields.length,
  );
  const frozenOffsets = useMemo(
    () => frozenLeftOffsets(frozenCount),
    [frozenCount],
  );

  // Grouping interleaves non-uniform group-header rows, which breaks
  // the fixed-row-height windowing math — so virtualization is only
  // engaged for the flat (ungrouped) view. Grouped bases rely on
  // collapsing groups to bound the rendered row count instead.
  const virtualizeRows =
    filteredAndSorted.length >= VIRTUALIZE_ROW_THRESHOLD &&
    gridGroupField === null;
  const {
    startIndex: rowWindowStart,
    endIndex: rowWindowEnd,
    topPad: rowTopPad,
    bottomPad: rowBottomPad,
    onScroll: onGridScroll,
  } = useVirtualRows(gridScrollRef, {
    rowCount: filteredAndSorted.length,
    rowHeight: gridRowHeightPx,
    enabled: virtualizeRows,
  });

  type RowRenderItem =
    | { type: "row"; ri: number }
    | { type: "spacer"; key: string; height: number };
  const rowRenderPlan = useMemo<RowRenderItem[]>(() => {
    const plan: RowRenderItem[] = [];
    if (!virtualizeRows) {
      for (let i = 0; i < filteredAndSorted.length; i++) {
        plan.push({ type: "row", ri: i });
      }
      return plan;
    }
    if (rowTopPad > 0) {
      plan.push({ type: "spacer", key: "base-virtual-top-pad", height: rowTopPad });
    }
    for (let i = rowWindowStart; i <= rowWindowEnd; i++) {
      plan.push({ type: "row", ri: i });
    }
    if (rowBottomPad > 0) {
      plan.push({
        type: "spacer",
        key: "base-virtual-bottom-pad",
        height: rowBottomPad,
      });
    }
    return plan;
  }, [
    virtualizeRows,
    filteredAndSorted.length,
    rowTopPad,
    rowBottomPad,
    rowWindowStart,
    rowWindowEnd,
  ]);

  // Shared props passed to every non-grid view. The grid view stays
  // inline below because it has filter/sort behavior the others
  // don't need.
  const viewProps: BaseViewProps = {
    data,
    onUpdateCell: updateCell,
    onAddRecord: addRecord,
    onAddRecordWith: addRecordWith,
    onRemoveRecord: removeRecord,
    config: viewConfig,
    onConfigChange: setViewConfig,
  };

  // Sticky-positioning style for a frozen leading column. `colIndex`
  // is the index into `frozenOffsets` (0 = select, 1 = row-num,
  // 2.. = frozen data columns). Returns `undefined` when the column
  // isn't frozen, leaving the cell with its normal flow layout.
  const frozenCellStyle = (colIndex: number): React.CSSProperties | undefined => {
    if (frozenCount <= 0 || colIndex >= frozenOffsets.length) return undefined;
    const isLast = colIndex === frozenOffsets.length - 1;
    return {
      position: "sticky",
      left: frozenOffsets[colIndex],
      zIndex: 2,
      // Fixed width on frozen DATA columns (colIndex >= 2) so the
      // sticky offsets computed in `frozenLeftOffsets` stay accurate.
      ...(colIndex >= 2
        ? { width: FROZEN_COL_WIDTH, minWidth: FROZEN_COL_WIDTH }
        : {}),
      background: "var(--color-bg, #fff)",
      // A subtle divider on the last frozen column hints at the seam.
      ...(isLast
        ? { boxShadow: "1px 0 0 var(--color-border, #e5e7eb)" }
        : {}),
    };
  };

  // Render one data row. Shared by the flat and grouped grid bodies so
  // row height / color strip / frozen styling stay identical between
  // them. `displayNumber` is the 1-based row label shown in the
  // row-number column.
  const renderDataRow = (record: BaseRecord, displayNumber: number) => {
    // O(1) lookup via the pre-built `recordIndexById` map; falls back
    // to -1 if a row somehow leaks through with no id (legacy
    // hand-edited JSON), which `removeRecord` / `updateCell` tolerate.
    const originalIndex = recordIndexById.get(record.id) ?? -1;
    const isSelected = selectedIds.has(record.id);
    const stripColor = rowColor(record, gridColorField);
    return (
      <tr
        key={record.id || originalIndex}
        className={isSelected ? "base-row-selected" : undefined}
        style={{ height: gridRowHeightPx }}
      >
        <td
          className="base-select-cell"
          style={{ position: "relative", ...frozenCellStyle(0) }}
        >
          {/* Color strip sits inside the select cell's left edge so it
              reads as a per-row accent without adding a column. */}
          {stripColor && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: 4,
                background: stripColor,
              }}
            />
          )}
          <input
            type="checkbox"
            aria-label={`Select record ${displayNumber}`}
            checked={isSelected}
            onChange={(e) => {
              setSelectedIds((prev) => {
                const next = new Set(prev);
                if (e.target.checked) next.add(record.id);
                else next.delete(record.id);
                return next;
              });
            }}
          />
        </td>
        <td className="base-row-num" style={frozenCellStyle(1)}>
          {displayNumber}
        </td>
        {data.fields.map((field, fieldIdx) => {
          // Match by the same (recordId, fieldName) tuple the modal
          // uses so opening the modal on cell X locks that inline cell
          // while every other inline cell stays editable.
          const isExpanded =
            expandedCell !== null &&
            expandedCell.recordId === record.id &&
            expandedCell.fieldName === field.name;
          return (
            <td
              key={field.name}
              className="base-cell"
              style={frozenCellStyle(fieldIdx + 2)}
            >
              <CellInput
                field={field}
                value={record[field.name]}
                record={record}
                recordIndex={originalIndex}
                allRecords={data.records}
                allFields={data.fields}
                resolver={tableResolver}
                onChange={(val) => updateCell(originalIndex, field.name, val)}
                onExpand={() =>
                  setExpandedCell({
                    recordId: record.id,
                    fieldName: field.name,
                  })
                }
                isExpanded={isExpanded}
              />
            </td>
          );
        })}
        <td className="base-actions-cell">
          <button
            type="button"
            className="btn-sm"
            onClick={() => setExpandedRecordId(record.id)}
            title="Expand record"
            aria-label="Expand record"
          >
            ⤢
          </button>
          <button
            type="button"
            className="btn-sm danger"
            onClick={() => removeRecord(originalIndex)}
          >
            Del
          </button>
        </td>
      </tr>
    );
  };

  return (
    <div
      className="base-editor"
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
    >
      <TableTabs
        tables={doc.tables}
        activeTableId={doc.activeTableId}
        onSwitch={handleSwitchTable}
        onAdd={handleAddTable}
        onRename={handleRenameTable}
        onRemove={handleRemoveTable}
      />
      <div
        className="base-toolbar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.5rem",
          borderBottom: "1px solid var(--color-border, #e5e7eb)",
        }}
      >
        <button type="button" className="btn-sm" onClick={addRecord}>
          + Record
        </button>
        <button type="button" className="btn-sm" onClick={() => setShowAddField(true)}>
          + Field
        </button>
        <button
          type="button"
          className="btn-sm"
          onClick={() => setShowManageFields(true)}
        >
          Manage Fields
        </button>
        <button
          type="button"
          className="btn-sm"
          onClick={() => setShowAiAssistant(true)}
          title="AI assistant (on-device)"
        >
          ✦ AI
        </button>
        {visibleSelectedIds.size > 0 && (
          <button
            type="button"
            className="btn-sm danger"
            onClick={removeSelectedRecords}
            aria-label={`Delete ${visibleSelectedIds.size} selected`}
          >
            Delete {visibleSelectedIds.size} selected
          </button>
        )}
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: "1px",
            height: "1.25rem",
            background: "var(--color-border, #e5e7eb)",
            margin: "0 0.25rem",
          }}
        />
        <button
          type="button"
          className="btn-sm"
          onClick={handleExportCsv}
          title="Download all records as CSV"
        >
          Export CSV
        </button>
        <button
          type="button"
          className="btn-sm"
          onClick={handleExportJson}
          title="Download all records as JSON"
        >
          Export JSON
        </button>
        <button
          type="button"
          className="btn-sm"
          onClick={() => setImportDialog("csv")}
          title="Replace records with a CSV"
        >
          Import CSV
        </button>
        <button
          type="button"
          className="btn-sm"
          onClick={() => setImportDialog("json")}
          title="Replace records with a JSON"
        >
          Import JSON
        </button>
        <div style={{ flex: 1 }} />
        <div
          role="tablist"
          aria-label="Base view"
          style={{ display: "flex", gap: "0.25rem" }}
        >
          {(
            [
              ["grid", "Grid"],
              ["kanban", "Kanban"],
              ["calendar", "Calendar"],
              ["timeline", "Timeline"],
              ["gallery", "Gallery"],
              ["form", "Form"],
            ] as [BaseViewKind, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              className="btn-sm"
              onClick={() => setView(v)}
              style={{
                fontWeight: view === v ? 600 : 400,
                background:
                  view === v
                    ? "var(--color-primary-soft, #ede9fe)"
                    : "transparent",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {showAddField && (
        <AddFieldDialog
          existingFields={data.fields}
          tables={doc.tables}
          activeTableId={doc.activeTableId}
          onAdd={addField}
          onCancel={() => setShowAddField(false)}
        />
      )}

      {showManageFields && (
        <ManageFieldsDialog
          fields={data.fields}
          onRename={renameField}
          onReorder={reorderField}
          onRemove={removeField}
          onClose={() => setShowManageFields(false)}
        />
      )}

      {importDialog !== null && (
        <ImportDialog
          kind={importDialog}
          recordCount={data.records.length}
          onImport={importDialog === "csv" ? handleImportCsv : handleImportJson}
          onCancel={() => setImportDialog(null)}
        />
      )}

      {view === "kanban" && <KanbanView {...viewProps} />}
      {view === "calendar" && <CalendarView {...viewProps} />}
      {view === "timeline" && <TimelineView {...viewProps} />}
      {view === "gallery" && <GalleryView {...viewProps} />}
      {view === "form" && <FormView {...viewProps} />}

      {view === "grid" && (
      <>
      <div
        className="base-grid-options"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          flexWrap: "wrap",
          padding: "0.4rem 0.5rem",
          borderBottom: "1px solid var(--color-border, #e5e7eb)",
          fontSize: "0.8rem",
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
          Row height
          <select
            className="input"
            aria-label="Row height"
            value={viewConfig.gridRowHeight}
            onChange={(e) =>
              setViewConfig((prev) => ({
                ...prev,
                gridRowHeight: e.target.value as GridRowHeight,
              }))
            }
          >
            <option value="short">Short</option>
            <option value="medium">Medium</option>
            <option value="tall">Tall</option>
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
          Group by
          <select
            className="input"
            aria-label="Group by"
            value={viewConfig.gridGroupField ?? ""}
            onChange={(e) => {
              const next = e.target.value === "" ? null : e.target.value;
              // Group keys are scoped to the previous field's values, so
              // discard the old collapse set when the field changes (and
              // when grouping is turned off) to avoid stale, surprising
              // collapse state on a different field.
              if (next !== viewConfig.gridGroupField) {
                setCollapsedGroups(new Set());
              }
              setViewConfig((prev) => ({
                ...prev,
                gridGroupField: next,
              }));
            }}
          >
            <option value="">None</option>
            {data.fields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
          Color by
          <select
            className="input"
            aria-label="Color by"
            value={viewConfig.gridColorField ?? ""}
            onChange={(e) =>
              setViewConfig((prev) => ({
                ...prev,
                gridColorField: e.target.value === "" ? null : e.target.value,
              }))
            }
          >
            <option value="">None</option>
            {data.fields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
          Frozen
          <select
            className="input"
            aria-label="Frozen columns"
            value={String(frozenCount)}
            onChange={(e) =>
              setViewConfig((prev) => ({
                ...prev,
                gridFrozenCount: Number(e.target.value),
              }))
            }
          >
            <option value="0">0</option>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
          </select>
        </label>
      </div>
      <div
        className="base-grid-wrapper"
        ref={gridScrollRef}
        onScroll={onGridScroll}
        style={{ flex: 1, minHeight: 0, overflow: "auto" }}
      >
        <table className="base-grid">
          <thead>
            <tr>
              <th className="base-select-cell">
                {/* Select-all checks/unchecks every record currently
                    visible after the active filter, not every record
                    in the table — matches what a spreadsheet's
                    select-all-in-filter-view does. */}
                <input
                  type="checkbox"
                  aria-label="Select all visible records"
                  checked={
                    filteredAndSorted.length > 0 &&
                    filteredAndSorted.every((r) => selectedIds.has(r.id))
                  }
                  ref={(el) => {
                    if (!el) return;
                    const some = filteredAndSorted.some((r) =>
                      selectedIds.has(r.id),
                    );
                    const all =
                      filteredAndSorted.length > 0 &&
                      filteredAndSorted.every((r) => selectedIds.has(r.id));
                    el.indeterminate = some && !all;
                  }}
                  onChange={(e) => {
                    setSelectedIds((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) {
                        for (const r of filteredAndSorted) next.add(r.id);
                      } else {
                        for (const r of filteredAndSorted) next.delete(r.id);
                      }
                      return next;
                    });
                  }}
                />
              </th>
              <th className="base-row-num">#</th>
              {data.fields.map((field) => (
                <th key={field.name} className="base-col-header">
                  <div className="base-col-header-content">
                    <button
                      type="button"
                      className="base-col-sort"
                      onClick={() => handleSort(field.name)}
                    >
                      {field.name}
                      {sortField === field.name && (sortDir === "asc" ? " ▲" : " ▼")}
                    </button>
                    <span className="base-col-type">({field.type})</span>
                    <button
                      type="button"
                      className="base-col-remove"
                      onClick={() => removeField(field.name)}
                      title="Remove field"
                    >
                      x
                    </button>
                  </div>
                  <input
                    className="base-filter-input"
                    placeholder={filterPlaceholderForType(field.type)}
                    value={filters[field.name] ?? ""}
                    onChange={(e) =>
                      setFilters((prev) => ({ ...prev, [field.name]: e.target.value }))
                    }
                  />
                </th>
              ))}
              <th className="base-actions-header">Actions</th>
            </tr>
          </thead>
          <tbody>
            {gridGroupField === null
              ? // Flat (ungrouped) body — unchanged virtualized path.
                rowRenderPlan.map((item) => {
                  if (item.type === "spacer") {
                    return (
                      <tr
                        key={item.key}
                        data-testid={item.key}
                        aria-hidden="true"
                      >
                        <td
                          colSpan={data.fields.length + 3}
                          style={{
                            height: item.height,
                            padding: 0,
                            border: "none",
                          }}
                        />
                      </tr>
                    );
                  }
                  return renderDataRow(
                    filteredAndSorted[item.ri],
                    item.ri + 1,
                  );
                })
              : // Grouped body — collapsible group headers with a
                // continuous 1-based row numbering across groups.
                (() => {
                  const groups = buildGroups(filteredAndSorted, gridGroupField);
                  const rows: React.ReactNode[] = [];
                  let runningNumber = 0;
                  for (const group of groups) {
                    const collapsed = collapsedGroups.has(group.key);
                    const groupColor = rowColor(
                      group.records[0] ?? { id: "" },
                      gridColorField,
                    );
                    rows.push(
                      <tr
                        key={`group-${group.key}`}
                        className="base-group-header"
                        data-testid={`base-group-${group.key}`}
                      >
                        <td
                          colSpan={data.fields.length + 3}
                          style={{
                            background: "var(--color-bg-secondary, #f3f4f6)",
                            fontWeight: 600,
                            padding: "0.35rem 0.5rem",
                            borderTop: "1px solid var(--color-border, #e5e7eb)",
                          }}
                        >
                          <button
                            type="button"
                            className="btn-sm"
                            aria-expanded={!collapsed}
                            onClick={() =>
                              setCollapsedGroups((prev) => {
                                const next = new Set(prev);
                                if (next.has(group.key)) next.delete(group.key);
                                else next.add(group.key);
                                return next;
                              })
                            }
                            style={{ marginRight: "0.4rem" }}
                          >
                            {collapsed ? "▸" : "▾"}
                          </button>
                          {groupColor && (
                            <span
                              aria-hidden="true"
                              style={{
                                display: "inline-block",
                                width: 8,
                                height: 8,
                                borderRadius: 2,
                                background: groupColor,
                                marginRight: "0.4rem",
                              }}
                            />
                          )}
                          {group.label || "(all)"}
                          <span
                            style={{
                              marginLeft: "0.4rem",
                              fontWeight: 400,
                              color: "var(--color-text-secondary, #6b7280)",
                            }}
                          >
                            {group.records.length}
                          </span>
                        </td>
                      </tr>,
                    );
                    if (!collapsed) {
                      for (const record of group.records) {
                        runningNumber += 1;
                        rows.push(renderDataRow(record, runningNumber));
                      }
                    } else {
                      runningNumber += group.records.length;
                    }
                  }
                  return rows;
                })()}
          </tbody>
        </table>
      </div>
      </>
      )}

      {expandedCell && (() => {
        // Resolve the live record AND the live field by stable
        // identifiers on every render so deletes / reorderings of
        // OTHER records or fields don't drift the target.
        const expandedIndex = data.records.findIndex(
          (r) => r.id === expandedCell.recordId,
        );
        const expandedField = data.fields.find(
          (f) => f.name === expandedCell.fieldName,
        );
        if (expandedIndex === -1 || !expandedField) {
          // Target record or field was deleted out from under us —
          // close the modal silently rather than write to nothing.
          return null;
        }
        return (
          <LongTextModal
            field={expandedField}
            value={data.records[expandedIndex]?.[expandedField.name]}
            onChange={(val) =>
              updateCell(expandedIndex, expandedField.name, val)
            }
            onClose={() => setExpandedCell(null)}
          />
        );
      })()}

      {expandedRecordId !== null && (() => {
        // Resolve the record by stable id every render; if it was
        // deleted out from under the modal, close silently.
        const idx = data.records.findIndex((r) => r.id === expandedRecordId);
        if (idx === -1) return null;
        return (
          <RecordModal
            record={data.records[idx]}
            recordIndex={idx}
            fields={data.fields}
            allRecords={data.records}
            resolver={tableResolver}
            onUpdateCell={updateCell}
            onAddComment={handleAddComment}
            onRemoveComment={handleRemoveComment}
            onClose={() => setExpandedRecordId(null)}
          />
        );
      })()}

      {showAiAssistant && (
        <BaseAiAssistant
          fields={data.fields}
          records={data.records}
          selectedIds={selectedIds}
          onCreateTable={createTableWithFields}
          onAddFields={addFields}
          onApplyCellValues={applyCellValues}
          onClose={() => setShowAiAssistant(false)}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// TableTabs — the multi-table switcher. Renders one tab per table in
// the document, a "+" to add a table, and (when there's more than one
// table) a double-click-to-rename + delete affordance on the active
// tab. A single-table base still shows its one tab so the user can
// rename it and discover the "+" — but the delete control is hidden
// because the document model guarantees at least one table.
// ──────────────────────────────────────────────────────────────────────

function TableTabs({
  tables,
  activeTableId,
  onSwitch,
  onAdd,
  onRename,
  onRemove,
}: {
  tables: BaseTable[];
  activeTableId: string;
  onSwitch: (tableId: string) => void;
  onAdd: () => void;
  onRename: (tableId: string, name: string) => void;
  onRemove: (tableId: string) => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const startRename = (table: BaseTable) => {
    setRenamingId(table.id);
    setDraftName(table.name);
  };
  const commitRename = () => {
    if (renamingId) onRename(renamingId, draftName);
    setRenamingId(null);
  };

  const activeTable = tables.find((t) => t.id === activeTableId);

  return (
    // Outer toolbar. The `role="tablist"` is a *separate* inner element
    // so it owns ONLY its `role="tab"` children: a tablist that also
    // contained the "+" / delete buttons trips `aria-required-children`
    // (those buttons are not `tab`s). The auxiliary controls therefore
    // live in the toolbar alongside — not inside — the tablist.
    <div
      className="base-table-tabs"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.25rem",
        padding: "0.25rem 0.5rem",
        borderBottom: "1px solid var(--color-border, #e5e7eb)",
        overflowX: "auto",
        background: "var(--color-bg-secondary, #f9fafb)",
      }}
    >
      <div
        className="base-table-tablist"
        role="tablist"
        aria-label="Tables"
        style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}
      >
        {tables.map((table) => {
          const isActive = table.id === activeTableId;
          const isRenaming = renamingId === table.id;
          if (isRenaming) {
            // Transient inline-rename of the active tab: the tab is
            // momentarily swapped for a text field while the user edits
            // its name (committed on Enter/blur). This editing state is
            // never the steady-state DOM the audit inspects.
            return (
              <input
                key={table.id}
                className="input base-table-tab-rename"
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  else if (e.key === "Escape") setRenamingId(null);
                }}
                aria-label={`Rename table ${table.name}`}
                style={{ width: "8rem", fontSize: "0.8rem" }}
              />
            );
          }
          return (
            <button
              key={table.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className="btn-sm base-table-tab"
              onClick={() => onSwitch(table.id)}
              onDoubleClick={() => startRename(table)}
              title={isActive ? "Double-click to rename" : table.name}
              style={{
                fontWeight: isActive ? 600 : 400,
                background: isActive
                  ? "var(--color-primary-soft, #ede9fe)"
                  : "transparent",
                borderBottomLeftRadius: 0,
                borderBottomRightRadius: 0,
              }}
            >
              {table.name}
            </button>
          );
        })}
      </div>
      {activeTable && tables.length > 1 && (
        <button
          type="button"
          className="btn-sm base-table-tab-remove"
          onClick={() => {
            if (
              window.confirm(
                `Delete table "${activeTable.name}" and all its records? Links to it from other tables will be cleared.`,
              )
            ) {
              onRemove(activeTable.id);
            }
          }}
          title={`Delete table ${activeTable.name}`}
          aria-label={`Delete table ${activeTable.name}`}
          style={{ padding: "0 0.3rem", color: "var(--color-danger, #b91c1c)" }}
        >
          ×
        </button>
      )}
      <button
        type="button"
        className="btn-sm"
        onClick={onAdd}
        title="Add table"
        aria-label="Add table"
      >
        +
      </button>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// RecordModal — the full "expand record" view. Shows every field of
// the active table for one record (inline-editable via the same
// CellInput components as the grid, so behaviour is identical), the
// record's created / modified timestamps, and an activity log of
// comments. Comments are stored in record metadata (`__comments`) and
// never sent anywhere — Tessera is local-first.
// ──────────────────────────────────────────────────────────────────────

function RecordModal({
  record,
  recordIndex,
  fields,
  allRecords,
  resolver,
  onUpdateCell,
  onAddComment,
  onRemoveComment,
  onClose,
}: {
  record: BaseRecord;
  recordIndex: number;
  fields: BaseField[];
  allRecords: BaseRecord[];
  resolver: BaseTableResolver;
  onUpdateCell: (recordIndex: number, fieldName: string, value: unknown) => void;
  onAddComment: (recordId: string, text: string, author: string) => void;
  onRemoveComment: (recordId: string, commentId: string) => void;
  onClose: () => void;
}) {
  const [commentDraft, setCommentDraft] = useState("");
  const comments = getComments(record);
  const created = record[RECORD_CREATED_KEY];
  const modified = record[RECORD_MODIFIED_KEY];

  // Close on Escape, mirroring the other modals in this editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submitComment = () => {
    const text = commentDraft.trim();
    if (text === "") return;
    onAddComment(record.id, text, "You");
    setCommentDraft("");
  };

  return (
    <div
      className="base-record-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        // Only close when the backdrop itself (not a child) is pressed.
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        className="base-record-modal card"
        role="dialog"
        aria-modal="true"
        aria-label="Expanded record"
        style={{
          background: "var(--color-bg, #fff)",
          color: "var(--color-text, #111)",
          borderRadius: "var(--radius-lg, 12px)",
          border: "1px solid var(--color-border, #e5e7eb)",
          width: "min(720px, 92vw)",
          maxHeight: "88vh",
          overflowY: "auto",
          boxShadow: "0 16px 48px rgba(0,0,0,0.28)",
          padding: "1rem 1.25rem",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "0.75rem",
          }}
        >
          <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Record</h2>
          <button
            type="button"
            className="btn-sm"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            ×
          </button>
        </div>

        <div
          className="base-record-modal-fields"
          style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}
        >
          {fields.map((field) => (
            <div
              key={field.name}
              style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}
            >
              <label
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  color: "var(--color-text-secondary, #6b7280)",
                }}
              >
                {field.name}
              </label>
              <CellInput
                field={field}
                value={record[field.name]}
                record={record}
                recordIndex={recordIndex}
                allRecords={allRecords}
                allFields={fields}
                resolver={resolver}
                onChange={(val) => onUpdateCell(recordIndex, field.name, val)}
              />
            </div>
          ))}
        </div>

        <div
          className="base-record-modal-activity"
          style={{
            marginTop: "1rem",
            paddingTop: "0.75rem",
            borderTop: "1px solid var(--color-border, #e5e7eb)",
          }}
        >
          <div
            style={{
              fontSize: "0.75rem",
              color: "var(--color-text-secondary, #6b7280)",
              display: "flex",
              gap: "1rem",
              flexWrap: "wrap",
            }}
          >
            <span>
              Created:{" "}
              {typeof created === "string" && created !== ""
                ? formatTimestamp(created, true)
                : "—"}
            </span>
            <span>
              Modified:{" "}
              {typeof modified === "string" && modified !== ""
                ? formatTimestamp(modified, true)
                : "—"}
            </span>
          </div>

          <h3 style={{ fontSize: "0.9rem", margin: "0.75rem 0 0.4rem" }}>
            Comments
          </h3>
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: "0.4rem",
            }}
          >
            {comments.length === 0 && (
              <li
                style={{
                  fontSize: "0.8rem",
                  color: "var(--color-text-secondary, #6b7280)",
                }}
              >
                No comments yet.
              </li>
            )}
            {comments.map((c) => (
              <li
                key={c.id}
                className="base-record-comment"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.15rem",
                  background: "var(--color-bg-secondary, #f9fafb)",
                  borderRadius: "var(--radius-md, 8px)",
                  padding: "0.4rem 0.5rem",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: "0.72rem",
                    color: "var(--color-text-secondary, #6b7280)",
                  }}
                >
                  <span>
                    <strong>{c.author}</strong> ·{" "}
                    {formatTimestamp(c.createdAt, true)}
                  </span>
                  <button
                    type="button"
                    className="btn-sm"
                    onClick={() => onRemoveComment(record.id, c.id)}
                    aria-label="Delete comment"
                    title="Delete comment"
                    style={{ padding: "0 0.3rem" }}
                  >
                    ×
                  </button>
                </div>
                <span style={{ fontSize: "0.85rem", whiteSpace: "pre-wrap" }}>
                  {c.body}
                </span>
              </li>
            ))}
          </ul>

          <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.5rem" }}>
            <textarea
              className="input"
              placeholder="Add a comment…"
              value={commentDraft}
              onChange={(e) => setCommentDraft(e.target.value)}
              onKeyDown={(e) => {
                // Cmd/Ctrl+Enter submits, matching common comment UIs.
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  submitComment();
                }
              }}
              rows={2}
              style={{ flex: 1, resize: "vertical" }}
            />
            <button
              type="button"
              className="btn-sm"
              onClick={submitComment}
              disabled={commentDraft.trim() === ""}
            >
              Comment
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// useClickOutside — closes an "open" popover when the user clicks or
// touches anywhere outside the bound ref. Shared between the
// multi_select and linked_record dropdowns (both of which are
// rendered absolutely-positioned inside their owning cell, so the
// natural blur-based close doesn't work — clicking another cell
// would otherwise leave the previous dropdown still open).
//
// The listener attaches only while `active` is true so an idle cell
// doesn't pay any per-click cost, and it uses `mousedown` /
// `touchstart` (rather than `click`) so the dropdown closes *before*
// the new target receives its click — this prevents the next cell's
// own toggle from immediately re-opening a different popover.
// ──────────────────────────────────────────────────────────────────────

function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean,
  onOutside: () => void,
) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      const node = ref.current;
      if (!node) return;
      const target = e.target as Node | null;
      if (target && node.contains(target)) return;
      onOutside();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [ref, active, onOutside]);
}

// ──────────────────────────────────────────────────────────────────────
// CellInput — dispatches to a per-type variant. Computed types
// (formula / rollup / lookup / auto_number) are rendered read-only;
// editable types render an input or a custom widget.
// ──────────────────────────────────────────────────────────────────────

interface CellInputProps {
  field: BaseField;
  value: unknown;
  record: BaseRecord;
  recordIndex: number;
  allRecords: BaseRecord[];
  allFields: BaseField[];
  // Resolver used by linked_record / rollup / lookup cells to follow a
  // cross-table link (`field.linkedTableId`) into the target table.
  // Absent for same-table links, which resolve against `allRecords`.
  resolver?: BaseTableResolver;
  onChange: (val: unknown) => void;
  onExpand?: () => void;
  // True when the LongTextModal is currently mounted over THIS cell's
  // (recordId, fieldName) pair. Threaded through CellInput so each
  // per-type variant can decide how to render concurrently with the
  // modal — at the moment only LongTextCell honours it (disables its
  // inline textarea + Expand button so the modal's `draft` is the
  // sole edit surface and can't be overwritten by an inline edit
  // committed while the user types in the modal).
  isExpanded?: boolean;
}

function CellInput(props: CellInputProps) {
  const { field } = props;
  switch (field.type) {
    case "checkbox":
      return <CheckboxCell {...props} />;
    case "number":
      return <NumberCell {...props} />;
    case "date":
      return <DateCell {...props} />;
    case "select":
      return <SelectCell {...props} />;
    case "url":
      return <UrlCell {...props} />;
    case "multi_select":
      return <MultiSelectCell {...props} />;
    case "formula":
      return <FormulaCell {...props} />;
    case "linked_record":
      return <LinkedRecordCell {...props} />;
    case "rollup":
      return <RollupCell {...props} />;
    case "lookup":
      return <LookupCell {...props} />;
    case "attachment":
      return <AttachmentCell {...props} />;
    case "long_text":
      return <LongTextCell {...props} />;
    case "email":
      return <EmailCell {...props} />;
    case "phone":
      return <PhoneCell {...props} />;
    case "currency":
      return <CurrencyCell {...props} />;
    case "percent":
      return <PercentCell {...props} />;
    case "rating":
      return <RatingCell {...props} />;
    case "duration":
      return <DurationCell {...props} />;
    case "auto_number":
      return <AutoNumberCell {...props} />;
    case "user":
      return <UserCell {...props} />;
    case "created_time":
      return <TimestampCell {...props} which="created" />;
    case "modified_time":
      return <TimestampCell {...props} which="modified" />;
    case "text":
    default:
      return <TextCell {...props} />;
  }
}

function TextCell({ value, onChange }: CellInputProps) {
  return (
    <input
      type="text"
      className="base-cell-input"
      value={value != null ? String(value) : ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function CheckboxCell({ value, onChange }: CellInputProps) {
  return (
    <input
      type="checkbox"
      checked={Boolean(value)}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function NumberCell({ value, onChange }: CellInputProps) {
  return (
    <input
      type="number"
      className="base-cell-input"
      value={value != null ? String(value) : ""}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    />
  );
}

function DateCell({ field, value, onChange }: CellInputProps) {
  // `dateIncludeTime` switches the native picker to `datetime-local`.
  // The two input types use different value formats — `YYYY-MM-DD` vs
  // `YYYY-MM-DDTHH:mm` — so we normalise the stored string to the
  // shape the active input expects (a date-only value still shows in
  // a datetime input by appending `T00:00`, and a datetime value still
  // shows in a date input by slicing the date half). This keeps a
  // field that toggles `includeTime` from rendering blank.
  const includeTime = field.dateIncludeTime === true;
  const raw = value != null ? String(value) : "";
  if (includeTime) {
    const local =
      raw === ""
        ? ""
        : raw.includes("T")
          ? raw.slice(0, 16)
          : `${raw}T00:00`;
    return (
      <input
        type="datetime-local"
        className="base-cell-input"
        value={local}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      type="date"
      className="base-cell-input"
      value={raw.includes("T") ? raw.slice(0, 10) : raw}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// `user` is a free-text collaborator name. Tessera is local-first with
// no central identity directory, so we store the name the user types
// rather than resolving against a remote roster — keeping the field
// fully usable offline and in the packaged app.
function UserCell({ value, onChange }: CellInputProps) {
  return (
    <input
      type="text"
      className="base-cell-input"
      value={value != null ? String(value) : ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Collaborator"
    />
  );
}

// Read-only intrinsic timestamps. `created_time` / `modified_time`
// read the record's `__created` / `__modified` metadata (stamped by
// addRecord / updateCell) rather than a stored cell value, mirroring
// Airtable's "Created time" / "Last modified time" fields. The field's
// `dateIncludeTime` flag controls whether the time-of-day is shown.
function TimestampCell({
  field,
  record,
  which,
}: CellInputProps & { which: "created" | "modified" }) {
  const iso = record[which === "created" ? RECORD_CREATED_KEY : RECORD_MODIFIED_KEY];
  const text =
    typeof iso === "string" && iso !== ""
      ? formatTimestamp(iso, field.dateIncludeTime === true)
      : "—";
  return (
    <span
      className="base-cell-readonly"
      style={{ color: "var(--color-text-secondary, #6b7280)" }}
      title={typeof iso === "string" ? iso : undefined}
    >
      {text}
    </span>
  );
}

function SelectCell({ field, value, onChange }: CellInputProps) {
  return (
    <select
      className="base-cell-input"
      value={value != null ? String(value) : ""}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">—</option>
      {(field.options ?? []).map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  );
}

function UrlCell({ value, onChange }: CellInputProps) {
  return (
    <input
      type="url"
      className="base-cell-input"
      value={value != null ? String(value) : ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder="https://..."
    />
  );
}

function EmailCell({ value, onChange }: CellInputProps) {
  return (
    <input
      type="email"
      className="base-cell-input"
      value={value != null ? String(value) : ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder="name@example.com"
    />
  );
}

function PhoneCell({ value, onChange }: CellInputProps) {
  return (
    <input
      type="tel"
      className="base-cell-input"
      value={value != null ? String(value) : ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder="+1 555-0123"
    />
  );
}

function CurrencyCell({ field, value, onChange }: CellInputProps) {
  const symbol = field.currencySymbol ?? "$";
  return (
    <div className="base-cell-currency" style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
      <span className="base-cell-currency-symbol">{symbol}</span>
      <input
        type="number"
        step="0.01"
        className="base-cell-input"
        value={value != null ? String(value) : ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      />
    </div>
  );
}

function PercentCell({ field, value, onChange }: CellInputProps) {
  // Defense in depth: `parseBaseContent` runs every field through
  // `sanitizeBaseField`, which already clamps `percentPrecision` to
  // [0,20]. We re-clamp here so an in-memory mutation (e.g. a future
  // codepath that builds a field by hand and skips the parser) can't
  // hand `toFixed` a value outside its ECMAScript-mandated [0,100]
  // domain, which would otherwise throw a RangeError mid-render and
  // unmount the entire editor.
  const rawPrecision = field.percentPrecision ?? 0;
  const precision = Number.isFinite(rawPrecision)
    ? Math.max(0, Math.min(20, Math.floor(rawPrecision)))
    : 0;
  const numeric = typeof value === "number" ? value : null;
  // Stored as a fraction (0..1) so 50% is 0.5 — same convention as
  // Excel — but the user sees percentage units, so the input is
  // multiplied/divided on entry.
  const displayed = numeric != null ? (numeric * 100).toFixed(precision) : "";
  return (
    <div className="base-cell-percent" style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
      <input
        type="number"
        step={1 / Math.pow(10, precision)}
        className="base-cell-input"
        value={displayed}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : Number(e.target.value) / 100)
        }
      />
      <span className="base-cell-percent-symbol">%</span>
    </div>
  );
}

function RatingCell({ value, onChange }: CellInputProps) {
  const rating = typeof value === "number" ? Math.max(0, Math.min(5, value)) : 0;
  return (
    <div
      className="base-cell-rating"
      style={{ display: "flex", gap: "2px", cursor: "pointer" }}
      role="radiogroup"
      aria-label="Rating"
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={n === rating}
          className="base-cell-rating-star"
          onClick={() => onChange(n === rating ? 0 : n)}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            color: n <= rating ? "var(--color-primary, #fbbf24)" : "#d1d5db",
            fontSize: "1.1rem",
            lineHeight: 1,
          }}
        >
          ★
        </button>
      ))}
    </div>
  );
}

/**
 * Format integer minutes as `h:mm`. Clamps negative values to 0 so a
 * record loaded from JSON with a stray negative number renders as
 * `0:00` instead of `"-2:-30"` (JS `%` preserves dividend sign).
 */
function formatDurationMinutes(value: unknown): string {
  if (value == null) return "";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "";
  const safe = Math.max(0, Math.floor(n));
  const hh = Math.floor(safe / 60);
  const mm = safe % 60;
  return `${hh}:${String(mm).padStart(2, "0")}`;
}

function DurationCell({ value, onChange }: CellInputProps) {
  // Stored as integer minutes; rendered as h:mm. We keep a local
  // `draft` string so users can type freely (intermediate keystrokes
  // like `"2"` or `"2:"` are not valid h:mm but must be allowed) —
  // the committed minutes value only updates on blur / Enter, after
  // the draft parses successfully. Empty input clears the field.
  const committed = formatDurationMinutes(value);
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft !== null ? draft : committed;

  const commit = () => {
    if (draft === null) return;
    const trimmed = draft.trim();
    if (trimmed === "") {
      onChange(null);
      setDraft(null);
      return;
    }
    const m = trimmed.match(/^(\d+):(\d{1,2})$/);
    if (m) {
      const h = Number(m[1]);
      const min = Number(m[2]);
      if (Number.isFinite(h) && Number.isFinite(min) && min < 60) {
        onChange(h * 60 + min);
        setDraft(null);
        return;
      }
    }
    // Malformed: discard the draft and re-display the last committed
    // value so the cell never gets stuck in an invalid state.
    setDraft(null);
  };

  return (
    <input
      type="text"
      className="base-cell-input"
      value={text}
      placeholder="h:mm"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          setDraft(null);
        }
      }}
    />
  );
}

function AutoNumberCell({ recordIndex }: CellInputProps) {
  // Read-only and computed from position — see helper for the
  // rationale (stable across sort by sorting on this field).
  return (
    <span className="base-cell-readonly">{computeAutoNumber(recordIndex)}</span>
  );
}

function MultiSelectCell({ field, value, onChange }: CellInputProps) {
  const selected: string[] = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
  const options = field.options ?? [];
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Memoize the close callback so the listener doesn't churn its
  // add/remove cycle on every render.
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(rootRef, open, close);

  const toggle = (opt: string) => {
    const next = selected.includes(opt)
      ? selected.filter((s) => s !== opt)
      : [...selected, opt];
    onChange(next);
  };

  return (
    <div
      ref={rootRef}
      className="base-cell-multiselect"
      style={{ position: "relative" }}
    >
      <button
        type="button"
        className="base-cell-input"
        onClick={() => setOpen((o) => !o)}
        style={{ textAlign: "left", minHeight: "1.5rem" }}
      >
        {selected.length === 0 ? (
          <span style={{ color: "#9ca3af" }}>—</span>
        ) : (
          <span style={{ display: "inline-flex", gap: "0.25rem", flexWrap: "wrap" }}>
            {selected.map((s) => (
              <span
                key={s}
                className="base-cell-tag"
                style={{
                  background: "var(--color-primary-soft, #ede9fe)",
                  padding: "0 0.4rem",
                  borderRadius: "999px",
                  fontSize: "0.75rem",
                }}
              >
                {s}
              </span>
            ))}
          </span>
        )}
      </button>
      {open && (
        <div
          className="base-cell-multiselect-menu"
          role="listbox"
          aria-multiselectable
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            zIndex: 100,
            background: "var(--color-bg-page, white)",
            border: "1px solid var(--color-border, #e5e7eb)",
            borderRadius: "4px",
            padding: "0.25rem",
            minWidth: "8rem",
            boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
          }}
        >
          {options.map((opt) => (
            <label
              key={opt}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.25rem",
                padding: "0.25rem",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={selected.includes(opt)}
                onChange={() => toggle(opt)}
              />
              <span>{opt}</span>
            </label>
          ))}
          {options.length === 0 && (
            <span style={{ fontSize: "0.75rem", color: "#9ca3af" }}>
              No options defined
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function FormulaCell({ field, record, allFields }: CellInputProps) {
  // Read-only: computed at render time from the live record values.
  // Pass the current field name so the engine's cycle detector can
  // catch self-references and mutual recursion between formula
  // fields before the JS call stack overflows.
  const src = field.formula ?? "";
  const result = evaluateBaseFormula(src, allFields, record, field.name);
  return (
    <span
      className="base-cell-readonly"
      title={`= ${src}`}
      style={{ color: "var(--color-text-secondary, #6b7280)" }}
    >
      {formatFormulaResult(result)}
    </span>
  );
}

function LinkedRecordCell({
  field,
  value,
  record,
  allRecords,
  resolver,
  onChange,
}: CellInputProps) {
  const links: string[] = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
  // Cross-table link: resolve / pick against the TARGET table's
  // records. Same-table link: `linkTargetRecords` returns `allRecords`
  // unchanged, preserving the existing behaviour.
  const targetRecords = linkTargetRecords(field, allRecords, resolver);
  const isCrossTable =
    typeof field.linkedTableId === "string" && field.linkedTableId !== "";
  const linkedRecords = resolveLinkedRecords(links, targetRecords);
  const display = field.linkedDisplayField;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Same close-on-outside-click behavior as MultiSelectCell. Memoize
  // the handler so the document listener add/remove cycle is stable
  // across re-renders.
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(rootRef, open, close);

  const removeLink = (id: string) =>
    onChange(links.filter((l) => l !== id));
  const addLink = (id: string) =>
    onChange(Array.from(new Set([...links, id])));

  return (
    <div
      ref={rootRef}
      className="base-cell-linkedrecord"
      style={{ position: "relative" }}
    >
      <div style={{ display: "inline-flex", gap: "0.25rem", flexWrap: "wrap" }}>
        {linkedRecords.map((r) => (
          <span
            key={r.id}
            className="base-cell-chip"
            data-record-id={r.id}
            style={{
              background: "var(--color-bg-secondary, #f3f4f6)",
              padding: "0 0.4rem",
              borderRadius: "999px",
              fontSize: "0.75rem",
              display: "inline-flex",
              alignItems: "center",
              gap: "0.25rem",
            }}
          >
            <span>{display && r[display] != null ? String(r[display]) : r.id.slice(0, 6)}</span>
            <button
              type="button"
              onClick={() => removeLink(r.id)}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                fontSize: "0.9rem",
                lineHeight: 1,
              }}
              aria-label={`Remove link to ${r.id}`}
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="btn-sm"
          style={{ fontSize: "0.75rem", padding: "0 0.4rem" }}
        >
          +
        </button>
      </div>
      {open && (
        <div
          className="base-cell-linkedrecord-menu"
          role="listbox"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            zIndex: 100,
            background: "var(--color-bg-page, white)",
            border: "1px solid var(--color-border, #e5e7eb)",
            borderRadius: "4px",
            padding: "0.25rem",
            minWidth: "12rem",
            maxHeight: "12rem",
            overflowY: "auto",
            boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
          }}
        >
          {targetRecords
            // Exclude already-linked records. For a SAME-table link we
            // also exclude the current record itself — a record linking
            // to itself causes rollup / lookup to include its own field
            // values, which is almost never what the user wants. For a
            // cross-table link there is no self to exclude (the target
            // population is a different table).
            .filter(
              (r) =>
                (isCrossTable || r.id !== record.id) &&
                !links.includes(r.id),
            )
            .map((r) => (
              <button
                type="button"
                key={r.id}
                onClick={() => {
                  addLink(r.id);
                  setOpen(false);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  background: "none",
                  border: "none",
                  padding: "0.25rem",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                }}
              >
                {display && r[display] != null ? String(r[display]) : r.id}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

function RollupCell({
  field,
  record,
  allFields,
  allRecords,
  resolver,
}: CellInputProps) {
  // rollup follows the `linkedField` link from THIS record, then
  // aggregates `targetField` across the linked records.
  const linkedFieldName = field.linkedField;
  const targetFieldName = field.targetField;
  const aggregation: RollupAggregation = field.aggregation ?? "SUM";
  if (!linkedFieldName || !targetFieldName) {
    return <span className="base-cell-readonly">—</span>;
  }
  const linkedFieldDef = allFields.find((f) => f.name === linkedFieldName);
  if (!linkedFieldDef || linkedFieldDef.type !== "linked_record") {
    return (
      <span
        className="base-cell-readonly"
        title={`linkedField "${linkedFieldName}" is not a linked_record field`}
      >
        #REF!
      </span>
    );
  }
  const ids = record[linkedFieldName];
  // Resolve the link's targets in the linked field's table (which may
  // be a different table when the link is cross-table).
  const linkedRecords = resolveLinkedRecords(
    ids,
    linkTargetRecords(linkedFieldDef, allRecords, resolver),
  );
  const values = linkedRecords.map((r) => r[targetFieldName]);
  return (
    <span className="base-cell-readonly">
      {aggregateValues(values, aggregation)}
    </span>
  );
}

function LookupCell({
  field,
  record,
  allFields,
  allRecords,
  resolver,
}: CellInputProps) {
  const linkedFieldName = field.linkedField;
  const targetFieldName = field.targetField;
  if (!linkedFieldName || !targetFieldName) {
    return <span className="base-cell-readonly">—</span>;
  }
  const linkedFieldDef = allFields.find((f) => f.name === linkedFieldName);
  if (!linkedFieldDef || linkedFieldDef.type !== "linked_record") {
    return (
      <span
        className="base-cell-readonly"
        title={`linkedField "${linkedFieldName}" is not a linked_record field`}
      >
        #REF!
      </span>
    );
  }
  const ids = record[linkedFieldName];
  const linkedRecords = resolveLinkedRecords(
    ids,
    linkTargetRecords(linkedFieldDef, allRecords, resolver),
  );
  return (
    <span className="base-cell-readonly">
      {lookupValues(linkedRecords, targetFieldName)}
    </span>
  );
}

function AttachmentCell({ value, onChange }: CellInputProps) {
  const paths: string[] = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    // Local-first: store the file name as the "path". A future PR
    // will wire this through the artifact's data directory; for now
    // the path is the relative name supplied by the file picker.
    const next = [...paths];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      next.push(f.name);
    }
    onChange(next);
  };

  const isImage = (p: string) => /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(p);

  return (
    <div
      className="base-cell-attachment"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        e.preventDefault();
        handleFiles(e.dataTransfer.files);
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.25rem",
        flexWrap: "wrap",
        minHeight: "1.5rem",
      }}
    >
      {paths.map((p, idx) => (
        <span
          key={`${p}-${idx}`}
          className="base-cell-attachment-item"
          style={{
            background: "var(--color-bg-secondary, #f3f4f6)",
            padding: "0.1rem 0.4rem",
            borderRadius: "4px",
            fontSize: "0.75rem",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.25rem",
          }}
        >
          <span aria-hidden>{isImage(p) ? "🖼" : "📎"}</span>
          <span>{p}</span>
          <button
            type="button"
            onClick={() => onChange(paths.filter((_, i) => i !== idx))}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              fontSize: "0.9rem",
              lineHeight: 1,
            }}
            aria-label={`Remove ${p}`}
          >
            ×
          </button>
        </span>
      ))}
      <button
        type="button"
        className="btn-sm"
        onClick={() => inputRef.current?.click()}
        style={{ fontSize: "0.75rem" }}
      >
        + File
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        onChange={(e) => handleFiles(e.target.files)}
        style={{ display: "none" }}
      />
    </div>
  );
}

function LongTextCell({ value, onChange, onExpand, isExpanded }: CellInputProps) {
  // When the LongTextModal is open over this cell, lock the inline
  // surface. The modal's `draft` state is initialized once from
  // `value` on mount and only flushes to the record on Save — so if
  // the user typed into the inline textarea while the modal was open
  // and then hit Save, the modal would overwrite the inline edit
  // with stale text. Disabling the inline surface eliminates the
  // ambiguity: while the modal is up, there is exactly one edit
  // surface, and it's the one the user explicitly chose by clicking
  // Expand. Mirrors Airtable's behaviour.
  return (
    <div
      style={{ display: "flex", alignItems: "flex-start", gap: "0.25rem" }}
      data-expanded={isExpanded ? "true" : undefined}
    >
      <textarea
        className="base-cell-input base-cell-longtext"
        value={value != null ? String(value) : ""}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        disabled={isExpanded}
        style={{
          flex: 1,
          resize: "vertical",
          minHeight: "1.5rem",
          opacity: isExpanded ? 0.5 : undefined,
        }}
        title={isExpanded ? "Edit in the expanded modal" : undefined}
      />
      <button
        type="button"
        className="btn-sm"
        title={isExpanded ? "Already open" : "Expand"}
        onClick={onExpand}
        disabled={isExpanded}
        style={{ fontSize: "0.75rem", padding: "0 0.3rem" }}
      >
        ⤢
      </button>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// LongTextModal — full-screen editor for long_text fields with a
// basic Markdown preview pane.
// ──────────────────────────────────────────────────────────────────────

function LongTextModal({
  field,
  value,
  onChange,
  onClose,
}: {
  field: BaseField;
  value: unknown;
  onChange: (val: unknown) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<string>(value != null ? String(value) : "");
  const [showPreview, setShowPreview] = useState(false);

  return (
    <div
      className="base-longtext-modal-overlay"
      role="dialog"
      aria-label={`Edit ${field.name}`}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        className="base-longtext-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--color-bg-page, white)",
          width: "min(720px, 90vw)",
          maxHeight: "80vh",
          borderRadius: "8px",
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>{field.name}</h3>
          <div style={{ display: "flex", gap: "0.25rem" }}>
            <button
              type="button"
              className="btn-sm"
              onClick={() => setShowPreview((p) => !p)}
            >
              {showPreview ? "Edit" : "Preview"}
            </button>
            <button
              type="button"
              className="btn-sm"
              onClick={() => {
                onChange(draft);
                onClose();
              }}
            >
              Save
            </button>
            <button type="button" className="btn-sm" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
        {showPreview ? (
          <div
            className="base-longtext-preview"
            style={{ overflowY: "auto", padding: "0.5rem", border: "1px solid #e5e7eb" }}
          >
            <MarkdownPreview source={draft} />
          </div>
        ) : (
          <textarea
            className="base-longtext-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            style={{ flex: 1, minHeight: "16rem", fontFamily: "monospace" }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Tiny Markdown preview: headings, bold, italic, inline code, line
 * breaks. Intentionally minimal — a real renderer can replace this
 * later; the goal is to give the user a visual cue that their input
 * is parsed correctly, not a faithful Markdown renderer.
 */
function MarkdownPreview({ source }: { source: string }) {
  const lines = source.split("\n");
  return (
    <div>
      {lines.map((line, i) => {
        if (line.startsWith("# ")) return <h1 key={i}>{renderInline(line.slice(2))}</h1>;
        if (line.startsWith("## ")) return <h2 key={i}>{renderInline(line.slice(3))}</h2>;
        if (line.startsWith("### ")) return <h3 key={i}>{renderInline(line.slice(4))}</h3>;
        if (line.trim() === "") return <br key={i} />;
        return <p key={i} style={{ margin: "0.25rem 0" }}>{renderInline(line)}</p>;
      })}
    </div>
  );
}

function renderInline(text: string): React.ReactNode {
  // Very small parser: **bold**, *italic*, `code`. Order matters
  // so the bold pattern is tried before italic.
  const parts: React.ReactNode[] = [];
  let i = 0;
  let buf = "";
  const flushBuf = () => {
    if (buf) {
      parts.push(buf);
      buf = "";
    }
  };
  while (i < text.length) {
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        flushBuf();
        parts.push(<strong key={i}>{text.slice(i + 2, end)}</strong>);
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "*") {
      const end = text.indexOf("*", i + 1);
      if (end !== -1) {
        flushBuf();
        parts.push(<em key={i}>{text.slice(i + 1, end)}</em>);
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        flushBuf();
        parts.push(<code key={i}>{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }
    buf += text[i];
    i++;
  }
  flushBuf();
  return <>{parts}</>;
}

// ──────────────────────────────────────────────────────────────────────
// AddFieldDialog — picks a name + type, and for derived/structural
// types collects the per-type config (options, formula, linkedField,
// targetField, aggregation, …) before submitting.
// ──────────────────────────────────────────────────────────────────────

function AddFieldDialog({
  existingFields,
  tables,
  activeTableId,
  onAdd,
  onCancel,
}: {
  existingFields: BaseField[];
  tables: BaseTable[];
  activeTableId: string;
  onAdd: (field: BaseField) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [optionsText, setOptionsText] = useState("");
  const [formulaSrc, setFormulaSrc] = useState("");
  const [linkedField, setLinkedField] = useState("");
  const [targetField, setTargetField] = useState("");
  const [aggregation, setAggregation] = useState<RollupAggregation>("SUM");
  const [linkedDisplayField, setLinkedDisplayField] = useState("");
  // Empty string ⇒ link within the active table (same-table link, the
  // legacy behaviour — no `linkedTableId` is written).
  const [linkedTableId, setLinkedTableId] = useState("");
  const [dateIncludeTime, setDateIncludeTime] = useState(false);
  const [currencySymbol, setCurrencySymbol] = useState("$");
  const [percentPrecision, setPercentPrecision] = useState("0");
  const [nameError, setNameError] = useState<string | null>(null);

  const linkFieldChoices = existingFields.filter(
    (f) => f.type === "linked_record",
  );

  // For a `linked_record`, the fields available as a display field come
  // from the chosen target table (the active table for a same-table
  // link). For a `rollup` / `lookup`, the target field comes from the
  // table that the selected `linkedField` points at.
  const tableById = (id: string): BaseTable | undefined =>
    tables.find((t) => t.id === id);
  const linkTargetTable =
    linkedTableId === "" ? tableById(activeTableId) : tableById(linkedTableId);
  const linkDisplayChoices = (linkTargetTable?.fields ?? []).filter(
    (f) => f.name !== name.trim(),
  );
  const selectedLinkField = existingFields.find(
    (f) => f.name === linkedField && f.type === "linked_record",
  );
  const rollupTargetTable = selectedLinkField
    ? selectedLinkField.linkedTableId
      ? tableById(selectedLinkField.linkedTableId)
      : tableById(activeTableId)
    : undefined;
  const rollupTargetChoices = (rollupTargetTable?.fields ?? []).map(
    (f) => f.name,
  );

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Name is required");
      return;
    }
    // Reject reserved names (`id` is the per-record stable identifier
    // every linked_record / rollup / lookup depends on; shadowing it
    // would orphan every link on the next reload).
    if (isReservedFieldName(trimmed)) {
      setNameError(`"${trimmed}" is reserved and cannot be used as a field name`);
      return;
    }
    // Two fields with the same name would both read/write the same
    // key on the record object, silently clobbering each other.
    if (existingFields.some((f) => f.name === trimmed)) {
      setNameError(`A field named "${trimmed}" already exists`);
      return;
    }
    setNameError(null);
    const field: BaseField = { name: trimmed, type };
    if (type === "select" || type === "multi_select") {
      const opts = optionsText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (opts.length > 0) field.options = opts;
    }
    if (type === "formula") field.formula = formulaSrc;
    if (type === "linked_record") {
      if (linkedDisplayField.trim()) field.linkedDisplayField = linkedDisplayField.trim();
      // Only persist `linkedTableId` for a genuine cross-table link.
      // A same-table link omits it so single-table bases serialize
      // byte-for-byte as before.
      if (linkedTableId !== "" && linkedTableId !== activeTableId) {
        field.linkedTableId = linkedTableId;
      }
    }
    if (type === "rollup" || type === "lookup") {
      if (linkedField) field.linkedField = linkedField;
      if (targetField.trim()) field.targetField = targetField.trim();
      if (type === "rollup") field.aggregation = aggregation;
    }
    if ((type === "date" || type === "created_time" || type === "modified_time") && dateIncludeTime) {
      field.dateIncludeTime = true;
    }
    if (type === "currency") field.currencySymbol = currencySymbol || "$";
    if (type === "percent") {
      const p = Number(percentPrecision);
      if (Number.isFinite(p) && p >= 0) field.percentPrecision = Math.floor(p);
    }
    onAdd(field);
  };

  return (
    <div
      className="base-add-field-dialog"
      style={{ padding: "0.5rem", display: "flex", flexDirection: "column", gap: "0.4rem", border: "1px solid var(--color-border, #e5e7eb)" }}
    >
      <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "center" }}>
        <input
          className="input"
          placeholder="Field name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (nameError) setNameError(null);
          }}
        />
        <select
          className="input"
          value={type}
          onChange={(e) => setType(e.target.value as FieldType)}
        >
          <optgroup label="Basic">
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
            <option value="select">Select</option>
            <option value="multi_select">Multi-select</option>
            <option value="checkbox">Checkbox</option>
            <option value="url">URL</option>
            <option value="email">Email</option>
            <option value="phone">Phone</option>
            <option value="currency">Currency</option>
            <option value="percent">Percent</option>
            <option value="rating">Rating</option>
            <option value="duration">Duration</option>
            <option value="long_text">Long text</option>
            <option value="attachment">Attachment</option>
            <option value="auto_number">Auto-number</option>
            <option value="user">User</option>
          </optgroup>
          <optgroup label="Computed">
            <option value="formula">Formula</option>
            <option value="linked_record">Linked record</option>
            <option value="rollup">Rollup</option>
            <option value="lookup">Lookup</option>
            <option value="created_time">Created time</option>
            <option value="modified_time">Modified time</option>
          </optgroup>
        </select>
      </div>

      {(type === "select" || type === "multi_select") && (
        <input
          className="input"
          placeholder="Options (comma-separated)"
          value={optionsText}
          onChange={(e) => setOptionsText(e.target.value)}
        />
      )}

      {type === "formula" && (
        <input
          className="input"
          placeholder="= {Price} * {Quantity}"
          value={formulaSrc}
          onChange={(e) => setFormulaSrc(e.target.value)}
        />
      )}

      {type === "linked_record" && (
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          <select
            className="input"
            value={linkedTableId}
            aria-label="Links to table"
            onChange={(e) => {
              setLinkedTableId(e.target.value);
              // The display-field choices come from the target table;
              // clear a stale pick when the target changes.
              setLinkedDisplayField("");
            }}
          >
            <option value="">This table (self-link)</option>
            {tables
              .filter((t) => t.id !== activeTableId)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
          <select
            className="input"
            value={linkedDisplayField}
            aria-label="Display field on linked records"
            onChange={(e) => setLinkedDisplayField(e.target.value)}
          >
            <option value="">Display field… (defaults to id)</option>
            {linkDisplayChoices.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {(type === "rollup" || type === "lookup") && (
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          <select
            className="input"
            value={linkedField}
            onChange={(e) => {
              setLinkedField(e.target.value);
              setTargetField("");
            }}
          >
            <option value="">Linked record field…</option>
            {linkFieldChoices.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
          <select
            className="input"
            value={targetField}
            aria-label="Target field on linked records"
            onChange={(e) => setTargetField(e.target.value)}
            disabled={rollupTargetChoices.length === 0}
          >
            <option value="">Target field…</option>
            {rollupTargetChoices.map((fname) => (
              <option key={fname} value={fname}>
                {fname}
              </option>
            ))}
          </select>
          {type === "rollup" && (
            <select
              className="input"
              value={aggregation}
              onChange={(e) => setAggregation(e.target.value as RollupAggregation)}
            >
              <option value="SUM">SUM</option>
              <option value="AVG">AVG</option>
              <option value="MIN">MIN</option>
              <option value="MAX">MAX</option>
              <option value="COUNT">COUNT</option>
              <option value="CONCAT">CONCAT</option>
            </select>
          )}
        </div>
      )}

      {type === "currency" && (
        <input
          className="input"
          placeholder="Currency symbol"
          value={currencySymbol}
          onChange={(e) => setCurrencySymbol(e.target.value)}
        />
      )}

      {type === "percent" && (
        <input
          className="input"
          type="number"
          min="0"
          max="6"
          placeholder="Decimal places"
          value={percentPrecision}
          onChange={(e) => setPercentPrecision(e.target.value)}
        />
      )}

      {(type === "date" || type === "created_time" || type === "modified_time") && (
        <label
          style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem" }}
        >
          <input
            type="checkbox"
            checked={dateIncludeTime}
            onChange={(e) => setDateIncludeTime(e.target.checked)}
          />
          Include time of day
        </label>
      )}

      {nameError && (
        <div
          className="base-add-field-error"
          role="alert"
          style={{ color: "var(--color-danger, #b91c1c)", fontSize: "0.8rem" }}
        >
          {nameError}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.4rem" }}>
        <button type="button" className="btn-sm" onClick={submit}>
          Add
        </button>
        <button type="button" className="btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Per-type filter input placeholder.
// Hints at the syntax the matcher will accept so the user doesn't
// have to guess (e.g. `>10` on a number column).
// ──────────────────────────────────────────────────────────────────────
function filterPlaceholderForType(type: FieldType): string {
  switch (type) {
    case "number":
    case "currency":
    case "percent":
    case "rating":
    case "duration":
    case "auto_number":
      return "e.g. >10";
    case "checkbox":
      return "true / false";
    case "multi_select":
    case "attachment":
      return "Any tag…";
    case "linked_record":
      return "Linked id…";
    case "date":
      return "yyyy-mm-dd…";
    default:
      return "Filter…";
  }
}

// ──────────────────────────────────────────────────────────────────────
// ManageFieldsDialog — reorder + rename + remove fields in one place.
// A single modal keeps the actions discoverable; per-column inline
// rename is gated behind this dialog so the grid header doesn't grow
// a third action button per column.
// ──────────────────────────────────────────────────────────────────────
interface ManageFieldsDialogProps {
  fields: BaseField[];
  onRename: (
    oldName: string,
    newName: string,
  ) => { ok: true } | { error: string };
  onReorder: (fieldName: string, direction: "up" | "down") => void;
  onRemove: (fieldName: string) => void;
  onClose: () => void;
}

function ManageFieldsDialog({
  fields,
  onRename,
  onReorder,
  onRemove,
  onClose,
}: ManageFieldsDialogProps) {
  // Per-row local draft so editing one name doesn't churn re-renders
  // on the others. `editingName` tracks which row is in edit mode;
  // `draft` is the in-progress text.
  const [editingName, setEditingName] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  const beginEdit = (name: string) => {
    setEditingName(name);
    setDraft(name);
    setRenameError(null);
  };

  const commitEdit = () => {
    if (editingName === null) return;
    const result = onRename(editingName, draft);
    if ("error" in result) {
      setRenameError(result.error);
      return;
    }
    setEditingName(null);
    setDraft("");
    setRenameError(null);
  };

  return (
    <div
      role="dialog"
      aria-label="Manage fields"
      className="base-modal"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="base-modal-content"
        style={{
          background: "var(--color-surface, #fff)",
          padding: "1.25rem",
          borderRadius: "0.5rem",
          minWidth: "420px",
          maxWidth: "640px",
          maxHeight: "80vh",
          overflow: "auto",
        }}
      >
        <h3 style={{ marginTop: 0 }}>Manage fields</h3>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "0.9rem",
          }}
        >
          <tbody>
            {fields.map((field, idx) => (
              <tr key={field.name}>
                <td
                  style={{
                    padding: "0.25rem 0.5rem",
                    width: "1.5rem",
                    color: "var(--color-muted, #6b7280)",
                  }}
                >
                  {idx + 1}
                </td>
                <td style={{ padding: "0.25rem 0.5rem" }}>
                  {editingName === field.name ? (
                    <div>
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitEdit();
                          if (e.key === "Escape") {
                            setEditingName(null);
                            setRenameError(null);
                          }
                        }}
                        aria-label={`Rename ${field.name}`}
                        style={{ width: "100%" }}
                      />
                      {renameError && (
                        <div
                          role="alert"
                          style={{
                            color: "var(--color-danger, #b91c1c)",
                            fontSize: "0.8rem",
                            marginTop: "0.25rem",
                          }}
                        >
                          {renameError}
                        </div>
                      )}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="base-manage-field-name"
                      onClick={() => beginEdit(field.name)}
                      title="Click to rename"
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        font: "inherit",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      {field.name}
                      <span
                        style={{
                          color: "var(--color-muted, #6b7280)",
                          marginLeft: "0.4rem",
                        }}
                      >
                        ({field.type})
                      </span>
                    </button>
                  )}
                </td>
                <td
                  style={{
                    padding: "0.25rem 0.5rem",
                    whiteSpace: "nowrap",
                  }}
                >
                  {editingName === field.name ? (
                    <>
                      <button
                        type="button"
                        className="btn-sm"
                        onClick={commitEdit}
                      >
                        Save
                      </button>{" "}
                      <button
                        type="button"
                        className="btn-sm"
                        onClick={() => {
                          setEditingName(null);
                          setRenameError(null);
                        }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn-sm"
                        aria-label={`Move ${field.name} up`}
                        disabled={idx === 0}
                        onClick={() => onReorder(field.name, "up")}
                      >
                        ↑
                      </button>{" "}
                      <button
                        type="button"
                        className="btn-sm"
                        aria-label={`Move ${field.name} down`}
                        disabled={idx === fields.length - 1}
                        onClick={() => onReorder(field.name, "down")}
                      >
                        ↓
                      </button>{" "}
                      <button
                        type="button"
                        className="btn-sm danger"
                        aria-label={`Delete ${field.name}`}
                        onClick={() => {
                          onRemove(field.name);
                        }}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div
          style={{
            marginTop: "1rem",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <button type="button" className="btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// ImportDialog — paste or pick a CSV / JSON file. We deliberately let
// the user paste the file body in addition to the file picker so
// power users (and tests) can drive imports without disk I/O.
// ──────────────────────────────────────────────────────────────────────
interface ImportDialogProps {
  kind: "csv" | "json";
  recordCount: number;
  onImport: (text: string) => void;
  onCancel: () => void;
}

function ImportDialog({
  kind,
  recordCount,
  onImport,
  onCancel,
}: ImportDialogProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    file
      .text()
      .then((body) => setText(body))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  };

  const submit = () => {
    if (text.trim() === "") {
      setError("Paste or pick a file first.");
      return;
    }
    try {
      onImport(text);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      role="dialog"
      aria-label={`Import ${kind.toUpperCase()}`}
      className="base-modal"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="base-modal-content"
        style={{
          background: "var(--color-surface, #fff)",
          padding: "1.25rem",
          borderRadius: "0.5rem",
          minWidth: "480px",
          maxWidth: "720px",
        }}
      >
        <h3 style={{ marginTop: 0 }}>Import {kind.toUpperCase()}</h3>
        {recordCount > 0 && (
          <p
            style={{
              color: "var(--color-danger, #b91c1c)",
              marginTop: 0,
              fontSize: "0.9rem",
            }}
          >
            ⚠ This will REPLACE the current {recordCount} record(s).
          </p>
        )}
        <input
          type="file"
          accept={kind === "csv" ? ".csv,text/csv" : ".json,application/json"}
          onChange={onFileChange}
          aria-label={`Choose ${kind.toUpperCase()} file`}
          style={{ display: "block", marginBottom: "0.5rem" }}
        />
        <p
          style={{
            fontSize: "0.85rem",
            color: "var(--color-muted, #6b7280)",
            margin: "0 0 0.25rem 0",
          }}
        >
          Or paste the file contents:
        </p>
        <textarea
          aria-label={`${kind.toUpperCase()} body`}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          rows={10}
          style={{
            width: "100%",
            fontFamily: "monospace",
            fontSize: "0.85rem",
          }}
        />
        {error && (
          <div
            role="alert"
            style={{
              color: "var(--color-danger, #b91c1c)",
              fontSize: "0.85rem",
              marginTop: "0.4rem",
            }}
          >
            {error}
          </div>
        )}
        <div
          style={{
            marginTop: "1rem",
            display: "flex",
            justifyContent: "flex-end",
            gap: "0.5rem",
          }}
        >
          <button type="button" className="btn-sm" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-sm primary"
            onClick={submit}
          >
            Import
          </button>
        </div>
      </div>
    </div>
  );
}

function getDefaultValue(type: FieldType): unknown {
  switch (type) {
    case "checkbox":
      return false;
    case "number":
    case "currency":
    case "percent":
    case "rating":
    case "duration":
      return null;
    case "date":
      return "";
    case "multi_select":
    case "linked_record":
    case "attachment":
      return [];
    // Computed types initialise to null: their stored value is never
    // read (the cell recomputes at render time), but a predictable
    // JSON shape helps migrations. `created_time` / `modified_time`
    // read the record's `__created` / `__modified` metadata at render
    // time, so they belong in the same null-initialised group.
    case "formula":
    case "rollup":
    case "lookup":
    case "auto_number":
    case "created_time":
    case "modified_time":
      return null;
    // `user` is free text, so empty string (the default) is correct.
    default:
      return "";
  }
}
