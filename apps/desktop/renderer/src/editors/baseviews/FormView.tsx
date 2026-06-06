/**
 * Form view for Bases.
 *
 * A sixth presentation over the shared `BaseContent` model (alongside
 * Grid / Kanban / Calendar / Timeline / Gallery). Unlike the others it
 * is write-only: it renders a fillable form — one labelled control per
 * *fillable* field — and, on submit, creates a brand-new record via
 * `onAddRecordWith`. This is the data-entry counterpart to the Grid's
 * spreadsheet-style editing, handy for collecting records one at a time
 * without scrolling a wide table.
 *
 * Computed / auto fields (`formula`, `rollup`, `lookup`, `auto_number`)
 * are intentionally omitted from the form — the engine derives them.
 */
import { useMemo, useState } from "react";
import type { BaseField } from "../baseEditorTypes";
import type { BaseViewProps } from "./types";
import {
  buildRecordPrefill,
  fillableFields,
  formHasInput,
  initialFormValues,
  type FormValues,
} from "./formViewHelpers";

export default function FormView({ data, onAddRecordWith }: BaseViewProps) {
  const fields = useMemo(() => fillableFields(data.fields), [data.fields]);
  const [values, setValues] = useState<FormValues>(() =>
    initialFormValues(data.fields),
  );
  // Count of records created this session, surfaced as a lightweight
  // confirmation so the user knows the submit "took".
  const [submittedCount, setSubmittedCount] = useState(0);

  const setValue = (name: string, value: unknown) =>
    setValues((prev) => ({ ...prev, [name]: value }));

  const reset = () => setValues(initialFormValues(data.fields));

  const canSubmit = formHasInput(data.fields, values);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onAddRecordWith(buildRecordPrefill(data.fields, values));
    setSubmittedCount((n) => n + 1);
    reset();
  };

  return (
    <form
      className="base-form-view"
      data-testid="base-form-view"
      onSubmit={handleSubmit}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        maxWidth: "32rem",
        margin: "0 auto",
        padding: "1rem",
      }}
    >
      {fields.length === 0 ? (
        <p style={{ color: "var(--color-text-tertiary, #9ca3af)" }}>
          Add a field to start collecting records.
        </p>
      ) : (
        fields.map((field) => (
          <FieldControl
            key={field.name}
            field={field}
            value={values[field.name]}
            onChange={(v) => setValue(field.name, v)}
          />
        ))
      )}

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <button
          type="submit"
          className="btn-sm"
          disabled={!canSubmit}
          data-testid="base-form-submit"
        >
          Add record
        </button>
        <button
          type="button"
          className="btn-sm"
          onClick={reset}
          data-testid="base-form-clear"
        >
          Clear
        </button>
        {submittedCount > 0 && (
          <span
            role="status"
            aria-live="polite"
            data-testid="base-form-status"
            style={{ color: "var(--color-text-secondary, #6b7280)" }}
          >
            {submittedCount} record{submittedCount === 1 ? "" : "s"} added
          </span>
        )}
      </div>
    </form>
  );
}

interface FieldControlProps {
  field: BaseField;
  value: unknown;
  onChange: (value: unknown) => void;
}

/** Render the appropriate input control for a single fillable field. */
function FieldControl({ field, value, onChange }: FieldControlProps) {
  const label = (
    <span style={{ fontWeight: 500, fontSize: "0.875rem" }}>{field.name}</span>
  );
  const labelStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  };

  if (field.type === "checkbox") {
    return (
      <label
        style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}
      >
        <input
          type="checkbox"
          aria-label={field.name}
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
    );
  }

  if (field.type === "select") {
    return (
      <label style={labelStyle}>
        {label}
        <select
          aria-label={field.name}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">—</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.type === "multi_select") {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    const toggle = (opt: string, on: boolean) =>
      onChange(
        on ? [...selected, opt] : selected.filter((s) => s !== opt),
      );
    return (
      <fieldset style={{ ...labelStyle, border: "none", padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 500, fontSize: "0.875rem", padding: 0 }}>
          {field.name}
        </legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          {(field.options ?? []).map((opt) => (
            <label
              key={opt}
              style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}
            >
              <input
                type="checkbox"
                aria-label={`${field.name}: ${opt}`}
                checked={selected.includes(opt)}
                onChange={(e) => toggle(opt, e.target.checked)}
              />
              {opt}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  if (field.type === "long_text") {
    return (
      <label style={labelStyle}>
        {label}
        <textarea
          aria-label={field.name}
          rows={3}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    );
  }

  return (
    <label style={labelStyle}>
      {label}
      <input
        type={inputTypeFor(field)}
        aria-label={field.name}
        placeholder={placeholderFor(field)}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** HTML input `type` best matching a field's data type. */
function inputTypeFor(field: BaseField): string {
  switch (field.type) {
    case "number":
    case "currency":
    case "percent":
    case "rating":
    case "duration":
      return "number";
    case "date":
      return "date";
    case "email":
      return "email";
    case "url":
      return "url";
    case "phone":
      return "tel";
    default:
      return "text";
  }
}

/** Hint text for the array / structural types entered as plain text. */
function placeholderFor(field: BaseField): string | undefined {
  if (
    field.type === "linked_record" ||
    field.type === "attachment"
  ) {
    return "comma,separated";
  }
  return undefined;
}
