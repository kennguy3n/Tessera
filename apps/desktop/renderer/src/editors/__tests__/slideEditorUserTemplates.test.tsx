import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SlideEditor from "../SlideEditor";
import { __resetCustomSlideTemplatesStoreForTests } from "../useCustomSlideTemplates";
import {
  buildCustomSlideTemplate,
  loadCustomSlideTemplates,
  saveCustomSlideTemplates,
  serializeSlideTemplate,
  type CustomSlideTemplate,
} from "../customSlideTemplates";
import type { SlideContent } from "../slideEditorTypes";

// jsdom ships neither URL.createObjectURL/revokeObjectURL (Export) nor an
// async Blob.text() (Import). Production runs on Chromium 126, which has
// both; back them minimally so the export/import codepaths run in tests.
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

const twoSlideDeck = () =>
  JSON.stringify({
    slides: [
      { title: "First", blocks: [{ type: "text", content: "a" }], notes: "" },
      { title: "Second", blocks: [{ type: "text", content: "b" }], notes: "" },
    ],
  });

function deck(title: string): SlideContent {
  return {
    slides: [
      {
        id: "s1",
        title,
        blocks: [{ id: "b1", type: "text", content: "body" }],
        notes: "",
      },
    ],
    themeId: "editorial",
    aspectRatio: "16:9",
  };
}

/**
 * Persist one custom template straight to localStorage (through the same
 * build path the editor uses), then reset the module store so the next
 * mount reloads it. Returns the built template.
 */
function seedTemplate(
  label: string,
  content: SlideContent,
  category = "",
): CustomSlideTemplate {
  const result = buildCustomSlideTemplate({
    label,
    description: "",
    category,
    content,
  });
  if (!result.ok) throw new Error(`seed failed: ${result.errors.join(", ")}`);
  saveCustomSlideTemplates([...loadCustomSlideTemplates(), result.template]);
  __resetCustomSlideTemplatesStoreForTests();
  return result.template;
}

function openGallery() {
  fireEvent.click(screen.getByRole("button", { name: "Templates" }));
  return screen.getByRole("dialog", { name: "Choose a deck template" });
}

beforeEach(() => {
  window.localStorage.clear();
  __resetCustomSlideTemplatesStoreForTests();
});

