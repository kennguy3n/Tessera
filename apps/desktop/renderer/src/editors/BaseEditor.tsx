import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import KanbanView from "./baseviews/KanbanView";
import CalendarView from "./baseviews/CalendarView";
import TimelineView from "./baseviews/TimelineView";
import GalleryView from "./baseviews/GalleryView";
import {
  defaultViewConfig,
  type BaseViewConfig,
  type BaseViewKind,
  type BaseViewProps,
} from "./baseviews/types";
import {
  parseBaseContent,
  makeRecordId,
  resolveLinkedRecords,
  aggregateValues,
  buildRecordIndex,
  lookupValues,
  computeAutoNumber,
  isReservedFieldName,
  matchesFilter,
  applyFieldRename,
  isComputedFieldType,
  VIEW_CONFIG_FIELD_POINTERS,
} from "./baseEditorHelpers";
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
  BaseRecord,
  FieldType,
  RollupAggregation,
} from "./baseEditorTypes";

export type { FieldType, BaseField, BaseContent, BaseRecord } from "./baseEditorTypes";
export type { BaseViewConfig, BaseViewKind } from "./baseviews/types";

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
  const [data, setData] = useState<BaseContent>(() => parseBaseContent(content));
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
    (updated: BaseContent) => {
      const json = JSON.stringify(updated);
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
  //
  // Two independent reasons to dismiss the modal:
  //   (1) the target record was deleted out from under us; or
  //   (2) the target field was removed (via the Manage Fields
  //       dialog or the column-header ×).
  // Without check (2), the modal would keep rendering against the
  // field name we captured at open-time while the user sees the
  // field gone from the grid behind the modal — and any edit
  // committed via the open modal would silently *re-add* the field
  // key to that record, undoing the field removal partially.
  //
  // The external content-sync useEffect lives further down (under
  // `dropStaleViewState`) so its dependency array can capture that
  // callback without hitting TDZ. Effects fire in commit-time order
  // regardless of declaration order, so the placement has no
  // functional consequence.
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

  const updateData = useCallback(
    (updated: BaseContent) => {
      setData(updated);
      debouncedSave(updated);
    },
    [debouncedSave],
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
      const parsed = parseBaseContent(content);
      setData(parsed);
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
      records: [...data.records, record],
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
        records: [...data.records, record],
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
      exportBaseCsv(data),
      "text/csv;charset=utf-8",
    );
  }, [data, triggerDownload]);

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
      updateData(next);
      setImportDialog(null);
      setSelectedIds(new Set());
      dropStaleViewState(next.fields);
    },
    [data.fields, updateData, dropStaleViewState],
  );

  const handleImportJson = useCallback(
    (text: string) => {
      const next = parseJsonToBase(text);
      updateData(next);
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
          i === recordIndex ? { ...r, [fieldName]: value } : r,
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

  // Pre-built `id -> BaseRecord` map. `resolveLinkedRecords` (called
  // from `RollupCell`, `LookupCell`, `LinkedRecordCell` and inside
  // `formatValueForCsv` for the filter / sort / export pipelines)
  // previously rebuilt `new Map(allRecords.map(r => [r.id, r]))` on
  // every call — O(N) per linked / rollup / lookup cell per render,
  // i.e. O(N * M) per render for the whole grid. Lifting that map
  // into a single per-render `useMemo` keyed on `data.records` and
  // threading the read-only view through `CellInputProps.recordsById`
  // makes the resolve step O(1) per cell. The map and the
  // `recordIndexById` map below share the same dependency array, so
  // they invalidate together whenever records add / remove / reorder.
  const recordsById = useMemo(
    () => buildRecordIndex(data.records),
    [data.records],
  );

  const filteredAndSorted = useMemo(() => {
    let records = [...data.records];

    // Apply per-field filters via the type-aware matcher.
    // Computed types (formula / rollup / lookup / auto_number)
    // need a rendered display string — their stored value is
    // either a source expression (`formula`) or `null`
    // (`auto_number`), so comparing it directly would always
    // miss. `formatValueForCsv` already computes the same display
    // string the cell renders, so threading it through here keeps
    // the filter, sort, CSV export, and cell render in lock-step.
    //
    // We thread the memoised `recordsById` map through to
    // `formatValueForCsv` so the rollup / lookup / linked_record
    // branches inside the formatter skip the O(N) `Map(allRecords)`
    // rebuild they would otherwise do on every cell. With many
    // computed columns active, this turns the filter pass from
    // O(N^2 * M) into O(N * M).
    for (const [fieldName, filterVal] of Object.entries(filters)) {
      if (!filterVal.trim()) continue;
      const field = data.fields.find((f) => f.name === fieldName);
      if (!field) continue;
      records = records.filter((r) => {
        const display = isComputedFieldType(field.type)
          ? formatValueForCsv(field, r, data.records, data.fields, recordsById)
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
    // Sort comparators are called O(N log N) times by the engine,
    // and each call previously re-evaluated `formatValueForCsv` for
    // both operands — so a 1000-row table with one computed sort
    // column does ~10000 formula evaluations per sort. We avoid
    // that by lifting the display string into a per-record cache
    // (`Map<record.id, string>`) computed eagerly *before* `sort`
    // and consulted from the comparator. Cache builds in O(N) and
    // collapses comparator cost to O(N log N) hash lookups.
    if (sortField) {
      const sortFieldDef = data.fields.find((f) => f.name === sortField);
      const sortIsComputed =
        sortFieldDef !== undefined && isComputedFieldType(sortFieldDef.type);
      let displayFor: (r: BaseRecord) => string;
      if (sortIsComputed && sortFieldDef) {
        const cache = new Map<string, string>();
        for (const r of records) {
          cache.set(
            r.id,
            formatValueForCsv(
              sortFieldDef,
              r,
              data.records,
              data.fields,
              recordsById,
            ),
          );
        }
        displayFor = (r) => cache.get(r.id) ?? "";
      } else {
        displayFor = (r) => {
          const raw = r[sortField];
          return raw == null ? "" : String(raw);
        };
      }
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
  }, [data.records, data.fields, filters, sortField, sortDir, recordsById]);

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

  return (
    <div className="base-editor">
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

      {view === "grid" && (
      <div className="base-grid-wrapper">
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
            {filteredAndSorted.map((record, ri) => {
              // O(1) lookup via the pre-built map; falls back to
              // -1 if a row somehow leaks through with no id (legacy
              // hand-edited JSON), which `removeRecord` / `updateCell`
              // are robust to.
              const originalIndex = recordIndexById.get(record.id) ?? -1;
              const isSelected = selectedIds.has(record.id);
              return (
                <tr
                  key={record.id || originalIndex}
                  className={isSelected ? "base-row-selected" : undefined}
                >
                  <td className="base-select-cell">
                    <input
                      type="checkbox"
                      aria-label={`Select record ${ri + 1}`}
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
                  <td className="base-row-num">{ri + 1}</td>
                  {data.fields.map((field) => (
                    <td key={field.name} className="base-cell">
                      <CellInput
                        field={field}
                        value={record[field.name]}
                        record={record}
                        recordIndex={originalIndex}
                        allRecords={data.records}
                        recordsById={recordsById}
                        allFields={data.fields}
                        onChange={(val) => updateCell(originalIndex, field.name, val)}
                        onExpand={() =>
                          setExpandedCell({
                            recordId: record.id,
                            fieldName: field.name,
                          })
                        }
                      />
                    </td>
                  ))}
                  <td className="base-actions-cell">
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
            })}
          </tbody>
        </table>
      </div>
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
  /**
   * Per-render `id -> BaseRecord` index built once in `BaseEditor`
   * via `useMemo(() => buildRecordIndex(data.records), [data.records])`
   * and threaded down here. `LinkedRecordCell`, `RollupCell`, and
   * `LookupCell` pass it to `resolveLinkedRecords` instead of letting
   * that helper rebuild `new Map(allRecords.map(...))` per call. With
   * N records and M computed columns this collapses M*O(N) per render
   * into O(N) one-time per render. The map is wrapped in a
   * `ReadonlyMap` to make accidental mutation impossible -- cells
   * downstream only ever `.get(id)` from it.
   */
  recordsById: ReadonlyMap<string, BaseRecord>;
  allFields: BaseField[];
  onChange: (val: unknown) => void;
  onExpand?: () => void;
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

function DateCell({ value, onChange }: CellInputProps) {
  return (
    <input
      type="date"
      className="base-cell-input"
      value={value != null ? String(value) : ""}
      onChange={(e) => onChange(e.target.value)}
    />
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

/**
 * Custom `React.memo` comparator for read-only computed cells
 * (`FormulaCell` / `RollupCell` / `LookupCell`). Compares only the
 * props these cells actually consume (`field`, `record`, `allFields`,
 * `recordsById`), and deliberately **ignores** `onChange` / `onExpand`
 * because they're constructed inline in the grid render — a fresh
 * closure per cell per render. Without skipping them, the default
 * shallow comparator would short-circuit `false` on every render and
 * defeat the memo entirely, re-running `evaluateBaseFormula` /
 * `aggregateValues` / `lookupValues` for every cell in the grid on
 * every unrelated keystroke (Devin Review PR #84 ANALYSIS-0001).
 *
 * The structural prop refs (`field`, `record`, `allFields`,
 * `recordsById`) all flow through `useMemo` / direct array refs at
 * the `BaseEditor` level — a no-op render keeps them stable, so the
 * comparator returns `true` and the cell skips re-render entirely.
 *
 * We deliberately also ignore `value`, `allRecords`, and `recordIndex`:
 * computed cells derive their displayed value from `record` +
 * `recordsById` (not the `value` prop, which is the raw record field
 * — same data, derived differently); `allRecords` is upstream of
 * `recordsById` (any change to one forces a new ref of the other);
 * and `recordIndex` is a render-position index that never affects the
 * computed output.
 */
const computedCellPropsEqual = (
  prev: CellInputProps,
  next: CellInputProps,
): boolean =>
  prev.field === next.field &&
  prev.record === next.record &&
  prev.allFields === next.allFields &&
  prev.recordsById === next.recordsById;

/**
 * Discriminated result returned by the `useMemo` inside `RollupCell` /
 * `LookupCell`. Using an `{ ok: true | false }` tag instead of a magic
 * `"#REF!"` string sentinel removes the (theoretical) ambiguity that
 * occurs when an aggregated value legitimately equals the literal
 * `"#REF!"` — e.g. a `CONCAT` rollup over a column where a record's
 * target value is the string `"#REF!"`. Devin Review PR #84
 * ANALYSIS-0005 flagged the collision.
 */
type ComputedCellResult = { ok: true; value: string | null } | { ok: false };

const FormulaCell = React.memo(function FormulaCell({
  field,
  record,
  allFields,
}: CellInputProps) {
  // Read-only: computed at render time from the live record values.
  // Pass the current field name so the engine's cycle detector can
  // catch self-references and mutual recursion between formula
  // fields before the JS call stack overflows.
  //
  // The compute is memoised so an unrelated render (e.g., another
  // field's edit, or a parent re-render) doesn't re-evaluate every
  // formula cell in the grid. We key on the live `record`, the live
  // `allFields` (formulas may reference siblings whose values feed
  // into the result), and the formula source string itself. Because
  // `BaseEditor` rebuilds `data.fields` / a single record only when
  // they actually change, ref-equality of these inputs is the right
  // cache key — a no-op render keeps the same refs and skips the
  // formula engine entirely. The outer `React.memo` uses the
  // `computedCellPropsEqual` comparator (above) so the unstable
  // `onChange` / `onExpand` callbacks the grid constructs inline
  // don't defeat the memo's short-circuit.
  const src = field.formula ?? "";
  const result = useMemo(
    () => evaluateBaseFormula(src, allFields, record, field.name),
    [src, allFields, record, field.name],
  );
  return (
    <span
      className="base-cell-readonly"
      title={`= ${src}`}
      style={{ color: "var(--color-text-secondary, #6b7280)" }}
    >
      {formatFormulaResult(result)}
    </span>
  );
}, computedCellPropsEqual);

function LinkedRecordCell({
  field,
  value,
  record,
  allRecords,
  recordsById,
  onChange,
}: CellInputProps) {
  const links: string[] = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
  // Resolve via the memoised `recordsById` index instead of letting
  // `resolveLinkedRecords` rebuild the lookup map per cell. The
  // helper supports either an array or a `ReadonlyMap` so this is a
  // drop-in optimisation without altering semantics.
  const linkedRecords = resolveLinkedRecords(links, recordsById);
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
          {allRecords
            // Exclude already-linked records and the current record
            // itself — a record linking to itself causes rollup /
            // lookup to include its own field values, which is
            // almost never what the user wants.
            .filter((r) => r.id !== record.id && !links.includes(r.id))
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

const RollupCell = React.memo(function RollupCell({
  field,
  record,
  allFields,
  recordsById,
}: CellInputProps) {
  // rollup follows the `linkedField` link from THIS record, then
  // aggregates `targetField` across the linked records.
  //
  // Resolution goes through the memoised `recordsById` index so
  // every rollup cell in the grid shares one map instead of building
  // its own per render. The aggregate is wrapped in `useMemo` keyed
  // on the inputs that actually feed into the result — if a parent
  // re-renders without touching this record or any sibling field
  // definition, we hit the cache.
  //
  // The aggregated result uses the `ComputedCellResult` discriminated
  // union (rather than a `"#REF!"` string sentinel) so a legitimate
  // aggregated value of the literal `"#REF!"` (e.g. a `CONCAT` over a
  // column containing the literal string) cannot collide with the
  // misconfiguration error state.
  const linkedFieldName = field.linkedField;
  const targetFieldName = field.targetField;
  const aggregation: RollupAggregation = field.aggregation ?? "SUM";
  const linkedFieldDef = useMemo(
    () =>
      linkedFieldName
        ? allFields.find((f) => f.name === linkedFieldName)
        : undefined,
    [allFields, linkedFieldName],
  );
  const aggregated = useMemo<ComputedCellResult>(() => {
    if (!linkedFieldName || !targetFieldName)
      return { ok: true, value: null };
    if (!linkedFieldDef || linkedFieldDef.type !== "linked_record") {
      return { ok: false };
    }
    const ids = record[linkedFieldName];
    const linkedRecords = resolveLinkedRecords(ids, recordsById);
    const values = linkedRecords.map((r) => r[targetFieldName]);
    return { ok: true, value: aggregateValues(values, aggregation) };
  }, [
    linkedFieldName,
    targetFieldName,
    linkedFieldDef,
    record,
    recordsById,
    aggregation,
  ]);
  if (!linkedFieldName || !targetFieldName) {
    return <span className="base-cell-readonly">—</span>;
  }
  if (!aggregated.ok) {
    return (
      <span
        className="base-cell-readonly"
        title={`linkedField "${linkedFieldName}" is not a linked_record field`}
      >
        #REF!
      </span>
    );
  }
  return <span className="base-cell-readonly">{aggregated.value}</span>;
}, computedCellPropsEqual);

const LookupCell = React.memo(function LookupCell({
  field,
  record,
  allFields,
  recordsById,
}: CellInputProps) {
  // Mirror of `RollupCell` minus the aggregation step — same
  // memoisation strategy: shared `recordsById` index + `useMemo`
  // gating compute on the inputs that genuinely participate. Uses
  // the same `ComputedCellResult` discriminated union as RollupCell
  // so a legitimate lookup value of the literal `"#REF!"` cannot
  // collide with the misconfiguration error state.
  const linkedFieldName = field.linkedField;
  const targetFieldName = field.targetField;
  const linkedFieldDef = useMemo(
    () =>
      linkedFieldName
        ? allFields.find((f) => f.name === linkedFieldName)
        : undefined,
    [allFields, linkedFieldName],
  );
  const looked = useMemo<ComputedCellResult>(() => {
    if (!linkedFieldName || !targetFieldName)
      return { ok: true, value: null };
    if (!linkedFieldDef || linkedFieldDef.type !== "linked_record") {
      return { ok: false };
    }
    const ids = record[linkedFieldName];
    const linkedRecords = resolveLinkedRecords(ids, recordsById);
    return { ok: true, value: lookupValues(linkedRecords, targetFieldName) };
  }, [
    linkedFieldName,
    targetFieldName,
    linkedFieldDef,
    record,
    recordsById,
  ]);
  if (!linkedFieldName || !targetFieldName) {
    return <span className="base-cell-readonly">—</span>;
  }
  if (!looked.ok) {
    return (
      <span
        className="base-cell-readonly"
        title={`linkedField "${linkedFieldName}" is not a linked_record field`}
      >
        #REF!
      </span>
    );
  }
  return <span className="base-cell-readonly">{looked.value}</span>;
}, computedCellPropsEqual);

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

function LongTextCell({ value, onChange, onExpand }: CellInputProps) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: "0.25rem" }}>
      <textarea
        className="base-cell-input base-cell-longtext"
        value={value != null ? String(value) : ""}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        style={{ flex: 1, resize: "vertical", minHeight: "1.5rem" }}
      />
      <button
        type="button"
        className="btn-sm"
        title="Expand"
        onClick={onExpand}
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
  onAdd,
  onCancel,
}: {
  existingFields: BaseField[];
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
  const [currencySymbol, setCurrencySymbol] = useState("$");
  const [percentPrecision, setPercentPrecision] = useState("0");
  const [nameError, setNameError] = useState<string | null>(null);

  const linkFieldChoices = existingFields.filter(
    (f) => f.type === "linked_record",
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
    }
    if (type === "rollup" || type === "lookup") {
      if (linkedField) field.linkedField = linkedField;
      if (targetField.trim()) field.targetField = targetField.trim();
      if (type === "rollup") field.aggregation = aggregation;
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
          </optgroup>
          <optgroup label="Computed">
            <option value="formula">Formula</option>
            <option value="linked_record">Linked record</option>
            <option value="rollup">Rollup</option>
            <option value="lookup">Lookup</option>
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
        <input
          className="input"
          placeholder="Display field on linked records (e.g. Name)"
          value={linkedDisplayField}
          onChange={(e) => setLinkedDisplayField(e.target.value)}
        />
      )}

      {(type === "rollup" || type === "lookup") && (
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          <select
            className="input"
            value={linkedField}
            onChange={(e) => setLinkedField(e.target.value)}
          >
            <option value="">Linked record field…</option>
            {linkFieldChoices.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
          <input
            className="input"
            placeholder="Target field on linked records"
            value={targetField}
            onChange={(e) => setTargetField(e.target.value)}
          />
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
    case "auto_number":
      return "e.g. >10";
    case "duration":
      // Duration is stored as integer minutes but rendered as h:mm,
      // so the filter accepts both formats — hint at the h:mm form
      // (which matches the cell display) since that's the
      // less-discoverable of the two. Devin Review PR #79 round 12
      // (ANALYSIS_…_0003) called out that the old "e.g. >10" hint
      // silently invited users to type ">1" against a 1:05 cell and
      // get ">1 minute" instead of the intended ">1 hour".
      return "e.g. >1:30";
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

  // If the field currently being edited disappears from `fields` (e.g.
  // an external code path removed it while this dialog was open),
  // clear the stale editing state. Without this, an `editingName`
  // referencing a deleted field would persist invisibly; if a new
  // field were later created with the same name (extremely unlikely
  // while the dialog is open, but possible) the editing UI would
  // reappear unexpectedly on that brand-new field. Defensive — matches
  // what the user would intuitively expect ("the row I was editing is
  // gone, so I'm no longer editing anything"). Devin Review PR #79
  // round 15 (ANALYSIS_…_0003).
  useEffect(() => {
    if (editingName === null) return;
    const stillExists = fields.some((f) => f.name === editingName);
    if (!stillExists) {
      setEditingName(null);
      setDraft("");
      setRenameError(null);
    }
  }, [fields, editingName]);

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
      .then((body) => {
        setText(body);
        // Programmatic `setText` does not fire the textarea's onChange
        // (controlled-input updates only clear the error on real user input),
        // so the symmetric clear has to live here. Otherwise a stale error
        // from a prior failed Import sticks under the textarea even though
        // the new file loaded cleanly. Devin Review PR #79 (BUG_…_0001).
        setError(null);
      })
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
    // Computed types: stored value is never read (the cell recomputes
    // at render time), but we initialise to null so the JSON shape is
    // predictable for migrations.
    case "formula":
    case "rollup":
    case "lookup":
    case "auto_number":
      return null;
    default:
      return "";
  }
}
