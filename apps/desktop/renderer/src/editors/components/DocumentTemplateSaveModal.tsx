/**
 * "Save as template" / edit / import metadata modal for documents.
 *
 * A thin form over {@link Modal} that collects the gallery metadata
 * (name, optional description, optional category) for a
 * {@link CustomDocumentTemplateDraft}, then builds + persists it through
 * {@link useCustomDocumentTemplates} on save. The document HTML itself is
 * already captured into `draft.content` by the caller — this component
 * never touches document content, so it stays purely presentational.
 *
 * One component serves every entry point by varying the seeded draft +
 * dialog title:
 *   - Save current document → a fresh draft with no id (new template).
 *   - Edit a template        → a draft carrying the template's id (in
 *                              place).
 *   - Import a file          → a parsed draft with no id (mints a fresh
 *                              id, so an import never overwrites — review
 *                              then save, exactly like a duplicate).
 *
 * The host (`DocumentEditor`) mounts this only while open, so the form
 * seeds its draft once from `initialDraft` in the `useState` initialiser
 * — no render-phase re-seed needed. Mirrors `SlideTemplateSaveModal`.
 */

import { useState } from "react";
import Modal from "../../components/Modal";
import {
  MAX_DOCUMENT_TEMPLATE_DESCRIPTION,
  MAX_DOCUMENT_TEMPLATE_LABEL,
  type CustomDocumentTemplate,
  type CustomDocumentTemplateDraft,
} from "../customDocumentTemplates";
import { DOCUMENT_TEMPLATE_CATEGORIES } from "../documentTemplates";
import { useCustomDocumentTemplates } from "../useCustomDocumentTemplates";

export interface DocumentTemplateSaveModalProps {
  isOpen: boolean;
  /** Seed draft for the current mode (save / edit / import). */
  initialDraft: CustomDocumentTemplateDraft;
  /** Dialog title reflecting the mode (e.g. "Save as template"). */
  title: string;
  /** Short hint describing what is being saved (e.g. selection vs. doc). */
  hint?: string;
  /** Called with the persisted template after a successful save. */
  onSaved: (template: CustomDocumentTemplate) => void;
  onClose: () => void;
}

export function DocumentTemplateSaveModal({
  isOpen,
  initialDraft,
  title,
  hint,
  onSaved,
  onClose,
}: DocumentTemplateSaveModalProps) {
  const { saveTemplate } = useCustomDocumentTemplates();

  const [draft, setDraft] = useState<CustomDocumentTemplateDraft>(
    () => initialDraft,
  );
  const [errors, setErrors] = useState<string[]>([]);

  const patch = (next: Partial<CustomDocumentTemplateDraft>) =>
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

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      closeOnOverlayClick={false}
    >
      <div
        className="document-template-save"
        data-testid="document-template-save-modal"
      >
        <p className="ai-panel-hint">
          {hint ??
            "Saves the current document — its headings, lists, tables, and styling — as a reusable template in your gallery."}
        </p>

        <label className="ai-panel-field">
          <span>Name</span>
          <input
            type="text"
            className="input"
            value={draft.label}
            maxLength={MAX_DOCUMENT_TEMPLATE_LABEL}
            onChange={(e) => patch({ label: e.target.value })}
            placeholder="e.g. Weekly status report"
            data-testid="document-template-name"
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
            maxLength={MAX_DOCUMENT_TEMPLATE_DESCRIPTION}
            onChange={(e) => patch({ description: e.target.value })}
            placeholder="Optional — what this document is for"
            data-testid="document-template-description"
            aria-label="Template description"
          />
        </label>

        <label className="ai-panel-field">
          <span>Category</span>
          <select
            className="input"
            value={draft.category}
            onChange={(e) => patch({ category: e.target.value })}
            data-testid="document-template-category"
            aria-label="Template category"
          >
            <option value="">Uncategorised</option>
            {DOCUMENT_TEMPLATE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>

        {errors.length > 0 && (
          <div
            className="ai-panel-error document-template-errors"
            role="alert"
            data-testid="document-template-errors"
          >
            <ul>
              {errors.map((err, i) => (
                <li key={i} data-testid="document-template-error">
                  {err}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="ai-panel-run-row document-template-save-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            data-testid="document-template-save"
          >
            Save template
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            data-testid="document-template-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
