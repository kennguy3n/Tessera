import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillManagerControls } from "../components/SkillManagerControls";
import { __resetCustomSkillsStoreForTests } from "../../skills/useCustomSkills";
import {
  buildCustomSkill,
  saveCustomSkills,
  serializeSkillExport,
  type CustomSkillDraft,
} from "../../skills/customSkills";
import { getSkillById } from "../../skills/skillLibrary";

// jsdom (the renderer test env) does NOT ship URL.createObjectURL /
// revokeObjectURL. The Export codepath relies on them, so install minimal
// implementations once at module load so `vi.spyOn` can stub them.
if (typeof URL.createObjectURL === "undefined") {
  Object.defineProperty(URL, "createObjectURL", {
    value: (_blob: Blob) => "blob:test",
    configurable: true,
    writable: true,
  });
}
if (typeof URL.revokeObjectURL === "undefined") {
  Object.defineProperty(URL, "revokeObjectURL", {
    value: (_url: string) => {},
    configurable: true,
    writable: true,
  });
}

// jsdom's Blob/File does not implement the async `.text()` reader the Import
// codepath uses (the production app runs on Chromium 126, which does). Back it
// with jsdom's supported `FileReader` so File.text() resolves in tests.
if (typeof Blob.prototype.text !== "function") {
  Object.defineProperty(Blob.prototype, "text", {
    value(this: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(this);
      });
    },
    configurable: true,
    writable: true,
  });
}

const BUILTIN_DOC_ID = "document-deliberate-draft";

beforeEach(() => {
  window.localStorage.clear();
  __resetCustomSkillsStoreForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it("exports the selected skill via the browser download dance", () => {
    const createSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock");
    const revokeSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const realCreate = document.createElement.bind(document);
    let lastAnchor: HTMLAnchorElement | null = null;
    const createElSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tag: string) => {
        const el = realCreate(tag);
        if (tag === "a") {
          lastAnchor = el as HTMLAnchorElement;
          (el as HTMLAnchorElement).click = vi.fn();
        }
        return el;
      });

    render(<Host initialId={BUILTIN_DOC_ID} />);
    // Export is enabled even for a built-in (a canonical starting template).
    fireEvent.click(screen.getByTestId("skill-manage-export"));

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(lastAnchor).not.toBeNull();
    expect(lastAnchor!.download.startsWith("tessera-skill-")).toBe(true);
    expect(lastAnchor!.download.endsWith(".json")).toBe(true);
    expect(lastAnchor!.click as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(
      1,
    );

    createElSpy.mockRestore();
  });

  it("imports a shared skill file and opens the editor pre-filled", async () => {
    const doc = getSkillById(BUILTIN_DOC_ID);
    expect(doc).toBeDefined();
    if (!doc) return;
    render(<Host initialId={BUILTIN_DOC_ID} />);

    const file = new File([serializeSkillExport(doc)], "shared.json", {
      type: "application/json",
    });
    fireEvent.change(screen.getByTestId("skill-manage-import-input"), {
      target: { files: [file] },
    });

    // Editor opens pre-filled (like Duplicate); no error shown.
    await screen.findByTestId("skill-editor");
    const name = screen.getByTestId("skill-editor-name") as HTMLInputElement;
    expect(name.value).toBe(doc.name);
    expect(
      screen.queryByTestId("skill-manage-import-error"),
    ).not.toBeInTheDocument();
  });

  it("saving an imported skill creates a new custom id (never overwrites)", async () => {
    const user = userEvent.setup();
    const doc = getSkillById(BUILTIN_DOC_ID);
    if (!doc) return;
    render(<Host initialId={BUILTIN_DOC_ID} />);

    const file = new File([serializeSkillExport(doc)], "shared.json", {
      type: "application/json",
    });
    fireEvent.change(screen.getByTestId("skill-manage-import-input"), {
      target: { files: [file] },
    });
    await screen.findByTestId("skill-editor");
    await user.click(screen.getByTestId("skill-editor-save"));

    const id = screen.getByTestId("selected").textContent ?? "";
    expect(id.startsWith("custom-")).toBe(true);
    expect(id).not.toBe(BUILTIN_DOC_ID);
  });

  it("shows an inline error for an unreadable import and opens no editor", async () => {
    render(<Host initialId={BUILTIN_DOC_ID} />);

    const file = new File(["not json{"], "bad.json", {
      type: "application/json",
    });
    fireEvent.change(screen.getByTestId("skill-manage-import-input"), {
      target: { files: [file] },
    });

    const error = await screen.findByTestId("skill-manage-import-error");
    expect(error.textContent).toMatch(/JSON/i);
    expect(screen.queryByTestId("skill-editor")).not.toBeInTheDocument();
  });
});
