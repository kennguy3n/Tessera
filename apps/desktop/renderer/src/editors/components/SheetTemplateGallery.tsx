/**
 * In-editor sheet template gallery (Deliverable 1).
 *
 * A modal picker — modelled on the Slide editor's deck-template gallery —
 * that lets the user start a sheet from a curated built-in (monthly
 * budget, cash-flow, sales forecast, …) or from one of their own saved
 * templates. It also hosts the user-template lifecycle that is wholly
 * self-contained (duplicate, export, two-step delete) and defers the two
 * actions that need a metadata form (edit / import-review) to the host
 * via {@link SheetTemplateGalleryProps.onEditTemplate} /
 * {@link SheetTemplateGalleryProps.onImportDraft}, so only one focus trap
 * is ever active at a time.
 *
 * Applying a template hands the host a ready-to-use {@link SheetContent}
 * (built from the template's stored content); the host replaces the grid
 * and closes the gallery. The component never mutates editor state
 * itself, keeping it presentational + reusable.
 */

import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import type { SheetContent } from "../sheetEditorTypes";
import {
  ALL_SHEET_TEMPLATES_CATEGORY,
  SHEET_TEMPLATES,
  SHEET_TEMPLATE_CATEGORIES,
  filterSheetTemplates,
  sheetContentFromTemplate,
  type SheetTemplateCategoryFilter,
  type SheetTemplateContent,
} from "../sheetTemplates";
import {
  customSheetTemplateToDraft,
  parseSheetTemplate,
  serializeSheetTemplate,
  sheetTemplateFilename,
  type CustomSheetTemplate,
  type CustomSheetTemplateDraft,
} from "../customSheetTemplates";
import { useCustomSheetTemplates } from "../useCustomSheetTemplates";

export interface SheetTemplateGalleryProps {
  /** Apply a chosen template's content to the editor (host also closes). */
  onApply: (content: SheetContent) => void;
  /** Open the metadata modal to edit a saved template in place. */
  onEditTemplate: (draft: CustomSheetTemplateDraft, title: string) => void;
  /** Open the metadata modal to review an imported template before save. */
  onImportDraft: (draft: CustomSheetTemplateDraft) => void;
  onClose: () => void;
}

/** How many columns/rows of a template are shown in the card preview. */
const PREVIEW_COLS = 5;
const PREVIEW_ROWS = 3;