describe("SlideEditor — user-authored templates", () => {
  it("saves the current deck as a template that appears in the gallery", async () => {
    const user = userEvent.setup();
    render(<SlideEditor content={twoSlideDeck()} onSave={vi.fn()} />);

    await user.click(screen.getByTestId("slide-save-as-template"));
    await user.type(screen.getByTestId("slide-template-name"), "Captured deck");
    await user.click(screen.getByTestId("slide-template-save"));

    // Persisted with the current 2-slide deck captured verbatim.
    const stored = loadCustomSlideTemplates();
    expect(stored).toHaveLength(1);
    expect(stored[0].label).toBe("Captured deck");
    expect(stored[0].content.slides).toHaveLength(2);

    const dialog = openGallery();
    expect(
      within(dialog).getByRole("button", {
        name: "Apply the Captured deck template",
      }),
    ).toBeInTheDocument();
  });

  it("applies a user template, reproducing the captured deck", () => {
    seedTemplate("Seeded", deck("Seeded Deck"));
    render(<SlideEditor content={twoSlideDeck()} onSave={vi.fn()} />);

    // Sanity: the editor starts on the original deck.
    expect(
      screen
        .getByRole("button", { name: /1 First/ })
        .getAttribute("aria-current"),
    ).toBe("true");

    const dialog = openGallery();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Apply the Seeded template" }),
    );

    // The deck is replaced by the template's single "Seeded Deck" slide.
    expect(
      screen
        .getByRole("button", { name: /1 Seeded Deck/ })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(screen.queryByRole("button", { name: /2 Second/ })).toBeNull();
  });

  it("filters user templates by search query and category chip", () => {
    seedTemplate("Alpha deck", deck("A"), "Sales");
    seedTemplate("Beta deck", deck("B"), "Marketing");
    render(<SlideEditor content={twoSlideDeck()} onSave={vi.fn()} />);

    const dialog = openGallery();
    expect(
      within(dialog).getByRole("button", {
        name: "Apply the Alpha deck template",
      }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", {
        name: "Apply the Beta deck template",
      }),
    ).toBeInTheDocument();

    // Free-text search narrows to Alpha.
    fireEvent.change(within(dialog).getByRole("searchbox"), {
      target: { value: "alpha" },
    });
    expect(
      within(dialog).getByRole("button", {
        name: "Apply the Alpha deck template",
      }),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", {
        name: "Apply the Beta deck template",
      }),
    ).toBeNull();

    // Clear search; the Marketing chip narrows to Beta.
    fireEvent.change(within(dialog).getByRole("searchbox"), {
      target: { value: "" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Marketing" }));
    expect(
      within(dialog).queryByRole("button", {
        name: "Apply the Alpha deck template",
      }),
    ).toBeNull();
    expect(
      within(dialog).getByRole("button", {
        name: "Apply the Beta deck template",
      }),
    ).toBeInTheDocument();
  });

  it("edits a user template in place from the gallery", async () => {
    const user = userEvent.setup();
    seedTemplate("Editable", deck("E"));
    render(<SlideEditor content={twoSlideDeck()} onSave={vi.fn()} />);

    openGallery();
    await user.click(
      screen.getByRole("button", { name: "Edit the Editable template" }),
    );

    // Gallery closes (single-trap), the modal opens pre-filled.
    const name = (await screen.findByTestId(
      "slide-template-name",
    )) as HTMLInputElement;
    expect(name.value).toBe("Editable");
    await user.clear(name);
    await user.type(name, "Edited");
    await user.click(screen.getByTestId("slide-template-save"));

    // Still a single template (edited in place), and the gallery reopens.
    const stored = loadCustomSlideTemplates();
    expect(stored).toHaveLength(1);
    expect(stored[0].label).toBe("Edited");
    expect(
      screen.getByRole("button", { name: "Apply the Edited template" }),
    ).toBeInTheDocument();
  });

  it("duplicates a user template from the gallery", () => {
    seedTemplate("Dup", deck("D"));
    render(<SlideEditor content={twoSlideDeck()} onSave={vi.fn()} />);

    const dialog = openGallery();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Duplicate the Dup template",
      }),
    );

    expect(loadCustomSlideTemplates()).toHaveLength(2);
    expect(
      within(dialog).getByRole("button", { name: "Apply the Dup template" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", {
        name: "Apply the Dup (copy) template",
      }),
    ).toBeInTheDocument();
  });

  it("requires a two-step confirm before deleting a user template", () => {
    seedTemplate("Doomed", deck("X"));
    render(<SlideEditor content={twoSlideDeck()} onSave={vi.fn()} />);

    const dialog = openGallery();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Delete the Doomed template",
      }),
    );
    // First click only arms the confirm; nothing deleted yet.
    expect(loadCustomSlideTemplates()).toHaveLength(1);

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Confirm deleting the Doomed template",
      }),
    );
    expect(loadCustomSlideTemplates()).toHaveLength(0);
    expect(
      within(dialog).queryByRole("button", {
        name: "Apply the Doomed template",
      }),
    ).toBeNull();
  });

  it("exports a user template via the browser download dance", () => {
    const createSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock");
    const revokeSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const downloads: string[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push(this.download);
      });

    seedTemplate("Portable deck", deck("P"));
    render(<SlideEditor content={twoSlideDeck()} onSave={vi.fn()} />);
    const dialog = openGallery();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Export the Portable deck template",
      }),
    );

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(downloads[0]).toBe("tessera-slide-template-portable-deck.json");

    // Restore only these spies — a blanket vi.restoreAllMocks() would
    // also wipe the global window.tessera mock the editor depends on.
    createSpy.mockRestore();
    revokeSpy.mockRestore();
    clickSpy.mockRestore();
  });

  it("imports a portable template file and saves it as a new template", async () => {
    const user = userEvent.setup();
    render(<SlideEditor content={twoSlideDeck()} onSave={vi.fn()} />);

    // Build a portable file from a template authored elsewhere.
    const external = buildCustomSlideTemplate({
      label: "Imported one",
      description: "",
      category: "Sales",
      content: deck("Imported Slide"),
    });
    if (!external.ok) throw new Error("fixture build failed");

    openGallery();
    const file = new File(
      [serializeSlideTemplate(external.template)],
      "t.json",
      {
        type: "application/json",
      },
    );
    fireEvent.change(screen.getByTestId("slide-template-import-input"), {
      target: { files: [file] },
    });

    // Review modal opens pre-filled (no error).
    const name = (await screen.findByTestId(
      "slide-template-name",
    )) as HTMLInputElement;
    expect(name.value).toBe("Imported one");
    expect(
      screen.queryByTestId("slide-template-import-error"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByTestId("slide-template-save"));

    // Saved as a brand-new template with a fresh id (never overwrites).
    const stored = loadCustomSlideTemplates();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).not.toBe(external.template.id);
    expect(stored[0].label).toBe("Imported one");
    expect(
      screen.getByRole("button", { name: "Apply the Imported one template" }),
    ).toBeInTheDocument();
  });

  it("shows an inline error for an unreadable import and opens no modal", async () => {
    render(<SlideEditor content={twoSlideDeck()} onSave={vi.fn()} />);
    openGallery();

    const file = new File(["not json{"], "bad.json", {
      type: "application/json",
    });
    fireEvent.change(screen.getByTestId("slide-template-import-input"), {
      target: { files: [file] },
    });

    const error = await screen.findByTestId("slide-template-import-error");
    expect(error).toHaveAttribute("role", "alert");
    expect(error.textContent).toMatch(/JSON/i);
    expect(
      screen.queryByTestId("slide-template-save-modal"),
    ).not.toBeInTheDocument();
  });
});
