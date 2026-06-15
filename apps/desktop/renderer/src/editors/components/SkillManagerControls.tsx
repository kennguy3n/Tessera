/**
 * Manage-controls row for a panel's Skills picker: New / Edit / Duplicate /
 * Export / Import / Delete a user-authored skill. Owns the
 * {@link SkillEditorModal} and the inline delete confirmation so the four AI
 * panels stay thin — each renders a single
 * `<SkillManagerControls surface selectedId onSelect />` next to its existing
 * skill `<select>`.
 *
 * Built-ins can be Duplicated or Exported (handy starting points) but never
 * Edited or Deleted; those are enabled only when the current selection is a
 * custom skill. Import reads a shared skill file and opens the editor
 * pre-filled (like Duplicate) so the user reviews before a fresh custom id is
 * minted on save — an import can never overwrite an existing skill. After
 * create / duplicate / import / delete the control re-selects a sensible skill
 * so the host's picker is never left pointing at a missing id.
 */

import { useEffect, useRef, useState } from "react";
import {
  emptyDraft,
  exportSkillFilename,
  isCustomSkillId,
  parseSkillImport,
  serializeSkillExport,
  skillToDraft,
  type CustomSkillDraft,
} from "../../skills/customSkills";
import { useCustomSkills } from "../../skills/useCustomSkills";
import type { Skill, SkillSurface } from "../../skills/skillTypes";
import { SkillEditorModal } from "./SkillEditorModal";

export interface SkillManagerControlsProps {
  surface: SkillSurface;
  /** The skill id currently selected in the host panel. */
  selectedId: string;
  /** Select a skill id (after create / duplicate / delete, or unchanged). */
  onSelect: (id: string) => void;
}

interface EditorState {
  draft: CustomSkillDraft;
  title: string;
}

export function SkillManagerControls({
  surface,
  selectedId,
  onSelect,
}: SkillManagerControlsProps) {
  const { skillById, skillsForSurface, deleteSkill } = useCustomSkills();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selected = skillById(selectedId);
  const isCustom = selected ? isCustomSkillId(selected.id) : false;

  // A pending delete confirmation / stale import error must not survive a
  // selection change.
  useEffect(() => {
    setConfirmingDelete(false);
    setImportError(null);
  }, [selectedId]);

  const openNew = () =>
    setEditor({ draft: emptyDraft(surface), title: "New skill" });

  const openEdit = () => {
    if (!selected || !isCustom) return;
    setEditor({ draft: skillToDraft(selected), title: "Edit skill" });
  };

  const openDuplicate = () => {
    if (!selected) return;
    const base = skillToDraft(selected);
    setEditor({
      draft: { ...base, id: undefined, name: `${selected.name} (copy)` },
      title: "Duplicate skill",
    });
  };

  const handleSaved = (skill: Skill) => {
    onSelect(skill.id);
  };

  // Export the current selection as a portable JSON file. Works for built-ins
  // (canonical starting template) and custom skills alike; never mutates it.
  const exportSelected = () => {
    if (!selected) return;
    const blob = new Blob([serializeSkillExport(selected)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportSkillFilename(selected);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const openImportPicker = () => {
    setImportError(null);
    fileInputRef.current?.click();
  };

  const onImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    // Reset so picking the same file again re-fires onChange.
    input.value = "";
    if (!file) return;
    file
      .text()
      .then((body) => {
        const result = parseSkillImport(body);
        if (!result.ok) {
          setImportError(result.error);
          return;
        }
        // Open the editor pre-filled (draft has no id ⇒ a fresh custom id is
        // minted on save), exactly like Duplicate — the user reviews first.
        setImportError(null);
        setEditor({ draft: result.draft, title: "Import skill" });
      })
      .catch(() => setImportError("Couldn’t read that file."));
  };

  const confirmDelete = () => {
    if (!selected || !isCustom) return;
    const deletedId = selected.id;
    const remaining = skillsForSurface(surface).filter(
      (s) => s.id !== deletedId,
    );
    deleteSkill(deletedId);
    setConfirmingDelete(false);
    // Fall back to the first remaining skill (a built-in always exists).
    onSelect(remaining[0]?.id ?? "");
  };

  return (
    <div
      className="skill-manage"
      role="group"
      aria-label="Manage skills"
      data-testid="skill-manage"
    >
      {confirmingDelete && selected ? (
        <div
          className="skill-manage-confirm"
          data-testid="skill-manage-confirm"
        >
          <span className="ai-panel-hint">Delete “{selected.name}”?</span>
          <button
            type="button"
            className="btn btn-danger skill-manage-btn"
            onClick={confirmDelete}
            data-testid="skill-manage-delete-confirm"
          >
            Delete
          </button>
          <button
            type="button"
            className="btn btn-secondary skill-manage-btn"
            onClick={() => setConfirmingDelete(false)}
            data-testid="skill-manage-delete-cancel"
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="btn btn-secondary skill-manage-btn"
            onClick={openNew}
            data-testid="skill-manage-new"
          >
            New
          </button>
          <button
            type="button"
            className="btn btn-secondary skill-manage-btn"
            onClick={openEdit}
            disabled={!isCustom}
            data-testid="skill-manage-edit"
          >
            Edit
          </button>
          <button
            type="button"
            className="btn btn-secondary skill-manage-btn"
            onClick={openDuplicate}
            disabled={!selected}
            data-testid="skill-manage-duplicate"
          >
            Duplicate
          </button>
          <button
            type="button"
            className="btn btn-secondary skill-manage-btn"
            onClick={exportSelected}
            disabled={!selected}
            data-testid="skill-manage-export"
          >
            Export
          </button>
          <button
            type="button"
            className="btn btn-secondary skill-manage-btn"
            onClick={openImportPicker}
            data-testid="skill-manage-import"
          >
            Import
          </button>
          <button
            type="button"
            className="btn btn-secondary skill-manage-btn"
            onClick={() => setConfirmingDelete(true)}
            disabled={!isCustom}
            data-testid="skill-manage-delete"
          >
            Delete
          </button>
        </>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        onChange={onImportFile}
        aria-label="Import skill file"
        data-testid="skill-manage-import-input"
        style={{ display: "none" }}
      />

      {importError && (
        <p
          className="ai-panel-hint skill-manage-error"
          role="alert"
          data-testid="skill-manage-import-error"
        >
          {importError}
        </p>
      )}

      {editor && (
        <SkillEditorModal
          isOpen
          initialDraft={editor.draft}
          title={editor.title}
          onClose={() => setEditor(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
