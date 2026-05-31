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
  lookupValues,
  computeAutoNumber,
  isReservedFieldName,
} from "./baseEditorHelpers";
import {
  evaluateBaseFormula,
  formatFormulaResult,
} from "./baseFormulaEngine";
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

  // Sync external content prop changes (e.g., version restore)
  useEffect(() => {
    if (content !== lastSavedRef.current) {
      setData(parseBaseContent(content));
      lastSavedRef.current = content;
    }
  }, [content]);

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

  const removeField = useCallback(
    (fieldName: string) => {
      // `id` is the stable record identifier; deleting it would
      // strip every record's id and orphan every linked_record
      // reference on the next save/reload cycle.
      if (isReservedFieldName(fieldName)) return;
      const updated: BaseContent = {
        fields: data.fields.filter((f) => f.name !== fieldName),
        records: data.records.map((r) => {
          const copy = { ...r };
          delete copy[fieldName];
          return copy;
        }),
      };
      updateData(updated);
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
    },
    [data, updateData],
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

  const filteredAndSorted = useMemo(() => {
    let records = [...data.records];

    // Apply filters
    for (const [field, filterVal] of Object.entries(filters)) {
      if (!filterVal.trim()) continue;
      const lower = filterVal.toLowerCase();
      records = records.filter((r) => {
        const val = r[field];
        if (val == null) return false;
        return String(val).toLowerCase().includes(lower);
      });
    }

    // Apply sort
    if (sortField) {
      records.sort((a, b) => {
        const va = a[sortField] ?? "";
        const vb = b[sortField] ?? "";
        const cmp = String(va).localeCompare(String(vb), undefined, { numeric: true });
        return sortDir === "asc" ? cmp : -cmp;
      });
    }

    return records;
  }, [data.records, filters, sortField, sortDir]);

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

      {view === "kanban" && <KanbanView {...viewProps} />}
      {view === "calendar" && <CalendarView {...viewProps} />}
      {view === "timeline" && <TimelineView {...viewProps} />}
      {view === "gallery" && <GalleryView {...viewProps} />}

      {view === "grid" && (
      <div className="base-grid-wrapper">
        <table className="base-grid">
          <thead>
            <tr>
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
                    placeholder="Filter..."
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
              const originalIndex = data.records.indexOf(record);
              return (
                <tr key={record.id || originalIndex}>
                  <td className="base-row-num">{ri + 1}</td>
                  {data.fields.map((field) => (
                    <td key={field.name} className="base-cell">
                      <CellInput
                        field={field}
                        value={record[field.name]}
                        record={record}
                        recordIndex={originalIndex}
                        allRecords={data.records}
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
  onChange,
}: CellInputProps) {
  const links: string[] = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
  const linkedRecords = resolveLinkedRecords(links, allRecords);
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

function RollupCell({ field, record, allFields, allRecords }: CellInputProps) {
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
  const linkedRecords = resolveLinkedRecords(ids, allRecords);
  const values = linkedRecords.map((r) => r[targetFieldName]);
  return (
    <span className="base-cell-readonly">
      {aggregateValues(values, aggregation)}
    </span>
  );
}

function LookupCell({ field, record, allFields, allRecords }: CellInputProps) {
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
  const linkedRecords = resolveLinkedRecords(ids, allRecords);
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
