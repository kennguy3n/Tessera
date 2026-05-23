import { useState, useCallback, useRef, useEffect, useMemo } from "react";
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

export type FieldType = "text" | "number" | "date" | "select" | "checkbox" | "url";

export interface BaseField {
  name: string;
  type: FieldType;
  options?: string[]; // for select type
}

export interface BaseContent {
  fields: BaseField[];
  records: Record<string, unknown>[];
}

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
  const [data, setData] = useState<BaseContent>(() => parseBaseContent(content));
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [showAddField, setShowAddField] = useState(false);
  // Active view kind plus per-view config (which field drives kanban
  // columns, which date drives the calendar, etc.). Both are
  // renderer concerns: they're NOT serialized into the artifact
  // JSON, so switching views never dirties the document.
  const [view, setView] = useState<BaseViewKind>("grid");
  const [viewConfig, setViewConfig] = useState<BaseViewConfig>(() =>
    defaultViewConfig(parseBaseContent(content).fields),
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

  const updateData = useCallback(
    (updated: BaseContent) => {
      setData(updated);
      debouncedSave(updated);
    },
    [debouncedSave],
  );

  const addField = useCallback(
    (name: string, type: FieldType) => {
      const updated: BaseContent = {
        fields: [...data.fields, { name, type }],
        records: data.records.map((r) => ({ ...r, [name]: getDefaultValue(type) })),
      };
      updateData(updated);
      setShowAddField(false);
    },
    [data, updateData],
  );

  const removeField = useCallback(
    (fieldName: string) => {
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
    const record: Record<string, unknown> = {};
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
      const record: Record<string, unknown> = {};
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
      const updated: BaseContent = {
        ...data,
        records: data.records.filter((_, i) => i !== index),
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

      {showAddField && <AddFieldDialog onAdd={addField} onCancel={() => setShowAddField(false)} />}

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
                <tr key={originalIndex}>
                  <td className="base-row-num">{ri + 1}</td>
                  {data.fields.map((field) => (
                    <td key={field.name} className="base-cell">
                      <CellInput
                        field={field}
                        value={record[field.name]}
                        onChange={(val) => updateCell(originalIndex, field.name, val)}
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
    </div>
  );
}

function CellInput({
  field,
  value,
  onChange,
}: {
  field: BaseField;
  value: unknown;
  onChange: (val: unknown) => void;
}) {
  switch (field.type) {
    case "checkbox":
      return (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case "number":
      return (
        <input
          type="number"
          className="base-cell-input"
          value={value != null ? String(value) : ""}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        />
      );
    case "date":
      return (
        <input
          type="date"
          className="base-cell-input"
          value={value != null ? String(value) : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "select":
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
    case "url":
      return (
        <input
          type="url"
          className="base-cell-input"
          value={value != null ? String(value) : ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://..."
        />
      );
    case "text":
    default:
      return (
        <input
          type="text"
          className="base-cell-input"
          value={value != null ? String(value) : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

function AddFieldDialog({
  onAdd,
  onCancel,
}: {
  onAdd: (name: string, type: FieldType) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("text");

  return (
    <div className="base-add-field-dialog">
      <input
        className="input"
        placeholder="Field name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <select
        className="input"
        value={type}
        onChange={(e) => setType(e.target.value as FieldType)}
      >
        <option value="text">Text</option>
        <option value="number">Number</option>
        <option value="date">Date</option>
        <option value="select">Select</option>
        <option value="checkbox">Checkbox</option>
        <option value="url">URL</option>
      </select>
      <button
        type="button"
        className="btn-sm"
        onClick={() => {
          if (name.trim()) onAdd(name.trim(), type);
        }}
      >
        Add
      </button>
      <button type="button" className="btn-sm" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function getDefaultValue(type: FieldType): unknown {
  switch (type) {
    case "checkbox":
      return false;
    case "number":
      return null;
    case "date":
      return "";
    default:
      return "";
  }
}

export function parseBaseContent(content: string): BaseContent {
  if (!content) {
    return {
      fields: [
        { name: "Name", type: "text" },
        { name: "Status", type: "text" },
      ],
      records: [{ Name: "", Status: "" }],
    };
  }
  try {
    const parsed = JSON.parse(content) as BaseContent;
    if (parsed.fields && Array.isArray(parsed.fields)) {
      return parsed;
    }
  } catch {
    // Not JSON
  }
  return {
    fields: [{ name: "Name", type: "text" }],
    records: [{ Name: content }],
  };
}
