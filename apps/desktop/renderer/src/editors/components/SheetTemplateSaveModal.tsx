/**
 * "Save sheet as template" / edit / import metadata modal.
 *
 * A thin form over {@link Modal} that collects the gallery metadata
 * (name, optional description, optional category) for a
 * {@link CustomSheetTemplateDraft}, then builds + persists it through
 * {@link useCustomSheetTemplates} on save. The sheet itself is already
 * captured into `draft.content` by the caller — this component never
 * touches sheet content, so it stays purely presentational.
 *
 * One component serves every entry point by varying the seeded draft +
 * dialog title:
 *   - Save current sheet → a fresh draft with no id (new template).
 *   - Edit a template    → a draft carrying the template's id (in place).
 *   - Import a file       → a parsed draft with no id (mints a fresh id,
 *                           so an import never overwrites — review then
 *                           save, exactly like a duplicate).
 *
 * The host (`SheetEditor`) mounts this only while open, so the form seeds
 * its draft once from `initialDraft` in the `useState` initialiser — no
 * render-phase re-seed needed.
 */

import { useState } from "react";
import Modal from "../../components/Modal";
import {
  MAX_TEMPLATE_DESCRIPTION,
  MAX_TEMPLATE_LABEL,
  type CustomSheetTemplate,
  type CustomSheetTemplateDraft,
} from "../customSheetTemplates";
import { SHEET_TEMPLATE_CATEGORIES } from "../sheetTemplates";
import { useCustomSheetTemplates } from "../useCustomSheetTemplates";

export interface SheetTemplateSaveModalProps {
  isOpen: boolean;
  /** Seed draft for the current mode (save / edit / import). */
  initialDraft: CustomSheetTemplateDraft;
  /** Dialog title reflecting the mode (e.g. "Save sheet as template"). */
  title: string;
  /** Called with the persisted template after a successful save. */
  onSaved: (template: CustomSheetTemplate) => void;
  onClose: () => void;
}

export function SheetTemplateSaveModal({
  isOpen,
  initialDraft,
  title,
  onSaved,
  onClose,
}: SheetTemplateSaveModalProps) {
  const { saveTemplate } = useCustomSheetTemplates();

  const [draft, setDraft] = useState<CustomSheetTemplateDraft>(
    () => initialDraft,
  );
  const [errors, setErrors] = useState<string[]>([]);

  const patch = (next: Partial<CustomSheetTemplateDraft>) =>
    setDraft((d) => ({ ...d, ...next }));

  const handleSave = () => {
    const result = saveTemplate(draft);
    if (result.ok) {
      onSaved(result.template);
      onClose();
    } else {
      setErrors(result.errors);
    }
  };

  const rowCount = draft.content.rows.length;
  const colCount = draft.content.columns.length;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      closeOnOverlayClick={false}
    >
      <div
        className="sheet-template-save"
        data-testid="sheet-template-save-modal"
      >
        <p className="ai-panel-hint">
          {`Saves this ${rowCount} × ${colCount}`} sheet — its headers,
          formulas, number formats, and styling — as a reusable template in your
          gallery.
        </p>

        <label className="ai-panel-field">
          <span>Name</span>
          <input
            type="text"
            className="input"
            value={draft.label}
            maxLength={MAX_TEMPLATE_LABEL}
            onChange={(e) => patch({ label: e.target.value })}
            placeholder="e.g. Quarterly budget"
            data-testid="sheet-template-name"
            aria-label="Template name"
            autoFocus
          />
        </label>

        <label className="ai-panel-field">
          <span>Description</span>
          <input
            type="text"
            className="input"
            value={draft.description}
            maxLength={MAX_TEMPLATE_DESCRIPTION}
            onChange={(e) => patch({ description: e.target.value })}
            placeholder="Optional — what this sheet is for"
            data-testid="sheet-template-description"
            aria-label="Template description"
          />
        </label>

        <label className="ai-panel-field">
          <span>Category</span>
          <select
            className="input"
            value={draft.category}
            onChange={(e) => patch({ category: e.target.value })}
            data-testid="sheet-template-category"
            aria-label="Template category"
          >
            <option value="">Uncategorised</option>
            {SHEET_TEMPLATE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>

        {errors.length > 0 && (
          <div
            className="ai-panel-error sheet-template-errors"
            role="alert"
            data-testid="sheet-template-errors"
          >
            <ul>
              {errors.map((err, i) => (
                <li key={i} data-testid="sheet-template-error">
                  {err}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="ai-panel-run-row sheet-template-save-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            data-testid="sheet-template-save"
          >
            Save template
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            data-testid="sheet-template-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
