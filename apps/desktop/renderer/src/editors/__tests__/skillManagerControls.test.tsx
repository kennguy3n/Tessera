import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { SkillManagerControls } from "../components/SkillManagerControls";
import { __resetCustomSkillsStoreForTests } from "../../skills/useCustomSkills";
import {
  buildCustomSkill,
  saveCustomSkills,
  type CustomSkillDraft,
} from "../../skills/customSkills";

const BUILTIN_DOC_ID = "document-deliberate-draft";

beforeEach(() => {
  window.localStorage.clear();
  __resetCustomSkillsStoreForTests();
});

/**
 * Persist one custom document skill straight to `localStorage` (through the
 * same build path the editor uses), then reset the store so the next mount
 * reloads it. Returns the new skill's id.
 */
function seedCustomSkill(name = "My skill"): string {
  const draft: CustomSkillDraft = {
    name,
    description: "",
    surfaces: ["document"],
    inputs: [{ id: "topic", label: "Topic", required: true, multiline: false }],
    steps: [
      {
        title: "Draft",
        kind: "draft",
        instruction: "Write about {{topic}}.",
        output: "result",
        inputsFrom: [],
        outputContract: "",
      },
    ],
  };
  const res = buildCustomSkill(draft);
  if (!res.ok) throw new Error(`seed failed: ${res.errors.join(", ")}`);
  saveCustomSkills([res.skill]);
  __resetCustomSkillsStoreForTests();
  return res.skill.id;
}

/** A host that owns the selected-id state, like a real AI panel. */
function Host({ initialId }: { initialId: string }) {
  const [selectedId, setSelectedId] = useState(initialId);
  return (
    <>
      <span data-testid="selected">{selectedId}</span>
      <SkillManagerControls
        surface="document"
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
    </>
  );
}

describe("SkillManagerControls", () => {
  it("disables Edit/Delete for a built-in skill but allows Duplicate", () => {
    render(<Host initialId={BUILTIN_DOC_ID} />);
    expect(screen.getByTestId("skill-manage-edit")).toBeDisabled();
    expect(screen.getByTestId("skill-manage-delete")).toBeDisabled();
    expect(screen.getByTestId("skill-manage-duplicate")).toBeEnabled();
    expect(screen.getByTestId("skill-manage-new")).toBeEnabled();
  });

  it("creates a new skill and selects it", async () => {
    const user = userEvent.setup();
    render(<Host initialId={BUILTIN_DOC_ID} />);

    await user.click(screen.getByTestId("skill-manage-new"));
    await user.type(screen.getByTestId("skill-editor-name"), "Fresh skill");
    // A new skill's seeded step has a blank instruction; fill it so the
    // skill validates.
    await user.type(
      screen.getByTestId("skill-editor-step-0-instruction"),
      "Write about {{topic}}.",
    );
    await user.click(screen.getByTestId("skill-editor-save"));

    // The host's selection now points at the new custom skill.
    const id = screen.getByTestId("selected").textContent ?? "";
    expect(id.startsWith("custom-")).toBe(true);
    // Modal closed.
    expect(screen.queryByTestId("skill-editor")).not.toBeInTheDocument();
  });

  it("duplicates the built-in as an editable custom copy", async () => {
    const user = userEvent.setup();
    render(<Host initialId={BUILTIN_DOC_ID} />);

    await user.click(screen.getByTestId("skill-manage-duplicate"));
    // Name is pre-filled with "(copy)".
    const dupName = screen.getByTestId("skill-editor-name") as HTMLInputElement;
    expect(dupName.value).toContain("(copy)");
    await user.click(screen.getByTestId("skill-editor-save"));

    const id = screen.getByTestId("selected").textContent ?? "";
    expect(id.startsWith("custom-")).toBe(true);
  });

  it("edits a custom skill in place (same id)", async () => {
    const user = userEvent.setup();
    const id = seedCustomSkill("Editable");
    render(<Host initialId={id} />);

    await user.click(screen.getByTestId("skill-manage-edit"));
    const name = screen.getByTestId("skill-editor-name");
    await user.clear(name);
    await user.type(name, "Renamed");
    await user.click(screen.getByTestId("skill-editor-save"));

    // Same id is retained on an in-place edit.
    expect(screen.getByTestId("selected").textContent).toBe(id);
  });

  it("requires an inline confirm before deleting and then falls back", async () => {
    const user = userEvent.setup();
    const id = seedCustomSkill("Doomed");
    render(<Host initialId={id} />);

    await user.click(screen.getByTestId("skill-manage-delete"));
    // Inline confirm shown; no window.confirm.
    expect(screen.getByTestId("skill-manage-confirm")).toBeInTheDocument();

    await user.click(screen.getByTestId("skill-manage-delete-confirm"));
    // Falls back to the first remaining (built-in) skill, never the deleted id.
    const selected = screen.getByTestId("selected").textContent ?? "";
    expect(selected).not.toBe(id);
    expect(selected).toBe(BUILTIN_DOC_ID);
  });

  it("cancels a pending delete confirmation", async () => {
    const user = userEvent.setup();
    const id = seedCustomSkill("Survivor");
    render(<Host initialId={id} />);

    await user.click(screen.getByTestId("skill-manage-delete"));
    await user.click(screen.getByTestId("skill-manage-delete-cancel"));
    expect(
      screen.queryByTestId("skill-manage-confirm"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("selected").textContent).toBe(id);
  });
});
