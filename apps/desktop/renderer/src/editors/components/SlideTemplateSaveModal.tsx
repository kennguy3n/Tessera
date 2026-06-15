/**
 * "Save deck as template" / edit / import metadata modal.
 *
 * A thin form over {@link Modal} that collects the gallery metadata
 * (name, optional description, optional category) for a
 * {@link CustomSlideTemplateDraft}, then builds + persists it through
 * {@link useCustomSlideTemplates} on save. The deck itself is already
 * captured into `draft.content` by the caller — this component never
 * touches slide content, so it stays purely presentational.
 *
 * One component serves every entry point by varying the seeded draft +
 * dialog title:
 *   - Save current deck → a fresh draft with no id (new template).
 *   - Edit a template   → a draft carrying the template's id (in place).
 *   - Import a file      → a parsed draft with no id (mints a fresh id,
 *                          so an import never overwrites — review then
 *                          save, exactly like a duplicate).
 *
 * The host (`SlideEditor`) mounts this only while open, so the form
 * seeds its draft once from `initialDraft` in the `useState` initialiser
 * — no render-phase re-seed needed.
 */

import { useState } from "react";
import Modal from "../../components/Modal";
import {
  MAX_TEMPLATE_DESCRIPTION,
  MAX_TEMPLATE_LABEL,
  type CustomSlideTemplate,
  type CustomSlideTemplateDraft,
} from "../customSlideTemplates";
import { TEMPLATE_CATEGORIES } from "../slideTemplates";
import { useCustomSlideTemplates } from "../useCustomSlideTemplates";

export interface SlideTemplateSaveModalProps {
  isOpen: boolean;
  /** Seed draft for the current mode (save / edit / import). */
  initialDraft: CustomSlideTemplateDraft;
  /** Dialog title reflecting the mode (e.g. "Save deck as template"). */
  title: string;
  /** Called with the persisted template after a successful save. */
  onSaved: (template: CustomSlideTemplate) => void;
  onClose: () => void;
}

export function SlideTemplateSaveModal({
  isOpen,
  initialDraft,
  title,
  onSaved,
  onClose,
}: SlideTemplateSaveModalProps) {
  const { saveTemplate } = useCustomSlideTemplates();

  const [draft, setDraft] = useState<CustomSlideTemplateDraft>(
    () => initialDraft,
  );
  const [errors, setErrors] = useState<string[]>([]);

  const patch = (next: Partial<CustomSlideTemplateDraft>) =>
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

  const slideCount = draft.content.slides.length;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      closeOnOverlayClick={false}
    >
      <div
        className="slide-template-save"
        data-testid="slide-template-save-modal"
      >
        <p className="ai-panel-hint">
          {slideCount === 1
            ? "Saves this 1-slide deck"
            : `Saves this ${slideCount}-slide deck`}{" "}
          — its layouts, theme, and styling — as a reusable template in your
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
            placeholder="e.g. Quarterly business review"
            data-testid="slide-template-name"
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
            placeholder="Optional — what this deck is for"
            data-testid="slide-template-description"
            aria-label="Template description"
          />
        </label>

        <label className="ai-panel-field">
          <span>Category</span>
          <select
            className="input"
            value={draft.category}
            onChange={(e) => patch({ category: e.target.value })}
            data-testid="slide-template-category"
            aria-label="Template category"
          >
            <option value="">Uncategorised</option>
            {TEMPLATE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>

        {errors.length > 0 && (
          <div
            className="ai-panel-error slide-template-errors"
            role="alert"
            data-testid="slide-template-errors"
          >
            <ul>
              {errors.map((err, i) => (
                <li key={i} data-testid="slide-template-error">
                  {err}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="ai-panel-run-row slide-template-save-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            data-testid="slide-template-save"
          >
            Save template
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            data-testid="slide-template-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
