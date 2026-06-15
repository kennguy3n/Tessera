/**
 * End-to-end wiring coverage for user-authored ("custom") skills: a skill
 * the user persisted to `localStorage` must surface in a real AI panel's
 * skill picker alongside the built-ins, and the shared manage controls
 * (New / Edit / Duplicate / Delete) must render in skills mode.
 *
 * Uses the Slides panel (`SlideDeckGenerator`) as the representative host —
 * all four panels share the same `useCustomSkills().skillsForSurface()` +
 * `<SkillManagerControls>` wiring.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SlideDeckGenerator } from "../SlideAiPanel";
import { _resetActiveGenerationForTests } from "../../hooks/useActiveGeneration";
import { __resetCustomSkillsStoreForTests } from "../../skills/useCustomSkills";
import {
  buildCustomSkill,
  saveCustomSkills,
  type CustomSkillDraft,
} from "../../skills/customSkills";

/** Persist a custom skill for `surface`, then reset the store so a fresh
 * mount reloads it from localStorage. Returns the new skill's id. */
function seedCustomSkill(
  name: string,
  surface: CustomSkillDraft["surfaces"][number],
): string {
  const draft: CustomSkillDraft = {
    name,
    description: "A user-authored skill.",
    surfaces: [surface],
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

describe("custom skills wired into an AI panel", () => {
  let originalModel: unknown;

  beforeEach(() => {
    window.localStorage.clear();
    __resetCustomSkillsStoreForTests();
    _resetActiveGenerationForTests();
    originalModel = (window.tessera as unknown as { model: unknown }).model;
    // A minimal model: skills mode never runs in these tests.
    (window.tessera as unknown as { model: unknown }).model = {
      status: vi.fn().mockResolvedValue({ available: true }),
      start: vi.fn(),
      stop: vi.fn(),
      generate: vi.fn(async () => undefined),
      cancelJob: vi.fn().mockResolvedValue(undefined),
      onToken: vi.fn(() => () => {}),
    };
  });

  afterEach(() => {
    (window.tessera as unknown as { model: unknown }).model = originalModel;
    vi.clearAllMocks();
  });

  it("shows a persisted custom skill in the panel's skill picker", async () => {
    seedCustomSkill("Investor narrative", "slide");
    const user = userEvent.setup();
    render(<SlideDeckGenerator open onApply={vi.fn()} onClose={vi.fn()} />);

    await user.click(screen.getByTestId("slide-ai-mode-skills"));

    // The picker renders (built-in + custom => more than one option).
    const picker = screen.getByRole("combobox", { name: "Choose a skill" });
    expect(
      within(picker).getByRole("option", { name: "Investor narrative" }),
    ).toBeInTheDocument();
    // The shared manage controls render in skills mode.
    expect(screen.getByTestId("skill-manage")).toBeInTheDocument();
    expect(screen.getByTestId("skill-manage-new")).toBeEnabled();
  });

  it("does not leak a custom skill scoped to a different surface", async () => {
    // A sheet-only skill must not appear in the Slides picker.
    seedCustomSkill("Sheet helper", "sheet");
    const user = userEvent.setup();
    render(<SlideDeckGenerator open onApply={vi.fn()} onClose={vi.fn()} />);

    await user.click(screen.getByTestId("slide-ai-mode-skills"));

    expect(screen.queryByRole("option", { name: "Sheet helper" })).toBeNull();
  });

  it("reflects a newly authored skill without remounting the panel", async () => {
    const user = userEvent.setup();
    render(<SlideDeckGenerator open onApply={vi.fn()} onClose={vi.fn()} />);

    await user.click(screen.getByTestId("slide-ai-mode-skills"));
    await user.click(screen.getByTestId("skill-manage-new"));
    // "New" seeds the draft with this panel's surface (Slides), so the
    // skill lands in this picker.
    await user.type(screen.getByTestId("skill-editor-name"), "Live-added deck");
    await user.type(
      screen.getByTestId("skill-editor-step-0-instruction"),
      "Write about {{topic}}.",
    );
    await user.click(screen.getByTestId("skill-editor-save"));

    // The store update propagates to the still-mounted panel's picker.
    expect(
      await screen.findByRole("option", { name: "Live-added deck" }),
    ).toBeInTheDocument();
  });
});
