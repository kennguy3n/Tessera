/**
 * Pure, React-free helpers for the Base **form** view.
 *
 * The form view renders one labelled input per *fillable* field and,
 * on submit, turns the collected raw input values into a typed record
 * prefill handed to `onAddRecordWith`. Keeping the value coercion here
 * (rather than inline in the component) lets it unit-test in isolation
 * and keeps the wire shape identical to what `BaseEditor.getDefaultValue`
 * would have produced for each field type.
 */
import type { BaseField, FieldType } from "../baseEditorTypes";

/** Raw, in-progress form state keyed by field name. */
export type FormValues = Record<string, unknown>;

/**
 * Field types whose values are *computed* or *auto-generated* and so
 * must never be collected from the form (the engine derives them at
 * render time / on insert). Mirrors the computed set in
 * `BaseEditor.getDefaultValue`.
 */
const NON_FILLABLE: ReadonlySet<FieldType> = new Set<FieldType>([
  "formula",
  "rollup",
  "lookup",
  "auto_number",
]);

/** Field types stored as `string[]` (rendered as comma-separated text). */
const ARRAY_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  "multi_select",
  "linked_record",
  "attachment",
]);

/** Numeric field types stored as `number | null`. */
const NUMERIC_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  "number",
  "currency",
  "percent",
  "rating",
  "duration",
]);

/** Whether the field can be filled in by the form UI. */
export function isFormEditableField(field: BaseField): boolean {
  return !NON_FILLABLE.has(field.type);
}

/** The fillable subset of a Base's fields, in declaration order. */
export function fillableFields(fields: BaseField[]): BaseField[] {
  return fields.filter(isFormEditableField);
}

/** The blank input value a freshly-reset form shows for `type`. */
export function emptyFormInput(type: FieldType): unknown {
  if (type === "checkbox") return false;
  if (ARRAY_TYPES.has(type)) return [];
  // Numbers are held as strings while editing so a half-typed "-" or
  // "" is representable; they coerce to `number | null` on submit.
  return "";
}

/** Build the initial form state for `fields` (fillable fields only). */
export function initialFormValues(fields: BaseField[]): FormValues {
  const out: FormValues = {};
  for (const field of fillableFields(fields)) {
    out[field.name] = emptyFormInput(field.type);
  }
  return out;
}

/**
 * Coerce one raw input value into the typed value stored on a record.
 * Numbers parse to `number | null` (blank ⇒ null), checkboxes to
 * booleans, the array types to `string[]`, everything else to a
 * trimmed-as-typed string.
 */
export function coerceFormValue(field: BaseField, raw: unknown): unknown {
  if (NUMERIC_TYPES.has(field.type)) {
    const s = String(raw ?? "").trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (field.type === "checkbox") return Boolean(raw);
  if (ARRAY_TYPES.has(field.type)) {
    if (Array.isArray(raw)) return raw.map((v) => String(v));
    // Allow a comma-separated string fallback for text-entry array UIs.
    return String(raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return String(raw ?? "");
}

/**
 * Turn the collected {@link FormValues} into the typed prefill object
 * `onAddRecordWith` expects. Only fillable fields are included; the
 * editor fills computed/auto fields with their own defaults.
 */
export function buildRecordPrefill(
  fields: BaseField[],
  values: FormValues,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fillableFields(fields)) {
    out[field.name] = coerceFormValue(field, values[field.name]);
  }
  return out;
}

/**
 * Whether a form has at least one non-empty fillable value — used to
 * disable the submit button on a pristine/blank form so the user can't
 * spawn an all-default empty record by accident.
 */
export function formHasInput(fields: BaseField[], values: FormValues): boolean {
  for (const field of fillableFields(fields)) {
    const v = values[field.name];
    if (field.type === "checkbox") {
      if (v === true) return true;
    } else if (Array.isArray(v)) {
      if (v.length > 0) return true;
    } else if (String(v ?? "").trim() !== "") {
      return true;
    }
  }
  return false;
}
