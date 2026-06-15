/**
 * Base template gallery — pick a starter base, save the current base as a
 * reusable template, or import / export portable template files.
 *
 * A thin presentational shell over {@link Modal} that surfaces three
 * things in one place:
 *   - the built-in starters from {@link BASE_TEMPLATES} (CRM, project
 *     tracker, …);
 *   - the user's saved templates from {@link useCustomBaseTemplates};
 *   - a "save this base" form + file import/export.
 *
 * Applying a template REPLACES the editor's document (the Base editor
 * owns a single artifact and has no "new base" entry point), so the
 * gallery guards a non-empty base behind an inline confirm. Every applied
 * document is re-normalised through {@link instantiateBaseDocument} so a
 * built-in factory base and a stored user base are held to the exact same
 * validation as any loaded artifact.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Modal from "../../components/Modal";
import {
  BASE_TEMPLATES,
  BASE_TEMPLATE_CATEGORIES,
  type BaseTemplate,
} from "../baseTemplates";
import {
  baseTemplateFilename,
  instantiateBaseDocument,
  MAX_BASE_TEMPLATE_DESCRIPTION,
  MAX_BASE_TEMPLATE_LABEL,
  parseBaseTemplate,
  serializeBaseTemplate,
  type CustomBaseTemplate,
  type CustomBaseTemplateDraft,
} from "../customBaseTemplates";
import { useCustomBaseTemplates } from "../useCustomBaseTemplates";
import type { BaseDocument } from "../baseEditorTypes";

export interface BaseTemplateGalleryProps {
  isOpen: boolean;
  /** The live base, captured verbatim when saving "this base" as a template. */
  currentDoc: BaseDocument;
  /** Install a freshly-instantiated base as the editor's document. */
  onApply: (doc: BaseDocument) => void;
  onClose: () => void;
}

interface SaveForm {
  label: string;
  description: string;
  category: string;
}

const EMPTY_FORM: SaveForm = { label: "", description: "", category: "" };

/** Whether the live base holds any user data worth guarding before replace. */
function baseHasData(doc: BaseDocument): boolean {
  return doc.tables.some((t) => t.records.length > 0);
}