/** A compact data-grid preview of a template's first cells. */
function TemplatePreview({ content }: { content: SheetTemplateContent }) {
  const columns = content.columns.slice(0, PREVIEW_COLS);
  const rows = content.rows
    .slice(0, PREVIEW_ROWS)
    .map((row) => row.slice(0, PREVIEW_COLS));
  const extraCols = Math.max(0, content.columns.length - columns.length);
  return (
    <div className="sheet-template-preview" aria-hidden="true">
      <table className="sheet-template-preview-table">
        <thead>
          <tr>
            {columns.map((label, c) => (
              <th key={c}>{label}</th>
            ))}
            {extraCols > 0 && (
              <th className="sheet-template-preview-more">…</th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {columns.map((_, c) => (
                <td key={c}>{row[c] ?? ""}</td>
              ))}
              {extraCols > 0 && <td className="sheet-template-preview-more" />}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SheetTemplateGallery({
  onApply,
  onEditTemplate,
  onImportDraft,
  onClose,
}: SheetTemplateGalleryProps) {
  const { customTemplates, deleteTemplate, duplicateTemplate } =
    useCustomSheetTemplates();

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<SheetTemplateCategoryFilter>(
    ALL_SHEET_TEMPLATES_CATEGORY,
  );
  const [importError, setImportError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  // The shared hook also defers initial focus to the first focusable
  // control (the search box) and closes on Escape.
  useFocusTrap(true, dialogRef, onClose);

  const visibleBuiltIns = useMemo(
    () => filterSheetTemplates(SHEET_TEMPLATES, category, query),
    [category, query],
  );
  const visibleCustom = useMemo(
    () => filterSheetTemplates(customTemplates, category, query),
    [customTemplates, category, query],
  );

  const applyContent = (content: SheetTemplateContent) => {
    onApply(sheetContentFromTemplate(content));
  };

  const handleExport = (template: CustomSheetTemplate) => {
    const body = serializeSheetTemplate(template);
    const blob = new Blob([body], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = sheetTemplateFilename(template);
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const handleImportFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset so re-picking the same file fires onChange again.
    event.target.value = "";
    if (!file) return;
    file
      .text()
      .then((body) => {
        const result = parseSheetTemplate(body);
        if (!result.ok) {
          setImportError(result.error);
          return;
        }
        setImportError(null);
        onImportDraft(result.draft);
      })
      .catch(() => {
        setImportError("Couldn’t read that file.");
      });
  };

  // Two-step delete: first click arms, second (same row) commits.
  const handleDelete = (id: string) => {
    if (confirmingDeleteId === id) {
      deleteTemplate(id);
      setConfirmingDeleteId(null);
    } else {
      setConfirmingDeleteId(id);
    }
  };

  const noMatches = visibleBuiltIns.length === 0 && visibleCustom.length === 0;

  return (
    <div
      className="sheet-template-picker-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="sheet-template-picker sheet-template-gallery"
        role="dialog"
        aria-modal="true"
        aria-label="Choose a sheet template"
        tabIndex={-1}
        data-testid="sheet-template-gallery"
      >
        <div className="sheet-template-gallery-header">
          <h2>Start from a template</h2>
          {/* The search box MUST stay the first focusable control so the
              focus trap defers initial focus to it. Keep the import button
              + (display:none) file input AFTER it. */}
          <input
            type="search"
            className="input sheet-template-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates…"
            aria-label="Search templates by name or description"
          />
          <div className="sheet-template-gallery-actions">
            <button
              type="button"
              className="btn-sm"
              onClick={() => importInputRef.current?.click()}
              title="Import a template from a .json file"
              data-testid="sheet-template-import"
            >
              Import template
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".json,application/json"
              style={{ display: "none" }}
              onChange={handleImportFile}
              data-testid="sheet-template-import-input"
              aria-hidden="true"
              tabIndex={-1}
            />
          </div>
        </div>
        {importError && (
          <p
            className="ai-panel-error sheet-template-import-error"
            role="alert"
            data-testid="sheet-template-import-error"
          >
            {importError}
          </p>
        )}
        <div
          className="sheet-template-categories"
          role="group"
          aria-label="Filter templates by category"
        >
          {[ALL_SHEET_TEMPLATES_CATEGORY, ...SHEET_TEMPLATE_CATEGORIES].map(
            (option) => (
              <button
                key={option}
                type="button"
                className={`sheet-template-chip${
                  category === option ? " is-active" : ""
                }`}
                aria-pressed={category === option}
                onClick={() => setCategory(option)}
              >
                {option}
              </button>
            ),
          )}
        </div>

        {visibleCustom.length > 0 && (
          <section
            className="sheet-template-section"
            aria-label="Your templates"
            data-testid="sheet-template-custom-section"
          >
            <h3 className="sheet-template-section-title">Your templates</h3>
            <div className="sheet-template-gallery-grid">
              {visibleCustom.map((template) => {
                const armed = confirmingDeleteId === template.id;
                return (
                  <div
                    key={template.id}
                    className="sheet-template-card sheet-template-custom-card"
                    data-testid={`sheet-template-custom-${template.id}`}
                  >
                    {template.category && (
                      <span className="sheet-template-card-category">
                        {template.category}
                      </span>
                    )}
                    <TemplatePreview content={template.content} />
                    <span className="sheet-template-card-meta">
                      <span className="sheet-template-card-text">
                        <span className="sheet-template-card-title">
                          {template.label}
                        </span>
                        {template.description && (
                          <span className="sheet-template-card-desc">
                            {template.description}
                          </span>
                        )}
                      </span>
                    </span>
                    <div className="sheet-template-card-actions">
                      <button
                        type="button"
                        className="btn-sm sheet-template-card-apply"
                        onClick={() => applyContent(template.content)}
                        aria-label={`Apply the ${template.label} template`}
                        data-testid={`sheet-template-apply-${template.id}`}
                      >
                        Apply
                      </button>
                      <button
                        type="button"
                        className="btn-sm"
                        onClick={() =>
                          onEditTemplate(
                            customSheetTemplateToDraft(template),
                            "Edit template",
                          )
                        }
                        aria-label={`Edit the ${template.label} template`}
                        data-testid={`sheet-template-edit-${template.id}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn-sm"
                        onClick={() => duplicateTemplate(template.id)}
                        aria-label={`Duplicate the ${template.label} template`}
                        data-testid={`sheet-template-duplicate-${template.id}`}
                      >
                        Duplicate
                      </button>
                      <button
                        type="button"
                        className="btn-sm"
                        onClick={() => handleExport(template)}
                        aria-label={`Export the ${template.label} template`}
                        data-testid={`sheet-template-export-${template.id}`}
                      >
                        Export
                      </button>
                      {armed ? (
                        <>
                          <button
                            type="button"
                            className="btn-sm sheet-template-delete-confirm"
                            onClick={() => handleDelete(template.id)}
                            aria-label={`Confirm deleting the ${template.label} template`}
                            data-testid={`sheet-template-delete-confirm-${template.id}`}
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            className="btn-sm"
                            onClick={() => setConfirmingDeleteId(null)}
                            aria-label="Cancel deleting the template"
                            data-testid={`sheet-template-delete-cancel-${template.id}`}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn-sm sheet-template-delete"
                          onClick={() => handleDelete(template.id)}
                          aria-label={`Delete the ${template.label} template`}
                          data-testid={`sheet-template-delete-${template.id}`}
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
          <h3 className="sheet-template-section-title">Built-in templates</h3>
        )}

        {noMatches ? (
          <p className="sheet-template-empty" role="status">
            No templates match your search.
          </p>
        ) : (
          visibleBuiltIns.length > 0 && (
            <div className="sheet-template-gallery-grid">
              {visibleBuiltIns.map((template) => (
                <div key={template.id} className="sheet-template-card">
                  <span className="sheet-template-card-category">
                    {template.category}
                  </span>
                  <TemplatePreview content={template.content} />
                  <span className="sheet-template-card-meta">
                    <span className="sheet-template-card-icon">
                      {template.icon}
                    </span>
                    <span className="sheet-template-card-text">
                      <span className="sheet-template-card-title">
                        {template.label}
                      </span>
                      <span className="sheet-template-card-desc">
                        {template.description}
                      </span>
                    </span>
                  </span>
                  {/* Stretched, transparent click target so the whole card
                      is one focusable control without nesting block markup
                      inside a <button>. */}
                  <button
                    type="button"
                    className="sheet-template-card-button"
                    onClick={() => applyContent(template.content)}
                    aria-label={`Use the ${template.label} template — ${template.description}`}
                    data-testid={`sheet-template-builtin-${template.id}`}
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
