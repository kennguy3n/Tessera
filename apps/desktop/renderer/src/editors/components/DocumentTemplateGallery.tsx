/**
 * In-editor document template gallery.
 *
 * The document-domain analogue of the Slide editor's template picker: a
 * modal overlay that lists the built-in {@link DOCUMENT_TEMPLATES} plus
 * the user's saved templates, with category chips + free-text search and
 * a safe live-text preview on every card. Applying a card inserts that
 * template's HTML into the document (the host decides cursor-insert vs.
 * replace-empty); the user's own templates can also be edited,
 * duplicated, exported to a portable file, and deleted (two-step armed
 * confirm).
 *
 * Like the Slide picker it owns its own focus trap (mirroring
 * `useFocusTrap`'s one-overlay-at-a-time invariant). The "Save current as
 * template", "Edit", and "Import" actions all open the shared
 * {@link DocumentTemplateSaveModal}, so the host closes this gallery
 * before opening that modal and reopens it on close — the two overlays
 * never stack. Those flows are delegated up to the host via callbacks so
 * this component stays presentational and the save modal owns the single
 * persistence path.
 */

import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import {
  documentTemplateFilename,
  parseDocumentTemplate,
  serializeDocumentTemplate,
  type CustomDocumentTemplate,
  type CustomDocumentTemplateDraft,
} from "../customDocumentTemplates";
import {
  ALL_DOCUMENT_TEMPLATES_CATEGORY,
  DOCUMENT_TEMPLATE_CATEGORIES,
  DOCUMENT_TEMPLATES,
  documentTemplatePreviewText,
  filterDocumentTemplates,
  type DocumentTemplateCategoryFilter,
} from "../documentTemplates";
import { useCustomDocumentTemplates } from "../useCustomDocumentTemplates";

export interface DocumentTemplateGalleryProps {
  isOpen: boolean;
  onClose: () => void;
  /** Insert a template's HTML into the document (host then closes us). */
  onApply: (content: string) => void;
  /** Open the "save the current document as a template" modal. */
  onSaveCurrent: () => void;
  /** Open the edit modal for an existing custom template. */
  onEditTemplate: (template: CustomDocumentTemplate) => void;
  /**
   * Open the import-review modal pre-filled with a parsed draft (the
   * draft carries no id, so saving mints a fresh one — non-destructive).
   */
  onImportDraft: (draft: CustomDocumentTemplateDraft) => void;
}