export function BaseTemplateGallery({
  isOpen,
  currentDoc,
  onApply,
  onClose,
}: BaseTemplateGalleryProps) {
  const { customTemplates, saveTemplate, deleteTemplate } =
    useCustomBaseTemplates();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [form, setForm] = useState<SaveForm>(EMPTY_FORM);
  const [saveErrors, setSaveErrors] = useState<string[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  // Id of the template awaiting a replace confirmation ("builtin:<id>" /
  // "custom:<id>"), or null when no confirmation is pending.
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  // Deferred document factory for the template awaiting confirmation. A
  // *thunk* (never an eagerly-built doc) so a built-in `template.build()`
  // runs exactly once — at apply time — instead of once on "Use" and again
  // on "Replace" (which minted a second, throwaway set of fresh ids).
  const pendingApply = useRef<(() => BaseDocument) | null>(null);

  const guardReplace = baseHasData(currentDoc);

  const apply = useCallback(
    (doc: BaseDocument) => {
      onApply(instantiateBaseDocument(doc));
      onClose();
    },
    [onApply, onClose],
  );

  const requestApply = useCallback(
    (key: string, factory: () => BaseDocument) => {
      if (guardReplace) {
        pendingApply.current = factory;
        setConfirmKey(key);
      } else {
        apply(factory());
      }
    },
    [guardReplace, apply],
  );

  const confirmApply = useCallback(() => {
    const factory = pendingApply.current;
    pendingApply.current = null;
    setConfirmKey(null);
    if (factory) apply(factory());
  }, [apply]);

  const cancelConfirm = useCallback(() => {
    pendingApply.current = null;
    setConfirmKey(null);
  }, []);

  // Keep the gallery self-contained: clear any pending replace confirmation
  // (and its deferred factory) whenever the modal is closed. Today the parent
  // also unmounts us on close, which would reset this state anyway — but not
  // relying on that means a stale, destructive "Replace base?" prompt can
  // never resurface if the gallery is ever kept mounted across open/close.
  useEffect(() => {
    if (!isOpen) {
      pendingApply.current = null;
      setConfirmKey(null);
    }
  }, [isOpen]);

  const handleSave = useCallback(() => {
    const draft: CustomBaseTemplateDraft = {
      label: form.label,
      description: form.description,
      category: form.category,
      content: currentDoc,
    };
    const result = saveTemplate(draft);
    if (result.ok) {
      setForm(EMPTY_FORM);
      setSaveErrors([]);
    } else {
      setSaveErrors(result.errors);
    }
  }, [form, currentDoc, saveTemplate]);

  const handleExport = useCallback((template: CustomBaseTemplate) => {
    const blob = new Blob([serializeBaseTemplate(template)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = baseTemplateFilename(template);
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, []);

  const handleImportFile = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      file
        .text()
        .then((body) => {
          const result = parseBaseTemplate(body);
          if (!result.ok) {
            setImportError(result.error);
            return;
          }
          const saved = saveTemplate(result.draft);
          if (saved.ok) {
            setImportError(null);
          } else {
            setImportError(
              saved.errors[0] ?? "This base template couldn’t be imported.",
            );
          }
        })
        .catch(() => setImportError("Couldn’t read that file."));
    },
    [saveTemplate],
  );

  const builtinByCategory = useMemo(() => {
    return BASE_TEMPLATE_CATEGORIES.map((category) => ({
      category,
      templates: BASE_TEMPLATES.filter((t) => t.category === category),
    })).filter((group) => group.templates.length > 0);
  }, []);

  const renderBuiltin = (template: BaseTemplate) => {
    const key = `builtin:${template.id}`;
    const confirming = confirmKey === key;
    return (
      <li key={template.id} className="base-template-card">
        <div className="base-template-card-body">
          <span className="base-template-card-title">{template.label}</span>
          <span className="base-template-card-desc">
            {template.description}
          </span>
        </div>
        {confirming ? (
          <div className="base-template-confirm" role="group">
            <span className="base-template-confirm-text">Replace base?</span>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={confirmApply}
              data-testid="base-template-confirm-apply"
            >
              Replace
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={cancelConfirm}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-sm base-template-use"
            onClick={() => requestApply(key, () => template.build())}
            data-testid="base-template-use-builtin"
          >
            Use
          </button>
        )}
      </li>
    );
  };

  const renderCustom = (template: CustomBaseTemplate) => {
    const key = `custom:${template.id}`;
    const confirming = confirmKey === key;
    return (
      <li key={template.id} className="base-template-card">
        <div className="base-template-card-body">
          <span className="base-template-card-title">{template.label}</span>
          {template.description && (
            <span className="base-template-card-desc">
              {template.description}
            </span>
          )}
        </div>
        {confirming ? (
          <div className="base-template-confirm" role="group">
            <span className="base-template-confirm-text">Replace base?</span>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={confirmApply}
              data-testid="base-template-confirm-apply"
            >
              Replace
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={cancelConfirm}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="base-template-card-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm base-template-use"
              onClick={() => requestApply(key, () => template.content)}
              data-testid="base-template-use-custom"
            >
              Use
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => handleExport(template)}
              aria-label={`Export ${template.label}`}
            >
              Export
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => deleteTemplate(template.id)}
              aria-label={`Delete ${template.label}`}
            >
              Delete
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Base templates"
      closeOnOverlayClick={false}
    >
      <div
        className="base-template-gallery"
        data-testid="base-template-gallery"
      >
        <section className="base-template-section">
          <h3 className="base-template-heading">Start from a template</h3>
          {builtinByCategory.map((group) => (
            <div key={group.category} className="base-template-group">
              <span className="base-template-group-label">
                {group.category}
              </span>
              <ul className="base-template-list">
                {group.templates.map(renderBuiltin)}
              </ul>
            </div>
          ))}
        </section>

        <section className="base-template-section">
          <div className="base-template-section-bar">
            <h3 className="base-template-heading">Your templates</h3>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => fileInputRef.current?.click()}
              data-testid="base-template-import"
            >
              Import file
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleImportFile}
              style={{ display: "none" }}
              data-testid="base-template-import-input"
            />
          </div>
          {importError && (
            <div className="ai-panel-error" role="alert">
              {importError}
            </div>
          )}
          {customTemplates.length === 0 ? (
            <p className="ai-panel-hint">
              Save the current base below, or import a{" "}
              <code>tessera.basetemplate</code> file.
            </p>
          ) : (
            <ul className="base-template-list">
              {customTemplates.map(renderCustom)}
            </ul>
          )}
        </section>

        <section className="base-template-section">
          <h3 className="base-template-heading">
            Save this base as a template
          </h3>
          <label className="ai-panel-field">
            <span>Name</span>
            <input
              type="text"
              className="input"
              value={form.label}
              maxLength={MAX_BASE_TEMPLATE_LABEL}
              onChange={(e) =>
                setForm((f) => ({ ...f, label: e.target.value }))
              }
              placeholder="e.g. Sales pipeline"
              data-testid="base-template-name"
              aria-label="Template name"
            />
          </label>
          <label className="ai-panel-field">
            <span>Description</span>
            <input
              type="text"
              className="input"
              value={form.description}
              maxLength={MAX_BASE_TEMPLATE_DESCRIPTION}
              onChange={(e) =>
                setForm((f) => ({ ...f, description: e.target.value }))
              }
              placeholder="Optional — what this base is for"
              data-testid="base-template-description"
              aria-label="Template description"
            />
          </label>
          <label className="ai-panel-field">
            <span>Category</span>
            <select
              className="input"
              value={form.category}
              onChange={(e) =>
                setForm((f) => ({ ...f, category: e.target.value }))
              }
              data-testid="base-template-category"
              aria-label="Template category"
            >
              <option value="">Uncategorised</option>
              {BASE_TEMPLATE_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>
          {saveErrors.length > 0 && (
            <div className="ai-panel-error" role="alert">
              <ul>
                {saveErrors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="ai-panel-run-row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSave}
              data-testid="base-template-save"
            >
              Save template
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </section>
      </div>
    </Modal>
  );
}
