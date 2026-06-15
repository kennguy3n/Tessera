import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { SlideTemplateSaveModal } from "../components/SlideTemplateSaveModal";
import { __resetCustomSlideTemplatesStoreForTests } from "../useCustomSlideTemplates";
import {
  CUSTOM_SLIDE_TEMPLATE_ID_PREFIX,
  emptySlideTemplateDraft,
  loadCustomSlideTemplates,
  type CustomSlideTemplate,
  type CustomSlideTemplateDraft,
} from "../customSlideTemplates";
import type { SlideContent } from "../slideEditorTypes";

function deck(): SlideContent {
  return {
    slides: [
      {
        id: "slide-1",
        title: "Hello",
        blocks: [{ id: "block-1", type: "text", content: "World" }],
        notes: "",
      },
    ],
    themeId: "editorial",
    aspectRatio: "4:3",
  };
}

/** A host that owns open state + records the saved template, like SlideEditor. */
function Host({
  initialDraft,
  title = "Save deck as template",
}: {
  initialDraft: CustomSlideTemplateDraft;
  title?: string;
}) {
  const [open, setOpen] = useState(true);
  const [saved, setSaved] = useState<CustomSlideTemplate | null>(null);
  return (
    <>
      <span data-testid="open">{open ? "open" : "closed"}</span>
      <span data-testid="saved-id">{saved?.id ?? ""}</span>
      {open && (
        <SlideTemplateSaveModal
          isOpen
          initialDraft={initialDraft}
          title={title}
          onSaved={setSaved}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  __resetCustomSlideTemplatesStoreForTests();
});

describe("SlideTemplateSaveModal", () => {
  it("saves a named template, persists it, and closes", async () => {
    const user = userEvent.setup();
    render(<Host initialDraft={emptySlideTemplateDraft(deck())} />);

    await user.type(
      screen.getByTestId("slide-template-name"),
      "Quarterly review",
    );
    await user.selectOptions(
      screen.getByTestId("slide-template-category"),
      "Sales",
    );
    await user.click(screen.getByTestId("slide-template-save"));

    // Persisted through the shared store.
    const stored = loadCustomSlideTemplates();
    expect(stored).toHaveLength(1);
    expect(stored[0].label).toBe("Quarterly review");
    expect(stored[0].category).toBe("Sales");

    // onSaved fired with a fresh custom id, and the modal closed.
    expect(
      screen
        .getByTestId("saved-id")
        .textContent?.startsWith(CUSTOM_SLIDE_TEMPLATE_ID_PREFIX),
    ).toBe(true);
    expect(screen.getByTestId("open").textContent).toBe("closed");
  });

  it("pre-fills the form from an imported draft", () => {
    const imported: CustomSlideTemplateDraft = {
      // No id — like a parsed import.
      label: "Imported deck",
      description: "From a teammate",
      category: "Marketing",
      content: deck(),
    };
    render(<Host initialDraft={imported} title="Import template" />);

    expect(
      (screen.getByTestId("slide-template-name") as HTMLInputElement).value,
    ).toBe("Imported deck");
    expect(
      (screen.getByTestId("slide-template-description") as HTMLInputElement)
        .value,
    ).toBe("From a teammate");
    expect(
      (screen.getByTestId("slide-template-category") as HTMLSelectElement)
        .value,
    ).toBe("Marketing");
  });

  it("shows an inline error for a blank name and persists nothing", async () => {
    const user = userEvent.setup();
    render(<Host initialDraft={emptySlideTemplateDraft(deck())} />);

    await user.click(screen.getByTestId("slide-template-save"));

    const error = await screen.findByTestId("slide-template-errors");
    expect(error).toHaveAttribute("role", "alert");
    expect(error.textContent).toMatch(/name/i);
    expect(loadCustomSlideTemplates()).toEqual([]);
    // Modal stays open so the user can fix the name.
    expect(screen.getByTestId("open").textContent).toBe("open");
  });

  it("edits an existing template in place (same id)", async () => {
    const user = userEvent.setup();
    const editDraft: CustomSlideTemplateDraft = {
      id: `${CUSTOM_SLIDE_TEMPLATE_ID_PREFIX}edit-me`,
      label: "Before",
      description: "",
      category: "",
      content: deck(),
    };
    render(<Host initialDraft={editDraft} title="Edit template" />);

    const name = screen.getByTestId("slide-template-name");
    await user.clear(name);
    await user.type(name, "After");
    await user.click(screen.getByTestId("slide-template-save"));

    expect(screen.getByTestId("saved-id").textContent).toBe(
      `${CUSTOM_SLIDE_TEMPLATE_ID_PREFIX}edit-me`,
    );
    const stored = loadCustomSlideTemplates();
    expect(stored).toHaveLength(1);
    expect(stored[0].label).toBe("After");
  });
});
