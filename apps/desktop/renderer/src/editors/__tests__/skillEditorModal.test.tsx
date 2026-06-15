import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SkillEditorModal } from "../components/SkillEditorModal";
import {
  CUSTOM_SKILLS_STORAGE_KEY,
  MAX_SKILL_INPUTS,
  MAX_SKILL_STEPS,
  emptyDraft,
  skillToDraft,
  type CustomSkillDraft,
} from "../../skills/customSkills";
import { __resetCustomSkillsStoreForTests } from "../../skills/useCustomSkills";
import { getSkillById } from "../../skills/skillLibrary";

beforeEach(() => {
  window.localStorage.clear();
  __resetCustomSkillsStoreForTests();
});

/** A draft that is one keystroke short of valid (blank name). */
function nearlyValidDraft(): CustomSkillDraft {
  return {
    name: "",
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
}

describe("SkillEditorModal", () => {
  it("builds + persists a valid skill and reports it to the host", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      <SkillEditorModal
        isOpen
        initialDraft={nearlyValidDraft()}
        title="New skill"
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    await user.type(screen.getByTestId("skill-editor-name"), "Brief writer");
    await user.click(screen.getByTestId("skill-editor-save"));

    expect(onSaved).toHaveBeenCalledTimes(1);
    const saved = onSaved.mock.calls[0][0];
    expect(saved.name).toBe("Brief writer");
    expect(saved.id.startsWith("custom-")).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Persisted to localStorage through the store.
    expect(window.localStorage.getItem(CUSTOM_SKILLS_STORAGE_KEY)).toContain(
      "Brief writer",
    );
  });

  it("surfaces build errors and does not persist an invalid draft", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(
      <SkillEditorModal
        isOpen
        initialDraft={nearlyValidDraft()}
        title="New skill"
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    // Save with a blank name -> validation error, no persistence.
    await user.click(screen.getByTestId("skill-editor-save"));

    expect(onSaved).not.toHaveBeenCalled();
    const errors = screen.getByTestId("skill-editor-errors");
    expect(
      within(errors).getAllByTestId("skill-editor-error").length,
    ).toBeGreaterThan(0);
    expect(window.localStorage.getItem(CUSTOM_SKILLS_STORAGE_KEY)).toBeNull();
  });

  it("derives a {{variable}} hint from an input label", async () => {
    const user = userEvent.setup();
    render(
      <SkillEditorModal
        isOpen
        initialDraft={emptyDraft("document")}
        title="New skill"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    // A freshly added input has no id yet, so its variable is derived from
    // the label the author types (the seeded input 0 already has id "topic").
    await user.click(screen.getByTestId("skill-editor-add-input"));
    const row = screen.getByTestId("skill-editor-input-1");
    const labelField = screen.getByTestId("skill-editor-input-1-label");
    await user.type(labelField, "Audience Tone");
    expect(within(row).getByText("{{audience_tone}}")).toBeInTheDocument();
  });

  it("caps the number of inputs and steps", async () => {
    const user = userEvent.setup();
    render(
      <SkillEditorModal
        isOpen
        initialDraft={emptyDraft("document")}
        title="New skill"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const addInput = screen.getByTestId("skill-editor-add-input");
    // emptyDraft seeds 1 input; click until the cap, then it disables.
    for (let i = 1; i < MAX_SKILL_INPUTS; i += 1) await user.click(addInput);
    expect(addInput).toBeDisabled();

    const addStep = screen.getByTestId("skill-editor-add-step");
    for (let i = 1; i < MAX_SKILL_STEPS; i += 1) await user.click(addStep);
    expect(addStep).toBeDisabled();
  });

  it("re-seeds the form when the host hands it a fresh draft", async () => {
    const user = userEvent.setup();
    const first = nearlyValidDraft();
    const { rerender } = render(
      <SkillEditorModal
        isOpen
        initialDraft={first}
        title="New skill"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await user.type(screen.getByTestId("skill-editor-name"), "Half-typed");
    expect(screen.getByTestId("skill-editor-name")).toHaveValue("Half-typed");

    // A new initialDraft reference must reset the form (new open).
    const second: CustomSkillDraft = { ...nearlyValidDraft(), name: "Preset" };
    rerender(
      <SkillEditorModal
        isOpen
        initialDraft={second}
        title="Edit skill"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByTestId("skill-editor-name")).toHaveValue("Preset");
  });

  it("exposes earlier outputs as attachable material on later steps", async () => {
    const user = userEvent.setup();
    render(
      <SkillEditorModal
        isOpen
        initialDraft={emptyDraft("document")}
        title="New skill"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    // emptyDraft has 1 step ("result"). Add a second; it can attach {{result}}
    // and the declared input {{topic}}.
    await user.click(screen.getByTestId("skill-editor-add-step"));
    expect(
      screen.getByTestId("skill-editor-step-1-from-result"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("skill-editor-step-1-from-topic"),
    ).toBeInTheDocument();
  });

  it("renders the per-step acceptance check controls", () => {
    render(
      <SkillEditorModal
        isOpen
        initialDraft={emptyDraft("document")}
        title="New skill"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByTestId("skill-editor-step-0-check")).toBeInTheDocument();
    expect(
      screen.getByTestId("skill-editor-step-0-check-nonempty"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("skill-editor-step-0-check-startswith"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("skill-editor-step-0-check-include"),
    ).toBeInTheDocument();
  });

  it("authors an acceptance check and includes it on the saved skill", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(
      <SkillEditorModal
        isOpen
        initialDraft={nearlyValidDraft()}
        title="New skill"
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    await user.type(screen.getByTestId("skill-editor-name"), "Formula writer");
    // Open the collapsible check section before interacting with its controls.
    await user.click(screen.getByText("Acceptance check (optional)"));
    await user.click(screen.getByTestId("skill-editor-step-0-check-nonempty"));
    await user.type(
      screen.getByTestId("skill-editor-step-0-check-startswith"),
      "=",
    );
    await user.click(screen.getByTestId("skill-editor-save"));

    expect(onSaved).toHaveBeenCalledTimes(1);
    const saved = onSaved.mock.calls[0][0];
    expect(saved.steps[0].check).toEqual({
      nonEmpty: true,
      mustStartWith: "=",
    });
  });

  it("shows a duplicated built-in's preserved check values", () => {
    const sheet = getSkillById("sheet-intent-formula-selfcheck");
    expect(sheet).toBeDefined();
    if (!sheet) return;
    render(
      <SkillEditorModal
        isOpen
        initialDraft={skillToDraft(sheet)}
        title="Duplicate skill"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    // The built-in's "propose" step requires an "=" prefix; the editor must
    // surface that preserved value in the Must-start-with field.
    expect(
      screen.getByTestId("skill-editor-step-0-check-startswith"),
    ).toHaveValue("=");
    expect(
      screen.getByTestId("skill-editor-step-0-check-nonempty"),
    ).toBeChecked();
  });

  it("renders the per-step model-sampling controls", () => {
    render(
      <SkillEditorModal
        isOpen
        initialDraft={emptyDraft("document")}
        title="New skill"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId("skill-editor-step-0-sampling"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("skill-editor-step-0-temperature"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("skill-editor-step-0-maxtokens"),
    ).toBeInTheDocument();
  });

  it("authors sampling overrides and includes them on the saved skill", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(
      <SkillEditorModal
        isOpen
        initialDraft={nearlyValidDraft()}
        title="New skill"
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    await user.type(screen.getByTestId("skill-editor-name"), "Tuned writer");
    await user.click(screen.getByText("Model sampling (optional)"));
    await user.type(
      screen.getByTestId("skill-editor-step-0-temperature"),
      "0.2",
    );
    await user.type(screen.getByTestId("skill-editor-step-0-maxtokens"), "800");
    await user.click(screen.getByTestId("skill-editor-save"));

    expect(onSaved).toHaveBeenCalledTimes(1);
    const saved = onSaved.mock.calls[0][0];
    expect(saved.steps[0].temperature).toBe(0.2);
    expect(saved.steps[0].maxTokens).toBe(800);
  });

  it("surfaces preserved sampling overrides when editing a skill", () => {
    const seeded = emptyDraft("document");
    seeded.steps[0].temperature = "0.5";
    seeded.steps[0].maxTokens = "1200";
    render(
      <SkillEditorModal
        isOpen
        initialDraft={seeded}
        title="Edit skill"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByTestId("skill-editor-step-0-temperature")).toHaveValue(
      0.5,
    );
    expect(screen.getByTestId("skill-editor-step-0-maxtokens")).toHaveValue(
      1200,
    );
  });

  it("renders the per-step output-format-contract control", () => {
    render(
      <SkillEditorModal
        isOpen
        initialDraft={emptyDraft("document")}
        title="New skill"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId("skill-editor-step-0-contract"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("skill-editor-step-0-contract-text"),
    ).toBeInTheDocument();
    // A step with no contract advertises the section as optional.
    expect(
      screen.getByText(/Output format contract \(optional\)/),
    ).toBeInTheDocument();
  });

  it("authors an output format contract and includes it on the saved skill", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(
      <SkillEditorModal
        isOpen
        initialDraft={nearlyValidDraft()}
        title="New skill"
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    await user.type(screen.getByTestId("skill-editor-name"), "Bullet planner");
    await user.click(screen.getByText(/Output format contract/));
    await user.type(
      screen.getByTestId("skill-editor-step-0-contract-text"),
      "FORMAT: one '- ' bullet per line, no prose.",
    );
    await user.click(screen.getByTestId("skill-editor-save"));

    expect(onSaved).toHaveBeenCalledTimes(1);
    const saved = onSaved.mock.calls[0][0];
    expect(saved.steps[0].outputContract).toBe(
      "FORMAT: one '- ' bullet per line, no prose.",
    );
  });

  it("surfaces a duplicated built-in's preserved output contract", () => {
    const doc = getSkillById("document-deliberate-draft");
    expect(doc).toBeDefined();
    if (!doc) return;
    render(
      <SkillEditorModal
        isOpen
        initialDraft={skillToDraft(doc)}
        title="Duplicate skill"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    // Step 0 ("plan") ships a FORMAT contract; the editor must surface it
    // verbatim and flag that step's section as already set. (The built-in
    // has multiple contract-bearing steps, so scope the summary to step 0.)
    expect(screen.getByTestId("skill-editor-step-0-contract-text")).toHaveValue(
      doc.steps[0].outputContract,
    );
    const step0 = screen.getByTestId("skill-editor-step-0");
    expect(
      within(step0).getByText(/Output format contract \(set\)/),
    ).toBeInTheDocument();
  });
});
