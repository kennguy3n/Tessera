/**
 * Manage-controls row for a panel's Skills picker: New / Edit / Duplicate /
 * Delete a user-authored skill. Owns the {@link SkillEditorModal} and the
 * inline delete confirmation so the four AI panels stay thin — each renders a
 * single `<SkillManagerControls surface selectedId onSelect />` next to its
 * existing skill `<select>`.
 *
 * Built-ins can be Duplicated (a handy starting point) but never Edited or
 * Deleted; those are enabled only when the current selection is a custom
 * skill. After create / duplicate / delete the control re-selects a sensible
 * skill so the host's picker is never left pointing at a missing id.
 */

import { useEffect, useState } from "react";
import {
  emptyDraft,
  isCustomSkillId,
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

  const selected = skillById(selectedId);
  const isCustom = selected ? isCustomSkillId(selected.id) : false;

  // A pending delete confirmation must not survive a selection change.
  useEffect(() => {
    setConfirmingDelete(false);
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
            onClick={() => setConfirmingDelete(true)}
            disabled={!isCustom}
            data-testid="skill-manage-delete"
          >
            Delete
          </button>
        </>
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