export function DocumentTemplateGallery({
  isOpen,
  onClose,
  onApply,
  onSaveCurrent,
  onEditTemplate,
  onImportDraft,
}: DocumentTemplateGalleryProps) {
  const { customTemplates, deleteTemplate, duplicateTemplate } =
    useCustomDocumentTemplates();

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<DocumentTemplateCategoryFilter>(
    ALL_DOCUMENT_TEMPLATES_CATEGORY,
  );
  const [importError, setImportError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );

  const galleryRef = useRef<HTMLDivElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  useFocusTrap(isOpen, galleryRef, onClose);

  // Clear transient UI (import error, armed delete) whenever the gallery
  // closes so a re-open never shows a stale error or a primed confirm.
  useEffect(() => {
    if (!isOpen) {
      setImportError(null);
      setConfirmingDeleteId(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const visibleBuiltIns = filterDocumentTemplates(
    DOCUMENT_TEMPLATES,
    category,
    query,
  );
  const visibleCustom = filterDocumentTemplates(
    customTemplates,
    category,
    query,
  );
  const nothingMatches =
    visibleBuiltIns.length === 0 && visibleCustom.length === 0;

  const handleExport = (template: CustomDocumentTemplate) => {
    const blob = new Blob([serializeDocumentTemplate(template)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = documentTemplateFilename(template);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset so re-selecting the same file fires `change` again.
    event.target.value = "";
    if (!file) return;
    setImportError(null);
    file
      .text()
      .then((text) => {
        const result = parseDocumentTemplate(text);
        if (result.ok) {
          onImportDraft(result.draft);
        } else {
          setImportError(result.error);
        }
      })
      .catch(() => {
        setImportError("Couldn’t read that file.");
      });
  };

  const handleDelete = (id: string) => {
    deleteTemplate(id);
    setConfirmingDeleteId(null);
  };

  return (
    <div
      className="document-template-picker-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={galleryRef}
        className="document-template-gallery"
        role="dialog"
        aria-modal="true"
        aria-label="Insert a document template"
        tabIndex={-1}
      >
        <div className="document-template-gallery-header">
          <h2>Document templates</h2>
          <p className="document-template-help">
            Insert a starter at your cursor — or replace an empty document. Save
            the current document as your own reusable template. Press Esc to
            close.
          </p>
          {/* The search box MUST stay the first focusable control — the
              focus trap defers initial focus to it. Keep the actions +
              (display:none) file input AFTER it so neither steals focus. */}
          <input
            type="search"
            className="input document-template-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates…"
            aria-label="Search templates by name or description"
          />
          <div className="document-template-gallery-actions">
            <button
              type="button"
              className="btn-sm"
              onClick={onSaveCurrent}
              title="Save the current document as a reusable template"
              data-testid="document-template-save-current"
            >
              Save current as template
            </button>
            <button
              type="button"
              className="btn-sm"
              onClick={() => importInputRef.current?.click()}
              title="Import a template from a .json file"
              data-testid="document-template-import"
            >
              Import template
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".json,application/json"
              style={{ display: "none" }}
              onChange={handleImportFile}
              data-testid="document-template-import-input"
              aria-hidden="true"
              tabIndex={-1}
            />
          </div>
        </div>
        {importError && (
          <p
            className="ai-panel-error document-template-import-error"
            role="alert"
            data-testid="document-template-import-error"
          >
            {importError}
          </p>
        )}
        <div
          className="document-template-categories"
          role="group"
          aria-label="Filter templates by category"
        >
          {[
            ALL_DOCUMENT_TEMPLATES_CATEGORY,
            ...DOCUMENT_TEMPLATE_CATEGORIES,
          ].map((chip) => (
            <button
              key={chip}
              type="button"
              className={`document-template-chip${
                category === chip ? " is-active" : ""
              }`}
              aria-pressed={category === chip}
              onClick={() => setCategory(chip)}
            >
              {chip}
            </button>
          ))}
        </div>
        {visibleCustom.length > 0 && (
          <section
            className="document-template-section"
            aria-label="Your templates"
            data-testid="document-template-custom-section"
          >
            <h3 className="document-template-section-title">Your templates</h3>
            <div className="document-template-grid">
              {visibleCustom.map((template) => {
                const armed = confirmingDeleteId === template.id;
                return (
                  <div
                    key={template.id}
                    className="document-template-card document-template-custom-card"
                    data-testid={`document-template-custom-${template.id}`}
                  >
                    {template.category && (
                      <span className="document-template-card-category">
                        {template.category}
                      </span>
                    )}
                    <span className="document-template-card-meta">
                      <span className="document-template-card-text">
                        <span className="document-template-card-title">
                          {template.label}
                        </span>
                        {template.description && (
                          <span className="document-template-card-desc">
                            {template.description}
                          </span>
                        )}
                        <span className="document-template-card-preview">
                          {documentTemplatePreviewText(template.content)}
                        </span>
                      </span>
                    </span>
                    <div className="document-template-card-actions">
                      <button
                        type="button"
                        className="btn-sm document-template-card-apply"
                        onClick={() => onApply(template.content)}
                        aria-label={`Insert the ${template.label} template`}
                        data-testid={`document-template-apply-${template.id}`}
                      >
                        Insert
                      </button>
                      <button
                        type="button"
                        className="btn-sm"
                        onClick={() => onEditTemplate(template)}
                        aria-label={`Edit the ${template.label} template`}
                        data-testid={`document-template-edit-${template.id}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn-sm"
                        onClick={() => duplicateTemplate(template.id)}
                        aria-label={`Duplicate the ${template.label} template`}
                        data-testid={`document-template-duplicate-${template.id}`}
                      >
                        Duplicate
                      </button>
                      <button
                        type="button"
                        className="btn-sm"
                        onClick={() => handleExport(template)}
                        aria-label={`Export the ${template.label} template`}
                        data-testid={`document-template-export-${template.id}`}
                      >
                        Export
                      </button>
                      {armed ? (
                        <>
                          <button
                            type="button"
                            className="btn-sm document-template-delete-confirm"
                            onClick={() => handleDelete(template.id)}
                            aria-label={`Confirm deleting the ${template.label} template`}
                            data-testid={`document-template-delete-confirm-${template.id}`}
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            className="btn-sm"
                            onClick={() => setConfirmingDeleteId(null)}
                            aria-label="Cancel deleting the template"
                            data-testid={`document-template-delete-cancel-${template.id}`}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn-sm document-template-delete"
                          onClick={() => setConfirmingDeleteId(template.id)}
                          aria-label={`Delete the ${template.label} template`}
                          data-testid={`document-template-delete-${template.id}`}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
        {visibleCustom.length > 0 && visibleBuiltIns.length > 0 && (
          <h3 className="document-template-section-title">
            Built-in templates
          </h3>
        )}
        {nothingMatches ? (
          <p
            className="document-template-empty"
            role="status"
            data-testid="document-template-empty"
          >
            No templates match your search.
          </p>
        ) : (
          visibleBuiltIns.length > 0 && (
            <div className="document-template-grid">
              {visibleBuiltIns.map((template) => (
                <div
                  key={template.id}
                  className="document-template-card"
                  data-testid={`document-template-builtin-${template.id}`}
                >
                  {template.category && (
                    <span className="document-template-card-category">
                      {template.category}
                    </span>
                  )}
                  <span className="document-template-card-meta">
                    <span className="document-template-card-icon" aria-hidden>
                      {template.icon}
                    </span>
                    <span className="document-template-card-text">
                      <span className="document-template-card-title">
                        {template.label}
                      </span>
                      <span className="document-template-card-desc">
                        {template.description}
                      </span>
                      <span className="document-template-card-preview">
                        {documentTemplatePreviewText(template.content)}
                      </span>
                    </span>
                  </span>
                  {/* Stretched, transparent click target so the whole card
                      is one focusable control without nesting block markup
                      inside a <button>. */}
                  <button
                    type="button"
                    className="document-template-card-button"
                    onClick={() => onApply(template.content)}
                    aria-label={`Insert the ${template.label} template — ${template.description}`}
                    data-testid={`document-template-insert-${template.id}`}
                  />
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}
