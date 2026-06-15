import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { DocumentTemplateSaveModal } from "../components/DocumentTemplateSaveModal";
import { __resetCustomDocumentTemplatesStoreForTests } from "../useCustomDocumentTemplates";
import {
  CUSTOM_DOCUMENT_TEMPLATE_ID_PREFIX,
  emptyDocumentTemplateDraft,
  loadCustomDocumentTemplates,
  type CustomDocumentTemplate,
  type CustomDocumentTemplateDraft,
} from "../customDocumentTemplates";

const SAMPLE_HTML = "<h1>Doc</h1><p>Body.</p>";

/** A host that owns open state + records the saved template, like DocumentEditor. */
function Host({
  initialDraft,
  title = "Save as template",
}: {
  initialDraft: CustomDocumentTemplateDraft;
  title?: string;
}) {
  const [open, setOpen] = useState(true);
  const [saved, setSaved] = useState<CustomDocumentTemplate | null>(null);
  return (
    <>
      <span data-testid="open">{open ? "open" : "closed"}</span>
      <span data-testid="saved-id">{saved?.id ?? ""}</span>
      {open && (
        <DocumentTemplateSaveModal
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
  __resetCustomDocumentTemplatesStoreForTests();
});

describe("DocumentTemplateSaveModal", () => {
  it("saves a named template, persists it, and closes", async () => {
    const user = userEvent.setup();
    render(<Host initialDraft={emptyDocumentTemplateDraft(SAMPLE_HTML)} />);

    await user.type(
      screen.getByTestId("document-template-name"),
      "Weekly status",
    );
    await user.selectOptions(
      screen.getByTestId("document-template-category"),
      "Reporting",
    );
    await user.click(screen.getByTestId("document-template-save"));

    const stored = loadCustomDocumentTemplates();
    expect(stored).toHaveLength(1);
    expect(stored[0].label).toBe("Weekly status");
    expect(stored[0].category).toBe("Reporting");
    expect(stored[0].content).toBe(SAMPLE_HTML);

    expect(
      screen
        .getByTestId("saved-id")
        .textContent?.startsWith(CUSTOM_DOCUMENT_TEMPLATE_ID_PREFIX),
    ).toBe(true);
    expect(screen.getByTestId("open").textContent).toBe("closed");
  });

  it("pre-fills the form from an imported draft", () => {
    const imported: CustomDocumentTemplateDraft = {
      // No id — like a parsed import.
      label: "Imported doc",
      description: "From a teammate",
      category: "Meetings",
      content: SAMPLE_HTML,
    };
    render(<Host initialDraft={imported} title="Import template" />);

    expect(
      (screen.getByTestId("document-template-name") as HTMLInputElement).value,
    ).toBe("Imported doc");
    expect(
      (screen.getByTestId("document-template-description") as HTMLInputElement)
        .value,
    ).toBe("From a teammate");
    expect(
      (screen.getByTestId("document-template-category") as HTMLSelectElement)
        .value,
    ).toBe("Meetings");
  });

  it("shows an inline error for a blank name and persists nothing", async () => {
    const user = userEvent.setup();
    render(<Host initialDraft={emptyDocumentTemplateDraft(SAMPLE_HTML)} />);

    await user.click(screen.getByTestId("document-template-save"));

    const error = await screen.findByTestId("document-template-errors");
    expect(error).toHaveAttribute("role", "alert");
    expect(error.textContent).toMatch(/name/i);
    expect(loadCustomDocumentTemplates()).toEqual([]);
    // Modal stays open so the user can fix the name.
    expect(screen.getByTestId("open").textContent).toBe("open");
  });

  it("edits an existing template in place (same id)", async () => {
    const user = userEvent.setup();
    const editDraft: CustomDocumentTemplateDraft = {
      id: `${CUSTOM_DOCUMENT_TEMPLATE_ID_PREFIX}edit-me`,
      label: "Before",
      description: "",
      category: "",
      content: SAMPLE_HTML,
    };
    render(<Host initialDraft={editDraft} title="Edit template" />);

    const name = screen.getByTestId("document-template-name");
    await user.clear(name);
    await user.type(name, "After");
    await user.click(screen.getByTestId("document-template-save"));

    expect(screen.getByTestId("saved-id").textContent).toBe(
      `${CUSTOM_DOCUMENT_TEMPLATE_ID_PREFIX}edit-me`,
    );
    const stored = loadCustomDocumentTemplates();
    expect(stored).toHaveLength(1);
    expect(stored[0].label).toBe("After");
  });

  it("shows the provided hint", () => {
    render(
      <Host
        initialDraft={emptyDocumentTemplateDraft(SAMPLE_HTML)}
        title="Save selection as template"
      />,
    );
    // Default hint when none provided.
    expect(screen.getByText(/reusable template in your gallery/i)).toBeTruthy();
  });
});
