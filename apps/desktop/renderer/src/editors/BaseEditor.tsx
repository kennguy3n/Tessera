import { useState, useCallback, useRef, useEffect, useMemo } from "react";

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

interface BaseEditorProps {
  content: string;
  onSave: (content: string) => void;
  autoSaveMs?: number;
}

export default function BaseEditor({
  content,
  onSave,
  autoSaveMs = 2000,
}: BaseEditorProps) {
  const [data, setData] = useState<BaseContent>(() => parseBaseContent(content));
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [showAddField, setShowAddField] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef(content);

  const debouncedSave = useCallback(
    (updated: BaseContent) => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        const json = JSON.stringify(updated);
        lastSavedRef.current = json;
        onSave(json);
      }, autoSaveMs);
    },
    [onSave, autoSaveMs],
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

  return (
    <div className="base-editor">
      <div className="base-toolbar">
        <button type="button" className="btn-sm" onClick={addRecord}>
          + Record
        </button>
        <button type="button" className="btn-sm" onClick={() => setShowAddField(true)}>
          + Field
        </button>
      </div>

      {showAddField && <AddFieldDialog onAdd={addField} onCancel={() => setShowAddField(false)} />}

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

function parseBaseContent(content: string): BaseContent {
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
