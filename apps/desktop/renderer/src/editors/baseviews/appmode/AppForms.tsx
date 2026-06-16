/**
 * App-mode data-entry form page.
 *
 * Promotes the builder's write-only {@link FormView} into the app
 * runtime: a single authored {@link BaseAppForm} is rendered over its
 * chosen field subset (or every fillable field when no subset is set),
 * and submitting creates a record in the form's table via the same
 * `onAddRecordWith` the rest of the editor uses.
 *
 * When `editing` is on, a compact configurator lets the author rename
 * the form, edit its description, and pick which fields appear.
 */
import FormView from "../FormView";
import { defaultViewConfig } from "../types";
import type { BaseContent } from "../../baseEditorTypes";
import type { BaseAppForm, BaseField, BaseTable } from "../../baseEditorTypes";
import { fillableFields } from "../formViewHelpers";
import { formFields } from "./appConfig";

export interface AppFormProps {
  form: BaseAppForm;
  table: BaseTable;
  data: BaseContent;
  editing: boolean;
  onAddRecordWith: (prefill: Record<string, unknown>) => void;
  onChange: (patch: Partial<BaseAppForm>) => void;
}

export default function AppForm({
  form,
  table,
  data,
  editing,
  onAddRecordWith,
  onChange,
}: AppFormProps) {
  const fillable = fillableFields(table.fields);
  const fields = formFields(table, form);
  // Subset fields drive a derived `BaseContent`; FormView reads only
  // `.fields` (never `.records`), so this is enough to scope the form
  // without copying the whole record set.
  const formData: BaseContent = { ...data, fields };

  return (
    <div className="base-app-form-page" data-testid="base-app-form-page">
      <div className="base-app-form-head">
        <div>
          <h2 className="base-app-form-title">{form.name}</h2>
          {form.description && (
            <p className="base-app-form-desc">{form.description}</p>
          )}
        </div>
      </div>

      {editing && (
        <FormConfigurator form={form} fillable={fillable} onChange={onChange} />
      )}

      {/* Remount on form / schema change so in-progress values reset. */}
      <FormView
        key={`${form.id}:${fields.map((f) => f.name).join(",")}`}
        data={formData}
        onUpdateCell={noop}
        onAddRecord={noopVoid}
        onAddRecordWith={onAddRecordWith}
        onRemoveRecord={noop}
        config={defaultViewConfig(fields)}
        onConfigChange={noopVoid}
      />
    </div>
  );
}

interface FormConfiguratorProps {
  form: BaseAppForm;
  fillable: BaseField[];
  onChange: (patch: Partial<BaseAppForm>) => void;
}

function FormConfigurator({ form, fillable, onChange }: FormConfiguratorProps) {
  const selected = new Set(form.fieldNames);
  const allShown = form.fieldNames.length === 0;

  const toggleField = (name: string, on: boolean) => {
    // Materialise the current effective order, then add / remove,
    // preserving table order. Empty subset means "all fields".
    const base = allShown ? fillable.map((f) => f.name) : form.fieldNames;
    const next = on
      ? [...base.filter((n) => n !== name), name]
      : base.filter((n) => n !== name);
    // Re-sort to table order so toggling never scrambles the layout.
    const ordered = fillable.map((f) => f.name).filter((n) => next.includes(n));
    onChange({ fieldNames: ordered });
  };

  return (
    <div className="base-app-form-config" data-testid="base-app-form-config">
      <label className="base-app-field">
        <span>Form name</span>
        <input
          type="text"
          value={form.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </label>
      <label className="base-app-field">
        <span>Description</span>
        <input
          type="text"
          value={form.description ?? ""}
          placeholder="Optional"
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </label>
      <fieldset className="base-app-form-fieldset">
        <legend>Fields</legend>
        <label className="base-app-form-check">
          <input
            type="checkbox"
            checked={allShown}
            onChange={() => onChange({ fieldNames: [] })}
            disabled={allShown}
          />
          <span>All fields</span>
        </label>
        {fillable.map((f) => (
          <label key={f.name} className="base-app-form-check">
            <input
              type="checkbox"
              checked={allShown || selected.has(f.name)}
              onChange={(e) => toggleField(f.name, e.target.checked)}
            />
            <span>{f.name}</span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}

// FormView shares the broad `BaseViewProps` surface; the app form only
// needs record creation, so the other handlers are inert no-ops.
function noop(): void {}
function noopVoid(): void {}
